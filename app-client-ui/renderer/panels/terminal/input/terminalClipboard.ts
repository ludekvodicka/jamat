/**
 * The pieces of clipboard work that are text in, text out, and therefore belong nowhere near xterm
 * or Electron. What the terminal does WITH them - which key, which selection, which escape - is
 * wiring, and it stays in the attachment beside the terminal it wires.
 *
 * All of them are V1's, ported along with the rest of its clipboard handling
 * (`AppJamat/app-electron/src/renderer/{hooks/useTerminal.ts,utils/terminal-helpers.ts}`).
 */
export class TerminalClipboard {
  /**
   * Text as a paste rather than as typing.
   *
   * A shell in bracketed-paste mode reads what arrives between the two markers as literal content:
   * a newline in it is a line, not a submitted command, and a readline binding inside it does not
   * fire. Without the markers a pasted multi-line prompt runs its first line the moment it arrives.
   *
   * Null for empty text: there is nothing to paste, and a bare pair of markers is still bytes the
   * agent has to parse.
   */
  static pasteOf(text: string): string | null {
    if (text.length === 0) return null
    return `\x1b[200~${text}\x1b[201~`
  }

  /** V1's value: quick for ordinary text, long enough that the TUI reads each line as its own paste. */
  /**
   * How much base64 an OSC 52 may carry. The payload is written by whatever runs in the terminal,
   * and xterm's own OSC limit is measured in megabytes: without this, one escape decoded a
   * multi-megabyte string on the drawing thread, character by character, and put it on the user's
   * clipboard from a tab that did not have to be visible. Every other axis of this surface is
   * bounded; a real selection is far below this.
   */
  private static readonly osc52PayloadCharactersMaxConst = 512 * 1_024
  private static readonly pasteLineDelayMillisecondsConst = 10

  /**
   * At the delay above this is two seconds of writes; past it the clipboard is a file rather than a
   * prompt, and a run that long outlives the attach it was started on more often than not.
   */
  private static readonly pasteAsTextLinesMaxConst = 200

  /**
   * The same text as ordinary editable lines instead of as one paste.
   *
   * One large bracketed paste is what makes Claude Code collapse the whole thing into a
   * `[Pasted text +N lines]` placeholder that cannot be edited. A line at a time, each as its own
   * small paste, stays under whatever that collapse measures, and the line break rides INSIDE the
   * paste, where bracketed mode stops it from submitting the prompt. The delay is what keeps them
   * distinct pastes rather than one arrival the TUI joins back up.
   *
   * A writer rather than a returned string: this is a sequence spaced in time, so there is no one
   * value to hand back. Which terminal the lines are written to still stays outside. What comes back
   * is the way to stop it, because the caller owns an attach that can go away mid-sequence.
   *
   * More lines than the cap go in as the single paste `Paste` sends: nothing is dropped, and the
   * placeholder is the honest reading of a clipboard that size.
   */
  static pasteAsTextByLines(text: string, write: (data: string) => void): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null
    const cancel = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
    const whole = TerminalClipboard.pasteOf(text)
    if (whole === null) return cancel
    const lines = text.split(/\r?\n/)
    if (lines.length > TerminalClipboard.pasteAsTextLinesMaxConst) {
      write(whole)
      return cancel
    }
    let index = 0
    const step = (): void => {
      timer = null
      const last = index === lines.length - 1
      write(`\x1b[200~${last ? lines[index] : `${lines[index]}\n`}\x1b[201~`)
      index += 1
      if (index < lines.length)
        timer = setTimeout(step, TerminalClipboard.pasteLineDelayMillisecondsConst)
    }
    step()
    return cancel
  }

  /**
   * Copied terminal text without the gutter a TUI drew down the left of it.
   *
   * Claude Code draws a vertical bar beside quoted and wrapped blocks. It is part of the SCREEN, so
   * a selection across such a block puts the bar at the start of every line, and what lands in the
   * clipboard is unusable as text. Per line, and only leading: a line that never had the gutter is
   * left exactly as it was.
   */
  static withoutQuoteGutter(text: string): string {
    return text.replace(/^[|│] ?/gm, '')
  }

  /**
   * What an OSC 52 escape wants put on the clipboard, or null for one that wants nothing put there.
   *
   * This is the only way a selection made INSIDE a TUI comes out. With mouse tracking on, a drag is
   * forwarded to the application and xterm makes no selection of its own, so the app does the
   * selecting and sends the copy as `ESC ] 52 ; <targets> ; <base64> BEL`. Null covers the two
   * cases that are not a copy: `?` is a READ of the clipboard, which is answered by ignoring it
   * rather than by handing the terminal's own process the user's clipboard, and payload that is not
   * base64 at all is a malformed escape rather than an empty copy.
   *
   * The gutter is not taken off here. Every copy goes out through one call in the attachment and
   * that call strips it, so this answers what the escape carried and nothing more.
   */
  static textOfOsc52(data: string): string | null {
    const separator = data.indexOf(';')
    const payload = (separator >= 0 ? data.slice(separator + 1) : data).trim()
    if (payload.length === 0 || payload === '?') return null
    if (payload.length > TerminalClipboard.osc52PayloadCharactersMaxConst) return null
    let binary: string
    try { binary = atob(payload) }
    catch { return null }
    const text = new TextDecoder()
      .decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
    if (text.length === 0) return null
    return text
  }

  /** `Ctrl+V`, and `Ctrl+Shift+V` with it: both are paste everywhere else, so both are paste here. */
  static isPasteKey(event: KeyboardEvent): boolean {
    return event.type === 'keydown' && event.ctrlKey && !event.altKey && !event.metaKey
      && (event.key === 'v' || event.key === 'V')
  }

  /**
   * `Ctrl+C`. Whether it copies ANYTHING is a different question and not one this can answer: with
   * no selection the key is the interrupt and belongs to whatever is running, so the decision is
   * made where the selection can be read.
   */
  static isCopyKey(event: KeyboardEvent): boolean {
    return event.type === 'keydown' && event.ctrlKey && !event.shiftKey && !event.altKey
      && !event.metaKey && (event.key === 'c' || event.key === 'C')
  }
}
