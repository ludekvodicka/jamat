import type {
  SessionMergePhase,
  SessionRecord,
  SessionRecordFinishChecks,
  SessionRecordMerge,
  SessionRecordScriptRun,
} from '../records/sessionRecord.types'
import type { SessionWorkflowInfo, SessionWorkflowStep, SessionWorkflowStepState } from '../sessionManagerApi.types'

type RunsOf = (runId: string) => SessionRecord | null

/**
 * The Finish of a Git worktree as a workflow: the after chain `finishChecks` as run steps, then the
 * merge (`worktreeMerge`) as client steps, with its resolver as an agent step, and the removal. The
 * Git Finish keeps its dialog presses, so the workflow admits no action; a failure says to press
 * Finish to continue. Nothing reads a clock.
 */
export class GitFinishWorkflow {
  /** The merge phases in their order; the resolver shows only once the merge met a conflict. */
  private static readonly phasesConst: readonly SessionMergePhase[] = ['base-merging', 'resolving', 'main-merging', 'tearing-down']

  static of(record: SessionRecord, runs: RunsOf): SessionWorkflowInfo | null {
    if (record.worktree?.kind === 'svn') return null
    const checks = record.finishChecks
    const merge = record.worktreeMerge
    // A chain that passed with no merge after it has nothing left to show.
    if (merge === undefined && (checks === undefined || checks.result?.kind === 'passed')) return null
    const history = (record.scriptRuns ?? []).filter((run) => run.phase === 'after')
    const checkSteps = checks === undefined ? [] : GitFinishWorkflow.checkStepsOf(checks, history, runs)
    const mergeSteps = GitFinishWorkflow.mergeStepsOf(merge, checks)
    const failure = checks?.result?.kind === 'failed' ? checks.result.reason : merge?.failure
    return {
      kind: 'git-finish',
      workflowId: `git-finish:${record.sessionId}:${checks?.startedAt ?? merge?.startedAt ?? 0}`,
      title: `Finish of ${record.title}`,
      badge: failure === undefined ? GitFinishWorkflow.runningBadgeOf(checks, merge) : merge === undefined ? 'check failed' : 'merge failed',
      summary: failure === undefined ? GitFinishWorkflow.runningSummaryOf(checks, merge) : `${failure}; press Finish to continue`,
      open: failure === undefined,
      rounds: [{ title: 'Finish', steps: [...checkSteps, ...mergeSteps] }],
      actions: [],
    }
  }

  private static checkStepsOf(checks: SessionRecordFinishChecks, history: readonly SessionRecordScriptRun[], runs: RunsOf): SessionWorkflowStep[] {
    const result = checks.result
    return checks.steps.map((step, index): SessionWorkflowStep => {
      const key = `check:${index}:${step.name}`
      const title = `Check ${step.name}`
      const entry = [...history].reverse().find((run) => run.stepKey === step.key)
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
      if (merge === undefined || index > current) state = checks?.result?.kind === 'failed' ? 'skipped' : 'pending'
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
