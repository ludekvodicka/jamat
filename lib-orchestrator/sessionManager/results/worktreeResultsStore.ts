import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { ErrnoCode } from '../../shared/errnoCode'
import { ErrorText } from '../../shared/errorText'
import { JsonShape } from '../../shared/jsonShape'
import type { SessionRecordWorktreeCaller } from '../records/sessionRecord.types'
import type { NotifySource } from '../notifies/sessionNotifier'
import type { ScriptLogStore } from '../scripts/scriptLogStore'
import type {
  SessionsOpResult,
  SvnFinishWorktreeResult,
  SvnLabelledRevision,
  WorktreeResultDto,
  WorktreeResultKind,
  WorktreeResultRemoval,
  WorktreeResultsFilter,
} from '../sessionManagerApi.types'

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
}

/** What an ending writes and what the cleanup finishes, as the flows reach the store. */
export type WorktreeResultsPort = Pick<WorktreeResultsStore, 'put' | 'keepLogs' | 'pendingRemovalsOf' | 'removalDone' | 'landedOf'>

export interface WorktreeResultsStoreDeps {
  now: () => number
  logs: Pick<ScriptLogStore, 'existingPathOf' | 'briefPathOf'>
  report: (message: string) => void
}

/**
 * The durable results of SVN worktrees, one file per action in its own directory, read once at
 * start and held. A result outlives its session and the session's run logs, so it keeps copies of
 * the logs of its action beside it (`<actionId>/<runId>.log`). It is kept 30 days, 1 day after it
 * was acknowledged, and swept at load. Writes are atomic and one at a time, so a recording resumed
 * after a restart and a notify landing together still leave one whole file.
 */
export class WorktreeResultsStore {
  static readonly keepMillisecondsConst = 30 * 86_400_000
  static readonly keepAcknowledgedMillisecondsConst = 86_400_000
  /** Ids name files: anything else could name a path outside the folder. */
  private static readonly plainIdConst = /^[A-Za-z0-9_-]{1,128}$/
  private static readonly resultsConst: readonly WorktreeResultKind[] =
    ['committed', 'nothing', 'partial', 'not-committed', 'discarded', 'kept', 'failed']
  private static readonly removalsConst: readonly WorktreeResultRemoval[] = ['removed', 'pending', 'kept']
  private readonly directory: string
  private readonly now: () => number
  private readonly logs: WorktreeResultsStoreDeps['logs']
  private readonly report: (message: string) => void
  private readonly results = new Map<string, WorktreeResultRecord>()
  private loading: Promise<void> | null = null
  private writes: Promise<unknown> = Promise.resolve()

  constructor(directory: string, deps: WorktreeResultsStoreDeps) {
    this.directory = directory
    this.now = deps.now
    this.logs = deps.logs
    this.report = deps.report
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
   * delivered or expired wake-up line and an acknowledgement already written stay.
   */
  async put(record: WorktreeResultRecord): Promise<boolean> {
    if (!WorktreeResultsStore.isPlainId(record.actionId)) throw new Error(`Not a plain id: ${JSON.stringify(record.actionId)}`)
    return this.serialized(async () => {
      const known = this.results.get(record.actionId)
      const line = known?.notify ?? null
      const sameLine = line !== null && record.notify !== null
        && line.sessionId === record.notify.sessionId && line.text === record.notify.text
      const next: WorktreeResultRecord = {
        ...record,
        notify: sameLine ? line : record.notify,
        acknowledgedAt: known?.acknowledgedAt ?? record.acknowledgedAt,
      }
      return this.written(next)
    })
  }

  /**
   * Copies the action's run logs, and the resolver's conflict brief when there is one, beside the
   * result: the parent's logs go with the parent. A log that is not on disk is left out.
   */
  async keepLogs(actionId: string, parentId: string, runs: readonly { runId: string; title: string }[]): Promise<WorktreeResultRecord['logs']> {
    const folder = this.logsDirectoryOf(actionId)
    const kept: WorktreeResultRecord['logs'] = []
    const copy = async (from: string | null, name: string, runId: string, title: string): Promise<void> => {
      if (from === null) return
      const to = join(folder, name)
      try {
        await mkdir(folder, { recursive: true })
        await copyFile(from, to)
        kept.push({ runId, title, path: to })
      } catch (error) {
        if (ErrnoCode.of(error) !== 'ENOENT') this.report(`The log ${from} of result ${actionId} could not be kept: ${ErrorText.of(error)}`)
      }
    }
    for (const run of runs)
      await copy(await this.logs.existingPathOf(parentId, run.runId), `${run.runId}.log`, run.runId, run.title)
    if (WorktreeResultsStore.isPlainId(parentId))
      await copy(this.logs.briefPathOf(parentId, actionId), 'conflicts.txt', `${actionId}-conflicts`, 'conflict brief')
    return kept
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
  pendingRemovalsOf(sessionId: string): string[] {
    return this.list({ sessionId }).filter((record) => record.removal === 'pending').map((record) => record.actionId)
  }

  /** The revisions the committed results among these landed; the landed row of their session waits for them. */
  landedOf(actionIds: readonly string[]): SvnLabelledRevision[] {
    return actionIds.flatMap((actionId) => {
      const record = this.results.get(actionId)
      return record?.result === 'committed' ? record.revisions : []
    })
  }

  /** A later removal of the same worktree finishes the result it already wrote. */
  async removalDone(actionId: string): Promise<void> {
    await this.update(actionId, (record) => record.removal === 'pending'
      ? { ...record, removal: 'removed', lines: [...record.lines, '   worktree removed after the session'] }
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
  async sweep(): Promise<number> {
    const now = this.now()
    let removed = 0
    for (const record of [...this.results.values()]) {
      const keep = record.acknowledgedAt === null
        ? record.at + WorktreeResultsStore.keepMillisecondsConst
        : record.acknowledgedAt + WorktreeResultsStore.keepAcknowledgedMillisecondsConst
      if (now < keep) continue
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
      actionId: record.actionId,
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
        if (parsed === null) this.report(`Worktree results at ${this.directory}: ${name} is not a result; it is left alone`)
        else this.results.set(actionId, parsed)
      } catch (error) {
        this.report(`Worktree results at ${this.directory}: ${name} could not be read (${ErrorText.of(error)}); it is left alone`)
      }
    }
    await this.sweepOrphanLogs()
  }

  /** A log folder whose result was never written (a client that died between the two) goes after the keep. */
  private async sweepOrphanLogs(): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true })
    const before = this.now() - WorktreeResultsStore.keepMillisecondsConst
    for (const entry of entries) {
      if (!entry.isDirectory() || this.results.has(entry.name)) continue
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
    if (record.directoryId !== null && typeof record.directoryId !== 'string') return null
    if (!Array.isArray(record.revisions) || !Array.isArray(record.lines) || !Array.isArray(record.logs)) return null
    if (record.notify !== null && !WorktreeResultsStore.isNotify(record.notify)) return null
    return record as unknown as WorktreeResultRecord
  }

  private static isNotify(value: unknown): value is WorktreeResultNotify {
    const notify = JsonShape.record(value)
    return notify !== null && typeof notify.sessionId === 'string' && typeof notify.text === 'string'
      && (notify.state === 'pending' || notify.state === 'delivered' || notify.state === 'expired')
      && (notify.at === null || typeof notify.at === 'number')
      && Number.isSafeInteger(notify.attempts)
  }
}
