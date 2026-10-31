import type { AttentionKind, AttentionSnapshot } from '../../shared/attention'
import { ErrorText } from '../../shared/errorText'

/** One thing that wants the person, as its source hands it in. */
export interface AttentionEntry {
  key: string
  kind: AttentionKind
  sessionId: string
  title: string
  /** Comes forward by itself once the person stops typing; otherwise only a click brings it. */
  automatic: boolean
  /**
   * The person stays with it until `wanted` turns false: nothing else comes forward meanwhile, and
   * its end moves straight on to the next automatic item, or back to where the person was.
   */
  holds: boolean
  wanted(): boolean
  /** Brings it in front: the panel that shows it, or null when it could not be shown. */
  show(): Promise<string | null>
}

export interface AttentionQueuePorts {
  /** The focused workspace and its active panel; null while no workspace window has the focus. */
  front(): { panelId: string | null } | null
  /** The active panel of the last focused workspace, also while another application is in front. */
  lastActivePanel(): string | null
  focus(panelId: string): Promise<void>
  /** How long the person must not type before an automatic item comes forward. */
  idleMilliseconds(): number
  returnEnabled(): boolean
  /** How long a return stays valid after the first item came forward, or null for no limit. */
  returnWindowMilliseconds(): number | null
  onChanged(): void
  report(message: string): void
  now?(): number
}

interface ShownEntry {
  entry: AttentionEntry
  panelId: string
}

/**
 * The one queue of what wants the person, and the one place that decides when it takes the screen.
 *
 * An item never comes forward while the person types: an agent's request that lands in the middle
 * of a sentence used to take the focus with it, and the rest of the sentence went into the review.
 * It waits until the person has typed nothing for `idleMilliseconds`, or until they click the
 * status bar. Another application in front holds it too, and the focus coming back counts as input.
 *
 * A holding item (a review, a waiting Finish) keeps the queue while the person is in its panel. Its
 * end goes straight on to the next automatic item, because the person is already working through
 * them, and after the last one back to the panel that was in front before the first. Leaving a
 * holding item unfinished releases the queue; the item stays open where it is.
 *
 * The state lives as long as AppClientUI does: a restart starts with an empty queue.
 */
export class AttentionQueue {
  private readonly ports: AttentionQueuePorts
  private waiting: AttentionEntry[] = []
  private current: ShownEntry | null = null
  /** Where the end of the running sequence returns to, and when its first item came forward. */
  private origin: { panelId: string; at: number } | null = null
  private lastInputAt = Number.NEGATIVE_INFINITY
  private lastShownAt = Number.NEGATIVE_INFINITY
  private timer: ReturnType<typeof setTimeout> | null = null
  private turn: Promise<void> = Promise.resolve()
  private settleQueued = false
  private stopped = false
  private published = '[]'
  private revision = 0

  constructor(ports: AttentionQueuePorts) {
    this.ports = ports
  }

  add(entry: AttentionEntry): void {
    if (this.stopped) return
    // Opened again while it waits, or while the person is still with it: neither a duplicate nor a
    // second activation. It is still news that the person may have left the one in front.
    const held = this.current?.entry.key === entry.key && this.ports.lastActivePanel() === this.current.panelId
    if (!held && !this.waiting.some((waiting) => waiting.key === entry.key)) {
      this.waiting.push(entry)
      this.publish()
    }
    this.changed()
  }

  /** Something a source holds changed: an item may be done, or the person may have moved. */
  changed(): void {
    if (this.settleQueued || this.stopped) return
    this.settleQueued = true
    void this.inTurn(async () => {
      this.settleQueued = false
      await this.settle()
    })
  }

  /** A key in a workspace window, or a workspace window taking the focus. */
  personActive(): void {
    this.lastInputAt = this.now()
    if (this.waiting.some((entry) => entry.automatic)) this.arm(this.ports.idleMilliseconds())
  }

  /** The status bar click: the first waiting item comes forward now, typing or not. */
  next(): Promise<void> {
    return this.inTurn(async () => {
      this.prune()
      const entry = this.ordered()[0]
      if (entry === undefined) return
      // The person chose where to go, so nothing they were in holds the queue or is returned to.
      this.current = null
      this.origin = null
      await this.show(entry)
    })
  }

  snapshot(): AttentionSnapshot {
    return { revision: this.revision, items: this.items() }
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.waiting = []
    this.current = null
    this.origin = null
    this.publish()
  }

  private async settle(): Promise<void> {
    if (this.stopped) return
    this.prune()
    const current = this.current
    if (current !== null) {
      if (this.wanted(current.entry)) {
        if (this.ports.lastActivePanel() === current.panelId) { this.publish(); return }
        this.current = null
        this.origin = null
      } else {
        this.current = null
        // Finishing in the item's own panel is working through the queue; anywhere else is not.
        if (this.ports.front()?.panelId === current.panelId) { await this.advance(); return }
        this.origin = null
      }
    }
    await this.whenIdle()
    this.publish()
  }

  private async advance(): Promise<void> {
    const next = this.waiting.find((entry) => entry.automatic)
    if (next !== undefined) { await this.show(next); return }
    const origin = this.origin
    this.origin = null
    this.publish()
    if (origin === null || !this.ports.returnEnabled()) return
    const window = this.ports.returnWindowMilliseconds()
    if (window !== null && this.now() - origin.at > window) return
    await this.ports.focus(origin.panelId)
  }

  private async whenIdle(): Promise<void> {
    const next = this.waiting.find((entry) => entry.automatic)
    if (next === undefined) return
    const front = this.ports.front()
    if (front === null) return
    const remaining = Math.max(this.lastInputAt, this.lastShownAt) + this.ports.idleMilliseconds() - this.now()
    if (remaining > 0) { this.arm(remaining); return }
    this.origin = next.holds && front.panelId !== null ? { panelId: front.panelId, at: this.now() } : null
    await this.show(next)
  }

  private async show(entry: AttentionEntry): Promise<void> {
    this.waiting = this.waiting.filter((waiting) => waiting.key !== entry.key)
    let panelId: string | null
    try { panelId = await entry.show() }
    catch (error) {
      this.ports.report(`${entry.title} could not be brought forward: ${ErrorText.of(error)}`)
      panelId = null
    }
    this.lastShownAt = this.now()
    // An unconfirmed show stops the sequence rather than moving on to the item after it.
    if (panelId === null || !entry.holds) {
      this.current = null
      this.origin = null
    } else {
      this.current = { entry, panelId }
      if (this.origin?.panelId === panelId) this.origin = null
    }
    this.publish()
    if (this.current === null && this.waiting.some((waiting) => waiting.automatic)) this.arm(this.ports.idleMilliseconds())
  }

  private prune(): void {
    const before = this.waiting.length
    this.waiting = this.waiting.filter((entry) => this.wanted(entry))
    if (this.waiting.length !== before) this.publish()
  }

  private wanted(entry: AttentionEntry): boolean {
    try { return entry.wanted() }
    catch (error) {
      this.ports.report(`${entry.title} could not be read for the attention queue: ${ErrorText.of(error)}`)
      return false
    }
  }

  private ordered(): AttentionEntry[] {
    return [...this.waiting.filter((entry) => entry.automatic), ...this.waiting.filter((entry) => !entry.automatic)]
  }

  /** Never late: a timer already set fires no later than this one would, and measures again. */
  private arm(delay: number): void {
    if (this.timer !== null || this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.changed()
    }, Math.max(0, delay))
  }

  private items(): AttentionSnapshot['items'] {
    return this.ordered().map((entry) => ({ key: entry.key, kind: entry.kind, sessionId: entry.sessionId,
      title: entry.title, automatic: entry.automatic }))
  }

  private publish(): void {
    const text = JSON.stringify(this.items())
    if (text === this.published) return
    this.published = text
    this.revision += 1
    this.ports.onChanged()
  }

  private inTurn(operation: () => Promise<void>): Promise<void> {
    const next = this.turn.then(operation).catch((error: unknown) => {
      this.ports.report(`The attention queue failed: ${ErrorText.of(error)}`)
    })
    this.turn = next
    return next
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now()
  }
}
