import { FinishProjection } from '../../worktrees/worktreeFinish'
import type { SessionRecord, SessionRecordActionHistory } from '../records/sessionRecord.types'
import { SessionActionHistory } from '../records/sessionActionHistory'
import type { SessionLiveState, SessionScriptRunInfo, SessionWorkflowAction, SessionWorkflowInfo, SessionWorkflowStepState } from '../sessionManagerApi.types'
import { GitFinishWorkflow } from '../../worktrees/worktreeViews'
import { SetupWorkflow } from './setupWorkflow'
import { SvnActionWorkflow } from '../../worktrees/worktreeViews'

export class SessionWorkflows {
  static openRunIdsOf(record: SessionRecord, runs: (runId: string) => SessionRecord | null): ReadonlySet<string> {
    const section = SessionWorkflows.sectionOf(record, runs)
    const ids = new Set<string>()
    if (section?.open !== true) return ids
    const startedAt = SessionActionHistory.currentOf(record)?.startedAt ?? 0
    for (const run of record.scriptRuns ?? [])
      if (run.phase === 'after' && run.startedAt >= startedAt) ids.add(run.runId)
    const action = FinishProjection.action(record)
    if (action?.runId !== undefined) ids.add(action.runId)
    if (action?.merger !== undefined) ids.add(action.merger.runId)
    for (const pass of action?.passes ?? [])
      if (pass.startedAt >= startedAt && pass.runId !== undefined) ids.add(pass.runId)
    for (const run of record.worktreeMerge?.runs ?? []) ids.add(run.runId)
    if (record.worktreeMerge?.resolveSessionId !== undefined) ids.add(record.worktreeMerge.resolveSessionId)
    if (record.finishChecks !== undefined) ids.add(record.finishChecks.runId)
    return ids
  }

  static holdsWorktreeHistory(record: SessionRecord): boolean {
    return (record.worktreeLifecycle?.journal.length ?? 0) > 0 || record.worktree !== undefined || record.svnAction !== undefined
      || record.worktreeOutcome !== undefined && record.worktreeOutcome.worktree !== 'removed'
  }

  static endedHistoryOf(records: readonly SessionRecord[]): ReadonlySet<string> {
    const byId = new Map(records.map((record) => [record.sessionId, record]))
    const runningParents = new Set(records.filter((record) => record.scriptOf !== undefined
      && (record.life === 'live' || record.life === 'starting')).map((record) => record.scriptOf!.sessionId))
    const runs = (runId: string): SessionRecord | null => byId.get(runId) ?? null
    return new Set(records.filter((record) => (record.life === 'ended' || record.life === 'lost')
      && !SessionWorkflows.holdsWorktreeHistory(record) && !runningParents.has(record.sessionId)
      && SessionWorkflows.sectionOf(record, runs)?.open !== true
      && !(record.pendingSetup !== undefined && SetupWorkflow.of(record, record.pendingSetup, runs)?.open === true))
      .map((record) => record.sessionId))
  }

  static sectionsOf(record: SessionRecord, runs: (runId: string) => SessionRecord | null,
    live: SessionLiveState = { kind: 'known', sessions: [] }, scripts?: readonly SessionScriptRunInfo[]): SessionWorkflowInfo[] {
    const sections: SessionWorkflowInfo[] = []
    const setup = record.pendingSetup === undefined ? SetupWorkflow.completedOf(record) : SetupWorkflow.of(record, record.pendingSetup, runs)
    if (setup !== null) sections.push({ ...setup, startedAt: record.createdAt })
    for (const entry of SessionActionHistory.entriesOf(record)) {
      const source: SessionRecord = { ...record, svnAction: entry.source.svnAction, worktreeMerge: entry.source.worktreeMerge,
        finishChecks: entry.source.finishChecks, worktree: entry.source.worktree, worktreeOutcome: entry.source.worktreeOutcome,
        pendingSetup: undefined, actionHistory: undefined, worktreeLifecycle: undefined,
        scriptRuns: record.scriptRuns?.filter((run) => run.startedAt <= entry.endedAt) }
      const workflow = SessionWorkflows.sectionOf(source, runs, undefined, entry.startedAt)
      if (workflow !== null) {
        const closed = SessionWorkflows.closedOf(workflow, entry)
        if (entry.outcome !== undefined && entry.outcome.at === record.worktreeOutcome?.at)
          closed.actions = SvnActionWorkflow.endedOf(record, entry.outcome).actions
        sections.push(closed)
      }
    }
    const requested = scripts ?? (record.scriptRuns ?? []).map((run): SessionScriptRunInfo => ({ ...run,
      state: run.outcome, summary: run.reason ?? run.title, row: false, log: run.log.state }))
    const current = SessionWorkflows.withValidationRuns(SessionWorkflows.sectionOf(record, runs, live), requested)
    if (current !== null && current.workflowId !== setup?.workflowId
      && !sections.some((section) => section.workflowId === current.workflowId)) sections.push(current)
    for (const run of requested)
      if (run.phase === 'inner') sections.push(SessionWorkflows.requestedOf(run))
    return sections.filter((section) => section.open || !record.clearedWorkflowIds?.includes(section.workflowId))
      .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0))
  }

  static of(record: SessionRecord, runs: (runId: string) => SessionRecord | null, live: SessionLiveState = { kind: 'known', sessions: [] }): SessionWorkflowInfo | null {
    record = FinishProjection.record(record)
    if (record.svnAction !== undefined)
      return { ...SvnActionWorkflow.of(record, record.svnAction, runs, live), startedAt: record.svnAction.startedAt }
    const git = record.finishChecks === undefined && record.worktreeMerge === undefined ? null : GitFinishWorkflow.of(record, runs)
    if (git !== null) return { ...git, startedAt: record.worktreeMerge?.startedAt ?? record.finishChecks?.startedAt, endedAt: record.worktreeMerge?.endedAt }
    const before = record.pendingSetup === undefined ? null : SetupWorkflow.of(record, record.pendingSetup, runs)
    if (before !== null) return before
    const lost = SvnActionWorkflow.workerLostOf(record)
    if (lost !== null) return lost
    return record.worktreeOutcome === undefined ? null
      : { ...SvnActionWorkflow.endedOf(record, record.worktreeOutcome), startedAt: record.worktreeOutcome.at }
  }

  /**
   * `startedAt`: when a closed history entry began. Its source holds no lifecycle and no outcome, so
   * the offer of an UPDATE after a Finish would otherwise date from the Finish (UA1-J09-11).
   */
  private static sectionOf(record: SessionRecord, runs: (runId: string) => SessionRecord | null, live: SessionLiveState = { kind: 'known', sessions: [] },
    startedAt?: number): SessionWorkflowInfo | null {
    record = FinishProjection.record(record)
    if (record.svnAction !== undefined) {
      const action = record.svnAction
      const current = SessionActionHistory.currentOf(record)!
      const start = startedAt ?? current.startedAt
      const update = action.kind === 'update-main' || action.stage === 'main-update'
      const first = action.passes?.findIndex((pass) => pass.stage === 'main-update') ?? -1
      const source = update ? { ...action, kind: 'update-main' as const,
        passes: first < 0 ? action.kind === 'finish' ? [] : action.passes : action.passes!.slice(first), startedAt: start,
        ...action.kind === 'finish' && first < 0 ? { stageAt: start } : {} } : action
      return { ...SvnActionWorkflow.of(record, source, runs, live), workflowId: current.key, startedAt: start }
    }
    const git = GitFinishWorkflow.sectionOf(record, runs)
    const workflow = git === null ? SessionWorkflows.of(record, runs, live) : { ...git,
      startedAt: record.worktreeMerge?.startedAt ?? record.finishChecks?.startedAt, endedAt: record.worktreeMerge?.endedAt }
    return workflow?.workflowId === `ended:${record.worktreeOutcome?.at}`
      && record.actionHistory?.some((entry) => entry.outcome?.at === record.worktreeOutcome?.at) ? null : workflow
  }

  private static closedOf(workflow: SessionWorkflowInfo, entry: SessionRecordActionHistory): SessionWorkflowInfo {
    const completed = entry.source.svnAction?.stage === 'recording' || entry.source.worktreeMerge?.endedAt !== undefined
      || entry.source.worktreeMerge === undefined && entry.source.finishChecks?.result?.kind === 'passed'
    const stopped = entry.source.svnAction === undefined ? null : SvnActionWorkflow.failureOf(entry.source.svnAction)
    const failed = entry.outcome?.result === 'failed' || entry.source.worktreeMerge?.failure !== undefined || stopped !== null
    return { ...workflow, workflowId: entry.key, startedAt: entry.startedAt, endedAt: entry.endedAt, open: false,
      badge: failed ? 'failed' : completed ? 'completed' : 'ended',
      summary: entry.outcome?.lines[0] ?? stopped ?? (completed ? 'Action completed' : SessionWorkflows.endedSummaryOf(entry)), actions: [],
      rounds: workflow.rounds.map((round) => ({ ...round, steps: round.steps.map((step) => {
        const state = step.state
        let closed: SessionWorkflowStepState
        switch (state) {
          case 'running': closed = failed ? 'failed' : completed ? 'done' : 'skipped'; break
          case 'pending': closed = 'skipped'; break
          case 'waits': closed = 'skipped'; break
          case 'done': case 'failed': case 'skipped': closed = state; break
          default: throw new Error(`Unknown workflow state: ${JSON.stringify(state satisfies never)}`)
        }
        return { ...step, state: closed, endedAt: step.endedAt ?? (step.startedAt === null ? null : entry.endedAt),
          body: step.body?.kind === 'commit' || step.body?.kind === 'sessions' ? undefined
            : step.body?.kind === 'conflicts' ? { ...step.body, readOnly: true as const }
              : step.target.kind === 'agent' ? { kind: 'log' as const, runId: step.target.runId } : step.body,
          target: step.target.kind === 'conflicts' || step.target.kind === 'agent' ? { kind: 'none' as const } : step.target }
      }) })) }
  }

  private static endedSummaryOf(entry: SessionRecordActionHistory): string {
    const ending = entry.ending
    switch (ending) {
      case undefined: return 'Action ended'
      case 'checks-stopped': return 'Checks stopped. The session went back to work.'
      case 'back-to-work': return 'Finish stopped. The session went back to work.'
      default: throw new Error(`Unknown action ending: ${JSON.stringify(ending satisfies never)}`)
    }
  }

  /**
   * A requested run can start only inside the session's place, its worktree, so every one still
   * running holds the worktree being validated; the validation names each with its Stop.
   */
  private static withValidationRuns(section: SessionWorkflowInfo | null, requested: readonly SessionScriptRunInfo[]): SessionWorkflowInfo | null {
    const running = requested.filter((run) => run.phase === 'inner' && run.state === 'running')
    if (section?.validation === undefined || running.length === 0) return section
    return { ...section, validation: { ...section.validation, runs: running.map((run) => ({ runId: run.runId, title: run.title,
      startedAt: run.startedAt, stop: SessionWorkflows.stopOf(run.runId) })) } }
  }

  private static stopOf(runId: string): SessionWorkflowAction {
    return { id: 'stop-run', label: 'Stop', primary: false, runId }
  }

  /**
   * An ended run whose row remains is removed here as the CLI removes it. The tree draws that row only
   * under a parent without actions, so a parent in a Finish left it with no Remove (UA1-J10-8).
   */
  private static actionsOf(run: SessionScriptRunInfo): SessionWorkflowAction[] {
    if (run.state === 'running') return [SessionWorkflows.stopOf(run.runId)]
    return run.row ? [{ id: 'remove-run', label: 'Remove', primary: false, runId: run.runId }] : []
  }

  private static requestedOf(run: SessionScriptRunInfo): SessionWorkflowInfo {
    const state = run.state
    let step: SessionWorkflowStepState
    switch (state) {
      case 'running': step = 'running'; break
      case 'succeeded': step = 'done'; break
      case 'failed': case 'lost': step = 'failed'; break
      // Somebody asked for this ending, a person or a Finish cleanup: nothing went wrong.
      case 'stopped': step = 'skipped'; break
      default: throw new Error(`Unknown script state: ${JSON.stringify(state satisfies never)}`)
    }
    return { kind: 'script', workflowId: `script:${run.runId}`, title: run.title, badge: state, summary: run.summary,
      startedAt: run.startedAt, endedAt: run.endedAt, open: state === 'running', actions: SessionWorkflows.actionsOf(run),
      rounds: [{ title: 'Script run', steps: [{ key: run.runId, title: run.title, detail: run.logDetail ?? '', state: step,
        startedAt: run.startedAt, endedAt: run.endedAt ?? null, target: { kind: 'run', runId: run.runId }, body: { kind: 'log', runId: run.runId } }] }] }
  }
}
