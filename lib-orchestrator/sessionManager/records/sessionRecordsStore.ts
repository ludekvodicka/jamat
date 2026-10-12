import { randomUUID } from 'node:crypto'
import { copyFile, readdir, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { ErrorText } from '../../shared/errorText'
import { type JsonDocumentReading, JsonDocumentStore } from '../../shared/jsonDocumentStore'
import { SessionLimits } from '../sessionLimits'
import type { SessionWorktreeKind, SvnLabelledRevision } from '../sessionManagerApi.types'
import { SessionScriptDefinitions } from '../scripts/sessionScriptDefinitions'
import type {
  SessionRecord,
  SessionRecordCommitReceipt,
  SessionRecordProcess,
  SessionRecordScriptLink,
  SessionRecordScriptRun,
  SessionRecordScriptStep,
  SessionRecordSvnAction,
  SessionRecordsDocument,
  SessionRecordWorktreeCaller,
} from './sessionRecord.types'

export interface SessionRecordsStoreOptions {
  snapshotsDirectory: string
  report?: (message: string) => void
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
  private static readonly svnActionStagesConst: readonly unknown[] = ['stopping', 'evidence', 'checks', 'updating',
    'cleaning', 'resolving', 'verifying', 'diffing', 'reviewing', 'removing', 'recording']
  private static readonly svnActionNeedsConst: readonly unknown[] = ['check-failed', 'conflict', 'resolver-failed', 'incoming',
    'out-of-date', 'review-cancelled', 'review-interrupted', 'partial', 'pinned-external', 'locked', 'svn-failed', 'not-stopped']
  private static readonly revisionLabelsConst: readonly unknown[] = ['receipt', 'base-proof', 'inferred']
  private records: SessionRecord[] = []
  private readonly pendingUserInput = new Map<string, number>()
  /** How many records the read turned from a cut-short finish into an `interrupted` outcome. */
  private interruptedFinishes = 0
  private documentRead = false

  private constructor(
    file: string,
    private readonly snapshotsDirectory: string,
    report: (message: string) => void,
  ) {
    super(file, report)
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
    )
    await store.read()
    if (store.interruptedFinishes > 0 && !await store.inTurn(() => store.commit(store.records, false)))
      store.report(`Session records at ${file}: ${store.interruptedFinishes} interrupted worktree `
        + 'finishes could not be written back; they read as interrupted until the next write')
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
  async put(record: SessionRecord): Promise<boolean> {
    // Validated OUTSIDE the turn: a record this store would refuse is refused to the caller
    // that wrote it, at the moment they wrote it, rather than after a wait behind somebody else.
    SessionRecordsStore.assertValid(record)
    return this.inTurn(() => {
      const next = this.records.filter((entry) => entry.sessionId !== record.sessionId)
      next.push(record)
      return this.commit(next, false)
    })
  }

  /**
   * Read-modify-write of one record with the read INSIDE the turn, so a write queued meanwhile is
   * never undone by a stale copy. `change` answers null to write nothing, and so does a missing
   * record; either answers false. Routine, so it spends no recovery point.
   */
  async update(sessionId: string, change: (record: SessionRecord) => SessionRecord | null): Promise<boolean> {
    return this.inTurn(() => {
      const current = this.get(sessionId)
      const next = current === null ? null : change(current)
      if (next === null) return Promise.resolve(false)
      if (next.sessionId !== sessionId) throw new Error(`An update of ${sessionId} answered ${next.sessionId}`)
      SessionRecordsStore.assertValid(next)
      return this.commit(this.records.map((record) => record.sessionId === sessionId ? next : record), false)
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
  private async commit(records: SessionRecord[], destructive: boolean): Promise<boolean> {
    const inputTimes = new Map(this.records.map((record) => [record.sessionId, record.lastUserInputAt ?? 0]))
    for (const [sessionId, at] of this.pendingUserInput) inputTimes.set(sessionId, at)
    records = records.map((record) => {
      const at = Math.max(record.lastUserInputAt ?? 0, inputTimes.get(record.sessionId) ?? 0)
      return at > 0 ? { ...record, lastUserInputAt: at } : record
    })
    const document: SessionRecordsDocument = { schemaVersion: 1, savedAt: Date.now(), records }
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
    for (const [sessionId, at] of this.pendingUserInput)
      if (!this.get(sessionId) || at <= (this.get(sessionId)?.lastUserInputAt ?? 0))
        this.pendingUserInput.delete(sessionId)
    return true
  }

  private async read(): Promise<void> {
    this.records = await this.readDocument()
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
      SessionRecordsStore.migrateScriptLink(candidate)
      this.dropDamagedAnnotations(candidate)
      const reason = SessionRecordsStore.problemOf(candidate, seen)
      if (reason) {
        this.report(`Session records at ${this.file}: dropping a record (${reason})`)
        continue
      }
      const record = candidate as SessionRecord
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
      if (record.worktreeFinish !== undefined) {
        records.push(SessionRecordsStore.interruptedFinishOf(record, Date.now()))
        this.interruptedFinishes++
      }
      else records.push(record)
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
  private dropDamagedAnnotations(candidate: unknown): void {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return
    const record = candidate as Partial<SessionRecord>
    const subject = `Session records at ${this.file}: record ${JSON.stringify(record.sessionId)}`
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
    // The worktree stays and Finish starts again; only the action this build cannot read goes.
    const action = SessionRecordsStore.svnActionProblem(record.svnAction)
    if (action !== null) {
      this.report(`${subject}: dropping its SVN action (${action})`)
      delete record.svnAction
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

  private static problemOf(candidate: unknown, seen: ReadonlySet<string>): string | null {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      return 'expected an object'
    const record = candidate as Partial<SessionRecord>
    if (!SessionRecordsStore.isFilledString(record.sessionId))
      return 'sessionId must be a non-empty string'
    if (seen.has(record.sessionId)) return `duplicate sessionId ${record.sessionId}`
    if (record.kind !== 'shell' && record.kind !== 'agent')
      return `record ${record.sessionId}: kind must be shell or agent`
    if (typeof record.title !== 'string')
      return `record ${record.sessionId}: title must be a string`
    if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt))
      return `record ${record.sessionId}: createdAt must be a number`
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
      ?? SessionRecordsStore.scriptRunsProblem(record.scriptRuns)
      ?? SessionRecordsStore.commitReceiptsProblem(record.commitReceipts)
      ?? SessionRecordsStore.worktreeProblem(record.worktree)
      ?? SessionRecordsStore.worktreeMergeProblem(record.worktreeMerge)
      ?? SessionRecordsStore.worktreeFinishProblem(record.worktreeFinish)
      ?? SessionRecordsStore.svnActionProblem(record.svnAction)
      ?? SessionRecordsStore.worktreeOutcomeProblem(record.worktreeOutcome)
      ?? SessionRecordsStore.retiredWorktreeProblem(record.retiredWorktree)
      ?? SessionRecordsStore.worktreeCleanupProblem(record.worktreeCleanup)
      ?? SessionRecordsStore.flowIdProblem(record.flowId)
      ?? SessionRecordsStore.completedProblem(record.completed)
      ?? SessionRecordsStore.stopRequestedProblem(record.stopRequested)
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
    if (value.cwdSubpath !== undefined && !SessionRecordsStore.isSubpath(value.cwdSubpath))
      return 'worktree cwdSubpath must be a relative path of named segments joined by /'
    return SessionRecordsStore.callerProblem(value.caller)
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
    for (const field of ['runId', 'reviewCommitId'] as const)
      if (action[field] !== undefined && !SessionRecordsStore.isFilledString(action[field]))
        return `svnAction ${field} must be a non-empty string`
    if (!Array.isArray(action.checks)) return 'svnAction checks must be an array'
    for (const step of action.checks) {
      const problem = SessionRecordsStore.scriptStepProblem(step)
      if (problem) return `svnAction checks: ${problem}`
      if (step.scriptId !== 'checks') return `svnAction checks: a ${JSON.stringify(step.scriptId)} step is not a check`
    }
    if (!SessionRecordsStore.isIndex(action.checkCursor, Math.max(action.checks.length, 1)))
      return 'svnAction checkCursor must be an index into its checks'
    if (action.roots !== undefined && (!Array.isArray(action.roots) || !action.roots.every((root) => root && typeof root === 'object'
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
    if (value.permission !== undefined && value.permission !== 'accept-edits')
      return `unknown agent permission ${JSON.stringify(value.permission)}`
    if (value.nativeSessionIdSource !== undefined && value.nativeSessionIdSource !== 'provided'
      && value.nativeSessionIdSource !== 'codex-app-server') return 'unknown native identity source'
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
    if (!SessionRecordsStore.isFilledString(value.setupSessionId))
      return 'pendingSetup needs a setupSessionId'
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
      && link.scriptId !== 'review')
      return `unknown script ${JSON.stringify(link.scriptId)}`
    if (!SessionRecordsStore.isFilledString(link.name)) return 'scriptOf needs a name string'
    if (link.stepKey !== undefined && !SessionRecordsStore.isFilledString(link.stepKey))
      return 'scriptOf stepKey must be a non-empty string'
    // A pair no definition answers would throw in every reconcile pass that reads it.
    if (!SessionScriptDefinitions.known({ phase: link.phase, scriptId: link.scriptId }))
      return `unknown script ${JSON.stringify(`${link.phase}/${link.scriptId}`)}`
    return null
  }

  /** Shape only: the history is read by the snapshot, whose words switch over the outcome and the log state. */
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
