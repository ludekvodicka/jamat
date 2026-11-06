import type { SessionRecord } from '../../sessionManager/worktreeSessionRecords'
import { SessionWorkingDirectory } from '../../sessionManager/sessionWorkingDirectory'
import { PathCompare } from '../../shared/pathCompare'

/**
 * When Jamat tries the removal of a Finish again by itself, after Windows refused it (EPERM, EBUSY, a
 * held file). Pure, in the `WorktreeCleanupPacing` style: the removal writes `execution.removalAt`
 * before each attempt, the reconciler reads whether the next one is due.
 *
 * A lock that outlived the rename retries can go seconds later (a process tree still exiting) or only
 * with a restart (Jamat 098, an orphaned probe Windows could not end). So the pace starts at half a
 * minute and settles on ten minutes, and the first judgement after a client start is always due. The
 * pace counts from when the wait began, which an automatic attempt keeps.
 */
export class BlockedRemovalRetry {
  private static readonly tiersConst: readonly { blockedFor: number; delay: number }[] = [
    { blockedFor: 2 * 60_000, delay: 30_000 },
    { blockedFor: 30 * 60_000, delay: 2 * 60_000 },
  ]
  private static readonly settledDelayMillisecondsConst = 10 * 60_000

  /**
   * A Finish that waits only for its worktree to go: the removal itself was refused, its permit is
   * saved, and nothing runs inside any more. A live helper, run or reopened worker there is the
   * person's to end; an automatic attempt would stop it.
   */
  static waiting(record: SessionRecord, records: readonly SessionRecord[]): boolean {
    const state = record.worktreeLifecycle
    if (state?.phase !== 'waiting' || state.wait?.kind !== 'removal-blocked' || state.step !== 'removing'
      || state.removalPermit === undefined || state.execution === undefined || state.unreadable !== undefined) return false
    if (record.worktree?.kind !== 'svn' || record.life === 'live' || record.life === 'starting' || record.pendingOperationId !== undefined) return false
    const root = record.worktree.worktreePath
    return !records.some((other) => (other.life === 'live' || other.life === 'starting')
      && PathCompare.isInside(root, SessionWorkingDirectory.ofRecord(other)))
  }

  static due(record: SessionRecord, records: readonly SessionRecord[], now: number, clientStartedAt: number): boolean {
    if (!BlockedRemovalRetry.waiting(record, records)) return false
    const state = record.worktreeLifecycle!
    const blockedAt = state.wait!.at
    const lastAttemptAt = state.execution!.removalAt ?? blockedAt
    if (lastAttemptAt < clientStartedAt) return true
    const since = now - lastAttemptAt
    // A clock that went backwards would otherwise park the removal until wall time caught up.
    if (since < 0) return true
    return since >= BlockedRemovalRetry.delayOf(now - blockedAt)
  }

  static delayOf(blockedFor: number): number {
    return BlockedRemovalRetry.tiersConst.find((tier) => blockedFor < tier.blockedFor)?.delay ?? BlockedRemovalRetry.settledDelayMillisecondsConst
  }
}
