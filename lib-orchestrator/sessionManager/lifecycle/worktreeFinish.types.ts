import type { SessionRecordWorktree } from '../records/sessionRecord.types'
import type { SessionFinishChoice, SessionsOpResult, SessionWorktreeInfo } from '../sessionManagerApi.types'

/**
 * Finishing a worktree session, one implementation per worktree kind. `SessionManager` selects it by
 * the record's kind; no implementation branches on the other kind. Each one is built with a
 * `WorktreeEnded` and calls it when an ending did all it promised.
 */
export interface WorktreeFinisher {
  /** svn answers once the first review is open, or at once when the finish ends without one. */
  finish(sessionId: string): Promise<SessionsOpResult>
  discard(sessionId: string): Promise<SessionsOpResult>
  /** Measured off the snapshot path; it may run a VCS process in the worktree. */
  facts(worktree: SessionRecordWorktree): Promise<WorktreeFinishFacts>
  /** Read on every recompose, so it costs nothing: what it needs of the disk, `facts` measured. */
  choicesOf(worktree: SessionRecordWorktree): readonly SessionFinishChoice[]
}

export interface WorktreeFinishFacts {
  diff: SessionWorktreeInfo['diff']
  baseMoved: boolean
}

/**
 * A finish or a discard ended as the person asked: the work landed, or was thrown away, and the
 * worktree is gone. What follows, the session going too, is `SessionManager`'s to decide.
 */
export type WorktreeEnded = (sessionId: string) => void
