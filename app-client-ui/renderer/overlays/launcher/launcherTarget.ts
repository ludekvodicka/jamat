/** The computer a remote card is about: what to send to, and what that computer is called. */
export interface LauncherRemoteTarget {
  remoteEndpointId: string
  displayName: string
}

/**
 * Which computer the work this card starts will run on. It sits at the launcher root beside
 * `launcherBinding.ts` for the same reason that one does: it is what the screens hand each other,
 * and three of them read it - the computer list writes it, the projects screen lists that
 * computer's catalog with it, and the create screen sends to it.
 *
 * A closed discriminant rather than a nullable remote target, because every branch over it ends in
 * a throw: a third kind of target would have to be decided rather than arriving as a quiet local
 * one, and "local" is the case where sending to the wrong machine is silent.
 */
export type LauncherTarget =
  | { kind: 'local' }
  | ({ kind: 'remote' } & LauncherRemoteTarget)
