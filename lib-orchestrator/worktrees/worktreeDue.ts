import { SvnResolverTiming } from './conflicts/svnResolverTiming'
import type { SessionRecord } from '../sessionManager/worktreeSessionRecords'
import { SessionScriptDefinitions } from '../sessionManager/worktreeSessionScripts'
import { SvnActionStages } from './finish/svnActionStages'
import { WorktreeCleanupPacing } from './removal/worktreeCleanupPacing'
import { BlockedRemovalRetry } from './removal/blockedRemovalRetry'
import { CheckExecution } from './finish/checkExecution'
import { FinishStepPolicy } from './finish/finishStepPolicy'
import type { WorktreeDueChange } from './worktreeLifecycle.types'

export class WorktreeDue {
  /** A Git merge resolver runs in print mode and ends by itself; one still running then is stuck, and nothing else would end it. */
  static readonly gitResolverLimitMillisecondsConst = 20 * 60_000

  static of(records: readonly SessionRecord[], now: number, clientStartedAt: number, held: ReadonlySet<string>): WorktreeDueChange[] {
    const changes: WorktreeDueChange[] = []
    for (const record of records) {
      if (record.worktreeLifecycle?.unreadable !== undefined) continue
      if (WorktreeDue.cleanupDue(record, records, now, clientStartedAt))
        changes.push({ kind: 'clean-worktree', sessionId: record.sessionId })
      if (!held.has(record.sessionId) && BlockedRemovalRetry.due(record, records, now, clientStartedAt))
        changes.push({ kind: 'retry-removal', sessionId: record.sessionId })
      const state = record.worktreeLifecycle
      if (state?.execution !== undefined && !held.has(record.sessionId)
        && (state.phase === 'finishing' && state.step !== undefined && FinishStepPolicy.steps[state.step].background
          && !(state.step === 'checking' && state.execution.runId !== undefined && state.execution.verdict === undefined
            && now - (state.execution.checkStartedAt ?? records.find((run) => run.sessionId === state.execution!.runId)?.createdAt ?? state.execution.startedAt) < CheckExecution.timeoutMillisecondsConst)
          || state.wait?.kind === 'worker-lost' && state.step === 'worker-resolving')) {
        changes.push({ kind: 'svn-action-due', sessionId: record.sessionId })
        continue
      }
      const resolver = WorktreeDue.overdueGitResolver(record, records, now)
      if (resolver !== null) changes.push({ kind: 'stop-script-run', runId: resolver })
      const action = record.svnAction
      if (action !== undefined && !held.has(record.sessionId)
        && (SvnActionStages.clientDue(action, now) || SvnResolverTiming.overdue(action, now)))
        changes.push({ kind: 'svn-action-due', sessionId: record.sessionId })
    }
    return changes
  }

  private static overdueGitResolver(record: SessionRecord, records: readonly SessionRecord[], now: number): string | null {
    const merge = record.worktreeMerge
    if (record.worktree?.kind === 'svn' || merge?.phase !== 'resolving' || merge.failure !== undefined || merge.resolveSessionId === undefined) return null
    const run = records.find((candidate) => candidate.sessionId === merge.resolveSessionId)
    if (run === undefined || (run.life !== 'live' && run.life !== 'starting')) return null
    return now - run.createdAt >= WorktreeDue.gitResolverLimitMillisecondsConst ? run.sessionId : null
  }

  private static cleanupDue(
    record: SessionRecord,
    records: readonly SessionRecord[],
    now: number,
    clientStartedAt: number,
  ): boolean {
    const cleanup = record.worktreeCleanup
    if (cleanup?.phase !== 'pending' || record.worktree?.kind !== 'svn') return false
    if (record.svnAction !== undefined || record.worktreeLifecycle?.execution !== undefined && (record.worktreeLifecycle.phase === 'finishing' || record.worktreeLifecycle.phase === 'waiting') || record.pendingOperationId !== undefined) return false
    // Between two steps no run of the chain is live, and the next one is about to start in there.
    if (SessionScriptDefinitions.judging('finish', record)) return false
    if (!WorktreeCleanupPacing.processGone(record) || !WorktreeCleanupPacing.runsGone(record, records)
      || !WorktreeCleanupPacing.settled(record, now, clientStartedAt)) return false
    return WorktreeCleanupPacing.due(cleanup, now, clientStartedAt)
  }
}
