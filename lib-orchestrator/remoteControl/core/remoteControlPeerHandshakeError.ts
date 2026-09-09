import type {
  RemoteControlPeerHandshakeErrorCode,
  RemoteControlPeerIdentity,
} from '../remoteControlPeerApi.types'

export class RemoteControlPeerHandshakeError extends Error {
  constructor(
    readonly code: RemoteControlPeerHandshakeErrorCode,
    message: string,
    /**
     * Set only on `unauthorized` for an UNKNOWN caller whose hello proved possession of the key it
     * carries. It is what lets the listener ask a person about a caller nobody has pinned yet; a
     * known identity arriving under another key never gets one, so an impersonation attempt has no
     * dialog to work on.
     */
    readonly claimant?: RemoteControlPeerIdentity,
  ) {
    super(message)
    this.name = 'RemoteControlPeerHandshakeError'
  }
}
