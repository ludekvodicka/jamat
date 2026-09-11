import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'

import { RemoteControlPeerClient } from './remoteControlPeerClient'
import { RemoteControlPeerKeys } from './remoteControlPeerKeys'
import type { RemoteControlPeerIdentity, RemoteControlPeerProfile } from './remoteControlPeerApi.types'

describe('LibOrchestrator/RemoteControl/RemoteControlPeerClient', () => {
  it('aborting a pending handshake terminates its socket and removes the abort listener', async () => {
    const fixture = new RemoteControlPeerClientTest()
    const abort = new AbortController()
    const pending = fixture.client.connect(fixture.profile, abort.signal)
    abort.abort()
    expect(await pending).to.deep.include({ ok: false, error: { code: 'unavailable', detail: 'Remote connection cancelled' } })
    expect(fixture.socket.terminated).to.equal(true)
    expect(fixture.socket.listenerCount('open')).to.equal(0)
    expect(fixture.socket.listenerCount('message')).to.equal(0)
    fixture.socket.emit('error', new Error('Late socket error after abort'))
  })

  it('an already cancelled dial never creates a socket', async () => {
    const fixture = new RemoteControlPeerClientTest()
    const abort = new AbortController()
    abort.abort()
    expect((await fixture.client.connect(fixture.profile, abort.signal)).ok).to.equal(false)
    expect(fixture.dials).to.equal(0)
  })
})

class RemoteControlPeerClientTest {
  readonly socket = new RemoteControlPeerClientTestSocket()
  readonly profile: RemoteControlPeerProfile
  readonly client: RemoteControlPeerClient
  dials = 0

  constructor() {
    const keys = RemoteControlPeerKeys.generateSigningKeyPair()
    const identity: RemoteControlPeerIdentity = {
      remoteComputerId: 'computer', remoteEndpointId: 'endpoint', configIdentity: 'config',
      runtimeChannel: 'development', displayName: 'Computer',
      signing: { algorithm: 'ed25519', publicKey: keys.publicKey, fingerprint: RemoteControlPeerKeys.fingerprint(keys.publicKey) },
    }
    this.profile = {
      profileId: 'profile', remoteComputerId: 'target', remoteEndpointId: 'target-endpoint',
      configIdentity: 'target-config', runtimeChannel: 'development', displayName: 'Target',
      endpoint: { host: '127.0.0.1', port: 47150 }, pinnedIdentity: identity.signing,
    }
    this.client = new RemoteControlPeerClient(identity, (payload) => RemoteControlPeerKeys.sign(keys.privateKey, payload), {
      socket: () => { this.dials += 1; return this.socket as unknown as WebSocket },
    })
  }
}

class RemoteControlPeerClientTestSocket extends EventEmitter {
  terminated = false
  terminate(): void { this.terminated = true }
}
