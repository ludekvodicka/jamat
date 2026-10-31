import { SvnFailures } from '../../svn/svnFailures'
import { WorktreeLifecycleMigration } from '../worktreeLifecycleMigration'
import { WorktreeRecovery } from '../worktreeRecovery'
import type { SvnStepJournalEntry } from '../worktreeState'

import { ErrorText } from '../../shared/errorText'
import { PathCompare } from '../../shared/pathCompare'
import type { SvnConflictJournal, SvnConflictKind, SvnWorktreeStatus } from '../../svn/svn.types'
import { SvnWorktreeEvidence } from '../../svn/svnWorktreeEvidence'
import { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import { OperationOutcomes } from '../../sessionManager/worktreeSessionRuntime'
import { ScriptRunLauncher } from '../../sessionManager/worktreeSessionRuntime'
import type { SessionSteps } from '../../sessionManager/worktreeSessionRuntime'
import type {
SessionRecord,
SessionRecordSvnAction,
SvnActionConflictSet,
SvnActionVerdict
} from '../../sessionManager/worktreeSessionRecords'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import { SessionScriptDefinitions } from '../../sessionManager/worktreeSessionScripts'
import type {
SessionConflictResolved,
SessionFinishPress,
SessionsOpResult,
SvnActionNeed,
SvnConflictActor,
SvnConflictResolveRequest
} from '../../sessionManager/sessionManagerApi.types'
import { SvnConflictFlow } from '../conflicts/svnConflictFlow'
import { SvnConflictWords } from '../conflicts/svnConflictWords'
import { SvnConflictIdentity } from '../conflicts/svnConflictIdentity'
import { SvnResolverLauncher,type SvnResolverPort } from '../conflicts/svnResolverLauncher'
import { SvnActionStages } from '../finish/svnActionStages'
import type { MainCopyUpdated, WorktreeEnded } from '../finish/worktreeFinish.types'
import { type WorktreeResultsPort } from '../results/worktreeResultsStore'

import type { SvnActionFlowDeps,SvnActionPort,SvnActionPorts } from '../finish/svnActionFlow'
import { WorktreeLeaseHeld, type WorktreeLease } from '../worktreeLease'
import type { WorktreeSvnCommands } from '../worktreeSvnCommands'
import { LandedRows } from './landedRows'
import { relative, resolve } from 'node:path'
import { WorktreeUpdate, WorktreeUpdateFailure } from '../worktreeUpdate'

export class MainCopyUpdate {
  private readonly updates: WorktreeUpdate
  private readonly lease: Pick<WorktreeLease, 'within' | 'checkAndRelease'>
  private readonly commands: Pick<WorktreeSvnCommands, 'accept'>
  private readonly roots = new Map<string, Promise<unknown>>()
  private static readonly stepsPerDriveConst = 32
  private static readonly listedPathsConst = 20
  private static readonly diffPathsConst = 100
  /** What a person does with the conflicts a resolver did not settle: the wait draws their list with its options. */
  private static readonly settleByHandConst = 'settle each one in the conflict list below (edit the file and press Merge, or take one side)'
  private readonly runner: SvnActionPorts['runner']
  private readonly records: SessionRecordsStore
  private readonly svn: SvnActionPort
  private readonly conflicts: SvnConflictFlow
  private readonly resolver: SvnResolverPort
  private readonly results: WorktreeResultsPort
  private readonly logs: SvnActionPorts['logs']
  private readonly landedDue: (mainCopy: string) => void
  private readonly detach: (work: Promise<unknown>, what: string) => void
  private readonly changed: () => void
  private readonly steps: Pick<SessionSteps, 'at' | 'clear'>
  private readonly createResolver: SvnActionFlowDeps['createResolver']
  private readonly stopRun: (runId: string) => Promise<boolean>
  private readonly ended: WorktreeEnded
  private readonly mainCopyUpdated: (update: MainCopyUpdated) => void
  private readonly report: (message: string) => void
  private readonly newId: () => string
  private readonly now: () => number
  private readonly driving = new Map<string, Promise<void>>()
  private readonly localExecuting: Map<string, Promise<void>>
  constructor(deps: SvnActionFlowDeps & { lease: Pick<WorktreeLease, 'within' | 'checkAndRelease'>; commands: Pick<WorktreeSvnCommands, 'accept'> }) {
    this.updates = new WorktreeUpdate({ ...deps, targets: deps.svn.updateTargets })
    this.lease = deps.lease
    this.commands = deps.commands
    this.localExecuting = new Map()
    this.runner = deps.runner
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
      cli: () => deps.resolver.cli(),
      now: deps.now,
    })
    this.resolver = deps.resolver
    this.results = deps.results
    this.ended = deps.ended
    this.mainCopyUpdated = deps.mainCopyUpdated ?? (() => {})
    this.landedDue = deps.landedDue
    this.detach = deps.detach
    this.changed = deps.changed
    this.steps = deps.steps
    this.createResolver = deps.createResolver
    this.stopRun = deps.stopRun
    this.logs = deps.logs
    this.report = deps.report
    this.newId = deps.newId
    this.now = deps.now
  }


  /**
   * `press` false: the UPDATE a published Finish starts by itself. It runs the rules, and a conflict
   * they leave waits for a press (Resolve with agent) before any resolver starts.
   */
  async startUpdate(sessionId: string, mainCopy: string, requestedBy: SessionFinishPress['requestedBy'], wait = false, press = true): Promise<SessionsOpResult<{ actionId: string }>> {
    const current = this.records.get(sessionId)?.svnAction
    if (current !== undefined && current.stage !== 'main-update' && current.needs === undefined)
      return { ok: false, code: 'merge-pending', detail: 'An SVN action is already running' }
    if (this.roots.has(PathCompare.comparable(mainCopy)))
      return { ok: false, code: 'merge-pending', detail: 'An UPDATE is already using this main copy; wait for it to end' }
    try {
      await this.lease.checkAndRelease(mainCopy)
      const answer = await this.lease.within(mainCopy, 'update', () => this.beginUpdate(sessionId, mainCopy, requestedBy, wait, press), false)
      if (answer.ok && !wait) this.due(sessionId)
      return answer
    } catch (error) {
      if (error instanceof WorktreeLeaseHeld) return { ok: false, code: 'merge-pending', detail: error.message }
      throw error
    }
  }

  private serializedRoot<T>(root: string, work: () => Promise<T>): Promise<T> {
    const key = PathCompare.comparable(root)
    const prior = this.roots.get(key) ?? Promise.resolve()
    const next = prior.catch(() => undefined).then(() => this.lease.within(root, 'update', work))
    this.roots.set(key, next)
    void next.finally(() => { if (this.roots.get(key) === next) this.roots.delete(key) }).catch(() => undefined)
    return next
  }

  private async beginUpdate(sessionId: string, mainCopy: string, requestedBy: SessionFinishPress['requestedBy'], wait: boolean, press: boolean)
    : Promise<SessionsOpResult<{ actionId: string }>> {
    const record = this.records.get(sessionId)
    if (!record) return OperationOutcomes.notFound(sessionId)
    if (this.records.latched) return OperationOutcomes.latched()
    const other = this.records.list().find(row => row.sessionId !== sessionId && row.svnAction?.kind === 'update-main'
      && row.svnAction.needs === undefined && row.svnAction.stage !== 'main-update' && PathCompare.comparable(row.svnAction.root) === PathCompare.comparable(mainCopy))
    if (other !== undefined) return { ok: false, code: 'merge-pending', detail: `UPDATE is already running for ${other.sessionId}` }
    const current = record.svnAction
    if (current !== undefined && current.stage !== 'main-update' && (current.needs === undefined || current.kind !== 'update-main'))
      return { ok: false, code: 'merge-pending', detail: `An SVN ${current.kind} of session ${sessionId} is ${current.stage}; wait for it to end` }
    const interrupted = WorktreeRecovery.pending(record)
    if (interrupted.length > 0 && !this.held().has(sessionId)) {
      const entry = interrupted.find((row) => row.kind === 'commit') ?? interrupted[0]
      if (entry.kind === 'commit' || !await this.recoverStep(sessionId, entry))
        return { ok: false, code: 'svn-failed', detail: this.records.get(sessionId)?.svnAction?.needs?.reason ?? 'An interrupted SVN operation needs recovery first' }
      return { ok: true, value: { actionId: current!.actionId } }
    }
    if (wait && current?.stage === 'main-update') return { ok: true, value: { actionId: current.actionId } }
    const resuming = current?.kind === 'update-main' && this.updates.pending(sessionId)
    // Each press may start the resolver once more; an UPDATE nobody pressed starts none.
    const spent = press ? {} : { resolverSpent: true as const }
    const action: SessionRecordSvnAction = resuming
      ? { ...current, stage: 'updating', retryAt: this.now(), runId: undefined, verdict: undefined, needs: undefined,
        rounds: { ...current.rounds, lock: 0 }, resolverSpent: undefined, ...spent }
      : {
      ...spent,
      kind: 'update-main',
      actionId: current?.needs === undefined ? current?.actionId ?? this.newId() : this.newId(),
      stage: wait ? 'main-update' : 'updating',
      retryAt: wait ? undefined : this.now(),
      root: mainCopy,
      checks: [],
      checkCursor: 0,
      rootCursor: 0,
      rounds: { incoming: 0, outOfDate: 0, lock: 0 },
      evidence: [],
      requestedBy,
      startedAt: current?.startedAt ?? this.now(),
      stageAt: this.now(),
    }
    const written = await this.updateRecord(sessionId, (latest) => latest.svnAction?.kind === 'update-main' && MainCopyUpdate.running(latest) ? null
      : { ...latest, svnAction: MainCopyUpdate.movedOf(latest.svnAction, action, this.now()) })
    if (!written) return OperationOutcomes.latched()
    if (resuming) await this.updates.retry(sessionId)
    if (!wait)
      try { await this.commands.accept(mainCopy) }
      catch (error) { await this.needs(this.records.get(sessionId)!, action, 'svn-failed', ErrorText.of(error)) }
    this.changed()
    if (wait) return { ok: true, value: { actionId: action.actionId } }
    return { ok: true, value: { actionId: action.actionId } }
  }

async noteVerdict(parentId: string, verdict: { kind: 'succeeded' } | { kind: 'failed'; reason: string }): Promise<boolean> {
    const parent = this.records.get(parentId)
    const action = parent?.svnAction
    if (!parent || !action?.runId || !SessionScriptDefinitions.judging('action', parent)) return false
    const runId = action.runId
    const run = this.records.get(runId)
    if (run?.life === 'live' || run?.life === 'starting') return false
    // Reconciliation judges gates before it captures ended runs. Commit recovery and revision
    // receipts need that saved output, including a settled failure to capture it.
    if (run !== null && !parent.scriptRuns?.some((entry) => entry.runId === runId)) return false
    // The resolver's pointer is written before the create writes its record, so a pass between the two
    // finds no record; while this process drives the action that is a run on its way, not a gone one.
    if (run === null && this.driving.has(parentId)) return false
    const savedRun = parent.scriptRuns?.find((entry) => entry.runId === runId)
    try {
      if (action.kind !== 'update-main')
        await this.results.keepAttempt(action.actionId, parentId, { runId, title: savedRun?.title ?? run?.title ?? action.stage })
    } catch (error) {
      await this.needs(parent, action, 'svn-failed', `The attempt log ${runId} could not be preserved: ${ErrorText.of(error)}. Keep the worktree and retry after fixing the result directory.`)
      return true
    }
    const exitCode = run?.exitCode ?? parent.scriptRuns?.find((entry) => entry.runId === runId)?.exitCode
    const recorded: SvnActionVerdict = verdict.kind === 'succeeded'
      ? { kind: 'succeeded', ...exitCode === undefined ? {} : { exitCode } }
      : { kind: 'failed', reason: verdict.reason, ...exitCode === undefined ? {} : { exitCode } }
    const written = await this.updateRecord(parentId, (latest) => {
      const now = latest.svnAction
      return now?.runId === runId && now.verdict === undefined && now.needs === undefined
        ? { ...latest, svnAction: { ...now, verdict: recorded } }
        : null
    })
    if (written) this.due(parentId)
    return written
  }

private async recoveryRefusal(parent: SessionRecord, reason: string): Promise<false> {
    if (parent.svnAction !== undefined) await this.needs(parent, parent.svnAction, 'svn-failed', reason)
    else {
      await this.records.update(parent.sessionId, (record) => record.worktreeLifecycle === undefined ? null : { ...record,
        worktreeLifecycle: { ...record.worktreeLifecycle, version: record.worktreeLifecycle.version + 1, phase: 'waiting',
          wait: { kind: 'svn-failed', reason, at: this.now() } } })
      this.report(`Session ${parent.sessionId}: ${reason}`)
      this.changed()
    }
    return false
  }

async recoverStep(sessionId: string, entry: SvnStepJournalEntry): Promise<boolean> {
    return this.underDrive(sessionId, () => this.recoverStepCurrent(sessionId, entry))
  }

  private async recoverStepCurrent(sessionId: string, entry: SvnStepJournalEntry): Promise<boolean> {
      const parent = this.records.get(sessionId)
      const action = parent?.svnAction
      if (parent === null) return false
      if (action?.kind === 'update-main' && (entry.kind === 'resolve' || entry.kind === 'revert')
        && entry.stepId.startsWith(`${action.actionId}-conflict-`) && entry.cwd !== undefined && PathCompare.isInside(action.root, entry.cwd)) {
        const read = await this.conflicts.read(action)
        if (!read.ok) return this.recoveryRefusal(parent, `Inspect the interrupted conflict choice: ${read.detail}`)
        if (!await this.write(parent, { ...MainCopyUpdate.withSet(action, read.value), stage: 'fixing',
          needs: { kind: 'conflict', reason: 'An interrupted conflict choice needs inspection; resume its saved option before updating again', at: this.now() } })) return false
        await this.records.update(sessionId, (latest) => latest.worktreeLifecycle === undefined ? null : {
          ...latest, worktreeLifecycle: { ...latest.worktreeLifecycle, journal: latest.worktreeLifecycle.journal.map((row) => row.runId === entry.runId
            ? { ...row, endedAt: this.now(), outcome: 'other', output: 'Interrupted conflict write retained for explicit inspection; no automatic replay' } : row) },
        })
        return false
      }
      if (parent.worktreeLifecycle?.update !== undefined && !parent.worktreeLifecycle.update.completed && action?.kind === 'update-main') {
        const read = await this.conflicts.read(action)
        if (!read.ok) return this.recoveryRefusal(parent, read.detail)
        if (!await this.updates.recover(sessionId, entry, true))
          return this.recoveryRefusal(parent, 'The interrupted update no longer matches its saved repository step')
        // The interrupted run becomes a pass of its own, so the workflow names it (UA1-J09-7).
        await this.write(parent, { ...action, runId: entry.runId, verdict: { kind: 'failed', reason: 'svn update was interrupted when the client stopped' } })
        await this.write(parent, { ...MainCopyUpdate.withSet(action, read.value), stage: 'updating', runId: undefined,
          verdict: undefined, needs: undefined, retryAt: this.now() })
        return true
      }
      if (action === undefined || !entry.stepId.startsWith(`${action.actionId}-`) || entry.cwd === undefined
        || PathCompare.comparable(entry.cwd) !== PathCompare.comparable(action.root))
        return this.recoveryRefusal(parent, 'The interrupted SVN step no longer matches its owning action; retain the worktree for inspection')
      const kind = entry.kind
      if ((kind !== 'update' && kind !== 'cleanup' && kind !== 'diff') || entry.cwd === undefined || entry.args === undefined) {
        await this.needs(parent, action, 'svn-failed', 'The interrupted SVN step lacks a supported replay command; inspect the worktree before continuing')
        return false
      }
      const stage = kind === 'update' ? 'updating' : kind === 'cleanup' ? 'cleaning' : 'diffing'
      if (action.stage !== stage)
        return this.recoveryRefusal(parent, 'The interrupted SVN step no longer matches the current stage; retain its evidence for inspection')
      if (kind === 'update' && entry.targetRevision === undefined) {
        await this.needs(parent, action, 'svn-failed', 'The interrupted update has no fixed revision; inspect the worktree before continuing')
        return false
      }
      if (action.kind === 'update-main' && kind === 'cleanup')
        return this.recoveryRefusal(parent, 'An interrupted main-copy cleanup needs inspection by the person; Jamat will not repeat it automatically')
      let current = action
      try {
        if (kind === 'update' && current.updateProtection === undefined) current = await this.protect(parent, current)
        if (kind !== 'diff' && current.kind !== 'update-main') {
          const cleanup = await this.runner.run(sessionId, 'cleanup', entry.cwd, ['cleanup', '--', '.'],
            { stepId: `${entry.stepId}-recovery-cleanup`, attempt: entry.attempt })
          if (!cleanup.ok) { await this.needs(parent, current, cleanup.failure === 'locked' ? 'locked' : 'svn-failed', cleanup.output); return false }
        }
        const read = await this.conflicts.read(current)
        if (!read.ok) { await this.needs(parent, current, 'svn-failed', read.detail); return false }
        current = { ...MainCopyUpdate.withSet(current, read.value), runId: undefined, verdict: undefined, retryAt: undefined, needs: undefined }
        if (!await this.write(parent, current)) return false
        const args = kind === 'update' ? ['update', '-r', String(entry.targetRevision), '--accept', 'postpone', '--', '.'] : [...entry.args]
        const result = await this.runner.run(sessionId, kind, entry.cwd, args, { stepId: entry.stepId, attempt: entry.attempt + 1,
          baseRevision: entry.baseRevision, targetRevision: entry.targetRevision })
        if (current.kind !== 'update-main') await this.results.keepAttempt(current.actionId, sessionId, { runId: result.runId, title: `Recovered svn ${kind}` })
        const written = await this.records.update(sessionId, (latest) => {
          const state = latest.worktreeLifecycle
          if (state === undefined || latest.svnAction?.actionId !== current.actionId) return null
          const next = WorktreeLifecycleMigration.shadow({ ...latest, svnAction: { ...current, runId: result.runId,
            verdict: result.ok ? { kind: 'succeeded', exitCode: result.exitCode } : { kind: 'failed', exitCode: result.exitCode, reason: result.output } } }, latest)
          return { ...next, worktreeLifecycle: { ...next.worktreeLifecycle!, journal: state.journal.map((row) =>
            (row.runId === entry.runId || (row.endedAt === undefined && row.kind === 'cleanup' && row.cwd === entry.cwd))
              ? { ...row, endedAt: this.now(), outcome: 'other' } : row) } }
        })
        if (written) this.report(`Recovered the sync of ${parent.title || sessionId}: ${read.value.entries.length} conflicts; resumed r${entry.targetRevision ?? read.value.revision}`)
        return written
      } catch (error) {
        await this.needs(parent, current, 'svn-failed', `SVN recovery failed: ${ErrorText.of(error)}`)
        return false
      }
  }

async resolveConflict(sessionId: string, request: SvnConflictResolveRequest & { by: SvnConflictActor })
    : Promise<SessionsOpResult<SessionConflictResolved>> {
    return this.underDrive(sessionId, async () => {
      const parent = this.records.get(sessionId)
      if (!parent) return OperationOutcomes.notFound(sessionId)
      if (this.records.latched) return OperationOutcomes.latched()
      const action = parent.svnAction
      if (action === undefined || !SvnConflictFlow.open(action.conflictSet))
        return { ok: false, code: 'not-found', detail: `Session ${sessionId} has no conflicts of an SVN action` }
      const resolved = await this.conflicts.resolve(action, request, (path, journal, kind) => this.noteJournal(sessionId, action.actionId, path, journal, kind))
      if (!resolved.ok) return resolved
      if (!await this.updateRecord(sessionId, (latest) => {
        if (latest.svnAction?.actionId !== action.actionId) return null
        const memory = latest.worktreeLifecycle?.conflictMemory ?? latest.worktree?.conflictMemory
        const settled = resolved.value.action.conflictSet?.entries.filter((entry) => entry.path === request.path && entry.state === 'settled') ?? []
        const paths = memory?.paths.filter((entry) => !settled.some((done) => SvnConflictIdentity.same(done, entry)))
        return { ...latest, svnAction: SvnActionStages.passedOf(latest.svnAction, resolved.value.action, this.now()),
          ...resolved.value.state === 'settled' && latest.worktreeLifecycle && memory ? {
            worktreeLifecycle: { ...latest.worktreeLifecycle, conflictMemory: paths!.length > 0 ? { ...memory, paths: paths! } : undefined },
            ...latest.worktree === undefined ? {} : { worktree: { ...latest.worktree, conflictMemory: undefined } },
          } : {} }
      })) return OperationOutcomes.latched()
      this.changed()
      // The last settlement ends the merger's stage: its run is stopped after this answer went out,
      // and its verdict takes the Finish on.
      const merger = SvnActionStages.agentRunOf(action)
      if (action.stage === 'merging' && merger !== null && resolved.value.left === 0)
        this.detach(this.stopRun(merger), `The merger ${merger} of session ${sessionId}`)
      return { ok: true, value: { sessionId, path: request.path, state: resolved.value.state, left: resolved.value.left } }
    })
  }

private async noteJournal(sessionId: string, actionId: string, path: string, journal: SvnConflictJournal, kind: SvnConflictKind): Promise<void> {
    await this.updateRecord(sessionId, (latest) => {
      const now = latest.svnAction
      const set = now?.conflictSet
      if (now?.actionId !== actionId || set === undefined) return null
      return { ...latest, svnAction: { ...now, conflictSet: { ...set, entries: set.entries.map((entry) => SvnConflictIdentity.same(entry, { path, kind }) ? { ...entry, journal } : entry) } } }
    })
  }

private async underDrive<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    for (let running = this.localExecuting.get(sessionId) ?? this.driving.get(sessionId); running !== undefined;
      running = this.localExecuting.get(sessionId) ?? this.driving.get(sessionId)) await running
    const root = this.records.get(sessionId)?.svnAction?.root
    const result = root === undefined ? work() : this.lease.within(root, 'update', work)
    const held = result.then(() => undefined, () => undefined)
    this.driving.set(sessionId, held)
    try {
      return await result
    } finally {
      if (this.driving.get(sessionId) === held) this.driving.delete(sessionId)
      if (this.steps.clear(sessionId)) this.changed()
    }
  }

due(sessionId: string): void {
    this.detach(this.drive(sessionId), `The SVN action of session ${sessionId}`)
  }

held(): ReadonlySet<string> {
    return new Set([...this.driving.keys(), ...this.localExecuting.keys()])
  }

drive(sessionId: string): Promise<void> {
    if (this.localExecuting.has(sessionId)) return Promise.resolve()
    const running = this.driving.get(sessionId)
    if (running !== undefined) return running
    const root = this.records.get(sessionId)?.svnAction?.root
    if (root === undefined) return Promise.resolve()
    const work = this.serializedRoot(root, () => this.driveSteps(sessionId)).catch((error: unknown) => this.leaseRefused(sessionId, error)).finally(() => {
      this.driving.delete(sessionId)
      // A step never outlives its drive.
      if (this.steps.clear(sessionId)) this.changed()
    })
    this.driving.set(sessionId, work)
    return work
  }

  /**
   * A drive the root lease refused ran no step, so the UPDATE would keep drawing a running step with
   * no button; it waits as `locked` with the refusal, and the next press tries again.
   */
  private async leaseRefused(sessionId: string, error: unknown): Promise<void> {
    if (!(error instanceof WorktreeLeaseHeld)) throw error
    const parent = this.records.get(sessionId)
    const action = parent?.svnAction
    if (!parent || action?.kind !== 'update-main' || action.needs !== undefined || action.stage === 'main-update') return
    await this.needs(parent, action, 'locked', `${action.root} could not be taken for this UPDATE: ${error.message} Press UPDATE again once it is free.`)
  }

private async driveSteps(sessionId: string): Promise<void> {
    const initial = this.records.get(sessionId)
    if (initial !== null) for (const entry of WorktreeRecovery.pending(initial).filter((row) => row.endedAt === undefined))
      if (!await this.recoverStepCurrent(sessionId, entry)) return
    for (let step = 0; step < MainCopyUpdate.stepsPerDriveConst; step += 1) {
      const parent = this.records.get(sessionId)
      const action = parent?.svnAction
      if (!parent || action?.kind !== 'update-main' || action.needs !== undefined) return
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

private async updated(parent: SessionRecord, action: SessionRecordSvnAction, verdict: SvnActionVerdict): Promise<void> {
    const mainCopy = true
    const again = 'press UPDATE again'
    const checkAgain = 'press UPDATE again'
    if (verdict.kind === 'failed') {
      const output = action.runId === undefined ? verdict.reason : (await this.logs.read(parent.sessionId, action.runId, 1024 * 1024))?.text ?? verdict.reason
      if (SvnFailures.classify(output, verdict.exitCode ?? null) === 'auth')
        return this.needs(parent, action, 'svn-failed', `svn sign-in needed: open TortoiseSVN and sign in. ${output}`)
      this.steps.at(parent.sessionId, { kind: 'read', read: 'lock' })
      const locked = await this.svn.locked(action.root)
      const delays = SvnWorktreeManager.lockRetryDelaysConst
      const lock = action.rounds.lock
      if (locked && lock < delays.length && parent.worktreeLifecycle?.stoppedFailure === undefined) {
        await this.write(parent, { ...action, verdict: undefined, rounds: { ...action.rounds, lock: lock + 1 }, retryAt: this.now() + delays[lock] })
        return
      }
      if (locked && mainCopy)
        return this.needs(parent, action, 'locked', MainCopyUpdate.lockedReasonOf(parent, action))
      if (locked && lock === delays.length)
        return this.launch(parent, { ...action, stage: 'cleaning', rounds: { ...action.rounds, lock: lock + 1 } })
      if (locked)
        return this.needs(parent, action, 'locked', `${action.root} is still locked after svn cleanup; close what works in it, then ${again}`)
    }
    this.steps.at(parent.sessionId, { kind: 'read', read: 'conflicts' })
    const read = await this.conflicts.read(action)
    if (!read.ok) return this.needs(parent, action, 'svn-failed', `svn cannot report the conflicts of ${action.root}: ${read.detail}`)
    let set = read.value
    if (verdict.kind === 'failed' && !SvnConflictFlow.open(set))
      return this.needs(parent, action, 'svn-failed', `svn update of ${action.root} failed (${verdict.reason}); its log is under Scripts`)
    let next = MainCopyUpdate.withSet(action, set)
    // The lossless rules first: a text conflict that is one only by line ends, or that merges cleanly
    // once they are ignored, never reaches the resolver or the person (Finish 072).
    if (next.conflictSet?.entries.some((entry) => entry.state === 'rule')) {
      while (next.conflictSet?.entries.some((entry) => entry.state === 'rule')) {
        this.steps.at(parent.sessionId, { kind: 'read', read: 'conflicts' })
        const fixed = await this.conflicts.fix(next, () => {}, async () => {})
        next = fixed.action
        if (fixed.kind === 'needs') return this.needs(parent, next, fixed.need, fixed.reason)
        if (fixed.kind !== 'applied') break
      }
      const reread = await this.conflicts.read(next)
      if (!reread.ok) return this.needs(parent, next, 'svn-failed', `svn cannot report the conflicts of ${action.root}: ${reread.detail}`)
      set = reread.value
      next = MainCopyUpdate.withSet(next, set)
    }
    const status = await this.svn.status(action.root)
    if (!status.ok) return this.needs(parent, next, 'svn-failed', `svn cannot report the state of ${action.root}: ${status.detail}`)
    const older = MainCopyUpdate.olderOf(next, status.value)
    const named = older.length === 0 ? '' : `; ${SvnConflictWords.olderOf(older)}`
    if (SvnConflictFlow.open(set) && !SvnConflictFlow.forAgent(set))
      return this.needs(parent, next, 'conflict', `${SvnConflictWords.reasonOf(set, checkAgain)}${named}`)
    if (SvnConflictFlow.open(set) && next.resolverSpent === true)
      return this.needs(parent, next, 'conflict', `${SvnConflictWords.agentReasonOf(SvnConflictFlow.toPerson(set))}${named}`)
    if (SvnConflictFlow.open(set)) return this.launchResolver(parent, next, status.value)
    return this.advance(parent, { ...next, stage: 'recording' })
  }

  /**
   * The wait on a lock in a main copy names the root its svn update ran in. A lock that Jamat's own
   * update left when the client stopped says so, and the person still runs svn cleanup: another
   * svn client may hold that lock by now (UA1-J09-7).
   */
  private static lockedReasonOf(record: SessionRecord, action: SessionRecordSvnAction): string {
    const journal = record.worktreeLifecycle?.journal ?? []
    const cwd = journal.find((entry) => entry.runId === action.runId)?.cwd ?? action.root
    const interrupted = journal.some((entry) => entry.kind === 'update' && entry.stepId.startsWith(`${action.actionId}-`) && entry.cwd !== undefined
      && PathCompare.comparable(entry.cwd) === PathCompare.comparable(cwd) && WorktreeRecovery.interrupted(record, entry.runId))
    const again = 'press UPDATE again'
    if (!interrupted) return `${cwd} is locked by another svn client; let it finish, or run svn cleanup there yourself, then ${again}`
    const own = relative(action.root, cwd).replace(/\\/g, '/') || '.'
    return `${own} in ${action.root} is still locked by Jamat's own svn update, which was interrupted when the client stopped. `
      + `Jamat never runs svn cleanup in a main copy: if no other svn client works there, run svn cleanup in ${cwd} yourself, then ${again}`
  }

  /**
   * The paths in the conflict sets of the other UPDATEs of this main copy. A waiting UPDATE keeps the
   * set it left, and the next UPDATE takes those paths into its own set, so they go on from press to
   * press until settled and never count as conflicts from before.
   */
  private static leftOpenOf(records: readonly SessionRecord[], action: SessionRecordSvnAction): Set<string> {
    return new Set(records.flatMap((record) => {
      const other = record.svnAction
      return other?.kind === 'update-main' && other.actionId !== action.actionId
        && PathCompare.comparable(other.root) === PathCompare.comparable(action.root)
        ? other.conflictSet?.entries.map((entry) => entry.path) ?? [] : []
    }))
  }

  /** The conflicts svn marked before this UPDATE and still marks; its set and its resolver leave them out. */
  private static olderOf(action: SessionRecordSvnAction, status: SvnWorktreeStatus): string[] {
    const before = action.updateProtection?.before ?? []
    return [...status.textConflicts, ...status.otherConflicts].filter((path) => before.includes(path))
  }

private static withSet(action: SessionRecordSvnAction, set: SvnActionConflictSet): SessionRecordSvnAction {
    if (SvnConflictFlow.open(set)) return { ...action, conflictSet: set }
    const next = { ...action }
    delete next.conflictSet
    return next
  }

private async launchResolver(parent: SessionRecord, action: SessionRecordSvnAction, status: SvnWorktreeStatus): Promise<void> {
    const paths = status.textConflicts.filter((path) => !(action.updateProtection?.before ?? []).includes(path))
    const unsafe = paths.filter((path) => !SvnWorktreeEvidence.takesArgument(path))
    if (unsafe.length > 0)
      return this.needs(parent, action, 'conflict',
        `${MainCopyUpdate.listed('svn cannot take the names of these conflicted files', unsafe)}; resolve them in an SVN client, then ${'press UPDATE again'}`)
    const unavailable = this.resolver.unavailable()
    if (unavailable !== null)
      return this.needs(parent, action, 'conflict',
        `${MainCopyUpdate.listed('conflicts after the update', paths)}; nobody can resolve them here (${unavailable})`)
    const brief = await this.resolver.briefs.writeBrief(parent.sessionId, action.actionId,
      SvnResolverLauncher.briefOf({ kind: action.kind, title: parent.title, root: action.root, paths }))
    if (!brief.ok)
      return this.needs(parent, action, 'conflict',
        `${MainCopyUpdate.listed('conflicts after the update', paths)}; the brief for a resolver could not be written (${brief.detail})`)
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
      `the conflict resolver could not start (${created.detail}); ${MainCopyUpdate.settleByHandConst}, then ${'press UPDATE again'}`)
  }

private async verifying(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    const conflicts = action.conflicts
    if (conflicts === undefined) throw new Error(`The SVN ${action.kind} of session ${parent.sessionId} verifies a resolver it holds no conflicts of`)
    const again = 'press UPDATE again'
    this.steps.at(parent.sessionId, { kind: 'read', read: 'markers', count: conflicts.paths.length })
    const marked = await this.resolver.withMarkers(action.root, conflicts.paths)
    // svn still marks these files after a hand edit; an option of the conflict list settles them.
    if (marked.length > 0)
      return this.needs(parent, action, 'resolver-failed',
        `${MainCopyUpdate.listed('the resolver left conflicts in', marked)}; ${MainCopyUpdate.settleByHandConst}, then ${again}`)
    this.steps.at(parent.sessionId, { kind: 'read', read: 'resolve', count: conflicts.paths.length })
    const resolved = await this.svn.resolveWorking(action.root, conflicts.paths)
    if (!resolved.ok)
      return resolved.code === 'refused'
        ? this.needs(parent, action, 'conflict', `${resolved.detail}; resolve them in an SVN client, then ${again}`)
        : this.needs(parent, action, 'svn-failed', `svn resolve in ${action.root} failed: ${resolved.detail}`)
    this.steps.at(parent.sessionId, { kind: 'read', read: 'conflicts' })
    const left = await this.svn.status(action.root)
    if (!left.ok) return this.needs(parent, action, 'svn-failed', `svn cannot report the state of ${action.root}: ${left.detail}`)
    const older = MainCopyUpdate.olderOf(action, left.value)
    const still = [...left.value.textConflicts, ...left.value.otherConflicts].filter((path) => !older.includes(path))
    if (still.length > 0)
      return this.needs(parent, action, 'conflict', MainCopyUpdate.listed('conflicts are still marked after the resolver', still))
    const settled = action.conflictSet === undefined ? action : { ...action, conflictSet: SvnConflictFlow.settledBy(action.conflictSet, 'agent') }
    return this.launch(parent, { ...settled, stage: 'diffing' })
  }

private async resolverOverdue(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    if (action.runId !== undefined) await this.stopRun(action.runId)
    await this.needs(parent, action, 'resolver-failed',
      `the conflict resolver ran longer than ${SvnResolverLauncher.limitMillisecondsConst / 60_000} minutes and was stopped; `
      + `${MainCopyUpdate.settleByHandConst}, then ${'press UPDATE again'}`)
  }

private async recordUpdate(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    if (this.updates.pending(parent.sessionId)) {
      await this.advance(parent, { ...action, stage: 'updating', runId: undefined, verdict: undefined, retryAt: this.now() })
      return
    }
    const revision = await this.svn.revisionOf(action.root)
    if (!revision.ok) return this.needs(parent, action, 'svn-failed', revision.detail)
    const by = action.requestedBy === 'window' ? 'person' : 'agent'
    // The revision each root of the main copy was updated to, the external mounts among them: a result
    // that published only to an external holds that mount's revision, not the root's (UA1-J13-7).
    const update = this.records.get(parent.sessionId)?.worktreeLifecycle?.update
    const repositories = update?.completed === true && update.actionId === action.actionId
      ? update.units.map((unit) => ({ repository: unit.target.repository, revision: unit.target.revision })) : []
    const gained = await this.results.mainUpdated(action.root, { revision: revision.value, by, at: this.now(),
      ...repositories.length === 0 ? {} : { repositories } }, async (revisions) => {
      const proof = await this.svn.landingProof(action.root, revisions)
      return proof.ok ? proof.value : { holds: false, reason: proof.detail }
    }, { parentId: parent.sessionId, runs: MainCopyUpdate.runsOf(this.records.get(parent.sessionId) ?? parent, action),
      lines: [LandedRows.savedOf(action.updateProtection)].flatMap((saved) => saved === null ? [] : [`   main copy update: ${saved}`]) })
    const written = await this.updateRecord(parent.sessionId, (latest) => {
      if (latest.svnAction?.actionId !== action.actionId) return null
      const next: SessionRecord = { ...latest }
      delete next.svnAction
      if (next.retiredWorktree !== undefined && (next.retiredWorktree.landed?.length ?? 0) === 0)
        next.completed = true
      return next
    })
    if (!written) return
    this.changed()
    if (parent.retiredWorktree !== undefined) this.mainCopyUpdated({ sessionId: parent.sessionId, title: parent.title, mainCopy: action.root,
      revision: revision.value, by, log: (gained.find((result) => result.sessionId === parent.sessionId) ?? gained[0])?.logs[0]?.path ?? null })
    this.landedDue(action.root)
    if (parent.retiredWorktree !== undefined && (parent.retiredWorktree.landed?.length ?? 0) === 0)
      this.ended(parent.sessionId)
  }

  /**
   * The SVN runs of this UPDATE: those journaled since it left a landed row's offer, else since it
   * started. The runs of the Finish before the offer belong to its result already.
   */
  private static runsOf(record: SessionRecord, action: SessionRecordSvnAction): { runId: string; title: string }[] {
    const since = action.passes?.filter((pass) => pass.stage === 'main-update').at(-1)?.endedAt ?? action.startedAt
    return (record.worktreeLifecycle?.journal ?? []).filter((entry) => entry.startedAt >= since).map((entry) => ({ runId: entry.runId,
      title: `Update main copy: ${record.scriptRuns?.find((run) => run.runId === entry.runId)?.title ?? `svn ${entry.kind}`}` }))
  }

private async advance(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    await this.write(parent, { ...action, verdict: undefined })
  }

private updateRecord(sessionId: string, compose: (latest: SessionRecord) => SessionRecord | null): Promise<boolean> {
    return this.records.update(sessionId, (latest) => {
      const next = compose(latest)
      if (next === null) return null
      const shadow = WorktreeLifecycleMigration.shadow(next, latest)
      return next.svnAction !== undefined && next.svnAction.actionId !== latest.svnAction?.actionId && shadow.worktreeLifecycle !== undefined
        ? { ...shadow, worktreeLifecycle: { ...shadow.worktreeLifecycle, stoppedFailure: undefined } } : shadow
    })
  }

private async write(parent: SessionRecord, action: SessionRecordSvnAction): Promise<boolean> {
    const written = await this.updateRecord(parent.sessionId, (latest) => latest.svnAction?.actionId === action.actionId
      ? { ...latest, svnAction: SvnActionStages.passedOf(latest.svnAction, action, this.now()) }
      : null)
    if (written) this.changed()
    return written
  }

private static movedOf(previous: SessionRecordSvnAction | undefined, next: SessionRecordSvnAction, now: number): SessionRecordSvnAction {
    return previous?.actionId === next.actionId ? SvnActionStages.passedOf(previous, next, now) : { ...next, stageAt: now }
  }

private static listed(what: string, paths: readonly string[]): string {
    const shown = paths.slice(0, MainCopyUpdate.listedPathsConst)
    const more = paths.length > shown.length ? ` and ${paths.length - shown.length} more` : ''
    return `${what}: ${shown.join(', ')}${more}`
  }

  static running(record: SessionRecord): boolean { return SvnActionStages.running(record) }

  private async step(parent: SessionRecord, action: SessionRecordSvnAction): Promise<boolean> {
    if (action.verdict !== undefined) { await this.judge(parent, action, action.verdict); return true }
    switch (action.stage) {
      case 'main-update': return false
      case 'verifying': await this.verifying(parent, action); return true
      case 'recording': await this.recordUpdate(parent, action); return this.updates.pending(parent.sessionId)
      case 'updating': case 'cleaning': case 'resolving': case 'diffing':
        if (SvnResolverLauncher.overdue(action, this.now())) { await this.resolverOverdue(parent, action); return true }
        if (!SvnActionStages.launchLost(action) && (action.retryAt === undefined || this.now() < action.retryAt)) return false
        await this.launch(parent, { ...action, retryAt: undefined }); return true
      case 'changes': case 'reviewing': case 'stopping': case 'evidence': case 'fixing': case 'removing': case 'committing': case 'checks': case 'merging':
        throw new Error('Finish stages belong to FinishDriver')
      default: throw new Error('Unknown UPDATE stage')
    }
  }

  private async judge(parent: SessionRecord, action: SessionRecordSvnAction, verdict: SvnActionVerdict): Promise<void> {
    switch (action.stage) {
      case 'updating': return this.updated(parent, action, verdict)
      case 'cleaning':
        if (verdict.kind === 'failed') return this.needs(parent, action, 'locked', verdict.reason)
        return this.launch(parent, { ...action, stage: 'updating' })
      case 'resolving': return this.advance(parent, { ...action, stage: 'verifying' })
      case 'diffing': return this.advance(parent, { ...action, stage: 'recording' })
      default: throw new Error('The UPDATE stage waits on no run')
    }
  }

  private async failed(sessionId: string, action: SessionRecordSvnAction, error: unknown): Promise<void> {
    const parent = this.records.get(sessionId)
    if (parent !== null) await this.needs(parent, action, 'svn-failed', ErrorText.of(error))
  }

  private async needs(parent: SessionRecord, action: SessionRecordSvnAction, kind: SvnActionNeed, reason: string): Promise<void> {
    this.steps.clear(parent.sessionId)
    await this.write(parent, { ...action, conflictSet: action.conflictSet === undefined ? undefined : SvnConflictFlow.toPerson(action.conflictSet),
      verdict: undefined, retryAt: undefined, needs: { kind, reason, at: this.now() } })
    this.report('Session ' + parent.sessionId + ': UPDATE waits (' + kind + '): ' + reason)
  }

  private async launch(parent: SessionRecord, action: SessionRecordSvnAction): Promise<void> {
    const kind = action.stage === 'updating' ? 'update' : action.stage === 'cleaning' ? 'cleanup' : action.stage === 'diffing' ? 'diff' : null
    if (kind === null) throw new Error('Unsupported UPDATE command')
    if (kind === 'update' && action.updateProtection === undefined) action = await this.protect(parent, action)
    const base = await this.svn.revisionOf(action.root)
    if (!base.ok) return this.needs(parent, action, 'svn-failed', base.detail)
    const target = kind === 'update' ? await this.svn.headRevisionOf(action.root) : null
    if (target !== null && !target.ok) return this.needs(parent, action, 'svn-failed', target.detail)
    const next = { ...action, baseRevision: base.value, runId: undefined, verdict: undefined, retryAt: undefined, needs: undefined }
    const args = kind === 'update' ? ['update', '-r', String(target!.value), '--accept', 'postpone', '--', '.']
      : kind === 'cleanup' ? ['cleanup', '--', '.'] : ['diff', '--old', '.@BASE', '--new', '.', '--', ...(action.conflicts?.paths ?? []).slice(0, MainCopyUpdate.diffPathsConst)]
    if (!await this.write(parent, next)) return
    if (kind === 'update') {
      try {
        const result = await this.updates.run(parent.sessionId, next.actionId, next.root, target!.value, next.updateProtection?.before)
        await this.write(parent, { ...next, runId: result.runId, verdict: { kind: 'succeeded', exitCode: 0 } })
      } catch (error) {
        if (!(error instanceof WorktreeUpdateFailure)) throw error
        await this.write(parent, { ...next, runId: error.result.runId,
          verdict: { kind: 'failed', exitCode: error.result.exitCode, reason: error.message } })
      }
      return
    }
    const result = await this.runner.run(parent.sessionId, kind, next.root, args, { stepId: next.actionId + '-' + kind,
      attempt: next.rounds.lock + 1, baseRevision: next.baseRevision, ...target?.ok ? { targetRevision: target.value } : {} })
    await this.write(parent, { ...next, runId: result.runId,
      verdict: result.ok ? { kind: 'succeeded', exitCode: result.exitCode } : { kind: 'failed', exitCode: result.exitCode, reason: result.output } })
  }

  private async protect(parent: SessionRecord, action: SessionRecordSvnAction): Promise<SessionRecordSvnAction> {
    const before = await this.svn.status(action.root)
    if (!before.ok) throw new Error(before.detail)
    const landed = this.records.list().flatMap((record) => {
      const landing = LandedRows.landingOf(record)
      return landing !== null && PathCompare.comparable(landing.mainCopy) === PathCompare.comparable(action.root) ? landing.landed : []
    })
    const paths = landed.length === 0 ? { ok: true as const, value: [] } : await this.svn.landingPaths(action.root, landed)
    if (!paths.ok) throw new Error(paths.detail)
    const roots = [...new Set(paths.value.flatMap((path) => path.root === null ? [] : [path.root]))]
    const overlaps: string[] = []
    const saved: string[] = []
    for (const root of roots) {
      const changed = await this.svn.changes(root)
      if (!changed.ok) throw new Error(changed.detail)
      const own = paths.value.filter((path) => path.root === root)
      const local = changed.value.filter((row) => own.some((path) => PathCompare.isInside(resolve(root, path.path), resolve(root, row.path))
        || PathCompare.isInside(resolve(root, row.path), resolve(root, path.path)))).map((row) => row.path)
      if (local.length === 0) continue
      const copied = await this.svn.saveLocalPaths(root, local, this.results.savedDirectoryOf(action.actionId))
      if (!copied.ok) throw new Error(copied.detail)
      saved.push(copied.value); overlaps.push(...local.map((path) => resolve(root, path)))
    }
    const jamat = MainCopyUpdate.leftOpenOf(this.records.list(), action)
    const older = [...before.value.textConflicts, ...before.value.otherConflicts].filter((path) => !jamat.has(path))
    const protectedAction = { ...action, updateProtection: { before: older, overlaps, saved } }
    if (!await this.write(parent, protectedAction)) throw new Error('UPDATE protection could not be saved')
    if (overlaps.length > 0) this.report(`${overlaps.length} of your files overlap landed revisions; copy saved: ${saved.join(', ')}`)
    return protectedAction
  }

}
