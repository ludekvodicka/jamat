import type {
  RemoteControlComputerFactsDto,
  RemoteControlRequestUnion,
  RemoteControlResponse,
  RemoteControlStepResult,
} from './remoteControlApi.types'
import type {
  RemoteControlPeerApplicationMessage,
  RemoteControlPeerCapability,
  RemoteControlPeerInboundApplicationMessage,
  RemoteControlPeerIdentity,
} from './remoteControlPeerApi.types'
import type {
  SessionsSnapshot,
  TerminalAttachSpec,
  TerminalFrame,
} from '../sessionManager/sessionManagerApi.types'

/** The same computer as the CLI sees, plus what only a window can use. */
export interface RemoteOutboundEndpointDto extends RemoteControlComputerFactsDto {
  connectionId: string | null
  sessions: SessionsSnapshot | null
}

export type RemoteEndpointIdentityDto = Omit<RemoteControlPeerIdentity, 'signing'>

export interface RemoteInboundConnectionDto {
  connectionId: string
  connectedAt: number
  identity: RemoteEndpointIdentityDto
  activeSessionIds: readonly string[]
}

export interface RemoteConnectionsSnapshot {
  revision: number
  outbound: readonly RemoteOutboundEndpointDto[]
  inbound: readonly RemoteInboundConnectionDto[]
}

export interface RemoteControlPeerTransport {
  readonly connectionId: string
  readonly remoteIdentity: RemoteControlPeerIdentity
  /** The names the handshake agreed on, not free-form text: a typo in a gate must not compile. */
  readonly capabilities: readonly RemoteControlPeerCapability[]
  isOpen(): boolean
  send(message: RemoteControlPeerApplicationMessage): boolean
  onMessage(listener: (message: RemoteControlPeerInboundApplicationMessage) => void): () => void
  onClose(listener: () => void): () => void
  close(): void
}

export interface RemoteConnectionsPort {
  snapshot(): RemoteConnectionsSnapshot
  execute(
    remoteEndpointId: string,
    request: RemoteControlRequestUnion,
  ): Promise<RemoteControlResponse>
  attachTerminal(
    remoteEndpointId: string,
    attachId: string,
    spec: TerminalAttachSpec,
    onFrame: (frame: TerminalFrame) => void,
  ): Promise<RemoteControlStepResult<{ attachId: string; sessionId: string }>>
  terminalInput(
    remoteEndpointId: string,
    attachId: string,
    data: string,
  ): Promise<RemoteControlStepResult<unknown>>
  terminalResize(
    remoteEndpointId: string,
    attachId: string,
    cols: number,
    rows: number,
  ): Promise<RemoteControlStepResult<unknown>>
  terminalActive(
    remoteEndpointId: string,
    attachId: string,
    active: boolean,
  ): Promise<RemoteControlStepResult<unknown>>
  detachTerminal(
    remoteEndpointId: string,
    attachId: string,
  ): Promise<RemoteControlStepResult<unknown>>
}
