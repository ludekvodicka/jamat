import { describe, expect, it } from 'vitest'

import type { RemoteControlPeerIdentity } from './remoteControlPeerApi.types'
import { RemoteControlPeerKeys } from './remoteControlPeerKeys'
import { RemoteControlPairing } from './remoteControlPairing'

describe('lib-orchestrator/remoteControl/remoteControlPairing', () => {
  it('exports only the public identity and builds an exact pinned profile', () => {
    const keys = RemoteControlPeerKeys.generateSigningKeyPair()
    const identity = RemoteControlPairingTest.identity(keys.publicKey)
    const bundle = RemoteControlPairing.bundle(identity, { host: 'computer-a.lan', port: 47_150 })
    const profile = RemoteControlPairing.profile(bundle, { profileId: 'profile-a' })
    const serialized = JSON.stringify({ bundle, profile })
    expect(profile).toEqual({
      profileId: 'profile-a',
      remoteComputerId: identity.remoteComputerId,
      remoteEndpointId: identity.remoteEndpointId,
      configIdentity: identity.configIdentity,
      runtimeChannel: identity.runtimeChannel,
      displayName: identity.displayName,
      endpoint: { host: 'computer-a.lan', port: 47_150 },
      pinnedIdentity: identity.signing,
    })
    expect(serialized).not.toContain(keys.privateKey)
    expect(serialized).not.toContain('privateKey')
    expect(serialized).not.toContain('token')
  })

  it('rejects a hidden extra field and a fingerprint that does not match the public key', () => {
    const keys = RemoteControlPeerKeys.generateSigningKeyPair()
    const bundle = RemoteControlPairing.bundle(
      RemoteControlPairingTest.identity(keys.publicKey),
      { host: '127.0.0.1', port: 47_150 },
    )
    expect(() => RemoteControlPairing.parse({ ...bundle, privateKey: keys.privateKey }))
      .toThrow('invalid')
    expect(() => RemoteControlPairing.parse({
      ...bundle,
      identity: {
        ...bundle.identity,
        signing: { ...bundle.identity.signing, fingerprint: 'x'.repeat(43) },
      },
    })).toThrow('identity')
  })

  it('rejects invalid endpoint fields before a client URL can be composed', () => {
    const keys = RemoteControlPeerKeys.generateSigningKeyPair()
    const bundle = RemoteControlPairing.bundle(
      RemoteControlPairingTest.identity(keys.publicKey),
      { host: '127.0.0.1', port: 47_150 },
    )
    expect(() => RemoteControlPairing.profile({
      ...bundle,
      endpoint: { host: 'http://host/path', port: 0 },
    })).toThrow('endpoint')
  })

  it('rejects line breaks in a paired display name', () => {
    const keys = RemoteControlPeerKeys.generateSigningKeyPair()
    const identity = RemoteControlPairingTest.identity(keys.publicKey)

    expect(() => RemoteControlPairing.bundle(
      { ...identity, displayName: 'Computer A\nroute: local' },
      { host: 'computer-a.lan', port: 47_150 },
    )).toThrow('identity')
  })
})

class RemoteControlPairingTest {
  static identity(publicKey: string): RemoteControlPeerIdentity {
    return {
      remoteComputerId: 'computer-a',
      remoteEndpointId: 'endpoint-a',
      configIdentity: 'config-a',
      runtimeChannel: 'development',
      displayName: 'Computer A',
      signing: {
        algorithm: 'ed25519',
        publicKey,
        fingerprint: RemoteControlPeerKeys.fingerprint(publicKey),
      },
    }
  }
}
