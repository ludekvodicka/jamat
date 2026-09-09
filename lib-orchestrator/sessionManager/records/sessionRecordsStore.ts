import { randomUUID } from 'node:crypto'
import { copyFile, readdir, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { ErrorText } from '../../shared/errorText'
import { type JsonDocumentReading, JsonDocumentStore } from '../../shared/jsonDocumentStore'
import type { SessionRecord, SessionRecordsDocument } from './sessionRecord.types'

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
  private records: SessionRecord[] = []

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
    return store
  }

  /** Every mutation of this store, in the order it was asked for. See `inTurn`. */
  private writes: Promise<unknown> = Promise.resolve()

  list(): readonly SessionRecord[] {
    return this.records
  }

  get(sessionId: string): SessionRecord | null {
    return this.records.find((record) => record.sessionId === sessionId) ?? null
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

  /** A record disappears for good, so the previous file is kept as a recovery point first. */
  async remove(sessionId: string): Promise<boolean> {
    // The latch is checked before the no-op short-circuit on purpose: after a failed read the
    // in-memory list is empty because nothing could be read, so "there was nothing to remove" is
    // exactly the answer this store cannot honestly give.
    if (!this.mayWrite()) return false
    return this.inTurn(() => {
      const next = this.records.filter((record) => record.sessionId !== sessionId)
      if (next.length === this.records.length) return Promise.resolve(true)
      return this.commit(next, true)
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
    return { document: this.recordsOf(parsed), damaged: false }
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
    for (const candidate of document.records ?? []) {
      const reason = SessionRecordsStore.problemOf(candidate, seen)
      if (reason) {
        this.report(`Session records at ${this.file}: dropping a record (${reason})`)
        continue
      }
      const record = candidate as SessionRecord
      seen.add(record.sessionId)
      records.push(record)
    }
    return records
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
    // flowId, presentation, completed, stopRequested and note, none of which is a setup field.
    const problem = SessionRecordsStore.pendingSetupProblem(record.pendingSetup)
      ?? SessionRecordsStore.transcriptCwdProblem(record.transcriptCwd, record.kind)
      ?? SessionRecordsStore.setupSkippedProblem(record.setupSkipped)
      ?? SessionRecordsStore.commandsProblem(record.commands)
      ?? SessionRecordsStore.setupForProblem(record.setupFor)
      ?? SessionRecordsStore.worktreeProblem(record.worktree)
      ?? SessionRecordsStore.worktreeMergeProblem(record.worktreeMerge)
      ?? SessionRecordsStore.resolveForProblem(record.resolveFor)
      ?? SessionRecordsStore.flowIdProblem(record.flowId)
      ?? SessionRecordsStore.presentationProblem(record.presentation)
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

  private static presentationProblem(value: SessionRecord['presentation']): string | null {
    if (value === undefined || value === 'tab') return null
    return `unknown presentation ${JSON.stringify(value)}`
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
    return null
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

  /** The other direction of the same link `setupFor` names, and checked the same way. */
  private static resolveForProblem(value: SessionRecord['resolveFor']): string | null {
    if (value === undefined || SessionRecordsStore.isFilledString(value)) return null
    return `resolveFor must be a non-empty string, not ${JSON.stringify(value)}`
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

  private static setupForProblem(value: SessionRecord['setupFor']): string | null {
    if (value === undefined) return null
    if (!SessionRecordsStore.isFilledString(value)) return 'setupFor must be a non-empty string'
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
