import type { DirectoryNote } from '../../../../shared/directoryNotes'

export type TerminalNotesSaveOutcome = { ok: true } | { ok: false; detail: string }

/**
 * One panel's writes of its notes: at most one in flight, and while it is out only the newest state
 * waits behind it. A failed write is kept as pending, so the editor still counts as unsaved and the
 * next `flush` (Retry, blur, an import) writes the newest state again.
 */
export class TerminalNotesSaveQueue {
  static readonly debounceMillisecondsConst = 500
  private readonly save: (notes: readonly DirectoryNote[]) => Promise<TerminalNotesSaveOutcome>
  private readonly onOutcome: (outcome: TerminalNotesSaveOutcome) => void
  private pending: readonly DirectoryNote[] | null = null
  private inFlight: Promise<TerminalNotesSaveOutcome> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    save: (notes: readonly DirectoryNote[]) => Promise<TerminalNotesSaveOutcome>,
    onOutcome: (outcome: TerminalNotesSaveOutcome) => void,
  ) {
    this.save = save
    this.onOutcome = onOutcome
  }

  /** Replaces whatever waits and starts the debounce again. */
  schedule(notes: readonly DirectoryNote[]): void {
    if (this.disposed) return
    this.pending = notes
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.start()
    }, TerminalNotesSaveQueue.debounceMillisecondsConst)
  }

  /**
   * Waits for the write in flight, then writes what is pending, until nothing is left. Answers the
   * last outcome; a failure of a write this call started ends it, so a dead channel is not retried
   * in a loop.
   */
  async flush(): Promise<TerminalNotesSaveOutcome> {
    this.clearTimer()
    let outcome: TerminalNotesSaveOutcome = { ok: true }
    let wrote = false
    for (;;) {
      if (this.inFlight !== null) {
        outcome = await this.inFlight
        continue
      }
      if (this.pending === null || (wrote && !outcome.ok)) return outcome
      wrote = true
      this.start()
    }
  }

  dirty(): boolean {
    return this.pending !== null || this.inFlight !== null
  }

  /** A closing panel still sends its last edit, once, and nobody is told how it went. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimer()
    this.start()
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private start(): void {
    if (this.inFlight !== null || this.pending === null) return
    const notes = this.pending
    this.pending = null
    this.inFlight = this.save(notes).then((outcome) => this.settled(notes, outcome))
  }

  private settled(notes: readonly DirectoryNote[], outcome: TerminalNotesSaveOutcome): TerminalNotesSaveOutcome {
    this.inFlight = null
    if (this.disposed) {
      // The one write `dispose` owes: whatever was pending when the panel closed.
      this.start()
      return outcome
    }
    if (!outcome.ok && this.pending === null) this.pending = notes
    this.onOutcome(outcome)
    // A newer state whose debounce already ran out waited for this write; a running timer will start it.
    if (outcome.ok && this.timer === null) this.start()
    return outcome
  }
}
