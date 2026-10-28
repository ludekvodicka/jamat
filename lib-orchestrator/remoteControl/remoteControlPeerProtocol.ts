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
    'sessions.restart', 'sessions.switchAccount', 'sessions.fork', 'sessions.remove', 'sessions.setDetails',
    'sessions.worktree', 'sessions.children', 'sessions.conflicts', 'sessions.resolveConflict',
    'sessions.finishWorktree', 'sessions.backToWork', 'sessions.discardWorktree', 'sessions.cleanupWorktree', 'sessions.updateMain',
    'sessions.retrySetup', 'sessions.transcript', 'sessions.scripts',
    'sessions.worktreeResults', 'sessions.acknowledgeWorktreeResult', 'sessions.clearActions',
    'sessions.finalize',
    'tabs.openFile',
    /*
     * Grantable for the reason `sessions.create` is: a create already names a colour and a group on
     * the computer that will RUN the session, so being able to name them at birth and never again
     * over the same link would be an asymmetry with no rule behind it. Neither reads anything back.
     */
    'sessions.color',
    'sessions.group',
    /*
     * The note is the one field with a READ of its own, because it is the one a caller WRITES in
     * order to be read back: a scheduler leaves the sentence saying what its session is waiting
     * for, and the next pass over the same session has to see what it left there.
     */
    'sessions.note',
    'sessions.setNote',
    'terminal.peek',
    'terminal.send',
    /*
     * What that computer can start an agent on, asked before a session is founded there. Its
     * capability is the version marker of the whole model feature: a controller sends `model` on a
     * create ONLY to a peer that offered this, because an older target's create validator reads
     * exact keys and refuses the entire request over one it does not know.
     */
    'agents.describe',
    'accounts.list',
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
  // Pre-model peers rejected unknown names; agents.describe arrived with tolerant negotiation.
  static readonly legacyCapabilities = [
    'control:system.hello', 'control:system.status', 'control:projects.list', 'control:sessions.list',
    'control:sessions.create', 'control:sessions.reopen', 'control:sessions.finalize',
    'control:terminal.peek', 'control:terminal.send',
    'socket:events.subscribe', 'socket:terminal.attach', 'socket:terminal.input',
    'socket:terminal.resize', 'socket:terminal.active', 'socket:terminal.detach',
  ] as const
  static readonly workspaceCapabilities = [
    'session-workspace.read', 'session-workspace.views', 'session-workspace.files',
    'session-workspace.changes', 'session-workspace.tasks', 'session-workspace.reviews',
    'session-workspace.actions', 'session-workspace.metadata', 'session-workspace.notes',
    'session-workspace.model', 'session-workspace.finish', 'session-workspace.conflicts', 'session-workspace.history', 'session-workspace.sidebar', 'session-workspace.commands',
    'session-workspace.commit-receipts',
  ] as const
  static readonly capabilities = [
    'agents.accounts',
    ...RemoteControlPeerConst.controlOperations.map((operation) => `control:${operation}` as const),
    ...RemoteControlPeerConst.socketOperations.map((operation) => `socket:${operation}` as const),
    ...RemoteControlPeerConst.workspaceCapabilities,
  ] as const
}
