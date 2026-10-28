import type {
  SessionRecord,
  SessionRecordFinishChecks,
  SessionRecordScriptStep,
  SessionRecordWorktree,
} from '../records/sessionRecord.types'
import type { SessionRecordsStore } from '../records/sessionRecordsStore'
import type { CommandAgreement } from '../scripts/commandAgreement'
import { DeclaredScripts } from '../scripts/declaredScripts'
import { ScriptChain } from '../scripts/scriptChain'
import { ScriptRunRecords } from '../scripts/scriptRunRecords'
import { SessionScriptDefinitions } from '../scripts/sessionScriptDefinitions'
import type { SessionsOpResult } from '../sessionManagerApi.types'
import { FinalizeSteps } from '../../worktrees/worktreeFinish'
import { OperationOutcomes } from './operationOutcomes'
import type { ReconcileChange } from './reconciler'
import { ScriptRunLauncher } from './scriptRunLauncher'
import { SetupFlow } from './setupFlow'
import type { HostGate } from '../hostGate'

export type FinishChecksGate =
  /** Nothing declared: the finisher runs. */
  | { kind: 'none' }
  /** The whole chain passed since the session last ran: the finisher runs. */
  | { kind: 'passed' }
  /** The chain started; the Finish continues when it passes. */
  | { kind: 'started' }
  /** A press while the chain runs does nothing more. */
  | { kind: 'running' }
  | { kind: 'refused'; result: SessionsOpResult<never> }

/** What the lifecycle answers for this flow, kept narrow so the flow never sees the whole class. */
export interface FinishLaunchPort {
  /** Why no run may go into the record's worktree now: a finish or cleanup holds it, or it is gone. */
  startRefusal(record: SessionRecord): Promise<SessionsOpResult<never> | null>
}

export interface FinishScriptsFlowDeps {
  hostGate?: Pick<HostGate, 'problemOf'>
  records: SessionRecordsStore
  setup: Pick<SetupFlow, 'environmentOf'>
  /** The gate in front of every repository-authored command; `declared` says what `scripts.after` holds. */
  agreement: Pick<CommandAgreement, 'declared' | 'gate'>
  runs: Pick<ScriptRunLauncher, 'launch'>
  launch: FinishLaunchPort
  report: (message: string) => void
  newId: () => string
  now: () => number
  /** This client process's start: only a chain it began continues the Finish on its own. */
  startedAt: number
}

/**
 * The after chain of a Finish: the project's declared `scripts.after`, one run per step, before the
 * finisher commits or merges anything. A pass continues the Finish, a failure blocks it.
 *
 * Like the before chain, every step is a record write plus a launch, and the parent names the run it
 * waits on through `finishChecks`, so a client that dies mid-check leaves a chain the next reconcile
 * pass judges. Only the process that started a chain continues the Finish by itself: a chain found on
 * disk after a restart waits for the next press, so no commit review opens out of nowhere.
 */
export class FinishScriptsFlow {
  private readonly hostGate: FinishScriptsFlowDeps['hostGate']
  private readonly records: SessionRecordsStore
  private readonly setup: FinishScriptsFlowDeps['setup']
  private readonly agreement: Pick<CommandAgreement, 'declared' | 'gate'>
  private readonly runs: Pick<ScriptRunLauncher, 'launch'>
  private readonly launch: FinishLaunchPort
  private readonly report: (message: string) => void
  private readonly newId: () => string
  private readonly now: () => number
  private readonly startedAt: number
  /** Wired late, like `setResumeMerge`: the Finish belongs to the session manager. */
  private continueFinish: ((parentId: string) => void) | null = null

  constructor(deps: FinishScriptsFlowDeps) {
    this.hostGate = deps.hostGate
    this.records = deps.records
    this.setup = deps.setup
    this.agreement = deps.agreement
    this.runs = deps.runs
    this.launch = deps.launch
    this.report = deps.report
    this.newId = deps.newId
    this.now = deps.now
    this.startedAt = deps.startedAt
  }

  setContinueFinish(resume: (parentId: string) => void): void {
    this.continueFinish = resume
  }

  /**
   * Asked by a Finish press before the finisher. `finisherRefusal` is what the finisher would answer
   * before touching anything: a chain is not started for a Finish that could not follow it.
   *
   * Every press after a failure runs the whole chain again, because a manual fix can break a step
   * that passed before. A pass counts only while the session has not run since the chain started and
   * the declared steps are the same.
   */
  async gate(
    parentId: string,
    acknowledge: string | undefined,
    finisherRefusal: SessionsOpResult<never> | null,
  ): Promise<FinishChecksGate> {
    const parent = this.records.get(parentId)
    if (!parent) return FinishScriptsFlow.refused(OperationOutcomes.notFound(parentId))
    // The press was planned before this turn of the queue; a reopen or a removal may have come first.
    const step = FinalizeSteps.planOf(parent)
    const worktree = parent.worktree
    if (step !== 'finish-worktree' || worktree === undefined)
      return FinishScriptsFlow.refused({
        ok: false,
        code: 'live-refused',
        detail: `Session ${parentId}: the next Finish step is ${step}, not the finish of its worktree; nothing was done`,
      })
    const checks = parent.finishChecks
    if (SessionScriptDefinitions.judging('finish', parent)) return { kind: 'running' }
    const declared = await this.declaredAfter(parent, acknowledge)
    if (!declared.ok) return FinishScriptsFlow.refused(declared.result)
    if (declared.steps.length === 0) return this.none(parent)
    if (checks?.result?.kind === 'passed' && checks.startedAt >= (parent.endedAt ?? 0)
      && ScriptChain.sameKeys(checks.steps, declared.steps))
      return { kind: 'passed' }
    if (finisherRefusal) return FinishScriptsFlow.refused(finisherRefusal)
    const held = await this.launch.startRefusal(parent)
    if (held) return FinishScriptsFlow.refused(held)
    if (this.records.latched) return FinishScriptsFlow.refused(OperationOutcomes.latched())
    return this.start(parent, worktree, declared.steps)
  }

  /**
   * The project's `scripts.after` as steps, from one read of the main copy's `.worktree.json`, never
   * the worktree's own: an agent must not author what runs outside it. The agreement is checked over
   * the same read. A file that is there and cannot be read is refused rather than read as declaring
   * nothing, or a Finish would commit with no checks. No project, or nothing declared, is no step.
   */
  async declaredAfter(
    parent: SessionRecord,
    acknowledge: string | undefined,
  ): Promise<{ ok: true; steps: SessionRecordScriptStep[]; environment?: string; install?: SessionRecordScriptStep } | { ok: false; result: SessionsOpResult<never> }> {
    const worktree = parent.worktree
    const projectRoot = worktree === undefined ? null : SetupFlow.setupProjectOf(parent.directory, worktree)
    if (projectRoot === null || worktree === undefined) return { ok: true, steps: [] }
    const read = await this.agreement.declared(projectRoot)
    if (read.kind === 'unreadable' || read.kind === 'damaged')
      return { ok: false, result: { ok: false, code: 'invalid-spec', detail: read.problem } }
    else if (read.kind !== 'read') throw new Error(`Unknown declared commands read: ${JSON.stringify(read satisfies never)}`)
    const after = read.value?.scripts.after ?? []
    const hostProblem = after.length === 0 ? null : this.hostGate?.problemOf(true)
    if (hostProblem) return { ok: false, result: { ok: false, code: 'host-unreachable', detail: hostProblem } }
    if (after.length === 0 && worktree.kind !== 'svn') return { ok: true, steps: [] }
    const agreement = this.agreement.gate(projectRoot, read, acknowledge)
    if (agreement) return { ok: false, result: agreement }
    const setup = worktree.kind === 'svn' ? await this.setup.environmentOf(parent, read) : undefined
    const environment = setup === undefined ? {} : { environment: setup.commands, ...setup.install === undefined ? {} : { install: setup.install } }
    if (after.length === 0) return { ok: true, steps: [], ...environment }
    const steps = DeclaredScripts.stepsOf(after, {
      projectRoot,
      repositoryRoot: worktree.repositoryRoot,
      worktreePath: worktree.worktreePath,
    })
    if (!steps.ok) return { ok: false, result: { ok: false, code: 'invalid-spec', detail: steps.problem } }
    return { ok: true, steps: steps.steps, ...environment }
  }

  /**
   * A step exited cleanly: the next step starts, or after the last one the chain has passed and the
   * Finish continues. Not while the run's own record still says it runs: the verdict is read off the
   * Host's dead runtime in the same pass that marks that record ended, and the finisher refuses a
   * worktree a run of the session still stands in. Nothing is written then, so the next pass judges
   * again from the ended record.
   */
  async applyPassed(parentId: string): Promise<ReconcileChange | null> {
    const parent = this.records.get(parentId)
    const checks = parent?.finishChecks
    if (!parent || !checks || checks.result !== undefined) return null
    const run = this.records.get(checks.runId)
    if (run?.life === 'live' || run?.life === 'starting') return null
    const next = checks.cursor + 1
    if (next < checks.steps.length) return this.advance(parent, checks, next)
    const passed = await this.records.update(parentId, (current) => FinishScriptsFlow.judgedOf(current, checks.runId)
      ? { ...current, finishChecks: { ...checks, result: { kind: 'passed', at: this.now() } } }
      : null)
    if (!passed) return null
    if (checks.startedAt >= this.startedAt && this.continueFinish !== null) this.continueFinish(parentId)
    else this.report(`Session ${parentId}: its Finish checks passed; press Finish to continue`)
    return { kind: 'script-succeeded', sessionId: parentId, gate: 'finish' }
  }

  /** The Finish stops here. The failed run stays a row, named by the chain, until the next press. */
  async applyFailed(parentId: string, reason: string): Promise<boolean> {
    const parent = this.records.get(parentId)
    const checks = parent?.finishChecks
    if (!parent || !checks || checks.result !== undefined) return false
    const done = await this.records.update(parentId, (current) => FinishScriptsFlow.judgedOf(current, checks.runId)
      ? { ...current, finishChecks: { ...checks, result: { kind: 'failed', reason, at: this.now() } } }
      : null)
    if (done)
      this.report(`Session ${parentId}: the Finish stopped because its check ${checks.steps[checks.cursor].name} `
        + `failed (${reason}); nothing was committed or merged, and the output is under Scripts`)
    return done
  }

  /** Run first, chain second, launch third: the order the before chain keeps for crash safety. */
  private async start(
    parent: SessionRecord,
    worktree: SessionRecordWorktree,
    steps: SessionRecordScriptStep[],
  ): Promise<FinishChecksGate> {
    const startedAt = this.now()
    const run = this.runOf(parent.sessionId, steps, 0, worktree.worktreePath)
    if (!await this.records.put(run)) return FinishScriptsFlow.refused(OperationOutcomes.latched())
    const finishChecks: SessionRecordFinishChecks = { runId: run.sessionId, steps, cursor: 0, startedAt }
    if (!await this.records.update(parent.sessionId, (current) => ({ ...current, finishChecks })))
      return FinishScriptsFlow.refused(OperationOutcomes.latched())
    const launched = await this.runs.launch(run)
    return launched.ok || ScriptRunLauncher.replayArmed(this.records.get(run.sessionId))
      ? { kind: 'started' }
      : FinishScriptsFlow.refused(launched)
  }

  /**
   * A client that dies after the run's write leaves it named by nobody, so the orphan rule marks it
   * lost, the step before it is judged succeeded once more, and exactly one new run is launched.
   */
  private async advance(
    parent: SessionRecord,
    checks: SessionRecordFinishChecks,
    cursor: number,
  ): Promise<ReconcileChange | null> {
    const worktreePath = parent.worktree?.worktreePath ?? checks.steps[cursor].commands[0].cwd
    const run = this.runOf(parent.sessionId, checks.steps, cursor, worktreePath)
    if (!await this.records.put(run)) return null
    const advanced = await this.records.update(parent.sessionId, (current) => FinishScriptsFlow.judgedOf(current, checks.runId)
      ? { ...current, finishChecks: { ...checks, runId: run.sessionId, cursor } }
      : null)
    if (!advanced) return null
    await this.runs.launch(run)
    return { kind: 'script-succeeded', sessionId: parent.sessionId, gate: 'finish' }
  }

  /**
   * Nothing to check. A chain left from an earlier press goes, so its failed run collapses and the
   * badge stops speaking of checks the project no longer declares.
   */
  private async none(parent: SessionRecord): Promise<FinishChecksGate> {
    if (parent.finishChecks !== undefined)
      await this.records.update(parent.sessionId, (current) => ({ ...current, finishChecks: undefined }))
    return { kind: 'none' }
  }

  private runOf(
    parentId: string,
    steps: readonly SessionRecordScriptStep[],
    cursor: number,
    worktreePath: string,
  ): SessionRecord {
    const step = steps[cursor]
    return ScriptRunRecords.shellRun({
      runId: this.newId(),
      operationId: this.newId(),
      link: SessionScriptDefinitions.linkOf(parentId, 'after', step.scriptId, step.name, step.key),
      title: ScriptRunRecords.titleOf(step, worktreePath),
      commands: step.commands,
      now: this.now(),
    })
  }

  /** The chain still names the run that was judged and has no result: the judgement is this one's to write. */
  private static judgedOf(current: SessionRecord, runId: string): boolean {
    return current.finishChecks?.runId === runId && current.finishChecks.result === undefined
  }

  private static refused(result: SessionsOpResult<never>): FinishChecksGate {
    return { kind: 'refused', result }
  }
}
