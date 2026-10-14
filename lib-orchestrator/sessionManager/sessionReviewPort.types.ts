import type { SessionsOpResult } from './sessionManagerApi.types'

/**
 * The commit dialog of the client, bound late because the client builds it after the sessions. The
 * review run of an SVN action opens its review through it once and waits for the status itself.
 */
export interface SessionReviewPort {
  /** `parentId`: the session whose action reviews; once the review settles, its workflow takes the focus back. */
  open(input: { sessionId: string; parentId: string; scopeRoot: string; proposal: string }): Promise<SessionsOpResult<{ commitSessionId: string }>>
  /** Whether the commit dialog still knows the review; a client restart forgets every one. */
  known(commitSessionId: string): boolean
  /**
   * Stores a worker's message for the SVN working copy that holds `directory`, under the worker's
   * session, and opens nothing. A message a person wrote there is never replaced (`message-edited`).
   */
  propose(input: { sessionId: string; directory: string; message: string }): Promise<SessionsOpResult<{ scopeRoot: string }>>
  /** The message stored for the session and scope (`commit propose`, or what a person wrote over it), or null. */
  proposalOf(sessionId: string, scopeRoot: string): string | null
  /** A Finish committed the worktree, so the session's message for that scope has served; Keep leaves it. */
  forgetProposal(sessionId: string, scopeRoot: string): void
}

/** Where a Finish started from the window shows the worktree; bound by the client, never named here. */
export interface SessionEditorPort {
  openWorktree(worktreePath: string, ownerName: string): void
}
