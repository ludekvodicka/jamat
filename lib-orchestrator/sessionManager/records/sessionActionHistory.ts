import { FinishProjection } from '../../worktrees/worktreeFinish'
import type { SessionRecord, SessionRecordActionHistory, SessionRecordSvnAction } from './sessionRecord.types'

/** Capture the last source before a replacement removes it, in the same atomic record write. */
export class SessionActionHistory {
  static entriesOf(record: SessionRecord): readonly SessionRecordActionHistory[] {
    const history = (record.actionHistory ?? []).filter((entry) => !record.clearedWorkflowIds?.includes(entry.key))
    const action = FinishProjection.action(record)
    if (action === undefined || record.clearedWorkflowIds?.includes(action.actionId) || history.some((entry) => entry.key === action.actionId)) return history
    const first = action.passes?.findIndex((pass) => pass.stage === 'main-update') ?? -1
    if (!(action.kind === 'finish' && action.stage === 'main-update') && !(action.kind === 'update-main' && first > 0)) return history
    const endedAt = action.passes?.[first]?.startedAt ?? SessionActionHistory.offeredAt(record, action)
    const passes = FinishProjection.shownPasses(record, action)
    const kept = passes?.findIndex((pass) => pass.stage === 'main-update') ?? -1
    return [...history, { key: action.actionId, startedAt: action.startedAt, endedAt, outcome: record.worktreeOutcome,
      source: { worktree: record.worktree, svnAction: { ...action, kind: 'finish', stage: 'recording',
        passes: kept < 0 ? passes : passes?.slice(0, kept) } } }]
  }

  static currentOf(record: SessionRecord): Omit<SessionRecordActionHistory, 'endedAt'> | null {
    const action = FinishProjection.action(record)
    if (action !== undefined) {
      const update = action.kind === 'update-main' || action.stage === 'main-update'
      const start = update ? action.passes?.find((pass) => pass.stage === 'main-update')?.startedAt
        ?? (action.kind === 'update-main' ? action.startedAt : SessionActionHistory.offeredAt(record, action)) : action.startedAt
      return { key: update ? `${action.actionId}:update-main` : action.actionId, startedAt: start,
        source: { svnAction: { ...action, passes: FinishProjection.shownPasses(record, action) }, worktree: record.worktree } }
    }
    const merge = record.worktreeMerge
    const checks = record.finishChecks
    if (record.worktree?.kind !== 'svn' && (merge !== undefined || checks !== undefined)) {
      const startedAt = merge?.startedAt ?? checks!.startedAt
      return { key: `git-${merge?.discard === true ? 'discard' : 'finish'}:${record.sessionId}:${startedAt}`, startedAt,
        source: { worktreeMerge: merge, finishChecks: checks, worktree: record.worktree } }
    }
    if (record.worktreeOutcome !== undefined && !(record.actionHistory ?? []).some((entry) => entry.outcome?.at === record.worktreeOutcome!.at))
      return { key: `ended:${record.worktreeOutcome.at}`, startedAt: record.worktreeOutcome.at,
        source: { worktreeOutcome: record.worktreeOutcome } }
    return null
  }

  /**
   * When a Finish began to wait for its main-copy UPDATE. A Finish of the worktree lifecycle records
   * no stage time; its result was recorded then.
   */
  private static offeredAt(record: SessionRecord, action: SessionRecordSvnAction): number {
    return action.stageAt ?? (record.worktreeLifecycle?.execution === undefined ? undefined : record.worktreeOutcome?.at) ?? action.startedAt
  }

  static preserve(previous: SessionRecord | null, next: SessionRecord, at: number): SessionRecord {
    if (previous === null) return next
    const before = SessionActionHistory.currentOf(previous)
    const after = SessionActionHistory.currentOf(next)
    // Failed checks close an action that the next press resumes under the same key; it is current again.
    const history = SessionActionHistory.entriesOf(previous).filter((entry) => entry.key !== after?.key)
    if (before === null || next.clearedWorkflowIds?.includes(before.key) || before.key === after?.key || history.some((entry) => entry.key === before.key)) {
      // Keep records its result after it closed the action: with nothing in between, that result
      // replaces the ending of the last action instead of opening a section of its own.
      const last = history.at(-1)
      if (before === null && last?.outcome !== undefined && next.worktreeOutcome !== undefined
        && next.worktreeOutcome !== previous.worktreeOutcome && last.outcome.at === previous.worktreeOutcome?.at)
        history[history.length - 1] = { ...last, endedAt: next.worktreeOutcome.at, outcome: structuredClone(next.worktreeOutcome) }
      if (history.length > 0) return { ...next, actionHistory: [...history] }
      const { actionHistory: _resumed, ...rest } = next
      return rest
    }
    // An outcome recorded while the action ran, such as a partial publication, is its ending too.
    const outcome = next.worktreeOutcome !== previous.worktreeOutcome
      || next.worktreeOutcome !== undefined && next.worktreeOutcome.at >= before.startedAt ? next.worktreeOutcome : undefined
    const ending = outcome === undefined ? SessionActionHistory.endingOf(previous, next) : undefined
    const entry: SessionRecordActionHistory = { ...structuredClone(before), endedAt: outcome?.at ?? at,
      ...outcome === undefined ? {} : { outcome: structuredClone(outcome) }, ...ending === undefined ? {} : { ending } }
    return { ...next, actionHistory: [...history, entry] }
  }

  /** The same Finish back in `active`: Back to work ended it, the one transition that leaves an action that way. */
  private static endingOf(previous: SessionRecord, next: SessionRecord): SessionRecordActionHistory['ending'] {
    const before = previous.worktreeLifecycle
    const after = next.worktreeLifecycle
    if (before === undefined || after === undefined || after.phase !== 'active' || after.actionId !== before.actionId
      || before.phase !== 'finishing' && before.phase !== 'waiting') return undefined
    return before.step === 'checking' ? 'checks-stopped' : 'back-to-work'
  }
}
