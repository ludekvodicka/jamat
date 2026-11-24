/**
 * What a terminal nobody is looking at has not been shown yet.
 *
 * xterm stops DRAWING a terminal that is off screen - it watches its own element - but
 * `terminal.write` still parses every byte into the buffer, and the parser runs on the one thread
 * that also handles `keydown`. A window holding twenty tabs of working agents therefore parsed
 * twenty screens' worth of repaints to draw one, and the cost landed exactly where typing happens.
 *
 * So a hidden panel holds its output as text and writes it once, when it is shown. Text is what
 * arrived; parsing it later is the same parse, done once, for the one tab somebody actually opens.
 *
 * It holds a BOUND, not an unbounded log. Past that bound the raw bytes are dropped and the panel
 * requests a clean serialized snapshot from the Host when it becomes visible again, rather than
 * resetting xterm and replaying a mid-sequence raw tail that wipes the user's scrollback.
 */
export type TerminalHeldFlush =
  | {
    kind: 'data'
    /** Clear the terminal before writing: what is held does not continue what is on screen. */
    reset: boolean
    /** Resize before writing, where a snapshot arrived while hidden and named a new geometry. */
    size: { cols: number; rows: number } | null
    data: string
  }
  | {
    /** Raw hidden output outgrew the bound; ask the Host for a clean serialized snapshot instead. */
    kind: 'overflow'
  }

export class TerminalHeldOutput {
  /**
   * Two megabytes: large enough for a heavy agent turn (such as Antigravity TUI repaints) to finish
   * in a hidden tab without re-attaching, while still capping hidden-tab memory before falling back
   * to a clean Host snapshot on reveal.
   */
  static readonly maxCharsConst = 2 * 1_024 * 1_024

  private data = ''
  private reset = false
  private size: { cols: number; rows: number } | null = null
  private overflowed = false

  /** Everything before a snapshot is superseded by it: that is what a snapshot means. */
  holdSnapshot(cols: number, rows: number, screen: string): void {
    this.data = screen
    this.reset = true
    this.size = { cols, rows }
    this.overflowed = false
    this.checkBound()
  }

  holdData(data: string): void {
    if (this.overflowed) return
    this.data += data
    this.checkBound()
  }

  get empty(): boolean {
    return !this.overflowed && this.data.length === 0 && !this.reset && this.size === null
  }

  get isOverflowed(): boolean {
    return this.overflowed
  }

  /** What to do to the terminal now that somebody is looking. Null when nothing arrived. */
  take(): TerminalHeldFlush | null {
    if (this.empty) return null
    if (this.overflowed) {
      this.clear()
      return { kind: 'overflow' }
    }
    const flush: TerminalHeldFlush = { kind: 'data', reset: this.reset, size: this.size, data: this.data }
    this.clear()
    return flush
  }

  private clear(): void {
    this.data = ''
    this.reset = false
    this.size = null
    this.overflowed = false
  }

  private checkBound(): void {
    if (this.data.length <= TerminalHeldOutput.maxCharsConst) return
    this.data = ''
    this.reset = false
    this.size = null
    this.overflowed = true
  }
}
