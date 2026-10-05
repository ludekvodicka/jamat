import assert from 'node:assert/strict'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { SessionManager } from '../../lib-orchestrator/sessionManager/sessionManager'
import type { SessionsOpResult, TerminalFrame } from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore'
import { OrchestratorPaths } from '../../lib-orchestrator/shared/orchestratorPaths'
import type { SessionRecord } from '../../lib-orchestrator/sessionManager/records/sessionRecord.types'
import { SmokeRun } from './smokeHarness'

const root = join(import.meta.dirname, '../..')
const scratch = join(root, `.aidocs/temp/${new Date().toISOString().slice(0, 10)}-codex-identity`, randomUUID())
const home = join(scratch, 'codex-home')
const cwd = join(scratch, 'workspace')
const configDir = join(scratch, 'controller')
const resourcesRoot = process.argv[2] ?? null
for (const directory of [home, cwd, configDir]) mkdirSync(directory, {recursive: true})

async function waitFor(check: () => boolean, failure: () => string, milliseconds = 30000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(failure())
}
function value<T>(result: SessionsOpResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.detail}`)
  return result.value
}

async function run(): Promise<void> {
  let requests = 0
  const models: string[] = []
  const efforts: string[] = []
  const userInputs: string[] = []
  const permissionInstructions = new Map<string, string>()
  const api = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.on('data', data => { body += data })
    request.on('end', () => {
      requests++
      const input = JSON.parse(body)
      let permissions = ''
      let lastUserInput = ''
      for (const item of input.input ?? [])
        for (const part of item.content ?? []) {
          if (item.role === 'developer' && part.type === 'input_text' && part.text.includes('<permissions instructions>'))
            permissions = part.text
          if (item.role === 'user' && part.type === 'input_text') lastUserInput = part.text
        }
      permissionInstructions.set(lastUserInput, permissions)
      models.push(input.model)
      efforts.push(input.reasoning?.effort)
      for (const item of input.input ?? [])
        if (item.role === 'user')
          for (const part of item.content ?? [])
            if (part.type === 'input_text') userInputs.push(part.text)
      const message = {type: 'message', id: `msg_${requests}`, role: 'assistant', status: 'completed',
        content: [{type: 'output_text', text: 'NATIVE_RESPONSE_DONE', annotations: []}]}
      const result = {id: `resp_${requests}`, object: 'response', status: 'completed', output: [message],
        usage: {input_tokens: 10, output_tokens: 5, total_tokens: 15}}
      response.writeHead(200, {'content-type': 'text/event-stream'})
      for (const event of [
        {type: 'response.created', response: {...result, status: 'in_progress', output: []}},
        {type: 'response.output_item.added', output_index: 0, item: {...message, status: 'in_progress', content: []}},
        {type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: message.id, delta: 'NATIVE_RESPONSE_DONE'},
        {type: 'response.output_item.done', output_index: 0, item: message},
        {type: 'response.completed', response: result},
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      response.end()
    })
  })
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  const address = api.address()
  assert.ok(address && typeof address !== 'string')
  writeFileSync(join(home, 'config.toml'), [
    'model="gpt-6.1-sol"', 'model_provider="jamat_identity_test"',
    '[model_providers.jamat_identity_test]', 'name="Jamat identity smoke"',
    `base_url="http://127.0.0.1:${address.port}/v1"`, 'wire_api="responses"', 'requires_openai_auth=false',
  ].join('\n'))
  process.env.CODEX_HOME = home
  process.env.TERM = 'xterm-256color'
  process.env.JAMAT_V3_LOCAL_STATE_DIR = join(scratch, 'state')
  process.env.JAMAT_V3_HOST_STATE_DIR = join(scratch, 'state', 'host')
  const identity = ConfigIdentityStore.loadOrCreate(configDir, 'development').configIdentity
  let host: ChildProcess | undefined
  const errors: string[] = []
  const output = new Map<string, string>()
  const writers = new Set<string>()
  let yolo = true
  const makeManager = () => new SessionManager({
    applicationRoot: resourcesRoot === null ? root : dirname(resourcesRoot),
    resourcesRoot, configDir, configIdentity: identity, channel: 'development',
    autoStartHost: false, onChanged: () => {}, onError: message => errors.push(message),
    yoloFor: () => yolo,
    modelFor: () => 'gpt-6.1-sol', effortFor: () => 'high',
    spawnImpl: ((command: string, args: readonly string[], options: SpawnOptions) => {
      host = spawn(command, args, options)
      return host
    }) as typeof spawn,
  })
  let manager = makeManager()
  const sessions: string[] = []
  const stored = (id: string): SessionRecord => JSON.parse(readFileSync(
    OrchestratorPaths.sessionRecordsFile(identity, 'development'), 'utf8'))
    .records.find((record: SessionRecord) => record.sessionId === id)
  const row = (id: string) => manager.snapshot().sessions.find(session => session.sessionId === id)
  const attach = (id: string) => {
    writers.delete(id)
    const attached = manager.terminalAttach(id, {sessionId: id, size: {cols: 120, rows: 35}}, {
      source: 'local', onFrame: (frame: TerminalFrame) => {
        if (frame.type === 'terminal.attached' && frame.writer) writers.add(id)
        const text = frame.type === 'terminal.snapshot' ? frame.projection.screen
          : frame.type === 'terminal.delta' ? frame.data : frame.type === 'terminal.data' ? frame.delta : ''
        output.set(id, ((output.get(id) ?? '') + text).slice(-30000))
      },
    })
    assert.ok(attached.ok)
  }
  const enter = async (id: string, text: string) => {
    await waitFor(() => writers.has(id), () => 'terminal writer was not attached')
    assert.equal(manager.terminalInput(id, text).kind, 'sent')
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(manager.terminalInput(id, '\r').kind, 'sent')
  }
  const verifyYolo = async (id: string, label: string) => {
    const prompt = `Reply with the test marker for ${label}.`
    await enter(id, prompt)
    await waitFor(() => permissionInstructions.has(prompt) && (output.get(id) ?? '').includes('NATIVE_RESPONSE_DONE'),
      () => `No mock response for ${label}: ${output.get(id)}; ${errors.join('; ')}`)
    const permissions = permissionInstructions.get(prompt) ?? ''
    assert.ok(permissions.includes('danger-full-access'), `YOLO sandbox was not applied to ${label}: ${permissions}`)
    assert.match(permissions, /approval policy.*never/i, `YOLO approvals were not applied to ${label}`)
    console.log(`ok: ${label} sends unrestricted sandbox and never approvals to the model`)
    await new Promise(resolve => setTimeout(resolve, 800))
  }
  try {
    await manager.start()
    value(await manager.startHost())
    await waitFor(() => manager.snapshot().host.presence === 'running'
      && manager.debugStatus().lease.leaseId !== null, () => JSON.stringify(manager.debugStatus()))
    for (let i = 0; i < 2; i++) {
      const created = value(await manager.createSession({kind: 'agent', directory: {mode: 'adHoc', path: cwd},
        agent: {agentId: 'codex', mode: 'new'}, title: `Identity ${i}`}))
      sessions.push(created.sessionId)
      attach(created.sessionId)
    }
    await waitFor(() => sessions.every(id => row(id)?.agent?.nativeSessionId),
      () => `Missing identities: ${JSON.stringify({sessions: manager.snapshot().sessions, errors, screens: [...output]})}`)
    const ids = sessions.map(id => row(id)!.agent!.nativeSessionId!)
    assert.notEqual(ids[0], ids[1])
    assert.equal(requests, 0)
    console.log('ok: simultaneous empty terminals in the same cwd have distinct confirmed IDs before a model turn')
    await verifyYolo(sessions[0], 'new session')
    assert.deepEqual([...new Set(models)], ['gpt-6.1-sol'])
    assert.deepEqual([...new Set(efforts)], ['high'])
    console.log('ok: native prompt, response, model and effort survive the bridge')
    await new Promise(resolve => setTimeout(resolve, 800))
    const fork = value(await manager.forkSession(sessions[0]))
    sessions.push(fork.sessionId)
    attach(fork.sessionId)
    await waitFor(() => !!row(fork.sessionId)?.agent?.nativeSessionId,
      () => `No fork identity: ${output.get(fork.sessionId)}; ${errors.join('; ')}`)
    assert.notEqual(row(fork.sessionId)?.agent?.nativeSessionId, ids[0])
    console.log('ok: native fork returns its own thread ID')
    await verifyYolo(fork.sessionId, 'fork')
    const firstLaunch = stored(sessions[0]).agent!.identityLaunchId
    value(await manager.stopSession(sessions[0]))
    await waitFor(() => row(sessions[0])?.life === 'ended', () => 'native session did not stop')
    value(await manager.reopenSession(sessions[0]))
    await waitFor(() => row(sessions[0])?.life === 'live' && stored(sessions[0]).agent?.identitySequence === 1,
      () => `native session did not confirm its resume: ${output.get(sessions[0])}`)
    assert.notEqual(stored(sessions[0]).agent?.identityLaunchId, firstLaunch)
    assert.equal(row(sessions[0])?.agent?.nativeSessionId, ids[0])
    console.log('ok: resume preserves the confirmed conversation ID')
    attach(sessions[0])
    await verifyYolo(sessions[0], 'resume')
    await enter(sessions[1], '/new')
    await waitFor(() => row(sessions[1])?.agent?.nativeSessionId !== ids[1],
      () => `native /new did not replace identity: ${output.get(sessions[1])}`)
    assert.ok(stored(sessions[1]).agent!.identitySequence! > 1)
    console.log('ok: native /new changes the identity in the existing Jamat tab')
    await verifyYolo(sessions[1], 'native /new')
    const beforeRestart = sessions.map(id => row(id)!.agent!.nativeSessionId)
    await manager.stop()
    manager = makeManager()
    await manager.start()
    await waitFor(() => sessions.every(id => row(id)?.life === 'live') && manager.debugStatus().lease.leaseId !== null,
      () => 'client did not reattach to live Codex terminals with its controller lease')
    assert.deepEqual(sessions.map(id => row(id)!.agent!.nativeSessionId), beforeRestart)
    console.log('ok: client restart preserves live terminals and confirmed identities')
    const prompt = 'First line with "quotes".\nSecond line: return the test marker.'
    const prompted = value(await manager.createSession({kind: 'agent', directory: {mode: 'adHoc', path: cwd},
      agent: {agentId: 'codex', mode: 'new', initialPrompt: prompt}, title: 'Multiline identity'}))
    sessions.push(prompted.sessionId)
    attach(prompted.sessionId)
    await waitFor(() => !!row(prompted.sessionId)?.agent?.nativeSessionId && userInputs.includes(prompt),
      () => `multiline initial prompt did not survive launch: ${output.get(prompted.sessionId)}`)
    console.log('ok: multiline initial prompt preserves quotes and newlines through the native launch')
    for (const id of sessions) value(await manager.stopSession(id))
    await waitFor(() => sessions.every(id => row(id)?.life === 'ended'), () => 'terminals did not release their conversations')
    const continued = value(await manager.createSession({kind: 'agent', directory: {mode: 'adHoc', path: cwd},
      agent: {agentId: 'codex', mode: 'continue'}, title: 'Continue identity'}))
    sessions.push(continued.sessionId)
    attach(continued.sessionId)
    await waitFor(() => !!row(continued.sessionId)?.agent?.nativeSessionId,
      () => `continue did not confirm its selected thread: ${output.get(continued.sessionId)}`)
    assert.equal(stored(continued.sessionId).agent?.nativeSessionIdSource, 'codex-app-server')
    assert.ok(sessions.slice(0, -1).some(id => row(id)?.agent?.nativeSessionId === row(continued.sessionId)?.agent?.nativeSessionId))
    console.log('ok: continue confirms the selected thread instead of inferring it in Jamat')
    await verifyYolo(continued.sessionId, 'continue')
    yolo = false
    const gated = value(await manager.createSession({kind: 'agent', directory: {mode: 'adHoc', path: cwd},
      agent: {agentId: 'codex', mode: 'new'}, title: 'Gated permissions'}))
    sessions.push(gated.sessionId)
    attach(gated.sessionId)
    await waitFor(() => !!row(gated.sessionId)?.agent?.nativeSessionId, () => `No gated identity: ${output.get(gated.sessionId)}`)
    const gatedPrompt = 'Reply with the test marker for gated permissions.'
    await enter(gated.sessionId, gatedPrompt)
    await waitFor(() => permissionInstructions.has(gatedPrompt) && (output.get(gated.sessionId) ?? '').includes('NATIVE_RESPONSE_DONE'),
      () => `No gated response: ${output.get(gated.sessionId)}`)
    assert.match(permissionInstructions.get(gatedPrompt) ?? '', /`sandbox_mode` is `read-only`/)
    console.log('ok: disabled YOLO preserves the native restricted sandbox')
    await new Promise(resolve => setTimeout(resolve, 800))
    value(await manager.stopSession(gated.sessionId))
    await waitFor(() => row(gated.sessionId)?.life === 'ended', () => 'gated session did not stop')
    yolo = true
    value(await manager.reopenSession(gated.sessionId))
    await waitFor(() => row(gated.sessionId)?.life === 'live' && stored(gated.sessionId).agent?.identitySequence === 1,
      () => `gated session did not resume: ${output.get(gated.sessionId)}`)
    attach(gated.sessionId)
    await verifyYolo(gated.sessionId, 'resume of a previously restricted session')
    assert.deepEqual(errors, [])
  } finally {
    for (const id of sessions) await manager.stopSession(id).catch(() => {})
    const hostId = manager.snapshot().host.hostInstanceId
    if (hostId) await manager.stopHost(hostId).catch(() => {})
    await manager.stop()
    if (host && host.exitCode === null && host.signalCode === null) host.kill()
    api.closeAllConnections()
    await new Promise<void>(resolve => api.close(() => resolve()))
  }
}
void run().catch(error => SmokeRun.failed('codex-identity', error))
