import type { SessionsOpResult } from './sessionManagerApi.types'

/**
 * The client's commit message proposals, bound after the commit manager is built.
 */
export interface SessionReviewPort {
  /** @deprecated Review runs are retired. Kept optional for existing client adapters. */
  open?(input: { sessionId: string; parentId: string; scopeRoot: string; proposal: string }): Promise<SessionsOpResult<{ commitSessionId: string }>>
  /** @deprecated No review run waits for a dialog. */
  known?(commitSessionId: string): boolean
  /**
   * Stores a worker's message for the SVN working copy that holds `directory`, under the worker's
   * session, and opens nothing. A message a person wrote there is never replaced (`message-edited`).
   */
  propose(input: { sessionId: string; directory: string; message: string }): Promise<SessionsOpResult<{ scopeRoot: string }>>
  /** Finish reads the proposal for each separately published repository mount. */
  proposalOf?(sessionId: string, scopeRoot: string): string | null
  /** A Finish committed the worktree, so the session's message for that scope has served; Keep leaves it. */
  forgetProposal(sessionId: string, scopeRoot: string): void
}
