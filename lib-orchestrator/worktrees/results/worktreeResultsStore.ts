import { constants } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { ErrnoCode } from '../../shared/errnoCode'
import { ErrorText } from '../../shared/errorText'
import { JsonShape } from '../../shared/jsonShape'
import { PathCompare } from '../../shared/pathCompare'
import type { SessionRecordWorktreeCaller } from '../../sessionManager/worktreeSessionRecords'
import type { NotifySource } from '../../sessionManager/worktreeSessionRuntime'
import type { ScriptLogStore } from '../../sessionManager/worktreeSessionScripts'
import type {
  SessionsOpResult,
  SvnFinishWorktreeResult,
  SvnLabelledRevision,
  WorktreeResultCommitMessage,
  WorktreeResultDto,
  WorktreeResultKind,
  WorktreeResultRemoval,
  WorktreeResultsFilter,
} from '../../sessionManager/sessionManagerApi.types'

/** The wake-up line of a result as it is kept: the text and how often it was tried. */
export interface WorktreeResultNotify {
  sessionId: string
  text: string
  state: 'pending' | 'delivered' | 'expired'
  /** When it was delivered or expired; null while it is pending. */
  at: number | null
  /** Deliveries tried and refused (a draft, a dialog, a session that does not run). */
  attempts: number
}

/** One result on disk, `<actionId>.json`; the wire answers `WorktreeResultsStore.dtoOf` of it. */
export interface WorktreeResultRecord {
  main?: NonNullable<WorktreeResultDto['main']>
  mainUnproven?: NonNullable<WorktreeResultDto['mainUnproven']>
  message?: string
  messages?: WorktreeResultCommitMessage[]
  messageSource?: WorktreeResultDto['messageSource']
  acknowledgedFindings?: WorktreeResultDto['acknowledgedFindings']
  actionId: string
  action: WorktreeResultDto['action']
  result: WorktreeResultKind
  sessionId: string
  title: string
  tag: string | null
  worktreePath: string
  mainCopy: string
  directoryId: string | null
  removal: WorktreeResultRemoval
  revisions: SvnLabelledRevision[]
  lines: string[]
  logs: WorktreeResultDto['logs'][number][]
  notify: WorktreeResultNotify | null
  at: number
  acknowledgedAt: number | null
  /** When the main copy was first proven to hold every landed path; a later read keeps that and proves nothing. */
  landedAt?: number
}

/** What an ending writes and what the cleanup finishes, as the flows reach the store. */
export type WorktreeResultsPort = Pick<WorktreeResultsStore, 'put' | 'keepLogs' | 'keepAttempt' | 'pendingRemovalsOf' | 'keptRemovalsOf' | 'removalDone' | 'landedOf' | 'savedDirectoryOf'
  | 'writeHandover' | 'readHandover' | 'mainUpdated'>

export interface WorktreeResultsStoreDeps {
  now: () => number
  logs: Pick<ScriptLogStore, 'existingPathOf' | 'briefPathOf' | 'mergeBriefPathOf'>
  report: (message: string) => void
  /** The ids of the actions still on a record: their folders hold saved copies and survive the orphan sweep. */
  heldActionIds?: () => ReadonlySet<string>
  quarantinedSessionIds?: () => ReadonlySet<string>
}

/**
 * The durable results of SVN worktrees, one file per action in its own directory, read once at
 * start and held. A result outlives its session and the session's run logs, so it keeps copies of
 * the logs of its action beside it (`<actionId>/<runId>.log`). It is kept 30 days, 1 day after it
 * was acknowledged, and swept at load. Writes are atomic and one at a time, so a recording resumed
 * after a restart and a notify landing together still leave one whole file.
 */
export class WorktreeResultsStore {
  private readonly unreadableResults = new Set<string>()
  private sweptAt = 0
  static readonly keepMillisecondsConst = 30 * 86_400_000
  static readonly keepAcknowledgedMillisecondsConst = 86_400_000
  /** Ids name files: anything else could name a path outside the folder. */
  private static readonly plainIdConst = /^[A-Za-z0-9_-]{1,128}$/
  private static readonly resultsConst: readonly WorktreeResultKind[] =
    ['never-started', 'committed', 'nothing', 'partial', 'not-committed', 'discarded', 'kept', 'failed']
  private static readonly removalsConst: readonly WorktreeResultRemoval[] = ['removed', 'pending', 'kept']
  private readonly directory: string
  private readonly now: () => number
  private readonly logs: WorktreeResultsStoreDeps['logs']
  private readonly report: (message: string) => void
  private readonly heldActionIds: () => ReadonlySet<string>
  private readonly quarantinedSessionIds: () => ReadonlySet<string>
  private readonly results = new Map<string, WorktreeResultRecord>()
  private loading: Promise<void> | null = null
  private writes: Promise<unknown> = Promise.resolve()

  constructor(directory: string, deps: WorktreeResultsStoreDeps) {
    this.directory = directory
    this.now = deps.now
    this.logs = deps.logs
    this.report = deps.report
    this.heldActionIds = deps.heldActionIds ?? (() => new Set())
    this.quarantinedSessionIds = deps.quarantinedSessionIds ?? (() => new Set())
  }

  static isPlainId(value: string): boolean {
    return WorktreeResultsStore.plainIdConst.test(value)
  }

  /**
   * Reads every result once, then sweeps those past their keep; a second call joins the first. It
   * never rejects: a sweep that fails is said, and the sessions start all the same.
   */
  load(): Promise<void> {
    this.loading ??= this.read().then(() => this.sweep()).then(
      () => undefined,
      (error: unknown) => this.report(`Worktree results at ${this.directory} could not be swept: ${ErrorText.of(error)}`),
    )
    return this.loading
  }

  /**
   * `<actionId>.json`, atomic. The same id overwrites, so a resumed recording writes one result; a
   * delivered or expired wake-up line, an acknowledgement and the landing proof of the same main
   * copy and revisions already written stay.
   */
  async put(record: WorktreeResultRecord): Promise<boolean> {
    if (!WorktreeResultsStore.isPlainId(record.actionId)) throw new Error(`Not a plain id: ${JSON.stringify(record.actionId)}`)
    return this.serialized(async () => {
      const known = this.results.get(record.actionId)
      const line = known?.notify ?? null
      const sameLine = line !== null && record.notify !== null
        && line.sessionId === record.notify.sessionId && line.text === record.notify.text
      const { mainUnproven: _unproven, landedAt: _landed, ...fields } = record
      const main = record.main ?? known?.main
      const mainUnproven = main === undefined ? record.mainUnproven ?? known?.mainUnproven : undefined
      const sameLanding = known !== undefined && PathCompare.comparable(known.mainCopy) === PathCompare.comparable(record.mainCopy)
        && JSON.stringify(known.revisions) === JSON.stringify(record.revisions)
      const landedAt = record.landedAt ?? (sameLanding ? known.landedAt : undefined)
      const next: WorktreeResultRecord = {
        ...fields,
        main,
        ...mainUnproven === undefined ? {} : { mainUnproven },
        ...landedAt === undefined ? {} : { landedAt },
        notify: sameLine ? line : record.notify,
        acknowledgedAt: known?.acknowledgedAt ?? record.acknowledgedAt,
      }
      return this.written(next)
    })
  }

  async keepAttempt(actionId: string, parentId: string, run: { runId: string; title: string }): Promise<string | null> {
    if (!WorktreeResultsStore.isPlainId(run.runId)) throw new Error(`Not a plain run id: ${run.runId}`)
    const source = await this.logs.existingPathOf(parentId, run.runId)
    if (source === null) return null
    const folder = join(this.logsDirectoryOf(actionId), 'attempts')
    await mkdir(folder, { recursive: true })
    const path = join(folder, `${run.runId}.log`)
    await copyFile(source, path, constants.COPYFILE_EXCL).catch((error: unknown) => {
      if (ErrnoCode.of(error) !== 'EEXIST') throw error
    })
    await AtomicJsonFile.writeAsync(join(folder, `${run.runId}.json`), { runId: run.runId, title: run.title })
    return path
  }

  /**
   * Records the UPDATE on every result it lands, with copies of the UPDATE's run logs: the parent's
   * logs may go with its row right after. A result that already records a landing keeps that first
   * revision and its logs, so a later UPDATE of the same main copy never claims it. A result of the
   * parent itself whose landing the UPDATE cannot prove keeps the logs too, marked `mainUnproven`
   * with the reason, until an UPDATE proves it. A run some result of the parent already keeps (its
   * Finish) is not copied again; the UPDATE's own lines (where it saved the person's changes) join
   * each such result once. Answers the logs each result gained.
   */
  async mainUpdated(mainCopy: string, main: NonNullable<WorktreeResultRecord['main']>,
    holds: (revisions: readonly SvnLabelledRevision[]) => Promise<{ holds: boolean; reason?: string }>,
    update?: { parentId: string; runs: readonly { runId: string; title: string }[]; lines?: readonly string[] }): Promise<{ actionId: string; sessionId: string; logs: WorktreeResultRecord['logs'] }[]> {
    await this.load()
    const known = new Set([...this.results.values()].filter((record) => record.sessionId === update?.parentId)
      .flatMap((record) => record.logs.map((log) => log.runId)))
    const runs = (update?.runs ?? []).filter((run) => !known.has(run.runId))
    const gained: { actionId: string; sessionId: string; logs: WorktreeResultRecord['logs'] }[] = []
    for (const record of [...this.results.values()]) {
      if (record.main !== undefined || PathCompare.comparable(record.mainCopy) !== PathCompare.comparable(mainCopy) || record.revisions.length === 0) continue
      const proof = await holds(record.revisions)
      if (!proof.holds && record.sessionId !== update?.parentId) continue
      const logs: WorktreeResultRecord['logs'] = []
      for (const run of runs.filter((run) => !record.logs.some((log) => log.runId === run.runId))) {
        const path = await this.copyLog(record.actionId, await this.logs.existingPathOf(update!.parentId, run.runId), `${run.runId}.log`)
        if (path !== null) logs.push({ runId: run.runId, title: run.title, path })
      }
      // Each result keeps the revisions of its own repositories: an external's is not the root's (UA1-J13-7).
      const { repositories, ...root } = main
      const own = repositories?.filter((row) => record.revisions.some((revision) => revision.repository === row.repository)) ?? []
      const held = own.length === 0 ? root : { ...root, repositories: own }
      if (!await this.update(record.actionId, (latest) => {
        const { mainUnproven: _unproven, ...rest } = latest
        return { ...rest, ...proof.holds ? { main: held, landedAt: latest.landedAt ?? this.now() } : { mainUnproven: { ...held, reason: proof.reason ?? 'the main copy does not hold every landed path' } },
          logs: [...latest.logs, ...logs.filter((log) => !latest.logs.some((held) => held.runId === log.runId))],
          lines: [...latest.lines, ...(update?.lines ?? []).filter((line) => !latest.lines.includes(line))] }
      })) throw new Error('The main-copy update receipt could not be saved')
      gained.push({ actionId: record.actionId, sessionId: record.sessionId, logs })
    }
    return gained
  }

  /**
   * Copies the action's run logs, the resolver's conflict brief and the merger's brief when there are
   * ones, beside the result: the parent's logs go with the parent. A log that is not on disk is left out.
   */
  async keepLogs(actionId: string, parentId: string, runs: readonly { runId: string; title: string }[]): Promise<WorktreeResultRecord['logs']> {
    const folder = this.logsDirectoryOf(actionId)
    const kept: WorktreeResultRecord['logs'] = []
    const attempts = join(folder, 'attempts')
    for (const name of await readdir(attempts).catch((error: unknown) => {
      if (ErrnoCode.of(error) === 'ENOENT') return []
      throw error
    })) {
      if (!name.endsWith('.json')) continue
      const run = JsonShape.record(JSON.parse(await readFile(join(attempts, name), 'utf8')))
      if (typeof run?.runId !== 'string' || !WorktreeResultsStore.isPlainId(run.runId) || typeof run.title !== 'string') continue
      const path = join(attempts, `${run.runId}.log`)
      if ((await stat(path)).isFile()) kept.push({ runId: run.runId, title: run.title, path })
    }
    const copy = async (from: string | null, name: string, runId: string, title: string): Promise<void> => {
      const path = await this.copyLog(actionId, from, name)
      if (path !== null) kept.push({ runId, title, path })
    }
    for (const run of runs)
      if (!kept.some((entry) => entry.runId === run.runId))
        await copy(await this.logs.existingPathOf(parentId, run.runId), `${run.runId}.log`, run.runId, run.title)
    if (WorktreeResultsStore.isPlainId(parentId)) {
      await copy(this.logs.briefPathOf(parentId, actionId), 'conflicts.txt', `${actionId}-conflicts`, 'conflict brief')
      await copy(this.logs.mergeBriefPathOf(parentId, actionId), 'merge.md', `${actionId}-merge`, 'merger brief')
    }
    return kept
  }

  /** `<actionId>/<name>`, or null when there is nothing to copy or the copy failed, which is reported. */
  private async copyLog(actionId: string, from: string | null, name: string): Promise<string | null> {
    if (from === null) return null
    const folder = this.logsDirectoryOf(actionId)
    const to = join(folder, name)
    try {
      await mkdir(folder, { recursive: true })
      await copyFile(from, to)
      return to
    } catch (error) {
      if (ErrnoCode.of(error) !== 'ENOENT') this.report(`The log ${from} of result ${actionId} could not be kept: ${ErrorText.of(error)}`)
      return null
    }
  }

  /**
   * `<actionId>/saved`: what a conflict option moves, replaces or resolves away is copied here first,
   * so it outlives the session beside the action's log copies.
   */
  savedDirectoryOf(actionId: string): string {
    return join(this.logsDirectoryOf(actionId), 'saved')
  }

  /** `<actionId>/merger-handover.json`: the content hash of every changed path when the merger started. */
  handoverPathOf(actionId: string): string {
    return join(this.logsDirectoryOf(actionId), 'merger-handover.json')
  }

  async writeHandover(actionId: string, hashes: Readonly<Record<string, string>>): Promise<boolean> {
    try {
      await AtomicJsonFile.ensureDirectoryAsync(this.logsDirectoryOf(actionId))
      await AtomicJsonFile.writeAsync(this.handoverPathOf(actionId), { actionId, at: this.now(), hashes })
      return true
    } catch (error) {
      this.report(`The merger handover of ${actionId} could not be written: ${ErrorText.of(error)}`)
      return false
    }
  }

  /** The hashes the merger started on, or null when none were written or they cannot be read. */
  async readHandover(actionId: string): Promise<ReadonlyMap<string, string> | null> {
    try {
      const hashes = JsonShape.record(JsonShape.record(JSON.parse(await readFile(this.handoverPathOf(actionId), 'utf8')))?.hashes)
      if (hashes === null) return null
      const entries = Object.entries(hashes)
      return entries.every(([, hash]) => typeof hash === 'string') ? new Map(entries as [string, string][]) : null
    } catch (error) {
      if (ErrnoCode.of(error) !== 'ENOENT') this.report(`The merger handover of ${actionId} could not be read: ${ErrorText.of(error)}`)
      return null
    }
  }

  list(filter: WorktreeResultsFilter): WorktreeResultRecord[] {
    return [...this.results.values()]
      .filter((record) => (filter.tag === undefined || record.tag === filter.tag)
        && (filter.sessionId === undefined || record.sessionId === filter.sessionId)
        && (filter.unacknowledged !== true || record.acknowledgedAt === null))
      .sort((a, b) => a.at - b.at || (a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : 0))
  }

  async acknowledge(actionId: string): Promise<SessionsOpResult<{ actionId: string }>> {
    const known = this.results.get(actionId)
    if (known === undefined) return { ok: false, code: 'not-found', detail: `No worktree result ${actionId}` }
    if (known.acknowledgedAt !== null) return { ok: true, value: { actionId } }
    const written = await this.update(actionId, (record) => ({ ...record, acknowledgedAt: this.now() }))
    return written
      ? { ok: true, value: { actionId } }
      : { ok: false, code: 'records-latched', detail: `The worktree result ${actionId} could not be written` }
  }

  /** The results of a session whose worktree is still on disk, which the cleanup finishes. */
  /** The main copy held every landed path of the result once. */
  async landed(actionId: string): Promise<boolean> {
    return this.update(actionId, (record) => record.landedAt !== undefined ? null : { ...record, landedAt: this.now() })
  }

  pendingRemovalsOf(sessionId: string): string[] {
    return this.list({ sessionId }).filter((record) => record.removal === 'pending').map((record) => record.actionId)
  }

  /**
   * The results of a session that kept its worktree. A later removal of that worktree finishes them too,
   * so a result does not say `kept` for a worktree that is gone (UA1-J11-3).
   */
  keptRemovalsOf(sessionId: string): string[] {
    return this.list({ sessionId }).filter((record) => record.removal === 'kept').map((record) => record.actionId)
  }

  /** The revisions the committed results among these landed; the landed row of their session waits for them. */
  landedOf(actionIds: readonly string[]): SvnLabelledRevision[] {
    return actionIds.flatMap((actionId) => {
      const record = this.results.get(actionId)
      return record?.result === 'committed' || record?.result === 'partial' ? record.revisions : []
    })
  }

  /** A later removal of the same worktree finishes the result it already wrote; `lines` are what that removal copied. */
  async removalDone(actionId: string, lines: readonly string[] = []): Promise<void> {
    await this.update(actionId, (record) => record.removal === 'pending' || record.removal === 'kept'
      ? { ...record, removal: 'removed', lines: [...record.lines, '   worktree removed after the session', ...lines] }
      : null)
  }

  /** The results whose wake-up line is still to be typed. */
  pendingNotifies(): WorktreeResultRecord[] {
    return this.list({}).filter((record) => record.notify?.state === 'pending')
  }

  notifySource(): NotifySource {
    return {
      pending: () => this.pendingNotifies().flatMap((record) => record.notify === null ? [] : [{
        id: record.actionId, sessionId: record.notify.sessionId, text: record.notify.text,
        at: record.at, attempts: record.notify.attempts,
      }]),
      note: (ids, state, at) => this.noteNotify(ids, state, at),
    }
  }

  /** `attempted` counts a refused delivery; the other two end the line. */
  async noteNotify(actionIds: readonly string[], state: 'delivered' | 'expired' | 'attempted', at: number): Promise<void> {
    for (const actionId of actionIds)
      await this.update(actionId, (record) => {
        const notify = record.notify
        if (notify === null || notify.state !== 'pending') return null
        if (state === 'attempted') return { ...record, notify: { ...notify, attempts: notify.attempts + 1 } }
        else if (state === 'delivered' || state === 'expired') return { ...record, notify: { ...notify, state, at } }
        else throw new Error(`Unknown notify state: ${JSON.stringify(state satisfies never)}`)
      })
  }

  /** Results past their keep go with their logs; answers how many went. */
  async sweepDue(): Promise<void> {
    if (this.now() - this.sweptAt < 60_000) return
    this.sweptAt = this.now()
    await this.sweep()
  }

  async sweep(): Promise<number> {
    const now = this.now()
    let removed = 0
    for (const record of [...this.results.values()]) {
      if (this.quarantinedSessionIds().has(record.sessionId)) continue
      const retained = (await readdir(this.logsDirectoryOf(record.actionId)).catch((error: unknown) => {
        if (ErrnoCode.of(error) === 'ENOENT') return []
        throw error
      })).some((name) => ['saved', 'ignored', 'discarded', 'setup'].includes(name))
      const keep = record.acknowledgedAt === null || retained
        ? record.at + WorktreeResultsStore.keepMillisecondsConst
        : record.acknowledgedAt + WorktreeResultsStore.keepAcknowledgedMillisecondsConst
      if (now < keep || this.heldActionIds().has(record.actionId)) continue
      await this.serialized(async () => {
        await rm(this.fileOf(record.actionId), { force: true })
        await rm(this.logsDirectoryOf(record.actionId), { recursive: true, force: true })
        this.results.delete(record.actionId)
      })
      removed += 1
    }
    return removed
  }

  /** A new result: the caller's tag and a pending wake-up line when the caller asked for one. */
  static recordOf(input: Omit<WorktreeResultRecord, 'tag' | 'notify' | 'acknowledgedAt'> & {
    caller: SessionRecordWorktreeCaller | undefined
  }): WorktreeResultRecord {
    const { caller, ...fields } = input
    const notify = caller?.notify
    return {
      ...fields,
      tag: caller?.tag ?? null,
      notify: notify === undefined ? null : { sessionId: notify.sessionId, text: notify.text, state: 'pending', at: null, attempts: 0 },
      acknowledgedAt: null,
    }
  }

  /** `in-use` and `undeleted` leave the worktree to the cleanup, which finishes the result. */
  static removalOf(removal: SvnFinishWorktreeResult): WorktreeResultRemoval {
    if (removal === 'removed') return 'removed'
    else if (removal === 'in-use' || removal === 'undeleted') return 'pending'
    else if (removal === 'kept') return 'kept'
    else throw new Error(`Unknown worktree removal: ${JSON.stringify(removal satisfies never)}`)
  }

  static dtoOf(record: WorktreeResultRecord): WorktreeResultDto {
    return {
      main: record.main,
      ...record.mainUnproven === undefined ? {} : { mainUnproven: record.mainUnproven },
      actionId: record.actionId,
      message: record.message,
      ...record.messages === undefined ? {} : { messages: record.messages },
      messageSource: record.messageSource,
      acknowledgedFindings: record.acknowledgedFindings,
      action: record.action,
      result: record.result,
      sessionId: record.sessionId,
      title: record.title,
      tag: record.tag,
      worktreePath: record.worktreePath,
      mainCopy: record.mainCopy,
      directoryId: record.directoryId,
      removal: record.removal,
      revisions: record.revisions,
      lines: record.lines,
      logs: record.logs,
      notify: record.notify === null ? null : { sessionId: record.notify.sessionId, state: record.notify.state, at: record.notify.at },
      holdsLanded: null,
      at: record.at,
      acknowledgedAt: record.acknowledgedAt,
    }
  }

  private async read(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if (ErrnoCode.of(error) === 'ENOENT') return
      this.report(`Worktree results at ${this.directory} could not be read: ${ErrorText.of(error)}`)
      return
    }
    for (const name of names) {
      const actionId = name.endsWith('.json') ? name.slice(0, -'.json'.length) : null
      if (actionId === null || !WorktreeResultsStore.isPlainId(actionId) || this.results.has(actionId)) continue
      try {
        const parsed = WorktreeResultsStore.parsed(JSON.parse(await readFile(join(this.directory, name), 'utf8')), actionId)
        if (parsed === null) { this.unreadableResults.add(actionId); this.report(`Worktree results at ${this.directory}: ${name} is not a result; it is left alone`) }
        else this.results.set(actionId, parsed)
      } catch (error) {
        this.unreadableResults.add(actionId)
        this.report(`Worktree results at ${this.directory}: ${name} could not be read (${ErrorText.of(error)}); it is left alone`)
      }
    }
    await this.sweepOrphanLogs()
  }

  /**
   * A log folder whose result was never written (a client that died between the two) goes after the
   * keep; the folder of an action still on a record holds its saved copies and stays.
   */
  private async sweepOrphanLogs(): Promise<void> {
    if (this.quarantinedSessionIds().size > 0) return
    const entries = await readdir(this.directory, { withFileTypes: true })
    const before = this.now() - WorktreeResultsStore.keepMillisecondsConst
    const held = this.heldActionIds()
    for (const entry of entries) {
      if (!entry.isDirectory() || this.results.has(entry.name) || this.unreadableResults.has(entry.name) || held.has(entry.name)) continue
      const folder = join(this.directory, entry.name)
      if ((await stat(folder)).mtimeMs < before) await rm(folder, { recursive: true, force: true })
    }
  }

  private async update(actionId: string, change: (record: WorktreeResultRecord) => WorktreeResultRecord | null): Promise<boolean> {
    return this.serialized(async () => {
      const known = this.results.get(actionId)
      if (known === undefined) return false
      const next = change(known)
      return next === null ? true : this.written(next)
    })
  }

  private async written(record: WorktreeResultRecord): Promise<boolean> {
    try {
      await AtomicJsonFile.ensureDirectoryAsync(this.directory)
      await AtomicJsonFile.writeAsync(this.fileOf(record.actionId), record)
      this.results.set(record.actionId, record)
      return true
    } catch (error) {
      this.report(`The worktree result ${record.actionId} could not be written: ${ErrorText.of(error)}`)
      return false
    }
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work)
    this.writes = next.catch(() => undefined)
    return next
  }

  private fileOf(actionId: string): string {
    return join(this.directory, `${actionId}.json`)
  }

  private logsDirectoryOf(actionId: string): string {
    if (!WorktreeResultsStore.isPlainId(actionId)) throw new Error(`Not a plain id: ${JSON.stringify(actionId)}`)
    return join(this.directory, actionId)
  }

  /** The fields every reader keys on; a file that lacks one is not a result of this build. */
  private static parsed(value: unknown, actionId: string): WorktreeResultRecord | null {
    const record = JsonShape.record(value)
    if (record === null || record.actionId !== actionId) return null
    const strings = ['sessionId', 'title', 'worktreePath', 'mainCopy'] as const
    if (strings.some((field) => typeof record[field] !== 'string')) return null
    if (record.action !== 'finish' && record.action !== 'discard' && record.action !== 'cleanup') return null
    if (!WorktreeResultsStore.resultsConst.includes(record.result as WorktreeResultKind)) return null
    if (!WorktreeResultsStore.removalsConst.includes(record.removal as WorktreeResultRemoval)) return null
    if (typeof record.at !== 'number' || !Number.isFinite(record.at)) return null
    if (record.acknowledgedAt !== null && (typeof record.acknowledgedAt !== 'number' || !Number.isFinite(record.acknowledgedAt))) return null
    if (record.tag !== null && typeof record.tag !== 'string') return null
    if (record.landedAt !== undefined && (typeof record.landedAt !== 'number' || !Number.isFinite(record.landedAt))) delete record.landedAt
    if (record.directoryId !== null && typeof record.directoryId !== 'string') return null
    if (!Array.isArray(record.revisions) || !Array.isArray(record.lines) || !Array.isArray(record.logs)) return null
    if (record.notify !== null && !WorktreeResultsStore.isNotify(record.notify)) return null
    const main = JsonShape.record(record.main)
    if (record.main !== undefined && (main === null || !Number.isSafeInteger(main.revision) || Number(main.revision) < 0
      || main.by !== 'person' && main.by !== 'agent' || typeof main.at !== 'number' || !Number.isFinite(main.at))) delete record.main
    else if (main !== null && !WorktreeResultsStore.isRepositoryRevisions(main.repositories)) delete main.repositories
    const unproven = JsonShape.record(record.mainUnproven)
    if (record.mainUnproven !== undefined && (unproven === null || !Number.isSafeInteger(unproven.revision) || Number(unproven.revision) < 0
      || unproven.by !== 'person' && unproven.by !== 'agent' || typeof unproven.at !== 'number' || !Number.isFinite(unproven.at)
      || typeof unproven.reason !== 'string')) delete record.mainUnproven
    else if (unproven !== null && !WorktreeResultsStore.isRepositoryRevisions(unproven.repositories)) delete unproven.repositories
    if (record.messages !== undefined && (!Array.isArray(record.messages) || !record.messages.every((row) => {
      const message = JsonShape.record(row)
      return message !== null && typeof message.repository === 'string' && Number.isSafeInteger(message.revision) && typeof message.message === 'string'
        && (message.adoptedFrom === undefined || typeof message.adoptedFrom === 'string')
        && (message.source === undefined || typeof message.source === 'string')
        && (message.acknowledgedFindings === undefined || Array.isArray(message.acknowledgedFindings))
    }))) delete record.messages
    return record as unknown as WorktreeResultRecord
  }

  /** Absent, or a list of repository URLs with a revision each. */
  private static isRepositoryRevisions(value: unknown): boolean {
    return value === undefined || Array.isArray(value) && value.every((row) => {
      const entry = JsonShape.record(row)
      return entry !== null && typeof entry.repository === 'string' && Number.isSafeInteger(entry.revision) && Number(entry.revision) >= 0
    })
  }

  private static isNotify(value: unknown): value is WorktreeResultNotify {
    const notify = JsonShape.record(value)
    return notify !== null && typeof notify.sessionId === 'string' && typeof notify.text === 'string'
      && (notify.state === 'pending' || notify.state === 'delivered' || notify.state === 'expired')
      && (notify.at === null || typeof notify.at === 'number')
      && Number.isSafeInteger(notify.attempts)
  }
}
