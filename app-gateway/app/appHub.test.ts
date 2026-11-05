import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout } from 'node:timers/promises'
import { test } from 'node:test'
import { GatewayAppHub } from './appHub'
import { GatewayAppContext } from './appContext'
import { FedHostConnection } from '../../lib-orchestrator/hostClient/hostConnection'
import { HostClient } from '../../lib-orchestrator/hostClient/hostClient'
import { HostDescriptorPaths } from '../../lib-orchestrator/hostClient/hostDescriptorPaths'
import type { ProcessMessage } from '../../lib-orchestrator/shared/processWire.types'
import type { WindowMessage } from '../../lib-orchestrator/shared/windowWire.types'

class OrchestrationPort extends EventEmitter {
  readonly send: (message: ProcessMessage) => void
  constructor(send: OrchestrationPort['send']) { super(); this.send = send }
  postMessage(message: ProcessMessage): void { this.send(message) }
  start(): void {}
  close(): void { this.emit('close') }
}

test('a stale window epoch cannot close or disable the replacement document', async () => {
  class Port extends EventEmitter {
    closed = false
    postMessage(message: WindowMessage): void { if (message.type === 'reply') this.emit('answer', message) }
    start(): void {}
    close(): void { if (!this.closed) { this.closed = true; this.emit('close') } }
    async attach(id: number): Promise<Extract<WindowMessage, { type: 'reply' }>> {
      const pending = new Promise<Extract<WindowMessage, { type: 'reply' }>>(resolve => this.once('answer', resolve))
      this.emit('message', { data: { type: 'call', id, target: 'terminal', method: 'terminal:attach',
        args: [`attach-${id}`, { sessionId: 'unknown', size: null }] } })
      const result = await pending
      this.emit('message', { data: { type: 'received', id } })
      return result
    }
  }
  const hub = new GatewayAppHub({ hostDescriptorFile: 'unused-window-fixture', controllerId: 'window-fixture' },
    { span: (_name, work) => work(), operation: (_name, work) => work() }, () => {})
  const old = new Port(), current = new Port()
  try {
    hub.openWindow('window', 'old', false, old)
    assert.deepEqual(await old.attach(1), { type: 'reply', id: 1, ok: false, error: 'The workspace window is closing' })
    hub.openWindow('window', 'current', true, current)
    assert.equal(old.closed, true)
    hub.setWindowAccepting('window', 'old', false)
    hub.closeWindow('window', 'old')
    assert.equal(current.closed, false)
    assert.equal((await current.attach(1)).ok, true)
    hub.setWindowAccepting('window', 'current', false)
    assert.equal((await current.attach(2)).ok, false)
    hub.setWindowAccepting('window', 'current', true)
    assert.equal((await current.attach(3)).ok, true)
  } finally { await hub.stop() }
  assert.equal(current.closed, true)
})

test('gateway owns stable lease acquisition, publishes expiry, and fed mutations refuse the lost lease', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-connection-')), previous = process.env.JAMAT_V3_HOST_STATE_DIR
  process.env.JAMAT_V3_HOST_STATE_DIR = root
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    requests.push({ path: request.url!, body })
    if (request.url === '/op/controller.acquire')
      response.end(JSON.stringify({ controllerId: body.controllerId, controllerLeaseId: 'lease', expiresAt: Date.now() + 150 }))
    else if (request.url === '/op/controller.release') response.end('{}')
    else { response.statusCode = 409; response.end('{"error":"fixture refuses renewal"}') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No fixture port')
  const descriptorFile = HostDescriptorPaths.descriptorFile('fixture', 'development')
  mkdirSync(dirname(descriptorFile), { recursive: true })
  writeFileSync(descriptorFile, JSON.stringify({ schemaVersion: 1, port: address.port, token: 'fixture-token', hostInstanceId: 'host', capabilities: [] }))
  const messages: ProcessMessage[] = [], fed = new FedHostConnection()
  const hub = new GatewayAppHub(new GatewayAppContext({ configIdentity: 'fixture', channel: 'development', stateDirectory: root }),
    { span: (_name, work) => work(), operation: (_name, work) => work() }, message => {
      assert.notEqual(message.type, 'host-connection', 'Native main must not relay Host credentials')
    })
  hub.connectOrchestrator(new OrchestrationPort(message => {
      messages.push(message)
      if (message.type === 'host-connection') fed.update(message.value.descriptor, message.value.leaseId)
    }))
  const client = new HostClient({ connection: fed, onEvent() {}, onPresence() {}, onResync() {}, onError() {} })
  let diagnosticHub: GatewayAppHub | null = null
  try {
    hub.start()
    for (let attempt = 0; attempt < 200 && !messages.some(message => message.type === 'host-connection' && message.value.leaseId === 'lease'); attempt++)
      await setTimeout(10)
    assert.ok(messages.some(message => message.type === 'host-connection' && message.value.leaseId === 'lease'))
    for (let attempt = 0; attempt < 200 && fed.leaseId() !== null; attempt++) await setTimeout(10)
    assert.equal(fed.leaseId(), null)
    assert.equal(requests[0].body.controllerId, 'jamat-client-fixture-development')
    assert.deepEqual(await client.runtimeStop({ hostInstanceId: 'host', runtimeSessionId: 'session', generation: 1 }),
      { ok: false, code: 'no-lease', detail: 'runtime.stop: no live controller lease' })
    assert.equal(requests.some(request => request.path === '/op/runtime.stop'), false)
    await hub.stop()
    assert.equal(requests.at(-1)?.path, '/op/controller.release')
    writeFileSync(descriptorFile, 'broken fixture')
    diagnosticHub = new GatewayAppHub(new GatewayAppContext({ configIdentity: 'fixture', channel: 'development', stateDirectory: root }),
      { span: (_name, work) => work(), operation: (_name, work) => work() }, message => messages.push(message))
    diagnosticHub.connectOrchestrator(new OrchestrationPort(message => messages.push(message)))
    diagnosticHub.start()
    for (let attempt = 0; attempt < 200 && !messages.some(message => message.type === 'event' && message.target === 'diagnostics'); attempt++)
      await setTimeout(10)
    const diagnostics = messages.filter(message => message.type === 'event' && message.target === 'diagnostics')
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0].type === 'event' && diagnostics[0].name, 'host-error')
  } finally {
    await diagnosticHub?.stop()
    await client.stop()
    await hub.stop()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (previous === undefined) delete process.env.JAMAT_V3_HOST_STATE_DIR
    else process.env.JAMAT_V3_HOST_STATE_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})
