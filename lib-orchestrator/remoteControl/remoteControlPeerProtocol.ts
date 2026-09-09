/**
 * The peer protocol as VALUES, for the same reason `remoteControlProtocol.ts` exists: a `.types.ts`
 * erases, and the capability list, the handshake limits and the protocol name do not.
 */

import type { RemoteControlOperation } from './remoteControlApi.types'
import { RemoteControlConst } from './remoteControlProtocol'

export class RemoteControlPeerConst {
  static readonly protocol = 'appjamat-v3-peer.v1' as const
  static readonly signingAlgorithm = 'ed25519' as const
  static readonly keyAgreementAlgorithm = 'x25519' as const
  static readonly cipherAlgorithm = 'aes-256-gcm' as const
  static readonly controlOperations = [
    'system.hello',
    'system.status',
    'projects.list',
    'sessions.list',
    'sessions.create',
    'sessions.reopen',
    'sessions.finalize',
    'terminal.peek',
    'terminal.send',
    /*
     * What that computer can start an agent on, asked before a session is founded there. Its
     * capability is the version marker of the whole model feature: a controller sends `model` on a
     * create ONLY to a peer that offered this, because an older target's create validator reads
     * exact keys and refuses the entire request over one it does not know.
     */
    'agents.describe',
  ] as const satisfies readonly RemoteControlOperation[]
  /*
   * Every socket operation, taken from the one list rather than copied beside it. `satisfies` only
   * held each member to a valid name; it never held the list to being COMPLETE, so an operation
   * added to the protocol would simply never have been offered to a peer.
   */
  static readonly socketOperations = RemoteControlConst.socketOperations
  /*
   * The two sizes of the peer wire, in the package that owns the protocol. They are ONE decision in
   * two halves: what a peer may say, and what the sealed frame carrying it may weigh. They used to
   * sit as bare numbers in the cipher and in the listener's `maxPayload`, in different packages, and
   * if those two ever disagreed the effect is invisible either way - a frame read in full and then
   * refused, or a limit the socket never lets anybody reach.
   */
  static readonly maximumPlaintextBytes = 1_048_576
  static readonly maximumFrameBytes = 1_500_000
  static readonly capabilities = [
    ...RemoteControlPeerConst.controlOperations.map((operation) => `control:${operation}` as const),
    ...RemoteControlPeerConst.socketOperations.map((operation) => `socket:${operation}` as const),
  ] as const
}
