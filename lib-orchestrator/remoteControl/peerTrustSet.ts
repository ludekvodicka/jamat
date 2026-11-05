import type { RemoteControlPeerIdentity } from './remoteControlPeerApi.types'

export class PeerTrustSet {
  private readonly peers: Map<string, RemoteControlPeerIdentity>

  constructor() { this.peers = new Map() }

  replace(peers: readonly RemoteControlPeerIdentity[]): void {
    this.peers.clear()
    for (const peer of peers)
      this.peers.set(PeerTrustSet.key(peer.remoteComputerId, peer.remoteEndpointId), structuredClone(peer))
  }

  revoke(remoteComputerId: string, remoteEndpointId: string): void {
    this.peers.delete(PeerTrustSet.key(remoteComputerId, remoteEndpointId))
  }

  trustedInbound(remoteComputerId: string, remoteEndpointId: string): RemoteControlPeerIdentity | null {
    const peer = this.peers.get(PeerTrustSet.key(remoteComputerId, remoteEndpointId))
    return peer ? structuredClone(peer) : null
  }

  allows(identity: RemoteControlPeerIdentity): boolean {
    const peer = this.peers.get(PeerTrustSet.key(identity.remoteComputerId, identity.remoteEndpointId))
    return peer !== undefined && peer.signing.publicKey === identity.signing.publicKey
      && peer.signing.fingerprint === identity.signing.fingerprint
      && peer.configIdentity === identity.configIdentity && peer.runtimeChannel === identity.runtimeChannel
  }

  private static key(computerId: string, endpointId: string): string {
    return JSON.stringify([computerId, endpointId])
  }
}
