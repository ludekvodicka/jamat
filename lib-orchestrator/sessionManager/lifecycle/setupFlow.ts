import type { HostGate } from '../hostGate'
import { existsSync } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'

import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import { ErrorText } from '../../shared/errorText'
import { ProductGroup } from '../../shared/productGroup'
import { SetupPaths } from '../../projectSetup/setupPaths'
import { SetupInputs } from '../../projectSetup/setupInputs'
import type { WorktreeFacts } from '../../git/git.types'
import type {
  SessionDirectoryRef,
  SessionRecord,
  SessionRecordProcess,
  SessionRecordScriptStep,
  SessionRecordSetupCommand,
  SessionRecordWorktree,
} from '../records/sessionRecord.types'
import type { ReconcileChange } from './reconciler'
import type { SessionRecordsStore } from '../records/sessionRecordsStore'
import type {
  SessionCreateSpec,
  SessionSetupAgreement,
  SessionsOpErrorCode,
  SessionsOpResult,
} from '../sessionManagerApi.types'
import type { SetupResolution, SetupScope } from '../../projectSetup/projectSetup.types'
import type { CommandAgreement, DeclaredCommandsRead } from '../scripts/commandAgreement'
import { DeclaredScripts } from '../scripts/declaredScripts'
import { ScriptChain } from '../scripts/scriptChain'
import { ScriptRunPlanning } from '../scripts/scriptRunPlanning'
import { ScriptRunRecords } from '../scripts/scriptRunRecords'
import type { SessionScriptsManager } from '../scripts/sessionScriptsManager'
import { SessionScriptDefinitions } from '../scripts/sessionScriptDefinitions'
import { ScriptRunLauncher } from './scriptRunLauncher'
import type { SessionSetupPort } from './sessionLifecycle'
import type { LocalBeforeStep, SessionWorktreePort, WorktreePlacement } from '../../worktrees/worktreeLifecycle.types'
import { OperationOutcomes } from './operationOutcomes'
import { WorktreeCleanupPacing } from '../../worktrees/worktreeRemoval'

/** What the setup resolution means for one worktree: run these commands, or install nothing. */
type SetupPlan =
  | { kind: 'run'; commands: SessionRecordSetupCommand[] }
  /**
   * `reason` is what the record keeps and what a refusal quotes; `announcement` is the sentence for
   * the user, and it is null only where the project itself already said it needs nothing. They are
   * two strings rather than one because only some of these have anything to advise.
   */
  | { kind: 'skip'; reason: string; announcement: string | null }

export type SetupSkip = Extract<SetupPlan, { kind: 'skip' }>

/**
 * The before chain of a worktree: the setup step when one resolves, then the project's declared
 * before scripts, one run per step. `skipped` is why no setup step leads a chain of declared steps.
 */
export type BeforePlan =
  | { kind: 'run'; steps: SessionRecordScriptStep[]; skipped: SetupSkip | null }
  | SetupSkip

/**
 * What the lifecycle around this flow does for it, kept narrow so the flow never sees the whole
 * class. The launch of a run itself goes through `ScriptRunLauncher`.
 */
export interface SetupLaunchPort {
  replayLaunch(
    change: Extract<ReconcileChange, { kind: 'retry-launch' }>,
  ): Promise<ReconcileChange | null>
  unrecordedWorktree(
    facts: WorktreeFacts,
  ): { ok: false; code: SessionsOpErrorCode; detail: string }
  /** Why no launch may go into the record's worktree now: a finish or cleanup holds it, or it is gone. */
  startRefusal(record: SessionRecord): Promise<SessionsOpResult<never> | null>
}

/**
 * The before chain of a worktree session: its dependency install, then the project's declared
 * `scripts.before`, before the session that waits on them starts.
 *
 * Local operations keep a gate on the parent; repository-authored commands get separate Host records.
 * Both persist their ownership before execution, so the worker cannot start on an incomplete tree.
 */
export interface SetupFlowDeps {
  hostGate?: Pick<HostGate, 'problemOf'>
  records: SessionRecordsStore
  setup: SessionSetupPort
  svn: Pick<SvnWorktreeManager, 'changes' | 'commitHashes' | 'assembly'>
  localBefore: LocalBeforeStep
  detach: (work: Promise<unknown>, what: string) => void
  /** The gate in front of every repository-authored command, and the second look before one runs. */
  agreement: Pick<CommandAgreement, 'declared' | 'gate' | 'agreed'>
  /** Which steps succeeded, read off the parent's history, for a gate an older build wrote without its steps. */
  scripts: Pick<SessionScriptsManager, 'succeededKeys'>
  runs: Pick<ScriptRunLauncher, 'launch'>
  launch: SetupLaunchPort
  /** Empties the reserved folder of a failed checkout before the checkout runs again. */
  worktrees: Pick<SessionWorktreePort, 'purgeReserved'>
  /** Where a fact the user has to know but cannot act on through the result goes. */
  report: (message: string) => void
  newId: () => string
  now: () => number
}

export class SetupFlow {
  private readonly hostGate: SetupFlowDeps['hostGate']
  private readonly localBefore: SetupFlowDeps['localBefore']
  private readonly detach: SetupFlowDeps['detach']
  private readonly localRuns: Map<string, Promise<void>>
  private readonly records: SessionRecordsStore
  private readonly svn: SetupFlowDeps['svn']
  private readonly setup: SessionSetupPort
  private readonly agreement: Pick<CommandAgreement, 'declared' | 'gate' | 'agreed'>
  private readonly scripts: Pick<SessionScriptsManager, 'succeededKeys'>
  private readonly runs: Pick<ScriptRunLauncher, 'launch'>
  private readonly launch: SetupLaunchPort
  private readonly worktrees: Pick<SessionWorktreePort, 'purgeReserved'>
  private readonly report: (message: string) => void
  private readonly newId: () => string
  private readonly now: () => number

  constructor(deps: SetupFlowDeps) {
    this.hostGate = deps.hostGate
    this.localRuns = new Map()
    this.localBefore = deps.localBefore
    this.detach = deps.detach
    this.records = deps.records
    this.svn = deps.svn
    this.setup = deps.setup
    this.agreement = deps.agreement
    this.scripts = deps.scripts
    this.runs = deps.runs
    this.launch = deps.launch
    this.worktrees = deps.worktrees
    this.report = deps.report
    this.newId = deps.newId
    this.now = deps.now
  }

  async createWaiting(record: SessionRecord, facts: WorktreeFacts, agreement: SessionSetupAgreement,
    checkout: (SessionRecordProcess & { cwd: string }) | null): Promise<SessionsOpResult<{ sessionId: string }>> {
    const steps = checkout === null ? undefined : [ScriptChain.processStepOf('svn', 'checkout', checkout)]
    const waiting: SessionRecord = { ...record, life: 'ended', binding: null, pendingOperationId: undefined, pendingOperationKind: undefined,
      endedAt: this.now(), endedReason: 'Setup waits for command approval',
      pendingSetup: { setupSessionId: this.newId(), agreement, ...steps === undefined ? {} : { steps, cursor: 0 } } }
    if (!await this.records.put(waiting)) return this.launch.unrecordedWorktree(facts)
    return { ok: true, value: { sessionId: record.sessionId } }
  }

  /** The parent gate is durable before execution, so a restart can recover a local step or judge its Host run. */
  async createWithSetup(
    record: SessionRecord,
    facts: WorktreeFacts,
    steps: SessionRecordScriptStep[],
  ): Promise<SessionsOpResult<{ sessionId: string }>> {
    if (steps[0] !== undefined && this.localBefore.accepts(steps[0])) {
      const setupSessionId = this.newId()
      if (!await this.records.put({ ...record, pendingSetup: { local: true, setupSessionId, steps, cursor: 0 } }))
        return this.launch.unrecordedWorktree(facts)
      this.detach(this.localRun(record.sessionId), `Before step of ${record.sessionId}`)
      return { ok: true, value: { sessionId: record.sessionId } }
    }
    const run = this.runOf(record.sessionId, steps, 0, facts.worktreePath)
    // Two writes, two different things left behind, so two different answers. The first one failing
    // is `create`'s own case: the worktree is on disk and no record names it. The second one failing
    // leaves the waiting session recorded - it names the worktree itself - and only the run missing,
    // which is the shape the ladder already reads as a setup that is gone.
    if (!await this.records.put({ ...record, pendingSetup: { setupSessionId: run.sessionId, steps, cursor: 0 } }))
      return this.launch.unrecordedWorktree(facts)
    if (!await this.records.put(run))
      return SetupFlow.unrecordedSetup(record.sessionId, facts)
    // Only the run's own record answers for its launch, exactly as every other create does. The
    // waiting session needs no special case either way: the next reconcile judges it by what the run
    // record then says.
    await this.runs.launch(run)
    return { ok: true, value: { sessionId: record.sessionId } }
  }

  async recoverLocalBefore(sessionId: string): Promise<boolean> {
    await this.localRun(sessionId, true)
    const record = this.records.get(sessionId)
    return record !== null && record.pendingSetup?.local !== true
  }

  private localRun(sessionId: string, recover = false): Promise<void> {
    const current = this.localRuns.get(sessionId)
    if (current !== undefined) return current
    const work = this.performLocalBefore(sessionId, recover).catch(async (error: unknown) => {
      await this.applyBeforeFailed(sessionId, ErrorText.of(error))
    }).finally(() => { this.localRuns.delete(sessionId) })
    this.localRuns.set(sessionId, work)
    return work
  }

  private async performLocalBefore(sessionId: string, recover: boolean): Promise<void> {
    const runId = await this.localBefore.run(sessionId, recover)
    const record = this.records.get(sessionId)
    const worktree = record?.worktree
    if (record === null || worktree === undefined || record.pendingSetup === undefined)
      throw new Error('The completed checkout lost its setup owner')
    const project = SetupFlow.setupProjectOf(record.directory, worktree)
    if (project === null) throw new Error('The completed checkout has no setup project')
    const read = await this.agreement.declared(project)
    const agreement = this.agreement.gate(project, read, undefined)
    if (agreement !== null) throw new Error(agreement.ok ? 'Setup agreement changed' : agreement.detail)
    const plan = await this.beforePlanOf(read, project, worktree.repositoryRoot, worktree.worktreePath, SetupFlow.setupScopeOf(worktree), true)
    const completed = record.pendingSetup.steps!.slice(0, (record.pendingSetup.cursor ?? 0) + 1)
    const steps = [...completed, ...plan.kind === 'run' ? plan.steps : []]
    const skipped = plan.kind === 'skip' ? plan : plan.skipped
    if (!await this.records.update(sessionId, (latest) => latest.pendingSetup === undefined ? null
      : { ...latest, setupSkipped: skipped === null ? undefined : { reason: skipped.reason },
        pendingSetup: { ...latest.pendingSetup, setupSessionId: runId, steps } }))
      throw new Error('The completed before step could not be recorded')
    await this.applyBeforeSucceeded(sessionId)
  }

  /** The run of one step of a parent's before chain, not yet written. */
  private runOf(
    parentId: string,
    steps: readonly SessionRecordScriptStep[],
    cursor: number,
    worktreePath: string,
  ): SessionRecord {
    const step = steps[cursor]
    const run = {
      runId: this.newId(),
      operationId: this.newId(),
      link: SessionScriptDefinitions.linkOf(parentId, 'before', step.scriptId, step.name, step.key),
      title: ScriptRunRecords.titleOf(step, worktreePath),
      now: this.now(),
    }
    return step.process === undefined
      ? ScriptRunRecords.shellRun({ ...run, commands: step.commands })
      : ScriptRunRecords.processRun({ ...run, process: step.process })
  }

  /**
   * What a resolution means for the worktree that has just been created: its steps as commands
   * inside that worktree, or the reason nothing installs there and whether the user has to hear it.
   *
   * `empty` is the one silence. The project declared it needs nothing, in a file that travels with
   * the repository, so saying it back on the error channel is noise; everything else is said out
   * loud, and only what a `.worktree.json` can actually answer is sent there.
   *
   * A step whose directory climbs out of the repository root is refused rather than run. Those
   * directories are `relative(repositoryRoot, projectRoot)`, so a `..` in one means the project is
   * not inside the repository git named for it - a junction, a substituted drive, a path that differs
   * in case - and joining it onto the worktree would run the install in the user's real checkout
   * instead of the copy that needs it. That is the world being strange rather than an invariant of
   * this library being broken, so it is answered rather than thrown, and it is answered the way
   * `none` is: the session is created, nothing is installed, and the reason names the step.
   */
  private static setupPlanOf(
    resolution: SetupResolution,
    worktreePath: string,
    projectRoot: string,
  ): SetupPlan {
    if (resolution.kind === 'empty')
      return {
        kind: 'skip',
        reason: 'the project declares an empty setup in .worktree.json',
        announcement: null,
      }
    else if (resolution.kind === 'none')
      return {
        kind: 'skip',
        reason: resolution.reason,
        announcement: `${SetupFlow.installedNothing(worktreePath, resolution.reason)}; the `
          + `file that decides what does is ${join(projectRoot, '.worktree.json')}`,
      }
    else if (resolution.kind === 'setup') {
      // An empty step list would be planned as a shell with no script, which is an interactive
      // terminal that never exits - and a session waiting for it would wait for ever.
      if (resolution.steps.length === 0) {
        const reason = 'the resolved setup has no steps to run'
        return {
          kind: 'skip',
          reason,
          announcement: SetupFlow.installedNothing(worktreePath, reason),
        }
      }
      const outside = resolution.steps.find((step) => SetupFlow.escapesRepository(step.cwd))
      if (outside) {
        const reason = `the step ${JSON.stringify(outside.command)} asks to run in ${
          JSON.stringify(outside.cwd)}, which is outside the repository it was resolved against`
        // Not a `.worktree.json` problem, so it is not answered with one: every step of a project
        // that sits outside its own repository escapes, whoever wrote the step.
        return {
          kind: 'skip',
          reason,
          announcement: `${SetupFlow.installedNothing(worktreePath, reason)}; ${projectRoot} `
            + 'is not inside the repository the worktree was cut from',
        }
      }
      return {
        kind: 'run',
        commands: resolution.steps.map((step) => ({
          command: step.command,
          cwd: join(worktreePath, step.cwd),
        })),
      }
    }
    else
      throw new Error(`Unknown setup resolution: ${JSON.stringify(resolution)}`)
  }

  private static installedNothing(worktreePath: string, reason: string): string {
    return `nothing was installed in the worktree ${worktreePath} (${reason})`
  }

  /** `''` is the repository root and everything under it is fine; `..` and an absolute path are not. */
  private static escapesRepository(cwd: string): boolean {
    const normalized = normalize(cwd)
    return isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${sep}`)
  }

  /**
   * The way back from a failed setup, and the only one there is: the worktree and its branch are
   * still on disk, so creating the session again over the same slug is refused as `worktree-exists`.
   *
   * It RE-RESOLVES instead of replaying the commands the run records still hold. What the user did
   * between the failure and this call is remove the cause, and the usual way to remove it is a
   * `.worktree.json` that says something different from what was resolved the first time; replaying
   * the stored commands would walk into the same wall for ever.
   *
   * The chain resumes at its first step the failed chain had not passed, so a failed `codegen` does
   * not install again; a step whose command changed is a different step and runs.
   *
   * Which is why what the fresh resolution says decides between two endings, and NEITHER of them is a
   * refusal: something to run runs again, and nothing to run starts the session that was waiting -
   * see `startWithoutSetup`. A retry that answered "nothing to run" would be the trap this method
   * exists to open, one door further along.
   */
  async retrySetup(sessionId: string, acknowledgeSetup?: string): Promise<SessionsOpResult> {
    const hostProblem = this.hostGate?.problemOf(true)
    if (hostProblem) return { ok: false, code: 'host-unreachable', detail: hostProblem }
    const record = this.records.get(sessionId)
    if (!record) return OperationOutcomes.notFound(sessionId)
    const held = await this.launch.startRefusal(record)
    if (held) return held
    // `pendingSetup` on a record that is over IS the marker of a failed setup: every path that puts a
    // runtime of its own behind the session clears it, and a live or starting session has one coming.
    if (!record.pendingSetup || (record.life !== 'ended' && record.life !== 'lost'))
      return {
        ok: false,
        code: 'invalid-spec',
        detail: `Session ${sessionId} has no failed setup to retry`,
      }
    /*
     * Every retry is a new run under a new id, so each attempt keeps its own history entry and its own
     * log, and the failed one collapses as superseded once its parent names the new one. It also means
     * a missing run record - removed from the list, or a crash between the two writes of
     * `createWithSetup` - needs nothing of its own: the waiting record is all a new run is built
     * from. Only a run that may still be running refuses it: two runs in one worktree race.
     */
    const previous = this.records.get(record.pendingSetup.setupSessionId)
    if (previous && ScriptRunPlanning.liveOrBound(previous))
      return {
        ok: false,
        code: 'live-refused',
        detail: `The setup of session ${sessionId} is still running; stop it before retrying it`,
      }
    // Both come off a file the store checks field by field and never for agreement between fields, so
    // a waiting record that names no worktree is answered rather than resolved against nothing.
    const worktree = record.worktree
    const projectRoot = worktree ? SetupFlow.setupProjectOf(record.directory, worktree) : null
    if (!worktree || projectRoot === null)
      return {
        ok: false,
        code: 'invalid-spec',
        detail: `Session ${sessionId} names no project worktree to install into`,
      }
    if (this.records.latched) return OperationOutcomes.latched()
    // The retry resolves afresh, so it would otherwise be the way around the gate: a `.worktree.json`
    // that appeared, or changed, after the create is what this asks about. It is asked rather than
    // skipped, unlike the create path's second look, because a retry is somebody deciding to run this
    // again - there is a caller here who can answer, and the fix for a refused install is often the
    // very edit that moved the hash. A damaged `scripts` key is refused here as `invalid-spec`. One
    // read answers both the question and what runs, so nothing can change the file in between.
    const read = await this.agreement.declared(projectRoot)
    const agreement = this.agreement.gate(projectRoot, read, acknowledgeSetup)
    if (agreement) {
      if (!agreement.ok && agreement.setup !== undefined)
        await this.records.put({ ...record, pendingSetup: { ...record.pendingSetup, agreement: agreement.setup } })
      return agreement
    }
    const checkedOut = record.pendingSetup.steps?.[0]?.scriptId === 'svn'
      && ScriptChain.firstDue(record.pendingSetup.steps.slice(0, 1), this.chainEvidenceOf(record)) === 1
    const plan = await this.beforePlanOf(read, projectRoot, worktree.repositoryRoot, worktree.worktreePath, SetupFlow.setupScopeOf(worktree), checkedOut)
    // The checkout is no resolution of the file: the one the chain was created with leads it again.
    const first = record.pendingSetup.steps?.[0]
    const lead = first?.scriptId === 'svn' ? [first] : []
    let steps: SessionRecordScriptStep[]
    let skipped: SetupSkip | null
    if (plan.kind === 'skip') {
      if (lead.length === 0) return this.startWithoutSetup(record, plan, plan)
      steps = lead
      skipped = plan
    }
    else if (plan.kind === 'run') {
      steps = [...lead, ...plan.steps]
      skipped = plan.skipped
    }
    else throw new Error(`Unknown before plan: ${JSON.stringify(plan satisfies never)}`)
    const cursor = ScriptChain.firstDue(steps, this.chainEvidenceOf(record))
    // Every step already succeeded: what failed was a run whose step a later attempt had passed.
    if (cursor === steps.length) return this.startWithoutSetup(record, skipped, plan.kind === 'skip' ? plan : null)
    // A failed checkout may leave half a working copy, which a second checkout cannot take.
    if (steps[cursor].scriptId === 'svn' && record.pendingSetup.local !== true) {
      const purged = await this.worktrees.purgeReserved(worktree)
      if (!purged.ok) return purged
    }
    return this.restart(record, worktree, steps, cursor, skipped)
  }

  /**
   * The steps the failed chain already passed. The cursor only moves past a step whose run exited
   * cleanly, and a retry only starts past steps that already had, so every step before it succeeded;
   * this survives any number of failures, where the capped history would lose the oldest successes.
   * A gate an older build wrote names no steps, and only the history can say anything for it.
   */
  private chainEvidenceOf(record: SessionRecord): ReadonlySet<string> {
    const gate = record.pendingSetup
    if (gate?.steps === undefined) return this.scripts.succeededKeys(record, 'before', 0)
    return new Set(gate.steps.slice(0, gate.cursor ?? 0).map((step) => step.key))
  }

  /**
   * A retry with nothing left to run is not a retry that failed: it is the session being told it may
   * start. The wait goes, the marker takes its place, and the record is left `starting` with a fresh
   * pending pair - which is exactly the shape the reconciler's own `retry-launch` rule picks up on its
   * next pass and hands to `replayLaunch`. There is no launch to write here; the one
   * `applyBeforeSucceeded` leans on is reached from this side too.
   *
   * The asymmetry with `create` is deliberate and this is the sentence that says so: at create time
   * an unresolvable setup is a session that starts anyway carrying `setupSkipped`, and at retry time
   * it is that same answer arriving late. `empty` is the project saying out loud that it needs
   * nothing and `none` is nobody knowing how, and refusing to start a session whose worktree is
   * already on disk helps nobody in either case - it only shuts the last door, since `reopen` refuses
   * the wait and a fresh create is refused the slug.
   */
  private async startWithoutSetup(
    record: SessionRecord,
    skipped: SetupSkip | null,
    announced: SetupSkip | null,
  ): Promise<SessionsOpResult> {
    if (!await this.records.put({
      ...this.rearmed(record, this.newId()),
      pendingSetup: undefined,
      setupSkipped: skipped === null ? undefined : { reason: skipped.reason },
    }))
      return OperationOutcomes.latched()
    // The result says the retry was accepted and nothing more, so what did not happen is said here,
    // for the same reason and in the same words `create` says it.
    if (announced?.announcement) this.report(`Session ${record.sessionId}: ${announced.announcement}`)
    return { ok: true, value: undefined }
  }

  /**
   * The retry: the step it resumes at is built again from what the fresh resolution says, and the
   * wait is pointed at the new run. It is the create path in the other order - the run first, the
   * session that waits for it second - because the gap between the two writes is a state a reconcile
   * pass reads: a session armed over the OLD run, still `ended` with the exit code that failed, would
   * be condemned on it, while a run that is `starting` and named by nobody yet is marked lost by the
   * orphan rule. The Host can hold nothing under an id minted a line ago.
   */
  private async restart(
    record: SessionRecord,
    worktree: SessionRecordWorktree,
    steps: SessionRecordScriptStep[],
    cursor: number,
    skipped: SetupSkip | null,
  ): Promise<SessionsOpResult> {
    if (this.localBefore.accepts(steps[cursor])) {
      if (!await this.records.put({ ...this.rearmed(record, this.newId()),
        pendingSetup: { local: true, setupSessionId: this.newId(), steps, cursor },
        setupSkipped: skipped === null ? undefined : { reason: skipped.reason } })) return OperationOutcomes.latched()
      this.detach(this.localRun(record.sessionId, true), `Retry before step of ${record.sessionId}`)
      return { ok: true, value: undefined }
    }
    const run = this.runOf(record.sessionId, steps, cursor, worktree.worktreePath)
    if (!await this.records.put(run)) return OperationOutcomes.latched()
    if (!await this.records.put({
      ...this.rearmed(record, this.newId()),
      pendingSetup: { setupSessionId: run.sessionId, steps, cursor },
      setupSkipped: skipped === null ? undefined : { reason: skipped.reason },
    }))
      return OperationOutcomes.latched()
    if (skipped?.announcement) this.report(`Session ${record.sessionId}: ${skipped.announcement}`)
    const launched = await this.runs.launch(run)
    return launched.ok || ScriptRunLauncher.replayArmed(this.records.get(run.sessionId))
      ? { ok: true, value: undefined }
      : launched
  }

  /**
   * Back to `starting` under the pending pair the caller minted; whether it is still waiting for an
   * install is the caller's word, and the reconciler reads the two together.
   *
   * The id is minted rather than taken from the record, and that is not the rule about never minting
   * over a stored id: whatever the Host may have run under the old one is the attempt that failed,
   * and answering this retry with that is the one thing it must not do. The kind is `create` because
   * what follows is a launch under an id nothing has run yet, whatever the agent's launch mode says.
   */
  private rearmed(record: SessionRecord, operationId: string): SessionRecord {
    return WorktreeCleanupPacing.relaunched({
      ...record,
      life: 'starting',
      binding: null,
      pendingOperationId: operationId,
      pendingOperationKind: 'create',
      endedAt: undefined,
      exitCode: undefined,
      endedReason: undefined,
      exitReason: undefined,
      stopRequested: undefined,
    }, this.now())
  }

  /**
   * A step of the chain exited cleanly: the next step starts, or after the last one the launch that
   * was waiting runs. A wait written before chains existed names one setup step and nothing after it.
   *
   * That launch is nothing more than the ordinary replay of the pending pair the create already
   * wrote - under the id the Host deduplicates by, never a fresh one. Minting a new id here would be a
   * second create of the same session for any Host that had already run the first.
   *
   * `pendingSetup` is cleared FIRST and the replay follows, because that is the order both crashes
   * survive. A client that dies between the two leaves an ordinary `starting` record with its
   * pending pair, which the next pass replays like any other interrupted launch. One that dies
   * before the clear finds the run still ended at 0 next pass and judges it succeeded again, which
   * costs nothing. The other order can leave a session running while its record still says it is
   * waiting for a setup that is over.
   */
  async applyBeforeSucceeded(sessionId: string): Promise<ReconcileChange | null> {
    const record = this.records.get(sessionId)
    const gate = record?.pendingSetup
    if (!record || !gate || !record.pendingOperationId || !record.pendingOperationKind)
      return null
    const next = (gate.cursor ?? 0) + 1
    if (gate.steps !== undefined && next < gate.steps.length)
      return this.startStep(record, gate.setupSessionId, gate.steps, next)
    let worktree = record.worktree
    if (worktree?.kind === 'svn') {
      try {
        const changed = await this.svn.changes(worktree.worktreePath)
        if (!changed.ok) throw new Error(changed.detail)
        const hashes = await this.svn.commitHashes(worktree.worktreePath, changed.value.map((row) => row.path))
        if (!hashes.ok) throw new Error(hashes.detail)
        const assembly = await this.svn.assembly(worktree.worktreePath)
        if (!assembly.ok) throw new Error(assembly.detail)
        const inputs = SetupInputs.of(assembly.value.nodes)
        worktree = { ...worktree, setupBaseline: { at: this.now(), hashes: hashes.value, inputs: inputs.digest, inputHashes: inputs.hashes,
          commands: SetupInputs.commands(gate.steps ?? []) } }
      }
      catch (error) {
        await this.applyBeforeFailed(sessionId, `Setup baseline could not be saved: ${ErrorText.of(error)}`)
        return null
      }
    }
    if (!await this.records.put({ ...record, worktree, pendingSetup: undefined })) return null
    return this.launch.replayLaunch({
      kind: 'retry-launch',
      sessionId,
      operationId: record.pendingOperationId,
      operation: record.pendingOperationKind,
    })
  }

  /**
   * The next step: run first, gate second, launch third, the order `restart` keeps for crash safety.
   * A client that dies after the run's write leaves it named by nobody, so the orphan rule marks it
   * lost, the step before it is judged succeeded once more, and exactly one new run is launched.
   */
  private async startStep(
    parent: SessionRecord,
    judgedRunId: string,
    steps: SessionRecordScriptStep[],
    cursor: number,
  ): Promise<ReconcileChange | null> {
    const worktreePath = parent.worktree?.worktreePath ?? steps[cursor].process?.cwd ?? steps[cursor].commands[0].cwd
    const run = this.runOf(parent.sessionId, steps, cursor, worktreePath)
    if (!await this.records.put(run)) return null
    const advanced = await this.records.update(parent.sessionId, (current) =>
      current.pendingSetup?.setupSessionId === judgedRunId
        ? { ...current, pendingSetup: { setupSessionId: run.sessionId, steps, cursor } }
        : null)
    if (!advanced) return null
    await this.runs.launch(run)
    return { kind: 'script-succeeded', sessionId: parent.sessionId, gate: 'before' }
  }

  /**
   * The session ends where it stands, never having run. The worktree and the branch the create made
   * for it stay and are NAMED, the way `remove` names what it leaves behind: what is on disk is a
   * directory a user may want, and a retry needs it exactly where it is.
   *
   * `pendingSetup` deliberately stays on the ended record. It is the link to the run whose terminal
   * holds what actually went wrong, and the only marker a retry has to work from; the reconciler
   * skips ended records, so it decides nothing there ever again. `endedReason` says the session
   * never ran, which is what lets the cleanup of a `removeWhenEnded` worktree judge it.
   */
  async applyBeforeFailed(sessionId: string, reason: string): Promise<boolean> {
    const record = this.records.get(sessionId)
    const gate = record?.pendingSetup
    if (!record || !gate || record.life === 'ended') return false
    const done = await this.records.put({
      ...record,
      life: 'ended',
      binding: null,
      pendingOperationId: undefined,
      pendingOperationKind: undefined,
      endedAt: this.now(),
      endedReason: `setup failed: ${reason}`,
    })
    const failed = SetupFlow.failedStepOf(gate.steps?.[gate.cursor ?? 0])
    if (done && record.worktree)
      this.report(
        `Session ${sessionId}: ${failed} failed (${reason}); `
        + `${OperationOutcomes.leftBehindOf(record.worktree)} for a retry or for you to remove`,
      )
    return done
  }

  /** What failed, as the report names it; a gate an older build wrote names no step and was the setup. */
  private static failedStepOf(step: SessionRecordScriptStep | undefined): string {
    if (step === undefined) return 'the setup'
    const scriptId = step.scriptId
    switch (scriptId) {
      case 'setup': return 'the setup'
      case 'declared': return `the before script ${step.name}`
      case 'svn': return 'the checkout'
      case 'checks': throw new Error('A check of an SVN action never runs before its session')
      default: throw new Error(`Unknown chain step: ${JSON.stringify(scriptId satisfies never)}`)
    }
  }

  /**
   * The chain a worktree runs before its session starts, and the second look at the agreement that
   * goes with it. Both come from the main copy's `.worktree.json`, never the worktree's own copy, so
   * an agent cannot author the commands that run outside its sandbox.
   *
   * The gate read `.worktree.json` before the worktree was cut and this reads it again to resolve it,
   * so the file has had a moment in which to change. Asking once more, over the very read the steps
   * are built from, is what stops that moment from being the way in: what runs is only ever a command
   * list this machine agreed to. A mismatch is not a refusal here - the worktree already exists - but
   * a skip, which is the same answer the session gets for a project that declares nothing. The look
   * covers every command the file declares, so a machine install is skipped too when the file beside
   * it moved: the chain runs whole or not at all.
   */
  async beforePlanFor(
    projectRoot: string,
    repositoryRoot: string,
    worktreePath: string,
    scope?: SetupScope,
    checkedOut = false,
  ): Promise<BeforePlan> {
    return this.beforePlanOf(await this.agreement.declared(projectRoot), projectRoot, repositoryRoot, worktreePath, scope, checkedOut)
  }

  /** The digest of the setup a worktree runs now, and its dependency install alone, which a Finish may run again. */
  async environmentOf(record: SessionRecord, read: DeclaredCommandsRead): Promise<{ commands: string; install?: SessionRecordScriptStep } | undefined> {
    const worktree = record.worktree
    if (worktree === undefined) return undefined
    const project = SetupFlow.setupProjectOf(record.directory, worktree)
    if (project === null) return undefined
    const plan = await this.beforePlanOf(read, project, worktree.repositoryRoot, worktree.worktreePath, SetupFlow.setupScopeOf(worktree), true)
    if (plan.kind === 'skip') return undefined
    else if (plan.kind === 'run') {
      const commands = SetupInputs.commands(plan.steps), install = plan.steps.find((step) => step.scriptId === 'setup')
      return commands === undefined ? undefined : { commands, ...install === undefined ? {} : { install } }
    }
    else throw new Error(`Unknown before plan: ${JSON.stringify(plan satisfies never)}`)
  }

  private async beforePlanOf(
    read: DeclaredCommandsRead,
    projectRoot: string,
    repositoryRoot: string,
    worktreePath: string,
    scope?: SetupScope,
    checkedOut = false,
  ): Promise<BeforePlan> {
    if (read.kind === 'read') return this.beforePlanOfRead(read, projectRoot, repositoryRoot, worktreePath, scope, checkedOut)
    // Nothing of a file that cannot be read, or whose scripts nobody can be shown, runs; not even a
    // machine install, since the file is the project's word on what replaces it.
    else if (read.kind === 'unreadable' || read.kind === 'damaged') return SetupFlow.skipOf(worktreePath, read.problem)
    else throw new Error(`Unknown declared commands read: ${JSON.stringify(read satisfies never)}`)
  }

  private async beforePlanOfRead(
    read: Extract<DeclaredCommandsRead, { kind: 'read' }>,
    projectRoot: string,
    repositoryRoot: string,
    worktreePath: string,
    scope?: SetupScope,
    checkedOut = false,
  ): Promise<BeforePlan> {
    const projectPath = SetupPaths.relativeOf(repositoryRoot, projectRoot)
    if (projectPath === null) return SetupFlow.skipOf(worktreePath, 'The setup project is outside its repository')
    const resolution = await this.setup.resolve(checkedOut ? join(worktreePath, projectPath) : projectRoot,
      checkedOut ? worktreePath : repositoryRoot, read.config, scope)
    const declared = read.value?.scripts.before ?? []
    const runsAnything = resolution.kind === 'setup' || declared.length > 0
    if (runsAnything && !this.agreement.agreed(projectRoot, read)) {
      // Two ways to arrive here and one sentence for both: the file changed after the gate agreed
      // to it, or a retry met commands that were never put in front of anybody.
      const reason = `${join(projectRoot, '.worktree.json')} declares commands this machine has `
        + 'not agreed to run'
      return SetupFlow.skipOf(worktreePath, reason)
    }
    const setup = SetupFlow.setupPlanOf(resolution, worktreePath, projectRoot)
    const before = DeclaredScripts.stepsOf(declared, { projectRoot, repositoryRoot, worktreePath })
    if (!before.ok) return SetupFlow.skipOf(worktreePath, before.problem)
    if (setup.kind === 'run')
      return { kind: 'run', steps: [SetupFlow.setupStepOf(setup.commands), ...before.steps], skipped: null }
    else if (setup.kind === 'skip')
      // A skipped setup with declared steps still runs them, and keeps saying why nothing installed.
      return before.steps.length === 0 ? setup : { kind: 'run', steps: before.steps, skipped: setup }
    else throw new Error(`Unknown setup plan: ${JSON.stringify(setup satisfies never)}`)
  }

  private static setupStepOf(commands: SessionRecordSetupCommand[]): SessionRecordScriptStep {
    return {
      key: ScriptChain.keyOf({ scriptId: 'setup', name: 'setup', commands }),
      scriptId: 'setup',
      name: 'setup',
      commands,
    }
  }

  private static skipOf(worktreePath: string, reason: string): SetupSkip {
    return { kind: 'skip', reason, announcement: SetupFlow.installedNothing(worktreePath, reason) }
  }

  /**
   * The gate in front of a repository's own commands, and the only thing between a clone somebody
   * dropped into a category root and a shell running what its `.worktree.json` says.
   *
   * Answers a refusal to be returned, or null to carry on. Three ways to carry on: the session asks
   * for no worktree at all, the project declares nothing of its own - the detected tiers are this
   * machine's own answers and are not foreign - or this machine has already agreed to exactly these
   * commands. The agreement travels back in the spec, so the answer belongs to the person who was
   * shown the commands rather than to a flag somebody could set without ever seeing them.
   */
  async setupAgreement(
    spec: SessionCreateSpec,
    placement: WorktreePlacement | null,
  ): Promise<SessionsOpResult<never> | null> {
    if (!spec.worktree || placement === null) return null
    const projectRoot = placement.ownerDir
    return this.agreement.gate(projectRoot, await this.agreement.declared(projectRoot), spec.acknowledgeSetup)
  }

  /**
   * Whose `.worktree.json` and dependencies a worktree installs, or null. A Git worktree copies the
   * whole repository, so the catalog project inside it decides. An SVN worktree checks out its
   * owner - a product group, a catalog project or an ad-hoc directory - and only the owner is there
   * to install.
   */
  static setupProjectOf(directory: SessionDirectoryRef, worktree: SessionRecordWorktree): string | null {
    const kind = worktree.kind ?? 'git'
    if (kind === 'git') return directory.mode === 'project' ? directory.projectPath : null
    else if (kind === 'svn') return worktree.repositoryRoot
    else throw new Error(`Unknown worktree kind: ${JSON.stringify(kind satisfies never)}`)
  }

  static setupScopeOf(worktree: SessionRecordWorktree): SetupScope {
    if (worktree.setupScope !== undefined) return worktree.setupScope
    // Old group checkouts retain member setup even after the main-copy marker is migrated.
    const kind = worktree.kind ?? 'git'
    if (kind === 'git') return 'project'
    else if (kind === 'svn')
      return existsSync(join(worktree.repositoryRoot, ProductGroup.markerConst)) ? 'members' : 'project'
    else throw new Error(`Unknown worktree kind: ${kind satisfies never}`)
  }

  /**
   * The waiting session was recorded and the install it waits for was not. Nothing is orphaned here
   * - that record names the worktree - so this only has to be true about where the session stands,
   * and where it stands is where a setup that failed leaves it: the missing setup record is what
   * `setupJudgement` reads as `its setup session record is gone`, which ends the session naming the
   * worktree, and `retrySetup` mints the install afresh from there. All of it waits on the file
   * becoming writable again, which is the one thing this call can do nothing about.
   */
  private static unrecordedSetup(
    sessionId: string,
    facts: WorktreeFacts,
  ): { ok: false; code: SessionsOpErrorCode; detail: string } {
    return {
      ok: false,
      code: 'records-latched',
      detail: `Session ${sessionId} was recorded in the worktree ${facts.worktreePath}, but the `
        + 'install it waits for could not be written, so nothing will install there; once the '
        + 'session records can be written again a reconcile pass ends the session for the missing '
        + 'install and retrySetup runs it again. Why the write failed is on the error channel',
    }
  }
}
