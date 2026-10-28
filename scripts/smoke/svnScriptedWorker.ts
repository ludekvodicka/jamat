import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppClientCli } from '../../app-client-cli/app/app.js'
import { RemoteControlConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol.js'
import type { RemoteControlDescriptor, RemoteControlRequestUnion } from '../../lib-orchestrator/remoteControl/remoteControlApi.types.js'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import type { FinishDriver } from '../../lib-orchestrator/worktrees/worktreeFinish.js'

export class SvnScriptedWorker {
  static async settle(root: string, tree: string, sessionId: string, paths: string[], flow: FinishDriver): Promise<void> {
    const token = 'disposable-svn-worker-token-0000000000'
    const answering = new Set<Promise<void>>()
    const server = createServer((request, response) => {
      const work = SvnScriptedWorker.answer(request, response, token, sessionId, flow)
      answering.add(work)
      void work.finally(() => answering.delete(work))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      assert(address !== null && typeof address !== 'string')
      const descriptor: RemoteControlDescriptor = { schemaVersion: 1, protocol: RemoteControlConst.protocol, address: '127.0.0.1', port: address.port,
        token, pid: process.pid, operations: RemoteControlConst.operations, optionalOperations: RemoteControlConst.optionalOperations,
        websocket: true, configIdentity: 'fixture', runtimeChannel: 'development', instanceId: 'fixture', startedAt: Date.now(), applicationVersion: 'fixture' }
      const input = join(root, 'worker-input.json')
      await writeFile(input, JSON.stringify({ descriptor, tree, sessionId, paths }))
      const result = await new CommandInvoker().run({ command: process.execPath, cwd: join(import.meta.dirname, '..', '..'),
        args: ['--import', 'tsx', import.meta.filename, '--worker-child', input], env: { ...process.env, JAMAT_V3_LOCAL_STATE_DIR: join(root, 'worker-state') }, timeoutMs: Math.max(120_000, paths.length * 8_000) })
      assert.equal(result.failure, null, result.stderr); assert.equal(result.code, 0, result.stderr + result.stdout)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      // A settlement still running after its connection closed must end before the caller goes on.
      await Promise.all(answering)
    }
  }

  /**
   * One settlement over the control API. As in AppClientUI, the answer follows the settlement and the
   * Finish goes on detached; waiting for its sync and review here held the answer past the CLI timeout.
   */
  private static async answer(request: IncomingMessage, response: ServerResponse, token: string, sessionId: string, flow: FinishDriver): Promise<void> {
    try {
      assert.equal(request.headers.authorization, `Bearer ${token}`)
      let text = ''
      for await (const bytes of request) text += bytes.toString()
      const call = JSON.parse(text) as RemoteControlRequestUnion
      assert.equal(call.operation, 'sessions.resolveConflict')
      if (call.operation !== 'sessions.resolveConflict') throw new Error('Unexpected worker operation')
      assert.deepEqual(call.body.session, { kind: 'sessionId', sessionId })
      const result = await flow.resolveConflict(sessionId, { path: call.body.path, option: call.body.option, confirm: false, requestedBy: 'cli', by: 'agent' })
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ protocol: call.protocol, operation: call.operation, requestId: call.requestId, operationId: call.operationId,
        ...(result.ok ? { ok: true, value: result.value } : { ok: false, error: { code: 'operation-failed', detail: result.detail } }) }))
    } catch (error) { console.error(error); response.statusCode = 500; response.end(String(error)) }
  }
}

if (process.argv[2] === '--worker-child') {
  const input = JSON.parse(await readFile(process.argv[3], 'utf8')) as { descriptor: RemoteControlDescriptor; tree: string; sessionId: string; paths: string[] }
  for (const path of input.paths) {
    await writeFile(join(input.tree, path), 'incoming\nworker\n')
    const code = await new AppClientCli(['sessions', 'resolve-conflict', '--self', '--path', path, '--option', 'merged'], {
      env: { ...process.env, JAMAT_V3_SESSION_ID: input.sessionId }, discover: () => ({ ok: true, value: input.descriptor }),
    }).run()
    assert.equal(code, 0, `Worker settlement failed for ${path}`)
  }
}
