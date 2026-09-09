import { type TerminalTarget, TerminalTargetCodec } from '../../shared/terminalTarget'

export interface ActiveTerminalReading {
  panelId: string
  target: TerminalTarget
}

/**
 * Which terminal panel the active tab of THIS document is. The wrap around the active-panel port
 * fills it, and the surfaces of this window's bar and sessions tree read it.
 *
 * It exists because the signal the shell already had leaves the window: the controller publishes the
 * active panel to the main process, which broadcasts a cross-window set for attention marks. That
 * set cannot say which panel THIS document has in front, which only this document knows.
 *
 * The source-aware target travels INSIDE the reading rather than arriving beside it: the panel id is
 * derived from the target, so the pair is written in one act and no surface can draw one tab's
 * session against another target. A local and remote session with the same id remain distinct.
 */
export class ActiveTerminalStore {
  private reading: ActiveTerminalReading | null = null
  private readonly subscribers = new Set<() => void>()

  subscribe(onChanged: () => void): () => void {
    this.subscribers.add(onChanged)
    return () => {
      this.subscribers.delete(onChanged)
    }
  }

  current(): ActiveTerminalReading | null {
    return this.reading
  }

  /**
   * Idempotent by VALUE: the port publishes on every layout move, restores included, and most of
   * those name the tab that was already in front. A store that swapped the object anyway would wake
   * every subscriber and hand React a new identity for a window nothing moved in.
   */
  set(reading: ActiveTerminalReading | null): void {
    if (ActiveTerminalStore.same(this.reading, reading))
      return
    this.reading = reading
    for (const subscriber of this.subscribers)
      subscriber()
  }

  private static same(
    left: ActiveTerminalReading | null,
    right: ActiveTerminalReading | null,
  ): boolean {
    if (left === null || right === null)
      return left === right
    return left.panelId === right.panelId
      && TerminalTargetCodec.key(left.target) === TerminalTargetCodec.key(right.target)
  }
}
