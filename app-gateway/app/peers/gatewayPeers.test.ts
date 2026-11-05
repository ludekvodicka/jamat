import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProcessCalls } from '../../../lib-orchestrator/shared/processCalls'
import { RemoteControlPeerKeys } from '../../../lib-orchestrator/remoteControl/remoteControlPeerKeys'
import { RemoteControlPeerClient } from '../../../lib-orchestrator/remoteControl/remoteControlPeerClient'
import type { RemoteControlPeerIdentity, RemoteControlPeerInboundApplicationMessage, RemoteControlPeerProfile } from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { PeerProcessState } from '../../../lib-orchestrator/remoteControl/peerProcess.types'
import { TerminalGateway, type TerminalGatewayDeps } from '../../../lib-orchestrator/sessionManager/terminalGateway'
import { GatewayPeers } from './gatewayPeers'
import { JsonShape } from '../../../lib-orchestrator/shared/jsonShape'

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Gateway peer fixture timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('private initialization owns the native listener, terminal traffic, redacted audit and acknowledged trust removal', async () => {
  const serverKeys = RemoteControlPeerKeys.generateSigningKeyPair(), clientKeys = RemoteControlPeerKeys.generateSigningKeyPair()
  const identity = (id: string, publicKey: string): RemoteControlPeerIdentity => ({ remoteComputerId: id, remoteEndpointId: `${id}-endpoint`,
    configIdentity: `${id}-config`, runtimeChannel: 'development', displayName: id,
    signing: { algorithm: 'ed25519', publicKey, fingerprint: RemoteControlPeerKeys.fingerprint(publicKey) } })
  const server = identity('server', serverKeys.publicKey), client = identity('client', clientKeys.publicKey)
  const events: { target: string; name: string; value: unknown }[] = [], methods: string[] = [], input: string[] = []
  const reports: string[] = []
  let state: PeerProcessState = { listener: { status: 'disabled' }, inbound: [] }, gateway!: ProcessCalls, peers!: GatewayPeers
  const main = new ProcessCalls({ send: message => gateway.receive(structuredClone(message)),
    invoke: async (target, method) => {
      assert.equal(target, 'peer-work'); methods.push(method)
      if (method === 'bound') return '{"public":"bundle"}'
      throw new Error(`Unexpected main method: ${method}`)
    }, event: (target, name, value) => {
      events.push({ target, name, value })
      if (target === 'peers' && name === 'state') state = value as PeerProcessState
    }, report: message => { throw new Error(message) } })
  gateway = new ProcessCalls({ send: message => main.receive(structuredClone(message)),
    invoke: (target, method, args, context) => {
      assert.equal(target, 'peers'); return peers.invoke(method, args, context)
    }, event: (target, name, value) => { assert.equal(target, 'peers'); peers.event(name, value) }, report: message => { throw new Error(message) } })
  const terminals = new TerminalGateway({
    descriptorOf: () => ({ hostInstanceId: 'host', port: 1, token: 'fixture' }) as ReturnType<TerminalGatewayDeps['descriptorOf']>,
    leaseIdOf: () => 'lease', onError: message => { reports.push(message) },
    activity: { userInput() {}, pendingInputHint() {} },
    socketFactory: deps => ({ connect() {}, close() {}, send(message) {
      if (message.type === 'terminal.input') input.push(message.data)
      else if (message.type === 'terminal.attach') queueMicrotask(() => deps.onFrame({ type: 'terminal.attached', writer: true,
        session: { runtimeSessionId: 'runtime', generation: 1, alive: true, cols: 120, rows: 40,
          outputSeq: 0, outputEpoch: 1, lastOutputAt: null, startedAt: 1 } }))
    } }),
  })
  await terminals.publishRefs([{ sessionId: 'session', resolution: { ok: true, alive: true,
    ref: { hostInstanceId: 'host', runtimeSessionId: 'runtime', generation: 1 } } }])
  peers = new GatewayPeers(gateway, terminals, { span: (_name, run) => run() }, () => {})
  try {
    await main.call('peers', 'initialize', [{ identity: server, privateKey: serverKeys.privateKey, trust: [client], bundleText: null }])
    assert.deepEqual(await main.call('peers', 'apply', [{ enabled: true, bindHost: '127.0.0.1', advertisedHost: '127.0.0.1', port: 0 }]), { ok: true })
    const runtime = state.listener
    if (runtime.status !== 'listening') throw new Error('No peer listener')
    assert.deepEqual(methods, ['bound'])
    const profile: RemoteControlPeerProfile = { profileId: 'server', remoteComputerId: server.remoteComputerId,
      remoteEndpointId: server.remoteEndpointId, configIdentity: server.configIdentity, runtimeChannel: server.runtimeChannel,
      displayName: server.displayName, endpoint: { host: '127.0.0.1', port: runtime.actualPort }, pinnedIdentity: server.signing }
    const dial = () => new RemoteControlPeerClient(client, payload => RemoteControlPeerKeys.sign(clientKeys.privateKey, payload),
      { connectTimeoutMilliseconds: 1_000 }).connect(profile)
    const connected = await dial()
    if (!connected.ok) throw new Error(connected.error.detail)
    const received: RemoteControlPeerInboundApplicationMessage[] = []
    connected.value.onMessage(message => received.push(message))
    connected.value.send({ type: 'socket-request', request: { protocol: 'appjamat-v3-control.v1', requestId: 'attach', operationId: 'attach-op',
      operation: 'terminal.attach', attachId: 'a', sessionId: 'session', size: null } })
    await until(() => state.inbound[0]?.activeSessionIds.includes('session') === true)
    connected.value.send({ type: 'socket-request', request: { protocol: 'appjamat-v3-control.v1', requestId: 'input', operationId: 'input-op',
      operation: 'terminal.input', attachId: 'a', data: 'SECRET-TERMINAL-TEXT' } })
    await until(() => received.some(message => {
      if (message.type !== 'socket-response') return false
      const response = JsonShape.record(message.response)
      return response?.type === 'response' && response.requestId === 'input'
    }))
    assert.deepEqual(input, ['SECRET-TERMINAL-TEXT'])
    assert.deepEqual(methods, ['bound'])
    const serialized = JSON.stringify(events)
    assert.equal(serialized.includes('SECRET-TERMINAL-TEXT'), false)
    assert.equal(serialized.includes(serverKeys.privateKey), false)
    assert.ok(serialized.includes('"characterCount":20'))
    const inhibit = await terminals.inhibit('session')
    connected.value.send({ type: 'socket-request', request: { protocol: 'appjamat-v3-control.v1', requestId: 'queued', operationId: 'queued-op',
      operation: 'terminal.input', attachId: 'a', data: 'NEVER-EMITTED' } })
    await until(async () => await terminals.pendingInput('session') === 1)
    await main.call('peers', 'revoke', [client.remoteComputerId, client.remoteEndpointId])
    assert.equal(state.inbound.length, 0)
    assert.equal(await terminals.pendingInput('session'), 0)
    inhibit.release()
    assert.deepEqual(input, ['SECRET-TERMINAL-TEXT'])
    assert.deepEqual(reports, ['Queued input for session was refused because its terminal attachment changed'])
    await until(() => !connected.value.isOpen())
    assert.equal((await dial()).ok, false)
    await main.call('peers', 'stop', [])
    assert.deepEqual(state.listener, { status: 'disabled' })
  } finally { await peers.stop(); terminals.closeAll(); gateway.close(); main.close() }
})
