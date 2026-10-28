import type {
  SessionMergePhase,
  SessionRecord,
  SessionRecordFinishChecks,
  SessionRecordMerge,
  SessionRecordScriptRun,
} from '../../sessionManager/worktreeSessionRecords'
import type { SessionWorkflowInfo, SessionWorkflowStep, SessionWorkflowStepState } from '../../sessionManager/sessionManagerApi.types'

type RunsOf = (runId: string) => SessionRecord | null

/** Git Finish review, checks and command history, composed without process policy in the renderer. */
export class GitFinishWorkflow {
  /** The merge phases in their order; the resolver shows only once the merge met a conflict. */
  private static readonly phasesConst: readonly SessionMergePhase[] = ['base-merging', 'resolving', 'main-merging', 'tearing-down']

  static of(record: SessionRecord, runs: RunsOf): SessionWorkflowInfo | null {
    if (record.worktreeMerge === undefined && record.finishChecks?.result?.kind === 'passed') return null
    return GitFinishWorkflow.sectionOf(record, runs)
  }

  static sectionOf(record: SessionRecord, runs: RunsOf): SessionWorkflowInfo | null {
    if (record.worktree?.kind === 'svn') return null
    const checks = record.finishChecks
    const merge = record.worktreeMerge
    if (merge === undefined && checks === undefined) return null
    const history = (record.scriptRuns ?? []).filter((run) => run.phase === 'after')
    const checkSteps = checks === undefined ? [] : GitFinishWorkflow.checkStepsOf(checks, history, runs)
    const recorded = merge?.runs ?? []
    const mergeSteps = GitFinishWorkflow.mergeStepsOf(merge, checks)
      .filter((step) => merge?.discard !== true || step.key === 'merge:tearing-down')
      .filter((step) => !recorded.some((run) => `merge:${run.phase}` === step.key))
    const commands: SessionWorkflowStep[] = recorded.map((run) => ({
      key: `command:${run.runId}`, title: run.phase === 'commit' ? 'Commit selected changes' : GitFinishWorkflow.titleOf(run.phase), detail: '',
      state: run.failed === true ? 'failed' : run.endedAt === undefined ? 'running' : 'done',
      startedAt: run.startedAt, endedAt: run.endedAt ?? null, target: { kind: 'run', runId: run.runId },
    }))
    const resolver = mergeSteps.find((step) => step.key === 'merge:resolving')
    if (resolver !== undefined && recorded.some((run) => run.phase === 'main-merging')) {
      commands.splice(recorded.findIndex((run) => run.phase === 'main-merging'), 0, resolver)
      mergeSteps.splice(mergeSteps.indexOf(resolver), 1)
    }
    const changes: SessionWorkflowStep[] = merge?.changes === true && record.worktree !== undefined ? [{
      key: 'changes', title: 'Changes', detail: 'Review the selected files and enter a commit message', state: 'waits',
      startedAt: null, endedAt: null, target: { kind: 'none' },
      body: { kind: 'commit', vcs: 'git', scopeRoot: record.worktree.worktreePath },
    }] : []
    const failure = checks?.result?.kind === 'failed' ? checks.result.reason : merge?.failure
    return {
      kind: merge?.discard === true ? 'discard' : 'git-finish',
      ...(merge?.revisions ? { revisions: [...merge.revisions, ...merge.mergedRevision ? [merge.mergedRevision] : []] } : {}),
      workflowId: `git-${merge?.discard === true ? 'discard' : 'finish'}:${record.sessionId}:${merge?.startedAt ?? checks?.startedAt ?? 0}`,
      title: `${merge?.discard === true ? 'Discard' : 'Finish'} of ${record.title}`,
      badge: changes.length > 0 ? 'changes need you' : merge?.endedAt !== undefined ? 'finished' : failure === undefined ? GitFinishWorkflow.runningBadgeOf(checks, merge) : merge === undefined ? 'check failed' : 'merge failed',
      summary: changes.length > 0 ? 'Review the changes and press Commit & merge' : merge?.endedAt !== undefined ? 'The worktree was removed' : failure === undefined ? GitFinishWorkflow.runningSummaryOf(checks, merge) : `${failure}; press Finish to continue`,
      open: merge?.endedAt === undefined,
      rounds: [{ title: 'Finish', steps: [...changes, ...checkSteps, ...commands, ...mergeSteps].map((step) => ({ ...step,
        ...step.target.kind === 'run' ? { body: { kind: 'log' as const, runId: step.target.runId } } : {} })) }],
      actions: changes.length > 0 ? [
        ...record.pendingSetup === undefined ? [{ id: 'finish-again' as const, label: 'Commit & merge', primary: true, place: 'step' as const, requiresCommit: true as const }] : [],
        { id: 'discard', label: 'Discard', primary: false, place: 'step', confirm: 'Discard this worktree and its uncommitted changes?' },
        { id: 'keep', label: 'Keep', primary: false, place: 'step' },
      ] : failure === undefined ? [] : [
        merge?.discard === true
          ? { id: 'discard', label: 'Retry discard', primary: true, confirm: 'Discard this worktree and its uncommitted changes?' }
          : { id: 'finish-again', label: 'Review changes', primary: true },
        { id: 'keep', label: 'Keep', primary: false },
      ],
    }
  }

  private static checkStepsOf(checks: SessionRecordFinishChecks, history: readonly SessionRecordScriptRun[], runs: RunsOf): SessionWorkflowStep[] {
    const result = checks.result
    return checks.steps.map((step, index): SessionWorkflowStep => {
      const key = `check:${index}:${step.name}`
      const title = `Check ${step.name}`
      const entry = [...history].reverse().find((run) => run.stepKey === step.key && run.startedAt >= checks.startedAt)
      if (index < checks.cursor || (index === checks.cursor && result?.kind === 'passed'))
        return { key, title, detail: entry?.title ?? '', state: 'done', startedAt: entry?.startedAt ?? null, endedAt: entry?.endedAt ?? null,
          target: entry === undefined ? { kind: 'none' } : { kind: 'run', runId: entry.runId } }
      if (index > checks.cursor)
        return { key, title, detail: '', state: 'pending', startedAt: null, endedAt: null, target: { kind: 'none' } }
      const run = runs(checks.runId)
      if (result?.kind === 'failed')
        return { key, title, detail: result.reason, state: 'failed', startedAt: entry?.startedAt ?? run?.createdAt ?? null,
          endedAt: entry?.endedAt ?? result.at, target: { kind: 'run', runId: checks.runId } }
      return { key, title, detail: run?.title ?? '', state: 'running', startedAt: run?.createdAt ?? null, endedAt: null,
        target: { kind: 'run', runId: checks.runId } }
    })
  }

  /** Before the merge starts every merge step is pending; after a failed check it never starts. */
  private static mergeStepsOf(merge: SessionRecordMerge | undefined, checks: SessionRecordFinishChecks | undefined): SessionWorkflowStep[] {
    const current = merge === undefined ? -1 : GitFinishWorkflow.phasesConst.indexOf(merge.phase)
    return GitFinishWorkflow.phasesConst.flatMap((phase, index): SessionWorkflowStep[] => {
      if (phase === 'resolving' && merge?.phase !== 'resolving' && merge?.resolveSessionId === undefined) return []
      let state: SessionWorkflowStepState
      if (merge?.endedAt !== undefined) state = 'done'
      else if (merge?.changes === true || checks !== undefined && checks.result === undefined
        || merge?.runs?.at(-1)?.phase === 'commit' || merge === undefined || index > current)
        state = checks?.result?.kind === 'failed' ? 'skipped' : 'pending'
      else if (index < current) state = 'done'
      else state = merge.failure === undefined ? 'running' : 'failed'
      const resolver = phase === 'resolving' && merge?.resolveSessionId !== undefined ? merge.resolveSessionId : null
      return [{
        key: `merge:${phase}`,
        title: GitFinishWorkflow.titleOf(phase),
        detail: state === 'failed' ? merge?.failure ?? '' : '',
        state,
        startedAt: null,
        endedAt: null,
        target: resolver === null ? { kind: 'none' } : { kind: 'agent', runId: resolver },
      }]
    })
  }

  private static titleOf(phase: SessionMergePhase): string {
    switch (phase) {
      case 'base-merging': return 'Merge the base into the branch'
      case 'resolving': return 'Claude resolves the conflicts'
      case 'main-merging': return 'Merge into the base'
      case 'tearing-down': return 'Remove the worktree'
      default: throw new Error(`Unknown merge phase: ${JSON.stringify(phase satisfies never)}`)
    }
  }

  private static runningBadgeOf(checks: SessionRecordFinishChecks | undefined, merge: SessionRecordMerge | undefined): string {
    if (checks !== undefined && checks.result === undefined) return 'checking'
    if (merge?.runs?.at(-1)?.phase === 'commit' && merge.runs.at(-1)?.endedAt === undefined) return 'committing'
    if (merge === undefined) return checks === undefined ? 'finishing' : 'checking'
    const phase = merge.phase
    switch (phase) {
      case 'base-merging': return 'merging the base'
      case 'resolving': return 'resolving'
      case 'main-merging': return 'merging'
      case 'tearing-down': return 'removing'
      default: throw new Error(`Unknown merge phase: ${JSON.stringify(phase satisfies never)}`)
    }
  }

  private static runningSummaryOf(checks: SessionRecordFinishChecks | undefined, merge: SessionRecordMerge | undefined): string {
    if (checks !== undefined && checks.result === undefined) return `Running the check ${checks.steps[checks.cursor]?.name ?? ''}`.trim()
    if (merge?.runs?.at(-1)?.phase === 'commit' && merge.runs.at(-1)?.endedAt === undefined) return 'Committing the selected changes'
    if (merge === undefined) return checks === undefined ? 'Finishing' : `Running the check ${checks.steps[checks.cursor]?.name ?? ''}`.trim()
    const phase = merge.phase
    switch (phase) {
      case 'base-merging': return 'Merging the base into the branch'
      case 'resolving': return 'Claude resolves the conflicts'
      case 'main-merging': return 'Merging into the base'
      case 'tearing-down': return 'Removing the worktree'
      default: throw new Error(`Unknown merge phase: ${JSON.stringify(phase satisfies never)}`)
    }
  }
}
