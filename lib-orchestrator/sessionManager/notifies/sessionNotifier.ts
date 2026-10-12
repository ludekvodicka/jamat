import { ErrorText } from '../../shared/errorText'
import type { SessionInfo } from '../sessionManagerApi.types'

/**
 * Types one line into a session. `delivered`: the text reached its composer. `retry`: not now (a
 * draft, a dialog, a session that does not run). `gone`: the session no longer exists.
 */
export interface SessionNotifyPort {
  deliver(sessionId: string, text: string): Promise<'delivered' | 'retry' | 'gone'>
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
      let answer: 'delivered' | 'retry' | 'gone'
      try {
        answer = await this.port.deliver(group.sessionId, group.text)
      } catch (error) {
        this.report(`The wake-up line could not be typed into session ${group.sessionId}: ${ErrorText.of(error)}`)
        answer = 'retry'
      }
      const at = this.now()
      if (answer === 'delivered') await SessionNotifier.note(group.items, 'delivered', at)
      else if (answer === 'retry') await SessionNotifier.note(group.items, 'attempted', at)
      else if (answer === 'gone') await SessionNotifier.note(group.items, 'expired', at)
      else throw new Error(`Unknown notify answer: ${JSON.stringify(answer satisfies never)}`)
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
