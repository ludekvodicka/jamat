import { FinishProjection } from '../finish/finishProjection'
import { WorktreeWords } from './worktreeWords'
import { SvnCommitMessageCheck } from '../../svn/svnCommitMessageCheck'
import { basename, resolve } from 'node:path'

import type { SessionRecord, SessionRecordSvnAction, SvnActionConflictSet, SvnActionPass } from '../../sessionManager/worktreeSessionRecords'
import type {
  SessionLiveBrief,
  SessionLiveState,
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
} from '../../sessionManager/sessionManagerApi.types'
import { SvnActionStages } from '../finish/svnActionStages'
import { SvnConflictFlow } from '../conflicts/svnConflictFlow'
import { SvnConflictWords } from '../conflicts/svnConflictWords'
import { SvnMergerLauncher } from '../conflicts/svnMergerLauncher'
import { SvnWaitHelper } from '../conflicts/svnWaitHelper'
import { LandedRows } from '../landing/landedRows'
import { SvnRevisionLabels } from '../finish/svnRevisionLabels'
import { WorktreePublication } from '../worktreePublication'
import { PathCompare } from '../../shared/pathCompare'
import { WorktreeRecovery } from '../worktreeRecovery'

/** A step before it is keyed into its round. */
interface PlannedStep {
  /** `conflicts`: the step of the conflicts an update left, which starts no round; `saving`: the copy an UPDATE made first. */
  stage: SvnActionStage | 'conflicts' | 'saving'
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

  static of(record: SessionRecord, action: SessionRecordSvnAction, runs: RunsOf, live: SessionLiveState = { kind: 'known', sessions: [] }): SessionWorkflowInfo {
    const driven = action.kind !== 'update-main' && record.worktreeLifecycle?.execution !== undefined
    const passes = FinishProjection.shownPasses(record, action) ?? []
    // From the action, not the lifecycle: a closed action in the history holds no lifecycle (UA1-J13-5).
    const mounts = SvnRevisionLabels.mountsOfAction(action)
    const done = passes.flatMap((pass) => SvnActionWorkflow.passStepsOf(record, pass, runs, mounts))
    const reviewing = driven && record.worktreeLifecycle!.step === 'reviewing'
    const reviewReady = reviewing && WorktreeWords.reviewReady(record.worktreeLifecycle!)
    const preparing = reviewing && record.worktreeLifecycle!.wait === undefined && !reviewReady
    // A lifecycle Finish records no stage time: its current step began with its open svn run, or else
    // when the last done step ended, not when the Finish started (023's removal read 4 h).
    // A closed lifecycle Finish in the action history has no stage time either.
    const open = driven ? FinishProjection.openRunOf(record) : undefined
    const stageAt = open?.startedAt ?? Math.max(action.startedAt, ...passes.map((pass) => pass.endedAt))
    // A retried removal runs no svn step; its current attempt began when the removal wrote it.
    const removalAt = driven && action.stage === 'removing' ? action.removalAt : undefined
    const current = SvnActionWorkflow.currentOf(record, { ...action, ...driven ? { runId: action.runId ?? open?.runId } : {},
      stageAt: action.stageAt ?? removalAt ?? SvnActionWorkflow.runStartOf(action, runs) ?? stageAt }, runs)
    const verifying = driven ? FinishProjection.verifyingOf(record) : null
    if (verifying !== null) for (const step of current) {
      Object.assign(step, SvnActionWorkflow.publicationNamed)
      if (step.state === 'running') step.detail = `Checking ${SvnActionWorkflow.revisionText(verifying.revision)} in the repository and the worktree`
    }
    if (preparing) for (const step of current) {
      step.state = 'running'
      step.detail = 'Preparing the synced review'
    }
    if (reviewReady)
      for (const step of current) {
        step.base += `:candidate-${record.worktreeLifecycle!.review?.version ?? 'pending'}`
        step.title = 'Validate the prepared worktree'
        step.detail = record.worktreeLifecycle!.wait?.reason ?? SvnActionWorkflow.incomingOf(record)
          ?? 'Run the application from the worktree, inspect the changes and make final edits. Recheck after edits, then publish the entire verified change set.'
      }
    // The idle gate before a commit names what holds it, and the person may publish anyway (UA1-J13-1).
    const idleWait = driven ? WorktreeWords.idleWaitOf(record.worktreeLifecycle!) : null
    if (idleWait !== null) for (const step of current) {
      step.state = 'waits'
      step.detail = idleWait
    }
    const ahead = (verifying === null ? SvnActionWorkflow.aheadOf(action) : SvnActionWorkflow.afterPublicationOf(action)).map(SvnActionWorkflow.pendingOf)
    const conflicts = SvnActionWorkflow.conflictWaitOf(action)
    let badge: string
    if (conflicts !== null) badge = SvnConflictWords.summaryOf(conflicts)
    else if (action.needs !== undefined) badge = SvnActionWorkflow.needBadgeOf(action.needs.kind)
    else badge = SvnActionWorkflow.runningBadgeOf(action)
    const retry = action.kind === 'update-main' && action.needs !== undefined
      ? [{ ...SvnActionWorkflow.pendingOf({ stage: 'main-update' }), state: 'waits' as const }] : []
    const rounds = SvnActionWorkflow.roundsOf(SvnActionWorkflow.kindWordOf(action.kind), SvnActionWorkflow.withSaved(action, [...done, ...current, ...ahead, ...retry]))
    const conflictStep = rounds.flatMap((round) => round.steps).filter((step) => step.body?.kind === 'conflicts').at(-1)
    if (conflictStep !== undefined && action.conflictSet !== undefined)
      conflictStep.body = { kind: 'conflicts', summary: SvnConflictWords.summaryOf(action.conflictSet),
        conflicts: SvnConflictWords.listOf(action.conflictSet, SvnConflictFlow.wireMaxConst, SvnActionStages.sideOf(action)), mergeBrief: action.mergeBrief ?? null }
    if (action.stage === 'changes' && (!driven || reviewReady)) {
      const step = rounds.flatMap((round) => round.steps).filter((step) => step.state === 'waits').at(-1)
      if (step !== undefined) step.body = { kind: 'commit', vcs: 'svn', scopeRoot: action.root, repositories: record.worktreeLifecycle?.review?.repositories,
        ...SvnActionWorkflow.separateMessages(record, action.root) ? { separateMessages: true as const } : {}, messageCheck: { message: action.commit?.message ?? '', source: action.commit?.messageSource ?? 'unknown',
        findings: SvnCommitMessageCheck.info(action.commit?.message ?? '', action.commit?.messageSource ?? 'unknown') }, ...action.marked === undefined ? {} : { marked: action.marked } }
    }
    if (action.stage === 'main-update' || retry.length > 0) {
      const step = rounds.flatMap((round) => round.steps).at(-1)
      if (step !== undefined) step.body = SvnActionWorkflow.liveBodyOf(live)
    }
    return {
      ...(driven && (record.worktreeLifecycle!.step === 'reviewing' || record.worktreeLifecycle!.environment?.pending === true) ? {
        validation: { cwd: action.root, checks: record.worktreeLifecycle!.preparation?.checks ?? 'pending',
          requiredSelection: Object.keys(record.worktreeLifecycle!.review?.hashes ?? {}).map((path) => resolve(action.root, path)),
          checkedAt: record.worktreeLifecycle!.preparation?.checkedAt, canRun: record.life === 'live' && record.worktreeLifecycle!.approvedAt === undefined,
          ...(record.worktreeLifecycle!.environment?.pending ? { environmentInputs: record.worktreeLifecycle!.environment.paths } : {}) },
      } : {}),
      kind: action.kind,
      workflowId: action.actionId,
      title: SvnActionWorkflow.titleOf(record, action.kind, action.root),
      badge: action.kind !== 'update-main' && record.worktreeLifecycle?.execution !== undefined ? WorktreeWords.presentation(record.worktreeLifecycle).title ?? badge : badge,
      summary: preparing ? 'Preparing the synced review' : action.needs !== undefined ? `Waits for you: ${action.needs.reason}`
        : SvnActionWorkflow.failureOf(action) ?? (driven && record.worktreeLifecycle?.step === 'reviewing'
          ? SvnActionWorkflow.incomingOf(record) ?? 'Validate the prepared application, then review and publish the whole verified change set'
        : verifying !== null ? `Verifying the publication${verifying.revision === null ? '' : ` r${verifying.revision}`}` : idleWait ?? SvnActionWorkflow.runningSummaryOf(action)),
      open: true,
      rounds,
      actions: action.kind !== 'update-main' && record.worktreeLifecycle?.execution !== undefined && record.worktreeLifecycle.phase !== 'landed' ? WorktreeWords.actions(record.worktreeLifecycle) : SvnActionWorkflow.actionsOf(action, SvnActionWorkflow.liveBodyOf(live).sessions, LandedRows.landingOf(record) !== null, mounts),
    }
  }

  /**
   * The run of the current stage ended failed and no client step has judged it yet. A Finish whose
   * check failed is closed in exactly this shape, so its history keeps the reason on the summary.
   */
  static failureOf(action: SessionRecordSvnAction): string | null {
    const verdict = action.verdict
    if (action.needs !== undefined || verdict?.kind !== 'failed' || action.runId === undefined || !SvnActionStages.isRun(action.stage)) return null
    return `${SvnActionWorkflow.namedOf(action.stage, SvnActionWorkflow.currentNameOf(action)).title} failed: ${verdict.reason}`
  }

  /**
   * Whether each repository of the review takes its own labelled message: several repositories, a
   * lone mount, or a lone repository after another repository of this worktree already published.
   */
  private static separateMessages(record: SessionRecord, scopeRoot: string): boolean {
    const repositories = record.worktreeLifecycle?.review?.repositories ?? []
    if (repositories.length === 0) return false
    const published = WorktreePublication.retain(record.worktreeLifecycle!).publication?.revisions ?? []
    return repositories.length > 1 || repositories.some((row) => PathCompare.comparable(row.root) !== PathCompare.comparable(scopeRoot))
      || published.some((revision) => !repositories.some((row) => row.repository === revision.repository))
  }

  private static incomingOf(record: SessionRecord): string | undefined {
    const known = record.worktreeLifecycle?.knownIncoming
    return known === undefined ? undefined : WorktreeWords.incomingWaits(known.paths)
  }

  /**
   * A worker lost while no Finish ran. No action holds that wait, so without this section the person
   * saw only the exit code and no press (UA1-J14R-1). Null for every other state.
   */
  static workerLostOf(record: SessionRecord): SessionWorkflowInfo | null {
    const state = record.worktreeLifecycle
    const wait = state?.wait
    if (state === undefined || state.phase !== 'waiting' || state.step !== undefined || state.execution !== undefined || wait?.kind !== 'worker-lost') return null
    return {
      kind: 'finish',
      workflowId: `worker-lost:${wait.at}`,
      title: `Worker of ${record.title}`,
      badge: WorktreeWords.wait(wait.kind).title,
      summary: `Waits for you: ${wait.reason}`,
      open: true,
      startedAt: wait.at,
      rounds: [{ title: 'Worker', steps: [{ key: 'worker-lost', title: 'Resume the worker', detail: wait.reason, state: 'waits',
        startedAt: wait.at, endedAt: null, target: { kind: 'none' } }] }],
      actions: WorktreeWords.actions(state),
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
      // A kept worktree is decided here later: a new preparation, or Discard without one (UA1-J07-7).
      actions: record.worktree !== undefined && record.worktreeLifecycle?.phase === 'kept' ? WorktreeWords.actions(record.worktreeLifecycle) : [],
    }
  }

  /** An update that left conflicts is its own step and, when the action waited on them, a conflict step. */
  private static passStepsOf(record: SessionRecord, pass: SvnActionPass, runs: RunsOf, mounts: ReadonlyMap<string, string>): PlannedStep[] {
    const conflicts = pass.stage === 'updating' ? pass.facts?.conflicts ?? 0 : 0
    if (conflicts === 0) return [SvnActionWorkflow.passStepOf(record, pass, runs, mounts)]
    const update: PlannedStep = {
      ...SvnActionWorkflow.namedOf('updating', undefined),
      detail: SvnActionWorkflow.leftOf(record, pass.runId, runs, conflicts, pass.facts?.revision),
      state: pass.result === 'failed' ? 'failed' : 'done',
      ...SvnActionWorkflow.passTimesOf(record, pass),
      target: SvnActionWorkflow.targetOf('updating', pass.runId),
    }
    if (pass.result !== 'waited') return [update]
    return [update, SvnActionWorkflow.conflictStepOf('waits', 'waited for you, and a press went on', update.endedAt!, update.endedAt!)]
  }

  /**
   * A step lasts as long as its own run. A pass ends when the action moved on, which after a wait is
   * the next press, so a pass that waited without a known run, and the offer of an UPDATE, take no time.
   */
  private static passTimesOf(record: SessionRecord, pass: SvnActionPass): { startedAt: number; endedAt: number } {
    const run = SvnActionWorkflow.runTimesOf(record, pass.runId)
    if (run !== null) return run
    if (pass.result === 'waited' || pass.stage === 'main-update') return { startedAt: pass.endedAt, endedAt: pass.endedAt }
    return { startedAt: pass.startedAt, endedAt: pass.endedAt }
  }

  /**
   * When the run of a check or merger stage began; the last done step ended long before a check the
   * person started later (UA1-J14-8). Undefined for every other stage and before the run exists.
   */
  private static runStartOf(action: SessionRecordSvnAction, runs: RunsOf): number | undefined {
    if (action.stage === 'checks') return action.runId === undefined ? undefined : action.checkStartedAt ?? runs(action.runId)?.createdAt
    if (action.stage === 'merging') return action.merger?.startedAt
    return undefined
  }

  /** When a run began and ended, from the parent's settled runs or the svn journal; null until it ended. */
  private static runTimesOf(record: SessionRecord, runId: string | undefined): { startedAt: number; endedAt: number } | null {
    if (runId === undefined) return null
    const settled = record.scriptRuns?.find((run) => run.runId === runId)
    if (settled !== undefined) return { startedAt: settled.startedAt, endedAt: settled.endedAt }
    const entry = record.worktreeLifecycle?.journal.find((row) => row.runId === runId)
    return entry?.endedAt === undefined ? null : { startedAt: entry.startedAt, endedAt: entry.endedAt }
  }

  private static passStepOf(record: SessionRecord, pass: SvnActionPass, runs: RunsOf, mounts: ReadonlyMap<string, string>): PlannedStep {
    // A commit is named by the root it published, so the commits of several repositories differ.
    const name = pass.stage === 'committing' ? SvnActionWorkflow.ownNameOf(pass.facts?.mount)
      : pass.runId === undefined ? undefined : SvnActionWorkflow.runNameOf(record, pass.runId, runs)
    const publication = pass.stage === 'verifying' && pass.facts?.revision !== undefined
    const repository = pass.facts?.repository === undefined ? undefined : SvnRevisionLabels.labelOf(pass.facts.repository, mounts)
    const revision = pass.facts?.revision === undefined ? undefined : `${repository === undefined ? '' : `${repository} `}r${pass.facts.revision}`
    const result = pass.result
    let state: SessionWorkflowStepState
    let detail: string
    let times: { startedAt: number | null; endedAt: number | null } = SvnActionWorkflow.passTimesOf(record, pass)
    if (result === 'failed' && pass.stage === 'resolving') {
      // The resolver's exit code decides nothing: the markers and svn resolve after it do (UA1-J09-11).
      state = 'skipped'
      const exitCode = record.scriptRuns?.find((run) => run.runId === pass.runId)?.exitCode
      detail = `ended${exitCode === undefined ? '' : ` with exit code ${exitCode}`}; Verify the resolution decides`
    }
    else if (result === 'done') {
      state = 'done'
      const set = record.worktreeLifecycle?.execution === undefined ? undefined : record.worktreeLifecycle.syncConflictSet
      if (pass.stage === 'fixing' && set !== undefined) detail = SvnConflictWords.settledDetailOf(set)
      else if (pass.stage === 'fixing' && pass.facts?.conflicts !== undefined) detail = SvnConflictWords.fixingOf(pass.facts)
      else if (publication) detail = `verified ${revision}`
      else detail = revision === undefined ? SvnActionWorkflow.runTitleOf(record, pass.runId, runs) : `committed ${revision}`
    }
    else if (result === 'failed') {
      state = 'failed'
      if (pass.stage === 'updating') {
        const title = SvnActionWorkflow.runTitleOf(record, pass.runId, runs) || 'svn update'
        // A run the client's stop cut off has no known end, so it shows no duration (UA1-J09-7).
        const interrupted = pass.runId !== undefined && WorktreeRecovery.interrupted(record, pass.runId)
        if (interrupted) times = { startedAt: null, endedAt: null }
        detail = interrupted ? `${title} was interrupted when the client stopped, and ran again` : `${title} failed, and ran again`
      }
      else detail = pass.stage === 'committing' && repository !== undefined ? `commit to ${repository} failed` : 'failed'
    }
    else if (result === 'waited') {
      state = 'waits'
      detail = 'waited for you, and a press went on'
    }
    else throw new Error(`Unknown SVN action pass result: ${JSON.stringify(result satisfies never)}`)
    return {
      ...publication ? SvnActionWorkflow.publicationNamed : SvnActionWorkflow.namedOf(pass.stage, name),
      detail,
      state,
      ...times,
      // The check of the conflicts opens the conflict list, which then says what each path became.
      target: pass.stage === 'fixing' ? { kind: 'conflicts' } : SvnActionWorkflow.targetOf(pass.stage, pass.runId),
    }
  }

  /**
   * A wait on the conflicts of the update is the update, done, and the conflict step that waits; a
   * wait after Check again is the check of the conflicts, waiting with the summary.
   */
  private static currentOf(record: SessionRecord, action: SessionRecordSvnAction, runs: RunsOf): PlannedStep[] {
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
      detail: SvnActionWorkflow.leftOf(record, action.runId, runs, SvnConflictFlow.totalOf(conflicts), conflicts.revision),
      state: 'done',
      ...SvnActionWorkflow.runTimesOf(record, action.runId) ?? { startedAt: action.stageAt ?? action.startedAt, endedAt: conflicts.readAt },
      target: SvnActionWorkflow.targetOf('updating', action.runId),
    }
    return [update, SvnActionWorkflow.conflictStepOf('waits', SvnConflictWords.summaryOf(conflicts), conflicts.readAt, needs.at)]
  }

  /** An UPDATE that saved the local changes overlapping what lands names where, before its first svn update. */
  private static withSaved(action: SessionRecordSvnAction, steps: readonly PlannedStep[]): PlannedStep[] {
    const detail = LandedRows.savedOf(action.updateProtection)
    const at = steps.findIndex((step) => step.stage === 'updating')
    if (detail === null || at < 0) return [...steps]
    const saving: PlannedStep = { stage: 'saving', base: 'saving', title: 'Save your changes', detail, state: 'done', startedAt: null, endedAt: null, target: { kind: 'none' } }
    return [...steps.slice(0, at), saving, ...steps.slice(at)]
  }

  /** The set an action waits on after its update or its check; null while it runs or waits for anything else. */
  private static conflictWaitOf(action: SessionRecordSvnAction): SvnActionConflictSet | null {
    const set = action.conflictSet
    return action.needs?.kind === 'conflict' && (action.stage === 'updating' || action.stage === 'fixing') && SvnConflictFlow.open(set) ? set : null
  }

  private static conflictStepOf(state: SessionWorkflowStepState, detail: string, startedAt: number, endedAt: number): PlannedStep {
    return { stage: 'conflicts', base: 'conflicts', title: 'Conflicts', detail, state, startedAt, endedAt, target: { kind: 'conflicts' } }
  }

  /**
   * `Update lib/ea to r7 left 1 conflict`: the run names the root whose update left them. A press after a
   * wait runs no svn update over a target already at its revision, only reads the conflicts again.
   */
  private static leftOf(record: SessionRecord, runId: string | undefined, runs: RunsOf, count: number, revision?: number): string {
    if (runId === undefined && revision !== undefined) return `Conflicts checked again after r${revision}: ${SvnActionWorkflow.conflictsText(count)} left`
    return `${SvnActionWorkflow.runTitleOf(record, runId, runs) || 'svn update'} left ${SvnActionWorkflow.conflictsText(count)}`
  }

  private static conflictsText(count: number): string {
    return `${count} conflict${count === 1 ? '' : 's'}`
  }

  private static runningOf(action: SessionRecordSvnAction, runs: RunsOf): PlannedStep {
    const needs = action.needs
    const runId = SvnActionStages.isRun(action.stage) ? action.runId : undefined
    const failed = SvnActionWorkflow.failureOf(action) !== null
    let detail: string
    if (needs !== undefined) detail = needs.reason
    else if (failed && action.verdict?.kind === 'failed') detail = action.verdict.reason
    else if (action.retryAt !== undefined) detail = 'the working copy is locked; svn update runs again shortly'
    else if (action.kind === 'update-main' && action.stage === 'recording' && (action.updateProtection?.before.length ?? 0) > 0)
      detail = SvnConflictWords.olderOf(action.updateProtection!.before)
    else detail = runId === undefined ? '' : runs(runId)?.title ?? ''
    return {
      ...SvnActionWorkflow.namedOf(action.stage, SvnActionWorkflow.currentNameOf(action)),
      detail,
      state: failed ? 'failed' : needs === undefined && action.stage !== 'changes' && action.stage !== 'main-update' ? 'running' : 'waits',
      startedAt: action.stageAt ?? action.startedAt,
      endedAt: needs === undefined ? null : needs.at,
      // An open set stays in view while the worker or the merger works on it: the person may settle a path too.
      // A wait with an open set draws it as well: after a failed resolver its options are the way on (UA1-J13-4).
      target: (action.stage === 'fixing' || needs !== undefined) && SvnConflictFlow.unsettled(action.conflictSet) ? { kind: 'conflicts' }
        : SvnActionWorkflow.targetOf(action.stage, runId),
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

  /** The check, or the review or commit root, the current stage works on. */
  private static currentNameOf(action: SessionRecordSvnAction): string | undefined {
    if (action.stage === 'checks') return action.checks[action.checkCursor]?.name
    if (action.stage === 'reviewing' || action.stage === 'committing') return SvnActionWorkflow.ownNameOf(action.roots?.[action.rootCursor]?.own)
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
      case 'committing': return { stage, base: 'committing', title: name === undefined || name === '.' ? 'Commit' : `Commit (${name})` }
      case 'changes': return { stage, base: 'changes', title: 'Changes' }
      case 'main-update': return { stage, base: 'main-update', title: 'Update main copy' }
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

  /** The `verifying` of a lifecycle Finish reads its own publication; the resolver check keeps `namedOf`. */
  private static readonly publicationNamed: Pick<PlannedStep, 'stage' | 'base' | 'title'> = { stage: 'verifying', base: 'publication', title: 'Verify the publication' }

  private static revisionText(revision: number | null): string {
    return revision === null ? 'the published revision' : `r${revision}`
  }

  /** After a verified publication: the commit of each repository left, then the cleanup. */
  private static afterPublicationOf(action: SessionRecordSvnAction): AheadStage[] {
    return [...(action.roots ?? []).slice(action.rootCursor + 1)
      .map((root): AheadStage => ({ stage: 'committing', name: SvnActionWorkflow.ownNameOf(root.own) })), { stage: 'removing' }]
  }

  /** A run stage targets its run, the resolver and the merger their agent tab, the review its commit split; a client stage nothing. */
  private static targetOf(stage: SvnActionStage, runId: string | undefined): SessionWorkflowTarget {
    if (runId === undefined) return { kind: 'none' }
    switch (stage) {
      case 'committing': case 'checks': case 'updating': case 'cleaning': case 'diffing': return { kind: 'run', runId }
      case 'resolving': case 'merging': return { kind: 'agent', runId }
      case 'reviewing': return { kind: 'commit', runId }
      case 'main-update': case 'changes': case 'stopping': case 'evidence': case 'verifying': case 'fixing': case 'removing': case 'recording': return { kind: 'none' }
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
    const review: AheadStage = { stage: 'committing' }
    const removal: AheadStage = { stage: 'removing' }
    const toTheEnd: AheadStage[] = [review, removal]
    const stage = action.stage
    switch (stage) {
      case 'changes': case 'main-update': return []
      case 'committing': return [removal]
      case 'stopping': return [{ stage: 'evidence' }, ...checks(0), ...toTheEnd]
      case 'evidence': return [...checks(0), ...toTheEnd]
      case 'checks': return [...checks(action.checkCursor + 1), ...toTheEnd]
      case 'updating': case 'cleaning': return [review, removal]
      case 'resolving': return [{ stage: 'verifying' }, ...checks(0), ...toTheEnd]
      case 'merging': case 'verifying': case 'fixing': return action.checks.length > 0 ? [...checks(0), ...toTheEnd] : [{ stage: 'updating' }, ...toTheEnd]
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
      case 'main-update': case 'changes': case 'committing': case 'checks': case 'updating': case 'cleaning': case 'resolving': case 'merging': case 'verifying': case 'fixing': case 'diffing':
      case 'reviewing': case 'removing': case 'recording':
        return []
      default: throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  private static updateAheadOf(stage: SvnActionStage): AheadStage[] {
    switch (stage) {
      case 'resolving': return [{ stage: 'verifying' }, { stage: 'diffing' }]
      case 'verifying': return [{ stage: 'diffing' }]
      case 'main-update': case 'changes': case 'stopping': case 'evidence': case 'committing': case 'checks': case 'updating': case 'cleaning': case 'merging': case 'fixing': case 'diffing':
      case 'reviewing': case 'removing': case 'recording':
        return []
      default: throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  /**
   * A new round at each `svn update` after one that ran through; a relaunch after a lock stays in its
   * round, and so does the update of the next target of the same sync (`.`, then a mount), which
   * directly follows the update before it. A round that follows a merger says so: the merger loop
   * reads as fix, merge, update again.
   */
  private static roundsOf(first: string, steps: readonly PlannedStep[]): SessionWorkflowRound[] {
    const rounds: { steps: PlannedStep[] }[] = [{ steps: [] }]
    for (const step of steps) {
      const round = rounds[rounds.length - 1]
      const updated = round.steps.some((earlier) => earlier.stage === 'updating' && (earlier.state === 'done' || earlier.state === 'waits'))
      const nextTarget = round.steps.at(-1)?.stage === 'updating' && round.steps.at(-1)?.state === 'done'
      if (step.stage === 'updating' && updated && !nextTarget) rounds.push({ steps: [step] })
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
          return { key: `${index + 1}:${base}${count === 1 ? '' : `#${count}`}`, ...step,
            ...step.target.kind === 'run' ? { body: { kind: 'log', runId: step.target.runId } }
              : step.target.kind === 'conflicts' ? { body: { kind: 'conflicts' } } : {} }
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
   * while the merger works also Check again, Open merger and Open in VS Code. Every wait the merger
   * does not cover offers Solve with agent. The presses of the current step are drawn under it.
   * Later changes nothing: its line says the UPDATE still waits, and where else it can be pressed.
   */
  /** A Host that cannot be reached names no session live; the confirmation then names nobody. */
  private static liveBodyOf(live: SessionLiveState): { kind: 'sessions'; sessions: SessionLiveBrief[]; liveUnknown?: true } {
    switch (live.kind) {
      case 'known': return { kind: 'sessions', sessions: [...live.sessions] }
      case 'unknown': return { kind: 'sessions', sessions: [], liveUnknown: true }
      default: throw new Error(`Unknown live state: ${JSON.stringify(live satisfies never)}`)
    }
  }

  private static actionsOf(action: SessionRecordSvnAction, live: readonly SessionLiveBrief[], landed: boolean, mounts: ReadonlyMap<string, string>): SessionWorkflowAction[] {
    // Text conflicts the rules left, and no resolver of this press is left: the press starts one (Finish 072).
    const open = action.conflictSet?.entries.filter((entry) => entry.state !== 'settled') ?? []
    const agent = action.kind === 'update-main' && action.needs?.kind === 'conflict' && action.resolverSpent === true
      && action.conflictSet?.more === 0 && open.length > 0 && open.every((entry) => entry.kind === 'text')
    if (action.stage === 'main-update' || action.kind === 'update-main' && action.needs !== undefined) return [
      { id: 'update-main', label: agent ? 'Resolve with agent' : SvnConflictWords.updateConst, primary: true, place: 'step', confirmLive: live.map((session) => session.sessionId) },
      { id: 'later', label: 'Later', primary: false, place: 'step', deferred: landed
        ? 'Main copy update left for later. It still waits on this step and in the session menu of the sessions tree: Update main copy.'
        : 'Main copy update left for later. It still waits on this step.' },
    ]
    const confirm = WorktreeWords.discardConfirm(action.evidence, undefined, [], mounts)
    if (action.stage === 'changes') return [
      { id: 'finish-again', label: 'Commit & merge', primary: true, place: 'step', requiresCommit: true },
      { id: 'discard', label: 'Discard', primary: false, place: 'step', confirm },
      { id: 'keep', label: 'Keep', primary: false, place: 'step' },
    ]
    const keep: SessionWorkflowAction = { id: 'keep', label: 'Keep worktree', primary: false }
    const discard: SessionWorkflowAction = { id: 'discard', label: 'Discard', primary: false, confirm }
    const vscode: SessionWorkflowAction = { id: 'open-in-vscode', label: 'Open in VS Code', primary: false }
    const solve: SessionWorkflowAction[] = SvnWaitHelper.offered(action)
      ? [{ id: 'solve-with-agent', label: 'Solve with agent', primary: false, place: 'step' }] : []
    if (action.needs === undefined) {
      const runId = SvnActionStages.agentRunOf(action)
      if (runId === null || action.kind !== 'finish') return []
      if (action.stage === 'merging') return [
        { id: 'finish-again', label: SvnConflictWords.checkAgainConst, primary: true, place: 'step' },
        { id: 'open-merger', label: 'Open merger', primary: false, runId, place: 'step' },
        { id: 'stop-agent', label: 'Stop agent', primary: false, runId, place: 'step' },
        vscode, keep, discard,
      ]
      return [{ id: 'stop-agent', label: 'Stop agent', primary: false, runId, place: 'step' }, keep, discard]
    }
    const kind = action.kind
    if (kind === 'finish' && action.needs.kind === 'conflict' && SvnActionStages.resumesAtFixing(action)) {
      const agent = (action.conflictSet?.entries ?? []).some(SvnMergerLauncher.forAgent)
      return [
        { id: 'finish-again', label: SvnConflictWords.checkAgainConst, primary: true, place: 'step' },
        ...agent ? [{ id: 'resolve-with-agent' as const, label: 'Resolve with agent', primary: false, place: 'step' as const }] : [],
        ...solve,
        vscode, keep, discard,
      ]
    }
    switch (kind) {
      case 'finish': return [
        { id: 'finish-again', label: SvnActionWorkflow.finishAgainLabelOf(action), primary: true, place: 'step' },
        ...solve,
        keep, discard, vscode,
      ]
      case 'discard': return [
        { id: 'discard', label: 'Discard again', primary: false, place: 'step', confirm },
        ...solve,
        keep, vscode,
      ]
      case 'update-main': return []
      default: throw new Error(`Unknown SVN action kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  /** Incoming commits are already updated in: the press only goes on to the review. */
  private static finishAgainLabelOf(action: SessionRecordSvnAction): string {
    if (SvnActionStages.resumesAtFixing(action)) return SvnConflictWords.checkAgainConst
    return action.needs?.kind === 'incoming' ? 'Continue to review' : 'Finish again'
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
      case 'committing': return 'committing'
      case 'changes': return 'waits for you'
      case 'main-update': return 'update main copy'
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
      case 'committing': return 'Committing the selected files'
      case 'changes': return 'Review the changes, choose files and enter a commit message'
      case 'main-update': return 'Update the main copy now or leave this step for later'
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
      case 'removal-blocked': return 'removal blocked'
      case 'not-stopped': return 'not stopped'
      case 'worker-busy': return 'worker working'
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
