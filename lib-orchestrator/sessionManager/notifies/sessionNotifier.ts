import { ErrorText } from '../../shared/errorText'
import type { SessionInfo } from '../sessionManagerApi.types'

/**
 * Types one line into a session. `delivered`: the agent took it (a proven submit, or its transcript
 * already holds the line as a user turn written since `since`). `typed`: the text reached the agent,
 * but nothing proves it took it. `retry`: not now (a draft, a dialog, a session that does not run).
 * `gone`: the session no longer exists.
 */
export interface SessionNotifyPort {
  deliver(sessionId: string, text: string, since: number): Promise<'delivered' | 'typed' | 'retry' | 'gone'>
  /** Whether the agent's transcript holds the line as a user turn written since `since`. */
  taken(sessionId: string, text: string, since: number): Promise<boolean>
  /** Holds the session's idle gate for a typed line not yet taken, or releases it. */
  holding(sessionId: string, held: boolean): void
}

/** A line typed without proof that the agent took it: already delivered on record, still held at the gate. */
interface TypedLine {
  sessionId: string
  text: string
  since: number
  typedAt: number
}

export interface PendingNotify {
  id: string
  sessionId: string
  text: string
  at: number
  attempts: number
}

export interface NotifySource {
  pending(): PendingNotify[]
  note(ids: readonly string[], state: 'delivered' | 'attempted' | 'expired', at: number): Promise<void>
}

export interface NotifyObservation {
  life: 'live' | 'gone'
  group: string | null
}

export interface SessionNotifierDeps {
  sources: readonly NotifySource[]
  watch: {
    watched(): readonly { sessionId: string }[]
    observe(sessionId: string, seen: NotifyObservation, at: number): Promise<unknown>
  }
  sessions: () => readonly SessionInfo[]
  groups: (sessions: readonly SessionInfo[]) => ReadonlyMap<string, string | null>
  port: SessionNotifyPort
  now: () => number
  report: (message: string) => void
}

interface SourcedNotify {
  source: NotifySource
  item: PendingNotify
}

interface NotifyGroup {
  sessionId: string
  text: string
  items: SourcedNotify[]
  due: boolean
}

/**
 * A pending wake-up line whose caller named a session gets its text typed
 * there once, through the deliver rules: only into an empty composer, never over a draft or a
 * dialog. A refusal is tried again at 1, 5, 15 and 30 minutes after the result, then every 30
 * minutes, and after 24 hours the line expires. Results with the same target and text share one
 * delivery across sources. A failed line never touches the action it reports.
 */
export class SessionNotifier {
  static readonly giveUpMillisecondsConst = 86_400_000
  /** Since the result: the first try at once, then the retries. */
  static readonly paceMillisecondsConst: readonly number[] = [0, 60_000, 300_000, 900_000, 1_800_000]
  static readonly repeatMillisecondsConst = 1_800_000
  private static readonly tickMillisecondsConst = 10_000
  /**
   * How long a typed line holds the idle gate while its turn does not show: twice the 83 s a Mirabia
   * 133 handoff took from typing to its turn.
   */
  static readonly holdMillisecondsConst = 180_000
  private readonly sources: SessionNotifierDeps['sources']
  private readonly watch: SessionNotifierDeps['watch']
  private readonly sessions: SessionNotifierDeps['sessions']
  private readonly readGroups: SessionNotifierDeps['groups']
  private readonly port: SessionNotifyPort
  private readonly now: () => number
  private readonly report: (message: string) => void
  private timer: ReturnType<typeof setTimeout> | null
  private running: Promise<void> | null
  private started: boolean
  /**
   * Lines typed without proof that the agent took them. Each is delivered on record at once, so it is
   * never typed twice, also across a restart, and holds the session's idle gate until its turn shows
   * or the hold ends. A restart drops the hold: the line then counts as delivered a little early.
   */
  private readonly typed: TypedLine[]

  constructor(deps: SessionNotifierDeps) {
    this.sources = deps.sources
    this.watch = deps.watch
    this.sessions = deps.sessions
    this.readGroups = deps.groups
    this.port = deps.port
    this.now = deps.now
    this.report = deps.report
    this.timer = null
    this.running = null
    this.started = false
    this.typed = []
  }

  /** Owns its timer; started and stopped by the client. */
  start(): void {
    if (this.started) return
    this.started = true
    this.arm()
  }

  stop(): void {
    this.started = false
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    for (const line of this.typed.splice(0)) this.port.holding(line.sessionId, false)
  }

  /** One pass; a pass still in flight is joined, so a line is never typed twice at once. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => { this.running = null })
    return this.running
  }

  /** When the try after `attempts` refused tries is due, counted from the result. */
  static offsetOf(attempts: number): number {
    const pace = SessionNotifier.paceMillisecondsConst
    if (attempts < pace.length) return pace[attempts]
    return pace[pace.length - 1] + (attempts - pace.length + 1) * SessionNotifier.repeatMillisecondsConst
  }

  private async pass(): Promise<void> {
    const now = this.now()
    const sessions = this.sessions()
    const groups = this.readGroups(sessions)
    const byId = new Map(sessions.map((session) => [session.sessionId, session]))
    for (const record of this.watch.watched())
      await this.watch.observe(record.sessionId, {
        life: SessionNotifier.lifeOf(byId.get(record.sessionId)), group: groups.get(record.sessionId) ?? null,
      }, now)
    const pending = this.sources.flatMap((source) => source.pending().map((item) => ({ source, item })))
    const old = pending.filter(({ item }) => now - item.at > SessionNotifier.giveUpMillisecondsConst)
    await SessionNotifier.note(old, 'expired', now)
    for (const group of SessionNotifier.groups(pending.filter((record) => !old.includes(record)), now)) {
      if (!group.due) continue
      const since = Math.min(...group.items.map(({ item }) => item.at))
      let answer: 'delivered' | 'typed' | 'retry' | 'gone'
      try {
        answer = await this.port.deliver(group.sessionId, group.text, since)
      } catch (error) {
        this.report(`The wake-up line could not be typed into session ${group.sessionId}: ${ErrorText.of(error)}`)
        answer = 'retry'
      }
      const at = this.now()
      if (answer === 'delivered') await SessionNotifier.note(group.items, 'delivered', at)
      else if (answer === 'typed') {
        await SessionNotifier.note(group.items, 'delivered', at)
        this.typed.push({ sessionId: group.sessionId, text: group.text, since, typedAt: at })
        this.port.holding(group.sessionId, true)
      } else if (answer === 'retry') await SessionNotifier.note(group.items, 'attempted', at)
      else if (answer === 'gone') await SessionNotifier.note(group.items, 'expired', at)
      else throw new Error(`Unknown notify answer: ${JSON.stringify(answer satisfies never)}`)
    }
    await this.release()
  }

  /**
   * A typed line holds the idle gate until the agent's transcript shows its turn, at most the hold:
   * in Mirabia 133 (2026-11-01) a conflict handoff marked delivered on typing sat 83 s before its turn
   * while Jamat counted the worker idle. It is never typed again: a lost submit costs the hold, not a
   * second line in a working agent.
   */
  private async release(): Promise<void> {
    for (const line of [...this.typed]) {
      let taken = false
      try {
        taken = await this.port.taken(line.sessionId, line.text, line.since)
      } catch (error) {
        this.report(`The wake-up line typed into session ${line.sessionId} could not be checked: ${ErrorText.of(error)}`)
      }
      if (!taken && this.now() - line.typedAt < SessionNotifier.holdMillisecondsConst) continue
      this.typed.splice(this.typed.indexOf(line), 1)
      this.port.holding(line.sessionId, false)
    }
  }

  private static lifeOf(session: SessionInfo | undefined): NotifyObservation['life'] {
    if (session === undefined) return 'gone'
    const life = session.life
    if (life === 'ended' || life === 'lost') return 'gone'
    else if (life === 'starting' || life === 'live') return 'live'
    else throw new Error(`Unknown session life: ${JSON.stringify(life satisfies never)}`)
  }

  private static async note(records: readonly SourcedNotify[], state: 'delivered' | 'attempted' | 'expired', at: number): Promise<void> {
    const ids = new Map<NotifySource, string[]>()
    for (const { source, item } of records) {
      const selected = ids.get(source) ?? []
      selected.push(item.id)
      ids.set(source, selected)
    }
    for (const [source, selected] of ids)
      await source.note(selected, state, at)
  }

  private static groups(records: readonly SourcedNotify[], now: number): NotifyGroup[] {
    const groups = new Map<string, NotifyGroup>()
    for (const record of records) {
      const notify = record.item
      const key = `${notify.sessionId}\n${notify.text}`
      const group = groups.get(key) ?? { sessionId: notify.sessionId, text: notify.text, items: [], due: false }
      group.items.push(record)
      group.due ||= now >= notify.at + SessionNotifier.offsetOf(notify.attempts)
      groups.set(key, group)
    }
    return [...groups.values()]
  }

  private arm(): void {
    if (!this.started) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.tick()
        .catch((error: unknown) => this.report(`The wake-up lines stopped a pass: ${ErrorText.of(error)}`))
        .finally(() => this.arm())
    }, SessionNotifier.tickMillisecondsConst)
    this.timer.unref()
  }
}
