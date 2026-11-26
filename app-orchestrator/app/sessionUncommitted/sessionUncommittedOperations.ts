import type { SessionUncommittedCandidate } from '../../../lib-orchestrator/sessionManager/sessionUncommittedView'
import type { SessionActivity, SessionCommitReceipt } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionUncommittedEntry, SessionUncommittedSnapshot } from '../../../lib-orchestrator/sessionUncommitted/sessionUncommitted.types'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import { PathCompare } from '../../../lib-orchestrator/shared/pathCompare'
import { SvnWcStamp } from '../../../lib-orchestrator/svn/svnWcStamp'
import type { SessionUncommittedWorker } from './sessionUncommittedWorker'
import type { SessionUncommittedScanReason, SessionUncommittedStatusEntry } from './sessionUncommittedWorker.types'

export interface SessionUncommittedOperationsDeps {
  worker: Pick<SessionUncommittedWorker, 'scan' | 'observeStatus'>
  /** The activity of every session, read on each `sessionsChanged`. */
  activities(): readonly { sessionId: string; activity: SessionActivity | null }[]
  candidates(): readonly SessionUncommittedCandidate[]
  /** The snapshot moved: its revision is new. */
  changed(): void
  log(line: string): void
  /** `stat` alone; replaced in tests. */
  stamps?: Pick<typeof SvnWcStamp, 'rootOf' | 'of'>
}

interface ScanRequest {
  reason: SessionUncommittedScanReason
  /** Absent for every working copy. */
  roots?: readonly string[]
}

/**
 * When the uncommitted mark is computed again (D11), on the orchestrator main thread, which only
 * calls `stat` here; the worker does the reading. Nothing runs while no window is visible, and the
 * first visible frame starts one full scan. Every scan is single-flight with one trailing request.
 * The snapshot's revision moves only when an entry changed (D12); a failed scan keeps the last
 * snapshot and logs one line per root and error text (D16).
 */
export class SessionUncommittedOperations {
  static readonly stampMillisecondsConst = 5_000
  static readonly transcriptsMillisecondsConst = 30_000
  static readonly idleMillisecondsConst = 2_000
  /** Directory to its working-copy root; cleared whole when it grows past this. */
  private static readonly rootsMaxConst = 4_096

  private readonly deps: SessionUncommittedOperationsDeps
  private readonly stamps: Pick<typeof SvnWcStamp, 'rootOf' | 'of'>
  private readonly activity = new Map<string, SessionActivity | null>()
  private readonly roots = new Map<string, string | null>()
  /** Comparable root to its last stamp. */
  private readonly lastStamps = new Map<string, string>()
  private readonly logged = new Set<string>()
  private value: SessionUncommittedSnapshot = { revision: 0, sessions: {} }
  private visible = false
  private stopped = false
  private stampTimer: ReturnType<typeof setInterval> | null = null
  private transcriptsTimer: ReturnType<typeof setInterval> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private stamping = false
  private running = false
  private trailing: ScanRequest | null = null

  constructor(deps: SessionUncommittedOperationsDeps) {
    this.deps = deps
    this.stamps = deps.stamps ?? SvnWcStamp
  }

  snapshot(): SessionUncommittedSnapshot {
    return this.value
  }

  setVisible(visible: boolean): void {
    if (this.stopped || visible === this.visible) return
    this.visible = visible
    if (!visible) {
      this.stopTimers()
      return
    }
    this.stampTimer = setInterval(() => void this.stampTick(), SessionUncommittedOperations.stampMillisecondsConst)
    this.transcriptsTimer = setInterval(() => this.request({ reason: 'tick' }), SessionUncommittedOperations.transcriptsMillisecondsConst)
    this.request({ reason: 'visible' })
  }

  /** `SessionManager.onChanged`: a session that stopped working is read once its transcript settled. */
  sessionsChanged(): void {
    const seen = new Set<string>()
    let settled = false
    for (const { sessionId, activity } of this.deps.activities()) {
      seen.add(sessionId)
      const before = this.activity.get(sessionId)
      this.activity.set(sessionId, activity)
      if (before === 'working' && (activity === 'idle' || activity === 'waiting')) settled = true
    }
    for (const sessionId of [...this.activity.keys()])
      if (!seen.has(sessionId)) this.activity.delete(sessionId)
    if (!settled || !this.visible) return
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.request({ reason: 'idle' })
    }, SessionUncommittedOperations.idleMillisecondsConst)
  }

  /** `VersioningCommitManagerDeps.committed`: the working copies of the committed scopes. */
  committed(receipt: SessionCommitReceipt): void {
    if (receipt.paths.length === 0 || !this.visible) return
    void this.rootsOf(receipt.scopes.map((scope) => scope.scopeRoot)).then((roots) => {
      if (roots.length > 0) this.request({ reason: 'commit', roots })
    })
  }

  /** A status File Changes read anyway (D6): handed to the worker, then that root is decided again. */
  observeStatus(root: string, entries: readonly SessionUncommittedStatusEntry[]): void {
    if (this.stopped) return
    this.deps.worker.observeStatus(root, entries.map(({ absolutePath, nodeKind }) => ({ absolutePath, nodeKind })))
      .then(() => this.request({ reason: 'status', roots: [root] }),
        (error: unknown) => this.logOnce(`status of ${root}`, ErrorText.of(error)))
  }

  /** For the quit: no timer, no request after it. The worker is stopped by its own step. */
  stop(): void {
    this.stopped = true
    this.visible = false
    this.stopTimers()
    this.trailing = null
  }

  private stopTimers(): void {
    if (this.stampTimer !== null) clearInterval(this.stampTimer)
    if (this.transcriptsTimer !== null) clearInterval(this.transcriptsTimer)
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.stampTimer = null
    this.transcriptsTimer = null
    this.idleTimer = null
  }

  /** One `stat` of each known root's `wc.db` pair; a root whose stamp moved is decided again. */
  private async stampTick(): Promise<void> {
    if (this.stamping) return
    this.stamping = true
    try {
      const roots = await this.rootsOf(this.deps.candidates().map((candidate) => candidate.cwd))
      const changed: string[] = []
      const known = new Set<string>()
      for (const root of roots) {
        const key = PathCompare.comparable(root)
        known.add(key)
        let stamp: string
        try { stamp = await this.stamps.of([root]) }
        catch (error) {
          this.logOnce(`stamp of ${root}`, ErrorText.of(error))
          continue
        }
        const before = this.lastStamps.get(key)
        this.lastStamps.set(key, stamp)
        if (before !== undefined && before !== stamp) changed.push(root)
      }
      for (const key of [...this.lastStamps.keys()])
        if (!known.has(key)) this.lastStamps.delete(key)
      if (changed.length > 0) this.request({ reason: 'stamp', roots: changed })
    }
    // A timer callback: a throw here would be an unhandled rejection every 5 s.
    catch (error) { this.logOnce('the working-copy stamps', ErrorText.of(error)) }
    finally { this.stamping = false }
  }

  private request(request: ScanRequest): void {
    if (!this.visible) return
    if (this.running) {
      this.trailing = this.trailing === null ? request : SessionUncommittedOperations.merged(this.trailing, request)
      return
    }
    void this.run(request)
  }

  private async run(request: ScanRequest): Promise<void> {
    this.running = true
    try {
      const candidates = this.deps.candidates()
      const sessions = candidates.length === 0 ? {} : await this.deps.worker.scan(candidates, request.reason, request.roots)
      this.logged.clear()
      this.apply(sessions)
    }
    catch (error) { this.logOnce(request.roots === undefined ? 'every working copy' : request.roots.join(', '), ErrorText.of(error)) }
    finally {
      this.running = false
      const next = this.trailing
      this.trailing = null
      if (next !== null) this.request(next)
    }
  }

  private apply(sessions: Record<string, SessionUncommittedEntry>): void {
    if (SessionUncommittedOperations.same(this.value.sessions, sessions)) return
    this.value = { revision: this.value.revision + 1, sessions }
    this.deps.changed()
  }

  private logOnce(subject: string, detail: string): void {
    const key = `${subject}\n${detail}`
    if (this.logged.has(key)) return
    this.logged.add(key)
    this.deps.log(`The uncommitted mark of ${subject} could not be computed: ${detail}`)
  }

  private async rootsOf(directories: readonly string[]): Promise<string[]> {
    const roots = new Map<string, string>()
    for (const directory of directories) {
      const key = PathCompare.comparable(directory)
      let root = this.roots.get(key)
      if (root === undefined) {
        try { root = await this.stamps.rootOf(directory) }
        catch { root = null }
        if (this.roots.size >= SessionUncommittedOperations.rootsMaxConst) this.roots.clear()
        this.roots.set(key, root)
      }
      if (root !== null) roots.set(PathCompare.comparable(root), root)
    }
    return [...roots.values()]
  }

  private static merged(left: ScanRequest, right: ScanRequest): ScanRequest {
    if (left.roots === undefined || right.roots === undefined) return { reason: left.roots === undefined ? left.reason : right.reason }
    const roots = new Map([...left.roots, ...right.roots].map((root) => [PathCompare.comparable(root), root]))
    return { reason: right.reason, roots: [...roots.values()] }
  }

  private static same(left: Readonly<Record<string, SessionUncommittedEntry>>, right: Readonly<Record<string, SessionUncommittedEntry>>): boolean {
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every((key) => {
      const other = right[key]
      const entry = left[key]!
      return other !== undefined && other.files === entry.files && other.sample.length === entry.sample.length
        && other.sample.every((path, index) => path === entry.sample[index])
    })
  }
}
