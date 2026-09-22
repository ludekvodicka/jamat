/**
 * What held the main process's event loop, and for how long.
 *
 * `LoopDelaySampler` beside it says a block HAPPENED; nothing in Node says what caused one. A
 * blocked loop is one synchronous task that ran too long, so the way to name it is to time the few
 * doors work comes through and keep the worst. That is this: an IPC handler's synchronous part, a
 * frame published to a window, a snapshot composed for one.
 *
 * **The synchronous part is the whole point.** An `async` handler that awaits for a second has not
 * blocked anything, so what is timed is the call itself - from entry until it returns, which for a
 * promise-returning handler is everything it did before its first await. That is exactly the part
 * that can make a keystroke wait.
 */
export interface MainWorkReading {
  label: string
  milliseconds: number
}

export class MainWorkLedger {
  /** Below this nothing is worth naming: a keystroke that waited 5 ms waited for nobody. */
  private static readonly floorMsConst = 5

  private worst: MainWorkReading | null = null

  /** Runs `work` and keeps its synchronous duration if it is the worst of the window. */
  run<T>(label: string, work: () => T): T {
    const begun = performance.now()
    try {
      return work()
    } finally {
      this.note(label, performance.now() - begun)
    }
  }

  note(label: string, milliseconds: number): void {
    const rounded = Math.round(milliseconds)
    if (rounded < MainWorkLedger.floorMsConst) return
    if (this.worst !== null && this.worst.milliseconds >= rounded) return
    this.worst = { label, milliseconds: rounded }
  }

  /** The worst of the window, and the window starts again here. Null where nothing was slow. */
  sample(): MainWorkReading | null {
    const worst = this.worst
    this.worst = null
    return worst
  }
}
