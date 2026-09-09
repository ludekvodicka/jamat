import type { RemoteOutboundConnectionStatus } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlPeerEndpoint } from '../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { RuntimeChannel } from '../../lib-orchestrator/shared/configIdentity.types'
import type { RemoteControlListenerSettings } from './remoteControlSettings'

/**
 * This computer, as the Remote Control screen names it. The fingerprint is here and the public key
 * it is made of is not: the fingerprint is the short thing two people read to each other, and the
 * key itself travels in the pairing bundle below or nowhere.
 */
export interface RemoteSettingsIdentityDto {
  remoteComputerId: string
  remoteEndpointId: string
  displayName: string
  fingerprint: string
  configIdentity: string
  runtimeChannel: RuntimeChannel
}

/**
 * What the inbound listener is really doing, as opposed to what the file asks of it. Lives here
 * rather than beside its owner because the renderer draws it and the main process holds it, and a
 * second copy of the union is how the two end up disagreeing about what `failed` carries.
 */
export type RemoteListenerRuntime =
  | { status: 'disabled' }
  | { status: 'starting' }
  | { status: 'listening'; actualHost: string; actualPort: number }
  /** Sanitized through `ErrorText`: a message, never a stack and never a credential. */
  | { status: 'failed'; error: string }

export interface RemoteSettingsListenerDto {
  configured: RemoteControlListenerSettings
  runtime: RemoteListenerRuntime
}

/** One paired computer this one dials, and what the connector has learned about reaching it. */
export interface RemoteSettingsProfileDto {
  profileId: string
  displayName: string
  remoteComputerId: string
  remoteEndpointId: string
  configIdentity: string
  runtimeChannel: RuntimeChannel
  endpoint: RemoteControlPeerEndpoint
  fingerprint: string
  status: RemoteOutboundConnectionStatus
  error: string | null
  /**
   * The connection's own diagnosis, and the reason the sessions tree does not need it: a computer
   * that is not connected has no row there by decision, so this screen is where "why not" is read.
   * All three are absent until the connector has something to say - it has never reached that
   * computer, no dial is waiting, or no hello has been answered.
   */
  lastConnectedAt: number | null
  nextRetryAt: number | null
  applicationVersion: string | null
}

/**
 * One computer that was let in, as the Allowed-in list names it. It is the other direction from the
 * profiles above and shares nothing with them: a person at THIS computer answered a dialog for this
 * row, and Revoke is the only way it leaves. There is no profile behind it and there does not need
 * to be one - being allowed in says nothing about whether this computer dials back.
 */
export interface RemoteSettingsInboundPeerDto {
  remoteComputerId: string
  remoteEndpointId: string
  displayName: string
  fingerprint: string
  addedAt: number
  /** Whether that computer is connected right now, joined from the live inbound registry. */
  connected: boolean
}

/**
 * Everything the Remote Control screen draws, in one read.
 *
 * **Credential-free by contract**: no private key, no bearer, no Host token, no trust file content
 * ever reaches it. The screen shows fingerprints and the PUBLIC pairing bundle, which are the two
 * things pairing exists to hand around; anything else that identifies this computer to another one
 * stays in the main process. `serviceRemoteSettingsIpc.test.ts` reads the serialized snapshot back
 * and refuses it if a secret is in there.
 */
export interface RemoteSettingsSnapshotDto {
  identity: RemoteSettingsIdentityDto
  /**
   * The public pairing bundle as pretty JSON, ready for the Copy button. `null` while nothing has
   * been published - the file is written at boot and again after every bind, so `null` means that
   * write failed, and a screen with nothing to copy says so rather than copying an empty string.
   */
  bundleText: string | null
  listener: RemoteSettingsListenerDto
  profiles: readonly RemoteSettingsProfileDto[]
  inbound: readonly RemoteSettingsInboundPeerDto[]
  /**
   * The `remoteControl` section of `config.json` holds something its owner cannot read, or the file
   * as a whole does. Either way nothing here can be written until it is repaired by hand, which is
   * what the screen locks its form over.
   */
  sectionDamaged: boolean
}

/**
 * Why a command did nothing, in the one vocabulary the screen has sentences for. `busy` and
 * `stopping` are the listener's own - another change is still binding, or the client is quitting -
 * and `not-confirmed` is the person at this computer saying no, whichever gate asked them.
 */
export type RemoteSettingsRefusalCode =
  | 'busy'
  | 'stopping'
  | 'bind-failed'
  | 'config-refused'
  | 'invalid-bundle'
  | 'identity-conflict'
  | 'not-confirmed'
  | 'not-found'
  /** A typed address answered with no pairing info this build can read, or did not answer at all. */
  | 'probe-failed'

export type RemoteSettingsSaveResult =
  | { ok: true }
  | { ok: false; code: RemoteSettingsRefusalCode; detail: string }
