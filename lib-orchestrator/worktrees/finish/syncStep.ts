import { ConflictJournals } from '../conflicts/conflictJournals'
import { WorktreeLeaseHeld } from '../worktreeLease'
import { randomUUID } from 'node:crypto'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionRecordSvnAction } from '../../sessionManager/worktreeSessionRecords'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { SessionsOpResult, SessionWorktreeSyncResult } from '../../sessionManager/sessionManagerApi.types'
import type { SvnConflictActor } from '../worktreeContracts'
import type { SvnConflictFlow } from '../conflicts/svnConflictFlow'
import type { SvnStepRunner } from '../svnStepRunner'
import type { WorktreeSvnCommands } from '../worktreeSvnCommands'
import type { WorkerReady } from './workerIdle'
import { ErrorText } from '../../shared/errorText'
import { WorktreeUpdate } from '../worktreeUpdate'
import { SvnConflictWords } from '../conflicts/svnConflictWords'
import { SvnConflictIdentity } from '../conflicts/svnConflictIdentity'
import { WorktreeWords } from '../view/worktreeWords'

export type WorktreeSyncResult = SessionWorktreeSyncResult
export type WorktreeSyncTrigger = 'ready' | 'finish' | 'worker'

export class SyncStep {
  private readonly deps: {
    records: SessionRecordsStore
    svn: Pick<SvnWorktreeManager, 'headRevisionOf' | 'revisionOf' | 'conflictSet' | 'scheduleMissing' | 'updateTargets' | 'unmoved'>
    runner: Pick<SvnStepRunner, 'run'>
    commands: Pick<WorktreeSvnCommands, 'lease' | 'accept' | 'verify'>
    conflicts: Pick<SvnConflictFlow, 'remember' | 'remembered' | 'fix'> & Partial<Pick<SvnConflictFlow, 'resolve'>>
    handoffs?: Pick<import('../../sessionManager/worktreeSessionRuntime').WorkerHandoffs, 'conflicts'>
    ready: Pick<WorkerReady, 'current'>
    /** Why the worker does not count as idle, as a person reads it; null when it does. */
    busyReason: (sessionId: string) => string | null
    holdInput: (sessionId: string) => () => void
    changed: () => void
  }
  private readonly running = new Map<string, Promise<SessionsOpResult<WorktreeSyncResult>>>()
  private readonly controls = new Map<string, number>()
  private readonly updates: WorktreeUpdate

  constructor(deps: SyncStep['deps']) {
    this.deps = deps
    this.updates = new WorktreeUpdate({ ...deps, targets: deps.svn.updateTargets })
  }

  recover(sessionId: string, entry: import('../worktreeState').SvnStepJournalEntry): Promise<boolean> {
    return this.updates.recover(sessionId, entry, false)
  }

  async withControl<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    this.controls.set(sessionId, (this.controls.get(sessionId) ?? 0) + 1)
    try {
      // Finish must wait for a ready sync to release its lease, then prevent another one entering.
      await this.running.get(sessionId)
      return await work()
    } finally {
      const remaining = this.controls.get(sessionId)! - 1
      if (remaining === 0) this.controls.delete(sessionId)
      else this.controls.set(sessionId, remaining)
    }
  }

  run(sessionId: string, trigger: WorktreeSyncTrigger, confirmed = false): Promise<SessionsOpResult<WorktreeSyncResult>> {
    if (trigger !== 'finish' && this.controls.has(sessionId))
      return Promise.resolve({ ok: false, code: 'merge-pending', detail: 'Sync waits for the current Finish step' })
    const pending = this.running.get(sessionId)
    if (pending !== undefined) return pending
    const work = this.execute(sessionId, trigger, confirmed).catch(async (error: unknown) => {
      const detail = ErrorText.of(error)
      if (error instanceof WorktreeLeaseHeld) return { ok: false as const, code: 'svn-failed' as const, detail }
      await this.deps.records.update(sessionId, (record) => record.worktreeLifecycle === undefined
        || record.worktreeLifecycle.wait?.kind === 'changed-outside' ? null : {
          ...record, worktreeLifecycle: { ...record.worktreeLifecycle, version: record.worktreeLifecycle.version + 1,
            phase: 'waiting', wait: { kind: 'svn-failed', reason: detail, at: Date.now() } },
        })
      return { ok: false as const, code: 'svn-failed' as const, detail }
    }).finally(() => { this.running.delete(sessionId); this.deps.changed() })
    this.running.set(sessionId, work)
    return work
  }

  private async execute(sessionId: string, trigger: WorktreeSyncTrigger, confirmed: boolean): Promise<SessionsOpResult<WorktreeSyncResult>> {
    const record = this.deps.records.get(sessionId)
    if (record?.worktreeLifecycle?.unreadable !== undefined)
      return { ok: false, code: 'invalid-spec', detail: record.worktreeLifecycle.unreadable }
    if (record?.worktree?.kind !== 'svn') return { ok: false, code: 'invalid-spec', detail: 'Sync requires an SVN worktree' }
    if (record.pendingSetup !== undefined) return { ok: false, code: 'merge-pending', detail: 'Sync waits for setup to finish' }
    if (record.svnAction !== undefined && record.svnAction.stage !== 'changes' && record.svnAction.needs === undefined)
      return { ok: false, code: 'merge-pending', detail: 'The current SVN action must finish before sync' }
    const root = record.worktree.worktreePath
    return this.deps.commands.lease.within(root, 'update', async () => {
      const releaseInput = this.deps.holdInput(sessionId)
      try {
        const locked = this.deps.records.get(sessionId)
        if (locked?.worktree?.worktreePath !== root || locked.pendingSetup !== undefined
          || locked.svnAction !== undefined && locked.svnAction.stage !== 'changes' && locked.svnAction.needs === undefined)
          return { ok: false, code: 'merge-pending', detail: 'The worktree changed before sync acquired its lease' }
        if (trigger === 'ready') {
          if (!await this.deps.ready.current(sessionId) || this.deps.busyReason(sessionId) !== null)
            return { ok: false, code: 'session-working', detail: 'Automatic sync waits for current ready and fresh idle evidence' }
        }
        else if (trigger === 'finish') {
          const busy = locked.life === 'live' && !confirmed ? this.deps.busyReason(sessionId) : null
          if (busy !== null) return { ok: false, code: 'session-working', detail: WorktreeWords.syncBusyOf(busy) }
        }
        else if (trigger !== 'worker') throw new Error(`Unknown sync trigger: ${JSON.stringify(trigger satisfies never)}`)
        const latest = this.deps.records.get(sessionId)
        if (latest?.worktreeLifecycle === undefined) throw new Error('The worktree lifecycle is unavailable')
        if (trigger !== 'ready' && latest.svnAction === undefined && latest.worktreeLifecycle.review === undefined
          && latest.worktreeLifecycle.facts.syncedAt === undefined && latest.worktreeLifecycle.wait?.kind !== 'changed-outside')
          await this.deps.commands.accept(root)
        else await this.deps.commands.verify(root)
        const base = await this.deps.svn.revisionOf(root)
        if (!base.ok) throw new Error(base.detail)
        const actionId = latest.worktreeLifecycle.actionId ?? randomUUID()
        if (latest.worktreeLifecycle.actionId === null)
          await this.write(sessionId, (state) => ({ ...state, actionId }))
        let action: SessionRecordSvnAction = { actionId, kind: 'finish', stage: 'fixing', root, baseRevision: base.value,
          checks: [], checkCursor: 0, rootCursor: 0, rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'cli', startedAt: Date.now(),
          conflictSet: latest.worktreeLifecycle.syncConflictSet ?? latest.svnAction?.conflictSet }
        let memory = latest.worktreeLifecycle?.conflictMemory ?? latest.worktree?.conflictMemory
        if (memory !== undefined && memory.paths.length > 0) {
          const checked = await this.deps.conflicts.remembered(action, memory)
          if (!checked.ok) throw new Error(checked.detail)
          memory = checked.value.memory
          await this.saveConflicts(sessionId, memory, checked.value.set)
          if (checked.value.reasons.length > 0) {
            const value = { revision: base.value, conflicts: checked.value.set.entries.map(({ path, kind }) => ({ path, kind })) }
            await this.settled(sessionId, value)
            return { ok: true, value }
          }
        }
        const head = await this.deps.svn.headRevisionOf(root)
        if (!head.ok) throw new Error(head.detail)
        const native = await this.deps.svn.conflictSet(root, base.value)
        if (!native.ok) throw new Error(native.detail)
        const victims = [...new Set([...native.value.facts.map((entry) => entry.path),
          ...action.conflictSet?.entries.map((entry) => entry.path) ?? [], ...memory?.paths.map((entry) => entry.path) ?? []])]
        const scheduled = await this.deps.svn.scheduleMissing(root, victims)
        if (!scheduled.ok) throw new Error(scheduled.detail)
        // The owner's revision does not prove that a floating external is current.
        if (trigger === 'ready' && !this.updates.pending(sessionId) && latest.worktreeLifecycle.facts.syncedAt?.revision === head.value) {
          const result = await this.result(root, head.value)
          if (result.ok) await this.settled(sessionId, result.value, latest.worktreeLifecycle.facts.syncedAt.headMovedBy ?? 0)
          return result
        }
        // A HEAD moved only by commits elsewhere in the repository brings nothing, and its round cost
        // minutes (Mirabia 114: 3 and 2 min). Every publication proof reads the worktree's own BASE and
        // svn's out-of-date check, so HEAD is recorded as reached while the worktree stays where it is.
        if (!this.updates.pending(sessionId) && latest.worktreeLifecycle.updateFailure === undefined && latest.worktreeLifecycle.knownIncoming === undefined
          && native.value.facts.length === 0
          && !action.conflictSet?.entries.some((entry) => entry.state !== 'settled')) {
          const unmoved = await this.deps.svn.unmoved(root)
          if (!unmoved.ok) throw new Error(unmoved.detail)
          if (unmoved.value) {
            const value = { revision: head.value, conflicts: [] }
            await this.settled(sessionId, value, 0)
            return { ok: true, value }
          }
        }
        await this.write(sessionId, (state) => ({ ...state, phase: 'finishing', step: 'syncing', wait: undefined, actionId }))
        for (;;) {
          const update = await this.updates.run(sessionId, actionId, root, head.value)
          const remembered = await this.deps.conflicts.remember(action, memory)
          if (!remembered.ok) throw new Error(remembered.detail)
          const fresh = remembered.value.set
          const kept = action.conflictSet?.entries.filter(SyncStep.outlivesRead) ?? []
          // A settled kind whose path svn still marks for the other kind open beside it stays settled.
          const held = (entry: typeof fresh.entries[number]): boolean => SvnConflictIdentity.openBeside(fresh, entry)
            && kept.some((old) => old.state === 'settled' && old.occurrenceId === entry.occurrenceId && SvnConflictIdentity.same(old, entry))
          action = { ...action, conflictSet: { ...fresh, entries: [...new Map([...kept, ...fresh.entries.filter((entry) => !held(entry))]
            .map((entry) => [SvnConflictIdentity.keyOf(entry), entry])).values()] } }
          memory = remembered.value.memory
          await this.saveConflicts(sessionId, memory, action.conflictSet!)
          while (action.conflictSet?.entries.some((entry) => entry.state === 'rule')) {
            const next = await this.deps.conflicts.fix(action, () => {}, async (path, journal, kind) => {
              await this.write(sessionId, (state) => ConflictJournals.record(state, path, journal, kind))
            })
            action = next.action
            await this.saveConflicts(sessionId, memory, action.conflictSet!)
            if (next.kind === 'needs' && next.need !== 'conflict') throw new Error(next.reason)
            if (next.kind !== 'applied') break
          }
          const checked = await this.deps.conflicts.remembered(action, memory)
          if (!checked.ok) throw new Error(checked.detail)
          memory = checked.value.memory
          const live = await this.result(root, update.revision)
          if (!live.ok) return live
          const diverged = action.conflictSet!.entries.filter((entry) => entry.kind === 'diverged' && entry.state !== 'settled')
          const conflicts = [...new Map([...live.value.conflicts, ...[...diverged, ...checked.value.set.entries].map(({ path, kind }) => ({ path, kind }))]
            .map((entry) => [SvnConflictIdentity.keyOf(entry), entry])).values()]
          await this.saveConflicts(sessionId, checked.value.memory, { ...action.conflictSet!,
            entries: [...new Map([...action.conflictSet!.entries, ...checked.value.set.entries].map((entry) => [SvnConflictIdentity.keyOf(entry), entry])).values()] })
          // An update its conflicts held runs on to its own target; HEAD of this press may be newer (UA1-J14-5).
          if (conflicts.length === 0 && (!update.complete || update.revision < head.value)) continue
          const result = { ok: true as const, value: { revision: update.revision, conflicts } }
          await this.settled(sessionId, result.value, Math.max(0, update.revision - base.value))
          return result
        }
      } finally { releaseInput() }
    })
  }

  /**
   * What a fresh read of svn cannot restate: a settlement, and a same-name file a keep-both left
   * diverged, which is no svn conflict and stays open until an option settles it.
   */
  private static outlivesRead(entry: import('../../sessionManager/worktreeSessionRecords').SvnActionConflictEntry): boolean {
    return entry.state === 'settled' || entry.kind === 'diverged'
  }

  private async settled(sessionId: string, result: WorktreeSyncResult, headMovedBy?: number): Promise<void> {
    await this.write(sessionId, (state) => ({ ...state, phase: 'finishing', wait: undefined, awaitingIdleAt: undefined, awaitingIdleReason: undefined,
      step: result.conflicts.length === 0 ? 'checking' : 'worker-resolving',
      // A new sync may meet new dependency inputs, so the Finish may run the install once more.
      ...state.execution === undefined ? {} : { execution: { ...state.execution, refresh: undefined } },
      facts: { ...state.facts, syncedAt: headMovedBy === undefined ? state.facts.syncedAt : { revision: result.revision, at: Date.now(), headMovedBy },
        worker: { ...state.facts.worker, ready: undefined } } }))
    if (result.conflicts.length > 0) await this.deps.handoffs?.conflicts(sessionId)
  }

  async resolve(sessionId: string, request: import('../../sessionManager/sessionManagerApi.types').SvnConflictResolveRequest & { by?: SvnConflictActor })
    : Promise<SessionsOpResult<import('../../sessionManager/sessionManagerApi.types').SessionConflictResolved>> {
    const root = this.deps.records.get(sessionId)?.worktree?.worktreePath
    if (root === undefined || this.deps.conflicts.resolve === undefined)
      return { ok: false, code: 'not-found', detail: 'The worker has no conflict resolution step' }
    return this.deps.commands.lease.within(root, 'resolve', async () => {
      const record = this.deps.records.get(sessionId)
      const state = record?.worktreeLifecycle
      if (state?.step !== 'worker-resolving' || state.syncConflictSet === undefined || state.actionId === null)
        return { ok: false, code: 'merge-pending', detail: 'The worker is not resolving conflicts' }
      await this.deps.commands.verify(root)
      const action: SessionRecordSvnAction = { actionId: state.actionId, root, kind: 'finish', stage: 'fixing',
        checks: [], checkCursor: 0, rootCursor: 0, rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [],
        requestedBy: 'cli', startedAt: state.syncConflictSet.readAt, conflictSet: { ...state.syncConflictSet,
          entries: state.syncConflictSet.entries.map((entry) => ({ ...entry, journal: entry.journal ?? (entry.occurrenceId === undefined ? state.syncJournals?.[entry.path] : undefined) })) } }
      const result = await this.deps.conflicts.resolve!(action, { ...request, by: request.by ?? (request.requestedBy === 'window' ? 'person' : 'agent') },
        (path, journal, kind) => this.write(sessionId, (latest) => ConflictJournals.record(latest, path, journal, kind)), 'worker-resolving')
      if (!result.ok) return result
      const rememberedMemory = state.conflictMemory ?? record?.worktree?.conflictMemory
      const checked = rememberedMemory === undefined ? null
        : await this.deps.conflicts.remembered(result.value.action, rememberedMemory)
      if (checked !== null && !checked.ok) return { ok: false as const, code: 'svn-failed' as const, detail: checked.detail }
      const memory = checked?.ok ? checked.value.memory : state.conflictMemory
      const set = result.value.action.conflictSet!
      const entries = [...new Map([...set.entries, ...(checked?.ok ? checked.value.set.entries : [])].map((entry) => [SvnConflictIdentity.keyOf(entry), entry])).values()]
      const left = entries.filter((entry) => entry.state !== 'settled').length + set.more
      const merged = { ...set, entries }
      // The person's wait says what is left and names the press drawn for the step it moves to.
      const reason = left === 0 ? SvnConflictWords.settledOf(merged, WorktreeWords.tryAgainConst)
        : SvnConflictWords.reasonOf(merged, `press ${SvnConflictWords.checkAgainConst}`)
      const step = left === 0 ? this.updates.reached(sessionId, action.actionId) ? 'checking' : 'syncing' : 'worker-resolving'
      // The worker settled the conflicts Jamat handed it and still ends that turn: the sync waits for it
      // without a wait for the person, who had pressed Finish again in 2 of 4 such Finishes (worker-agent 031, 032).
      await this.write(sessionId, (latest) => ({ ...latest, step, conflictMemory: memory, syncConflictSet: merged,
        ...step === 'syncing' ? { awaitingIdleAt: Date.now(), awaitingIdleReason: undefined } : {},
        ...latest.wait?.kind === 'conflict-person' ? { wait: { ...latest.wait, reason } } : {} }))
      if (memory !== undefined) await this.saveConflicts(sessionId, memory, { ...set, entries })
      this.deps.changed()
      return { ok: true, value: { sessionId, path: request.path,
        state: entries.find((entry) => entry.path === request.path && (request.kind === undefined || entry.kind === request.kind))?.state ?? result.value.state, left } }
    })
  }

  private async saveConflicts(sessionId: string, memory: import('../../sessionManager/worktreeSessionRecords').SessionRecordConflictMemory,
    set: import('../../sessionManager/worktreeSessionRecords').SvnActionConflictSet): Promise<void> {
    if (!await this.deps.records.update(sessionId, (record) => record.worktree === undefined || record.worktreeLifecycle === undefined ? null : {
      ...record, worktree: { ...record.worktree, conflictMemory: undefined },
      worktreeLifecycle: { ...record.worktreeLifecycle, version: record.worktreeLifecycle.version + 1, conflictMemory: memory,
        syncConflictSet: { ...set, entries: [...new Map([
          ...(record.worktreeLifecycle.syncConflictSet?.entries.filter((entry) => entry.state === 'settled') ?? []),
          ...set.entries,
        ].map((entry) => [SvnConflictIdentity.keyOf(entry), entry])).values()] } },
    })) throw new Error('The sync conflicts could not be saved')
  }

  private async result(root: string, revision: number): Promise<SessionsOpResult<WorktreeSyncResult>> {
    const conflicts = await this.deps.svn.conflictSet(root, revision)
    if (!conflicts.ok) return { ok: false, code: 'svn-failed', detail: conflicts.detail }
    return { ok: true, value: { revision, conflicts: conflicts.value.facts.map(({ path, kind }) => ({ path, kind })) } }
  }

  private async write(sessionId: string, update: (state: import('../worktreeState').WorktreeLifecycle) => import('../worktreeState').WorktreeLifecycle): Promise<void> {
    if (!await this.deps.records.update(sessionId, (record) => record.worktreeLifecycle === undefined ? null : {
      ...record, worktreeLifecycle: { ...update(record.worktreeLifecycle), version: record.worktreeLifecycle.version + 1 },
    })) throw new Error('The sync state could not be saved')
  }
}
