import { FinishProjection } from './finish/finishProjection'
import { WorktreeWords } from './view/worktreeWords'
import { WorktreeViews } from './view/worktreeView'
import { WorktreeRecordView } from './view/worktreeRecordView'
import { WorktreeDue } from './worktreeDue'
import { WorktreeTransitions } from './worktreeTransitions'
import { PathCompare } from '../shared/pathCompare'
import type { SessionRecord, SessionRecordWorktree, SvnActionVerdict } from '../sessionManager/worktreeSessionRecords'
import type { SessionConflictList, SessionConflictResolved, SessionCreated, SessionFinishChoice, SessionFinishPress, SessionsOpResult, SessionWorktreeInfo, SessionWorktreePlace, SessionWorktreeState, SvnConflictResolveRequest } from '../sessionManager/sessionManagerApi.types'
import { SessionScriptDefinitions } from '../sessionManager/worktreeSessionScripts'
import { SvnActionStages } from './finish/svnActionStages'
import { SvnConflictWords } from './conflicts/svnConflictWords'
import type { WorktreeChoicesInput, WorktreeFinisher } from './finish/worktreeFinish.types'
import type { WorktreeActions, WorktreeDueChange, WorktreeLifecycleDeps, WorktreePlaceRequest, WorktreeRequest } from './worktreeLifecycle.types'

export class WorktreeLifecycle {
  private readonly withControl: WorktreeLifecycleDeps['withControl']
  private readonly dirty: WorktreeLifecycleDeps['dirty']
  private readonly syncPort: WorktreeLifecycleDeps['sync']
  private readonly recordsPort: WorktreeLifecycleDeps['records']
  private readonly finishersPort: WorktreeLifecycleDeps['finishers']
  private readonly actionsPort: WorktreeLifecycleDeps['actions']
  private readonly provisionPort: WorktreeLifecycleDeps['provision']
  private readonly changedPort: WorktreeLifecycleDeps['changed']
  private readonly createPort: WorktreeLifecycleDeps['create']
  private readonly stopPort: WorktreeLifecycleDeps['stop']
  private readonly awaitExitPort: WorktreeLifecycleDeps['awaitExit']
  private readonly refreshPort: WorktreeLifecycleDeps['refresh']
  private readonly activityOfPort: WorktreeLifecycleDeps['activityOf']
  private readonly checksPort: WorktreeLifecycleDeps['checks']
  private readonly whileFinishingPort: WorktreeLifecycleDeps['whileFinishing']
  private readonly requestCleanupPort: WorktreeLifecycleDeps['requestCleanup']
  private readonly removePort: WorktreeLifecycleDeps['remove']
  private readonly mainCopyOfPort: WorktreeLifecycleDeps['mainCopyOf']
  private readonly onQueuePort: WorktreeLifecycleDeps['onQueue']
  private readonly stepOfPort: WorktreeLifecycleDeps['stepOf']
  private readonly workflowOfPort: WorktreeLifecycleDeps['workflowOf']
  private readonly actionsOfPort: WorktreeLifecycleDeps['actionsOf']

  constructor(deps: WorktreeLifecycleDeps) {
    this.withControl = deps.withControl
    this.dirty = deps.dirty
    this.syncPort = deps.sync
    this.recordsPort = deps.records
    this.finishersPort = deps.finishers
    this.actionsPort = deps.actions
    this.provisionPort = deps.provision
    this.changedPort = deps.changed
    this.createPort = deps.create
    this.stopPort = deps.stop
    this.awaitExitPort = deps.awaitExit
    this.refreshPort = deps.refresh
    this.activityOfPort = deps.activityOf
    this.checksPort = deps.checks
    this.whileFinishingPort = deps.whileFinishing
    this.requestCleanupPort = deps.requestCleanup
    this.removePort = deps.remove
    this.mainCopyOfPort = deps.mainCopyOf
    this.onQueuePort = deps.onQueue
    this.stepOfPort = deps.stepOf
    this.workflowOfPort = deps.workflowOf
    this.actionsOfPort = deps.actionsOf
  }

  recover(recovery: { run(): Promise<void> }): Promise<void> { return recovery.run() }

  place(request: WorktreePlaceRequest) { return this.provisionPort.place(request) }
  create(request: WorktreeRequest) { return this.provisionPort.create(request) }
  purgeReserved(worktree: SessionRecordWorktree) { return this.provisionPort.purgeReserved(worktree) }

  finisherOf(record: SessionRecord): Promise<WorktreeFinisher> {
    return this.registration(record.worktree?.kind ?? 'git').load()
  }

  choicesOf(input: WorktreeChoicesInput): readonly SessionFinishChoice[] {
    return this.registration(input.worktree.kind ?? 'git').choices(input)
  }

  private registration(kind: import('../sessionManager/sessionManagerApi.types').SessionWorktreeKind) {
    const entry = this.finishersPort.get(kind)
    if (entry === undefined) throw new Error(`No finisher for worktree kind ${JSON.stringify(kind)}`)
    return entry
  }

  async keep(sessionId: string): Promise<SessionsOpResult> {
    const record = this.recordsPort()?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    const finisher = await this.finisherOf(record)
    if (finisher.ownsChecks) {
      const result = await this.press(sessionId, { choice: 'keep', requestedBy: 'cli' })
      return result.ok ? { ok: true, value: undefined } : result
    }
    return finisher.keep(sessionId)
  }

  requestCleanup(sessionId: string): Promise<SessionsOpResult> {
    const refusal = this.unreadable(sessionId)
    return refusal === undefined ? this.requestCleanupPort(sessionId) : Promise.resolve(refusal)
  }

  static onRunVerdict(actions: Pick<WorktreeActions, 'noteVerdict'>, sessionId: string, verdict: SvnActionVerdict): Promise<boolean> {
    return actions.noteVerdict(sessionId, verdict)
  }

  static due(records: readonly SessionRecord[], now: number, clientStartedAt: number, held: ReadonlySet<string>): WorktreeDueChange[] {
    return WorktreeDue.of(records, now, clientStartedAt, held)
  }

  async infoOf(sessionId: string): Promise<SessionsOpResult<SessionWorktreeState>> {
    const record = this.recordsPort()?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    const retired = record.retiredWorktree
    const finish = WorktreeLifecycle.legacyFinishOf(record)
    return {
      ok: true,
      value: {
        sessionId,
        ...record.worktreeLifecycle === undefined ? {} : { worktreeView: WorktreeViews.of(record.worktreeLifecycle) },
        worktree: record.worktree === undefined ? null : WorktreeLifecycle.worktreePlaceOf(record.worktree),
        retired: retired === undefined
          ? null
          : { worktreePath: retired.worktreePath, revisions: retired.revisions, removedAt: retired.removedAt },
        finish: finish === undefined ? null : { phase: finish.phase, scopeRoot: finish.scopeRoot ?? null },
        action: FinishProjection.action(record) === undefined ? null : SvnActionStages.infoOf(FinishProjection.action(record)!),
        outcome: record.worktreeOutcome ?? null,
        cleanup: record.worktreeCleanup === undefined
          ? null
          : { phase: record.worktreeCleanup.phase, reason: record.worktreeCleanup.reason ?? null },
        receipts: (record.commitReceipts ?? []).map(({ scopeRoot, revision, at }) => ({ scopeRoot, revision, at })),
        step: this.stepOfPort(record),
        workflow: this.workflowOfPort(record),
        actions: this.actionsOfPort(record),
      },
    }
  }

  /** Where the conflict paths of a session's SVN action are: the main copy its UPDATE works in, else its worktree. */
  conflictRootOf(sessionId: string): SessionsOpResult<{ root: string; place: 'main copy' | 'worktree' }> {
    const record = this.recordsPort()?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    if (record.svnAction?.kind === 'update-main') return { ok: true, value: { root: record.svnAction.root, place: 'main copy' } }
    if (record.worktree === undefined) return { ok: false, code: 'invalid-spec', detail: `Session ${sessionId} has no worktree` }
    return { ok: true, value: { root: record.worktree.worktreePath, place: 'worktree' } }
  }

  async conflictsOf(sessionId: string): Promise<SessionsOpResult<SessionConflictList>> {
    const record = this.recordsPort()?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    const parent = record.svnAction === undefined && record.scriptOf !== undefined
      ? this.recordsPort()?.get(record.scriptOf.sessionId) ?? record
      : record
    const lifecycle = parent.worktreeLifecycle
    const action = parent.svnAction?.kind === 'update-main' ? parent.svnAction : lifecycle?.syncConflictSet !== undefined && lifecycle.actionId !== null
      ? { actionId: lifecycle.actionId, stage: 'fixing' as const, conflictSet: lifecycle.syncConflictSet } : parent.svnAction
    const set = action?.conflictSet
    if (action === undefined || !SvnConflictWords.open(set))
      return { ok: false, code: 'not-found', detail: `Session ${sessionId} has no conflicts of an SVN action` }
    const listed = SvnConflictWords.listOf(set, set.entries.length, parent.svnAction?.kind === 'update-main' ? 'main-copy' : 'worktree')
    return { ok: true, value: {
      sessionId: parent.sessionId,
      actionId: action.actionId,
      stage: action.stage,
      summary: SvnConflictWords.summaryOf(set),
      entries: listed.entries,
      more: listed.more,
    } }
  }

  async resolveConflict(sessionId: string, request: SvnConflictResolveRequest): Promise<SessionsOpResult<SessionConflictResolved>> {
    const actions = await this.actionsPort()
    const record = this.recordsPort()?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    const run = record.svnAction === undefined && record.scriptOf !== undefined
    const parentId = run && record.scriptOf !== undefined ? record.scriptOf.sessionId : sessionId
    const refusal = this.unreadable(parentId)
    if (refusal !== undefined) return refusal
    // A run of the session settling its parent's conflicts is the merger; the session's own call is its worker's.
    const by = run ? 'merger' : request.requestedBy === 'window' ? 'person' : 'agent'
    const resolved = await actions.resolveConflict(parentId, { ...request, by })
    this.changedPort()
    return resolved
  }

  async solveWithAgent(sessionId: string): Promise<SessionsOpResult<SessionCreated>> {
    const refusal = this.unreadable(sessionId)
    if (refusal !== undefined) return refusal
    const actions = await this.actionsPort()
    const spec = await actions.helperOf(sessionId)
    if (!spec.ok) return spec
    return this.createPort(spec.value)
  }

  async backToWork(sessionId: string, requestedBy: SessionFinishPress['requestedBy'], confirmStoppedRunId?: string): Promise<SessionsOpResult<{ sessionId: string; actionId: string | null }>> {
    let actor: 'person' | 'agent'
    switch (requestedBy) {
      case 'window': actor = 'person'; break
      case 'cli': case 'peer': actor = 'agent'; break
      default: throw new Error(`Unknown Finish source: ${JSON.stringify(requestedBy satisfies never)}`)
    }
    const result = await (await this.actionsPort()).backToWork(sessionId, actor, confirmStoppedRunId)
    this.changedPort()
    return result.ok ? { ok: true, value: { sessionId, actionId: result.value.actionId } } : result
  }


  static decorate(info: import('../sessionManager/sessionManagerApi.types').SessionInfo): void { WorktreeWords.decorate(info) }

  static viewOf(record: SessionRecord) {
    return WorktreeViews.of(record.worktreeLifecycle)
  }

  static worktreePlaceOf(worktree: SessionRecordWorktree): SessionWorktreePlace {
    return WorktreeRecordView.worktreePlaceOf(worktree)
  }

  static legacyFinishOf(record: SessionRecord): SessionWorktreeInfo['finish'] {
    return WorktreeRecordView.legacyFinishOf(record)
  }

  async setupPaths(sessionId: string, paths: readonly string[]): Promise<SessionsOpResult<string[]>> {
    const refusal = this.unreadable(sessionId)
    if (refusal !== undefined) return refusal
    const record = this.recordsPort()?.get(sessionId)
    if (!record?.worktree) return { ok: true, value: [] }
    return this.registration(record.worktree.kind ?? 'git').session.setupPaths(record, paths)
  }

  async finish(record: SessionRecord, acknowledgeSetup: string | undefined,
    press: SessionFinishPress = { choice: 'merge', requestedBy: 'cli' }, continuation = false): Promise<SessionsOpResult> {
    const sessionId = record.sessionId
    const refusal = this.unreadable(sessionId)
    if (refusal !== undefined) return refusal
    const finisher = await this.finisherOf(record)
    if (finisher.ownsChecks) {
      const pressed = await this.press(sessionId, {
        ...acknowledgeSetup === undefined ? {} : { acknowledgeSetup },
        ...press, choice: 'commit',
      })
      this.changedPort()
      return pressed.ok ? { ok: true, value: undefined } : pressed
    }
    if (record.finishChecks !== undefined && record.finishChecks.result === undefined)
      return { ok: true, value: undefined }
    if (!continuation && finisher.prepare !== undefined) {
      const prepared = await finisher.prepare(sessionId, press)
      if (!prepared.ok) return prepared
      if (!prepared.value.ready) return { ok: true, value: undefined }
    }
    if (record.life === 'live' || record.life === 'starting') {
      if (this.activityOfPort(record) === 'working' && press.confirmWorking !== true)
        return { ok: false, code: 'session-working', detail: `Session ${sessionId} is still working; finish it anyway, or wait until it is ready` }
      const stopped = await this.stopPort(sessionId)
      if (!stopped.ok) return stopped
      if (!await this.awaitExitPort(sessionId))
        return { ok: false, code: 'live-refused', detail: `Session ${sessionId} is still stopping; Finish waits for its exit` }
      await this.refreshPort()
    }
    const gated = await this.checksPort(sessionId, acknowledgeSetup, null)
    if (!gated.ok) return gated
    const checks = gated.value
    if (checks.kind === 'refused') return checks.result
    else if (checks.kind === 'started' || checks.kind === 'running') return { ok: true, value: undefined }
    else if (checks.kind === 'none' || checks.kind === 'passed')
      return this.whileFinishingPort(sessionId, async () => {
        const finished = await finisher.finish(sessionId, press)
        return finished.ok ? { ok: true, value: undefined } : finished
      })
    else throw new Error(`Unknown Finish checks gate: ${JSON.stringify(checks satisfies never)}`)
  }

  async sync(sessionId: string, trigger: 'ready' | 'finish' | 'worker', confirmed = false) {
    const refusal = this.unreadable(sessionId)
    if (refusal !== undefined) return refusal
    return await this.syncPort?.(sessionId, trigger, confirmed) ?? { ok: false as const, code: 'invalid-spec' as const, detail: 'This worktree does not support sync' }
  }

  async press(sessionId: string, press: SessionFinishPress): Promise<SessionsOpResult<{ sessionId: string; actionId: string | null }>> {
    const record = this.recordsPort()?.get(sessionId)
    if (record != null && this.withControl !== undefined && (await this.finisherOf(record)).ownsChecks)
      return this.withControl(record, () => this.pressCurrent(sessionId, press))
    return this.pressCurrent(sessionId, press)
  }

  private async pressCurrent(sessionId: string, press: SessionFinishPress): Promise<SessionsOpResult<{ sessionId: string; actionId: string | null }>> {
    const refusal = this.unreadable(sessionId)
    if (refusal !== undefined) return refusal
    const record = this.recordsPort()?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    if (press.reviewVersion !== undefined && press.reviewVersion !== record.worktreeLifecycle?.version)
      return { ok: false, code: 'review-stale', detail: 'This review is outdated' }
    const worktree = record.worktree
    if (worktree === undefined) return { ok: false, code: 'invalid-spec', detail: `Session ${sessionId} has no worktree` }
    const finisher = await this.finisherOf(record)
    const state = finisher.ownsChecks ? record.worktreeLifecycle : undefined
    let actor: 'person' | 'agent'
    switch (press.requestedBy) {
      case 'window': actor = 'person'; break
      case 'cli': case 'peer': actor = 'agent'; break
      default: throw new Error(`Unknown Finish source: ${JSON.stringify(press.requestedBy satisfies never)}`)
    }
    if (state !== undefined && (press.choice === 'keep' || press.choice === 'discard')) {
      const dirty = await this.dirty?.(record) ?? true
      if (this.recordsPort()?.get(sessionId)?.worktreeLifecycle?.version !== state.version)
        return { ok: false, code: 'review-stale', detail: 'This review is outdated' }
      const at = Date.now()
      const transition = WorktreeTransitions.next(state, press.choice === 'keep' ? { kind: 'keep', dirty }
        : { kind: 'discard', dirty, permit: actor === 'agent' ? { kind: 'clean', provedAt: at, allowed: [] } : { kind: 'discard', by: 'person', at } }, actor)
      if (!transition.ok) return { ok: false, code: 'person-only', detail: transition.refusal }
    }
    if (actor === 'agent' && (press.choice === 'commit' || press.choice === 'merge') && (state?.owner === 'person' || state?.owner === 'remote-person')
      && (state.phase === 'finishing' || state.phase === 'waiting'))
      return { ok: false, code: 'person-only', detail: `The person holds this Finish${state.ownerSince === undefined ? '' : ` since ${new Date(state.ownerSince).toLocaleTimeString()}`}` }
    if (!finisher.ownsChecks) {
      let result: SessionsOpResult
      if (press.choice === 'keep') result = await finisher.keep(sessionId)
      else if (press.choice === 'discard') {
        if (record.life === 'live' || record.life === 'starting') {
          const stopped = await this.stopPort(sessionId)
          if (!stopped.ok) return stopped
          if (!await this.awaitExitPort(sessionId))
            return { ok: false, code: 'live-refused', detail: `Session ${sessionId} is still stopping; Discard waits for its exit` }
          await this.refreshPort()
        }
        result = await this.discardAndWait(sessionId)
      }
      else if (press.choice === 'commit' || press.choice === 'merge')
        result = await this.finish(record, press.acknowledgeSetup, press)
      else throw new Error(`Unknown finish choice: ${JSON.stringify(press.choice satisfies never)}`)
      this.changedPort()
      return result.ok ? { ok: true, value: { sessionId, actionId: null } } : result
    }
    const pressed = await (await this.finisherOf(record)).finish(sessionId, press)
    this.changedPort()
    return pressed.ok ? { ok: true, value: { sessionId, actionId: pressed.value.actionId } } : pressed
  }

  async discardAndWait(sessionId: string): Promise<SessionsOpResult> {
    const refusal = this.unreadable(sessionId)
    if (refusal !== undefined) return refusal
    const record = this.recordsPort()?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    if ((await this.finisherOf(record)).ownsChecks)
      return this.whileFinishingPort(sessionId, () => this.finisherOf(record).then((finisher) => finisher.discard(sessionId)))
    // The checks run in the worktree a Discard would take away under them.
    if (SessionScriptDefinitions.judging('finish', record))
      return {
        ok: false,
        code: 'merge-pending',
        detail: `Session ${sessionId}: its Finish checks are running; wait for them to end, or stop the check`,
      }
    return this.whileFinishingPort(sessionId, () => this.finisherOf(record).then((finisher) => finisher.discard(sessionId)))
  }

  async removeWithSession(sessionId: string): Promise<SessionsOpResult> {
    const refusal = this.unreadable(sessionId)
    if (refusal !== undefined) return refusal
    const record = this.recordsPort()?.get(sessionId)
    if (!record?.worktree) return this.removePort(sessionId)
    return this.registration(record.worktree.kind ?? 'git').session.removeWithSession(record)
  }

  async updateMain(sessionId: string, confirmLive: readonly string[] | undefined, requestedBy: SessionFinishPress['requestedBy'])
    : Promise<SessionsOpResult<{ sessionId: string; actionId: string }>> {
    return this.onQueuePort(async () => {
      const refusal = this.unreadable(sessionId)
      if (refusal !== undefined) return refusal
      const actions = await this.actionsPort()
      const record = this.recordsPort()?.get(sessionId)
      if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
      const mainCopy = await this.mainCopyOfPort(record)
      if (!mainCopy.ok) return mainCopy
      const running = (this.recordsPort()?.list() ?? []).find((other) => other.svnAction?.kind === 'update-main'
        && SvnActionStages.running(other) && PathCompare.comparable(other.svnAction.root) === PathCompare.comparable(mainCopy.value))
      if (running !== undefined)
        return { ok: false, code: 'merge-pending', detail: `An UPDATE of ${mainCopy.value} runs for session ${running.sessionId}; wait for it to end` }
      // A press starts the UPDATE whatever sessions work in the main copy: overlap protection keeps their
      // files' copies. `confirmLive` from older callers is accepted and no longer compared (Finish 072).
      const wait = requestedBy === 'window' && confirmLive === undefined
      const started = await actions.startUpdate(sessionId, mainCopy.value, requestedBy, wait)
      return started.ok ? { ok: true, value: { sessionId, actionId: started.value.actionId } } : started
    })
  }


  private unreadable(sessionId: string): { ok: false; code: 'invalid-spec'; detail: string } | undefined {
    const reason = this.recordsPort()?.get(sessionId)?.worktreeLifecycle?.unreadable
    return reason === undefined ? undefined : { ok: false, code: 'invalid-spec', detail: reason }
  }
}
