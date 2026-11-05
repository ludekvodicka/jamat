import type { RemoteControlPeerTransport, RemoteInboundConnectionDto } from './remoteConnectionsApi.types'
import type { RemoteControlPeerIdentity } from './remoteControlPeerApi.types'
import type { RemoteControlResponse, RemoteControlStepResult } from './remoteControlApi.types'
import type { RemoteSessionStatePage, RemoteSessionStateRequest, RemoteSessionViewRequest, RemoteSessionViewResponse } from './remoteSessionApi.types'
import type { RemoteListenerRuntime } from './remotePeerListener.types'

export type PeerAuthority = Pick<RemoteControlPeerTransport, 'connectionId' | 'remoteIdentity' | 'capabilities'>

export interface PeerProcessIdentity {
  identity: RemoteControlPeerIdentity
  privateKey: string
  trust: readonly RemoteControlPeerIdentity[]
  bundleText: string | null
}

export interface PeerProcessState {
  listener: RemoteListenerRuntime
  inbound: readonly RemoteInboundConnectionDto[]
}

export interface PeerForwardPort {
  execute(peer: PeerAuthority, request: unknown, signal: AbortSignal): Promise<RemoteControlResponse>
  view(peer: PeerAuthority, request: RemoteSessionViewRequest, signal: AbortSignal): Promise<RemoteSessionViewResponse['result']>
  state(peer: PeerAuthority, request: RemoteSessionStateRequest, signal: AbortSignal): Promise<RemoteControlStepResult<RemoteSessionStatePage>>
  releaseConnection(peer: PeerAuthority): void
}
