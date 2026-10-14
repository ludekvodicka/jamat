import { basename, dirname } from 'node:path'

import type { SvnConflictJournal, SvnRoot, SvnWorktreeStatus } from '../../svn/svn.types'
import type { SvnConflictResolutions } from '../../svn/svnConflictResolutions'
import { SvnWorktreeEvidence } from '../../svn/svnWorktreeEvidence'
import { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import { ErrorText } from '../../shared/errorText'
import { ReviewRunExit } from '../../shared/reviewRunExit'
import type {
  SessionRecord,
  SessionRecordScriptStep,
  SessionRecordSvnAction,
  SessionRecordWorktree,
  SvnActionConflictSet,
  SvnActionRoot,
  SvnActionVerdict,
} from '../records/sessionRecord.types'
import type { SessionRecordsStore } from '../records/sessionRecordsStore'
import { type WorktreeResultRecord, type WorktreeResultsPort, WorktreeResultsStore } from '../results/worktreeResultsStore'
import { ScriptChain } from '../scripts/scriptChain'
import { ScriptRunRecords } from '../scripts/scriptRunRecords'
import { SessionScriptDefinitions } from '../scripts/sessionScriptDefinitions'
import type {
  SessionActivity,
  SessionConflictResolved,
  SessionCreateSpec,
  SessionFinishPress,
  SessionsOpResult,
  SessionWorktreeOutcome,
  SvnActionKind,
  SvnActionNeed,
  SvnConflictActor,
  SvnConflictResolveRequest,
  SvnFinishWorktreeResult,
  SvnLabelledRevision,
  WorktreeResultKind,
} from '../sessionManagerApi.types'
import type { FinishScriptsFlow } from './finishScriptsFlow'
import { OperationOutcomes } from './operationOutcomes'
import { ScriptRunLauncher } from './scriptRunLauncher'
import type { SessionSteps } from './sessionSteps'
import type { SessionInternalMarks } from './sessionLifecycle'
import { LandedRows } from './landedRows'
import { SvnActionStages } from './svnActionStages'
import { SvnConflictFlow } from './svnConflictFlow'
import { SvnConflictWords } from './svnConflictWords'
import { SvnMergerLauncher } from './svnMergerLauncher'
import { SvnResolverLauncher, type SvnResolverPort } from './svnResolverLauncher'
import { SvnRevisionLabels } from './svnRevisionLabels'
import { SvnWorktreeRemoval } from './svnWorktreeRemoval'
import type { WorktreeEnded } from './worktreeFinish.types'
import { WorktreeCleanupPacing } from './worktreeCleanupPacing'

/** The svn reads an action decides its next stage with, named so a test can hand it a scripted set. */
export type SvnActionPort = Pick<SvnWorktreeManager,
  | 'ownerCheck' | 'scheduleMissing' | 'revisionOf' | 'status' | 'changes' | 'resolveWorking' | 'incoming' | 'locked'
  | 'reviewRoots' | 'fingerprint' | 'lowerBounds' | 'conflictSet' | 'logOf' | 'hashes' | 'baseAbove'>

/** What `SessionManager` hands the lifecycle for its SVN actions. */
export interface SvnActionPorts {
  svn: SvnActionPort
  labels: Pick<SvnRevisionLabels, 'ownCommits' | 'afterReview' | 'inferred'>
  removal: Pick<SvnWorktreeRemoval, 'remove'>
  resolver: SvnResolverPort
  /** The option executor that settles a conflicted path at Check again. */
  resolutions: Pick<SvnConflictResolutions, 'apply'>
  /** Where every ending writes its durable result, and where the saved copies of its conflicts go. */
  results: WorktreeResultsPort
  /** Commit opens reviews in the commit dialog through the Jamat CLI; null when both are there. */
  finishRefusal: () => SessionsOpResult<never> | null
  activityOf: (sessionId: string) => SessionActivity | null
  ended: WorktreeEnded
  /**
   * A committed ending left a landed row, or an UPDATE ended: the main copy is read again at once,
   * whether it holds what its landed rows wait for, and how far behind HEAD it is.
   */
  landedDue: (mainCopy: string) => void
  /**
   * A committed Finish used the worker's commit message proposals for the roots it reviewed, so they
   * go; Keep, a Finish that committed nothing and Discard leave them.
   */
  proposalsSpent: (sessionId: string, scopeRoots: readonly string[]) => void
  /** Runs a client stage off the caller: it reads svn, and the reconcile loop must not wait for it. */
  detach: (work: Promise<unknown>, what: string) => void
  /** The record moved outside an operation, so the snapshot is composed again. */
  changed: () => void
  /** What this client does for the session now, one step before each client read. */
  steps: Pick<SessionSteps, 'at' | 'clear'>
}

export interface SvnActionFlowDeps extends SvnActionPorts {
  records: SessionRecordsStore
  runs: Pick<ScriptRunLauncher, 'launch'>
  /** The resolver and the merger are agent sessions, created as the merge resolver is: the create writes their record. */
  createResolver: (spec: SessionCreateSpec, marks: SessionInternalMarks) => Promise<SessionsOpResult<{ sessionId: string }>>
  stopRun: (runId: string) => Promise<boolean>
  checks: Pick<FinishScriptsFlow, 'declaredAfter'>
  stop: (sessionId: string) => Promise<SessionsOpResult>
  report: (message: string) => void
  newId: () => string
  now: () => number
}

/**
 * Finish (Commit) and Discard of an SVN worktree, and UPDATE of a main copy, as a chain of stages on
 * the session record.
 *
 * A run stage is a Host runtime the session waits on through the `action` gate: a check of the
 * project, `svn update`, `svn cleanup`, or a review run that hosts the commit split. Its verdict is
 * written on the action, and the next client step reads the disk and picks the next stage: the
 * status XML for conflicts, `svn log -v` for incoming commits, the review roots for what is left.
 * Client stages are short writes of this client: stop the session, read the evidence, remove the
 * worktree, record the ending. A press, a verdict and the reconcile change `svn-action-due` drive
 * them, so a client restart continues from the record and the disk.
 *
 * Landing is the commit from the worktree and nothing else: a Finish never writes the main copy. A
 * committed Finish leaves a landed row, and UPDATE is the one action that updates a main copy: an
 * `svn update` run in it (a lock is waited out, never cleaned up), the resolver for text conflicts,
 * and a visible `svn diff` of the files it resolved. A stop is a state that waits for the person,
 * never a lost worktree: only a worktree with nothing left in it is removed, and only Discard throws
 * changes away.
 */
export class SvnActionFlow {
  static readonly stopLimitMillisecondsConst = 60_000
  private static readonly incomingRoundsConst = 2
  private static readonly outOfDateRoundsConst = 2
  private static readonly stepsPerDriveConst = 32
  private static readonly listedPathsConst = 20
  /** Paths one diff run names, so its command line stays below the Windows limit. */
  private static readonly diffPathsConst = 100
  private readonly records: SessionRecordsStore
  private readonly svn: SvnActionPort
  private readonly conflicts: SvnConflictFlow
  private readonly labels: SvnActionPorts['labels']
  private readonly removal: SvnActionPorts['removal']
  private readonly resolver: SvnResolverPort
  private readonly results: WorktreeResultsPort
  private readonly finishRefusal: () => SessionsOpResult<never> | null
  private readonly activityOf: (sessionId: string) => SessionActivity | null
  private readonly ended: WorktreeEnded
  private readonly landedDue: (mainCopy: string) => void
  private readonly proposalsSpent: SvnActionPorts['proposalsSpent']
  private readonly detach: (work: Promise<unknown>, what: string) => void
  private readonly changed: () => void
  private readonly steps: Pick<SessionSteps, 'at' | 'clear'>
  private readonly runs: Pick<ScriptRunLauncher, 'launch'>
  private readonly createResolver: SvnActionFlowDeps['createResolver']
  private readonly stopRun: (runId: string) => Promise<boolean>
  private readonly checks: Pick<FinishScriptsFlow, 'declaredAfter'>
  private readonly stop: (sessionId: string) => Promise<SessionsOpResult>
  private readonly report: (message: string) => void
  private readonly newId: () => string
  private readonly now: () => number
  /** The drives in flight by session; the reconciler asks for none of them again meanwhile. */
  private readonly driving = new Map<string, Promise<void>>()
  /** How the removal of each action that ended in this process went, for a Discard that waits for it. */
  private readonly endings = new Map<string, SvnFinishWorktreeResult>()
  /**
   * The actions whose Resolve with agent press waits for their `fixing` step. A restart forgets the
   * press, and that step then waits for the person, who presses again.
   */
  private readonly agentPresses = new Set<string>()

  constructor(deps: SvnActionFlowDeps) {
    this.records = deps.records
    this.svn = deps.svn
    this.conflicts = new SvnConflictFlow({
      svn: deps.svn,
      briefs: deps.resolver.briefs,
      handover: deps.results,
      resolutions: deps.resolutions,
      savedDirectoryOf: (actionId) => deps.results.savedDirectoryOf(actionId),
      withMarkers: (root, paths) => deps.resolver.withMarkers(root, paths),
      unavailable: () => deps.resolver.unavailable(),
      now: deps.now,
    })
    this.labels = deps.labels
    this.removal = deps.removal
    this.resolver = deps.resolver
    this.results = deps.results
    this.finishRefusal = deps.finishRefusal
    this.activityOf = deps.activityOf
    this.ended = deps.ended
    this.landedDue = deps.landedDue
    this.proposalsSpent = deps.proposalsSpent
    this.detach = deps.detach
    this.changed = deps.changed
    this.steps = deps.steps
    this.runs = deps.runs
    this.createResolver = deps.createResolver
    this.stopRun = deps.stopRun
    this.checks = deps.checks
    this.stop = deps.stop
    this.report = deps.report
    this.newId = deps.newId
    this.now = deps.now
  }

  /** Whether an action holds the session: one that runs, not one that waits for the person. */
  static running(record: SessionRecord): boolean {
    return record.svnAction !== undefined && record.svnAction.needs === undefined
  }

  /**
   * A press of Finish. It answers once the action is written; the stages go on without the caller.
   * A waiting action takes Finish again (from the evidence, or straight to the review when the
   * checks passed on this very worktree), Keep (ends it) and Discard (a new action that removes).
   * While an agent works for a running action, Keep and Discard stop its run first and then go the
   * way of a waiting action; the stopped run's verdict lands on no action, because no action names it.
   */
  async start(sessionId: string, press: SessionFinishPress): Promise<SessionsOpResult<{ actionId: string | null }>> {
    let record = this.records.get(sessionId)
    if (!record) return OperationOutcomes.notFound(sessionId)
    if (this.records.latched) return OperationOutcomes.latched()
    const worktree = record.worktree
    if (worktree?.kind !== 'svn')
      return { ok: false, code: 'invalid-spec', detail: `Session ${sessionId} has no SVN worktree` }
    let current = record.svnAction
    const choice = press.choice
    // The running action an agent works for, which this press takes over once its agent stopped.
    let replaces: string | undefined
    if (current !== undefined && current.needs === undefined) {
      const agentRun = SvnActionStages.agentRunOf(current)
      // Commit while the merger works is Check again: what the person settled counts, the merger goes on.
      if (choice === 'commit' && current.stage === 'merging' && agentRun !== null) return this.checkWhileMerging(sessionId, current.actionId)
      if (agentRun === null || (choice !== 'keep' && choice !== 'discard'))
        return { ok: false, code: 'merge-pending', detail: `An SVN ${current.kind} of session ${sessionId} is ${current.stage}; wait for it to end` }
      const stopped = await this.stopAgent(sessionId, current, agentRun)
      if (!stopped.ok) return stopped
      record = stopped.value
      current = record.svnAction
      replaces = current?.actionId
    }
    let kind: SvnActionKind
    if (choice === 'keep') return this.keep(record)
    else if (choice === 'merge')
      return { ok: false, code: 'invalid-spec', detail: `Session ${sessionId} has an SVN worktree, which Commit lands; there is no merge` }
    else if (choice === 'commit') {
      const refusal = this.finishRefusal() ?? (press.agent === true ? this.agentRefusal(sessionId, current) : null)
      if (refusal) return refusal
      kind = 'finish'
    }
    else if (choice === 'discard') kind = 'discard'
    else throw new Error(`Unknown finish choice: ${JSON.stringify(choice satisfies never)}`)
    const live = record.life === 'live' || record.life === 'starting'
    if (live && this.activityOf(sessionId) === 'working' && press.confirmWorking !== true)
      return {
        ok: false,
        code: 'session-working',
        detail: `Session ${sessionId} is still working${record.note === undefined ? '' : ` (${record.note})`}; finish it anyway, or wait until it is ready`,
      }
    let checks: SessionRecordScriptStep[] = []
    if (kind === 'finish') {
      // One read of the main copy's `.worktree.json`: the steps run as they were agreed to now.
      const declared = await this.checks.declaredAfter(record, press.acknowledgeSetup)
      if (!declared.ok) return declared.result
      checks = declared.steps.map(SvnActionFlow.checkOf)
    }
    const now = this.now()
    const action = kind === 'finish' && current !== undefined
      ? SvnActionFlow.resumed(current, press, checks, now, live)
      : SvnActionFlow.fresh(worktree, kind, press, checks, this.newId(), now, live, current?.evidence ?? [])
    const written = await this.records.update(sessionId, (latest) => SvnActionFlow.running(latest) && latest.svnAction?.actionId !== replaces
      ? null
      // A Git-era chain on an SVN record goes with the first SVN action.
      : { ...latest, svnAction: SvnActionFlow.movedOf(latest.svnAction, action, now), finishChecks: undefined })
    if (!written) return OperationOutcomes.latched()
    this.changed()
    if (press.agent === true) this.agentPresses.add(action.actionId)
    if (action.stage === 'stopping') {
      const stopped = await this.stop(sessionId)
      if (!stopped.ok) this.report(`Session ${sessionId}: the ${kind} could not stop the session (${stopped.detail}); it waits for its end`)
    }
    this.due(sessionId)
    return { ok: true, value: { actionId: action.actionId } }
  }

  /**
   * Why Resolve with agent cannot start a merger on this action, or null: it needs a Finish that waits
   * on its conflicts, a path an agent may settle among them, and a Claude on this machine.
   */
  private agentRefusal(sessionId: string, current: SessionRecordSvnAction | undefined): SessionsOpResult<never> | null {
    const set = current?.conflictSet
    if (current === undefined || current.kind !== 'finish' || current.needs?.kind !== 'conflict' || !SvnConflictFlow.unsettled(set))
      return { ok: false, code: 'invalid-spec', detail: `Resolve with agent needs a Finish of session ${sessionId} that waits on its conflicts` }
    if (!set.entries.some(SvnMergerLauncher.forAgent))
      return { ok: false, code: 'invalid-spec', detail: `No conflict of session ${sessionId} is one an agent may settle; settle them yourself, then press Check again` }
    const unavailable = this.resolver.unavailable()
    return unavailable === null ? null : { ok: false, code: 'invalid-spec', detail: `No merger runs here: ${unavailable}` }
  }

  /**
   * Check again while the merger works, under the drive: the set is read again, what the person
   * settled by hand counts as theirs, and when nothing is left open the merger's run is stopped, whose
   * verdict takes the Finish on. Otherwise the merger goes on with the rest.
   */
  private async checkWhileMerging(sessionId: string, actionId: string): Promise<SessionsOpResult<{ actionId: string | null }>> {
    return this.underDrive(sessionId, async () => {
      const parent = this.records.get(sessionId)
      const action = parent?.svnAction
      const runId = action === undefined ? null : SvnActionStages.agentRunOf(action)
      if (!parent || action?.actionId !== actionId || action.stage !== 'merging' || action.needs !== undefined || runId === null)
        return { ok: false, code: 'merge-pending', detail: `The SVN Finish of session ${sessionId} moved on while it was checked; press again` }
      this.steps.at(sessionId, { kind: 'read', read: 'conflicts' })
      const checked = await this.conflicts.recheck(action, (fix) => this.steps.at(sessionId, { kind: 'fixing', ...fix }))
      if (!checked.ok) return { ok: false, code: 'svn-failed', detail: `svn cannot report the conflicts of ${action.root}: ${checked.detail}` }
      if (!await this.write(parent, { ...action, conflictSet: checked.value })) return OperationOutcomes.latched()
      if (!SvnConflictFlow.unsettled(checked.value)) this.detach(this.stopRun(runId), `The merger ${runId} of session ${sessionId}`)
      return { ok: true, value: { actionId } }
    })
  }

  /**
   * UPDATE of a main copy, as an action of the session that asked for it: a landed row, or any
   * session (a coordinator) in that main copy. It answers once the update run is launched. A waiting
   * UPDATE of the same session gives way to the new one; any other action of it refuses.
   */
  async startUpdate(sessionId: string, mainCopy: string, requestedBy: SessionFinishPress['requestedBy'])
    : Promise<SessionsOpResult<{ actionId: string }>> {
    const record = this.records.get(sessionId)
    if (!record) return OperationOutcomes.notFound(sessionId)
    if (this.records.latched) return OperationOutcomes.latched()
    const current = record.svnAction
    if (current !== undefined && (current.needs === undefined || current.kind !== 'update-main'))
      return { ok: false, code: 'merge-pending', detail: `An SVN ${current.kind} of session ${sessionId} is ${current.stage}; wait for it to end` }
    const action: SessionRecordSvnAction = {
      kind: 'update-main',
      actionId: this.newId(),
      stage: 'updating',
      root: mainCopy,
      checks: [],
      checkCursor: 0,
      rootCursor: 0,
      rounds: { incoming: 0, outOfDate: 0, lock: 0 },
      evidence: [],
      requestedBy,
      startedAt: this.now(),
      stageAt: this.now(),
    }
    const written = await this.records.update(sessionId, (latest) => SvnActionFlow.running(latest) ? null : { ...latest, svnAction: action })
    if (!written) return OperationOutcomes.latched()
    this.changed()
    const latest = this.records.get(sessionId)
    // Outside a drive, so no drive's end clears the steps of its reads.
    try { if (latest !== null) await this.launch(latest, action) }
    finally { if (this.steps.clear(sessionId)) this.changed() }
    return { ok: true, value: { actionId: action.actionId } }
  }

  /**
   * The verdict of the run a run stage waits on, written on the action; the next client step judges
   * it off the reconcile loop. Not while the run's own record still says it runs: the verdict is read
   * off the Host's dead runtime in the same pass that marks that record ended, and its exit code is
   * what a review run says.
   */
  async noteVerdict(parentId: string, verdict: { kind: 'succeeded' } | { kind: 'failed'; reason: string }): Promise<boolean> {
    const parent = this.records.get(parentId)
    const action = parent?.svnAction
    if (!parent || !action?.runId || !SessionScriptDefinitions.judging('action', parent)) return false
    const runId = action.runId
    const run = this.records.get(runId)
    if (run?.life === 'live' || run?.life === 'starting') return false
    // The resolver's pointer is written before the create writes its record, so a pass between the two
    // finds no record; while this process drives the action that is a run on its way, not a gone one.
    if (run === null && this.driving.has(parentId)) return false
    const exitCode = run?.exitCode ?? parent.scriptRuns?.find((entry) => entry.runId === runId)?.exitCode
    const recorded: SvnActionVerdict = verdict.kind === 'succeeded'
      ? { kind: 'succeeded', ...exitCode === undefined ? {} : { exitCode } }
      : { kind: 'failed', reason: verdict.reason, ...exitCode === undefined ? {} : { exitCode } }
    const written = await this.records.update(parentId, (latest) => {
      const now = latest.svnAction
      return now?.runId === runId && now.verdict === undefined && now.needs === undefined
        ? { ...latest, svnAction: { ...now, verdict: recorded } }
        : null
    })
    if (written) this.due(parentId)
    return written
  }

  /**
   * One option on one conflicted path of a waiting Finish (`sessions.resolveConflict`), under the
   * session's drive: it waits for a drive in flight and holds the session while it runs, so no stage
   * moves beside it. Each step's journal is on the record before the next step starts; the settled
   * set is written in one move, and the action keeps waiting until Check again.
   */
  async resolveConflict(sessionId: string, request: SvnConflictResolveRequest & { by: SvnConflictActor })
    : Promise<SessionsOpResult<SessionConflictResolved>> {
    return this.underDrive(sessionId, async () => {
      const parent = this.records.get(sessionId)
      if (!parent) return OperationOutcomes.notFound(sessionId)
      if (this.records.latched) return OperationOutcomes.latched()
      const action = parent.svnAction
      if (action === undefined || !SvnConflictFlow.open(action.conflictSet))
        return { ok: false, code: 'not-found', detail: `Session ${sessionId} has no conflicts of an SVN action` }
      const resolved = await this.conflicts.resolve(action, request, (path, journal) => this.noteJournal(sessionId, action.actionId, path, journal))
      if (!resolved.ok) return resolved
      if (!await this.write(parent, resolved.value.action)) return OperationOutcomes.latched()
      // The last settlement ends the merger's stage: its run is stopped after this answer went out,
      // and its verdict takes the Finish on.
      const merger = SvnActionStages.agentRunOf(action)
      if (action.stage === 'merging' && merger !== null && resolved.value.left === 0)
        this.detach(this.stopRun(merger), `The merger ${merger} of session ${sessionId}`)
      return { ok: true, value: { sessionId, path: request.path, state: resolved.value.state, left: resolved.value.left } }
    })
  }

  /** The step an option reached on one path, on the record before the next step starts. */
  private async noteJournal(sessionId: string, actionId: string, path: string, journal: SvnConflictJournal): Promise<void> {
    await this.records.update(sessionId, (latest) => {
      const now = latest.svnAction
      const set = now?.conflictSet
      if (now?.actionId !== actionId || set === undefined) return null
      return { ...latest, svnAction: { ...now, conflictSet: { ...set, entries: set.entries.map((entry) => entry.path === path ? { ...entry, journal } : entry) } } }
    })
  }

  /** Waits for every drive in flight, then holds the session as a drive does until `work` ended. */
  private async underDrive<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    for (let running = this.driving.get(sessionId); running !== undefined; running = this.driving.get(sessionId)) await running
    const result = work()
    const held = result.then(() => undefined, () => undefined)
    this.driving.set(sessionId, held)
    try {
      return await result
    } finally {
      if (this.driving.get(sessionId) === held) this.driving.delete(sessionId)
      if (this.steps.clear(sessionId)) this.changed()
    }
  }

  /** Drives the client stages of a session's action, detached. */
  due(sessionId: string): void {
    this.detach(this.drive(sessionId), `The SVN action of session ${sessionId}`)
  }

  /** The sessions this process drives now; the reconciler leaves them alone. */
  held(): ReadonlySet<string> {
    return new Set(this.driving.keys())
  }

  /** One drive per session at a time; a second call joins the one in flight. */
  drive(sessionId: string): Promise<void> {
    const running = this.driving.get(sessionId)
    if (running !== undefined) return running
    const work = this.driveSteps(sessionId).finally(() => {
      this.driving.delete(sessionId)
      // A step never outlives its drive.
      if (this.steps.clear(sessionId)) this.changed()
    })
    this.driving.set(sessionId, work)
    return work
  }

  /**
   * Drives until the action waits on a run, on the person or on nothing more. A caller that has to
   * answer with the ending (the Discard of `sessions.discardWorktree`) waits here.
   */
  async settled(sessionId: string): Promise<SvnFinishWorktreeResult | null> {
    for (;;) {
      const before = this.records.get(sessionId)?.svnAction
      await this.drive(sessionId)
      const after = this.records.get(sessionId)?.svnAction
      if (after === undefined) return before === undefined ? null : this.endings.get(before.actionId) ?? null
      if (after === before || after.needs !== undefined || !SvnActionStages.clientDue(after)) return null
    }
  }

  /** How the removal of an action that ended in this process went. */
  endingOf(actionId: string): SvnFinishWorktreeResult | null {
    return this.endings.get(actionId) ?? null
  }

  private async driveSteps(sessionId: string): Promise<void> {
    for (let step = 0; step < SvnActionFlow.stepsPerDriveConst; step += 1) {
      const parent = this.records.get(sessionId)
      const action = parent?.svnAction
      if (!parent || action === undefined || action.needs !== undefined) return
      let moved: boolean
      try {
        moved = await this.step(parent, action)
      } catch (error) {
        await this.failed(sessionId, action, error)
        return
      }
      if (!moved) return
    }
  }

  /** One step; false when nothing moved, so the drive ends. */
  private async step(parent: SessionRecord, action: SessionRecordSvnAction): Promise<boolean> {
    if (action.verdict !== undefined) {
      await this.judge(parent, action, action.verdict)
      return true
    }
    const stage = action.stage
    switch (stage) {
      case 'stopping': return this.stopping(parent, action)
      case 'evidence':
        await this.evidence(parent, action)
        return true
      case 'verifying':
        await this.verifying(parent, action)
        return true
      case 'fixing':
        await this.fixing(parent, action)
        return true
      case 'removing':
        await this.removing(parent, action)
        return true
      case 'recording':
        await this.recording(parent, action)
        return false
      case 'checks': case 'updating': case 'cleaning': case 'resolving': case 'merging': case 'diffing': case 'reviewing':
        if (SvnResolverLauncher.overdue(action, this.now())) {
          await this.resolverOverdue(parent, action)
          return true
        }
        if (action.retryAt === undefined || this.now() < action.retryAt) return false
        await this.launch(parent, { ...action, retryAt: undefined })
        return true
      default:
        throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  private async stopping(parent: SessionRecord, action: SessionRecordSvnAction): Promise<boolean> {
    if (parent.life === 'live' || parent.life === 'starting') {
      if (this.now() - action.startedAt <= SvnActionFlow.stopLimitMillisecondsConst) return false
      await this.needs(parent, action, 'not-stopped',
        `the session did not stop within ${SvnActionFlow.stopLimitMillisecondsConst / 1_000} s; stop it, then press Finish again`)
      return true
    }
    // Check again on a conflict wait goes back to the conflicts, never to the evidence; any other
    // Finish again dropped the set (`resumed`).
    await this.advance(parent, { ...action, stage: action.kind === 'finish' && SvnConflictFlow.open(action.conflictSet) ? 'fixing' : 'evidence' })
    return true
  }

  /**
   * Before any update erases it: what this worktree committed itself, and the receipts of its split.
   * A worktree already gone has nothing left to judge. Finish again goes straight to the review when
   * the checks passed on this very worktree.
   */
  private async evidence(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    const worktree = parent.worktree
    if (worktree === undefined)
      return this.advance(parent, { ...action, stage: 'recording', removal: parent.retiredWorktree === undefined ? 'kept' : 'removed' })
    if (action.kind === 'finish') {
      this.steps.at(parent.sessionId, { kind: 'read', read: 'owner' })
      const checked = await this.svn.ownerCheck(SvnWorktreeRemoval.locationOf(worktree))
      if (!checked.ok) return this.needs(parent, action, 'svn-failed', `REFUSED: ${checked.detail}`)
    }
    this.steps.at(parent.sessionId, { kind: 'read', read: 'own-commits' })
    const own = await this.labels.ownCommits(action.root, parent.commitReceipts, parent.createdAt, (read) => {
      const step = SvnRevisionLabels.stepOf(read)
      this.steps.at(parent.sessionId, step.facts, step.progress)
    })
    if (!own.ok && action.kind === 'finish')
      return this.needs(parent, action, 'svn-failed', `svn cannot report the state of ${action.root}: ${own.detail}`)
    const next = { ...action, evidence: SvnRevisionLabels.merged(action.evidence, own.ok ? own.value : []) }
    if (next.kind === 'discard') return this.advance(parent, { ...next, stage: 'removing' })
    if (next.checksPassed !== undefined) {
      this.steps.at(parent.sessionId, { kind: 'read', read: 'fingerprint' })
      const fingerprint = await this.svn.fingerprint(next.root)
      if (fingerprint.ok && fingerprint.value === next.checksPassed.fingerprint) return this.toReview(parent, next)
    }
    const fresh = { ...next, checksPassed: undefined, checkCursor: 0 }
    return this.launch(parent, fresh.checks.length > 0 ? { ...fresh, stage: 'checks' } : { ...fresh, stage: 'updating' })
  }

  /** The branch table of a run's verdict: what the disk says now picks the next stage. */
  private async judge(parent: SessionRecord, action: SessionRecordSvnAction, verdict: SvnActionVerdict): Promise<void> {
    const stage = action.stage
    switch (stage) {
      case 'checks': {
        const check = action.checks[action.checkCursor]
        if (verdict.kind === 'failed')
          return this.needs(parent, action, 'check-failed', `the check ${check.name} failed (${verdict.reason}); its output is under Scripts`)
        return action.checkCursor + 1 < action.checks.length
          ? this.launch(parent, { ...action, checkCursor: action.checkCursor + 1 })
          : this.launch(parent, { ...action, stage: 'updating' })
      }
      case 'updating': return this.updated(parent, action, verdict)
      case 'cleaning':
        if (verdict.kind === 'failed')
          return this.needs(parent, action, 'locked', `svn cleanup of ${action.root} failed (${verdict.reason}); run it in an SVN client, then press Finish again`)
        return this.launch(parent, { ...action, stage: 'updating' })
      // Verified whatever its exit code: a resolver that exits 1 may have left clean files, one that exits 0 may not.
      case 'resolving': return this.advance(parent, { ...action, stage: 'verifying' })
      // Judged whatever its exit code: `fixing` reads what the merger left, as at Check again.
      case 'merging': return this.advance(parent, SvnActionFlow.mergerEnded(action, this.now()))
      // The diff only shows the merge; the update and the resolution are done whatever it printed.
      case 'diffing': return this.advance(parent, { ...action, stage: 'recording' })
      case 'reviewing': return this.reviewed(parent, action, verdict)
      case 'stopping': case 'evidence': case 'verifying': case 'fixing': case 'removing': case 'recording':
        throw new Error(`The client stage ${stage} waits on no run`)
      default:
        throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  /**
   * After the update. A working-copy lock is waited out on the lock pace, then `svn cleanup` runs
   * once in the worktree; a main copy is never cleaned up, because the lock may be another client's
   * work in progress. Any other ending, a failed one too, reads every conflict the update left as one
   * set, so no conflict hides another. A Finish takes the set to `fixing`, where the rules run first;
   * an UPDATE gives a set of text conflicts only to the resolver, and any other kind waits for the
   * person with the whole list. Incoming commits to a project of the change set
   * run the checks again, because they passed without them; without checks, or past the limit, the
   * person decides. An UPDATE with no conflict left is recorded.
   */
  private async updated(parent: SessionRecord, action: SessionRecordSvnAction, verdict: SvnActionVerdict): Promise<void> {
    const mainCopy = SvnActionFlow.inMainCopy(action.kind)
    const again = SvnActionFlow.againOf(action.kind)
    const checkAgain = SvnActionFlow.checkAgainOf(action.kind)
    if (verdict.kind === 'failed') {
      this.steps.at(parent.sessionId, { kind: 'read', read: 'lock' })
      const locked = await this.svn.locked(action.root)
      const delays = SvnWorktreeManager.lockRetryDelaysConst
      const lock = action.rounds.lock
      if (locked && lock < delays.length) {
        await this.write(parent, { ...action, verdict: undefined, rounds: { ...action.rounds, lock: lock + 1 }, retryAt: this.now() + delays[lock] })
        return
      }
      if (locked && mainCopy)
        return this.needs(parent, action, 'locked', `${action.root} is locked by another svn client; let it finish, or run svn cleanup there yourself, then ${again}`)
      if (locked && lock === delays.length)
        return this.launch(parent, { ...action, stage: 'cleaning', rounds: { ...action.rounds, lock: lock + 1 } })
      if (locked)
        return this.needs(parent, action, 'locked', `${action.root} is still locked after svn cleanup; close what works in it, then ${again}`)
    }
    this.steps.at(parent.sessionId, { kind: 'read', read: 'conflicts' })
    const read = await this.conflicts.read(action)
    if (!read.ok) return this.needs(parent, action, 'svn-failed', `svn cannot report the conflicts of ${action.root}: ${read.detail}`)
    const set = read.value
    if (verdict.kind === 'failed' && !SvnConflictFlow.open(set))
      return this.needs(parent, action, 'svn-failed', `svn update of ${action.root} failed (${verdict.reason}); its log is under Scripts`)
    const next = SvnActionFlow.withSet(action, set)
    if (SvnConflictFlow.open(set) && !mainCopy) return this.advance(parent, { ...next, stage: 'fixing' })
    if (SvnConflictFlow.open(set) && !SvnConflictFlow.forAgent(set))
      return this.needs(parent, next, 'conflict', SvnConflictWords.reasonOf(set, checkAgain))
    if (SvnConflictFlow.open(set) && next.resolverSpent === true)
      return this.needs(parent, next, 'conflict', `${SvnConflictWords.reasonOf(SvnConflictFlow.toPerson(set), checkAgain)}; one resolver runs per press`)
    const status = await this.svn.status(action.root)
    if (!status.ok) return this.needs(parent, next, 'svn-failed', `svn cannot report the state of ${action.root}: ${status.detail}`)
    if (SvnConflictFlow.open(set)) return this.launchResolver(parent, next, status.value)
    if (mainCopy) return this.advance(parent, { ...next, stage: 'recording' })
    const own = [...action.evidence.map((entry) => entry.revision),
      ...(parent.commitReceipts ?? []).flatMap((receipt) => receipt.revision === null ? [] : [receipt.revision])]
    this.steps.at(parent.sessionId, { kind: 'read', read: 'incoming', revision: (action.baseRevision ?? 0) + 1 })
    const incoming = await this.svn.incoming(action.root, action.baseRevision ?? 0, status.value.changed, own)
    if (!incoming.ok) return this.needs(parent, next, 'svn-failed', `svn cannot read what the update brought in: ${incoming.detail}`)
    if (incoming.value.length > 0) {
      if (action.checks.length === 0 || action.rounds.incoming >= SvnActionFlow.incomingRoundsConst)
        return this.needs(parent, next, 'incoming', SvnActionFlow.listed('other commits changed this project', incoming.value))
      return this.launch(parent, { ...next, stage: 'checks', checkCursor: 0, rounds: { ...action.rounds, incoming: action.rounds.incoming + 1 } })
    }
    return this.toReview(parent, next)
  }

  /** The set an update read, or none once an update leaves no conflict. */
  private static withSet(action: SessionRecordSvnAction, set: SvnActionConflictSet): SessionRecordSvnAction {
    if (SvnConflictFlow.open(set)) return { ...action, conflictSet: set }
    const next = { ...action }
    delete next.conflictSet
    return next
  }

  /**
   * One review run per changed root, mounts first. A pinned external with changes cannot be
   * committed by a review, so it stops everything before one opens. Nothing changed: everything was
   * committed earlier, from the split, so the action only removes.
   */
  private async toReview(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    this.steps.at(parent.sessionId, { kind: 'read', read: 'review-roots' })
    const roots = await this.svn.reviewRoots(action.root)
    if (!roots.ok) return this.needs(parent, action, 'svn-failed', `svn cannot report the state of ${action.root}: ${roots.detail}`)
    const pinned = roots.value.find((root) => root.pinned && root.changed.length > 0)
    if (pinned !== undefined)
      return this.needs(parent, action, 'pinned-external',
        `the external ${pinned.own} is pinned to a revision; commit it by hand and move the pin, then press Finish again`)
    const due = roots.value.filter((root) => root.changed.length > 0).map(SvnActionFlow.actionRootOf)
    if (due.length === 0) return this.advance(parent, { ...action, stage: 'removing', roots: [] })
    this.steps.at(parent.sessionId, { kind: 'read', read: 'fingerprint' })
    const fingerprint = await this.svn.fingerprint(action.root)
    return this.launch(parent, {
      ...action,
      stage: 'reviewing',
      roots: due,
      rootCursor: 0,
      reviewCommitId: undefined,
      checksPassed: fingerprint.ok ? { fingerprint: fingerprint.value, at: this.now() } : undefined,
    })
  }

  /**
   * After a review run. A root with nothing left goes on, whatever the exit code: a commit from the
   * session's own split counts the same. What the review committed is labelled by its receipt, else
   * by the BASE proof, else by the log.
   */
  private async reviewed(parent: SessionRecord, action: SessionRecordSvnAction, verdict: SvnActionVerdict): Promise<void> {
    const roots = action.roots ?? []
    const root = roots[action.rootCursor]
    if (root === undefined) throw new Error(`An SVN action reviewed root ${action.rootCursor} of ${roots.length}`)
    const ended = ReviewRunExit.of(verdict.exitCode)
    this.steps.at(parent.sessionId, { kind: 'read', read: 'review-roots' })
    const now = await this.svn.reviewRoots(action.root)
    if (!now.ok) return this.needs(parent, action, 'svn-failed', `svn cannot report the state of ${action.root}: ${now.detail}`)
    const changedOf = (own: string): string[] => now.value.find((candidate) => candidate.own === own)?.changed.map((row) => row.path) ?? []
    const left = changedOf(root.own)
    const latest = this.records.get(parent.sessionId) ?? parent
    this.steps.at(parent.sessionId, { kind: 'read', read: 'receipts', mount: root.own })
    let proven = await this.labels.afterReview(latest, action.startedAt, root)
    if (left.length === 0 && proven.length === 0) {
      this.steps.at(parent.sessionId, { kind: 'read', read: 'review-labels', mount: root.own })
      proven = await this.labels.inferred(root)
    }
    const next: SessionRecordSvnAction = { ...action, evidence: SvnRevisionLabels.merged(action.evidence, proven) }
    if (left.length === 0) {
      const rest = roots.map((candidate, index) => index <= action.rootCursor ? candidate : { ...candidate, changed: changedOf(candidate.own) })
      const cursor = rest.findIndex((candidate, index) => index > action.rootCursor && candidate.changed.length > 0)
      return cursor === -1
        ? this.advance(parent, { ...next, stage: 'removing' })
        : this.launch(parent, { ...next, roots: rest, rootCursor: cursor, reviewCommitId: undefined })
    }
    if (ended === 'out-of-date' && action.rounds.outOfDate < SvnActionFlow.outOfDateRoundsConst)
      return this.launch(parent, { ...next, stage: 'updating', rounds: { ...action.rounds, outOfDate: action.rounds.outOfDate + 1 } })
    const changes = `${left.length} change${left.length === 1 ? '' : 's'}`
    if (proven.length > 0)
      return this.needs(parent, next, 'partial', `the review of ${root.path} committed part of it; ${changes} left`)
    if (ended === 'interrupted')
      return this.needs(parent, next, 'review-interrupted', `the review of ${root.path} was interrupted; press Finish again to review it`)
    if (ended === 'out-of-date')
      return this.needs(parent, next, 'out-of-date', 'newer content arrived during the review again; press Finish again')
    return this.needs(parent, next, 'review-cancelled', `the review of ${root.path} ended without a commit; ${changes} left`)
  }

  /**
   * The text conflicts of the update go to one resolver. The brief and the pointer come first: the
   * pointer names a run the create has not written yet, so a client that dies in between leaves a
   * gone run, which the gate judges as failed and the verification then reads from the disk. A name
   * svn cannot take is never passed to `svn resolve`, so it needs the person before anything runs.
   */
  private async launchResolver(parent: SessionRecord, action: SessionRecordSvnAction, status: SvnWorktreeStatus): Promise<void> {
    const paths = status.textConflicts
    const unsafe = paths.filter((path) => !SvnWorktreeEvidence.takesArgument(path))
    if (unsafe.length > 0)
      return this.needs(parent, action, 'conflict',
        `${SvnActionFlow.listed('svn cannot take the names of these conflicted files', unsafe)}; resolve them in an SVN client, then ${SvnActionFlow.checkAgainOf(action.kind)}`)
    const unavailable = this.resolver.unavailable()
    if (unavailable !== null)
      return this.needs(parent, action, 'conflict',
        `${SvnActionFlow.listed('conflicts after the update', paths)}; nobody can resolve them here (${unavailable})`)
    const brief = await this.resolver.briefs.writeBrief(parent.sessionId, action.actionId,
      SvnResolverLauncher.briefOf({ kind: action.kind, title: parent.title, root: action.root, paths }))
    if (!brief.ok)
      return this.needs(parent, action, 'conflict',
        `${SvnActionFlow.listed('conflicts after the update', paths)}; the brief for a resolver could not be written (${brief.detail})`)
    const runId = this.newId()
    const pointed: SessionRecordSvnAction = {
      ...action,
      stage: 'resolving',
      runId,
      conflicts: { paths: [...paths], before: [...status.changed], at: this.now() },
      resolverSpent: true,
      verdict: undefined,
      retryAt: undefined,
    }
    if (!await this.write(parent, pointed)) return
    // The resolver's row speaks from here, and its create takes a while.
    if (this.steps.clear(parent.sessionId)) this.changed()
    const spec = SvnResolverLauncher.specOf(parent, { root: action.root, briefFile: this.resolver.briefs.briefPathOf(parent.sessionId, action.actionId) })
    const created = await this.createResolver(spec, {
      sessionId: runId,
      oneShot: true,
      permission: 'accept-edits',
      scriptOf: SessionScriptDefinitions.linkOf(parent.sessionId, 'after', 'svn-resolve', 'resolver'),
    })
    if (created.ok) return
    // An undecided refusal leaves the resolver pending, and the reconciler starts it under the same
    // id; taking the pointer back then would leave an agent in the worktree that nothing judges.
    if (ScriptRunLauncher.replayArmed(this.records.get(runId))) {
      this.report(`Session ${parent.sessionId}: the conflict resolver could not be started yet (${created.detail}); it is retried`)
      return
    }
    const latest = this.records.get(parent.sessionId)
    const now = latest?.svnAction
    if (!latest || now?.actionId !== action.actionId || now.runId !== runId || now.verdict !== undefined) return
    return this.needs(latest, now, 'resolver-failed',
      `the conflict resolver could not start (${created.detail}); resolve the conflicts by hand, then ${SvnActionFlow.checkAgainOf(action.kind)}`)
  }

  /**
   * The merger of a Finish, once per conflict set: the brief and the pointer first (the entries an agent
   * may settle are `agent`), then the create of an interactive Claude in the worktree. As with the
   * resolver, a client that dies between pointer and create leaves a gone run that the gate judges,
   * and `fixing` then reads what is there; an undecided create keeps the pointer for the replay; a
   * decided refusal gives the set to the person.
   */
  private async launchMerger(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    const set = action.conflictSet
    if (set === undefined) throw new Error(`The Finish of session ${parent.sessionId} starts a merger on no conflict set`)
    const briefed = await this.conflicts.brief(parent, action)
    if (!briefed.ok) return this.needs(parent, action, 'conflict', `${SvnConflictWords.reasonOf(SvnConflictFlow.toPerson(set), 'press Check again')}; ${briefed.detail}`)
    const brief = briefed.value.mergeBrief
    if (brief === undefined) throw new Error(`The Finish of session ${parent.sessionId} starts a merger with no path for it`)
    this.steps.at(parent.sessionId, { kind: 'read', read: 'changes' })
    const handed = await this.conflicts.handOver(action)
    if (!handed.ok) return this.needs(parent, action, 'conflict', `${SvnConflictWords.reasonOf(SvnConflictFlow.toPerson(set), 'press Check again')}; ${handed.detail}`)
    const runId = this.newId()
    const now = this.now()
    const pointed: SessionRecordSvnAction = {
      ...briefed.value,
      stage: 'merging',
      runId,
      merger: { runId, setAt: set.readAt, startedAt: now },
      verdict: undefined,
      retryAt: undefined,
    }
    if (!await this.write(parent, pointed)) return
    // The merger's row speaks from here, and its create takes a while.
    if (this.steps.clear(parent.sessionId)) this.changed()
    const created = await this.createResolver(SvnMergerLauncher.specOf(parent, { root: action.root, briefFile: brief }),
      SvnMergerLauncher.marksOf(parent.sessionId, runId))
    if (created.ok) return
    if (ScriptRunLauncher.replayArmed(this.records.get(runId))) {
      this.report(`Session ${parent.sessionId}: the merger could not be started yet (${created.detail}); it is retried`)
      return
    }
    const latest = this.records.get(parent.sessionId)
    const current = latest?.svnAction
    if (!latest || current?.actionId !== action.actionId || current.runId !== runId || current.verdict !== undefined) return
    const waiting = current.conflictSet === undefined ? set : current.conflictSet
    return this.needs(latest, current, 'conflict',
      `the merger could not start (${created.detail}); ${SvnConflictWords.reasonOf(SvnConflictFlow.toPerson(waiting), 'press Check again')}`)
  }

  /** The merger's run ended: `fixing` reads the set again as the merger left it, once, as after a merger. */
  private static mergerEnded(action: SessionRecordSvnAction, now: number): SessionRecordSvnAction {
    const set = action.conflictSet
    const merger = action.merger
    return {
      ...action,
      stage: 'fixing',
      ...set === undefined ? {} : { conflictSet: { ...set, waited: true } },
      ...merger === undefined ? {} : { merger: { ...merger, endedAt: now } },
    }
  }

  /**
   * The resolver of an UPDATE ended, whatever its exit code: no marker left in a conflicted file, then
   * `svn resolve --accept working` and no conflict left, then the merge as a diff. Only the markers are
   * read: other sessions may change a main copy's files meanwhile, so a change outside the conflicts
   * proves nothing about the resolver. (A worktree Finish has the merger and its guards instead.)
   */
  private async verifying(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    const conflicts = action.conflicts
    if (conflicts === undefined) throw new Error(`The SVN ${action.kind} of session ${parent.sessionId} verifies a resolver it holds no conflicts of`)
    const mainCopy = SvnActionFlow.inMainCopy(action.kind)
    const again = SvnActionFlow.checkAgainOf(action.kind)
    this.steps.at(parent.sessionId, { kind: 'read', read: 'markers', count: conflicts.paths.length })
    const marked = await this.resolver.withMarkers(action.root, conflicts.paths)
    if (marked.length > 0)
      return this.needs(parent, action, 'resolver-failed',
        `${SvnActionFlow.listed('the resolver left conflicts in', marked)}; resolve them by hand, then ${again}`)
    this.steps.at(parent.sessionId, { kind: 'read', read: 'resolve', count: conflicts.paths.length })
    const resolved = await this.svn.resolveWorking(action.root, conflicts.paths)
    if (!resolved.ok)
      return resolved.code === 'refused'
        ? this.needs(parent, action, 'conflict', `${resolved.detail}; resolve them in an SVN client, then ${again}`)
        : this.needs(parent, action, 'svn-failed', `svn resolve in ${action.root} failed: ${resolved.detail}`)
    this.steps.at(parent.sessionId, { kind: 'read', read: 'conflicts' })
    const left = await this.svn.status(action.root)
    if (!left.ok) return this.needs(parent, action, 'svn-failed', `svn cannot report the state of ${action.root}: ${left.detail}`)
    const still = [...left.value.textConflicts, ...left.value.otherConflicts]
    if (still.length > 0)
      return this.needs(parent, action, 'conflict', SvnActionFlow.listed('conflicts are still marked after the resolver', still))
    const settled = action.conflictSet === undefined ? action : { ...action, conflictSet: SvnConflictFlow.settledBy(action.conflictSet, 'agent') }
    if (mainCopy) return this.launch(parent, { ...settled, stage: 'diffing' })
    return this.launch(parent, settled.checks.length > 0 ? { ...settled, stage: 'checks', checkCursor: 0 } : { ...settled, stage: 'updating' })
  }

  /** Past its limit the resolver is stopped; what it left is the person's to judge. */
  private async resolverOverdue(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    if (action.runId !== undefined) await this.stopRun(action.runId)
    await this.needs(parent, action, 'resolver-failed',
      `the conflict resolver ran longer than ${SvnResolverLauncher.limitMillisecondsConst / 60_000} minutes and was stopped; `
      + `resolve the conflicts by hand, then ${SvnActionFlow.checkAgainOf(action.kind)}`)
  }

  /**
   * `fixing`, one step per drive step: after an update Jamat's rules, one entry each, journaled on the
   * record as they go; after Check again or a merger the set read again for what was settled. Nothing
   * open goes on: the checks when declared, else the update, in a new round. Paths an agent may settle
   * go to the merger, once per set. Anything else waits for the person.
   */
  private async fixing(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    this.steps.at(parent.sessionId, { kind: 'read', read: 'conflicts' })
    const next = await this.conflicts.fix(action, (fix) => this.steps.at(parent.sessionId, { kind: 'fixing', ...fix }),
      (path, journal) => this.noteJournal(parent.sessionId, action.actionId, path, journal), this.agentPresses.delete(action.actionId))
    const kind = next.kind
    switch (kind) {
      case 'applied':
        await this.write(parent, next.action)
        return
      case 'settled':
        return this.launch(parent, next.action.checks.length > 0 ? { ...next.action, stage: 'checks', checkCursor: 0 } : { ...next.action, stage: 'updating' })
      case 'merge': return this.launchMerger(parent, next.action)
      case 'needs': {
        // A wait on paths an agent may settle hands the person the merger's brief too.
        const briefed = next.need === 'conflict' ? await this.conflicts.brief(parent, next.action) : null
        if (briefed !== null && !briefed.ok) this.report(`Session ${parent.sessionId}: ${briefed.detail}`)
        return this.needs(parent, briefed?.ok === true ? briefed.value : next.action, next.need, next.reason)
      }
      default: throw new Error(`Unknown conflict step: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  /** By identity, after a re-read on the queue; a worktree already gone is removed. */
  private async removing(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    const worktree = parent.worktree
    let removal: SvnFinishWorktreeResult
    if (worktree === undefined) removal = parent.retiredWorktree === undefined ? 'kept' : 'removed'
    else {
      const removed = await this.removal.remove(parent.sessionId, SvnWorktreeRemoval.locationOf(worktree),
        action.evidence.map(SvnRevisionLabels.textOf))
      removal = removed.state
      if (removal !== 'removed') this.report(`Session ${parent.sessionId}: ${removed.lines.join(' ')}`)
    }
    const latest = this.records.get(parent.sessionId)
    const now = latest?.svnAction
    if (!latest || now?.actionId !== action.actionId) return
    await this.advance(latest, { ...now, stage: 'recording', removal })
  }

  /**
   * The ending, in one write: the outcome, the action gone, and the removal after the end asked for
   * when a holder kept the worktree. A committed Finish whose worktree went leaves a landed row until
   * its main copy holds what it committed; any other worktree that went takes its session with it.
   */
  private async recording(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    if (action.kind === 'update-main') return this.recordUpdate(parent, action)
    const removal = action.removal ?? 'kept'
    const at = this.now()
    let outcome: SessionWorktreeOutcome | undefined
    let result: WorktreeResultKind
    let lines: string[]
    if (action.kind === 'finish') {
      result = action.evidence.length > 0 ? 'committed' : 'nothing'
      lines = [
        result === 'committed'
          ? `-> committed ${SvnActionFlow.revisionText(action.evidence)} from ${action.root}`
          : `NOTHING TO COMMIT: ${action.root} held no change`,
        ...SvnConflictWords.fixedLinesOf(action.fixed ?? [], this.results.savedDirectoryOf(action.actionId)),
        ...SvnActionFlow.removalLines(removal, action.root),
      ]
      outcome = SvnActionFlow.outcomeOf(parent, action, result, removal, lines, at)
    }
    else if (action.kind === 'discard') {
      result = 'discarded'
      lines = [`DISCARDED: ${action.root}`, ...SvnActionFlow.removalLines(removal, action.root)]
    }
    else throw new Error(`Unknown SVN action kind: ${JSON.stringify(action.kind satisfies never)}`)
    this.steps.at(parent.sessionId, { kind: 'recording' })
    // Before the record: a session that goes takes its run logs with it, and a recording resumed
    // after a restart writes the same result again.
    await this.writeResult(parent, action, result, removal, lines, at)
    const unfinished = removal === 'in-use' || removal === 'undeleted'
    const landed = result === 'committed' && removal === 'removed' ? action.evidence : []
    const ownerDir = SvnActionFlow.mainCopyOf(parent, action)
    let landing = false
    const written = await this.records.update(parent.sessionId, (latest) => {
      if (latest.svnAction?.actionId !== action.actionId) return null
      let next: SessionRecord = { ...latest }
      delete next.svnAction
      if (outcome !== undefined) next.worktreeOutcome = outcome
      // The holder goes some time after the action; the cleanup takes the worktree then.
      if (unfinished && next.worktree !== undefined)
        next.worktreeCleanup = WorktreeCleanupPacing.pending(action.kind === 'finish' ? 'removal-unfinished' : 'discard-unfinished', at)
      landing = landed.length > 0 && next.retiredWorktree !== undefined
      if (landing) next = LandedRows.retiredOf(next, ownerDir, landed)
      return next
    })
    if (!written) return
    this.endings.set(action.actionId, removal)
    if (result === 'committed')
      this.proposalsSpent(parent.sessionId, [...new Set([action.root, ...(action.roots ?? []).map((root) => root.path)])])
    this.changed()
    if (removal !== 'removed') return
    if (landing) this.landedDue(ownerDir)
    else this.ended(parent.sessionId)
  }

  /** An UPDATE ends no worktree, so it writes no result; the landed rows of its main copy are read at once. */
  private async recordUpdate(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    const written = await this.records.update(parent.sessionId, (latest) => {
      if (latest.svnAction?.actionId !== action.actionId) return null
      const next: SessionRecord = { ...latest }
      delete next.svnAction
      return next
    })
    if (!written) return
    this.changed()
    this.landedDue(action.root)
  }

  /**
   * Stops the agent of a running action and waits out a drive in flight, as `resolverOverdue` does
   * before the person's path. Answers the record to go on from, or `merge-pending` when the action
   * moved on meanwhile.
   */
  private async stopAgent(sessionId: string, action: SessionRecordSvnAction, runId: string): Promise<SessionsOpResult<SessionRecord>> {
    await this.stopRun(runId)
    await this.driving.get(sessionId)
    const latest = this.records.get(sessionId)
    const now = latest?.svnAction
    if (!latest || now?.actionId !== action.actionId || (now.needs === undefined && SvnActionStages.agentRunOf(now) === null))
      return { ok: false, code: 'merge-pending', detail: `The SVN ${action.kind} of session ${sessionId} moved on while its agent stopped; press again` }
    return { ok: true, value: latest }
  }

  /** Keep ends an action that waits for the person; the worktree and what it holds stay. */
  private async keep(record: SessionRecord): Promise<SessionsOpResult<{ actionId: string | null }>> {
    const action = record.svnAction
    if (action === undefined) return { ok: true, value: { actionId: null } }
    const lines = [`KEPT: ${action.needs?.reason ?? 'the person kept the worktree'}; ${action.root} stays`]
    const at = this.now()
    const partial = action.evidence.length > 0
    const outcome = SvnActionFlow.outcomeOf(record, action, partial ? 'partial' : 'not-committed', 'kept', lines, at)
    await this.writeResult(record, action, partial ? 'partial' : 'kept', 'kept', lines, at)
    const written = await this.records.update(record.sessionId, (latest) => {
      if (latest.svnAction?.actionId !== action.actionId) return null
      const next: SessionRecord = { ...latest, worktreeOutcome: outcome }
      delete next.svnAction
      return next
    })
    if (!written) return OperationOutcomes.latched()
    this.changed()
    return { ok: true, value: { actionId: action.actionId } }
  }

  /** An unexpected throw ends the action with the error; the worktree stays, and Finish runs again. */
  private async failed(sessionId: string, action: SessionRecordSvnAction, error: unknown): Promise<void> {
    const detail = ErrorText.of(error)
    if (action.kind === 'update-main') {
      this.report(`Session ${sessionId}: the UPDATE of ${action.root} stopped on an unexpected failure: ${detail}`)
      await this.records.update(sessionId, (latest) => {
        if (latest.svnAction?.actionId !== action.actionId) return null
        const next: SessionRecord = { ...latest }
        delete next.svnAction
        return next
      })
      this.changed()
      return
    }
    this.report(`Session ${sessionId}: the SVN ${action.kind} stopped on an unexpected failure; the worktree is kept: ${detail}`)
    const lines = [`ERROR: the ${action.kind} stopped on an unexpected failure; the worktree is kept: ${detail}`]
    const at = this.now()
    const record = this.records.get(sessionId)
    if (record?.svnAction?.actionId === action.actionId) await this.writeResult(record, action, 'failed', 'kept', lines, at)
    await this.records.update(sessionId, (latest) => {
      if (latest.svnAction?.actionId !== action.actionId) return null
      const next: SessionRecord = {
        ...latest,
        worktreeOutcome: SvnActionFlow.outcomeOf(latest, action, 'failed', 'kept', lines, at),
      }
      delete next.svnAction
      return next
    })
    this.changed()
  }

  /**
   * The durable result of the ending, with copies of the logs of the runs since the press. A result
   * that cannot be written is said and never stops the ending.
   */
  private async writeResult(
    record: SessionRecord,
    action: SessionRecordSvnAction,
    result: WorktreeResultKind,
    removal: SvnFinishWorktreeResult,
    lines: string[],
    at: number,
  ): Promise<void> {
    try {
      const runs = (record.scriptRuns ?? []).filter((run) => run.startedAt >= action.startedAt)
      const logs = await this.results.keepLogs(action.actionId, record.sessionId, runs)
      const written = await this.results.put(SvnActionFlow.resultOf(record, action, result, removal, lines, logs, at))
      if (!written) this.report(`Session ${record.sessionId}: the result of its SVN ${action.kind} was not written`)
    } catch (error) {
      this.report(`Session ${record.sessionId}: the result of its SVN ${action.kind} was not written: ${ErrorText.of(error)}`)
    }
  }

  /**
   * Run first, pointer second, launch third: a client that dies between them leaves a run the orphan
   * rule marks lost, or a pointer whose run the reconciler replays. The update reads the BASE it
   * starts from and schedules what was deleted from disk; a review reads the bounds of its proof.
   */
  private async launch(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    let next = action
    if (action.stage === 'updating') {
      // A file the person deleted in a main copy is theirs to delete or restore; only a worktree's goes.
      if (!SvnActionFlow.inMainCopy(action.kind)) {
        this.steps.at(parent.sessionId, { kind: 'read', read: 'schedule-missing' })
        const missing = await this.svn.scheduleMissing(action.root, (action.conflictSet?.entries ?? []).map((entry) => entry.path))
        if (!missing.ok) return this.needs(parent, action, 'svn-failed', missing.detail)
      }
      this.steps.at(parent.sessionId, { kind: 'read', read: 'base-revision' })
      const base = await this.svn.revisionOf(action.root)
      if (!base.ok) return this.needs(parent, action, 'svn-failed', `svn cannot report the state of ${action.root}: ${base.detail}`)
      next = { ...action, baseRevision: base.value }
    }
    else if (action.stage === 'reviewing') {
      const roots = action.roots ?? []
      const root = roots[action.rootCursor]
      this.steps.at(parent.sessionId, { kind: 'read', read: 'review-bounds', mount: root.own })
      const bounds = await this.svn.lowerBounds([SvnActionFlow.svnRootOf(root)])
      if (!bounds.ok) return this.needs(parent, action, 'svn-failed', `svn cannot report the state of ${root.path}: ${bounds.detail}`)
      const { repository, base, rootBase, since } = bounds.value[root.own]
      next = { ...action, roots: roots.map((candidate, index) => index === action.rootCursor
        ? { ...candidate, bounds: { repository, base, rootBase, since } } : candidate) }
    }
    const run = this.runOf(parent.sessionId, next)
    if (!await this.records.put(run)) return
    const pointed = await this.records.update(parent.sessionId, (latest) => latest.svnAction?.actionId === next.actionId
      ? { ...latest, svnAction: SvnActionStages.passedOf(latest.svnAction,
        { ...next, runId: run.sessionId, verdict: undefined, retryAt: undefined, needs: undefined }, this.now()) }
      : null)
    if (!pointed) return
    // The run row and the end of the step in one snapshot.
    this.steps.clear(parent.sessionId)
    this.changed()
    await this.runs.launch(run)
  }

  private runOf(parentId: string, action: SessionRecordSvnAction): SessionRecord {
    const ids = { runId: this.newId(), operationId: this.newId(), now: this.now() }
    const folder = basename(action.root)
    const stage = action.stage
    switch (stage) {
      case 'checks': {
        const step = action.checks[action.checkCursor]
        return ScriptRunRecords.shellRun({
          ...ids,
          link: SessionScriptDefinitions.linkOf(parentId, 'after', 'checks', step.name, step.key),
          title: ScriptRunRecords.titleOf(step, action.root),
          commands: step.commands,
        })
      }
      case 'updating': case 'cleaning': {
        const name = stage === 'updating' ? 'update' : 'cleanup'
        const args = stage === 'updating' ? ['--non-interactive', 'update', '--accept', 'postpone', '--', '.'] : ['--non-interactive', 'cleanup', '--', '.']
        return ScriptRunRecords.processRun({
          ...ids,
          link: SessionScriptDefinitions.linkOf(parentId, 'after', 'svn', name),
          title: `svn ${name} ${folder}`,
          process: { tool: 'svn', args, cwd: action.root },
        })
      }
      case 'diffing': {
        // The log of this run is the merge: what the resolver made of the resolved files against BASE.
        const paths = (action.conflicts?.paths ?? []).slice(0, SvnActionFlow.diffPathsConst).map((path) => `${path}@`)
        return ScriptRunRecords.processRun({
          ...ids,
          link: SessionScriptDefinitions.linkOf(parentId, 'after', 'svn', 'diff'),
          title: `svn diff ${folder}`,
          process: { tool: 'svn', args: ['--non-interactive', 'diff', '--', ...paths], cwd: action.root },
        })
      }
      case 'reviewing': {
        const root = (action.roots ?? [])[action.rootCursor]
        return ScriptRunRecords.processRun({
          ...ids,
          link: SessionScriptDefinitions.linkOf(parentId, 'after', 'review', root.own === '' ? '.' : root.own),
          title: `Review ${folder}${root.own === '' ? '' : ` (${root.own})`}`,
          process: { tool: 'jamat-cli', args: ['sessions', 'worktree-review', '--self', '--wait'], cwd: root.path },
        })
      }
      case 'resolving': case 'merging': throw new Error('The resolver and the merger are created as agent sessions, never as run records of this flow')
      case 'stopping': case 'evidence': case 'verifying': case 'fixing': case 'removing': case 'recording':
        throw new Error(`The client stage ${stage} launches no run`)
      default:
        throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  /**
   * The action waits for the person: the run it waited on stays a row, and Finish again, Keep or
   * Discard go on. A worktree whose caller named a wake-up line gets a new notice in the same write,
   * which the notifier types once into the caller's session.
   */
  private async needs(parent: SessionRecord, action: SessionRecordSvnAction, kind: SvnActionNeed, reason: string): Promise<void> {
    // A waiting action shows its need, never a step.
    const cleared = this.steps.clear(parent.sessionId)
    // While it waits, no agent works on a conflict: the person settles what is left.
    const waiting = action.conflictSet === undefined ? action : { ...action, conflictSet: SvnConflictFlow.toPerson(action.conflictSet) }
    const at = this.now()
    const notice = SvnActionFlow.callsBack(parent, action.kind, kind) ? { notice: { id: this.newId(), at, attempts: 0, state: 'pending' as const } } : {}
    const written = await this.write(parent, { ...waiting, ...notice, verdict: undefined, retryAt: undefined, needs: { kind, reason, at } })
    if (!written && cleared) this.changed()
    if (written && kind !== 'review-cancelled')
      this.report(`Session ${parent.sessionId}: the SVN ${action.kind} of ${action.root} waits for you (${kind}): ${reason}`)
  }

  /**
   * Whether a wait wakes the caller: a Finish or Discard of a worktree whose caller named a line. Not
   * an UPDATE, and not a review the person cancelled in the window, where they already are.
   */
  private static callsBack(parent: SessionRecord, kind: SvnActionKind, need: SvnActionNeed): boolean {
    if (SvnActionFlow.inMainCopy(kind) || need === 'review-cancelled') return false
    return (parent.worktree ?? parent.retiredWorktree)?.caller?.notify !== undefined
  }

  private async advance(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    await this.write(parent, { ...action, verdict: undefined })
  }

  /** Lands on the action the record holds now, so a press or a newer action is never overwritten. */
  private async write(parent: SessionRecord, action: SessionRecordSvnAction): Promise<boolean> {
    const written = await this.records.update(parent.sessionId, (latest) => latest.svnAction?.actionId === action.actionId
      ? { ...latest, svnAction: SvnActionStages.passedOf(latest.svnAction, action, this.now()) }
      : null)
    if (written) this.changed()
    return written
  }

  /** Finish again keeps the passes of the action it resumes; a new action starts its own. */
  private static movedOf(previous: SessionRecordSvnAction | undefined, next: SessionRecordSvnAction, now: number): SessionRecordSvnAction {
    return previous?.actionId === next.actionId ? SvnActionStages.passedOf(previous, next, now) : { ...next, stageAt: now }
  }

  private static fresh(
    worktree: SessionRecordWorktree,
    kind: SvnActionKind,
    press: SessionFinishPress,
    checks: SessionRecordScriptStep[],
    actionId: string,
    now: number,
    live: boolean,
    evidence: readonly SvnLabelledRevision[],
  ): SessionRecordSvnAction {
    return {
      kind,
      actionId,
      stage: live ? 'stopping' : 'evidence',
      root: worktree.worktreePath,
      checks,
      checkCursor: 0,
      rootCursor: 0,
      rounds: { incoming: 0, outOfDate: 0, lock: 0 },
      evidence: [...evidence],
      requestedBy: press.requestedBy,
      startedAt: now,
    }
  }

  /**
   * Finish again on a waiting action: its evidence and its last passed checks stay, every limit
   * starts again, and the checks are the ones agreed to now. Check again on a conflict wait keeps the
   * set and goes back to it (`fixing`), so the checks never run on a half-merged tree; every other
   * wait starts at the evidence and drops the set.
   */
  private static resumed(
    current: SessionRecordSvnAction,
    press: SessionFinishPress,
    checks: SessionRecordScriptStep[],
    now: number,
    live: boolean,
  ): SessionRecordSvnAction {
    const fixing = SvnActionStages.resumesAtFixing(current)
    const next: SessionRecordSvnAction = {
      ...current,
      stage: live ? 'stopping' : fixing ? 'fixing' : 'evidence',
      checks,
      checkCursor: 0,
      rootCursor: 0,
      rounds: { incoming: 0, outOfDate: 0, lock: 0 },
      requestedBy: press.requestedBy,
      startedAt: now,
    }
    delete next.needs
    delete next.verdict
    delete next.retryAt
    delete next.reviewCommitId
    delete next.removal
    delete next.roots
    delete next.conflicts
    delete next.resolverSpent
    if (!fixing) {
      delete next.conflictSet
      delete next.mergeBrief
    }
    if (!ScriptChain.sameKeys(current.checks, checks)) delete next.checksPassed
    return next
  }

  /** A `scripts.after` step as the action keeps it: the same commands under its own script id. */
  private static checkOf(step: SessionRecordScriptStep): SessionRecordScriptStep {
    const check = { scriptId: 'checks' as const, name: step.name, commands: step.commands }
    return { ...check, key: ScriptChain.keyOf(check) }
  }

  private static outcomeOf(
    record: SessionRecord,
    action: SessionRecordSvnAction,
    result: SessionWorktreeOutcome['result'],
    worktree: SvnFinishWorktreeResult,
    lines: string[],
    at: number,
  ): SessionWorktreeOutcome {
    return {
      result,
      revisions: SvnWorktreeRemoval.joined(record.worktreeOutcome?.revisions ?? [], action.evidence.map(SvnRevisionLabels.textOf)),
      main: 'none',
      worktree,
      lines,
      at,
      labelled: [...action.evidence],
    }
  }

  /** A worktree already gone keeps its caller on the tombstone; its main copy is the folder above `.worktrees`. */
  private static resultOf(
    record: SessionRecord,
    action: SessionRecordSvnAction,
    result: WorktreeResultKind,
    removal: SvnFinishWorktreeResult,
    lines: string[],
    logs: WorktreeResultRecord['logs'],
    at: number,
  ): WorktreeResultRecord {
    const worktree = record.worktree
    const retired = record.retiredWorktree
    const kind = action.kind
    if (kind === 'update-main') throw new Error('An UPDATE of a main copy writes no worktree result')
    return WorktreeResultsStore.recordOf({
      actionId: action.actionId,
      action: kind,
      result,
      sessionId: record.sessionId,
      title: record.title,
      worktreePath: action.root,
      mainCopy: SvnActionFlow.mainCopyOf(record, action),
      directoryId: worktree?.directoryId ?? retired?.directoryId ?? null,
      removal: WorktreeResultsStore.removalOf(removal),
      revisions: [...action.evidence],
      lines,
      logs,
      at,
      caller: worktree?.caller ?? retired?.caller,
    })
  }

  /** The main copy of a worktree action: its owner while the worktree stands, the tombstone's after, else the folder above `.worktrees`. */
  private static mainCopyOf(record: SessionRecord, action: SessionRecordSvnAction): string {
    return record.worktree?.repositoryRoot ?? record.retiredWorktree?.ownerDir ?? dirname(dirname(action.root))
  }

  /** Whether the action works in a main copy rather than in a worktree of its session. */
  private static inMainCopy(kind: SvnActionKind): boolean {
    if (kind === 'update-main') return true
    else if (kind === 'finish' || kind === 'discard') return false
    else throw new Error(`Unknown SVN action kind: ${JSON.stringify(kind satisfies never)}`)
  }

  /** What the person presses to go on after they dealt with a reason. */
  private static againOf(kind: SvnActionKind): string {
    return SvnActionFlow.inMainCopy(kind) ? 'press UPDATE again' : 'press Finish again'
  }

  /** The press after settling conflicts: Check again of a Finish goes back to them (`fixing`). */
  private static checkAgainOf(kind: SvnActionKind): string {
    return SvnActionFlow.inMainCopy(kind) ? 'press UPDATE again' : 'press Check again'
  }

  private static removalLines(removal: SvnFinishWorktreeResult, path: string): string[] {
    if (removal === 'removed') return ['   worktree removed']
    else if (removal === 'in-use')
      return [`IN USE: ${path} (a process has its working directory or an open file there; it is removed once nothing holds it)`]
    else if (removal === 'undeleted') return [`ERROR: ${path}.deleting is left half deleted; it is removed once nothing holds it`]
    else if (removal === 'kept') return [`KEPT: ${path} stays`]
    else throw new Error(`Unknown worktree removal: ${JSON.stringify(removal satisfies never)}`)
  }

  private static actionRootOf(root: SvnRoot): SvnActionRoot {
    return { path: root.path, own: root.own, changed: root.changed.map((row) => row.path) }
  }

  private static svnRootOf(root: SvnActionRoot): SvnRoot {
    return { path: root.path, own: root.own, changed: root.changed.map((path) => ({ kind: 'item', conflict: false, path })) }
  }

  private static listed(what: string, paths: readonly string[]): string {
    const shown = paths.slice(0, SvnActionFlow.listedPathsConst)
    const more = paths.length > shown.length ? ` and ${paths.length - shown.length} more` : ''
    return `${what}: ${shown.join(', ')}${more}`
  }

  /** The repository's last segment, so a line stays readable. */
  private static revisionText(revisions: readonly SvnLabelledRevision[]): string {
    return revisions.map((entry) => `${entry.repository.replace(/\/+$/, '').split('/').pop() || entry.repository}:r${entry.revision}`).join(',') || '-'
  }
}
