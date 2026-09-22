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
 * It holds a BOUND, not a history. Past that bound the oldest characters go and the flush resets
 * the terminal first, which is what the Host itself does when its ring has outrun a client
 * (`terminal.snapshot` after `terminal.stream-truncated`): a screen that starts mid-sequence is
 * repainted by the next thing the agent draws.
 */
export interface TerminalHeldFlush {
  /** Clear the terminal before writing: what is held does not continue what is on screen. */
  reset: boolean
  /** Resize before writing, where a snapshot arrived while hidden and named a new geometry. */
  size: { cols: number; rows: number } | null
  data: string
}

export class TerminalHeldOutput {
  /**
   * Half a megabyte, the same figure the Host bounds its own ring at. It is about six thousand
   * full-width rows: more than a viewport, less than the memory a hidden tab may cost while its
   * agent works through the night.
   */
  static readonly maxCharsConst = 512 * 1_024
  /**
   * How far past the bound the buffer is allowed to run before it is cut back to it.
   *
   * Cutting on every frame past the bound is what the slack prevents: `data += delta` makes a rope
   * and `slice` flattens it, so a hidden panel printing a build log would copy half a megabyte per
   * frame - on the thread that handles `keydown`, which is the cost this class exists to remove.
   * With slack the copy happens once per slack's worth of output instead of once per frame.
   */
  private static readonly slackCharsConst = 256 * 1_024

  private data = ''
  private reset = false
  private size: { cols: number; rows: number } | null = null

  /** Everything before a snapshot is superseded by it: that is what a snapshot means. */
  holdSnapshot(cols: number, rows: number, screen: string): void {
    this.data = screen
    this.reset = true
    this.size = { cols, rows }
    this.trim()
  }

  holdData(data: string): void {
    this.data += data
    this.trim()
  }

  get empty(): boolean {
    return this.data.length === 0 && !this.reset && this.size === null
  }

  /** What to do to the terminal now that somebody is looking. Null when nothing arrived. */
  take(): TerminalHeldFlush | null {
    if (this.empty) return null
    const flush: TerminalHeldFlush = { reset: this.reset, size: this.size, data: this.data }
    this.data = ''
    this.reset = false
    this.size = null
    return flush
  }

  private trim(): void {
    if (this.data.length
      <= TerminalHeldOutput.maxCharsConst + TerminalHeldOutput.slackCharsConst) return
    this.data = this.data.slice(-TerminalHeldOutput.maxCharsConst)
    this.reset = true
  }
}
