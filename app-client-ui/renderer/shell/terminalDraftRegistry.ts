import { TerminalDraft } from '../panels/terminal/input/terminalDraft'

interface TerminalDraftEntry {
  characters: number
  touchedAt: number
}

/**
 * What a person has half-written in this document's terminals, and when they last touched one.
 *
 * Per document and fed by the panel that holds the attach, for the reason `TerminalInputRegistry`
 * beside it is: the keystrokes travel through that attach and nowhere else. Its one reader is the
 * automatic compact, which types into the very prompt this counts, so the question it answers is
 * whether writing there now would land in the middle of somebody's sentence. The synthetic path
 * never reports here - `/compact` is not something a person typed - so a compact cannot silence the
 * evidence against the next one.
 *
 * **Written limit: a draft is known only in the window it was typed in.** A tab dragged to another
 * window is a fresh panel in a fresh document, whose registry starts empty, so text already standing
 * in that prompt is invisible there until the next keystroke. Both windows can hold the session, and
 * neither hears the other's keys.
 */
export class TerminalDraftRegistry {
  /**
   * A keystroke that left no characters behind - a cursor key, a backspace that emptied the line -
   * still says where a person's hands are, so the last one counts for a while after it.
   */
  private static readonly recentMillisecondsConst = 15_000

  private readonly entries = new Map<string, TerminalDraftEntry>()
  private readonly subscribers = new Set<() => void>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Bytes this person's keys produced for one session, whatever they turn out to mean. */
  typed(sessionId: string, data: string): void {
    if (TerminalDraft.isReport(data)) return
    const characters = TerminalDraft.after(this.entries.get(sessionId)?.characters ?? 0, data)
    this.entries.set(sessionId, { characters, touchedAt: this.now() })
    for (const subscriber of this.subscribers) subscriber()
  }

  subscribe(onChanged: () => void): () => void {
    this.subscribers.add(onChanged)
    return () => { this.subscribers.delete(onChanged) }
  }

  status(sessionId: string): { characters: number; quietAt: number } {
    const entry = this.entries.get(sessionId)
    return {
      characters: entry?.characters ?? 0,
      quietAt: entry === undefined ? 0 : entry.touchedAt + TerminalDraftRegistry.recentMillisecondsConst,
    }
  }

  /** Whether somebody is writing into this session's prompt, or has left something standing in it. */
  composing(sessionId: string): boolean {
    const status = this.status(sessionId)
    return status.characters > 0 || this.now() < status.quietAt
  }
}
