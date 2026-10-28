import type { SessionRecord, SessionRecordWorktree } from '../../sessionManager/worktreeSessionRecords'
import type { SessionFinishChoice, SessionFinishPress, SessionsOpResult } from '../../sessionManager/sessionManagerApi.types'

/**
 * Finishing a worktree session, one implementation per worktree kind. `SessionManager` selects it by
 * the record's kind; no implementation branches on the other kind. Each one is built with a
 * `WorktreeEnded` and calls it when an ending did all it promised.
 */
export interface WorktreeFinisher {
  /**
   * True: `finish` stops a live session, runs the project's after checks itself and answers once the
   * action is accepted. False: `SessionManager` runs the Finish checks gate first and calls `finish`
   * on an ended session once they passed.
   */
  readonly ownsChecks: boolean
  /** A review gate before this manager stops the session or starts checks. */
  prepare?(sessionId: string, press: SessionFinishPress): Promise<SessionsOpResult<{ ready: boolean }>>
  /** The press; `actionId` names an action that goes on after the answer, null for an ending already done. */
  finish(sessionId: string, press: SessionFinishPress): Promise<SessionsOpResult<{ actionId: string | null }>>
  /**
   * What refuses every Finish of this client before the worktree is asked anything, or null. Asked
   * before a Finish runs the project's checks, so nobody waits for checks no Finish can follow.
   */
  /** The worktree goes with what is in it; answers once that removal ended. */
  discard(sessionId: string): Promise<SessionsOpResult>
  /** Ends a Finish that waits for the person and keeps the worktree; with none to end, nothing happens. */
  keep(sessionId: string): Promise<SessionsOpResult>
  /** Read on every recompose, so it costs nothing and reads no disk. */
  choicesOf(input: WorktreeChoicesInput): readonly SessionFinishChoice[]
}

export interface WorktreeChoicesInput {
  record: SessionRecord
  worktree: SessionRecordWorktree
}

/**
 * A finish or a discard ended as the person asked: the work landed, or was thrown away, and the
 * worktree is gone. What follows, the session going too, is `SessionManager`'s to decide.
 */
export type WorktreeEnded = (sessionId: string) => void

/**
 * An UPDATE recorded on a landed row. The row goes once its main copy holds what it landed, and its
 * Session actions with it, so the composer tells the result once: the revision, who asked, and the
 * UPDATE log the durable result kept (null when none could be kept).
 */
export interface MainCopyUpdated {
  sessionId: string
  title: string
  mainCopy: string
  revision: number
  by: 'person' | 'agent'
  log: string | null
}
