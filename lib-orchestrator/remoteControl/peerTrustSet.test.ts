import { describe, expect, it } from 'vitest'
import { PeerTrustSet } from './peerTrustSet'
import type { RemoteControlPeerIdentity } from './remoteControlPeerApi.types'

const peer: RemoteControlPeerIdentity = { remoteComputerId: 'pc', remoteEndpointId: 'endpoint', configIdentity: 'config',
  runtimeChannel: 'development', displayName: 'Peer', signing: { algorithm: 'ed25519', publicKey: 'key', fingerprint: 'print' } }

describe('PeerTrustSet', () => {
  it('requires the current identity pin and owns snapshots of pushed trust', () => {
    const trust = new PeerTrustSet()
    expect(trust.allows(peer)).toBe(false)
    const pushed = structuredClone(peer)
    trust.replace([pushed])
    pushed.signing.publicKey = 'changed'
    expect(trust.allows(peer)).toBe(true)
    expect(trust.allows(pushed)).toBe(false)
    expect(trust.allows({ ...peer, configIdentity: 'other' })).toBe(false)
    const read = trust.trustedInbound('pc', 'endpoint')!
    read.signing.publicKey = 'changed'
    expect(trust.allows(peer)).toBe(true)
  })

  it('replaces and revokes trust immediately without changing an independent peer', () => {
    const other = { ...peer, remoteEndpointId: 'other' }
    const trust = new PeerTrustSet()
    trust.replace([peer, other])
    trust.revoke('pc', 'endpoint')
    expect(trust.allows(peer)).toBe(false)
    expect(trust.allows(other)).toBe(true)
    trust.replace([])
    expect(trust.allows(other)).toBe(false)
    expect(trust.trustedInbound('pc', 'endpoint')).toBeNull()
  })
})
