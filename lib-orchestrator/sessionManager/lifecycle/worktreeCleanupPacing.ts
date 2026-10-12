import type {
  SessionExitReason,
  SessionRecord,
  SessionRecordWorktreeCleanup,
  SessionWorktreeCleanupTrigger,
} from '../records/sessionRecord.types'

/**
 * When the removal of an SVN worktree after its session's end is judged again. Pure, in the
 * `LaunchBackoff` style: the lifecycle writes the attempt, the reconciler reads whether the next one
 * is due.
 *
 * A holder or a failed status read is often gone in seconds, so the pace starts fast and settles on
 * ten minutes. The first judgement after a client start is always due: a holder may have gone while
 * no client ran.
 */
export class WorktreeCleanupPacing {
  /** The summary while this client judges and removes the worktree, which a Finish then waits for. */
  static readonly runningSummaryConst = 'being removed now, unless something is left in it'
  /** Windows lets a handle of an exited process go a moment after the exit is reported. */
  private static readonly graceMillisecondsConst = 30_000
  /** Indexed by the attempts already made, so `delaysConst[1]` is the wait after the first. */
  private static readonly delaysConst = [0, 0, 5_000, 30_000, 120_000, 600_000] as const

  static pending(trigger: SessionWorktreeCleanupTrigger, now: number): SessionRecordWorktreeCleanup {
    return { phase: 'pending', trigger, requestedAt: now, attempts: 0 }
  }

  /** Written before the apply runs, so the next pass does not judge the record again at once. */
  static attempted(cleanup: SessionRecordWorktreeCleanup, now: number): SessionRecordWorktreeCleanup {
    return { ...cleanup, attempts: cleanup.attempts + 1, lastAttemptAt: now }
  }

  /** A Discard that did not finish threw the changes away already; every other trigger keeps them. */
  static checksChanges(trigger: SessionWorktreeCleanupTrigger): boolean {
    if (trigger === 'discard-unfinished') return false
    else if (trigger === 'committed' || trigger === 'removal-unfinished' || trigger === 'remove-when-ended'
      || trigger === 'requested') return true
    else throw new Error(`Unknown cleanup trigger: ${JSON.stringify(trigger satisfies never)}`)
  }

  /**
   * Written by every launch into the worktree: the run makes new work there, which the skipped
   * change check of an unfinished Discard would delete, so that request goes on as a fresh one that
   * counts changes. Every other cleanup stays as it is.
   */
  static relaunched(record: SessionRecord, now: number): SessionRecord {
    const cleanup = record.worktreeCleanup
    if (cleanup === undefined || WorktreeCleanupPacing.checksChanges(cleanup.trigger)) return record
    return { ...record, worktreeCleanup: WorktreeCleanupPacing.pending('removal-unfinished', now) }
  }

  /**
   * Whether the session ran after `at`: an end recorded later proves a launch after it. A record
   * that names no end proves nothing, so a lost run after a reopen relies on `relaunched`.
   */
  static ranSince(record: SessionRecord, at: number): boolean {
    return record.endedAt !== undefined && record.endedAt > at
  }

  /** Whether nothing can still run in the worktree, so the cleanup may judge it. */
  static processGone(record: SessionRecord): boolean {
    if (record.life === 'lost') return true
    // `endedReason` is written only where no runtime existed (a failed before chain, a refused launch),
    // and every bind clears it, so such a session has no process that could hold the worktree.
    else if (record.life === 'ended')
      return record.endedReason !== undefined || WorktreeCleanupPacing.exitConfirmed(record.exitReason)
    else if (record.life === 'live' || record.life === 'starting') return false
    else throw new Error(`Unknown session life: ${JSON.stringify(record.life satisfies never)}`)
  }

  /** No run of this parent can still hold the worktree. */
  static runsGone(parent: SessionRecord, records: readonly SessionRecord[]): boolean {
    return records.every((run) => run.scriptOf?.sessionId !== parent.sessionId || WorktreeCleanupPacing.processGone(run))
  }

  /** An ended session whose process may still run, so its cleanup waits without a verdict. */
  static endUnconfirmed(record: SessionRecord): boolean {
    return record.life === 'ended' && !WorktreeCleanupPacing.processGone(record)
  }

  /** Whether the session's end lies far enough back; a record that names no end counts from the client start. */
  static settled(record: SessionRecord, now: number, clientStartedAt: number): boolean {
    const since = now - (record.endedAt ?? clientStartedAt)
    return since < 0 || since >= WorktreeCleanupPacing.graceMillisecondsConst
  }

  static due(cleanup: SessionRecordWorktreeCleanup, now: number, clientStartedAt: number): boolean {
    if (cleanup.phase === 'kept') return false
    else if (cleanup.phase !== 'pending')
      throw new Error(`Unknown cleanup phase: ${JSON.stringify(cleanup.phase satisfies never)}`)
    if (cleanup.lastAttemptAt === undefined || cleanup.lastAttemptAt < clientStartedAt) return true
    // A clock that went backwards would otherwise park the record until wall time caught up.
    const since = now - cleanup.lastAttemptAt
    if (since < 0) return true
    return since >= WorktreeCleanupPacing.delayOf(cleanup)
  }

  /**
   * The sentence a row, a tab and a script show for a cleanup; the reason vocabulary is this class's.
   * `endUnconfirmed` is `endUnconfirmed(record)`: no verdict comes until a reopen ends the session again.
   */
  static summaryOf(cleanup: Pick<SessionRecordWorktreeCleanup, 'phase' | 'reason'>, endUnconfirmed: boolean): string {
    const reason = cleanup.reason
    if (cleanup.phase === 'kept') return reason === undefined ? 'kept' : `kept: ${reason}`
    else if (cleanup.phase !== 'pending')
      throw new Error(`Unknown cleanup phase: ${JSON.stringify(cleanup.phase satisfies never)}`)
    if (endUnconfirmed) return 'waiting: the end of the session is not confirmed'
    if (reason === undefined) return 'removed once the session has ended and nothing is left in it'
    if (reason === 'in use') return 'waiting to remove (in use)'
    return `waiting to remove (${reason})`
  }

  /** `host-lost` may leave the process running without a Host and no reason says nothing; `spawn-failed` never ran one. */
  private static exitConfirmed(reason: SessionExitReason | undefined): boolean {
    if (reason === 'process-exit' || reason === 'stopped' || reason === 'spawn-failed') return true
    else if (reason === 'host-lost' || reason === undefined) return false
    else throw new Error(`Unknown exit reason: ${JSON.stringify(reason satisfies never)}`)
  }

  private static delayOf(cleanup: SessionRecordWorktreeCleanup): number {
    const delays = WorktreeCleanupPacing.delaysConst
    if (cleanup.attempts < 1) return 0
    return cleanup.attempts >= delays.length ? delays[delays.length - 1] : delays[cleanup.attempts]
  }
}
