/**
 * How long a keystroke took to come back, measured where both ends are visible: the main process
 * relays the byte to the Host and publishes the frame that answers it.
 *
 * It is the only reading that includes the AGENT. In raw mode nothing echoes a key except the
 * program reading it, so a Claude or Codex process busy with a tool result accepts the byte and
 * draws nothing for as long as it stays busy - which the person reports as "I cannot type" and
 * which no loop delay of ours would show. A measurement that stops at our own boundary would say
 * everything is fine, every time.
 *
 * One pending keystroke per attach, and the FIRST byte back closes it: a burst of typing is one
 * wait, not one per key.
 *
 * **It measures silence after a keystroke, not the echo of that keystroke.** A terminal already
 * printing output answers the next byte that was coming anyway, so a busy screen reads low. What it
 * catches is the case it exists for: nothing at all came back for seconds after somebody typed.
 */
export class EchoLatency {
  /**
   * Past this an answer is not late, it is absent - the agent is reading a file, thinking, or gone.
   * Keeping it would draw one enormous number for minutes after it stopped being true.
   */
  private static readonly abandonMsConst = 30_000

  private readonly pending = new Map<string, number>()
  private maxValue: number | null = null

  /**
   * `performance.now` rather than `Date.now`: a clock adjustment between a keystroke and its answer
   * would otherwise be reported as the wait, and the bar would draw a red number nobody caused.
   */
  constructor(private readonly now: () => number = () => performance.now()) {}

  typed(attachId: string): void {
    if (this.pending.has(attachId)) return
    this.pending.set(attachId, this.now())
  }

  answered(attachId: string): void {
    const at = this.pending.get(attachId)
    if (at === undefined) return
    this.pending.delete(attachId)
    const elapsed = this.now() - at
    if (elapsed > EchoLatency.abandonMsConst) return
    this.maxValue = Math.max(this.maxValue ?? 0, elapsed)
  }

  forget(attachId: string): void {
    this.pending.delete(attachId)
  }

  /** The worst wait since the last read; null where nobody typed. The window starts again here. */
  sample(): number | null {
    const max = this.maxValue
    this.maxValue = null
    return max
  }
}
