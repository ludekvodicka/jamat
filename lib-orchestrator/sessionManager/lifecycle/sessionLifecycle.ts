import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

import type {
  RuntimeLaunchSpec,
  RuntimeListResult,
  RuntimeMutationAck,
  RuntimeRef,
  RuntimeResult,
  RuntimeSessionInfo,
} from '../../../app-host/app/wire/hostWire.js'
import type { GitResult, WorktreeFacts } from '../../git/git.types'
import type {
  HostCallFailure,
  HostCallResult,
} from '../../hostClient/hostClient.types'
import type { DeclaredSetup, SetupResolution } from '../../projectSetup/projectSetup.types'
import type { CodexRolloutMatch } from '../../projectManager/codexRolloutView'
import { AgentPresets, type SessionAgentSpec } from '../launch/agentPresets'
import { ClaudeTrustSeed, type ClaudeTrustSeedResult } from '../launch/claudeTrustSeed'
import { CodexIdCapture } from '../launch/codexIdCapture'
import { GitCodes } from './gitCodes'
import { SetupFlow } from './setupFlow'
import { OperationOutcomes } from './operationOutcomes'
import { LaunchPlanner, type LaunchPlanOptions } from '../launch/launchPlanner'
import type {
  SessionRecord,
  SessionRecordAgent,
  SessionRecordSetupCommand,
} from '../records/sessionRecord.types'
import { SessionColors } from '../records/sessionColors'
import { SessionLimits } from '../sessionLimits'
import { SessionOutcomes } from '../records/sessionOutcomes'
import type { SessionRecordsStore } from '../records/sessionRecordsStore'
import { SessionTitle } from '../records/sessionTitle'
import type {
  SessionAgentId,
  SessionColorName,
  SessionCreateSpec,
  SessionDetailsSaved,
  SessionDetailsUpdate,
  SessionHistoryOpenSpec,
  SessionHistoryReference,
  SessionTitleParts,
  SessionsOpErrorCode,
  SessionsOpResult,
} from '../sessionManagerApi.types'
import { LaunchBackoff } from './launchBackoff'
import { Reconciler, type ReconcileChange } from './reconciler'

/** What this class asks of the Host: five operations, all of them answering with a value. */
export interface SessionHostPort {
  runtimeCreate(request: {
    operationId: string
    runtimeSessionId: string
    launch: RuntimeLaunchSpec
  }): Promise<HostCallResult<RuntimeResult>>
  runtimeReplace(request: {
    target: RuntimeRef
    operationId: string
    launch: RuntimeLaunchSpec
  }): Promise<HostCallResult<RuntimeResult>>
  runtimeList(): Promise<HostCallResult<RuntimeListResult>>
  runtimeStop(target: RuntimeRef): Promise<HostCallResult<RuntimeMutationAck>>
  runtimeRemove(target: RuntimeRef): Promise<HostCallResult<RuntimeMutationAck>>
}

/**
 * The one thing a session wants from git. Tearing a worktree down is deliberately not on it: the
 * teardown is `worktree remove --force` together with `branch -d`, both under a user who has said
 * what should happen to the work inside, and that belongs to `WorktreeMergeFlow` rather than to a
 * record being deleted. What `remove` does instead is SAY what it leaves - see there.
 */
export interface SessionWorktreePort {
  create(
    repositoryRoot: string,
    slug: string,
    baseRef?: string,
  ): Promise<GitResult<WorktreeFacts>>
}

/**
 * The one thing a session wants from the project setup member: what installs this project, read in
 * the main copy and answered as repository-relative steps. It runs nothing and it decides nothing
 * about sessions - the install is a session of its own, on the Host, like everything else here that
 * takes time.
 */
export interface SessionSetupPort {
  resolve(projectRoot: string, repositoryRoot: string): Promise<SetupResolution>
  /**
   * What the project declares on its own, answerable before a worktree exists - which is what lets a
   * create be refused without leaving one behind.
   */
  declaredSetup(projectRoot: string): Promise<DeclaredSetup | null>
  acknowledgeSetup(projectRoot: string, hash: string): void
}

/**
 * Taking a session's number, and nothing else the number store can do. The store stays lazy until a
 * promotion, provider-history open or fork needs it.
 */
export interface SessionNumbersPort {
  /** Null when the number could not be taken: a session without a number, not a refused promotion. */
  allocate(projectPath: string, records: readonly SessionRecord[]): Promise<string | null>
}

/**
 * Where a Codex conversation id can be found after the fact. Narrow, and pointed at the subsystem's
 * declared read surface rather than at `providers/`, which nothing outside `projectManager` imports.
 */
export interface SessionCodexRolloutsPort {
  /**
   * The launch window, walked fresh: the one read every capture pass makes. A record's window is
   * its own, so this costs the same whether the record was launched a second or a month ago.
   */
  rolloutsBetween(
    directory: string,
    from: number,
    until: number,
  ): Promise<readonly CodexRolloutMatch[]>
}

/**
 * Where a session's name goes into its Claude transcript. Narrow, and pointed at the subsystem's
 * declared write surface for the same reason the rollouts port is: `providers/` is imported by
 * `projectManager` and by nothing else. False means the name was not written, never a failed rename.
 */
export interface SessionClaudeTitlesPort {
  appendTitle(input: { cwd: string; nativeSessionId: string; title: string }): Promise<boolean>
}

export interface SessionLifecycleDeps {
  controller: NonNullable<LaunchPlanOptions['controller']>
  records: SessionRecordsStore
  host: SessionHostPort
  worktrees: SessionWorktreePort
  setup: SessionSetupPort
  numbers: SessionNumbersPort
  codexRollouts: SessionCodexRolloutsPort
  claudeTitles: SessionClaudeTitlesPort
  /** Where a fact the user has to know but cannot act on through the result goes. */
  report: (message: string) => void
  /**
   * Continues a merge whose resolver has just exited cleanly. Optional because the merge flow is
   * wired after the lifecycle: without it a resolved conflict simply waits for a person to press
   * Merge, which is the manual path everything else already falls back to.
   */
  resumeMerge?: (sessionId: string) => void
  /**
   * Whether this agent runs without being asked anything, read AT EVERY launch rather than captured:
   * the switch is a live setting, so turning it off reaches every session the next time one starts.
   * Absent means gated, which is what a consumer that knows nothing about the switch must get.
   */
  yoloFor?: (agentId: SessionRecordAgent['agentId']) => boolean
  /**
   * The model an agent should START on, read at every launch that FOUNDS a conversation, so the
   * setting stays live the same way yolo does. Absent means no opinion: nothing is emitted and the
   * agent keeps its own default, which is what a consumer that knows nothing about the setting must
   * get.
   */
  modelFor?: (agentId: SessionRecordAgent['agentId']) => string | undefined
  effortFor?: (agentId: SessionRecordAgent['agentId']) => string | undefined
  /** Injected by tests; the default answers Claude's trust dialog in the file it reads it from. */
  seedClaudeTrust?: (cwd: string) => ClaudeTrustSeedResult
  /** Both are injected by tests only. Ids are v4 UUIDs because Claude's `--session-id` demands one. */
  newId?: () => string
  now?: () => number
}

export type ReopenRoute =
  | { kind: 'replace'; target: RuntimeRef }
  | { kind: 'create' }
  | { kind: 'live' }

/** What a resolution means for the worktree that was just made: run these, or install nothing. */
export type SetupPlan =
  | { kind: 'run'; commands: SessionRecordSetupCommand[] }
  /**
   * `reason` is what the record keeps and what a refusal quotes; `announcement` is the sentence for
   * the user, and it is null only where the project itself already said it needs nothing. They are
   * two strings rather than one because only some of these have anything to advise.
   */
  | { kind: 'skip'; reason: string; announcement: string | null }

/**
 * Create, reopen, stop, remove, adopt and retry a failed setup, plus the reconcile pass that applies
 * what the Reconciler decided. Every domain failure comes back as a code; a throw here means an
 * invariant of this library was violated, never that something went wrong out in the world.
 *
 * **The create ordering is the point of this class.** The worktree first, then the record written as
 * `starting` carrying the `pendingOperationId` and its kind BEFORE the wire call, then the Host, then
 * the binding. A client that dies anywhere in that sequence leaves evidence the next reconcile can
 * finish: the record exists, it names the operation and what that operation was, and the Host
 * deduplicates the replay by that same id.
 *
 * **A pending record is evidence of a question, never of an answer.** A call that reached no decision
 * leaves one behind: it never got to the Host, it never had the authority to act, or the Host refused
 * it for something about itself that will be different next time. Only a Host that judged the REQUEST
 * has decided, and that refusal is written into the record instead of being asked again for ever.
 * Which answers are which is the whole of `decided`.
 */
export class SessionLifecycle {
  /** V1's bound, kept: a note is a paragraph about a session, not a document inside one. */

  private readonly records: SessionRecordsStore
  private readonly controller: SessionLifecycleDeps['controller']
  private readonly host: SessionHostPort
  private readonly worktrees: SessionWorktreePort
  private readonly setup: SessionSetupPort
  private readonly numbers: SessionNumbersPort
  private readonly codexRollouts: SessionCodexRolloutsPort
  private readonly claudeTitles: SessionClaudeTitlesPort
  private readonly report: (message: string) => void
  private resumeMerge: ((sessionId: string) => void) | null
  private readonly yoloFor: (agentId: SessionRecordAgent['agentId']) => boolean
  private readonly modelFor: (agentId: SessionRecordAgent['agentId']) => string | undefined
  private readonly effortFor: (agentId: SessionRecordAgent['agentId']) => string | undefined
  private readonly seedClaudeTrust: (cwd: string) => ClaudeTrustSeedResult
  private readonly newId: () => string
  private readonly now: () => number
  private codexStartupNamingDone = false
  /**
   * The install machine, carved out of this class. It launches records the way this class does, so
   * it is handed exactly those five methods and nothing else - never `this`.
   */
  private readonly setupFlow: SetupFlow

  constructor(deps: SessionLifecycleDeps) {
    this.controller = deps.controller
    this.records = deps.records
    this.host = deps.host
    this.worktrees = deps.worktrees
    this.setup = deps.setup
    this.numbers = deps.numbers
    this.codexRollouts = deps.codexRollouts
    this.claudeTitles = deps.claudeTitles
    this.report = deps.report
    this.resumeMerge = deps.resumeMerge ?? null
    this.yoloFor = deps.yoloFor ?? (() => false)
    this.modelFor = deps.modelFor ?? (() => undefined)
    this.effortFor = deps.effortFor ?? (() => undefined)
    this.seedClaudeTrust = deps.seedClaudeTrust
      ?? ((cwd) => ClaudeTrustSeed.seed(cwd, ClaudeTrustSeed.defaultPath()))
    this.newId = deps.newId ?? (() => randomUUID())
    this.now = deps.now ?? (() => Date.now())
    this.setupFlow = new SetupFlow({
      records: this.records,
      host: this.host,
      setup: this.setup,
      report: this.report,
      newId: this.newId,
      now: this.now,
      launch: {
        plannedLaunch: (record, launch) => this.plannedLaunch(record, launch),
        bindLive: (record, result) => this.bindLive(record, result),
        endRefused: (record, detail) => this.endRefused(record, detail),
        replayLaunch: (change) => this.replayLaunch(change),
        hostRouteOf: (sessionId) => this.hostRouteOf(sessionId),
        unrecordedWorktree: (facts) => this.unrecordedWorktree(facts),
      },
    })
  }

  /**
   * The one place a launch is planned in this file, and the reason it exists: yolo is decided by the
   * RECORD'S KIND rather than by the call site, so a setup shell can never pick it up and a sixth
   * launch site added later has nowhere to forget it. Nothing else here may call
   * `LaunchPlanner.plan` directly.
   *
   * It is also the only effect on the path: Claude's directory trust is a write into its own config
   * file, and this is where the launch stops being a plan and starts being a process.
   *
   * `launch` is spelled out at every call site on purpose, because the two settings do NOT share a
   * rule. Yolo is decided by the record's kind and applies to every launch. A model applies only to
   * the launch that FOUNDS a conversation: passing `--model` on a reopen would drag a session the
   * user had remodelled from inside, with `/model`, back to the default on every client restart.
   * Making it a parameter rather than something inferred here means a sixth launch site added later
   * has nowhere to leave the decision implicit either.
   */
  private plannedLaunch(
    record: SessionRecord,
    launch: 'create' | 'reopen',
    options?: LaunchPlanOptions,
  ): RuntimeLaunchSpec {
    options = { ...options, controller: this.controller }
    if (record.kind === 'shell')
      return LaunchPlanner.plan(record, options)
    else if (record.kind === 'agent') {
      // A record with no agent is refused by LaunchPlanner itself, which already owns that invariant.
      const agentId = record.agent?.agentId
      const yolo = agentId !== undefined && this.yoloFor(agentId)
      if (yolo && agentId === 'claude') this.seedTrust(record)
      let model: string | undefined
      let effort: string | undefined
      if (launch === 'create') {
        // The record and nothing else: `recordAgentOf` has already resolved this machine's setting
        // into it, so a replay repeats the same command line however the setting has moved since,
        // and a model NAMED by a caller - which today is a create sent from another computer - is
        // the same field. The effort is still read live here, because nothing reads it back.
        model = record.agent?.model
        effort = agentId === undefined ? undefined : this.effortFor(agentId)
      }
      else if (launch === 'reopen') {
        // Deliberately nothing: a resumed conversation carries on with whatever it was running
        // on, and both of these are switchable from inside a session.
        model = undefined
        effort = undefined
      }
      else
        throw new Error(`Unknown launch: ${JSON.stringify(launch)}`)
      return LaunchPlanner.plan(record, { ...options, yolo, model, effort })
    }
    else
      throw new Error(`Unknown session kind: ${JSON.stringify(record.kind)}`)
  }

  /** Best effort: the worst a failure may do is cost one sentence, never the launch. */
  private seedTrust(record: SessionRecord): void {
    const seeded = this.seedClaudeTrust(LaunchPlanner.cwdOf(record))
    if (seeded.problem !== null)
      this.report(`Session ${record.sessionId}: Claude's trust file could not be written `
        + `(${seeded.problem}); Claude will ask about this directory itself`)
  }

  /**
   * Wired after construction because the merge flow needs the lifecycle to exist first, which is the
   * ordinary init-phase setter rather than a start() argument.
   */
  setResumeMerge(resume: (sessionId: string) => void): void {
    this.resumeMerge = resume
  }

  /**
   * One pass catches records whose regular five-minute naming cadence elapsed while no client ran.
   *
   * A record's window is its own, so this reaches a fork taken weeks ago exactly as cheaply as one
   * taken this morning: that is what names the forks that were written before forks were looked for.
   */
  async nameCodexOnStartup(): Promise<void> {
    if (this.codexStartupNamingDone) return
    this.codexStartupNamingDone = true
    for (const record of this.records.list())
      if (CodexIdCapture.discoverable(record)) await this.applyCodexName(record.sessionId)
  }

  /**
   * A session this library starts for itself: same create, with the id already chosen and the two
   * marks that say what it is. Only the merge flow uses it, and the marks are exactly what the wire
   * spec refuses to carry - a person cannot ask for a one-shot run, nor claim a session resolves
   * somebody else's merge.
   */
  async createInternal(
    spec: SessionCreateSpec,
    marks: { sessionId: string; oneShot: true; resolveFor: string },
  ): Promise<SessionsOpResult<{ sessionId: string }>> {
    return this.createWith(spec, marks)
  }

  /**
   * A session somebody ASKED for, and the reason this door takes one argument: the sentence above
   * used to be enforced by nobody. `create(spec, marks)` was public with the widened signature, so
   * any caller could hand over the two marks the wire refuses to carry, and what stopped them was
   * that none happened to. There are two doors now and the compiler holds the difference.
   */
  async create(spec: SessionCreateSpec): Promise<SessionsOpResult<{ sessionId: string }>> {
    return this.createWith(spec)
  }

  async historyReferences(
    directory: SessionHistoryOpenSpec['directory'],
  ): Promise<SessionsOpResult<{ references: SessionHistoryReference[] }>> {
    const problem = SessionLifecycle.directoryProblem(directory)
    if (problem) return { ok: false, code: 'invalid-spec', detail: problem }
    if (directory.mode !== 'project')
      return { ok: false, code: 'invalid-spec', detail: 'history needs a catalog project' }
    await this.captureProjectCodexIds(directory.projectPath)
    const references: SessionHistoryReference[] = []
    for (const record of this.records.list()) {
      if (!SessionLifecycle.isProjectRecord(record, directory.projectPath)) continue
      const agent = record.agent
      if (!agent?.nativeSessionId) continue
      references.push({
        sessionId: record.sessionId,
        agentId: agent.agentId,
        nativeSessionId: agent.nativeSessionId,
        title: record.title,
        titleParts: SessionTitle.partsOf(record.title),
        life: record.life,
      })
    }
    return { ok: true, value: { references } }
  }

  async openHistory(
    spec: SessionHistoryOpenSpec,
  ): Promise<SessionsOpResult<{ sessionId: string }>> {
    const problem = SessionLifecycle.historyOpenProblem(spec)
    if (problem) return { ok: false, code: 'invalid-spec', detail: problem }
    await this.captureProjectCodexIds(spec.directory.projectPath)
    const matching = this.historyRecordsOf(spec)
    const runningRecord = matching.find((record) =>
      record.life === 'starting' || record.life === 'live')
    const known = runningRecord ?? matching[matching.length - 1]
    if (!spec.providerActive && runningRecord === undefined && known !== undefined) {
      const reopened = await this.reopen(known.sessionId)
      if (!reopened.ok) return reopened
      return { ok: true, value: { sessionId: known.sessionId } }
    }
    return this.createHistoryRecord(
      spec,
      spec.providerActive || runningRecord !== undefined ? 'fork' : 'resume',
      known ?? null,
    )
  }

  private async createHistoryRecord(
    spec: SessionHistoryOpenSpec,
    mode: 'resume' | 'fork',
    parent: SessionRecord | null,
  ): Promise<SessionsOpResult<{ sessionId: string }>> {
    const parts = parent === null
      ? { number: null, name: SessionTitle.normalizeName(spec.providerName) }
      : SessionTitle.partsOf(parent.title)
    if (mode === 'resume') {
      const token = await this.numbers.allocate(spec.directory.projectPath, this.records.list())
      return this.create({
        kind: 'agent',
        directory: spec.directory,
        agent: { agentId: spec.agentId, mode, nativeSessionId: spec.nativeSessionId },
        title: SessionTitle.compose(token, parts.name),
      })
    }
    else if (mode === 'fork')
      return this.forkConversation(
        spec.directory,
        spec.agentId,
        spec.nativeSessionId,
        parts,
        SessionTitle.compose(parts.number, parts.name),
      )
    else
      throw new Error(`Unknown history launch mode: ${JSON.stringify(mode)}`)
  }

  private async createWith(
    spec: SessionCreateSpec,
    marks?: { sessionId: string; oneShot: true; resolveFor: string },
  ): Promise<SessionsOpResult<{ sessionId: string }>> {
    const problem = SessionLifecycle.specProblem(spec)
    if (problem) return { ok: false, code: 'invalid-spec', detail: problem }
    // The READ latch, and only that: a file that could not be read refuses every write for the rest
    // of the session, so asking here is what stops a worktree being cut for a record that could
    // never be written. It says NOTHING about a file that read cleanly and cannot be written - that
    // one is only visible when the write itself comes back false, and it is answered where it
    // happens, by naming what the worktree left behind.
    if (this.records.latched) return OperationOutcomes.latched()
    // Before the worktree, not after: a refusal here has to leave nothing behind, and what it asks
    // about is readable at the project root alone.
    const agreement = await this.setupFlow.setupAgreement(spec)
    if (agreement) return agreement
    const worktree = await this.provisionWorktree(spec)
    if (!worktree.ok)
      return {
        ok: false,
        code: GitCodes.sessionCodeOf(worktree.code),
        detail: worktree.detail,
      }

    const facts = worktree.value
    const sessionId = marks?.sessionId ?? this.newId()
    const operationId = this.newId()
    const record = this.recordOf(spec, sessionId, facts, operationId, marks)
    /*
     * Only a worktree is empty enough to need this, and only a worktree create can name the
     * repository the steps come back relative to. The resolution itself is a couple of file reads,
     * which is why it may sit on the one queue every operation shares; the install it decides on
     * runs as a runtime on the Host, where nothing waits for it.
     */
    if (facts !== null) {
      const projectRoot = OperationOutcomes.projectRootOf(spec.directory)
      const plan = await this.setupFlow.setupPlanFor(projectRoot, facts.repositoryRoot, facts.worktreePath)
      if (plan.kind === 'run') return this.setupFlow.createWithSetup(record, facts, plan.commands)
      else if (plan.kind === 'skip') {
        // A marker rather than silence: a worktree that had nothing installed into it looks exactly
        // like one that did, right up to the moment the session inside it fails to build.
        record.setupSkipped = { reason: plan.reason }
        if (plan.announcement !== null) this.report(`Session ${sessionId}: ${plan.announcement}`)
      }
      else
        throw new Error(`Unknown setup plan: ${JSON.stringify(plan)}`)
    }
    // The write that can fail with a worktree already on disk. A create with no worktree has left
    // nothing anywhere, so it says the plain thing; one with a worktree says where that worktree is.
    if (!await this.records.put(record))
      return facts === null ? OperationOutcomes.latched() : this.unrecordedWorktree(facts)

    // Built from the RECORD rather than from the spec, which is the same shape plus the two marks the
    // wire refuses to carry. Reading the spec here dropped `oneShot` on the floor: the merge
    // resolver's own launch never carried `-p`, so what was meant to answer once and exit came up as
    // an interactive agent nobody was watching, and only a REPLAY of it ran the way it was meant to.
    const agentArgs = record.agent ? AgentPresets.replayArgs(record.agent) : undefined
    const created = await this.host.runtimeCreate({
      operationId,
      runtimeSessionId: sessionId,
      launch: this.plannedLaunch(record, 'create', { agentArgs }),
    })
    if (!created.ok) {
      // No decision leaves the record `starting` with its pending id on purpose: that is exactly the
      // state the reconciler replays once the Host can answer differently. A decision is the Host
      // judging the request itself, and one of those replayed every two seconds forever is not a
      // retry, it is a loop - see `decided` for which answers are which. The undecided half is paced
      // and counted instead, so a refusal that stands is a wait somebody can see rather than a loop.
      if (OperationOutcomes.decided(created)) await this.endRefused(record, created.detail)
      else await this.markLaunchWait(record.sessionId, created.detail)
      return OperationOutcomes.failureOf(created)
    }
    await this.bindLive(record, created.value)
    return { ok: true, value: { sessionId } }
  }

  /**
   * One more refusal nobody could act on, written where the next replay and the row can both read it.
   *
   * Read again rather than spread from what the caller started with, for the reason `stop` gives:
   * the Host call is a round trip, and this record may have moved under it. A failed write is not
   * reported - the wait is a pacing hint, and losing one leaves the record exactly as pending as it
   * already was, which the next pass replays as before.
   */
  private async markLaunchWait(sessionId: string, reason: string): Promise<void> {
    const record = this.records.get(sessionId)
    // Only while the launch is still the one being waited for. A record that bound, ended or was
    // removed while the Host was answering has nothing left to pace.
    if (!record || record.life !== 'starting' || record.pendingOperationId === undefined) return
    await this.records.put({
      ...record,
      launchWait: LaunchBackoff.after(record.launchWait, reason, this.now()),
    })
  }

  /**
   * A create the Host refused ENDS the record; it is not dropped. Dropping would be tidier for a
   * plain shell, but a refused create can already have a worktree and a branch behind it, and with
   * no record naming them nothing would ever say where they are - and the user would never learn
   * what the Host actually said. The ended record carries the Host's own words, shows up in the
   * snapshot beside every other session, and `remove()` takes it away when the user is done with it.
   */
  private async endRefused(record: SessionRecord, detail: string): Promise<void> {
    await this.records.put({
      ...record,
      life: 'ended',
      binding: null,
      pendingOperationId: undefined,
      pendingOperationKind: undefined,
      launchWait: undefined,
      endedAt: this.now(),
      endedReason: detail,
    })
  }

  /**
   * The session keeps its id forever, so what changes is only which wire operation puts a process
   * behind it again - and that is decided by what the Host currently knows, not by what the record
   * last said.
   */
  /**
   * Running the install again for a session that is waiting on one. Delegated whole: the flow owns
   * every step of it, and this class owns being the surface the manager calls.
   */
  async retrySetup(sessionId: string, acknowledgeSetup?: string): Promise<SessionsOpResult> {
    return this.setupFlow.retrySetup(sessionId, acknowledgeSetup)
  }

  async reopen(sessionId: string): Promise<SessionsOpResult> {
    let record = this.records.get(sessionId)
    if (!record) return OperationOutcomes.notFound(sessionId)
    /*
     * A record carrying `pendingSetup` has a worktree that exists and is NOT installed. Reopening it
     * would launch the session into exactly the half-provisioned directory this whole path exists to
     * prevent, so it is refused whatever its life says.
     *
     * Asked BEFORE the `starting` check, because the two answers are not interchangeable: a starting
     * record waiting on an install would otherwise be told its launch is replayed as soon as the Host
     * can answer, and it is not - it is replayed when the install exits 0, and never if the install
     * fails. What is said instead is true of every life this reaches.
     *
     * Refused rather than carried forward, and refused rather than quietly cleared. Carrying the wait
     * into the reopened record is the worst of the three: a Host that decides nothing leaves the
     * record `starting` with the wait and a new pending pair, and the next reconcile judges the OLD
     * failed setup all over again and ends the session, throwing the user's reopen away without a
     * word. Clearing it is only the second worst - it launches the agent into the uninstalled
     * worktree, silently.
     */
    if (record.pendingSetup)
      return {
        ok: false,
        code: 'invalid-spec',
        detail: `Session ${sessionId} cannot be reopened: its setup has not finished, so its worktree `
          + 'is not installed; it starts by itself when the setup exits cleanly, and retrySetup runs '
          + 'the setup again after one that failed',
      }
    /*
     * A launch already in flight is refused rather than joined. The record would otherwise be
     * restamped with a fresh operation id and the kind `reopen`, throwing away the id the Host
     * deduplicates by and replaying an unanswered create as a resume of a conversation that create
     * never created - a recoverable session turned into a doomed one by one click.
     *
     * Refused rather than carried forward: carrying the pending pair would make this call re-issue
     * the operation the reconcile pass is already re-issuing under that same id, on its own two
     * second clock. A pending launch has exactly one owner, and it is that pass. `starting` with no
     * pending pair is the same answer for one more pass, after which the reconciler has marked the
     * record lost and this succeeds.
     */
    if (record.life === 'starting')
      return {
        ok: false,
        code: 'launch-pending',
        detail: `Session ${sessionId} has a launch waiting for the Host to answer; it is replayed as soon as the Host can`,
      }
    // A Codex record has no id until one is found for it, so the look happens before the gate rather
    // than after the refusal. Everything from here on reads the record this may have replaced.
    record = await this.withCapturedCodexId(record)
    // Asked before the Host is touched: a record that cannot name the conversation it would land on
    // is refused outright rather than started on a guess.
    const reopenable = record.agent ? AgentPresets.reopenProblem(record.agent) : null
    if (reopenable)
      return {
        ok: false,
        code: 'invalid-spec',
        detail: `Session ${sessionId} cannot be reopened: ${reopenable}`,
      }
    if (this.records.latched) return OperationOutcomes.latched()
    const routed = await this.hostRouteOf(sessionId)
    if (!routed.ok) return routed
    const route = routed.value

    if (route.kind === 'live')
      return {
        ok: false,
        code: 'live-refused',
        detail: `Session ${sessionId} is still running; stop it before reopening it`,
      }
    const operationId = this.newId()
    // The kind travels with the id: what is left on disk if this dies here is otherwise
    // indistinguishable from an interrupted create, and a create replays the wrong command line.
    //
    // Everything the previous run left behind goes with it. The binding named a generation that is
    // dead or gone, and a `starting` record still carrying one is the shape `remove` refuses and
    // `stop` would fire at - a session that could be neither started nor deleted. The replace target
    // comes from the listing, never from here, so nothing reads the binding this drops. The ended
    // fields go for the same reason: a record the snapshot reports as `starting` must not also be
    // reporting when and why it ended.
    const pending: SessionRecord = {
      ...record,
      binding: null,
      life: 'starting',
      pendingOperationId: operationId,
      pendingOperationKind: 'reopen',
      endedAt: undefined,
      exitCode: undefined,
      endedReason: undefined,
      exitReason: undefined,
      stopRequested: undefined,
      // Running it again is the opposite of being done with it, so the mark goes. Without this a
      // reopened session would be live and still filed as finished, which is to say invisible.
      completed: undefined,
    }
    if (!await this.records.put(pending)) return OperationOutcomes.latched()
    const launch = this.plannedLaunch(pending, 'reopen')
    let result: HostCallResult<RuntimeResult>
    if (route.kind === 'replace')
      result = await this.host.runtimeReplace({ target: route.target, operationId, launch })
    else if (route.kind === 'create')
      result = await this.host.runtimeCreate({ operationId, runtimeSessionId: sessionId, launch })
    else
      throw new Error(`Unknown reopen route: ${JSON.stringify(route)}`)
    if (!result.ok) {
      // The Host judged the request, so nothing is pending any more and the record goes back to what
      // it was before this attempt. Only a call that decided nothing leaves the pending record to
      // replay.
      if (OperationOutcomes.decided(result)) await this.records.put(record)
      return OperationOutcomes.failureOf(result)
    }
    await this.bindLive(pending, result.value)
    return { ok: true, value: undefined }
  }

  /**
   * What the Host currently has for this id, as the one of three routes a relaunch can take. It is
   * asked of the Host rather than read off the record on purpose: what the record last said about a
   * generation is history, and only the listing says what can be replaced.
   */
  private async hostRouteOf(sessionId: string): Promise<SessionsOpResult<ReopenRoute>> {
    const listing = await this.host.runtimeList()
    if (!listing.ok) return OperationOutcomes.failureOf(listing)
    const known = listing.value.sessions.find((entry) => entry.runtimeSessionId === sessionId)
    return {
      ok: true,
      value: SessionLifecycle.reopenRoute(known, listing.value.hostInstanceId, sessionId),
    }
  }

  /** The exit event and the reconcile that follows it are what mark the record: the Host decides life. */
  async stop(sessionId: string): Promise<SessionsOpResult> {
    const record = this.records.get(sessionId)
    if (!record) return OperationOutcomes.notFound(sessionId)
    if (record.life === 'ended' || record.life === 'lost')
      return { ok: true, value: undefined }
    else if (record.life === 'live' || record.life === 'starting') {
      const target = OperationOutcomes.targetOf(record)
      if (!target)
        return {
          ok: false,
          code: 'not-found',
          detail: `Session ${sessionId} has no runtime on the Host yet`,
        }
      const stopped = await this.host.runtimeStop(target)
      if (!stopped.ok) {
        /*
         * A refused stop is still a stop somebody asked for, and for most sessions that is the fact
         * worth keeping. The Host answers `did not confirm its death` for a process that is dying
         * slowly, and the exit lands a second later; without the mark that ending reads as a crash,
         * which is the one thing this whole action exists to stop happening. Measured on 2026-08-19:
         * stop asked for at 14:53:23.625, process gone at 14:53:24.974, row red.
         *
         * NOT for the two roles somebody else is waiting on. An install and a merge resolver are
         * judged by how they ended, and a stop the Host refused may have reached neither: a marked
         * install would fail the session it was preparing while it is still installing. For those the
         * mark stays where it has always been, after a stop the Host confirmed.
         */
        if (record.setupFor === undefined && record.resolveFor === undefined
          && !record.stopRequested)
          await this.records.put({ ...this.records.get(sessionId) ?? record, stopRequested: true })
        return OperationOutcomes.failureOf(stopped)
      }
      // A session that was stopped did not end on its own, whatever exit code the platform gives a
      // killed process - and on POSIX that is 0. The mark goes on either answer now; what waits for
      // the Host's confirmation is the `completed` below, which is a statement about a session that
      // has actually finished rather than about what somebody asked for.
      // Read again rather than spreading what we started with: the Host call is a round trip, and the
      // merge flow writes this same store from OUTSIDE the operation queue. A teardown that landed in
      // that gap would be undone by a stale copy, putting back a worktree `remove --force` deleted.
      const current = this.records.get(sessionId) ?? record
      const marks: Partial<SessionRecord> = {}
      if (!current.stopRequested) marks.stopRequested = true
      // Asked of the record as it will be WRITTEN: the witness this stop is about is the mark two
      // lines up, and a record read before it would answer that nobody had asked for anything.
      if (SessionLifecycle.completesOn({ ...current, ...marks })) marks.completed = true
      // The answer is kept rather than dropped. It is NOT a refusal - the Host stopped the
      // runtime and the session really is stopped - but what did not land is the fact that makes
      // the ending readable: two judgements ask `stopRequested` BEFORE the exit code, and on
      // POSIX a signalled process reports 0, so a stopped install without the mark reads as a
      // clean run and the session it was preparing starts in a half-installed worktree.
      if (Object.keys(marks).length > 0 && !await this.records.put({ ...current, ...marks }))
        this.report(
          `Session ${sessionId} was stopped, but the record could not be written; its ending may `
          + 'read as a crash, and a stopped install or merge resolver may read as a clean run',
        )
      return { ok: true, value: undefined }
    }
    else
      throw new Error(`Unknown session life: ${JSON.stringify(record.life)}`)
  }

  /**
   * The record goes; the worktree and its branch stay, and this says so out loud.
   *
   * `create` ends a refused create rather than dropping it because a worktree and a branch may be
   * behind it and the record is the only thing that names them. Removing the record is the user
   * deciding they are done with that, and it must not be refused - a session nothing can take away
   * is the trap this whole path exists to avoid - but the reasoning would be contradicted in
   * silence if the directory and the branch simply vanished from view. So they are named on the
   * client's error channel: what is left, exactly where, and what the branch is called.
   *
   * They are not removed here on purpose. `git worktree remove` refuses a worktree holding
   * uncommitted work, and refusing the removal for that would put the session back in the trap;
   * `--force` throws that work away, which is not a decision to take on a click that says nothing
   * about it. Teardown is `--force` plus `branch -d` under a user who has said what happens to the
   * work, and that is `WorktreeMergeFlow`'s - Merge or Discard on the row - not this one's.
   */
  async remove(sessionId: string): Promise<SessionsOpResult> {
    const record = this.records.get(sessionId)
    if (!record) return OperationOutcomes.notFound(sessionId)
    const target = OperationOutcomes.targetOf(record)
    // A `starting` record with no binding names nothing on the Host: its launch either never ran or
    // was never answered, so there is no runtime to stop first and the record is all there is to
    // remove. Refusing it is what left a session that could be neither started nor deleted.
    if (record.life === 'live' || (record.life === 'starting' && target !== null))
      return {
        ok: false,
        code: 'live-refused',
        detail: `Session ${sessionId} is ${record.life}; stop it before removing it`,
      }
    else if (record.life === 'starting' || record.life === 'ended' || record.life === 'lost') {
      // Best effort, and deliberately not a reason to refuse: the Host's dead entry is only a
      // diagnostic once the record is gone, and it does not survive the Host's next start anyway.
      if (record.life === 'ended' && target) await this.host.runtimeRemove(target)
      if (!await this.records.remove(sessionId)) return OperationOutcomes.latched()
      // The install was only ever preparing THIS session, so it goes with it. Best effort, and its
      // own record stays: it ends like any other shell session, with what it printed still readable.
      if (record.pendingSetup) await this.setupFlow.stopSetup(record.pendingSetup.setupSessionId)
      if (record.worktree)
        this.report(
          `Session ${sessionId} is gone; its worktree ${record.worktree.worktreePath} and the branch `
          + `${record.worktree.branch} are left in ${record.worktree.repositoryRoot} for you to keep `
          + 'or remove, because nothing here throws away work that was never committed',
        )
      return { ok: true, value: undefined }
    }
    else
      throw new Error(`Unknown session life: ${JSON.stringify(record.life)}`)
  }

  /**
   * The one place where closing a surface ends what is behind it, and it is narrow on purpose: a
   * plain tab is presented by its tab alone, so a tab closed without this would leave a runtime
   * nothing can ever show again. Everywhere else closing a tab still only detaches.
   *
   * The stop and the removal are one operation rather than two calls, because between them the
   * record would name a runtime that is already gone.
   */
  async discardPlain(sessionId: string): Promise<SessionsOpResult> {
    const record = this.records.get(sessionId)
    if (!record) return OperationOutcomes.notFound(sessionId)
    if (record.presentation !== 'tab')
      return {
        ok: false,
        code: 'invalid-spec',
        detail: `Session ${sessionId} is not a plain tab, so closing its tab ends nothing`,
      }
    if (this.records.latched) return OperationOutcomes.latched()
    const target = OperationOutcomes.targetOf(record)
    if (target !== null && (record.life === 'live' || record.life === 'starting')) {
      // Marked BEFORE the stop, the opposite way round from `stop()`. Nothing is waiting on this
      // session's exit code the way an install's caller waits, and the record is on its way out; the
      // only thing the marker has to survive is a crash between the stop and the removal, where it
      // is what keeps a closed tab from reading as a session that fell over.
      if (!record.stopRequested && !await this.records.put({ ...record, stopRequested: true }))
        return OperationOutcomes.latched()
      const stopped = await this.host.runtimeStop(target)
      if (!stopped.ok && !SessionLifecycle.alreadyGone(stopped))
        return OperationOutcomes.failureOf(stopped)
    }
    if (!await this.records.remove(sessionId)) return OperationOutcomes.latched()
    // Best effort for the same reason `remove` does it: a dead entry on the Host is a diagnostic
    // once the record is gone, and it does not survive the Host's next start anyway.
    if (target !== null) await this.host.runtimeRemove(target)
    return { ok: true, value: undefined }
  }

  /**
   * A plain tab becomes a session of the tree. One direction only: a session of the tree has a
   * number and a place in the tree, and there is nowhere for those to go back to.
   *
   * A number is taken only for a project directory, exactly as the create card does it, and failing
   * to take one is not a reason to refuse: a session without a number is a session, and refusing
   * would leave the tab as the only thing holding a session the person asked to keep.
   */
  async promotePlain(sessionId: string): Promise<SessionsOpResult> {
    const record = this.records.get(sessionId)
    if (!record) return OperationOutcomes.notFound(sessionId)
    if (record.presentation !== 'tab')
      return {
        ok: false,
        code: 'invalid-spec',
        detail: `Session ${sessionId} is already a session of the tree`,
      }
    if (this.records.latched) return OperationOutcomes.latched()
    const token = record.directory.mode === 'project'
      ? await this.numbers.allocate(record.directory.projectPath, this.records.list())
      : null
    const title = token === null ? record.title : `${token} - ${record.title}`
    const promoted: SessionRecord = { ...record, title }
    delete promoted.presentation
    if (!await this.records.put(promoted)) return OperationOutcomes.latched()
    return { ok: true, value: undefined }
  }

  /**
   * Fork the conversation this session is holding into one of its own.
   *
   * The spec is composed HERE rather than by whoever asked, because everything it needs is on the
   * record and none of it is the caller's to guess: which agent this is, which conversation, and
   * which directory. A surface that built this itself would be a second place that knows what
   * forking means.
   *
   * A fork is a session of the tree, never a plain tab: closing a plain tab discards its record, so a
   * plain tab holding a fork would be a tab that dies for good the first time it is closed. The
   * launcher settled the same question the same way.
   *
   * `name` is the ONE thing a caller may say, because it is the one thing the record cannot: the
   * card that asks for a fork lets the name be typed over before anything starts. It replaces the
   * parent's name and nothing else - the number pair is still composed here, from the number the
   * counter actually hands out.
   */
  async forkFrom(
    sessionId: string,
    options?: { name?: string },
  ): Promise<SessionsOpResult<{ sessionId: string }>> {
    const record = this.records.get(sessionId)
    if (!record) return OperationOutcomes.notFound(sessionId)
    if (record.kind !== 'agent' || record.agent === undefined)
      return {
        ok: false,
        code: 'invalid-spec',
        detail: `Session ${sessionId} is a shell, and a shell holds no conversation to fork`,
      }
    // A resolver runs in the worktree the merge tears down the moment it is finished, and a fork of
    // it would still be standing there. The same shape `admitsOf` withholds `fork` for.
    if (record.resolveFor !== undefined)
      return {
        ok: false,
        code: 'invalid-spec',
        detail: `Session ${sessionId} resolves a merge for ${record.resolveFor}, and its worktree goes when that merge is done, so nothing may fork it`,
      }
    const agentId = record.agent.agentId
    // The one thing a client could never do for itself: a codex session learns its own id late, and
    // this is the moment to go and find it rather than refuse for want of it.
    const captured = await this.withCapturedCodexId(record)
    const parentId = captured.agent?.nativeSessionId
    if (parentId === undefined)
      return {
        ok: false,
        code: 'invalid-spec',
        detail: `Session ${sessionId} never named the conversation it is holding, so there is nothing to fork from`,
      }
    const parts = SessionTitle.partsOf(captured.title)
    // An empty name is a name: it says "no name", and the fork is then called by its numbers alone,
    // exactly as a create with an empty field is. Only an absent option keeps the parent's.
    const name = options?.name === undefined
      ? parts.name
      : SessionTitle.normalizeName(options.name)
    // The project directory rather than the worktree, and no worktree of its own: a worktree belongs
    // to the one session it was cut for, and a fork sharing it would put two agents in one checkout.
    return this.forkConversation(
      captured.directory,
      agentId,
      parentId,
      { number: parts.number, name },
      SessionTitle.compose(parts.number, name),
    )
  }

  private async forkConversation(
    directory: SessionCreateSpec['directory'],
    agentId: SessionAgentId,
    parentId: string,
    parentTitle: SessionTitleParts,
    unnumberedTitle: string,
  ): Promise<SessionsOpResult<{ sessionId: string }>> {
    let title: string
    if (directory.mode === 'project') {
      const token = await this.numbers.allocate(
        directory.projectPath,
        this.records.list(),
      )
      title = SessionTitle.composeFork(parentTitle.number, token, parentTitle.name)
    }
    else if (directory.mode === 'adHoc' || directory.mode === 'default')
      title = unnumberedTitle
    else
      throw new Error(`Unknown session directory: ${JSON.stringify(directory)}`)
    return this.create({
      kind: 'agent',
      directory,
      agent: { agentId, mode: 'fork', forkParentId: parentId },
      title,
    })
  }

  /**
   * Give this session a colour, or take the one it has away. `null` is None, and it deletes the field
   * rather than storing a word for absence.
   *
   * The name is checked here because this is the write: a caller offering something nobody can draw
   * has made a mistake, and answering it is cheaper than a record that reads back as blank forever.
   */
  async setColor(
    sessionId: string,
    color: SessionColorName | null,
  ): Promise<SessionsOpResult> {
    if (color !== null && !SessionColors.isName(color))
      return {
        ok: false,
        code: 'invalid-spec',
        detail: `${JSON.stringify(color)} is not a session colour`,
      }
    const record = this.records.get(sessionId)
    if (!record) return OperationOutcomes.notFound(sessionId)
    if (this.records.latched) return OperationOutcomes.latched()
    const painted: SessionRecord = { ...record }
    if (color === null) delete painted.color
    else painted.color = color
    if (!await this.records.put(painted)) return OperationOutcomes.latched()
    return { ok: true, value: undefined }
  }

  /**
   * The details dialog's Save: whichever of name, note and colour actually moved, merged into ONE
   * record put, so the save is one revision and one broadcast. A field that is absent is not
   * touched - a name-only save must never revert a colour another surface wrote moments earlier -
   * and `null` clears the note and the colour. The number prefix is not the caller's to touch: the
   * record's own is kept and the name is composed behind it, so `014 - old` renamed to `new` stays
   * `014 - new`, and a save that carries no changed name leaves the title byte-for-byte as it was.
   *
   * `titleChanged` is answered rather than left for the caller to derive, and so is
   * `notifyAgent`: the whole of "should the agent hear about this rename" is settled here, from
   * the record. Claude's half is written into the transcript below; Codex's is a command typed
   * into its TUI, so what travels back is the text and never the typing.
   */
  /** Codex's own command for it. Measured against Codex CLI 0.149.0. */
  private static readonly renameCommandConst = '/rename'

  async setDetails(
    sessionId: string,
    update: SessionDetailsUpdate,
  ): Promise<SessionsOpResult<SessionDetailsSaved>> {
    if (update.color !== undefined && update.color !== null && !SessionColors.isName(update.color))
      return {
        ok: false,
        code: 'invalid-spec',
        detail: `${JSON.stringify(update.color)} is not a session colour`,
      }
    const note = update.note === undefined ? undefined : update.note?.trim() ?? ''
    if (note !== undefined && note.length > SessionLimits.noteCharacters)
      return {
        ok: false,
        code: 'invalid-spec',
        detail: `The note is longer than ${SessionLimits.noteCharacters} characters`,
      }
    const record = this.records.get(sessionId)
    if (!record) return OperationOutcomes.notFound(sessionId)
    if (this.records.latched) return OperationOutcomes.latched()
    const parts = SessionTitle.partsOf(record.title)
    let name = parts.name
    let nameChanged = false
    let title = record.title
    if (update.name !== undefined) {
      name = SessionTitle.normalizeName(update.name)
      // On a record with no prefix the name IS the whole title, and a name shaped like a session
      // number would come back out of `partsOf` as one: the next save would edit `planning notes`
      // behind a chip reading `2026`. Refused here, where the shape is still the caller's choice.
      if (parts.number === null && SessionTitle.titlePrefixConst.test(name))
        return {
          ok: false,
          code: 'invalid-spec',
          detail: 'A name must not begin like a session number',
        }
      const composed = SessionTitle.compose(parts.number, name)
      if (composed.trim().length === 0)
        return { ok: false, code: 'invalid-spec', detail: 'The session name is empty' }
      nameChanged = name !== parts.name
      // The title is rewritten only for a changed name: an unrelated save must not canonize a
      // separator, and a rewrite here would fire the provider propagation below over nothing.
      if (nameChanged) title = composed
    }
    const detailed: SessionRecord = { ...record, title }
    if (note !== undefined) {
      if (note === '') delete detailed.note
      else detailed.note = note
    }
    if (update.color !== undefined) {
      if (update.color === null) delete detailed.color
      else detailed.color = update.color
    }
    if (!await this.records.put(detailed)) return OperationOutcomes.latched()
    // Only after the record landed, and best-effort: a transcript the name never reached is a fact
    // for the report channel, never a failed save. The bare name goes over - the prefix is V3's.
    if (nameChanged && name !== ''
        && record.agent?.agentId === 'claude' && record.agent.nativeSessionId !== undefined) {
      const written = await this.claudeTitles.appendTitle({
        cwd: LaunchPlanner.cwdOf(record),
        nativeSessionId: record.agent.nativeSessionId,
        title: name,
      }).catch(() => false)
      if (!written)
        this.report(`The new name of ${sessionId} was not written to the Claude transcript`)
    }
    return {
      ok: true,
      value: {
        titleChanged: nameChanged,
        notifyAgent: SessionLifecycle.renameNoticeOf(record, name, nameChanged),
      },
    }
  }

  /**
   * What the agent behind this session still has to be TOLD, once the record has the new name.
   *
   * Only Codex, and only while it is live: it writes its own index when the command is typed
   * into its TUI, and a session that is not running has no TUI to type into. Claude needs no
   * notice at all - its half is the transcript write above, which this library does itself.
   *
   * `/rename` is the provider's protocol and belongs beside the other things this library knows
   * about a provider, not in the card that draws the field.
   */
  private static renameNoticeOf(
    record: SessionRecord,
    name: string,
    nameChanged: boolean,
  ): SessionDetailsSaved['notifyAgent'] {
    if (!nameChanged || name === '') return null
    if (record.agent?.agentId !== 'codex' || record.life !== 'live') return null
    return { text: `${SessionLifecycle.renameCommandConst} ${name}` }
  }

  /**
   * The pass's own look for the conversation a live Codex session is having, read out of the rollout
   * it wrote seconds ago.
   *
   * This is what makes the id knowable at all for a session nobody reopens: the model and context the
   * status bar draws, the conversation File Changes reconstructs and `admits.fork` all hang off that
   * one field, and before this the only two things that ever filled it were a reopen and a fork.
   *
   * False here means only that nothing could be claimed on this pass, which is the normal answer for
   * most of them.
   */
  private async applyCodexName(sessionId: string): Promise<boolean> {
    const record = this.records.get(sessionId)
    if (!record) return false
    const named = await this.withCapturedCodexId(record)
    return named.agent?.nativeSessionId !== record.agent?.nativeSessionId
  }

  private async captureProjectCodexIds(projectPath: string): Promise<void> {
    const unnamed = this.records.list().filter((record) =>
      SessionLifecycle.isProjectRecord(record, projectPath)
      && CodexIdCapture.discoverable(record))
    for (const record of unnamed) await this.withCapturedCodexId(record)
  }

  private historyRecordsOf(spec: SessionHistoryOpenSpec): SessionRecord[] {
    return this.records.list().filter((record) =>
      SessionLifecycle.isProjectRecord(record, spec.directory.projectPath)
      && record.agent?.agentId === spec.agentId
      && record.agent.nativeSessionId === spec.nativeSessionId)
  }

  /**
   * The record, with the id of the conversation it ran written into it where one could be found for
   * it beyond doubt. Unchanged in every other case, which leaves the reopen gate saying exactly what
   * it said before this existed.
   *
   * The one read every pass makes: the launch window walked fresh. A listing would answer out of a
   * thirty-second cache, so it could not see a rollout written a second ago, and building that cache
   * without a memo reads every header in ninety days. The window a rollout has to fall inside is the
   * record's own, so this costs the same for a record launched a second or a month ago.
   */
  private async withCapturedCodexId(record: SessionRecord): Promise<SessionRecord> {
    const agent = record.agent
    if (!agent || !CodexIdCapture.discoverable(record) || this.records.latched) return record
    const window = CodexIdCapture.windowOf(record)
    const found = await this.codexRollouts.rolloutsBetween(
      LaunchPlanner.cwdOf(record),
      window.from,
      window.until,
    )
    const captured = CodexIdCapture.matchOf(found, record, this.records.list())
    if (captured === null) return record
    const named: SessionRecord = { ...record, agent: { ...agent, nativeSessionId: captured } }
    return await this.records.put(named) ? named : record
  }

  /**
   * A stop the Host answered with "no such runtime", which is the runtime having already finished on
   * its own. Only 404 counts: every other refusal leaves it possible that something is still running,
   * and a caller about to throw the record away has to be sure it is not.
   */
  private static alreadyGone(failure: HostCallFailure): boolean {
    return failure.code === 'op-rejected' && failure.status === 404
  }

  /**
   * Whether this ending files the session as done with. Stopping a session IS finishing with it, so
   * it is one click and not two.
   *
   * It is asked in three places rather than only after a confirmed stop, and that is the whole of
   * this rule's history: the Host answers `did not confirm its death` for a process that is dying
   * slowly, and a stop it refused used to leave the mark unwritten for ever. The exit landed a
   * second later and the row stayed in the daily view as unfinished business nobody could finish -
   * measured on 2026-08-20, on two sessions the person then deleted to get rid of them, which is
   * the one action here that cannot be undone.
   *
   * A session with a worktree is the exception it has always been: it has after-steps waiting on
   * it, so until somebody says whether the branch is merged home or thrown away, it IS unfinished
   * business. Whichever of the two they choose marks it finished when it completes.
   *
   * Ask it of the record as it will be WRITTEN - a stop that has just marked itself is the witness
   * this question is about.
   */
  private static completesOn(record: SessionRecord): boolean {
    if (record.worktree !== undefined || record.completed !== undefined) return false
    return SessionOutcomes.endingWasAsked(record)
  }

  /**
   * A live runtime nobody was tracking becomes a shell record around it. It is adopted as a shell
   * because nothing on the Host says what it was launched as - the Host persists neither argv nor
   * environment - and a record claiming an agent it cannot prove would resume the wrong thing.
   */
  async adoptOrphan(runtimeSessionId: string): Promise<SessionsOpResult> {
    if (this.records.get(runtimeSessionId))
      return {
        ok: false,
        code: 'invalid-spec',
        detail: `${runtimeSessionId} is already a tracked session, so there is no orphan to adopt`,
      }
    if (this.records.latched) return OperationOutcomes.latched()
    const listing = await this.host.runtimeList()
    if (!listing.ok) return OperationOutcomes.failureOf(listing)
    const found = listing.value.sessions.find(
      (entry) => entry.runtimeSessionId === runtimeSessionId,
    )
    if (!found || !found.alive)
      return {
        ok: false,
        code: 'not-found',
        detail: `The Host has no live runtime ${runtimeSessionId}`,
      }
    const adopted: SessionRecord = {
      sessionId: runtimeSessionId,
      kind: 'shell',
      title: `Adopted ${runtimeSessionId}`,
      // The launch directory is not recoverable, so the record claims none rather than a wrong one.
      directory: { mode: 'default' },
      binding: { hostInstanceId: listing.value.hostInstanceId, generation: found.generation },
      life: 'live',
      createdAt: found.startedAt,
    }
    if (!await this.records.adopt(adopted)) return OperationOutcomes.latched()
    return { ok: true, value: undefined }
  }

  /**
   * Plans against the Host's answer and carries out what it decided. The changes handed back are the
   * ones that landed, plus every orphan - an orphan is reported on every pass, because it is a fact
   * about the Host rather than a change to anything here.
   */
  async reconcile(listing: RuntimeListResult | null): Promise<ReconcileChange[]> {
    if (this.records.latched) return []
    const applied: ReconcileChange[] = []
    for (const change of Reconciler.plan(this.records.list(), listing, this.now())) {
      if (change.kind === 'orphan')
        applied.push(change)
      else if (change.kind === 'bind-live') {
        if (await this.applyBindLive(change.sessionId, change.binding)) applied.push(change)
      }
      else if (change.kind === 'mark-ended') {
        const record = this.records.get(change.sessionId)
        if (record) {
          const ended: SessionRecord = {
            ...record,
            life: 'ended',
            exitCode: change.exitCode,
            // The Host's own word for the ending, kept beside the mark this client may have written
            // itself: either one on its own is enough to read the ending as wanted.
            exitReason: change.exitReason,
            endedAt: change.endedAt,
            pendingOperationId: undefined,
            pendingOperationKind: undefined,
            // A runtime of its own ran and exited, so nothing about this session is waiting for a
            // setup any more, whatever the record was still saying.
            pendingSetup: undefined,
          }
          // Where a stop the Host refused finally gets to file its session: the exit is here, and
          // the witness of who asked for it is on the record. Judged on the ENDED record, so the
          // Host's own word arriving with this change counts as well as the client's own mark.
          if (SessionLifecycle.completesOn(ended)) ended.completed = true
          if (await this.records.put(ended)) applied.push(change)
        }
      }
      else if (change.kind === 'mark-lost') {
        if (await this.markLost(change.sessionId)) applied.push(change)
      }
      else if (change.kind === 'retry-launch') {
        const landed = await this.replayLaunch(change)
        if (landed) applied.push(landed)
      }
      else if (change.kind === 'setup-succeeded') {
        const landed = await this.setupFlow.applySetupSucceeded(change.sessionId)
        if (landed) applied.push(landed)
      }
      else if (change.kind === 'setup-failed') {
        if (await this.setupFlow.applySetupFailed(change.sessionId, change.reason)) applied.push(change)
      }
      else if (change.kind === 'merge-resolve-succeeded') {
        // The resolver committed, so the merge can carry on from what it left in the worktree. It
        // is fired and not awaited on purpose: the merge does git work, and this loop holds the one
        // queue every operation shares. Its own idempotence is what makes that safe - it re-reads
        // the disk, so starting it twice does the remaining work once.
        if (this.resumeMerge) {
          this.resumeMerge(change.sessionId)
          applied.push(change)
        }
      }
      else if (change.kind === 'merge-resolve-failed') {
        if (await this.applyResolveFailed(change.sessionId, change.reason)) applied.push(change)
      }
      else if (change.kind === 'name-codex-conversation') {
        if (await this.applyCodexName(change.sessionId)) applied.push(change)
      }
      else
        throw new Error(`Unknown reconcile change: ${JSON.stringify(change)}`)
    }
    return applied
  }

  /**
   * The resolver did not finish cleanly. The PHASE stays `resolving` and the reason is written
   * beside it: the manual path is still open, and running Merge again after resolving by hand is
   * what finishes the job.
   */
  private async applyResolveFailed(sessionId: string, reason: string): Promise<boolean> {
    const record = this.records.get(sessionId)
    if (!record?.worktreeMerge) return false
    return this.records.put({
      ...record,
      worktreeMerge: { ...record.worktreeMerge, failure: reason },
    })
  }

  /** The binding named a runtime this Host answered it does not have, so it stops being true. */
  private async markLost(sessionId: string): Promise<boolean> {
    const record = this.records.get(sessionId)
    if (!record) return false
    const lost: SessionRecord = {
      ...record,
      life: 'lost',
      binding: null,
      pendingOperationId: undefined,
      pendingOperationKind: undefined,
      launchWait: undefined,
    }
    // The other way a refused stop ends up: the Host restarts before the exit is ever reported, so
    // the runtime is unfindable rather than dead. `lost` is what became of it, but somebody had
    // already said they were done with it, and that verdict is not weakened by losing the Host.
    if (SessionLifecycle.completesOn(lost)) lost.completed = true
    return this.records.put(lost)
  }

  private async applyBindLive(
    sessionId: string,
    binding: { hostInstanceId: string; generation: number },
  ): Promise<boolean> {
    const record = this.records.get(sessionId)
    if (!record) return false
    // A reconcile runs after every event, and most of them find nothing moved. Rewriting the file
    // each time would cost a write per event for no news at all.
    if (record.life === 'live'
      && record.pendingOperationId === undefined
      && record.binding?.hostInstanceId === binding.hostInstanceId
      && record.binding.generation === binding.generation)
      return false
    return this.records.put({
      ...record,
      binding,
      life: 'live',
      pendingOperationId: undefined,
      pendingOperationKind: undefined,
      launchWait: undefined,
      pendingSetup: undefined,
      endedAt: undefined,
      exitCode: undefined,
      endedReason: undefined,
      exitReason: undefined,
      // `stopRequested` deliberately survives a bind. Two judgements read it ahead of the exit code -
      // the install gate and the merge resolver - and neither reads `exitReason`, so it is the only
      // witness they have that a killed process reporting 0 on POSIX did not finish its work. A pass
      // that merely OBSERVES a runtime has no business erasing that; the two places that do erase it
      // are `reopen` and the create replay, where a new run is being launched on purpose.
    })
  }

  /**
   * The replay carries the operationId the record was written with, so a Host that already ran it
   * answers with what it did instead of starting a second process. A Host still holding that
   * operation is also still holding the runtime, which the reconciler would have found in the
   * listing - so this path only ever reaches a Host that has neither, and the rebuilt launch never
   * has to match a digest the Host remembers. It is always a create for the same reason: the Host
   * that would have taken a replace no longer has the runtime a replace names.
   *
   * What differs is the command line, and only the record can say which one. A create that never
   * ran has no conversation to resume, so it repeats the create it was; an interrupted reopen had
   * already chosen its resume, and repeating the create instead would start a second process under
   * an id its agent is already using.
   *
   * The change it hands back is the one that landed, which is not always the one it was asked for:
   * a record that cannot name the launch it was pending on is marked lost instead.
   */
  private async replayLaunch(
    change: Extract<ReconcileChange, { kind: 'retry-launch' }>,
  ): Promise<ReconcileChange | null> {
    const record = this.records.get(change.sessionId)
    if (!record) return null
    /*
     * Asked before anything is built, because building it would THROW: a reopen of a record whose
     * agent cannot name its conversation is refused by `AgentPresets`, and a record like that can
     * reach here from a hand edit or a half-written file - the store validates the `kind` enum and
     * nothing else. A throw here abandons the whole reconcile pass, every change queued behind this
     * record included. The record is lost instead, the way the reconciler already loses one whose
     * pending kind is missing rather than guessing which launch it meant.
     */
    const problem = record.agent
      ? SessionLifecycle.replayProblemOf(record.agent, change.operation)
      : null
    if (problem !== null)
      return await this.markLost(change.sessionId)
        ? { kind: 'mark-lost', sessionId: change.sessionId }
        : null
    const agentArgs = record.agent
      ? SessionLifecycle.replayArgsOf(record.agent, change.operation)
      : undefined
    const created = await this.host.runtimeCreate({
      operationId: change.operationId,
      runtimeSessionId: change.sessionId,
      // A replay is whatever the interrupted operation was, so the pending kind decides: a replayed
      // create founds the conversation and carries the model, a replayed reopen does not.
      launch: this.plannedLaunch(record, change.operation, { agentArgs }),
    })
    // A replay the Host decided nothing about keeps the pending pair: a later pass tries it under
    // the same id, once the wait this refusal just extended is up. A decision ends the record,
    // exactly as a decided first attempt does.
    if (!created.ok) {
      if (OperationOutcomes.decided(created)) await this.endRefused(record, created.detail)
      else await this.markLaunchWait(change.sessionId, created.detail)
      return null
    }
    await this.bindLive(record, created.value)
    return change
  }

  /** Whether the launch the pending pair asks for can be built at all, in the words of what refused it. */
  private static replayProblemOf(
    agent: SessionRecordAgent,
    operation: 'create' | 'reopen',
  ): string | null {
    // A create repeats what the record already stored, so there is nothing left to be unable to name.
    if (operation === 'create') return null
    else if (operation === 'reopen') return AgentPresets.reopenProblem(agent)
    else throw new Error(`Unknown pending operation: ${JSON.stringify(operation)}`)
  }

  private static replayArgsOf(
    agent: SessionRecordAgent,
    operation: 'create' | 'reopen',
  ): string[] {
    if (operation === 'create') return AgentPresets.replayArgs(agent)
    else if (operation === 'reopen') return AgentPresets.reopenArgs(agent)
    else throw new Error(`Unknown pending operation: ${JSON.stringify(operation)}`)
  }

  /** A session with a runtime of its own is not waiting for anything, so `pendingSetup` goes too. */
  private async bindLive(record: SessionRecord, result: RuntimeResult): Promise<boolean> {
    return this.records.put({
      ...record,
      binding: {
        hostInstanceId: result.hostInstanceId,
        generation: result.session.generation,
      },
      life: 'live',
      pendingOperationId: undefined,
      pendingOperationKind: undefined,
      launchWait: undefined,
      pendingSetup: undefined,
      endedAt: undefined,
      exitCode: undefined,
      endedReason: undefined,
      exitReason: undefined,
      // `stopRequested` survives a bind, for the reason `applyBindLive` gives.
    })
  }

  private async provisionWorktree(
    spec: SessionCreateSpec,
  ): Promise<GitResult<WorktreeFacts | null>> {
    if (!spec.worktree) return { ok: true, value: null }
    return this.worktrees.create(
      OperationOutcomes.projectRootOf(spec.directory),
      spec.worktree.slug,
      spec.worktree.baseRef,
    )
  }

  private recordOf(
    spec: SessionCreateSpec,
    sessionId: string,
    worktree: WorktreeFacts | null,
    operationId: string,
    marks?: { oneShot: true; resolveFor: string },
  ): SessionRecord {
    const agent = spec.agent ? this.recordAgentOf(spec.agent, sessionId, marks?.oneShot) : undefined
    const cwd = worktree?.worktreePath ?? LaunchPlanner.directoryOf(spec.directory)
    const record: SessionRecord = {
      sessionId,
      kind: spec.kind,
      title: spec.title?.trim() || SessionLifecycle.defaultTitle(cwd, agent),
      directory: spec.directory,
      binding: null,
      life: 'starting',
      pendingOperationId: operationId,
      pendingOperationKind: 'create',
      createdAt: this.now(),
    }
    if (agent) {
      record.agent = agent
      record.transcriptCwd = cwd
    }
    if (marks) record.resolveFor = marks.resolveFor
    if (spec.flowId) record.flowId = spec.flowId
    if (spec.presentation) record.presentation = spec.presentation
    if (worktree) record.worktree = worktree
    return record
  }

  private recordAgentOf(agent: SessionAgentSpec, sessionId: string, oneShot?: true): SessionRecordAgent {
    const nativeSessionId = agent.nativeSessionId
      ?? (AgentPresets.mintsNativeSessionId(agent) ? sessionId : undefined)
    const stored: SessionRecordAgent = { agentId: agent.agentId, launchMode: agent.mode }
    if (nativeSessionId) stored.nativeSessionId = nativeSessionId
    if (agent.forkParentId) stored.forkParentId = agent.forkParentId
    if (agent.initialPrompt) stored.initialPrompt = agent.initialPrompt
    // Resolved HERE rather than at the launch, and that is what makes the field readable at all: the
    // reader that draws the context window has the record and no way to reach a setting, so a model
    // left for `plannedLaunch` to read is one nothing can ask about afterwards. A caller that named
    // one still wins - it is answering for the machine that runs the session, not for this one.
    const model = agent.model ?? this.modelFor(agent.agentId)
    if (model) stored.model = model
    if (oneShot) stored.oneShot = oneShot
    return stored
  }

  /** What plan B displays is its own decision; what is stored is something readable to fall back on. */
  private static defaultTitle(cwd: string, agent: SessionRecordAgent | undefined): string {
    const name = basename(cwd) || cwd
    return agent ? `${name} (${agent.agentId})` : name
  }

  private static reopenRoute(
    known: RuntimeSessionInfo | undefined,
    hostInstanceId: string,
    sessionId: string,
  ): ReopenRoute {
    if (!known) return { kind: 'create' }
    if (known.alive) return { kind: 'live' }
    return {
      kind: 'replace',
      target: { hostInstanceId, runtimeSessionId: sessionId, generation: known.generation },
    }
  }

  private static specProblem(spec: SessionCreateSpec): string | null {
    if (!spec || typeof spec !== 'object') return 'a create spec is required'
    const directory = SessionLifecycle.directoryProblem(spec.directory)
    if (directory) return directory
    if (spec.worktree) {
      if (spec.directory.mode !== 'project')
        return 'a worktree can only be created for a project directory'
      if (!SessionLifecycle.filled(spec.worktree.slug)) return 'a worktree needs a slug'
    }
    const presentation = SessionLifecycle.presentationProblem(spec)
    if (presentation) return presentation
    if (spec.kind === 'shell') {
      if (spec.agent) return 'a shell session carries no agent'
      // A flow composes a first instruction, and a shell has nobody to give one to. The prompt
      // itself needs no check of its own: it lives inside `agent`, which a shell may not carry.
      if (spec.flowId) return 'a shell session is not composed by a flow'
      return null
    }
    else if (spec.kind === 'agent')
      return SessionLifecycle.agentProblem(spec.agent)
    else
      return `unknown session kind ${JSON.stringify(spec.kind)}`
  }

  /** A plain tab is a raw terminal in a directory: the two things it cannot be are isolated and composed. */
  private static presentationProblem(spec: SessionCreateSpec): string | null {
    if (spec.presentation === undefined) return null
    if (spec.presentation !== 'tab')
      return `unknown presentation ${JSON.stringify(spec.presentation)}`
    if (spec.worktree) return 'a plain tab runs without isolation, so it cannot carry a worktree'
    if (spec.flowId) return 'a plain tab is not composed by a flow'
    return null
  }

  private static agentProblem(agent: SessionAgentSpec | undefined): string | null {
    if (!agent) return 'an agent session needs an agent'
    if (agent.agentId !== 'claude' && agent.agentId !== 'codex')
      return `unknown agent ${JSON.stringify(agent.agentId)}`
    if (agent.mode !== 'new' && agent.mode !== 'continue'
      && agent.mode !== 'resume' && agent.mode !== 'fork')
      return `unknown launch mode ${JSON.stringify(agent.mode)}`
    if (agent.mode === 'resume' && !SessionLifecycle.filled(agent.nativeSessionId))
      return 'resuming needs the id of the session to resume'
    if (agent.mode === 'fork' && !SessionLifecycle.filled(agent.forkParentId))
      return 'forking needs the id of the session to fork'
    // Codex cannot be told an id before it starts, so one handed in with `new` or `fork` names a
    // conversation nobody proved exists, and every reopen and every transcript reader would trust
    // it. Only `resume` names one that already does. Claude is not refused: a caller minting the id
    // is the same act this library performs.
    if (agent.agentId === 'codex'
      && (agent.mode === 'new' || agent.mode === 'fork')
      && agent.nativeSessionId !== undefined)
      return 'a codex session started as new or fork cannot be given a conversation id; Codex reports it afterwards'
    return null
  }

  private static historyOpenProblem(spec: SessionHistoryOpenSpec): string | null {
    const directoryProblem = SessionLifecycle.directoryProblem(spec.directory)
    if (directoryProblem) return directoryProblem
    if (spec.directory.mode !== 'project') return 'history needs a catalog project'
    if (spec.agentId !== 'claude' && spec.agentId !== 'codex')
      return `unknown agent ${JSON.stringify(spec.agentId)}`
    if (!SessionLifecycle.filled(spec.nativeSessionId))
      return 'opening history needs the id of the session to open'
    if (!SessionLifecycle.filled(spec.providerName))
      return 'opening history needs the provider session name'
    if (typeof spec.providerActive !== 'boolean')
      return 'opening history needs the provider activity state'
    return null
  }

  private static isProjectRecord(record: SessionRecord, projectPath: string): boolean {
    return record.directory.mode === 'project' && record.directory.projectPath === projectPath
  }

  private static directoryProblem(directory: SessionCreateSpec['directory']): string | null {
    if (!directory || typeof directory !== 'object') return 'a directory is required'
    if (directory.mode === 'project')
      return SessionLifecycle.filled(directory.categoryId)
        && SessionLifecycle.filled(directory.projectPath)
        ? null
        : 'a project directory needs a categoryId and a projectPath'
    else if (directory.mode === 'adHoc')
      return SessionLifecycle.filled(directory.path) ? null : 'an adHoc directory needs a path'
    else if (directory.mode === 'default')
      return null
    else
      return `unknown directory mode ${JSON.stringify((directory as { mode?: unknown }).mode)}`
  }

  private static filled(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
  }

  /**
   * A create that cut its worktree and then could not write the record naming it. The directory and
   * the branch are on disk, nothing on disk points at them any more, and the slug they took is
   * refused as `worktree-exists` to the next create over it - so they are named out loud, on the
   * same error channel `remove` and `applySetupFailed` already use for what they leave behind.
   * Undoing them here is the one thing this must not do: `git worktree remove --force` over work
   * nobody has looked at is not a decision a failed write is entitled to take.
   */
  private unrecordedWorktree(
    facts: WorktreeFacts,
  ): { ok: false; code: SessionsOpErrorCode; detail: string } {
    const left = `the worktree ${facts.worktreePath} and the branch ${facts.branch} are left in `
      + facts.repositoryRoot
    this.report(
      `A session could not be recorded, so ${left} with nothing naming them; they are yours to keep `
      + 'or remove, and the same slug is refused to the next create over it',
    )
    return {
      ok: false,
      code: 'records-latched',
      detail: 'The session records could not be written, so this session was never recorded - but '
        + `its worktree had already been created, and ${left}; why the write failed is on the error `
        + 'channel',
    }
  }

}
