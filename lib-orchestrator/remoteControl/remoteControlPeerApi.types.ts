import type { RemoteControlPeerConst } from './remoteControlPeerProtocol'
import type {
  RemoteControlRequestUnion,
  RemoteControlResponse,
  RemoteControlSocketRequest,
  RemoteControlSocketResponse,
} from './remoteControlApi.types'
import type { RuntimeChannel } from '../shared/configIdentity.types'

export type RemoteControlPeerProtocol = typeof RemoteControlPeerConst.protocol
export type RemoteControlPeerCapability = typeof RemoteControlPeerConst.capabilities[number]
export type RemoteControlPeerHandshakeErrorCode =
  | 'invalid-handshake'
  | 'protocol-mismatch'
  | 'wrong-peer'
  | 'unauthorized'
  | 'replay'

export interface RemoteControlPeerPinnedIdentity {
  algorithm: typeof RemoteControlPeerConst.signingAlgorithm
  publicKey: string
  fingerprint: string
}

export interface RemoteControlMachineIdentity {
  remoteComputerId: string
  displayName: string
  signing: RemoteControlPeerPinnedIdentity
}

export interface RemoteControlPeerIdentity extends RemoteControlMachineIdentity {
  remoteEndpointId: string
  configIdentity: string
  runtimeChannel: RuntimeChannel
}

export interface RemoteControlPeerEndpoint {
  host: string
  port: number
}

export interface RemoteControlPeerPairingBundle {
  schemaVersion: 1
  protocol: RemoteControlPeerProtocol
  identity: RemoteControlPeerIdentity
  endpoint: RemoteControlPeerEndpoint
}

/**
 * One computer this one may dial, and where. Whether it IS dialled right now is not written here
 * and never was persisted: a connection stands while something needs it and is dropped when
 * nothing does, so the file says who may be reached and the connector says who is.
 *
 * `outboundEnabled` lived here until 2026-09-07 and is gone: with dialling on demand its only off
 * state was "paired but unreachable", which is what Forget says without leaving a dead row behind.
 * A file still holding the key parses - see `RemoteControlPairing.assertProfile`.
 */
export interface RemoteControlPeerProfile {
  profileId: string
  remoteComputerId: string
  remoteEndpointId: string
  configIdentity: string
  runtimeChannel: RuntimeChannel
  displayName: string
  endpoint: RemoteControlPeerEndpoint
  pinnedIdentity: RemoteControlPeerPinnedIdentity
}

export interface RemoteControlPeerClientHello {
  protocol: RemoteControlPeerProtocol
  type: 'client-hello'
  connectionId: string
  sentAt: number
  nonce: string
  identity: RemoteControlPeerIdentity
  expectedRemoteComputerId: string
  expectedRemoteEndpointId: string
  ephemeralPublicKey: string
  /**
   * What the sender ASKS for, which is not the same as what this build can name: a newer peer
   * offers capabilities this one has never heard of, and those are dropped by the intersection
   * rather than refusing the handshake. The negotiated set - `RemoteControlPeerCodecResult
   * .capabilities` - stays the narrow type, because only a name both sides know can be granted.
   *
   * It is also SIGNED, so what arrives here is what was signed and is never filtered in place.
   */
  capabilities: readonly string[]
  signature: string
}

export interface RemoteControlPeerServerHello {
  protocol: RemoteControlPeerProtocol
  type: 'server-hello'
  connectionId: string
  sentAt: number
  nonce: string
  identity: RemoteControlPeerIdentity
  ephemeralPublicKey: string
  /** What the server SELECTED, for the same reason and read back the same way as the client's. */
  capabilities: readonly string[]
  clientHelloHash: string
  signature: string
}

export interface RemoteControlPeerSealedFrame {
  protocol: RemoteControlPeerProtocol
  type: 'sealed'
  connectionId: string
  sequence: number
  ciphertext: string
  authenticationTag: string
}

export type RemoteControlPeerApplicationMessage =
  | { type: 'control-request'; request: RemoteControlRequestUnion }
  | { type: 'control-response'; response: RemoteControlResponse }
  | { type: 'socket-request'; request: RemoteControlSocketRequest }
  | { type: 'socket-response'; response: RemoteControlSocketResponse }

export type RemoteControlPeerEncryptedMessage =
  | RemoteControlPeerApplicationMessage
  | { type: 'heartbeat-ping'; sentAt: number }
  | { type: 'heartbeat-pong'; sentAt: number }

/**
 * The same four kinds coming the other way, with their payloads still unread.
 *
 * A sealed frame proves who sent it and that nobody changed it on the way. It proves NOTHING about
 * what is inside, so an inbound payload stays `unknown` until the side that acts on it validates it:
 * a request through `RemoteControl.execute` or the socket validation, an answer through
 * `RemoteControlResponseValidation`. The types above are what a sender builds; these are what a
 * receiver gets.
 */
export type RemoteControlPeerInboundApplicationMessage =
  | { type: 'control-request'; request: unknown }
  | { type: 'control-response'; response: unknown }
  | { type: 'socket-request'; request: unknown }
  | { type: 'socket-response'; response: unknown }

export type RemoteControlPeerInboundMessage =
  | RemoteControlPeerInboundApplicationMessage
  | { type: 'heartbeat-ping'; sentAt: number }
  | { type: 'heartbeat-pong'; sentAt: number }
