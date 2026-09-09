import { basename, isAbsolute, join, normalize, sep } from 'node:path'

import type {
  RuntimeLaunchSpec,
  RuntimeResult,
} from '../../../app-host/app/wire/hostWire.js'
import type { WorktreeFacts } from '../../git/git.types'
import type { HostCallResult } from '../../hostClient/hostClient.types'
import { LaunchPlanner } from '../launch/launchPlanner'
import type {
  SessionRecord,
  SessionRecordSetupCommand,
  SessionRecordWorktree,
} from '../records/sessionRecord.types'
import type { ReconcileChange } from './reconciler'
import type { SessionRecordsStore } from '../records/sessionRecordsStore'
import type {
  SessionCreateSpec,
  SessionsOpErrorCode,
  SessionsOpResult,
} from '../sessionManagerApi.types'
import type { DeclaredSetup, SetupResolution } from '../../projectSetup/projectSetup.types'
import type {
  ReopenRoute,
  SessionHostPort,
  SessionSetupPort,
  SetupPlan,
} from './sessionLifecycle'
import { OperationOutcomes } from './operationOutcomes'

/**
 * What the lifecycle around this flow does for it, kept narrow so the flow never sees the whole
 * class. Every one is about a RECORD reaching the Host and what is written down when it does, which
 * is the one thing an install shares with every other session: an install IS a session, with a
 * script where the prompt would be.
 */
export interface SetupLaunchPort {
  plannedLaunch(record: SessionRecord, launch: 'create' | 'reopen'): RuntimeLaunchSpec
  bindLive(record: SessionRecord, result: RuntimeResult): Promise<boolean>
  endRefused(record: SessionRecord, detail: string): Promise<void>
  replayLaunch(
    change: Extract<ReconcileChange, { kind: 'retry-launch' }>,
  ): Promise<ReconcileChange | null>
  hostRouteOf(sessionId: string): Promise<SessionsOpResult<ReopenRoute>>
  unrecordedWorktree(
    facts: WorktreeFacts,
  ): { ok: false; code: SessionsOpErrorCode; detail: string }
}

/**
 * Installing a worktree's dependencies before the session that waits on them starts.
 *
 * An install runs as a session of its own - a shell with a script instead of a prompt - and the
 * session that needs it waits, recorded, naming the setup by id. That is what makes every step here
 * a record write plus a launch rather than a process this class babysits: a client that dies mid
 * install leaves a record saying what was being attempted, and the next reconcile pass judges it.
 *
 * Carved out of `SessionLifecycle`, which held it as ~450 lines and seventeen members beside the
 * session operations and the reconcile applier, and whose job could not be stated without three
 * "and"s. It follows `WorktreeMergeFlow`, carved out of the same file the same way: narrow deps, its
 * own record fields, its own phase writes, and one port back for what only the lifecycle can do.
 */
export interface SetupFlowDeps {
  records: SessionRecordsStore
  host: SessionHostPort
  setup: SessionSetupPort
  launch: SetupLaunchPort
  /** Where a fact the user has to know but cannot act on through the result goes. */
  report: (message: string) => void
  newId: () => string
  now: () => number
}

export class SetupFlow {
  private readonly records: SessionRecordsStore
  private readonly host: SessionHostPort
  private readonly setup: SessionSetupPort
  private readonly launch: SetupLaunchPort
  private readonly report: (message: string) => void
  private readonly newId: () => string
  private readonly now: () => number

  constructor(deps: SetupFlowDeps) {
    this.records = deps.records
    this.host = deps.host
    this.setup = deps.setup
    this.launch = deps.launch
    this.report = deps.report
    this.newId = deps.newId
    this.now = deps.now
  }

  /**
   * Two records and ONE runtime: the session's own launch is not started here at all. It waits on
   * disk under the pending pair its record was already written with, named by `pendingSetup`, until a
   * reconcile pass sees the install exit cleanly - so the caller is handed the session's id the
   * moment both records are written, however long the install takes.
   *
   * The waiting record is written before the install is launched, for the same reason every launch
   * here writes its record first: a client that dies while the Host is installing must leave
   * something on disk that says what that install belongs to.
   *
   * The setup is an ordinary shell session, which is what makes it visible in the list, attachable
   * while it runs and readable after it fails, with no infrastructure of its own.
   */
  async createWithSetup(
    record: SessionRecord,
    facts: WorktreeFacts,
    commands: SessionRecordSetupCommand[],
  ): Promise<SessionsOpResult<{ sessionId: string }>> {
    const setupSessionId = this.newId()
    const operationId = this.newId()
    const setupRecord = this.setupRecordOf(
      setupSessionId,
      record.sessionId,
      operationId,
      facts,
      commands,
    )
    // Two writes, two different things left behind, so two different answers. The first one failing
    // is `create`'s own case: the worktree is on disk and no record names it. The second one failing
    // leaves the waiting session recorded - it names the worktree itself - and only the install
    // missing, which is the shape `setupJudgement` already reads as a setup that is gone.
    if (!await this.records.put({ ...record, pendingSetup: { setupSessionId } }))
      return this.launch.unrecordedWorktree(facts)
    if (!await this.records.put(setupRecord))
      return SetupFlow.unrecordedSetup(record.sessionId, facts)
    const created = await this.host.runtimeCreate({
      operationId,
      runtimeSessionId: setupSessionId,
      launch: this.launch.plannedLaunch(setupRecord, 'create'),
    })
    // Only the setup's own record answers for the setup's launch, exactly as every other create does:
    // a refusal the Host DECIDED ends it, anything undecided leaves its pending pair for the replay.
    // The waiting session needs no special case either way - the next reconcile judges it by what the
    // setup record then says, which is what it would do for an install that had run and failed.
    if (created.ok) await this.launch.bindLive(setupRecord, created.value)
    else if (OperationOutcomes.decided(created)) await this.launch.endRefused(setupRecord, created.detail)
    return { ok: true, value: { sessionId: record.sessionId } }
  }

  /**
   * The install as a shell session with a script instead of a prompt.
   *
   * It carries NO `worktree` field although it runs inside one, and that is the point of writing it
   * by hand: `LaunchPlanner.cwdOf` prefers a record's worktree path over its directory, so the field
   * would silently move a step that asked for a directory inside the worktree - a pnpm workspace root
   * above the project, say - back to the top of it. The directory is the first step's own, and every
   * step cd's to its own anyway.
   */
  private setupRecordOf(
    setupSessionId: string,
    forSessionId: string,
    operationId: string,
    facts: WorktreeFacts,
    commands: SessionRecordSetupCommand[],
  ): SessionRecord {
    return {
      sessionId: setupSessionId,
      kind: 'shell',
      title: `Setup ${basename(facts.worktreePath)}`,
      directory: { mode: 'adHoc', path: commands[0].cwd },
      commands,
      setupFor: forSessionId,
      binding: null,
      life: 'starting',
      pendingOperationId: operationId,
      pendingOperationKind: 'create',
      createdAt: this.now(),
    }
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
   * It RE-RESOLVES instead of replaying the commands the setup record still holds. What the user did
   * between the failure and this call is remove the cause, and the usual way to remove it is a
   * `.worktree.json` that says something different from what was resolved the first time; replaying
   * the stored commands would walk into the same wall for ever.
   *
   * Which is why what the fresh resolution says decides between two endings, and NEITHER of them is a
   * refusal: something to install runs again, and nothing to install starts the session that was
   * waiting - see `startWithoutSetup`. A retry that answered "nothing to run" would be the trap this
   * method exists to open, one door further along.
   */
  async retrySetup(sessionId: string, acknowledgeSetup?: string): Promise<SessionsOpResult> {
    const record = this.records.get(sessionId)
    if (!record) return OperationOutcomes.notFound(sessionId)
    // `pendingSetup` on a record that is over IS the marker of a failed setup: every path that puts a
    // runtime of its own behind the session clears it, and a live or starting session has one coming.
    if (!record.pendingSetup || (record.life !== 'ended' && record.life !== 'lost'))
      return {
        ok: false,
        code: 'invalid-spec',
        detail: `Session ${sessionId} has no failed setup to retry`,
      }
    /*
     * A setup record that is no longer there is minted afresh rather than refused, and the record
     * that waits is all it takes: `setupRecordOf` asks for the worktree, the session it prepares and
     * the commands, and the fresh resolution below answers the last of those. Removing the dead
     * install from the list - or a crash between the two writes `createWithSetup` makes - would
     * otherwise leave the session with every door shut at once: `reopen` refuses it for the wait, a
     * fresh create is refused the slug its worktree already took, and this was the third refusal.
     */
    const setupRecord = this.records.get(record.pendingSetup.setupSessionId)
    // Both come off a file the store checks field by field and never for agreement between fields, so
    // a waiting record that names no worktree is answered rather than resolved against nothing.
    const worktree = record.worktree
    const projectRoot = record.directory.mode === 'project' ? record.directory.projectPath : null
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
    // very edit that moved the hash.
    const agreement = await this.setupAgreementFor(projectRoot, acknowledgeSetup)
    if (agreement) return agreement
    const plan = await this.setupPlanFor(projectRoot, worktree.repositoryRoot, worktree.worktreePath)
    if (plan.kind === 'skip') return this.startWithoutSetup(record, plan)
    else if (plan.kind === 'run')
      return setupRecord
        ? this.rearmSetup(record, setupRecord, plan.commands)
        : this.mintSetup(record, worktree, plan.commands)
    else throw new Error(`Unknown setup plan: ${JSON.stringify(plan)}`)
  }

  /**
   * A retry that resolves to nothing to install is not a retry that failed: it is the session being
   * told it may start. The wait goes, the marker takes its place, and the record is left `starting`
   * with a fresh pending pair - which is exactly the shape the reconciler's own `retry-launch` rule
   * picks up on its next pass and hands to `replayLaunch`. There is no launch to write here; the one
   * `applySetupSucceeded` leans on is reached from this side too.
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
    plan: Extract<SetupPlan, { kind: 'skip' }>,
  ): Promise<SessionsOpResult> {
    if (!await this.records.put({
      ...this.rearmed(record, this.newId()),
      pendingSetup: undefined,
      setupSkipped: { reason: plan.reason },
    }))
      return OperationOutcomes.latched()
    // The result says the retry was accepted and nothing more, so what did not happen is said here,
    // for the same reason and in the same words `create` says it.
    if (plan.announcement !== null) this.report(`Session ${record.sessionId}: ${plan.announcement}`)
    return { ok: true, value: undefined }
  }

  /**
   * The setup record takes the fresh commands AND a launch of its own BEFORE the waiting session is
   * armed, because the gap between the two writes is a state a reconcile pass reads. A session armed
   * over a setup record that still says `ended` with the exit code that failed is condemned on that
   * old exit code: the retry is thrown away without a word, and `endedReason` then names a run that
   * no longer matches the commands on disk. A setup that is `starting` and names a launch to replay
   * is exactly what `setupJudgement` waits for, so a crash anywhere in here is finished by the next
   * pass rather than judged by it.
   *
   * What the Host has is asked BEFORE either write, so a Host that cannot answer - or one still
   * running the install - leaves both records exactly as the failure left them, with the retry still
   * there to be asked for again.
   */
  private async rearmSetup(
    record: SessionRecord,
    setupRecord: SessionRecord,
    commands: SessionRecordSetupCommand[],
  ): Promise<SessionsOpResult> {
    const routed = await this.launch.hostRouteOf(setupRecord.sessionId)
    if (!routed.ok) return routed
    const route = routed.value
    if (route.kind === 'live')
      return {
        ok: false,
        code: 'live-refused',
        detail: `The setup of session ${record.sessionId} is still running; stop it before retrying it`,
      }
    // Minted rather than reused: the id the failed install ran under is in the Host's own operation
    // ledger, and replaying it would be answered with that dead runtime instead of installing again.
    const operationId = this.newId()
    const armed: SessionRecord = {
      ...this.rearmed(setupRecord, operationId),
      commands,
      directory: { mode: 'adHoc', path: commands[0].cwd },
    }
    if (!await this.records.put(armed)) return OperationOutcomes.latched()
    if (!await this.records.put(this.rearmed(record, this.newId())))
      return OperationOutcomes.latched()
    return this.launchSetup(armed, route, operationId)
  }

  /**
   * The retry for a session whose setup record is gone: the install is built again from what the
   * waiting record itself says, and the wait is pointed at the new one. It is the create path in the
   * other order - the install first, the session that waits for it second - for the same reason
   * `rearmSetup` uses that order, and the Host can hold nothing under an id minted a line ago.
   */
  private async mintSetup(
    record: SessionRecord,
    worktree: SessionRecordWorktree,
    commands: SessionRecordSetupCommand[],
  ): Promise<SessionsOpResult> {
    const setupSessionId = this.newId()
    const operationId = this.newId()
    const setupRecord = this.setupRecordOf(
      setupSessionId,
      record.sessionId,
      operationId,
      worktree,
      commands,
    )
    if (!await this.records.put(setupRecord)) return OperationOutcomes.latched()
    if (!await this.records.put({
      ...this.rearmed(record, this.newId()),
      pendingSetup: { setupSessionId },
    }))
      return OperationOutcomes.latched()
    return this.launchSetup(setupRecord, { kind: 'create' }, operationId)
  }

  /**
   * The armed install is put back on the Host the way `reopen` puts any record back - a replace where
   * the Host still holds the dead runtime, a create where it holds nothing. It is NOT `reopen`
   * itself, and that is the whole point: the record is deliberately already `starting` under the pair
   * this call carries, which is the shape `reopen` refuses and the shape a crash here leaves behind
   * for the reconciler to finish.
   */
  private async launchSetup(
    armed: SessionRecord,
    route: Exclude<ReopenRoute, { kind: 'live' }>,
    operationId: string,
  ): Promise<SessionsOpResult> {
    const launch = this.launch.plannedLaunch(armed, 'reopen')
    let result: HostCallResult<RuntimeResult>
    if (route.kind === 'replace')
      result = await this.host.runtimeReplace({ target: route.target, operationId, launch })
    else if (route.kind === 'create')
      result = await this.host.runtimeCreate({
        operationId,
        runtimeSessionId: armed.sessionId,
        launch,
      })
    else
      throw new Error(`Unknown reopen route: ${JSON.stringify(route)}`)
    if (!result.ok) {
      // Exactly what a refused install at create time does: a decision ends the setup record carrying
      // the Host's words, and the next pass condemns the waiting session with them. Anything
      // undecided keeps the pending pair, which is what the reconciler replays under the same id.
      if (OperationOutcomes.decided(result)) await this.launch.endRefused(armed, result.detail)
      return OperationOutcomes.failureOf(result)
    }
    await this.launch.bindLive(armed, result.value)
    return { ok: true, value: undefined }
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
    return {
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
    }
  }

  /**
   * The install was only ever preparing the session that is going away.
   *
   * Where it has a runtime, that runtime is stopped and the Host's own exit event ends the record
   * like any other. Where it has none - `starting` and unbound, which is what a Host that never
   * answered the install's create leaves behind - stopping reaches nothing, and the pending pair
   * would make the next reconcile pass START it: `pnpm install` running in a worktree that belongs to
   * no session at all. So the pair goes and the record ends here instead, saying why.
   */
  async stopSetup(setupSessionId: string): Promise<void> {
    const setup = this.records.get(setupSessionId)
    if (!setup) return
    const target = OperationOutcomes.targetOf(setup)
    if (target) {
      // The record this stop is for is already gone by the time this runs, so nothing will ever
      // judge that install again: a refusal here - an unreachable Host, a lost lease, a 409 - leaves
      // `pnpm install` running in a worktree that belongs to no session, and used to leave it
      // silently, because this was the one Host call in this file whose answer was dropped.
      const stopped = await this.host.runtimeStop(target)
      if (!stopped.ok)
        this.report(
          `The install ${setupSessionId} could not be stopped (${stopped.code}: ${stopped.detail}); `
          + `it may still be running in ${LaunchPlanner.cwdOf(setup)}`,
        )
      return
    }
    if (setup.pendingOperationId === undefined && setup.pendingOperationKind === undefined) return
    await this.records.put({
      ...setup,
      life: 'ended',
      pendingOperationId: undefined,
      pendingOperationKind: undefined,
      endedAt: this.now(),
      endedReason: 'the session it was installing for was removed before the Host answered its launch',
    })
  }

  /**
   * The install is done, so the launch that was waiting for it is nothing more than the ordinary
   * replay of the pending pair the create already wrote - under the id the Host deduplicates by,
   * never a fresh one. Minting a new id here would be a second create of the same session for any
   * Host that had already run the first.
   *
   * `pendingSetup` is cleared FIRST and the replay follows, because that is the order both crashes
   * survive. A client that dies between the two leaves an ordinary `starting` record with its
   * pending pair, which the next pass replays like any other interrupted launch. One that dies
   * before the clear finds the setup still ended at 0 next pass and judges it succeeded again, which
   * costs nothing. The other order can leave a session running while its record still says it is
   * waiting for a setup that is over.
   */
  async applySetupSucceeded(sessionId: string): Promise<ReconcileChange | null> {
    const record = this.records.get(sessionId)
    if (!record?.pendingSetup || !record.pendingOperationId || !record.pendingOperationKind)
      return null
    if (!await this.records.put({ ...record, pendingSetup: undefined })) return null
    return this.launch.replayLaunch({
      kind: 'retry-launch',
      sessionId,
      operationId: record.pendingOperationId,
      operation: record.pendingOperationKind,
    })
  }

  /**
   * The session ends where it stands, never having run. The worktree and the branch the create made
   * for it stay and are NAMED, the way `remove` names what it leaves behind: what is on disk is a
   * directory a user may want, and a retry needs it exactly where it is.
   *
   * `pendingSetup` deliberately stays on the ended record. It is the link to the setup session whose
   * terminal holds what actually went wrong, and the only marker a retry has to work from; the
   * reconciler skips ended records, so it decides nothing there ever again.
   */
  async applySetupFailed(sessionId: string, reason: string): Promise<boolean> {
    const record = this.records.get(sessionId)
    if (!record?.pendingSetup || record.life === 'ended') return false
    const done = await this.records.put({
      ...record,
      life: 'ended',
      binding: null,
      pendingOperationId: undefined,
      pendingOperationKind: undefined,
      endedAt: this.now(),
      endedReason: `setup failed: ${reason}`,
    })
    if (done && record.worktree)
      this.report(
        `Session ${sessionId}: the setup failed (${reason}); its worktree `
        + `${record.worktree.worktreePath} and the branch ${record.worktree.branch} are left in `
        + `${record.worktree.repositoryRoot} for a retry or for you to remove`,
      )
    return done
  }

  /**
   * The resolution, and the second look at the agreement that goes with it.
   *
   * The gate read `.worktree.json` before the worktree was cut and this reads it again to resolve it,
   * so the file has had a moment in which to change. Asking once more is what stops that moment from
   * being the way in: what runs is only ever a command list this machine agreed to. A mismatch is not
   * a refusal here - the worktree already exists - but a skip, which is the same answer the session
   * gets for a project that declares nothing.
   */
  async setupPlanFor(
    projectRoot: string,
    repositoryRoot: string,
    worktreePath: string,
  ): Promise<SetupPlan> {
    const resolution = await this.setup.resolve(projectRoot, repositoryRoot)
    if (resolution.kind === 'setup' && resolution.origin === 'project') {
      const declared = await this.setup.declaredSetup(projectRoot)
      if (!declared?.acknowledged) {
        // Two ways to arrive here and one sentence for both: the file changed after the gate agreed
        // to it, or a retry met a setup that was never put in front of anybody.
        const reason = `${join(projectRoot, '.worktree.json')} declares a setup this machine has `
          + 'not agreed to run'
        return {
          kind: 'skip',
          reason,
          announcement: SetupFlow.installedNothing(worktreePath, reason),
        }
      }
    }
    return SetupFlow.setupPlanOf(resolution, worktreePath, projectRoot)
  }

  /**
   * The gate in front of a repository's own `setup`, and the only thing between a clone somebody
   * dropped into a category root and a shell running what its `.worktree.json` says.
   *
   * Answers a refusal to be returned, or null to carry on. Three ways to carry on: the session asks
   * for no worktree at all, the project declares no setup of its own - the detected tiers are this
   * machine's own answers and are not foreign - or this machine has already agreed to exactly these
   * commands. The agreement travels back in the spec, so the answer belongs to the person who was
   * shown the commands rather than to a flag somebody could set without ever seeing them.
   */
  async setupAgreement(
    spec: SessionCreateSpec,
  ): Promise<SessionsOpResult<never> | null> {
    if (!spec.worktree) return null
    return this.setupAgreementFor(
      OperationOutcomes.projectRootOf(spec.directory),
      spec.acknowledgeSetup,
    )
  }

  /** The same question for the retry, which resolves afresh and can be answered by its caller too. */
  private async setupAgreementFor(
    projectRoot: string,
    acknowledgeSetup: string | undefined,
  ): Promise<SessionsOpResult<never> | null> {
    const declared = await this.setup.declaredSetup(projectRoot)
    if (!declared || declared.acknowledged) return null
    if (acknowledgeSetup === declared.hash) {
      this.setup.acknowledgeSetup(projectRoot, declared.hash)
      return null
    }
    return SetupFlow.setupRefusal(projectRoot, declared)
  }

  private static setupRefusal(
    projectRoot: string,
    declared: DeclaredSetup,
  ): SessionsOpResult<never> {
    return {
      ok: false,
      code: 'setup-not-acknowledged',
      detail: `${join(projectRoot, '.worktree.json')} asks to run ${declared.commands.length} `
        + `command${declared.commands.length === 1 ? '' : 's'} in a fresh worktree, and this machine `
        + 'has not agreed to them',
      setup: { commands: declared.commands, hash: declared.hash },
    }
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
