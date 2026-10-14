import { basename } from 'node:path'

import type { SessionRecord, SessionRecordSvnAction, SvnActionConflictSet, SvnActionPass } from '../records/sessionRecord.types'
import type {
  SessionWorkflowAction,
  SessionWorkflowInfo,
  SessionWorkflowRound,
  SessionWorkflowStep,
  SessionWorkflowStepState,
  SessionWorkflowTarget,
  SessionWorktreeOutcome,
  SvnActionKind,
  SvnActionNeed,
  SvnActionStage,
  SvnFinishResult,
} from '../sessionManagerApi.types'
import { SvnActionStages } from './svnActionStages'
import { SvnConflictFlow } from './svnConflictFlow'
import { SvnConflictWords } from './svnConflictWords'
import { SvnMergerLauncher } from './svnMergerLauncher'

/** A step before it is keyed into its round. */
interface PlannedStep {
  /** `conflicts`: the step of the conflicts an update left, which starts no round. */
  stage: SvnActionStage | 'conflicts'
  /** The key within its round: `updating`, `check:lint`, `review:lib`. */
  base: string
  title: string
  detail: string
  state: SessionWorkflowStepState
  startedAt: number | null
  endedAt: number | null
  target: SessionWorkflowTarget
}

/** A stage still ahead, with the check or the review root it names. */
interface AheadStage {
  stage: SvnActionStage
  name?: string
}

type RunsOf = (runId: string) => SessionRecord | null

/**
 * The workflow of an SVN action (Finish, Discard, UPDATE): one done step per pass, the current stage
 * running or waiting with its need, and the stages still ahead as pending, projected from the frozen
 * checks and the review roots. A new round starts at each `svn update` after one that ran through, so
 * an update again after incoming commits, a resolver or an out-of-date review reads as round 2. Every
 * word is composed here; nothing reads a clock.
 */
export class SvnActionWorkflow {
  static readonly roundsMaxConst = 10
  static readonly stepsMaxConst = 20

  static of(record: SessionRecord, action: SessionRecordSvnAction, runs: RunsOf): SessionWorkflowInfo {
    const done = (action.passes ?? []).flatMap((pass) => SvnActionWorkflow.passStepsOf(record, pass, runs))
    const current = SvnActionWorkflow.currentOf(action, runs)
    const ahead = SvnActionWorkflow.aheadOf(action).map(SvnActionWorkflow.pendingOf)
    const conflicts = SvnActionWorkflow.conflictWaitOf(action)
    let badge: string
    if (conflicts !== null) badge = SvnConflictWords.summaryOf(conflicts)
    else if (action.needs !== undefined) badge = SvnActionWorkflow.needBadgeOf(action.needs.kind)
    else badge = SvnActionWorkflow.runningBadgeOf(action)
    return {
      kind: action.kind,
      workflowId: action.actionId,
      title: SvnActionWorkflow.titleOf(record, action.kind, action.root),
      badge,
      summary: action.needs === undefined ? SvnActionWorkflow.runningSummaryOf(action) : `Waits for you: ${action.needs.reason}`,
      open: true,
      rounds: SvnActionWorkflow.roundsOf(SvnActionWorkflow.kindWordOf(action.kind), [...done, ...current, ...ahead]),
      actions: SvnActionWorkflow.actionsOf(action),
    }
  }

  /** The last ending of the session's SVN action, its lines verbatim, until the next press. */
  static endedOf(record: SessionRecord, outcome: SessionWorktreeOutcome): SessionWorkflowInfo {
    const state: SessionWorkflowStepState = outcome.result === 'failed' ? 'failed' : 'done'
    const badge = SvnActionWorkflow.resultBadgeOf(outcome.result)
    return {
      kind: 'finish',
      workflowId: `ended:${outcome.at}`,
      title: SvnActionWorkflow.titleOf(record, 'finish', ''),
      badge,
      summary: outcome.lines[0]?.trim() || badge,
      open: false,
      rounds: [{
        title: 'Outcome',
        steps: outcome.lines.slice(0, SvnActionWorkflow.stepsMaxConst).map((line, index) => ({
          key: `outcome:${index}`,
          title: line.trim(),
          detail: '',
          state,
          startedAt: null,
          endedAt: outcome.at,
          target: { kind: 'none' },
        })),
      }],
      actions: [],
    }
  }

  /** An update that left conflicts is its own step and, when the action waited on them, a conflict step. */
  private static passStepsOf(record: SessionRecord, pass: SvnActionPass, runs: RunsOf): PlannedStep[] {
    const conflicts = pass.stage === 'updating' ? pass.facts?.conflicts ?? 0 : 0
    if (conflicts === 0) return [SvnActionWorkflow.passStepOf(record, pass, runs)]
    const update: PlannedStep = {
      ...SvnActionWorkflow.namedOf('updating', undefined),
      detail: `svn update left ${SvnActionWorkflow.conflictsText(conflicts)}`,
      state: pass.result === 'failed' ? 'failed' : 'done',
      startedAt: pass.startedAt,
      endedAt: pass.endedAt,
      target: SvnActionWorkflow.targetOf('updating', pass.runId),
    }
    if (pass.result !== 'waited') return [update]
    return [update, SvnActionWorkflow.conflictStepOf('waits', 'waited for you, and a press went on', pass.endedAt, pass.endedAt)]
  }

  private static passStepOf(record: SessionRecord, pass: SvnActionPass, runs: RunsOf): PlannedStep {
    const name = pass.runId === undefined ? undefined : SvnActionWorkflow.runNameOf(record, pass.runId, runs)
    const result = pass.result
    let state: SessionWorkflowStepState
    let detail: string
    if (result === 'done') {
      state = 'done'
      if (pass.stage === 'fixing' && pass.facts?.conflicts !== undefined) detail = SvnConflictWords.fixingOf(pass.facts)
      else detail = pass.facts?.revision === undefined ? SvnActionWorkflow.runTitleOf(record, pass.runId, runs) : `committed r${pass.facts.revision}`
    }
    else if (result === 'failed') {
      state = 'failed'
      detail = pass.stage === 'updating' ? 'svn update failed, and ran again' : 'failed'
    }
    else if (result === 'waited') {
      state = 'waits'
      detail = 'waited for you, and a press went on'
    }
    else throw new Error(`Unknown SVN action pass result: ${JSON.stringify(result satisfies never)}`)
    return {
      ...SvnActionWorkflow.namedOf(pass.stage, name),
      detail,
      state,
      startedAt: pass.startedAt,
      endedAt: pass.endedAt,
      // The check of the conflicts opens the conflict list, which then says what each path became.
      target: pass.stage === 'fixing' ? { kind: 'conflicts' } : SvnActionWorkflow.targetOf(pass.stage, pass.runId),
    }
  }

  /**
   * A wait on the conflicts of the update is the update, done, and the conflict step that waits; a
   * wait after Check again is the check of the conflicts, waiting with the summary.
   */
  private static currentOf(action: SessionRecordSvnAction, runs: RunsOf): PlannedStep[] {
    const conflicts = SvnActionWorkflow.conflictWaitOf(action)
    const needs = action.needs
    if (conflicts === null || needs === undefined) return [SvnActionWorkflow.runningOf(action, runs)]
    if (action.stage === 'fixing')
      return [{
        ...SvnActionWorkflow.namedOf('fixing', undefined),
        detail: SvnConflictWords.summaryOf(conflicts),
        state: 'waits',
        startedAt: action.stageAt ?? action.startedAt,
        endedAt: needs.at,
        target: { kind: 'conflicts' },
      }]
    const update: PlannedStep = {
      ...SvnActionWorkflow.namedOf('updating', undefined),
      detail: `svn update left ${SvnActionWorkflow.conflictsText(SvnConflictFlow.totalOf(conflicts))}`,
      state: 'done',
      startedAt: action.stageAt ?? action.startedAt,
      endedAt: conflicts.readAt,
      target: SvnActionWorkflow.targetOf('updating', action.runId),
    }
    return [update, SvnActionWorkflow.conflictStepOf('waits', SvnConflictWords.summaryOf(conflicts), conflicts.readAt, needs.at)]
  }

  /** The set an action waits on after its update or its check; null while it runs or waits for anything else. */
  private static conflictWaitOf(action: SessionRecordSvnAction): SvnActionConflictSet | null {
    const set = action.conflictSet
    return action.needs?.kind === 'conflict' && (action.stage === 'updating' || action.stage === 'fixing') && SvnConflictFlow.open(set) ? set : null
  }

  private static conflictStepOf(state: SessionWorkflowStepState, detail: string, startedAt: number, endedAt: number): PlannedStep {
    return { stage: 'conflicts', base: 'conflicts', title: 'Conflicts', detail, state, startedAt, endedAt, target: { kind: 'conflicts' } }
  }

  private static conflictsText(count: number): string {
    return `${count} conflict${count === 1 ? '' : 's'}`
  }

  private static runningOf(action: SessionRecordSvnAction, runs: RunsOf): PlannedStep {
    const needs = action.needs
    const runId = SvnActionStages.isRun(action.stage) ? action.runId : undefined
    let detail: string
    if (needs !== undefined) detail = needs.reason
    else if (action.retryAt !== undefined) detail = 'the working copy is locked; svn update runs again shortly'
    else detail = runId === undefined ? '' : runs(runId)?.title ?? ''
    return {
      ...SvnActionWorkflow.namedOf(action.stage, SvnActionWorkflow.currentNameOf(action)),
      detail,
      state: needs === undefined ? 'running' : 'waits',
      startedAt: action.stageAt ?? action.startedAt,
      endedAt: needs === undefined ? null : needs.at,
      target: SvnActionWorkflow.targetOf(action.stage, runId),
    }
  }

  private static pendingOf(ahead: AheadStage): PlannedStep {
    return {
      ...SvnActionWorkflow.namedOf(ahead.stage, ahead.name),
      detail: '',
      state: 'pending',
      startedAt: null,
      endedAt: null,
      target: { kind: 'none' },
    }
  }

  /** The check or the review root the current stage works on. */
  private static currentNameOf(action: SessionRecordSvnAction): string | undefined {
    if (action.stage === 'checks') return action.checks[action.checkCursor]?.name
    if (action.stage === 'reviewing') return SvnActionWorkflow.ownNameOf(action.roots?.[action.rootCursor]?.own)
    return undefined
  }

  /** The name a run was launched with: the check, or `.` and the mount path of a review. */
  private static runNameOf(record: SessionRecord, runId: string, runs: RunsOf): string | undefined {
    return runs(runId)?.scriptOf?.name ?? record.scriptRuns?.find((run) => run.runId === runId)?.name
  }

  private static runTitleOf(record: SessionRecord, runId: string | undefined, runs: RunsOf): string {
    if (runId === undefined) return ''
    return runs(runId)?.title ?? record.scriptRuns?.find((run) => run.runId === runId)?.title ?? ''
  }

  private static ownNameOf(own: string | undefined): string | undefined {
    return own === undefined ? undefined : own === '' ? '.' : own
  }

  private static namedOf(stage: SvnActionStage, name: string | undefined): Pick<PlannedStep, 'stage' | 'base' | 'title'> {
    switch (stage) {
      case 'stopping': return { stage, base: 'stopping', title: 'Stop the session' }
      case 'evidence': return { stage, base: 'evidence', title: 'Read what the worktree committed' }
      case 'checks': return { stage, base: `check:${name ?? ''}`, title: name === undefined ? 'Check' : `Check ${name}` }
      case 'updating': return { stage, base: 'updating', title: 'svn update' }
      case 'cleaning': return { stage, base: 'cleaning', title: 'svn cleanup' }
      case 'resolving': return { stage, base: 'resolving', title: 'Claude resolves the conflicts' }
      case 'merging': return { stage, base: 'merging', title: 'Merger' }
      case 'verifying': return { stage, base: 'verifying', title: 'Verify the resolution' }
      case 'fixing': return { stage, base: 'fixing', title: 'Check the conflicts' }
      case 'diffing': return { stage, base: 'diffing', title: 'svn diff of the resolved files' }
      case 'reviewing':
        return { stage, base: `review:${name ?? '.'}`, title: name === undefined || name === '.' ? 'Review' : `Review (${name})` }
      case 'removing': return { stage, base: 'removing', title: 'Remove the worktree' }
      case 'recording': return { stage, base: 'recording', title: 'Record the result' }
      default: throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  /** A run stage targets its run, the resolver and the merger their agent tab, the review its commit split; a client stage nothing. */
  private static targetOf(stage: SvnActionStage, runId: string | undefined): SessionWorkflowTarget {
    if (runId === undefined) return { kind: 'none' }
    switch (stage) {
      case 'checks': case 'updating': case 'cleaning': case 'diffing': return { kind: 'run', runId }
      case 'resolving': case 'merging': return { kind: 'agent', runId }
      case 'reviewing': return { kind: 'commit', runId }
      case 'stopping': case 'evidence': case 'verifying': case 'fixing': case 'removing': case 'recording': return { kind: 'none' }
      default: throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  private static aheadOf(action: SessionRecordSvnAction): AheadStage[] {
    const kind = action.kind
    switch (kind) {
      case 'finish': return SvnActionWorkflow.finishAheadOf(action)
      case 'discard': return SvnActionWorkflow.discardAheadOf(action.stage)
      case 'update-main': return SvnActionWorkflow.updateAheadOf(action.stage)
      default: throw new Error(`Unknown SVN action kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  /** Projected, not promised: Finish again with passed checks goes straight to the review. */
  private static finishAheadOf(action: SessionRecordSvnAction): AheadStage[] {
    const checks = (from: number): AheadStage[] => action.checks.slice(from).map((check) => ({ stage: 'checks', name: check.name }))
    const review: AheadStage = { stage: 'reviewing' }
    const removal: AheadStage = { stage: 'removing' }
    const toTheEnd: AheadStage[] = [{ stage: 'updating' }, review, removal]
    const stage = action.stage
    switch (stage) {
      case 'stopping': return [{ stage: 'evidence' }, ...checks(0), ...toTheEnd]
      case 'evidence': return [...checks(0), ...toTheEnd]
      case 'checks': return [...checks(action.checkCursor + 1), ...toTheEnd]
      case 'updating': case 'cleaning': return [review, removal]
      case 'resolving': return [{ stage: 'verifying' }, ...checks(0), ...toTheEnd]
      case 'merging': case 'verifying': case 'fixing': return [...checks(0), ...toTheEnd]
      case 'reviewing':
        return [...(action.roots ?? []).slice(action.rootCursor + 1)
          .map((root): AheadStage => ({ stage: 'reviewing', name: SvnActionWorkflow.ownNameOf(root.own) })), removal]
      case 'diffing': case 'removing': case 'recording': return []
      default: throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  private static discardAheadOf(stage: SvnActionStage): AheadStage[] {
    switch (stage) {
      case 'stopping': return [{ stage: 'evidence' }, { stage: 'removing' }]
      case 'evidence': return [{ stage: 'removing' }]
      case 'checks': case 'updating': case 'cleaning': case 'resolving': case 'merging': case 'verifying': case 'fixing': case 'diffing':
      case 'reviewing': case 'removing': case 'recording':
        return []
      default: throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  private static updateAheadOf(stage: SvnActionStage): AheadStage[] {
    switch (stage) {
      case 'resolving': return [{ stage: 'verifying' }, { stage: 'diffing' }]
      case 'verifying': return [{ stage: 'diffing' }]
      case 'stopping': case 'evidence': case 'checks': case 'updating': case 'cleaning': case 'merging': case 'fixing': case 'diffing':
      case 'reviewing': case 'removing': case 'recording':
        return []
      default: throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  /**
   * A new round at each `svn update` after one that ran through; a relaunch after a lock stays in its
   * round. A round that follows a merger says so: the merger loop reads as fix, merge, update again.
   */
  private static roundsOf(first: string, steps: readonly PlannedStep[]): SessionWorkflowRound[] {
    const rounds: { steps: PlannedStep[] }[] = [{ steps: [] }]
    for (const step of steps) {
      const round = rounds[rounds.length - 1]
      const updated = round.steps.some((earlier) => earlier.stage === 'updating' && (earlier.state === 'done' || earlier.state === 'waits'))
      if (step.stage === 'updating' && updated) rounds.push({ steps: [step] })
      else round.steps.push(step)
    }
    return rounds.map((round, index) => {
      const seen = new Map<string, number>()
      const afterMerger = index > 0 && rounds[index - 1].steps.some((step) => step.stage === 'merging')
      return {
        title: index === 0 ? first : `Update ${index + 1}${afterMerger ? ', after the merger' : ''}`,
        steps: round.steps.map(({ stage: _stage, base, ...step }): SessionWorkflowStep => {
          const count = (seen.get(base) ?? 0) + 1
          seen.set(base, count)
          return { key: `${index + 1}:${base}${count === 1 ? '' : `#${count}`}`, ...step }
        }).slice(-SvnActionWorkflow.stepsMaxConst),
      }
    }).slice(-SvnActionWorkflow.roundsMaxConst)
  }

  /**
   * A waiting Finish goes on with Finish again, Keep or Discard; a waiting Discard with Discard again
   * or Keep. Both open the worktree in VS Code, where the person fixes what waits. A Finish that waits
   * on its conflicts offers Check again and, while a path an agent may settle is open, Resolve with
   * agent. A waiting UPDATE is pressed again where it was pressed. A running action admits nothing,
   * except while an agent works for a Finish: Stop agent, and Keep and Discard, which stop it first;
   * while the merger works also Check again, Open merger and Open in VS Code.
   */
  private static actionsOf(action: SessionRecordSvnAction): SessionWorkflowAction[] {
    const keep: SessionWorkflowAction = { id: 'keep', label: 'Keep worktree', primary: false }
    const discard: SessionWorkflowAction = { id: 'discard', label: 'Discard', primary: false }
    const vscode: SessionWorkflowAction = { id: 'open-in-vscode', label: 'Open in VS Code', primary: false }
    if (action.needs === undefined) {
      const runId = SvnActionStages.agentRunOf(action)
      if (runId === null || action.kind !== 'finish') return []
      if (action.stage === 'merging') return [
        { id: 'finish-again', label: 'Check again', primary: true },
        { id: 'open-merger', label: 'Open merger', primary: false, runId },
        { id: 'stop-agent', label: 'Stop agent', primary: false, runId },
        vscode, keep, discard,
      ]
      return [{ id: 'stop-agent', label: 'Stop agent', primary: false, runId }, keep, discard]
    }
    const kind = action.kind
    if (kind === 'finish' && action.needs.kind === 'conflict' && SvnActionStages.resumesAtFixing(action)) {
      const agent = (action.conflictSet?.entries ?? []).some(SvnMergerLauncher.forAgent)
      return [
        { id: 'finish-again', label: 'Check again', primary: true },
        ...agent ? [{ id: 'resolve-with-agent' as const, label: 'Resolve with agent', primary: false }] : [],
        vscode, keep, discard,
      ]
    }
    switch (kind) {
      case 'finish': return [
        { id: 'finish-again', label: SvnActionStages.resumesAtFixing(action) ? 'Check again' : 'Finish again', primary: true },
        { id: 'keep', label: 'Keep worktree', primary: false },
        { id: 'discard', label: 'Discard', primary: false },
        { id: 'open-in-vscode', label: 'Open in VS Code', primary: false },
      ]
      case 'discard': return [
        { id: 'discard', label: 'Discard again', primary: true },
        { id: 'keep', label: 'Keep worktree', primary: false },
        { id: 'open-in-vscode', label: 'Open in VS Code', primary: false },
      ]
      case 'update-main': return []
      default: throw new Error(`Unknown SVN action kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  private static titleOf(record: SessionRecord, kind: SvnActionKind, root: string): string {
    switch (kind) {
      case 'finish': return `Finish of ${record.title}`
      case 'discard': return `Discard of ${record.title}`
      case 'update-main': return `UPDATE of ${basename(root) || root}`
      default: throw new Error(`Unknown SVN action kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  private static kindWordOf(kind: SvnActionKind): string {
    switch (kind) {
      case 'finish': return 'Finish'
      case 'discard': return 'Discard'
      case 'update-main': return 'UPDATE'
      default: throw new Error(`Unknown SVN action kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  private static runningBadgeOf(action: SessionRecordSvnAction): string {
    const stage = action.stage
    switch (stage) {
      case 'stopping': return 'stopping'
      case 'evidence': return 'reading'
      case 'checks': return 'checking'
      case 'updating': return action.retryAt === undefined ? 'updating' : 'waits for the lock'
      case 'cleaning': return 'cleaning up'
      case 'resolving': return 'resolving'
      case 'merging': return 'merging'
      case 'verifying': return 'verifying'
      case 'fixing': return 'checking conflicts'
      case 'diffing': return 'diffing'
      case 'reviewing': return 'reviewing'
      case 'removing': return 'removing'
      case 'recording': return 'recording'
      default: throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  private static runningSummaryOf(action: SessionRecordSvnAction): string {
    const stage = action.stage
    switch (stage) {
      case 'stopping': return 'Stopping the session'
      case 'evidence': return 'Reading what the worktree committed'
      case 'checks': return `Running the check ${action.checks[action.checkCursor]?.name ?? ''}`.trim()
      case 'updating': return action.retryAt === undefined ? 'Running svn update' : 'Waiting for the svn lock'
      case 'cleaning': return 'Running svn cleanup'
      case 'resolving': return 'Claude resolves the conflicts'
      case 'merging': return 'The merger settles the conflicts the rules left'
      case 'verifying': return 'Verifying the resolution'
      case 'fixing': return 'Checking the conflicts'
      case 'diffing': return 'Showing the merge as svn diff'
      case 'reviewing': {
        const count = action.roots?.length ?? 0
        return count > 1 ? `Reviewing ${action.rootCursor + 1} of ${count}` : 'Reviewing the changes'
      }
      case 'removing': return 'Removing the worktree'
      case 'recording': return 'Recording the result'
      default: throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  /** The row mark of a waiting action: short, the full reason is the summary. */
  private static needBadgeOf(need: SvnActionNeed): string {
    switch (need) {
      case 'check-failed': return 'check failed'
      case 'conflict': return 'conflicts need you'
      case 'resolver-failed': return 'resolver failed'
      case 'incoming': return 'incoming commits'
      case 'out-of-date': return 'out of date'
      case 'review-cancelled': return 'review cancelled'
      case 'review-interrupted': return 'review interrupted'
      case 'partial': return 'partly committed'
      case 'pinned-external': return 'pinned external'
      case 'locked': return 'locked'
      case 'svn-failed': return 'svn failed'
      case 'not-stopped': return 'not stopped'
      default: throw new Error(`Unknown SVN action need: ${JSON.stringify(need satisfies never)}`)
    }
  }

  private static resultBadgeOf(result: SvnFinishResult): string {
    switch (result) {
      case 'committed': return 'committed'
      case 'partial': return 'partly committed'
      case 'not-committed': return 'not committed'
      case 'out-of-date': return 'out of date'
      case 'updated': return 'updated'
      case 'conflict': return 'conflict'
      case 'nothing': return 'nothing to commit'
      case 'failed': return 'failed'
      case 'interrupted': return 'interrupted'
      default: throw new Error(`Unknown finish result: ${JSON.stringify(result satisfies never)}`)
    }
  }
}
