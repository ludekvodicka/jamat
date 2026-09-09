import type {
  SessionModelInfo,
  SessionModelReading,
} from '../../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { ErrorText } from '../../shared/errorText'
import {
  type ActiveAgentTerminal,
  ActiveAgentTerminals,
} from '../statusBar/useActiveAgentTerminal'

export interface SessionModelPorts {
  read(sessionId: string): Promise<IpcResult<SessionModelReading>>
  reportError(message: string): void
}

/** The tab this window has in front, and the last thing read about its session. Both, or neither. */
export interface SessionModelCurrent {
  focus: ActiveAgentTerminal
  info: SessionModelInfo
  /**
   * When this reading was last TRUE, not when it was last drawn.
   *
   * A reading is kept when a later read answers nothing, which is right - a session with nothing to
   * say yet and one that has ended answer the same way, and the last true reading is the truest
   * thing this window knows. What was missing is any sign of its age: a live session whose
   * transcript stopped being readable - the project directory renamed under it, a backup agent
   * holding the file - went on drawing the same numbers in the same colour with the same Compact
   * button for hours, and somebody decided on a figure that had not moved since.
   */
  readAt: number
}

export interface SessionModelHeld {
  info: SessionModelInfo
  readAt: number
}

/**
 * The poll behind widget B, and the only clock in it. One per document, because what it follows is
 * the tab THIS window has in front: the main process knows which sessions are open somewhere, not
 * which one is being looked at here.
 *
 * The cadence is V1's - 8 s until something has been read about the focused session, 20 s after -
 * and it stands still while no agent terminal is in front, so a window showing a file viewer asks
 * nothing of anybody. A tick that reaches a session whose transcript has not moved costs one stat in
 * the library and no open, which is what makes polling an ended session free rather than merely
 * cheap.
 *
 * The map of readings is what makes switching tabs immediate: the value the session last answered is
 * drawn the moment its tab comes forward and the fresh read settles it a moment later. It is
 * volatile on purpose - nothing here is written to disk, and a reading that outlived the window
 * would be a claim about a session nobody has looked at since. Bounded the way the two readers below
 * it are, oldest first.
 *
 * The cold cadence is for a session that has not answered YET - a fresh agent whose transcript is
 * still empty - and it gives up after a few tries. A session that keeps answering nothing is not
 * getting closer to an answer, and behind a Codex rollout that cannot be resolved each of those asks
 * walks the whole rollout store on the client's main thread, for as long as the tab is in front.
 */
export class SessionModelStore {
  private static readonly warmMillisecondsConst = 20_000
  private static readonly coldMillisecondsConst = 8_000
  private static readonly maxRememberedConst = 16
  /** About half a minute of the fast cadence, which is what a starting session needs and no more. */
  private static readonly coldAsksConst = 4

  private readonly readings = new Map<string, SessionModelHeld>()
  private readonly inFlight = new Map<string, Promise<SessionModelReading | null>>()
  private readonly subscribers = new Set<() => void>()
  private focus: ActiveAgentTerminal | null = null
  private state: SessionModelCurrent | null = null
  /** Consecutive answers about the tab in front that carried nothing. Reset when the tab changes. */
  private silentAsks = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private reading = false
  private stopped = true
  /**
   * Whether this window is on screen at all.
   *
   * "No agent terminal in front" is not the same question, and this poll was the only status-bar
   * reader that asked one and not the other: the sessions poll and the rate monitor both drop to
   * nothing when no window is visible, and a holder minimised for the afternoon went on asking
   * `sessionModel:get` every twenty seconds.
   */
  private visible = true

  constructor(
    private readonly ports: SessionModelPorts,
    /** Injected so a test can age a reading without waiting for one. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Arms this document's poll and hands back the one function that disarms it. */
  start(): () => void {
    this.stopped = false
    void this.tick()
    return () => this.stop()
  }

  /** Told by the document. A window coming back reads at once rather than after a whole interval. */
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

  /** The tab in front changed: the timer is re-keyed to the new session and read immediately. */
  setFocus(focus: ActiveAgentTerminal | null): void {
    if (ActiveAgentTerminals.same(this.focus, focus))
      return
    this.focus = focus
    this.silentAsks = 0
    this.clearTimer()
    this.settle()
    void this.tick()
  }

  subscribe(onChanged: () => void): () => void {
    this.subscribers.add(onChanged)
    return () => {
      this.subscribers.delete(onChanged)
    }
  }

  /** Held rather than built per call: `useSyncExternalStore` reads this on every render. */
  current(): SessionModelCurrent | null {
    return this.state
  }

  readingFor(sessionId: string): SessionModelHeld | null {
    return this.readings.get(sessionId) ?? null
  }

  async readNow(sessionId: string): Promise<SessionModelInfo | null> {
    const reading = await this.readSession(sessionId)
    if (reading === null || reading.kind === 'none') return null
    else if (reading.kind === 'ok') return reading.info
    else
      throw new Error(`Unknown session model reading: ${JSON.stringify(reading)}`)
  }

  private stop(): void {
    this.stopped = true
    this.clearTimer()
  }

  private async tick(): Promise<void> {
    const focus = this.focus
    if (focus === null || this.stopped || this.reading || !this.visible)
      return
    this.reading = true
    const answer = await this.readSession(focus.sessionId)
    this.reading = false
    // `accept` refuses a reading it was never taught, and this runs behind a bare `void tick()`:
    // uncaught, the throw would both escape as a rejected promise and skip the re-arm below, so
    // the widget would freeze on its last value until another tab came forward.
    try {
      if (answer !== null)
        this.accept(answer)
    } catch (thrown) {
      this.ports.reportError(`The session model reading could not be taken: ${ErrorText.of(thrown)}`)
    }
    // The tab moved while the read was in flight, so the answer in hand is about the tab that left:
    // the one now in front is read at once rather than after a whole interval of nothing drawn.
    if (this.focus !== null && this.focus !== focus)
      void this.tick()
    else
      this.arm()
  }

  /** Null is a read that never landed. It is reported, and what is drawn is left alone. */
  private async readOf(sessionId: string): Promise<SessionModelReading | null> {
    try {
      const answer = await this.ports.read(sessionId)
      if (answer.ok)
        return answer.value
      this.ports.reportError(`The session model could not be read: ${answer.error}`)
      return null
    } catch (thrown) {
      this.ports.reportError(`The session model could not be read: ${ErrorText.of(thrown)}`)
      return null
    }
  }

  private readSession(sessionId: string): Promise<SessionModelReading | null> {
    const current = this.inFlight.get(sessionId)
    if (current !== undefined) return current
    const reading = this.readAndRemember(sessionId)
      .finally(() => {
        if (this.inFlight.get(sessionId) === reading) this.inFlight.delete(sessionId)
      })
    this.inFlight.set(sessionId, reading)
    return reading
  }

  private async readAndRemember(sessionId: string): Promise<SessionModelReading | null> {
    const reading = await this.readOf(sessionId)
    if (reading === null || reading.kind === 'none') return reading
    else if (reading.kind === 'ok') {
      try {
        this.remember(sessionId, reading.info)
        return reading
      } catch (error) {
        this.ports.reportError(
          `The session model reading could not be taken: ${ErrorText.of(error)}`,
        )
        return null
      }
    }
    else {
      this.ports.reportError(
        `The session model reading could not be taken: `
        + `Unknown session model reading: ${JSON.stringify(reading)}`,
      )
      return null
    }
  }

  private accept(reading: SessionModelReading): void {
    if (reading.kind === 'ok') {
      this.silentAsks = 0
    }
    else if (reading.kind === 'none')
      // Not an erasure. A session with nothing to say yet and one that has ended answer the same
      // way, and the last reading that WAS true stays the truest thing this window knows about it.
      // Counted, so the fast cadence stops asking a session that will not start answering.
      this.silentAsks += 1
    else
      throw new Error(`Unknown session model reading: ${JSON.stringify(reading)}`)
  }

  private remember(sessionId: string, info: SessionModelInfo): void {
    this.readings.delete(sessionId)
    this.readings.set(sessionId, { info, readAt: this.now() })
    while (this.readings.size > SessionModelStore.maxRememberedConst)
      this.readings.delete(this.readings.keys().next().value!)
    this.settle()
  }

  private arm(): void {
    this.clearTimer()
    if (this.stopped || this.focus === null || !this.visible)
      return
    const warm = this.readings.has(this.focus.sessionId)
      || this.silentAsks >= SessionModelStore.coldAsksConst
    const delay = warm
      ? SessionModelStore.warmMillisecondsConst
      : SessionModelStore.coldMillisecondsConst
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, delay)
  }

  private settle(): void {
    const next = this.readingOf()
    if (next === null && this.state === null)
      return
    if (next !== null && this.state !== null
      && this.state.focus === next.focus && this.state.info === next.info
      && this.state.readAt === next.readAt)
      return
    this.state = next
    for (const subscriber of this.subscribers)
      subscriber()
  }

  private readingOf(): SessionModelCurrent | null {
    if (this.focus === null)
      return null
    const held = this.readings.get(this.focus.sessionId)
    return held === undefined
      ? null
      : { focus: this.focus, info: held.info, readAt: held.readAt }
  }

  private clearTimer(): void {
    if (this.timer !== null)
      clearTimeout(this.timer)
    this.timer = null
  }
}
