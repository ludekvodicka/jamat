import { WorktreeLifecycleMigration } from '../../worktrees/worktreeLifecycleMigration'
import { WorktreeStateValidation } from '../../worktrees/worktreeStateValidation'
import { WorktreePublication } from '../../worktrees/worktreePublication'
import { JsonShape } from '../../shared/jsonShape'
import { randomUUID } from 'node:crypto'
import { copyFile, readdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { ErrorText } from '../../shared/errorText'
import { type JsonDocumentReading, JsonDocumentStore } from '../../shared/jsonDocumentStore'
import { SvnConflictShapes } from '../../svn/svnConflictShapes'
import { SessionLimits } from '../sessionLimits'
import type { SessionParentKind, SessionWorktreeKind, SvnLabelledRevision } from '../sessionManagerApi.types'
import { SessionScriptDefinitions } from '../scripts/sessionScriptDefinitions'
import { SessionWorkflows } from '../lifecycle/sessionWorkflows'
import { SessionActionHistory } from './sessionActionHistory'
import type {
  SessionRecord,
  SessionRecordActionHistory,
  SessionRecordCommitReceipt,
  SessionRecordParentLink,
  SessionRecordProcess,
  SessionRecordScriptLink,
  SessionRecordScriptRun,
  SessionRecordScriptStep,
  SessionRecordSvnAction,
  SessionRecordsDocument,
  SessionRecordWorktreeCaller,
  SvnActionConflictEntry,
  SvnActionConflictSet,
  SvnActionFixed,
  SvnActionMerger,
  SvnActionNotice,
} from './sessionRecord.types'

export interface SessionRecordsStoreOptions {
  snapshotsDirectory: string
  report?: (message: string) => void
  removeSessionLogs?: (sessionId: string, keepIds?: readonly string[]) => Promise<void>
}

/**
 * The session records on disk. Reads are lenient and writes are strict, the asymmetry
 * `ClientStateStore` and `CatalogStore` already use here: one unusable record must not cost the
 * others, while a bad write would quietly replace what the client meant to keep.
 *
 * Unlike the catalog this file is never hand-edited, so it is read once at load and held in memory;
 * there is no mtime re-read and the client's main process is the only writer.
 *
 * **A recovery point is spent only on a destructive transition** - removing a record, or adopting an
 * orphan into one. Status and binding updates land on every reconcile tick, and snapshotting those
 * would push every real recovery point out of the ring within seconds.
 */
export class SessionRecordsStore extends JsonDocumentStore<SessionRecord[]> {
  private static readonly snapshotKeepConst = 10
  private static readonly snapshotPatternConst =
    /^session-records-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/
  private static readonly finishResultsConst: readonly unknown[] = ['committed', 'partial',
    'not-committed', 'out-of-date', 'updated', 'conflict', 'nothing', 'failed', 'interrupted']
  private static readonly finishMainPatternConst = /^(?:none|updated|failed|merged:\d+|conflict:\d+)$/
  private static readonly svnActionStagesConst: readonly unknown[] = ['main-update', 'changes', 'committing', 'stopping', 'evidence', 'checks', 'updating',
    'cleaning', 'resolving', 'merging', 'verifying', 'fixing', 'diffing', 'reviewing', 'removing', 'recording']
  private static readonly svnActionNeedsConst: readonly unknown[] = ['check-failed', 'conflict', 'resolver-failed', 'incoming',
    'out-of-date', 'review-cancelled', 'review-interrupted', 'partial', 'pinned-external', 'locked', 'svn-failed', 'removal-blocked', 'not-stopped', 'worker-busy']
  private static readonly revisionLabelsConst: readonly unknown[] = ['receipt', 'base-proof', 'inferred']
  private static readonly conflictKindsConst: readonly unknown[] = ['text', 'property', 'tree', 'diverged']
  private static readonly conflictStatesConst: readonly unknown[] = ['rule', 'agent', 'person', 'settled']
  private static readonly conflictActorsConst: readonly unknown[] = ['jamat', 'agent', 'merger', 'person']
  private static readonly parentKindsConst: readonly unknown[] = ['worktree', 'ticket', 'worker'] satisfies readonly SessionParentKind[]
  private records: SessionRecord[] = []
  private readonly unreadableRecords = new Map<string, SessionRecord>()
  private readonly pendingUserInput = new Map<string, number>()
  /** How many records the read turned from a cut-short finish into an `interrupted` outcome. */
  private interruptedFinishes = 0
  private migratedActions = 0
  private migratedLifecycles = 0
  private migratedSetups = 0
  private documentRead = false
  private readonly snapshotsDirectory: string
  private readonly removeSessionLogs: (sessionId: string, keepIds?: readonly string[]) => Promise<void>

  private constructor(
    file: string,
    snapshotsDirectory: string,
    report: (message: string) => void,
    removeSessionLogs: (sessionId: string, keepIds?: readonly string[]) => Promise<void>,
  ) {
    super(file, report)
    this.snapshotsDirectory = snapshotsDirectory
    this.removeSessionLogs = removeSessionLogs
  }

  protected get subject(): string {
    return 'Session records'
  }

  protected get refusalConsequence(): string {
    return 'nothing is written for the rest of this session'
  }

  protected get readFailureConsequence(): string {
    return 'starting from none'
  }

  protected emptyDocument(): SessionRecord[] {
    return []
  }

  protected writeFailureMessage(detail: string): string {
    return `Session records at ${this.file} could not be written (${detail}); the file is `
      + 'left exactly as it is, so this change was not recorded anywhere'
  }

  static async load(
    file: string,
    options: SessionRecordsStoreOptions,
  ): Promise<SessionRecordsStore> {
    const store = new SessionRecordsStore(
      file,
      options.snapshotsDirectory,
      options.report ?? ((message) => console.warn(message)),
      options.removeSessionLogs ?? (() => Promise.resolve()),
    )
    await store.read()
    const endedIds = SessionWorkflows.endedHistoryOf(store.records)
    const ended = store.records.filter((record) => endedIds.has(record.sessionId))
    if ((store.interruptedFinishes + store.migratedActions + store.migratedLifecycles + store.migratedSetups > 0
      || ended.some((record) => record.actionHistory !== undefined || record.scriptRuns !== undefined))
      && !await store.inTurn(() => store.commit(store.records, true)))
      store.report(`Session records at ${file}: migrated worktree records could not be written back; `
        + 'they stay migrated in memory until the next write')
    if (!store.latched)
      for (const record of ended)
        if (!store.unreadableRecords.has(record.sessionId) && store.get(record.sessionId)?.actionHistory === undefined && store.get(record.sessionId)?.scriptRuns === undefined)
          await store.removeLogs(record.sessionId)
    return store
  }

  /** Every mutation of this store, in the order it was asked for. See `inTurn`. */
  private writes: Promise<unknown> = Promise.resolve()

  list(): readonly SessionRecord[] {
    return this.records
  }

  /**
   * Whether the load read a document out of the file. False for a missing file and for one that
   * could not be read or used: an empty list then says nothing about which sessions exist, so
   * nothing may be deleted for not being in it.
   */
  get loadedFromFile(): boolean {
    return this.documentRead
  }

  get(sessionId: string): SessionRecord | null {
    return this.records.find((record) => record.sessionId === sessionId) ?? null
  }

  lastUserInputAt(sessionId: string): number | null {
    return this.pendingUserInput.get(sessionId) ?? this.get(sessionId)?.lastUserInputAt ?? null
  }

  noteUserInput(sessionId: string, at: number): void {
    if (!Number.isFinite(at) || at <= 0) throw new Error('User input time must be a positive timestamp')
    if (this.get(sessionId) && at > (this.lastUserInputAt(sessionId) ?? 0))
      this.pendingUserInput.set(sessionId, at)
  }

  /**
   * Resolves once every write queued so far has landed on disk.
   *
   * It exists for shutdown. The write went off the event loop on 2026-09-21, so a poll that was
   * still in flight when `stop()` ran can queue a record write AFTER the flush that stop awaits -
   * and a caller that removes the state directory next, which is what every integration test does,
   * meets a file still being written. The queue is the evidence: a turn that does nothing is
   * behind every turn that does.
   */
  async settled(): Promise<void> {
    await this.inTurn(() => Promise.resolve(true))
  }

  async flushUserInput(): Promise<boolean> {
    return this.inTurn(() => this.pendingUserInput.size === 0
      ? Promise.resolve(true) : this.commit(this.records, false))
  }

  /** Insert or replace. Routine, so it spends no recovery point. Answers whether it landed. */
  async put(record: SessionRecord, options: { newLifetime?: boolean } = {}): Promise<boolean> {
    if (this.unreadableRecords.has(record.sessionId)) return false
    // Validated OUTSIDE the turn: a record this store would refuse is refused to the caller
    // that wrote it, at the moment they wrote it, rather than after a wait behind somebody else.
    SessionRecordsStore.assertValid(record)
    return this.inTurn(() => {
      const next = this.records.filter((entry) => entry.sessionId !== record.sessionId)
      next.push(record)
      return this.commit(next, false, options.newLifetime === true ? record.sessionId : undefined)
    })
  }

  /**
   * Read-modify-write of one record with the read INSIDE the turn, so a write queued meanwhile is
   * never undone by a stale copy. `change` answers null to write nothing, and so does a missing
   * record; either answers false. Routine, so it spends no recovery point.
   */
  async update(sessionId: string, change: (record: SessionRecord) => SessionRecord | null, options: { newLifetime?: boolean } = {}): Promise<boolean> {
    return this.inTurn(() => {
      if (this.unreadableRecords.has(sessionId)) return Promise.resolve(false)
      const current = this.get(sessionId)
      const changed = current === null ? null : change(current)
      const next = changed === null ? null : SessionRecordsStore.retainPublication(changed, current ?? undefined)
      if (next === null) return Promise.resolve(false)
      if (next.sessionId !== sessionId) throw new Error(`An update of ${sessionId} answered ${next.sessionId}`)
      SessionRecordsStore.assertValid(next)
      return this.commit(this.records.map((record) => record.sessionId === sessionId ? next : record), false, options.newLifetime ? sessionId : undefined)
    })
  }

  /**
   * Inserts `record` and changes `parentId` in one write. A writer off the session queue uses it for
   * a run and the pointer naming it: a reconcile pass between two writes would collapse the run as
   * never launched. Answers false, writing nothing, for a missing parent or a null `change`.
   */
  async putWith(record: SessionRecord, parentId: string, change: (parent: SessionRecord) => SessionRecord | null): Promise<boolean> {
    if (this.unreadableRecords.has(record.sessionId) || this.unreadableRecords.has(parentId)) return false
    SessionRecordsStore.assertValid(record)
    return this.inTurn(() => {
      const current = this.get(parentId)
      const changed = current === null ? null : change(current)
      const parent = changed === null ? null : SessionRecordsStore.retainPublication(changed, current ?? undefined)
      if (parent === null) return Promise.resolve(false)
      if (parent.sessionId !== parentId) throw new Error(`An update of ${parentId} answered ${parent.sessionId}`)
      SessionRecordsStore.assertValid(parent)
      return this.commit([...this.records.filter((entry) => entry.sessionId !== record.sessionId)
        .map((entry) => entry.sessionId === parentId ? parent : entry), record], false)
    })
  }

  async clearActions(sessionId: string): Promise<boolean> {
    if (this.unreadableRecords.has(sessionId)) return false
    return this.inTurn(() => {
      const current = this.get(sessionId)
      if (current === null) return Promise.resolve(false)
      const runs = (id: string): SessionRecord | null => this.get(id)
      const sections = SessionWorkflows.sectionsOf(current, runs)
      const cleared = sections.filter((section) => !section.open && section.actions.length === 0).map((section) => section.workflowId)
      if (cleared.length === 0) return Promise.resolve(true)
      const keepRunIds = new Set(SessionWorkflows.openRunIdsOf(current, runs))
      if (sections.some((section) => section.kind === 'before' && (section.open || section.actions.length > 0))) {
        for (const run of current.scriptRuns ?? [])
          if (run.phase === 'before') keepRunIds.add(run.runId)
        if (current.pendingSetup !== undefined) keepRunIds.add(current.pendingSetup.setupSessionId)
      }
      for (const run of this.records)
        if (run.scriptOf?.sessionId === sessionId && (run.life === 'live' || run.life === 'starting')) keepRunIds.add(run.sessionId)
      if (current.worktreeOutcome !== undefined) cleared.push(`ended:${current.worktreeOutcome.at}`)
      const next = { ...current, clearedWorkflowIds: [...new Set([...current.clearedWorkflowIds ?? [], ...cleared])] }
      return this.commit(this.records.map((record) => record.sessionId === sessionId ? next : record), true, undefined, { sessionId, keepRunIds })
    })
  }

  /**
   * Records disappear for good, so the previous file is kept as a recovery point first. A caller
   * whose removal is already recorded elsewhere may spend none; one write takes every id.
   */
  async remove(
    sessionIds: string | readonly string[],
    options: { recoveryPoint: boolean } = { recoveryPoint: true },
  ): Promise<boolean> {
    if ((typeof sessionIds === 'string' ? [sessionIds] : sessionIds).some((id) => this.unreadableRecords.has(id))) return false
    // The latch is checked before the no-op short-circuit on purpose: after a failed read the
    // in-memory list is empty because nothing could be read, so "there was nothing to remove" is
    // exactly the answer this store cannot honestly give.
    if (!this.mayWrite()) return false
    const gone = new Set(typeof sessionIds === 'string' ? [sessionIds] : sessionIds)
    return this.inTurn(() => {
      const next = this.records.filter((record) => !gone.has(record.sessionId))
      if (next.length === this.records.length) return Promise.resolve(true)
      return this.commit(next, options.recoveryPoint)
    })
  }

  /**
   * Adopting an orphan writes a record around a runtime nobody was tracking. It is the one addition
   * that earns a recovery point: it is how a mistaken adoption becomes undoable.
   */
  async adopt(record: SessionRecord): Promise<boolean> {
    if (this.unreadableRecords.has(record.sessionId)) return false
    SessionRecordsStore.assertValid(record)
    return this.inTurn(() => {
      const next = this.records.filter((entry) => entry.sessionId !== record.sessionId)
      next.push(record)
      return this.commit(next, true)
    })
  }

  /**
   * One writer at a time, and the read of `this.records` is INSIDE the turn.
   *
   * Every mutation here is a read-modify-write with an await in the middle: `commit` takes a
   * recovery point before a destructive write, which is a `copyFile` and a rotation. A second
   * mutation that computed its list before that await and wrote after it silently reverted the
   * first, in memory and on disk - a lost `clearWorktree` leaves a record naming a worktree that
   * is gone. Nothing outside serialises them: the merge flow deliberately runs off the session
   * manager's operation queue, because its git steps must not hold it, and `resumeMerge` is
   * fired from inside a reconcile pass without being awaited.
   *
   * The queue is per store, like the records it guards. A rejection is swallowed on the CHAIN
   * only, or it would be re-thrown into every write that queued behind it; the caller who asked
   * still gets it.
   */
  private async inTurn(work: () => Promise<boolean>): Promise<boolean> {
    const run = this.writes.then(work)
    this.writes = run.catch(() => undefined)
    return run
  }

  /**
   * A write that does not land answers `false`, exactly as a refused one does, and that is what makes
   * `put`'s contract - false means the file did not change - true for the disk as well as for the
   * latch. A throw would reach the callers as a rejected promise instead of the typed refusal every
   * one of them is written around.
   *
   * That is the whole of it, and it is worth saying what it is NOT. The `false` undoes nothing and
   * can undo nothing: whatever the caller did before it asked for this write is still done, and
   * saying so belongs to the caller - `SessionLifecycle.create` names the worktree and the branch a
   * refused write leaves with nothing pointing at them, because the slug stays taken either way.
   * What this method promises reaches exactly as far as the file.
   *
   * The read latch is untouched by this. A file that could not be READ still refuses every write for
   * the rest of the session, because writing over damage is how a workspace was lost.
   */
  private async commit(records: SessionRecord[], destructive: boolean, newLifetime?: string,
    clear?: { sessionId: string; keepRunIds: ReadonlySet<string> }): Promise<boolean> {
    const previous = new Map(this.records.map((record) => [record.sessionId, record]))
    records = records.map((record) => this.unreadableRecords.has(record.sessionId) ? record
      : SessionRecordsStore.retainPublication(record, previous.get(record.sessionId)))
    const at = Date.now()
    const resetHistory = new Map(records.filter((record) => record.sessionId === newLifetime
      && !(record.worktreeLifecycle?.phase === 'active' || record.worktreeLifecycle?.phase === 'finishing' || record.worktreeLifecycle?.phase === 'waiting'))
      .map((record) => [record.sessionId, SessionWorkflows.openRunIdsOf(record, (id) => previous.get(id) ?? null)]))
    if (clear !== undefined) resetHistory.set(clear.sessionId, clear.keepRunIds)
    records = records.map((record) => {
      const link = record.scriptOf
      return link !== undefined && resetHistory.has(link.sessionId) && !resetHistory.get(link.sessionId)!.has(record.sessionId)
        ? { ...record, scriptOf: { ...link, historyExpired: true } } : record
    })
    const ended = SessionWorkflows.endedHistoryOf(records)
    const previouslyEnded = SessionWorkflows.endedHistoryOf(this.records)
    const nextIds = new Set(records.map((record) => record.sessionId))
    const removedLogs = new Set(this.records.filter((record) => !nextIds.has(record.sessionId)).map((record) => record.sessionId))
    for (const id of resetHistory.keys()) removedLogs.add(id)
    for (const record of records)
      if (record.scriptOf?.historyExpired === true && record.life !== 'live' && record.life !== 'starting'
        && (previous.get(record.sessionId)?.scriptOf?.historyExpired !== true
          || previous.get(record.sessionId)?.life === 'live' || previous.get(record.sessionId)?.life === 'starting'))
        removedLogs.add(record.scriptOf.sessionId)
    for (const record of this.records)
      if (record.scriptOf?.historyExpired === true && !nextIds.has(record.sessionId)) removedLogs.add(record.scriptOf.sessionId)
    records = records.map((record) => {
      const before = previous.get(record.sessionId) ?? null
      const active = resetHistory.get(record.sessionId)
      if (active !== undefined) {
        const next = { ...record }
        if (record.sessionId === newLifetime) delete next.clearedWorkflowIds
        delete next.actionHistory
        const kept = next.scriptRuns?.filter((run) => active.has(run.runId)) ?? []
        if (kept.length > 0) next.scriptRuns = kept
        else delete next.scriptRuns
        return next
      }
      if (record.life === 'starting' && record.pendingOperationKind === 'reopen') return record
      if (ended.has(record.sessionId) && !SessionWorkflows.holdsWorktreeHistory(record)) {
        if (before === null || !previouslyEnded.has(record.sessionId)
          || record.actionHistory !== undefined || record.scriptRuns !== undefined)
          removedLogs.add(record.sessionId)
        if (record.actionHistory === undefined && record.scriptRuns === undefined) return record
        const next = { ...record }
        delete next.actionHistory
        delete next.scriptRuns
        return next
      }
      return SessionActionHistory.preserve(before !== null && previouslyEnded.has(record.sessionId) ? null : before, record, at)
    })
    for (const record of records) SessionRecordsStore.assertValid(record)
    const inputTimes = new Map(this.records.map((record) => [record.sessionId, record.lastUserInputAt ?? 0]))
    for (const [sessionId, at] of this.pendingUserInput) inputTimes.set(sessionId, at)
    records = records.map((record) => {
      const at = Math.max(record.lastUserInputAt ?? 0, inputTimes.get(record.sessionId) ?? 0)
      return at > 0 ? { ...record, lastUserInputAt: at } : record
    })
    const document: SessionRecordsDocument = { schemaVersion: 1, savedAt: Date.now(),
      records: records.map((record) => this.unreadableRecords.get(record.sessionId) ?? record) }
    // A destructive write with no recovery point behind it is refused rather than made: `false`
    // means "the file was left as this write found it", and that has to stay true of the case
    // where the undo this class promises would not be there afterwards.
    const written = await this.writeDocument(document, async () => {
      if (!destructive || await this.snapshotCurrent()) return true
      this.report(
        `Session records at ${this.file} were not changed: no recovery point could be taken `
        + 'first, and a destructive write without one cannot be undone',
      )
      return false
    })
    if (!written) return false
    this.records = records
    for (const sessionId of removedLogs) {
      if (this.unreadableRecords.has(sessionId)) continue
      const parent = this.get(sessionId)
      if (parent !== null && SessionWorkflows.holdsWorktreeHistory(parent)) continue
      const keepIds = parent === null || ended.has(sessionId) ? [] : [
        ...resetHistory.get(sessionId) ?? [],
        ...parent?.scriptRuns?.map((run) => run.runId) ?? [],
        ...records.filter((run) => run.scriptOf?.sessionId === sessionId && (run.life === 'live' || run.life === 'starting'))
          .map((run) => run.sessionId),
        ...parent?.svnAction === undefined ? [] : [parent.svnAction.actionId],
      ]
      await this.removeLogs(sessionId, keepIds)
    }
    for (const [sessionId, at] of this.pendingUserInput)
      if (!this.get(sessionId) || at <= (this.get(sessionId)?.lastUserInputAt ?? 0))
        this.pendingUserInput.delete(sessionId)
    return true
  }

  private async removeLogs(sessionId: string, keepIds?: readonly string[]): Promise<void> {
    try {
      await this.removeSessionLogs(sessionId, keepIds)
    } catch (error) {
      this.report(`The script logs of session ${sessionId} could not be removed: ${ErrorText.of(error)}`)
    }
  }

  private async read(): Promise<void> {
    this.records = await this.readDocument()
  }

  private static retainPublication(record: SessionRecord, previous?: SessionRecord): SessionRecord {
    if (record.worktreeLifecycle === undefined) return record
    const sameDirectory = (record.worktree?.directoryId ?? record.retiredWorktree?.directoryId)
      === (previous?.worktree?.directoryId ?? previous?.retiredWorktree?.directoryId)
      && (record.worktree?.worktreePath ?? record.retiredWorktree?.worktreePath)
      === (previous?.worktree?.worktreePath ?? previous?.retiredWorktree?.worktreePath)
    return { ...record, worktreeLifecycle: WorktreePublication.retain(record.worktreeLifecycle, sameDirectory ? previous?.worktreeLifecycle : undefined) }
  }

  /**
   * A document this store cannot use at all throws, which the base reads as damage and as the reason
   * to refuse every later write. A single unusable RECORD is dropped aloud instead: the rest of the
   * file is still every other session, and losing one record is not a reason to stop writing.
   */
  protected coerce(parsed: unknown): JsonDocumentReading<SessionRecord[]> {
    const document = this.recordsOf(parsed)
    this.documentRead = true
    return { document, damaged: false }
  }

  /** Unknown fields ride through untouched; a record that cannot be used is dropped aloud. */
  private recordsOf(parsed: unknown): SessionRecord[] {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('expected an object')
    const document = parsed as Partial<SessionRecordsDocument>
    if (document.schemaVersion !== 1)
      throw new Error(`unsupported schema version ${JSON.stringify(document.schemaVersion)}`)
    if (document.records !== undefined && !Array.isArray(document.records))
      throw new Error('records must be an array')
    const seen = new Set<string>()
    const records: SessionRecord[] = []
    let unverified = 0
    for (const candidate of document.records ?? []) {
      const original = structuredClone(candidate)
      SessionRecordsStore.migrateScriptLink(candidate)
      this.dropDamagedAnnotations(candidate, original)
      const reason = SessionRecordsStore.problemOf(candidate, seen)
      if (reason) {
        if (this.unreadableRecords.has(candidate.sessionId) && !seen.has(candidate.sessionId)) {
          records.push({ sessionId: candidate.sessionId, kind: 'shell', title: typeof candidate.title === 'string' ? candidate.title : candidate.sessionId,
            life: 'lost', binding: null, createdAt: 0, worktreeLifecycle: candidate.worktreeLifecycle,
            directory: SessionRecordsStore.directoryProblem(candidate.directory) === null ? candidate.directory : { mode: 'adHoc', path: dirname(this.file) },
            ...(SessionRecordsStore.worktreeProblem(candidate.worktree) === null ? { worktree: candidate.worktree } : {}) })
          seen.add(candidate.sessionId)
          this.report(`Session ${candidate.sessionId} remains quarantined: ${reason}`)
          continue
        }
        this.report(`Session records at ${this.file}: dropping a record (${reason})`)
        continue
      }
      const record = candidate as SessionRecord
      if (this.unreadableRecords.has(record.sessionId)) {
        seen.add(record.sessionId)
        records.push(record)
        continue
      }
      // Older removal records kept a setup agreement after its worktree was gone.
      if (record.pendingSetup !== undefined && record.worktree === undefined && record.retiredWorktree?.kind === 'svn'
        && (record.life === 'ended' || record.life === 'lost')) {
        if (record.pendingSetup.agreement !== undefined) {
          record.endedReason = 'Setup cancelled; worktree removed'
          record.stopRequested = true
        }
        delete record.pendingSetup
        this.migratedSetups++
      }
      const merge = record.worktreeMerge
      if (merge !== undefined) {
        if (merge.changes !== true) delete merge.changes
        if (typeof merge.endedAt !== 'number' || !Number.isFinite(merge.endedAt)) delete merge.endedAt
        const approval = merge.approval
        if (approval === null || typeof approval !== 'object' || !Array.isArray(approval.selection)
          || !approval.selection.every((path) => typeof path === 'string') || typeof approval.message !== 'string')
          delete merge.approval
        else if (approval.hashes !== undefined && (approval.hashes === null || typeof approval.hashes !== 'object'
          || Array.isArray(approval.hashes) || !Object.values(approval.hashes).every((hash) => typeof hash === 'string')))
          delete approval.hashes
        if (!Array.isArray(merge.runs)) delete merge.runs
        else merge.runs = merge.runs.filter((run) => run !== null && typeof run === 'object'
          && ['commit', 'base-merging', 'resolving', 'main-merging', 'tearing-down'].includes(run.phase)
          && typeof run.runId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(run.runId)
          && typeof run.startedAt === 'number' && Number.isFinite(run.startedAt)
          && (run.endedAt === undefined || typeof run.endedAt === 'number' && Number.isFinite(run.endedAt)))
          .slice(-10).map((run) => run.endedAt === undefined
            ? { ...run, endedAt: Date.now(), failed: true } : run)
        if (merge.runs?.some((run) => run.failed === true) && merge.endedAt === undefined && merge.failure === undefined)
          merge.failure = 'A command was interrupted; review the changes before continuing'
      }
      const action = record.svnAction
      if (action?.kind === 'finish' && (action.flowVersion === undefined || action.stage === 'reviewing')) {
        action.flowVersion = 1
        action.stage = 'changes'
        // Dropping the pointer makes the old run an orphan; neither its exit nor a restart may commit.
        delete action.runId
        delete action.verdict
        delete action.retryAt
        delete action.needs
        delete (action as unknown as Record<string, unknown>).reviewCommitId
        delete action.merger
        delete action.commit
        this.migratedActions++
      }
      const agent = record.agent
      if (agent?.agentId === 'codex' && agent.nativeSessionId !== undefined
        && agent.nativeSessionIdSource === undefined) {
        if (agent.launchMode === 'resume') agent.nativeSessionIdSource = 'provided'
        else {
          agent.unverifiedNativeSessionId = agent.nativeSessionId
          delete agent.nativeSessionId
          unverified++
        }
      }
      // The one field this store does NOT let ride through, because it is gone rather than unknown:
      // a record written before 2026-09-23 may still say `presentation: "tab"`, and such a session
      // is an ordinary session of the tree now. Dropping it on read is what clears it from the file
      // - the next write of any record writes the whole document - so this line retires itself.
      delete (record as { presentation?: unknown }).presentation
      seen.add(record.sessionId)
      const migrated = record.worktreeFinish === undefined ? record : SessionRecordsStore.interruptedFinishOf(record, Date.now())
      if (record.worktreeFinish !== undefined) this.interruptedFinishes++
      if (migrated.worktreeLifecycle === undefined) {
        const lifecycle = WorktreeLifecycleMigration.fromOld(migrated)
        if (lifecycle !== null) {
          migrated.worktreeLifecycle = lifecycle
          this.migratedLifecycles++
        }
      }
      const retained = SessionRecordsStore.retainPublication(migrated)
      if (JSON.stringify(retained.worktreeLifecycle) !== JSON.stringify(migrated.worktreeLifecycle)) this.migratedLifecycles++
      records.push(retained)
    }
    if (unverified > 0)
      this.report(`Codex identity migration: ${unverified} old inferred bindings are unverified; `
        + 'their original IDs are preserved. Open the intended conversation explicitly from Codex history to resume it')
    return records
  }

  /**
   * Before 2026-10-07 a setup run said `setupFor` and a resolver `resolveFor`. Each becomes the one
   * link, BEFORE validation, so a malformed old value is dropped aloud by the link's own check rather
   * than read as an ordinary session. The next write of any record writes the whole document, so this
   * migration retires itself.
   */
  private static migrateScriptLink(candidate: unknown): void {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return
    const legacy = candidate as { scriptOf?: unknown; setupFor?: unknown; resolveFor?: unknown }
    if (legacy.scriptOf === undefined && legacy.setupFor !== undefined)
      legacy.scriptOf = { sessionId: legacy.setupFor, phase: 'before', scriptId: 'setup', name: 'setup' }
    else if (legacy.scriptOf === undefined && legacy.resolveFor !== undefined)
      legacy.scriptOf = { sessionId: legacy.resolveFor, phase: 'after', scriptId: 'merge-resolve', name: 'resolver' }
    delete legacy.setupFor
    delete legacy.resolveFor
  }

  /**
   * The script history and the Finish checks annotate a session; one value an older or newer build
   * wrote that this one cannot read costs that annotation, said aloud, never the session with its
   * worktree pointer and its gates. Written records still have to be whole: `assertValid` refuses.
   */
  private dropDamagedAnnotations(candidate: unknown, original: SessionRecord): void {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return
    const record = candidate as Partial<SessionRecord>
    const subject = `Session records at ${this.file}: record ${JSON.stringify(record.sessionId)}`
    if (record.worktreeLifecycle !== undefined) {
      const lifecycle = WorktreeStateValidation.parse(record.worktreeLifecycle)
      if (lifecycle === undefined) {
        this.quarantine(record, original, 'Unreadable worktree lifecycle; use a compatible build or recover the saved record before continuing')
      }
      else {
        if (JSON.stringify(record.worktreeLifecycle) !== JSON.stringify(lifecycle)) this.migratedLifecycles++
        record.worktreeLifecycle = lifecycle
      }
    }
    if (record.clearedWorkflowIds !== undefined && !SessionRecordsStore.isStringList(record.clearedWorkflowIds)) {
      this.report(`${subject}: dropping malformed cleared workflow ids`)
      delete record.clearedWorkflowIds
    }
    if (record.actionHistory !== undefined) {
      if (!Array.isArray(record.actionHistory)) {
        this.report(`${subject}: dropping its action history (actionHistory must be an array)`)
        delete record.actionHistory
      }
      else {
        const valid = record.actionHistory.filter((entry) => SessionRecordsStore.actionHistoryEntryProblem(entry) === null)
        if (valid.length !== record.actionHistory.length)
          this.report(`${subject}: dropping ${record.actionHistory.length - valid.length} damaged action history entries`)
        record.actionHistory = valid
      }
    }
    if (record.scriptRuns !== undefined && !Array.isArray(record.scriptRuns)) {
      this.report(`${subject}: dropping its script history (scriptRuns must be an array)`)
      delete record.scriptRuns
    }
    else if (record.scriptRuns !== undefined) {
      const problems = record.scriptRuns.map((entry) => SessionRecordsStore.scriptRunProblem(entry))
      const first = problems.find((problem) => problem !== null)
      if (first !== undefined) {
        record.scriptRuns = record.scriptRuns.filter((_entry, index) => problems[index] === null)
        this.report(`${subject}: dropping ${problems.length - record.scriptRuns.length} script history `
          + `entries it cannot read (${first})`)
      }
    }
    if (record.commitReceipts !== undefined && !Array.isArray(record.commitReceipts)) {
      this.report(`${subject}: dropping its commit receipts (commitReceipts must be an array)`)
      delete record.commitReceipts
    }
    else if (record.commitReceipts !== undefined) {
      const problems = record.commitReceipts.map((entry) => SessionRecordsStore.commitReceiptProblem(entry))
      const first = problems.find((problem) => problem !== null)
      if (first !== undefined) {
        record.commitReceipts = record.commitReceipts.filter((_entry, index) => problems[index] === null)
        this.report(`${subject}: dropping ${problems.length - record.commitReceipts.length} commit receipts `
          + `it cannot read (${first})`)
      }
    }
    const checks = SessionRecordsStore.finishChecksProblem(record.finishChecks)
    if (checks !== null) {
      this.report(`${subject}: dropping its Finish checks (${checks})`)
      delete record.finishChecks
    }
    // The passes only draw the workflow: ones this build cannot read cost the steps, never the action.
    const passes = record.svnAction && typeof record.svnAction === 'object' ? SessionRecordsStore.passesProblem(record.svnAction) : null
    if (passes !== null && record.svnAction) {
      this.report(`${subject}: dropping the passes of its SVN action (${passes})`)
      delete record.svnAction.passes
      delete record.svnAction.stageAt
    }
    // A set this build cannot word costs the set; the next read takes it from svn again.
    const set = record.svnAction && typeof record.svnAction === 'object' ? SessionRecordsStore.conflictSetProblem(record.svnAction.conflictSet) : null
    if (set !== null && record.svnAction) {
      this.report(`${subject}: dropping the conflict set of its SVN action (${set})`)
      delete record.svnAction.conflictSet
    }
    // A list of fixes this build cannot word costs the FIXED lines of the result, never the action.
    const fixed = record.svnAction && typeof record.svnAction === 'object' ? SessionRecordsStore.fixedProblem(record.svnAction.fixed) : null
    if (fixed !== null && record.svnAction) {
      this.report(`${subject}: dropping the fixes of its SVN action (${fixed})`)
      delete record.svnAction.fixed
    }
    // A wake-up notice this build cannot read costs the line, never the action.
    const notice = record.svnAction && typeof record.svnAction === 'object' ? SessionRecordsStore.noticeProblem(record.svnAction.notice) : null
    if (notice !== null && record.svnAction) {
      this.report(`${subject}: dropping the wake-up notice of its SVN action (${notice})`)
      delete record.svnAction.notice
    }
    // A merger this build cannot read costs the field: the run stage still names its run.
    const merger = record.svnAction && typeof record.svnAction === 'object' ? SessionRecordsStore.mergerProblem(record.svnAction.merger) : null
    if (merger !== null && record.svnAction) {
      this.report(`${subject}: dropping the merger of its SVN action (${merger})`)
      delete record.svnAction.merger
    }
    if (record.worktree && typeof record.worktree === 'object' && record.worktree.agentStartedAt !== undefined
      && (typeof record.worktree.agentStartedAt !== 'number' || !Number.isFinite(record.worktree.agentStartedAt) || record.worktree.agentStartedAt < 0)) {
      this.report(`${subject}: dropping malformed worktree agent start proof`)
      delete record.worktree.agentStartedAt
    }
    if (record.worktree && typeof record.worktree === 'object' && !SessionRecordsStore.validConflictMemory(record.worktree.conflictMemory)) {
      this.report(`${subject}: dropping malformed worktree conflict memory`)
      delete record.worktree.conflictMemory
    }
    if (record.worktree && typeof record.worktree === 'object' && !SessionRecordsStore.validSetupBaseline(record.worktree.setupBaseline)) {
      this.report(`${subject}: dropping malformed worktree setup baseline`)
      delete record.worktree.setupBaseline
    }
    // Unknown actions wait safely while valid lifecycle evidence remains available.
    const action = SessionRecordsStore.svnActionProblem(record.svnAction)
    if (action !== null) {
      this.quarantine(record, original, `Unreadable SVN action (${action}); use a compatible build or recover the saved record before continuing`)
    }
    // The tag and the wake-up line ride on the results; the worktree itself stays.
    for (const holder of [record.worktree, record.retiredWorktree]) {
      if (!holder || typeof holder !== 'object') continue
      const caller = SessionRecordsStore.callerProblem(holder.caller)
      if (caller === null) continue
      this.report(`${subject}: dropping the caller of its worktree (${caller})`)
      delete holder.caller
    }
  }

  private static assertValid(record: SessionRecord): void {
    const reason = SessionRecordsStore.problemOf(record, new Set())
    if (reason)
      throw new Error(`Refusing to store an invalid session record: ${reason}`)
  }

  private quarantine(record: Partial<SessionRecord>, original: SessionRecord, reason: string): void {
    if (typeof record.sessionId !== 'string' || this.unreadableRecords.has(record.sessionId)) return
    this.unreadableRecords.set(record.sessionId, original)
    reason = `${reason}. Original record: ${this.file}`
    const known = WorktreeStateValidation.parse(record.worktreeLifecycle)
    record.worktreeLifecycle = { ...known, version: known?.version ?? 0, actionId: known?.actionId ?? null,
      phase: 'waiting', step: undefined, wait: { kind: 'svn-failed', reason, at: record.createdAt ?? 0 },
      unreadable: reason, execution: undefined, update: undefined, review: undefined, approvedAt: undefined,
      outOfDate: known?.outOfDate ?? 0, journal: known?.journal ?? [],
      facts: known?.facts ?? { worker: { liveness: 'dead', resumeFailures: 0 } } }
    delete record.svnAction
    this.report(`Session ${record.sessionId} is read-only: ${reason}. Its original record is preserved.`)
  }

  quarantinedSessionIds(): ReadonlySet<string> { return new Set(this.unreadableRecords.keys()) }

  private static problemOf(candidate: unknown, seen: ReadonlySet<string>): string | null {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      return 'expected an object'
    const record = candidate as Partial<SessionRecord>
    if (record.worktreeLifecycle !== undefined && WorktreeStateValidation.parse(record.worktreeLifecycle) === undefined)
      return `worktreeLifecycle is malformed (${record.worktreeLifecycle.phase}/${record.worktreeLifecycle.step ?? 'no step'}): ${WorktreeStateValidation.problem(record.worktreeLifecycle)}`
    if (!SessionRecordsStore.isFilledString(record.sessionId))
      return 'sessionId must be a non-empty string'
    if (seen.has(record.sessionId)) return `duplicate sessionId ${record.sessionId}`
    if (record.kind !== 'shell' && record.kind !== 'agent')
      return `record ${record.sessionId}: kind must be shell or agent`
    if (typeof record.title !== 'string')
      return `record ${record.sessionId}: title must be a string`
    if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt))
      return `record ${record.sessionId}: createdAt must be a number`
    if (record.account !== undefined && (record.kind !== 'shell' || !record.account
      || (record.account.agentId !== 'claude' && record.account.agentId !== 'codex')
      || !SessionRecordsStore.isFilledString(record.account.accountId)))
      return `record ${record.sessionId}: invalid shell account`
    if (record.accountSegments !== undefined && (!Array.isArray(record.accountSegments)
      || record.accountSegments.some(segment => !segment || !SessionRecordsStore.isFilledString(segment.accountId)
        || !Number.isFinite(segment.from) || segment.from < 0
        || (segment.to !== null && (!Number.isFinite(segment.to) || segment.to < segment.from)))))
      return `record ${record.sessionId}: invalid account segments`
    if (record.lastUserInputAt !== undefined && (typeof record.lastUserInputAt !== 'number'
      || !Number.isFinite(record.lastUserInputAt) || record.lastUserInputAt <= 0))
      return `record ${record.sessionId}: lastUserInputAt must be a positive timestamp`
    if (record.life !== 'starting' && record.life !== 'live'
      && record.life !== 'ended' && record.life !== 'lost')
      return `record ${record.sessionId}: unknown life ${JSON.stringify(record.life)}`
    const directory = SessionRecordsStore.directoryProblem(record.directory)
    if (directory) return `record ${record.sessionId}: ${directory}`
    const binding = SessionRecordsStore.bindingProblem(record.binding)
    if (binding) return `record ${record.sessionId}: ${binding}`
    if (record.pendingOperationKind !== undefined
      && record.pendingOperationKind !== 'create'
      && record.pendingOperationKind !== 'reopen')
      return `record ${record.sessionId}: unknown pending operation kind ${
        JSON.stringify(record.pendingOperationKind)}`
    if (record.pendingKeepsHistory !== undefined && record.pendingKeepsHistory !== true)
      return `record ${record.sessionId}: pendingKeepsHistory must be true when present`
    if (record.kind === 'agent') {
      const agent = SessionRecordsStore.agentProblem(record.agent)
      if (agent) return `record ${record.sessionId}: ${agent}`
    }
    // Named for what it is rather than for the four setup checks it began as: it now carries
    // flowId, completed, stopRequested and note, none of which is a setup field.
    const problem = SessionRecordsStore.pendingSetupProblem(record.pendingSetup)
      ?? SessionRecordsStore.finishChecksProblem(record.finishChecks)
      ?? SessionRecordsStore.transcriptCwdProblem(record.transcriptCwd, record.kind)
      ?? SessionRecordsStore.setupSkippedProblem(record.setupSkipped)
      ?? SessionRecordsStore.commandsProblem(record.commands)
      ?? SessionRecordsStore.recordProcessProblem(record)
      ?? SessionRecordsStore.scriptOfProblem(record.scriptOf)
      ?? SessionRecordsStore.parentProblem(record.parent)
      ?? SessionRecordsStore.scriptRunsProblem(record.scriptRuns)
      ?? SessionRecordsStore.actionHistoryProblem(record.actionHistory)
      ?? (record.clearedWorkflowIds !== undefined && !SessionRecordsStore.isStringList(record.clearedWorkflowIds) ? 'clearedWorkflowIds must be a list of strings' : null)
      ?? SessionRecordsStore.commitReceiptsProblem(record.commitReceipts)
      ?? SessionRecordsStore.worktreeProblem(record.worktree)
      ?? SessionRecordsStore.worktreeMergeProblem(record.worktreeMerge)
      ?? SessionRecordsStore.worktreeFinishProblem(record.worktreeFinish)
      ?? SessionRecordsStore.svnActionProblem(record.svnAction)
      ?? SessionRecordsStore.worktreeOutcomeProblem(record.worktreeOutcome)
      ?? SessionRecordsStore.retiredWorktreeProblem(record.retiredWorktree)
      ?? SessionRecordsStore.worktreeCleanupProblem(record.worktreeCleanup)
      ?? SessionRecordsStore.flowIdProblem(record.flowId)
      ?? SessionRecordsStore.callerOperationIdProblem(record.callerOperationId)
      ?? SessionRecordsStore.completedProblem(record.completed)
      ?? SessionRecordsStore.stopRequestedProblem(record.stopRequested)
      ?? (record.manuallyStoppedAt !== undefined && (!Number.isFinite(record.manuallyStoppedAt) || record.manuallyStoppedAt < 0) ? 'manuallyStoppedAt must be a timestamp' : null)
      ?? SessionRecordsStore.noteProblem(record.note)
      ?? SessionRecordsStore.launchWaitProblem(record.launchWait)
    if (problem) return `record ${record.sessionId}: ${problem}`
    return null
  }

  private static transcriptCwdProblem(
    value: SessionRecord['transcriptCwd'],
    kind: SessionRecord['kind'],
  ): string | null {
    if (value === undefined) return null
    if (kind !== 'agent') return 'a shell record cannot carry transcriptCwd'
    if (!SessionRecordsStore.isFilledString(value) || !isAbsolute(value))
      return 'transcriptCwd must be a non-empty absolute path'
    return null
  }

  /**
   * The other field the details card writes. `color` is refused on write and filtered on read;
   * `note` had neither, and `Partial<SessionRecord>` typed it `string | undefined` so nothing here
   * looked unfinished. A record carrying a number loaded without a word, `SessionInfo.note` was
   * then a number typed `string`, and the card's first Save called `.trim()` on it inside a click
   * handler - which nothing under `renderer/` was catching.
   */
  private static noteProblem(value: SessionRecord['note']): string | null {
    if (value === undefined) return null
    if (typeof value !== 'string') return 'note must be a string'
    return null
  }

  /** Absent or true; `false` is how a record says nothing, and it says it by leaving the field out. */
  /**
   * The four strings a merge and a teardown hand to git as paths and refs. An unchecked one
   * reaches `LaunchPlanner.cwdOf` as a spawn's `cwd` and `worktree remove --force` as its
   * target, which is the furthest from this file a bad value in it can get.
   */
  private static worktreeProblem(value: SessionRecord['worktree']): string | null {
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return 'worktree must be an object'
    for (const field of ['worktreePath', 'branch', 'baseCommit', 'repositoryRoot'] as const)
      if (!SessionRecordsStore.isFilledString(value[field]))
        return `worktree needs a ${field} string`
    if (value.kind !== undefined && !SessionRecordsStore.isWorktreeKind(value.kind))
      return `unknown worktree kind ${JSON.stringify(value.kind)}`
    if (value.directoryId !== undefined && !SessionRecordsStore.isFilledString(value.directoryId))
      return 'worktree directoryId must be a non-empty string'
    if (value.preservationActionId !== undefined && (typeof value.preservationActionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.preservationActionId)))
      return 'worktree preservationActionId must be an action identity'
    if (value.cwdSubpath !== undefined && !SessionRecordsStore.isSubpath(value.cwdSubpath))
      return 'worktree cwdSubpath must be a relative path of named segments joined by /'
    if (value.setupScope !== undefined && value.setupScope !== 'project' && value.setupScope !== 'members')
      return 'worktree setupScope must be project or members'
    return SessionRecordsStore.callerProblem(value.caller)
  }

  private static validSetupBaseline(value: unknown): boolean {
    if (value === undefined) return true
    if (!JsonShape.isRecord(value) || typeof value.at !== 'number' || !Number.isFinite(value.at) || !JsonShape.isRecord(value.hashes)) return false
    if ([value.inputs, value.commands].some((hash) => hash !== undefined && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))) return false
    if (value.inputHashes !== undefined && (!JsonShape.isRecord(value.inputHashes) || Object.values(value.inputHashes).some((hash) => typeof hash !== 'string'))) return false
    return Object.entries(value.hashes).every(([path, hash]) => typeof hash === 'string' && hash.length > 0
      && path.length > 0 && !/[\\:\0\r\n]/.test(path) && !path.startsWith('/') && !path.split('/').includes('..'))
  }

  private static validConflictMemory(value: unknown): boolean {
    return WorktreeStateValidation.validConflictMemory(value)
  }

  /** A launch joins it onto the worktree path, so it must never climb out of the worktree or replace it. */
  private static isSubpath(value: unknown): boolean {
    return typeof value === 'string' && value.length > 0 && !/[\\:]/.test(value)
      && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  }

  private static callerProblem(value: SessionRecordWorktreeCaller | undefined): string | null {
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return 'caller must be an object'
    if (value.tag !== undefined && (typeof value.tag !== 'string' || !SessionLimits.worktreeTagShape.test(value.tag)))
      return 'caller tag has an invalid shape'
    if (value.notify === undefined) return null
    if (!value.notify || typeof value.notify !== 'object') return 'caller notify must be an object'
    if (!SessionRecordsStore.isFilledString(value.notify.sessionId)) return 'caller notify needs a sessionId string'
    if (typeof value.notify.text !== 'string' || value.notify.text.length === 0
      || value.notify.text.length > SessionLimits.worktreeNotifyCharacters)
      return 'caller notify needs a text within the deliver limit'
    return null
  }

  private static worktreeFinishProblem(value: SessionRecord['worktreeFinish']): string | null {
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return 'worktreeFinish must be an object'
    if (value.phase !== 'updating' && value.phase !== 'reviewing'
      && value.phase !== 'main-updating' && value.phase !== 'removing')
      return `unknown finish phase ${JSON.stringify(value.phase)}`
    if (typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt))
      return 'worktreeFinish needs a startedAt number'
    for (const field of ['scopeRoot', 'commitSessionId'] as const)
      if (value[field] !== undefined && !SessionRecordsStore.isFilledString(value[field]))
        return `worktreeFinish ${field} must be a non-empty string`
    return null
  }

  private static worktreeOutcomeProblem(value: SessionRecord['worktreeOutcome']): string | null {
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return 'worktreeOutcome must be an object'
    if (!SessionRecordsStore.finishResultsConst.includes(value.result))
      return `unknown finish result ${JSON.stringify(value.result)}`
    if (!SessionRecordsStore.isStringList(value.revisions))
      return 'worktreeOutcome revisions must be a list of strings'
    if (typeof value.main !== 'string' || !SessionRecordsStore.finishMainPatternConst.test(value.main))
      return `unknown finish main result ${JSON.stringify(value.main)}`
    if (value.worktree !== 'removed' && value.worktree !== 'kept'
      && value.worktree !== 'in-use' && value.worktree !== 'undeleted')
      return `unknown finish worktree result ${JSON.stringify(value.worktree)}`
    if (!SessionRecordsStore.isStringList(value.lines))
      return 'worktreeOutcome lines must be a list of strings'
    if (typeof value.at !== 'number' || !Number.isFinite(value.at))
      return 'worktreeOutcome needs an at number'
    if (value.labelled !== undefined && !SessionRecordsStore.isLabelledList(value.labelled))
      return 'worktreeOutcome labelled must be a list of labelled revisions'
    return null
  }

  private static passesProblem(action: Partial<SessionRecordSvnAction>): string | null {
    if (action.stageAt !== undefined && (typeof action.stageAt !== 'number' || !Number.isFinite(action.stageAt)))
      return 'stageAt must be a number'
    if (action.passes === undefined) return null
    if (!Array.isArray(action.passes)) return 'passes must be an array'
    const bad = action.passes.find((pass) => !pass || typeof pass !== 'object'
      || !SessionRecordsStore.svnActionStagesConst.includes(pass.stage)
      || (pass.runId !== undefined && !SessionRecordsStore.isFilledString(pass.runId))
      || !Number.isFinite(pass.startedAt) || !Number.isFinite(pass.endedAt)
      || (pass.result !== 'done' && pass.result !== 'failed' && pass.result !== 'waited')
      || (pass.facts !== undefined && (!pass.facts || typeof pass.facts !== 'object'
        || [pass.facts.revision, pass.facts.conflicts, pass.facts.fixed, pass.facts.left].some((count) => count !== undefined && !Number.isSafeInteger(count))
        || [pass.facts.mount, pass.facts.repository].some((name) => name !== undefined && typeof name !== 'string'))))
    return bad === undefined ? null : 'a pass names no known stage, time or result'
  }

  /** Every entry must name a kind, shape, state and options of this build, or its words would throw. */
  private static conflictSetProblem(value: unknown): string | null {
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return 'conflictSet must be an object'
    const set = value as Partial<SvnActionConflictSet>
    if (![set.readAt, set.baseRevision, set.revision, set.more].every((number) => typeof number === 'number' && Number.isFinite(number)))
      return 'conflictSet needs its times, revisions and count'
    if (!Array.isArray(set.entries)) return 'conflictSet entries must be an array'
    if (set.waited !== undefined && set.waited !== true) return 'conflictSet waited must be true when present'
    const bad = set.entries.find((entry: Partial<SvnActionConflictEntry> | null) => !entry || typeof entry !== 'object'
      || typeof entry.path !== 'string'
      || (entry.occurrenceId !== undefined && !/^[0-9a-f-]{36}$/i.test(entry.occurrenceId))
      || !SessionRecordsStore.conflictKindsConst.includes(entry.kind)
      || !SvnConflictShapes.isShape(entry.shape)
      || !SessionRecordsStore.conflictStatesConst.includes(entry.state)
      || !Array.isArray(entry.options) || !entry.options.every((option) => SvnConflictShapes.isOption(option))
      || (entry.rule !== undefined && !SvnConflictShapes.isOption(entry.rule))
      || (entry.settledWith !== undefined && !SvnConflictShapes.isOption(entry.settledWith))
      || !entry.facts || typeof entry.facts !== 'object'
      || (entry.by !== undefined && !SessionRecordsStore.conflictActorsConst.includes(entry.by))
      || (entry.saved !== undefined && typeof entry.saved !== 'string')
      || (entry.confirmedLoss !== undefined && entry.confirmedLoss !== true)
      || (entry.journal !== undefined && (!entry.journal || typeof entry.journal !== 'object'
        || !SvnConflictShapes.isOption(entry.journal.option) || !Number.isSafeInteger(entry.journal.done) || entry.journal.done < 0)))
    return bad === undefined ? null : 'an entry names no known kind, shape, state or option'
  }

  /** Each fix names a path and an option of this build, or its line would throw. */
  private static fixedProblem(value: unknown): string | null {
    if (value === undefined) return null
    if (!Array.isArray(value)) return 'fixed must be an array'
    return value.every((fix: Partial<SvnActionFixed> | null) => !!fix && typeof fix === 'object' && typeof fix.path === 'string' && SvnConflictShapes.isOption(fix.option))
      ? null : 'a fix names no path or no known option'
  }

  /** An id, a time, a count of tries and a known state. */
  private static noticeProblem(value: unknown): string | null {
    if (value === undefined) return null
    const notice = value as Partial<SvnActionNotice> | null
    if (!notice || typeof notice !== 'object' || !SessionRecordsStore.isFilledString(notice.id)) return 'notice needs an id'
    if (typeof notice.at !== 'number' || typeof notice.attempts !== 'number' || !Number.isSafeInteger(notice.attempts) || notice.attempts < 0)
      return 'notice needs a time and a count'
    if (notice.state !== 'pending' && notice.state !== 'delivered' && notice.state !== 'expired') return `unknown notice state ${JSON.stringify(notice.state)}`
    return notice.settledAt === undefined || typeof notice.settledAt === 'number' ? null : 'notice settledAt must be a number'
  }

  /** A run id and the set and start it names; its end and its check are times when present. */
  private static mergerProblem(value: unknown): string | null {
    if (value === undefined) return null
    const merger = value as Partial<SvnActionMerger> | null
    if (!merger || typeof merger !== 'object' || !SessionRecordsStore.isFilledString(merger.runId)) return 'merger needs a run id'
    const times = [merger.setAt, merger.startedAt]
    const optional = [merger.endedAt, merger.checkedAt].filter((time) => time !== undefined)
    return [...times, ...optional].every((time) => typeof time === 'number' && Number.isFinite(time)) ? null : 'merger times must be numbers'
  }

  /** Shape only, like the other gates: the cursors must name an entry, the stage and the reason one of their sets. */
  private static svnActionProblem(value: SessionRecord['svnAction']): string | null {
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return 'svnAction must be an object'
    const action = value as Partial<SessionRecordSvnAction>
    if (action.kind !== 'finish' && action.kind !== 'discard' && action.kind !== 'update-main')
      return `unknown SVN action kind ${JSON.stringify(action.kind)}`
    if (!SessionRecordsStore.isFilledString(action.actionId)) return 'svnAction needs an actionId'
    if (!SessionRecordsStore.svnActionStagesConst.includes(action.stage)) return `unknown SVN action stage ${JSON.stringify(action.stage)}`
    if (!SessionRecordsStore.isFilledString(action.root)) return 'svnAction needs a root'
    for (const field of ['runId', 'mergeBrief'] as const)
      if (action[field] !== undefined && !SessionRecordsStore.isFilledString(action[field]))
        return `svnAction ${field} must be a non-empty string`
    if (action.flowVersion !== undefined && action.flowVersion !== 1) return 'unknown SVN action flowVersion'
    if (action.marked !== undefined && !SessionRecordsStore.isStringList(action.marked)) return 'svnAction marked must be paths'
    const commit = action.commit
    if (commit !== undefined && (!commit || typeof commit !== 'object' || !SessionRecordsStore.isStringList(commit.selection)
      || commit.preparedAdds !== undefined && !SessionRecordsStore.isStringList(commit.preparedAdds)
      || typeof commit.message !== 'string' || !commit.hashes || typeof commit.hashes !== 'object' || Array.isArray(commit.hashes)
      || !Object.values(commit.hashes).every((value) => typeof value === 'string')
      || commit.files !== undefined && (!SessionRecordsStore.isFilledString(commit.files.targetsFile) || !SessionRecordsStore.isFilledString(commit.files.messageFile))))
      return 'svnAction commit must hold its selection, message and hashes'
    if (!Array.isArray(action.checks)) return 'svnAction checks must be an array'
    for (const step of action.checks) {
      const problem = SessionRecordsStore.scriptStepProblem(step)
      if (problem) return `svnAction checks: ${problem}`
      if (step.scriptId !== 'checks') return `svnAction checks: a ${JSON.stringify(step.scriptId)} step is not a check`
    }
    if (!SessionRecordsStore.isIndex(action.checkCursor, Math.max(action.checks.length, 1)))
      return 'svnAction checkCursor must be an index into its checks'
    if (action.roots !== undefined && (!Array.isArray(action.roots) || !action.roots.every((root) => root && typeof root === 'object'
      && (root.selection === undefined || SessionRecordsStore.isStringList(root.selection))
      && SessionRecordsStore.isFilledString(root.path) && typeof root.own === 'string' && SessionRecordsStore.isStringList(root.changed))))
      return 'svnAction roots must be a list of roots'
    if (!SessionRecordsStore.isIndex(action.rootCursor, Math.max(action.roots?.length ?? 0, 1)))
      return 'svnAction rootCursor must be an index into its roots'
    const rounds = action.rounds
    if (!rounds || typeof rounds !== 'object'
      || ![rounds.incoming, rounds.outOfDate, rounds.lock].every((count) => Number.isSafeInteger(count) && count >= 0))
      return 'svnAction needs its rounds'
    if (!SessionRecordsStore.isLabelledList(action.evidence)) return 'svnAction evidence must be a list of labelled revisions'
    for (const field of ['startedAt', 'retryAt', 'baseRevision'] as const)
      if ((field === 'startedAt' || action[field] !== undefined)
        && (typeof action[field] !== 'number' || !Number.isFinite(action[field])))
        return `svnAction ${field} must be a number`
    if (action.requestedBy !== 'window' && action.requestedBy !== 'cli' && action.requestedBy !== 'peer')
      return `unknown SVN action caller ${JSON.stringify(action.requestedBy)}`
    if (action.removal !== undefined && action.removal !== 'removed' && action.removal !== 'kept'
      && action.removal !== 'in-use' && action.removal !== 'undeleted')
      return `unknown SVN action removal ${JSON.stringify(action.removal)}`
    const needs = action.needs
    if (needs !== undefined && (!needs || typeof needs !== 'object' || !SessionRecordsStore.svnActionNeedsConst.includes(needs.kind)
      || typeof needs.reason !== 'string' || typeof needs.at !== 'number'))
      return 'svnAction needs must name a known reason'
    const verdict = action.verdict
    if (verdict !== undefined && (!verdict || typeof verdict !== 'object'
      || (verdict.kind !== 'succeeded' && !(verdict.kind === 'failed' && typeof verdict.reason === 'string'))
      || (verdict.exitCode !== undefined && !Number.isSafeInteger(verdict.exitCode))))
      return 'svnAction verdict must be a known verdict'
    const passed = action.checksPassed
    if (passed !== undefined && (!passed || typeof passed !== 'object' || !SessionRecordsStore.isFilledString(passed.fingerprint)
      || typeof passed.at !== 'number'))
      return 'svnAction checksPassed needs a fingerprint and an at number'
    const conflicts = action.conflicts
    if (conflicts !== undefined && (!conflicts || typeof conflicts !== 'object' || !SessionRecordsStore.isStringList(conflicts.paths)
      || !SessionRecordsStore.isStringList(conflicts.before) || typeof conflicts.at !== 'number' || !Number.isFinite(conflicts.at)))
      return 'svnAction conflicts need their paths, the changes before the resolver and an at number'
    if (action.resolverSpent !== undefined && action.resolverSpent !== true)
      return `svnAction resolverSpent must be true or absent, not ${JSON.stringify(action.resolverSpent)}`
    return null
  }

  private static isIndex(value: unknown, length: number): boolean {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < length
  }

  private static isLabelledList(value: unknown): value is readonly SvnLabelledRevision[] {
    return Array.isArray(value) && value.every((entry) => entry && typeof entry === 'object'
      && SessionRecordsStore.isFilledString(entry.repository) && Number.isSafeInteger(entry.revision) && entry.revision > 0
      && SessionRecordsStore.revisionLabelsConst.includes(entry.label))
  }

  private static retiredWorktreeProblem(value: SessionRecord['retiredWorktree']): string | null {
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return 'retiredWorktree must be an object'
    if (!SessionRecordsStore.isFilledString(value.worktreePath))
      return 'retiredWorktree needs a worktreePath string'
    if (!SessionRecordsStore.isWorktreeKind(value.kind))
      return `unknown retired worktree kind ${JSON.stringify(value.kind)}`
    if (!SessionRecordsStore.isStringList(value.revisions))
      return 'retiredWorktree revisions must be a list of strings'
    if (typeof value.removedAt !== 'number' || !Number.isFinite(value.removedAt))
      return 'retiredWorktree needs a removedAt number'
    if (value.directoryId !== undefined && !SessionRecordsStore.isFilledString(value.directoryId))
      return 'retiredWorktree directoryId must be a non-empty string'
    if (value.ownerDir !== undefined && !SessionRecordsStore.isFilledString(value.ownerDir))
      return 'retiredWorktree ownerDir must be a non-empty string'
    if (value.landed !== undefined && (!SessionRecordsStore.isLabelledList(value.landed) || value.ownerDir === undefined))
      return 'retiredWorktree landed must be a list of labelled revisions beside an ownerDir'
    return SessionRecordsStore.callerProblem(value.caller)
  }

  private static worktreeCleanupProblem(value: SessionRecord['worktreeCleanup']): string | null {
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return 'worktreeCleanup must be an object'
    if (value.phase !== 'pending' && value.phase !== 'kept')
      return `unknown cleanup phase ${JSON.stringify(value.phase)}`
    if (value.trigger !== 'committed' && value.trigger !== 'removal-unfinished'
      && value.trigger !== 'discard-unfinished' && value.trigger !== 'remove-when-ended'
      && value.trigger !== 'requested')
      return `unknown cleanup trigger ${JSON.stringify(value.trigger)}`
    if (value.reason !== undefined && typeof value.reason !== 'string')
      return 'worktreeCleanup reason must be a string'
    if (typeof value.requestedAt !== 'number' || !Number.isFinite(value.requestedAt))
      return 'worktreeCleanup needs a requestedAt number'
    if (typeof value.attempts !== 'number' || !Number.isSafeInteger(value.attempts) || value.attempts < 0)
      return 'worktreeCleanup needs an attempts count'
    if (value.lastAttemptAt !== undefined
      && (typeof value.lastAttemptAt !== 'number' || !Number.isFinite(value.lastAttemptAt)))
      return 'worktreeCleanup lastAttemptAt must be a number'
    return null
  }

  private static isWorktreeKind(value: unknown): value is SessionWorktreeKind {
    return value === 'svn' || value === 'git'
  }

  private static isStringList(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  }

  /**
   * A finish cannot outlive the client process that ran it, so a record still carrying one was cut
   * short. It becomes an `interrupted` outcome naming the phase, and the next Finish reads the disk.
   */
  private static interruptedFinishOf(record: SessionRecord, now: number): SessionRecord {
    const finish = record.worktreeFinish
    if (finish === undefined) return record
    const scope = finish.scopeRoot === undefined ? '' : ` in ${finish.scopeRoot}`
    return {
      ...record,
      worktreeFinish: undefined,
      worktreeOutcome: {
        result: 'interrupted',
        // Commits of an earlier finish are still this worktree's; the next Finish no longer recovers them.
        revisions: record.worktreeOutcome?.revisions ?? [],
        main: 'none',
        worktree: 'kept',
        lines: [`INTERRUPTED during ${finish.phase}${scope}`],
        at: now,
      },
    }
  }

  /**
   * The phase is a closed union and the ONE unchecked value in this file that had a throw
   * waiting for it: `SessionNodeState.mergeBadgeOf` ends in `throw new Error('Unknown merge
   * phase')` inside a `useMemo`, and nothing under `renderer/` catches it, so a hand-edited
   * document took the whole React root down at render instead of being dropped aloud at load.
   */
  private static worktreeMergeProblem(value: SessionRecord['worktreeMerge']): string | null {
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return 'worktreeMerge must be an object'
    if (value.revisions !== undefined && (!Array.isArray(value.revisions)
      || value.revisions.some((revision) => typeof revision !== 'string' || !/^[a-f0-9]{40,64}$/.test(revision))))
      return 'worktreeMerge revisions must contain verified Git commit IDs'
    if (value.mergedRevision !== undefined && (typeof value.mergedRevision !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.mergedRevision)))
      return 'worktreeMerge mergedRevision must be a Git commit ID'
    if (value.phase !== 'base-merging' && value.phase !== 'resolving'
      && value.phase !== 'main-merging' && value.phase !== 'tearing-down')
      return `unknown merge phase ${JSON.stringify(value.phase)}`
    if (typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt))
      return 'worktreeMerge needs a startedAt number'
    if (value.resolveSessionId !== undefined
      && !SessionRecordsStore.isFilledString(value.resolveSessionId))
      return 'worktreeMerge resolveSessionId must be a non-empty string'
    if (value.failure !== undefined && typeof value.failure !== 'string')
      return 'worktreeMerge failure must be a string'
    return null
  }

  private static completedProblem(value: SessionRecord['completed']): string | null {
    if (value === undefined || value === true) return null
    return `completed must be true or absent, not ${JSON.stringify(value)}`
  }

  /**
   * Absent or true, for the same reason `completed` is: the field is how a record says yes.
   *
   * `exitReason` beside it is deliberately NOT checked here, and the difference is where the value
   * comes from. This one is written by this library alone, so a shape it does not know is a caller
   * mistake worth refusing. `exitReason` is the Host's word, checked at the seam it arrives through
   * (`Reconciler.exitReasonOf`) rather than here: a record carrying a reason a newer Host invented is
   * still a session somebody can work in, and dropping it on read - which is what a clause here would
   * do - would cost them the session to save an annotation. It is the same asymmetry `SessionColors`
   * is written around.
   */
  private static stopRequestedProblem(value: SessionRecord['stopRequested']): string | null {
    if (value === undefined || value === true) return null
    return `stopRequested must be true or absent, not ${JSON.stringify(value)}`
  }

  private static flowIdProblem(value: SessionRecord['flowId']): string | null {
    if (value === undefined) return null
    if (!SessionRecordsStore.isFilledString(value)) return 'flowId must be a non-empty string'
    return null
  }

  private static callerOperationIdProblem(value: SessionRecord['callerOperationId']): string | null {
    if (value === undefined) return null
    if (!SessionRecordsStore.isFilledString(value)) return 'callerOperationId must be a non-empty string'
    return null
  }

  private static directoryProblem(value: SessionRecord['directory'] | undefined): string | null {
    if (!value || typeof value !== 'object') return 'directory must be an object'
    if (value.mode === 'project') {
      if (!SessionRecordsStore.isFilledString(value.categoryId)
        || !SessionRecordsStore.isFilledString(value.projectPath))
        return 'a project directory needs categoryId and projectPath'
      return null
    }
    else if (value.mode === 'adHoc') {
      if (!SessionRecordsStore.isFilledString(value.path)) return 'an adHoc directory needs a path'
      return null
    }
    else if (value.mode === 'default')
      return null
    else
      return `unknown directory mode ${JSON.stringify((value as { mode?: unknown }).mode)}`
  }

  private static bindingProblem(value: SessionRecord['binding'] | undefined): string | null {
    if (value === null) return null
    if (!value || typeof value !== 'object') return 'binding must be an object or null'
    if (!SessionRecordsStore.isFilledString(value.hostInstanceId))
      return 'binding needs a hostInstanceId'
    if (typeof value.generation !== 'number' || !Number.isFinite(value.generation))
      return 'binding needs a numeric generation'
    return null
  }

  /**
   * The launch mode is as necessary as the agent itself: an agent record that cannot say how it was
   * started cannot be relaunched correctly, so it is dropped here rather than relaunched by a guess.
   */
  private static agentProblem(value: SessionRecord['agent']): string | null {
    if (!value || typeof value !== 'object') return 'an agent session needs an agent'
    if (value.agentId !== 'claude' && value.agentId !== 'codex')
      return `unknown agent ${JSON.stringify(value.agentId)}`
    if (value.accountId !== undefined && !SessionRecordsStore.isFilledString(value.accountId))
      return 'accountId must be a non-empty string'
    if (value.launchAccountId !== undefined && !SessionRecordsStore.isFilledString(value.launchAccountId))
      return 'launchAccountId must be a non-empty string'
    // The prompt becomes an argv element verbatim, the same reason `commandsProblem` exists: a
    // non-string coerced into a command line fails at the spawn, far from whoever wrote it.
    if (value.initialPrompt !== undefined
      && !SessionRecordsStore.isFilledString(value.initialPrompt))
      return 'initialPrompt must be a non-empty string'
    if (value.launchMode !== 'new' && value.launchMode !== 'continue'
      && value.launchMode !== 'resume' && value.launchMode !== 'fork')
      return `unknown launch mode ${JSON.stringify(value.launchMode)}`
    // Absent or true, the way `completed` and `stopRequested` are: the field is how a record
    // says yes, and a session wrongly read as one-shot is one nothing ever reopens.
    if (value.oneShot !== undefined && value.oneShot !== true)
      return `oneShot must be true or absent, not ${JSON.stringify(value.oneShot)}`
    if (value.permission !== undefined && value.permission !== 'accept-edits' && value.permission !== 'merger')
      return `unknown agent permission ${JSON.stringify(value.permission)}`
    if (value.nativeSessionIdSource !== undefined && value.nativeSessionIdSource !== 'provided'
      && value.nativeSessionIdSource !== 'codex-app-server' && value.nativeSessionIdSource !== 'claude-statusline')
      return 'unknown native identity source'
    for (const id of [value.identityLaunchId, value.unverifiedNativeSessionId])
      if (id !== undefined && !SessionRecordsStore.isFilledString(id)) return 'invalid identity metadata'
    if (value.identitySequence !== undefined
      && (!Number.isSafeInteger(value.identitySequence) || value.identitySequence < 1))
      return 'invalid identity sequence'
    return null
  }

  /**
   * The setup fields are checked by shape and never by kind: the session a setup prepares is a shell
   * one whenever the worktree, not the agent, is what asked for it.
   */
  private static pendingSetupProblem(value: SessionRecord['pendingSetup']): string | null {
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return 'pendingSetup must be an object'
    if (value.local !== undefined && value.local !== true) return 'pendingSetup local must be true when present'
    if (!SessionRecordsStore.isFilledString(value.setupSessionId))
      return 'pendingSetup needs a setupSessionId'
    if (value.agreement !== undefined && (!value.agreement || !SessionRecordsStore.isFilledString(value.agreement.hash)
      || !Array.isArray(value.agreement.commands) || !value.agreement.commands.every((command) => typeof command === 'string')))
      return 'pendingSetup agreement needs commands and their hash'
    // A wait without steps is one an older build wrote: a single setup step.
    if (value.steps === undefined && value.cursor === undefined) return null
    if (!Array.isArray(value.steps) || value.steps.length === 0)
      return 'pendingSetup steps must be a non-empty array'
    for (const step of value.steps) {
      const problem = SessionRecordsStore.scriptStepProblem(step)
      if (problem) return `pendingSetup steps: ${problem}`
    }
    if (typeof value.cursor !== 'number' || !Number.isSafeInteger(value.cursor)
      || value.cursor < 0 || value.cursor >= value.steps.length)
      return `pendingSetup cursor must be an index into its ${value.steps.length} steps`
    return null
  }

  /** Shape only, like the before gate beside it: the cursor must name one of its steps. */
  private static finishChecksProblem(value: SessionRecord['finishChecks']): string | null {
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return 'finishChecks must be an object'
    if (!SessionRecordsStore.isFilledString(value.runId)) return 'finishChecks needs a runId'
    if (!Array.isArray(value.steps) || value.steps.length === 0)
      return 'finishChecks steps must be a non-empty array'
    for (const step of value.steps) {
      const problem = SessionRecordsStore.scriptStepProblem(step)
      if (problem) return `finishChecks steps: ${problem}`
      // Only the project's own checks run after: any other step has no definition to judge it by.
      if (step.scriptId !== 'declared') return `finishChecks steps: a ${JSON.stringify(step.scriptId)} step is not a check`
    }
    if (typeof value.cursor !== 'number' || !Number.isSafeInteger(value.cursor)
      || value.cursor < 0 || value.cursor >= value.steps.length)
      return `finishChecks cursor must be an index into its ${value.steps.length} steps`
    if (typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt))
      return 'finishChecks needs a startedAt number'
    const result = value.result
    if (result === undefined) return null
    if (!result || typeof result !== 'object') return 'finishChecks result must be an object'
    if (typeof result.at !== 'number' || !Number.isFinite(result.at)) return 'finishChecks result needs an at number'
    if (result.kind === 'passed') return null
    else if (result.kind === 'failed')
      return typeof result.reason === 'string' ? null : 'a failed finishChecks result needs a reason'
    else return `unknown finishChecks result ${JSON.stringify((result as { kind?: unknown }).kind)}`
  }

  private static scriptStepProblem(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'a step must be an object'
    const step = value as Partial<SessionRecordScriptStep>
    if (!SessionRecordsStore.isFilledString(step.key)) return 'a step needs a key'
    if (step.scriptId !== 'setup' && step.scriptId !== 'declared' && step.scriptId !== 'checks' && step.scriptId !== 'svn')
      return `unknown step script ${JSON.stringify(step.scriptId)}`
    if (!SessionRecordsStore.isFilledString(step.name)) return 'a step needs a name'
    if (step.commands === undefined) return 'a step needs commands'
    if (step.scriptId === 'svn' && step.process === undefined) return 'an svn step runs a process'
    if (step.process === undefined) return SessionRecordsStore.commandsProblem(step.commands)
    if (!Array.isArray(step.commands) || step.commands.length > 0) return 'a process step runs no commands'
    if (!step.process || typeof step.process !== 'object') return 'a step process must be an object'
    if (!SessionRecordsStore.isFilledString(step.process.cwd)) return 'a step process needs a cwd'
    return SessionRecordsStore.processProblem(step.process)
  }

  /** A launch plans either a shell line or a tool; a record that names both cannot say which it meant. */
  private static recordProcessProblem(record: Partial<SessionRecord>): string | null {
    if (record.process === undefined) return null
    if (record.kind !== 'shell') return 'only a shell record runs a process'
    if (record.commands !== undefined) return 'a record runs commands or a process, never both'
    return SessionRecordsStore.processProblem(record.process)
  }

  private static processProblem(value: SessionRecordProcess): string | null {
    if (!value || typeof value !== 'object') return 'process must be an object'
    if (value.tool !== 'svn' && value.tool !== 'jamat-cli') return `unknown process tool ${JSON.stringify(value.tool)}`
    if (!SessionRecordsStore.isStringList(value.args)) return 'process args must be a list of strings'
    return null
  }

  /**
   * Checked by shape like every other optional field, and deliberately not against the pending pair
   * beside it: this file validates one field at a time, and a wait left on a record whose launch has
   * landed costs nothing - `applyBindLive` clears it, and `LaunchBackoff` is asked only where a
   * replay is already due.
   */
  private static launchWaitProblem(value: SessionRecord['launchWait']): string | null {
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return 'launchWait must be an object'
    if (typeof value.attempts !== 'number' || !Number.isFinite(value.attempts) || value.attempts < 1)
      return 'launchWait needs a positive attempts count'
    if (typeof value.lastAttemptAt !== 'number' || !Number.isFinite(value.lastAttemptAt))
      return 'launchWait needs a lastAttemptAt number'
    if (typeof value.reason !== 'string') return 'launchWait needs a reason string'
    return null
  }

  private static setupSkippedProblem(value: SessionRecord['setupSkipped']): string | null {
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return 'setupSkipped must be an object'
    if (typeof value.reason !== 'string') return 'setupSkipped needs a reason string'
    return null
  }

  /**
   * A command becomes a shell line verbatim, so an empty one would run whatever the `&&` glue around
   * it happens to form. It is refused here, where the caller that built it is still on the stack.
   */
  private static commandsProblem(value: SessionRecord['commands']): string | null {
    if (value === undefined) return null
    if (!Array.isArray(value)) return 'commands must be an array'
    // An empty list is not an install that does nothing: `LaunchPlanner` reads a record whose
    // commands name no step as an INTERACTIVE shell, and a terminal that never exits is a session
    // waiting for its setup for ever with nothing said anywhere.
    if (value.length === 0) return 'commands must name at least one step'
    for (const step of value) {
      if (!step || typeof step !== 'object') return 'a command must be an object'
      if (!SessionRecordsStore.isFilledString(step.command)) return 'a command needs a command'
      if (!SessionRecordsStore.isFilledString(step.cwd)) return 'a command needs a cwd'
    }
    return null
  }

  /** Every reader decides what a run is from this link, so a shape it does not know is no run at all. */
  private static scriptOfProblem(value: SessionRecord['scriptOf']): string | null {
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return 'scriptOf must be an object'
    const link = value as Partial<SessionRecordScriptLink>
    if (!SessionRecordsStore.isFilledString(link.sessionId))
      return `scriptOf sessionId must be a non-empty string, not ${JSON.stringify(link.sessionId)}`
    if (link.phase !== 'before' && link.phase !== 'after' && link.phase !== 'inner')
      return `unknown script phase ${JSON.stringify(link.phase)}`
    if (link.scriptId !== 'setup' && link.scriptId !== 'declared' && link.scriptId !== 'merge-resolve'
      && link.scriptId !== 'requested' && link.scriptId !== 'svn' && link.scriptId !== 'checks' && link.scriptId !== 'svn-resolve'
      && link.scriptId !== 'svn-merge' && link.scriptId !== 'review')
      return `unknown script ${JSON.stringify(link.scriptId)}`
    if (!SessionRecordsStore.isFilledString(link.name)) return 'scriptOf needs a name string'
    if (link.stepKey !== undefined && !SessionRecordsStore.isFilledString(link.stepKey))
      return 'scriptOf stepKey must be a non-empty string'
    if (link.historyExpired !== undefined && typeof link.historyExpired !== 'boolean')
      return 'scriptOf historyExpired must be a boolean'
    // A pair no definition answers would throw in every reconcile pass that reads it.
    if (!SessionScriptDefinitions.known({ phase: link.phase, scriptId: link.scriptId }))
      return `unknown script ${JSON.stringify(`${link.phase}/${link.scriptId}`)}`
    return null
  }

  private static parentProblem(value: SessionRecord['parent']): string | null {
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return 'parent must be an object'
    const link = value as Partial<SessionRecordParentLink>
    if (!SessionRecordsStore.isFilledString(link.sessionId))
      return `parent sessionId must be a non-empty string, not ${JSON.stringify(link.sessionId)}`
    if (!SessionRecordsStore.parentKindsConst.includes(link.kind))
      return `unknown parent kind ${JSON.stringify(link.kind)}`
    return null
  }

  /** Shape only: the history is read by the snapshot, whose words switch over the outcome and the log state. */
  private static actionHistoryProblem(value: SessionRecord['actionHistory']): string | null {
    if (value === undefined) return null
    if (!Array.isArray(value)) return 'actionHistory must be an array'
    for (const entry of value) {
      const problem = SessionRecordsStore.actionHistoryEntryProblem(entry)
      if (problem !== null) return `actionHistory: ${problem}`
    }
    return null
  }

  private static actionHistoryEntryProblem(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'an entry must be an object'
    const entry = value as Partial<SessionRecordActionHistory>
    if (!SessionRecordsStore.isFilledString(entry.key)) return 'an entry needs a key'
    if (typeof entry.startedAt !== 'number' || !Number.isFinite(entry.startedAt)
      || typeof entry.endedAt !== 'number' || !Number.isFinite(entry.endedAt)) return 'an entry needs timestamps'
    const source = entry.source
    if (!source || typeof source !== 'object' || Array.isArray(source)) return 'an entry needs its source'
    if (source.svnAction === undefined && source.worktreeMerge === undefined && source.finishChecks === undefined
      && source.worktreeOutcome === undefined) return 'an entry needs an action'
    const merge = source.worktreeMerge
    if (merge?.runs !== undefined && (!Array.isArray(merge.runs) || !merge.runs.every((run) => run !== null && typeof run === 'object'
      && ['commit', 'base-merging', 'resolving', 'main-merging', 'tearing-down'].includes(run.phase)
      && SessionRecordsStore.isFilledString(run.runId) && Number.isFinite(run.startedAt)
      && (run.endedAt === undefined || Number.isFinite(run.endedAt))))) return 'an entry needs valid Git runs'
    if (merge?.endedAt !== undefined && (typeof merge.endedAt !== 'number' || !Number.isFinite(merge.endedAt)))
      return 'an entry needs a valid Git ending'
    if (entry.ending !== undefined && entry.ending !== 'checks-stopped' && entry.ending !== 'back-to-work')
      return 'an entry needs a known ending'
    return SessionRecordsStore.svnActionProblem(source.svnAction)
      ?? SessionRecordsStore.worktreeMergeProblem(source.worktreeMerge)
      ?? SessionRecordsStore.finishChecksProblem(source.finishChecks)
      ?? SessionRecordsStore.worktreeProblem(source.worktree)
      ?? SessionRecordsStore.worktreeOutcomeProblem(source.worktreeOutcome)
      ?? SessionRecordsStore.worktreeOutcomeProblem(entry.outcome)
  }

  private static scriptRunsProblem(value: SessionRecord['scriptRuns']): string | null {
    if (value === undefined) return null
    if (!Array.isArray(value)) return 'scriptRuns must be an array'
    for (const entry of value) {
      const problem = SessionRecordsStore.scriptRunProblem(entry)
      if (problem) return `scriptRuns: ${problem}`
    }
    return null
  }

  private static scriptRunProblem(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'an entry must be an object'
    const entry = value as Partial<SessionRecordScriptRun>
    if (!SessionRecordsStore.isFilledString(entry.runId)) return 'an entry needs a runId'
    if (entry.phase === undefined || entry.scriptId === undefined
      || !SessionScriptDefinitions.known({ phase: entry.phase, scriptId: entry.scriptId }))
      return `unknown script ${JSON.stringify(`${entry.phase}/${entry.scriptId}`)}`
    if (typeof entry.name !== 'string' || typeof entry.title !== 'string') return 'an entry needs a name and a title'
    if (entry.stepKey !== undefined && !SessionRecordsStore.isFilledString(entry.stepKey))
      return 'an entry stepKey must be a non-empty string'
    if (!SessionRecordsStore.isStringList(entry.commands)) return 'an entry needs a list of commands'
    for (const field of ['startedAt', 'endedAt'] as const)
      if (typeof entry[field] !== 'number' || !Number.isFinite(entry[field])) return `an entry needs a ${field} number`
    if (entry.exitCode !== undefined && (typeof entry.exitCode !== 'number' || !Number.isFinite(entry.exitCode)))
      return 'an entry exitCode must be a number'
    if (entry.outcome !== 'succeeded' && entry.outcome !== 'failed'
      && entry.outcome !== 'stopped' && entry.outcome !== 'lost')
      return `unknown run outcome ${JSON.stringify(entry.outcome)}`
    if (entry.reason !== undefined && typeof entry.reason !== 'string') return 'an entry reason must be a string'
    const log = entry.log
    if (!log || typeof log !== 'object') return 'an entry needs a log'
    if (log.state === 'saved')
      return typeof log.bytes === 'number' && Number.isSafeInteger(log.bytes) && log.bytes >= 0
        && typeof log.truncated === 'boolean' ? null : 'a saved log needs a bytes count and a truncated flag'
    else if (log.state === 'unavailable')
      return typeof log.reason === 'string' ? null : 'an unavailable log needs a reason'
    else
      return `unknown log state ${JSON.stringify((log as { state?: unknown }).state)}`
  }

  private static commitReceiptsProblem(value: SessionRecord['commitReceipts']): string | null {
    if (value === undefined) return null
    if (!Array.isArray(value)) return 'commitReceipts must be an array'
    for (const entry of value) {
      const problem = SessionRecordsStore.commitReceiptProblem(entry)
      if (problem) return `commitReceipts: ${problem}`
    }
    return null
  }

  private static commitReceiptProblem(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'a receipt must be an object'
    const receipt = value as Partial<SessionRecordCommitReceipt>
    if (!SessionRecordsStore.isFilledString(receipt.scopeRoot)) return 'a receipt needs a scopeRoot'
    if (receipt.revision !== null && (typeof receipt.revision !== 'number' || !Number.isSafeInteger(receipt.revision)
      || receipt.revision <= 0))
      return 'a receipt revision must be a positive integer or null'
    if (!SessionRecordsStore.isStringList(receipt.paths)) return 'a receipt needs a list of paths'
    if (typeof receipt.at !== 'number' || !Number.isFinite(receipt.at)) return 'a receipt needs an at number'
    return null
  }

  private static isFilledString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
  }

  /**
   * True when a recovery point exists after this, which is the whole reason it answers at all: the
   * class promises that the previous file is kept FIRST, and `adopt` calls the snapshot "how a
   * mistaken adoption becomes undoable". Swallowing the failure here let the destructive write go
   * ahead with the ring empty, and the caller was told `true` either way.
   *
   * A missing source file is not a failure: there is nothing yet to keep, and the write that
   * follows is the first one. It answers true for that, and only for that.
   */
  private async snapshotCurrent(): Promise<boolean> {
    try {
      AtomicJsonFile.ensureDirectory(this.snapshotsDirectory)
      // Random tie-break, not a counter: a per-process counter restarts at zero every run, so two
      // runs snapshotting in the same millisecond overwrite each other's recovery point.
      await copyFile(
        this.file,
        join(this.snapshotsDirectory, `session-records-${Date.now()}-${randomUUID()}.json`),
      )
    } catch (error) {
      // A missing file on the first destructive write is the common case and is not worth a line.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      this.report(`Session records snapshot failed: ${ErrorText.of(error)}`)
      return false
    }
    // Rotation is housekeeping over points already taken, so its failure is worth a line and is
    // not a reason to refuse the write: the point this call was for is on disk.
    try {
      await this.rotateSnapshots()
    } catch (error) {
      this.report(`Session records snapshot rotation failed: ${ErrorText.of(error)}`)
    }
    return true
  }

  private async rotateSnapshots(): Promise<void> {
    const names = (await readdir(this.snapshotsDirectory))
      .filter((name) => SessionRecordsStore.snapshotPatternConst.test(name))
      .sort()
    for (const name of names.slice(0, Math.max(0, names.length - SessionRecordsStore.snapshotKeepConst)))
      await unlink(join(this.snapshotsDirectory, name))
  }
}
