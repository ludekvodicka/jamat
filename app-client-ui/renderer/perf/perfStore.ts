import type { IpcResult } from '../../shared/appClientUiIpc'
import type { PerfReading, PerfSample } from '../../shared/perfSample'

export interface PerfStorePorts {
  sample(): Promise<IpcResult<PerfSample>>
  reportError(message: string): void
  /**
   * The clock and the document's own state, injected because the two things worth proving about
   * this store are what it does when a tick runs late and what it does when nobody is looking, and
   * neither can be staged through a fake timer: a faked interval fires exactly on schedule.
   */
  now?(): number
  hidden?(): boolean
}

/**
 * How fast this window is answering, sampled by the window itself.
 *
 * Two of the numbers can only be taken here. The renderer's own event loop is measured by how late
 * a short timer actually runs - there is no `monitorEventLoopDelay` in a browser context - and the
 * round trip to the main process is the wall time around the sampling call, which is the queue a
 * keystroke joins on its way out.
 *
 * It holds a timer and a value, so it is a store rather than something the bar reads when it draws:
 * the reading must survive the widget being redrawn, and a widget that sampled while rendering
 * would measure its own render.
 */
export class PerfStore {
  /** Often enough to catch a block, cheap enough to leave running: one timer, no work. */
  private static readonly lagProbeMsConst = 50
  private static readonly sampleMsConst = 1_000

  private reading: PerfReading | null = null
  private readonly subscribers = new Set<() => void>()
  private lagProbe: ReturnType<typeof setInterval> | null = null
  private sampler: ReturnType<typeof setInterval> | null = null
  private lagMax = 0
  private lastProbeAt = 0
  /** When the call in flight went out, or null. Also the overlap guard: one call at a time. */
  private samplingSince: number | null = null
  /** The document was hidden at the last probe, so the next one measures Chromium and not this UI. */
  private throttled = false
  /** A failure is said once per run of them, not once a second into a console nobody is reading. */
  private reportedFailure = false

  private readonly now: () => number
  private readonly hidden: () => boolean

  constructor(private readonly ports: PerfStorePorts) {
    this.now = ports.now ?? (() => performance.now())
    this.hidden = ports.hidden ?? (() => document.visibilityState === 'hidden')
  }

  start(): () => void {
    if (this.lagProbe !== null) throw new Error('The performance store is already started')
    this.lastProbeAt = this.now()
    this.lagProbe = setInterval(() => this.probe(), PerfStore.lagProbeMsConst)
    this.sampler = setInterval(() => void this.sample(), PerfStore.sampleMsConst)
    return () => this.stop()
  }

  current(): PerfReading | null {
    return this.reading
  }

  subscribe(onChanged: () => void): () => void {
    this.subscribers.add(onChanged)
    return () => { this.subscribers.delete(onChanged) }
  }

  private stop(): void {
    if (this.lagProbe !== null) clearInterval(this.lagProbe)
    if (this.sampler !== null) clearInterval(this.sampler)
    this.lagProbe = null
    this.sampler = null
    // The guard goes with the timers, or a stop taken while a call was out latches the next start.
    this.samplingSince = null
  }

  /**
   * How late this tick is against when it was due. A loop blocked for a second by a parse or a
   * render answers here and nowhere else in the window.
   *
   * **A hidden document measures Chromium, not this UI.** Background throttling stretches a 50 ms
   * interval to about a second, and to about a minute after five of them, so a minimized window
   * would come back drawing a red `R 59950` for a UI that is answering perfectly. Nothing is
   * recorded while the document is hidden, and the first tick after it comes back is dropped too:
   * its lateness is the gap this window spent minimized.
   */
  private probe(): void {
    const now = this.now()
    if (this.hidden()) {
      this.lastProbeAt = now
      this.throttled = true
      return
    }
    if (this.throttled) {
      this.throttled = false
      this.lastProbeAt = now
      return
    }
    const late = now - this.lastProbeAt - PerfStore.lagProbeMsConst
    this.lastProbeAt = now
    if (late > this.lagMax) this.lagMax = Math.round(late)
  }

  /**
   * A sample in flight is never joined by a second one: the main process answers a window since the
   * previous call, so two overlapping calls would each be handed part of it and the bar would draw
   * whichever landed last.
   *
   * A tick that finds one still out is not wasted. How long it has been out IS the reading - a main
   * process that has stopped answering is the fault this widget exists to show, and a widget that
   * froze on its last number while that happened would be the one thing worse than no widget.
   */
  private async sample(): Promise<void> {
    const pending = this.samplingSince
    if (pending !== null) {
      this.publishWait(Math.round(this.now() - pending))
      return
    }
    const begun = this.now()
    this.samplingSince = begun
    try {
      const answer = await this.ports.sample()
      const roundTrip = Math.round(this.now() - begun)
      // Whatever the answer was, the window this lateness belongs to is over.
      const lag = this.lagMax
      this.lagMax = 0
      if (!answer.ok) {
        if (!this.reportedFailure) {
          this.reportedFailure = true
          this.ports.reportError(`The performance sample could not be read: ${answer.error}`)
        }
        return
      }
      this.reportedFailure = false
      this.reading = {
        ...answer.value,
        rendererLagMs: lag,
        mainRoundTripMs: roundTrip,
      }
      for (const subscriber of this.subscribers) subscriber()
    } finally {
      this.samplingSince = null
    }
  }

  /** The one number a call that has not come back can still move, over whatever was last known. */
  private publishWait(waitedMs: number): void {
    const last = this.reading
    if (last === null || waitedMs <= last.mainRoundTripMs) return
    this.reading = { ...last, mainRoundTripMs: waitedMs }
    for (const subscriber of this.subscribers) subscriber()
  }
}
