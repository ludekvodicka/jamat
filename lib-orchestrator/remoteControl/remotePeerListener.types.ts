import type { RemoteInboundConnectionDto } from './remoteConnectionsApi.types'

export interface RemoteControlListenerSettings {
  enabled: boolean
  bindHost: string
  port: number
  advertisedHost: string
}

export type RemoteListenerRuntime =
  | { status: 'disabled' }
  | { status: 'starting' }
  | { status: 'listening'; actualHost: string; actualPort: number }
  | { status: 'failed'; error: string }

export type RemoteListenerApplyResult =
  | { ok: true }
  | { ok: false; code: 'busy' | 'stopping' | 'bind-failed'; detail: string }

export interface RemotePeerListenerPort {
  apply(settings: RemoteControlListenerSettings): Promise<RemoteListenerApplyResult>
  runtime(): RemoteListenerRuntime
}

export interface RemoteInboundPort {
  snapshot(): readonly RemoteInboundConnectionDto[]
  closeEndpoint(remoteComputerId: string, remoteEndpointId: string): Promise<void>
}
