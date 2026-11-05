import { describe, expect, it, vi } from 'vitest'
import { ProcessCalls } from '../../../lib-orchestrator/shared/processCalls'
import type { RemoteConnectionsSnapshot } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteControlPeerIdentity, RemoteControlPeerProfile } from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { GatewayOutboundClient } from './gatewayOutboundClient'

describe('GatewayOutboundClient private protocol', () => {
  it('forwards main control and native authority with exact arguments while caching only public state', async () => {
    const invokes: unknown[][] = [], events: unknown[][] = [], changed = vi.fn(), removed = vi.fn()
    let gateway!: ProcessCalls, client!: GatewayOutboundClient
    const main = new ProcessCalls({ send: message => gateway.receive(structuredClone(message)), invoke: async () => { throw new Error('No work callback') },
      event: (target, name, value) => { expect(target).toBe('outbound'); client.event(name, value) }, report: message => { throw new Error(message) } })
    gateway = new ProcessCalls({ send: message => main.receive(structuredClone(message)),
      invoke: async (...args) => { invokes.push(args.slice(0, 3)); return { ok: true, value: null } },
      event: (...args) => { events.push(args) }, report: message => { throw new Error(message) } })
    const identity: RemoteControlPeerIdentity = { remoteComputerId: 'computer', remoteEndpointId: 'endpoint', configIdentity: 'config', runtimeChannel: 'development', displayName: 'name',
      signing: { algorithm: 'ed25519', publicKey: 'public', fingerprint: 'fingerprint' } }
    const profiles: RemoteControlPeerProfile[] = []
    client = new GatewayOutboundClient(main, () => profiles, changed, removed)
    try {
      await client.initialize({ identity, privateKey: 'private-key' })
      const request = { protocol: 'appjamat-v3-control.v1' as const, operation: 'system.status' as const, requestId: 'cli-request', body: {} }
      await client.execute('peer', request)
      const viewRequest = { operation: 'views.open' as const, requestId: 'view-request', epoch: 'peer-epoch', body: { sessionId: 'session', viewerId: 'viewer' } }
      await client.sessionView('peer', viewRequest)
      const window = { windowId: '7', epoch: 'window-epoch' }
      await client.authorizeView(window, 'peer', 'view')
      await client.pasteImage(window, 'peer', 'private-claim', 'image')
      const chunk = { uploadId: 'upload', fileName: 'file', size: 3, offset: 0, data: 'YWJj' }
      await client.pasteFile(window, 'peer', 'private-claim', chunk)
      expect(invokes).toEqual([
        ['outbound', 'initialize', [{ identity, privateKey: 'private-key', profiles: [] }]],
        ['outbound', 'execute', ['peer', request]], ['outbound', 'session-view', ['peer', viewRequest]],
        ['windows', 'remote-view', ['7', 'window-epoch', 'peer', 'view']],
        ['windows', 'remote-paste-image', ['7', 'window-epoch', 'peer', 'private-claim', 'image']],
        ['windows', 'remote-paste-file', ['7', 'window-epoch', 'peer', 'private-claim', chunk]],
      ])
      const state = { revision: 9, outbound: [{ remoteEndpointId: 'peer', status: 'connected', connectionId: 'peer-epoch' }], inbound: [] } as unknown as RemoteConnectionsSnapshot
      gateway.emit('outbound', 'state', state)
      expect(client.viewEpoch('peer')).toBe('peer-epoch')
      expect(client.viewEpoch('unknown')).toBeNull()
      client.snapshot().outbound[0]!.displayName = 'Mutated copy'
      expect(client.snapshot()).toEqual(state)
      expect(JSON.stringify(client.snapshot())).not.toContain('private-key')
      expect(changed).toHaveBeenCalledOnce()
      gateway.emit('outbound', 'session-removed', { endpointId: 'peer', sessionId: 'session' })
      expect(removed).toHaveBeenCalledWith('peer', 'session')
      profiles.push({ ...identity, profileId: 'profile', endpoint: { host: 'edited', port: 47150 }, pinnedIdentity: identity.signing })
      client.reloadProfiles(); client.retryNow('peer'); client.notifyChanged(); client.stop()
      expect(events).toEqual([['outbound', 'profiles', profiles], ['outbound', 'retry', 'peer'], ['outbound', 'changed', null], ['outbound', 'stop', null]])
    } finally { main.close(); gateway.close() }
  })
})
