import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProcessCalls } from '../../../lib-orchestrator/shared/processCalls'
import { RemoteControlPeerKeys } from '../../../lib-orchestrator/remoteControl/remoteControlPeerKeys'
import type { RemoteControlPeerApplicationMessage, RemoteControlPeerIdentity, RemoteControlPeerProfile } from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { RemoteControlPeerConnection } from '../../../lib-orchestrator/remoteControl/remoteControlPeerConnection'
import type { RemoteConnectionsSnapshot } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import { RemoteControlPeerServer } from './remoteControlPeerServer'
import { OutboundPeers } from './outboundPeers'

test('private outbound initialization and profile pushes retain control forwarding through the existing signed peer channel', async () => {
  const keys = RemoteControlPeerKeys.generateSigningKeyPair(), remoteKeys = RemoteControlPeerKeys.generateSigningKeyPair()
  const identity = (name: string, publicKey: string): RemoteControlPeerIdentity => ({ remoteComputerId: name, remoteEndpointId: name + '-endpoint',
    configIdentity: name + '-config', runtimeChannel: 'development', displayName: name,
    signing: { algorithm: 'ed25519', publicKey, fingerprint: RemoteControlPeerKeys.fingerprint(publicKey) } })
  const local = identity('local', keys.publicKey), remote = identity('remote', remoteKeys.publicKey)
  const received: RemoteControlPeerApplicationMessage[] = [], connections: RemoteControlPeerConnection[] = [], events: unknown[] = [], reports: string[] = []
  let notifications = 0, state: RemoteConnectionsSnapshot | null = null, gateway!: ProcessCalls, peers!: OutboundPeers
  const main = new ProcessCalls({ send: message => gateway.receive(structuredClone(message)),
    invoke: async () => { throw new Error('Outbound network work must stay in Gateway') },
    event: (target, name, value) => { events.push({ target, name, value }); if (target === 'outbound' && name === 'state') state = value as RemoteConnectionsSnapshot },
    report: message => reports.push(message) })
  gateway = new ProcessCalls({ send: message => main.receive(structuredClone(message)),
    invoke: async (target, method, args) => { assert.equal(target, 'outbound'); return peers.invoke(method, args) },
    event: (target, name, value) => { assert.equal(target, 'outbound'); peers.event(name, value) }, report: message => reports.push(message) })
  peers = new OutboundPeers(gateway, () => ({ listener: { status: 'disabled' }, inbound: [] }), () => { notifications++ })
  const server = new RemoteControlPeerServer({ identity: remote, sign: data => RemoteControlPeerKeys.sign(remoteKeys.privateKey, data),
    trustedInbound: () => local, onUnknownPeer: () => { throw new Error('Unexpected unknown peer') }, pairingBundleText: () => null,
    onError: message => reports.push(message), onConnection: connection => {
      connections.push(connection)
      connection.onMessage(untrusted => {
        const message = untrusted as RemoteControlPeerApplicationMessage
        received.push(message)
        switch (message.type) {
          case 'control-request': {
            const request = message.request
            connection.send({ type: 'control-response', response: { protocol: request.protocol, requestId: request.requestId,
              operation: request.operation, operationId: null, ok: true, value: request.operation === 'system.hello'
                ? { protocol: request.protocol, configIdentity: remote.configIdentity, runtimeChannel: 'development', instanceId: 'instance', startedAt: 1,
                  applicationVersion: 'fixture', operations: ['system.hello', 'system.status'], optionalOperations: [] }
                : { marker: request.requestId } } } as RemoteControlPeerApplicationMessage)
            return
          }
          case 'socket-request': {
            const request = message.request
            assert.equal(request.operation, 'events.subscribe')
            connection.send({ type: 'socket-response', response: { protocol: request.protocol, type: 'response', requestId: request.requestId,
              operation: 'events.subscribe', operationId: null, ok: true, value: { throughRevision: 0, truncated: false } } })
            return
          }
          case 'session-state-request': {
            const request = message.request
            if (request.kind === 'detail') throw new Error('No detail requested')
            connection.send({ type: 'session-state-response', response: { requestId: request.requestId, result: { ok: true, value: {
              kind: request.kind, epoch: connection.connectionId, revision: 1, offset: 0, next: null,
              snapshot: { revision: 1, reconciled: true, host: { presence: 'running', hostVersion: 'fixture', hostInstanceId: 'host', liveCount: 0, lastStartError: null },
                categories: [], sessions: [], orphans: [] },
            } } } })
            return
          }
          default: throw new Error('Unexpected peer request: ' + message.type)
        }
      })
    } })
  try {
    const address = await server.start('127.0.0.1', 0)
    const profile: RemoteControlPeerProfile = { profileId: 'profile', remoteComputerId: remote.remoteComputerId, remoteEndpointId: remote.remoteEndpointId,
      configIdentity: remote.configIdentity, runtimeChannel: remote.runtimeChannel, displayName: remote.displayName, endpoint: address, pinnedIdentity: remote.signing }
    await main.call('outbound', 'initialize', [{ identity: local, privateKey: keys.privateKey, profiles: [profile] }])
    assert.equal(connections.length, 0)
    assert.deepEqual(await main.call('outbound', 'network-state', []), { listener: { status: 'disabled' }, connections: peers.snapshot() })
    assert.ok(notifications > 0)
    const request = { protocol: 'appjamat-v3-control.v1' as const, operation: 'system.status' as const, requestId: 'cli-forward', body: {} }
    assert.partialDeepStrictEqual(await main.call('outbound', 'execute', [remote.remoteEndpointId, request]), { ok: true, value: { marker: 'cli-forward' } })
    assert.equal(connections.length, 1)
    assert.ok(received.some(message => message.type === 'control-request' && message.request.requestId === 'cli-forward'))
    await peers.port().connectComputer('window-hold', remote.remoteEndpointId)
    const first = connections[0]!
    main.emit('outbound', 'profiles', [{ ...profile, displayName: 'Renamed' }])
    const deadline = Date.now() + 2_000
    while (connections.length !== 2 || peers.port().viewEpoch(remote.remoteEndpointId) === null) {
      if (Date.now() >= deadline) throw new Error('Profile redial timed out')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(first.isOpen(), false)
    assert.equal((state as RemoteConnectionsSnapshot | null)?.outbound[0]?.displayName, 'Renamed')
    main.emit('outbound', 'profiles', [])
    assert.deepEqual(peers.snapshot().outbound, [])
    assert.equal(JSON.stringify(events).includes(keys.privateKey), false)
    assert.equal(JSON.stringify(events).includes(remote.signing.publicKey), false)
    assert.deepEqual(reports, [])
  } finally { peers.stop(); for (const connection of connections) connection.close(); await server.stop(); main.close(); gateway.close() }
})
