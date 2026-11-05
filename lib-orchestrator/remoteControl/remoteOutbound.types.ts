import type { SessionsOpResult } from '../sessionManager/sessionManagerApi.types'
import type { RemoteControlSocketRequest, RemoteControlStepResult } from './remoteControlApi.types'
import type { RemoteConnectionsPort, RemoteConnectionsSnapshot } from './remoteConnectionsApi.types'
import type { RemoteControlPeerIdentity, RemoteControlPeerProfile } from './remoteControlPeerApi.types'
import type { RemoteSessionDetail, RemoteSessionView, RemoteSessionViewRequest, RemoteSessionViewResponse } from './remoteSessionApi.types'
import type { PeerProcessState } from './peerProcess.types'

export interface RemoteOutboundPort extends RemoteConnectionsPort {
  connectComputer(holderId: string, endpointId: string): Promise<RemoteControlStepResult<undefined>>
  releaseConnections(holderId: string): void
  selectSession(endpointId: string, sessionId: string): Promise<RemoteControlStepResult<undefined>>
  disconnectSessions(endpointId: string, sessionIds?: readonly string[]): Promise<void>
  viewEpoch(endpointId: string): string | null
  sessionView(endpointId: string, request: RemoteSessionViewRequest): Promise<RemoteSessionViewResponse['result']>
  sessionDetail(endpointId: string, view: RemoteSessionView): Promise<RemoteControlStepResult<RemoteSessionDetail>>
  sessionReference(endpointId: string, sessionId: string): SessionsOpResult<{ text: string }>
  terminalPasteImage(endpointId: string, attachId: string, data: string): Promise<RemoteControlStepResult<{ path: string }>>
  terminalPasteFile(endpointId: string, attachId: string, chunk: RemotePasteFileChunk): Promise<RemoteControlStepResult<{ path: string | null }>>
}

export type RemotePasteFileChunk = Pick<Extract<RemoteControlSocketRequest, { operation: 'terminal.pasteFile' }>, 'uploadId' | 'fileName' | 'size' | 'offset' | 'data'>

export interface RemoteOutboundProfiles {
  snapshot(): RemoteConnectionsSnapshot
  reloadProfiles(): void
  retryNow(endpointId: string): void
}

export interface OutboundProcessIdentity {
  identity: RemoteControlPeerIdentity
  privateKey: string
  profiles: readonly RemoteControlPeerProfile[]
}

export interface RemoteWindowIdentity { windowId: string; epoch: string }

export interface RemoteNetworkState { connections: RemoteConnectionsSnapshot; listener: PeerProcessState['listener'] }
