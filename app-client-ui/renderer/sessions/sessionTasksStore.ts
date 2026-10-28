import type {
  RemoteControlError,
  RemoteControlStepResult,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { SessionInfo, SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionTaskListing } from '../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { ErrorText } from '../../shared/errorText'
import type { SnapshotStore } from '../ipc/snapshotStore'

export interface SessionTasksPorts {
  canRead?(info: SessionInfo): boolean
  list(sessionIds: readonly string[]): Promise<IpcResult<RemoteControlStepResult<Record<string, SessionTaskListing>>>>
  reportError(message: string): void
}

export type SessionTasksSessions = Pick<SnapshotStore<SessionsSnapshot>, 'current' | 'subscribe'>

interface SessionTasksHeld {
  listing: SessionTaskListing | null
  print: string | null
  askedAt: number
  /** `life:endedAt` of an ended or lost session when it was asked, null while it was live. */
  endedKey: string | null
}

type SessionTasksAnswer =
  | { kind: 'listings'; value: Record<string, SessionTaskListing> }
  | { kind: 'failed' }
  | { kind: 'unavailable' }

/**
 * The poll behind the task rows. It holds readings only: what a row means is
 * the library's listing, and the tree draws it.
 *
 * Sessions drawn by the tree are asked, each on its own clock: every 3 s while the session
 * works or a task of it runs, every 15 s while it is live and idle, once after it ended and again
 * only when its end moves. A shell session and an agent without a native id are never asked, and
 * nothing is asked while the window is out of sight. One call is out at a time and carries at most
 * 64 sessions. What was held for a session stays while the snapshot names it, so a session drawn
 * again is not asked again before its time; what the snapshot no longer names is dropped.
 *
 * A controller that does not know the operation is not asked again for the life of this renderer:
 * an older main process under a newer renderer is a state no retry changes.
 */
export class SessionTasksStore {
  static readonly fastMillisecondsConst = 3_000
  static readonly slowMillisecondsConst = 15_000
  /** The shortest wait between two asks, so a stream of snapshot changes cannot drive a busy loop. */
  static readonly minimumDelayMillisecondsConst = 1_000
  static readonly sessionIdsPerCallConst = 64

  private readonly sessions: SessionTasksSessions
  private readonly ports: SessionTasksPorts
  private readonly now: () => number
  private readonly held = new Map<string, SessionTasksHeld>()
  private readonly subscribers = new Set<() => void>()
  private listings: ReadonlyMap<string, SessionTaskListing> = new Map()
  private drawn: ReadonlySet<string> = new Set()
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerAt = 0
  private generation = 0
  private reading = false
  private stopped = true
  private visible = true
  private unavailable = false
  /** When the last call failed: the next one waits the slow interval instead of retrying each second. */
  private failedAt: number | null = null
  private unsubscribeSessions: (() => void) | null = null

  constructor(sessions: SessionTasksSessions, ports: SessionTasksPorts, now: () => number = () => Date.now()) {
    this.sessions = sessions
    this.ports = ports
    this.now = now
  }

  /** Arms the poll and hands back the one function that disarms it. A second start shares the first. */
  start(): () => void {
    if (!this.stopped)
      return () => this.stop()
    this.stopped = false
    this.unsubscribeSessions = this.sessions.subscribe(() => this.sessionsChanged())
    void this.tick()
    return () => this.stop()
  }

  /** A window coming back asks at once what is due, rather than after a whole interval. */
  setWindowVisible(visible: boolean): void {
    if (this.visible === visible)
      return
    this.visible = visible
    if (!visible) {
      this.clearTimer()
      return
    }
    void this.tick()
  }

  setDrawn(sessionIds: ReadonlySet<string>): void {
    if (sessionIds.size === this.drawn.size && [...sessionIds].every((sessionId) => this.drawn.has(sessionId)))
      return
    this.drawn = new Set(sessionIds)
    if (!this.reading)
      this.arm()
  }

  subscribe(onChanged: () => void): () => void {
    this.subscribers.add(onChanged)
    return () => {
      this.subscribers.delete(onChanged)
    }
  }

  /** Held rather than built per call: `useSyncExternalStore` reads this on every render. */
  current(): ReadonlyMap<string, SessionTaskListing> {
    return this.listings
  }

  invalidate(): void {
    this.generation++
    this.held.clear()
    this.failedAt = null
    this.unavailable = false
    this.publish()
    if (!this.reading) this.arm()
  }

  private stop(): void {
    this.stopped = true
    this.clearTimer()
    this.unsubscribeSessions?.()
    this.unsubscribeSessions = null
  }

  private sessionsChanged(): void {
    const present = new Set(this.agentSessions().map((info) => info.sessionId))
    let dropped = false
    for (const sessionId of [...this.held.keys()])
      if (!present.has(sessionId)) {
        this.held.delete(sessionId)
        dropped = true
      }
    if (dropped)
      this.publish()
    if (!this.reading)
      this.arm()
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.reading || !this.visible || this.unavailable)
      return
    this.clearTimer()
    const now = this.now()
    const due = this.drawnSessions()
      .filter((info) => (this.dueAt(info) ?? Infinity) <= now)
      .slice(0, SessionTasksStore.sessionIdsPerCallConst)
    if (due.length > 0) {
      this.reading = true
      const generation = this.generation
      const answer = await this.listOf(due.map((info) => info.sessionId))
      this.reading = false
      if (this.stopped) return
      if (generation !== this.generation) { this.arm(); return }
      switch (answer.kind) {
        case 'listings':
          this.failedAt = null
          this.accept(due, answer.value, now)
          break
        case 'failed':
          this.failedAt = now
          break
        case 'unavailable':
          this.unavailable = true
          this.clearTimer()
          return
        default: throw new Error(`Unknown session tasks answer: ${JSON.stringify(answer satisfies never)}`)
      }
    }
    this.arm()
  }

  private async listOf(sessionIds: readonly string[]): Promise<SessionTasksAnswer> {
    try {
      const answer = await this.ports.list(sessionIds)
      if (!answer.ok) {
        this.ports.reportError(`Reading sub-agents: ${answer.error}`)
        return { kind: 'failed' }
      }
      if (answer.value.ok)
        return { kind: 'listings', value: answer.value.value }
      if (SessionTasksStore.unknownOperation(answer.value.error))
        return { kind: 'unavailable' }
      this.ports.reportError(`Reading sub-agents: ${answer.value.error.code}: ${answer.value.error.detail}`)
      return { kind: 'failed' }
    } catch (thrown) {
      this.ports.reportError(`Reading sub-agents: ${ErrorText.of(thrown)}`)
      return { kind: 'failed' }
    }
  }

  /**
   * The registry refuses an operation it has no registration for before it reaches any operation:
   * `invalid-request` with `Unknown operation: ...` from the envelope check, or `not-found` where a
   * caller resolves the name first. `sessionTasks.list` itself answers neither.
   */
  private static unknownOperation(error: RemoteControlError): boolean {
    return error.code === 'not-found'
      || (error.code === 'invalid-request' && error.detail.startsWith('Unknown operation:'))
  }

  private accept(asked: readonly SessionInfo[], answer: Record<string, SessionTaskListing>, now: number): void {
    let changed = false
    for (const info of asked) {
      const before = this.held.get(info.sessionId)
      const listing: SessionTaskListing | null = answer[info.sessionId] ?? null
      const print = listing === null ? null : JSON.stringify(listing)
      const same = before !== undefined && before.print === print
      if (!same)
        changed = true
      this.held.set(info.sessionId, {
        listing: same ? before.listing : listing,
        print,
        askedAt: now,
        endedKey: SessionTasksStore.endedKeyOf(info),
      })
    }
    if (changed)
      this.publish()
  }

  /** When this session is next due, or null when it is never asked again. */
  private dueAt(info: SessionInfo): number | null {
    if (!this.canRead(info))
      return null
    const held = this.held.get(info.sessionId)
    const endedKey = SessionTasksStore.endedKeyOf(info)
    // An ended session's transcript scan may need more than one read to reach the end.
    if (endedKey !== null && held !== undefined && held.endedKey === endedKey && SessionTasksStore.catchingUp(held))
      return held.askedAt + SessionTasksStore.fastMillisecondsConst
    if (endedKey !== null)
      return held !== undefined && held.endedKey === endedKey ? null : 0
    if (held === undefined)
      return 0
    return held.askedAt + (SessionTasksStore.fast(info, held)
      ? SessionTasksStore.fastMillisecondsConst
      : SessionTasksStore.slowMillisecondsConst)
  }

  private static fast(info: SessionInfo, held: SessionTasksHeld): boolean {
    if (info.activity === 'working')
      return true
    const listing = held.listing
    if (listing === null || listing.kind === 'none')
      return false
    else if (listing.kind === 'tasks')
      return listing.catchingUp || listing.rows.some((row) => row.state === 'running')
    else
      throw new Error(`Unknown session task listing: ${JSON.stringify(listing satisfies never)}`)
  }

  private static catchingUp(held: SessionTasksHeld): boolean {
    return held.listing !== null && held.listing.kind === 'tasks' && held.listing.catchingUp
  }

  private static endedKeyOf(info: SessionInfo): string | null {
    switch (info.life) {
      case 'starting':
      case 'live': return null
      case 'ended':
      case 'lost': return `${info.life}:${info.endedAt ?? ''}`
      default: throw new Error(`Unknown session life: ${JSON.stringify(info.life satisfies never)}`)
    }
  }

  private agentSessions(): readonly SessionInfo[] {
    return this.sessions.current().snapshot?.sessions.filter((info) => this.ports.canRead ? this.ports.canRead(info) : info.kind === 'agent') ?? []
  }

  private canRead(info: SessionInfo): boolean {
    return this.ports.canRead ? this.ports.canRead(info) : info.kind === 'agent' && info.agent?.nativeSessionId !== undefined
  }

  private drawnSessions(): readonly SessionInfo[] {
    return this.agentSessions().filter((info) => this.drawn.has(info.sessionId))
  }

  private arm(): void {
    if (this.stopped || !this.visible || this.unavailable)
      return
    let next = Infinity
    for (const info of this.drawnSessions()) {
      const due = this.dueAt(info)
      if (due !== null && due < next)
        next = due
    }
    if (next === Infinity) {
      this.clearTimer()
      return
    }
    const now = this.now()
    if (this.failedAt !== null)
      next = Math.max(next, this.failedAt + SessionTasksStore.slowMillisecondsConst)
    const at = Math.max(next, now + SessionTasksStore.minimumDelayMillisecondsConst)
    // A timer that fires sooner is kept: re-arming it on every snapshot change would push an ask
    // that is already due further away each time.
    if (this.timer !== null && this.timerAt <= at)
      return
    this.clearTimer()
    this.timerAt = at
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, at - now)
  }

  private publish(): void {
    const next = new Map<string, SessionTaskListing>()
    for (const [sessionId, held] of this.held)
      if (held.listing !== null)
        next.set(sessionId, held.listing)
    this.listings = next
    for (const subscriber of this.subscribers)
      subscriber()
  }

  private clearTimer(): void {
    if (this.timer !== null)
      clearTimeout(this.timer)
    this.timer = null
  }
}
