import type { TerminalProjectionSnapshot } from '../../../app-host/app/wire/hostWire.js'
import type { AgentWorkFrame } from './agentWorkInspector.types'

/**
 * The frame is half the contract: a classifier is a pure function of it, so the windows it reads
 * decide as much as the patterns do. V1 built these windows from a headless xterm mirror it kept
 * beside every session; the Host already keeps one and publishes the result, so here the same three
 * windows are sliced out of `TerminalProjectionSnapshot` and no terminal is emulated a second time.
 *
 * The window sizes are V1's, and each has a reason:
 *
 * - the SHALLOW screen window holds the status-line region only, so the ambiguous busy markers (a
 *   spinner glyph looks like a markdown bullet, "esc to interrupt" can be quoted in a reply) cannot
 *   fire on conversation text;
 * - the WIDE screen window is read for the high-specificity elapsed timers alone, which no prose
 *   contains, so the "thinking (1h25m)" line is still found when a tall input box has pushed it out
 *   of the shallow one;
 * - the RAW window is the recent output, where a marker appears before the screen has settled.
 *
 * **A row of the serialized screen is not a line of its text, and reading it as one is what broke
 * the shallow window.** `SerializeAddon` writes `\r\n` between two rows only when the second one is
 * NOT a wrapped continuation of the first: re-emitting a break inside a wrapped line would make the
 * terminal wrap it a second time. A TUI whose prose is longer than the terminal is wide therefore
 * serializes most of its viewport with no break at all - a 56-row Claude screen recorded on
 * 2026-08-27 carried seven of them - so `split('\n')` handed back the WHOLE screen as eight rows
 * and the shallow window was the wide window was the transcript. The session that exposed it was
 * plainly working, with `esc to interrupt` and a running spinner on screen, and it drew the orange
 * `waiting` diamond for as long as its own last message stayed in the buffer: the message opened
 * with a numbered list, so Claude's echo of it, `> 1. opraveno.`, normalized to exactly the
 * selected menu row `>1.` that `promptEvidence` trusts when it comes from the shallow window.
 *
 * So rows are counted in CELLS against the projection's own `cols`, which is what makes a wrap a
 * row boundary. See `rowStarts`.
 */
export class ScreenTail {
  static readonly screenRowsConst = 8
  static readonly wideScreenRowsConst = 16
  static readonly rawCharsConst = 2_000
  private static readonly ansiPatternConst = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g
  /** The same alphabet as above, anchored, with the CSI parameters and final byte kept apart. */
  private static readonly escapeAtConst =
    /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[([0-?]*)[ -/]*([@-~]))/y

  static frameOf(
    projection: Pick<TerminalProjectionSnapshot, 'raw' | 'screen' | 'cols'>,
  ): AgentWorkFrame {
    return {
      rawTail: ScreenTail.rawTail(projection.raw),
      screenTail: ScreenTail.rows(projection.screen, ScreenTail.screenRowsConst, projection.cols),
      wideScreenTail: ScreenTail.rows(
        projection.screen, ScreenTail.wideScreenRowsConst, projection.cols),
    }
  }

  /** The classification buffer, not the ring: the Host's ring is half a megabyte of history. */
  static rawTail(raw: string): string {
    return raw.length <= ScreenTail.rawCharsConst ? raw : raw.slice(-ScreenTail.rawCharsConst)
  }

  /**
   * The last physical rows of the serialized screen, empty ones included. An agent TUI keeps its
   * status line at the bottom, so blank rows remain significant unless SerializeAddon explicitly
   * restores the cursor upward after serializing unused viewport rows below the TUI. Physical row
   * boundaries are materialized as newlines: SerializeAddon omits them at wrapped boundaries, but a
   * classifier still needs to know where one status row ends and the next prompt begins.
   */
  static rows(screen: string, count: number, cols: number): string {
    const starts = ScreenTail.rowStarts(screen, cols)
    let endRow = starts.length
    if (ScreenTail.finalVerticalMove(screen) === 'A')
      while (endRow > 0 && !ScreenTail.stripAnsiLower(
        screen.slice(starts[endRow - 1], starts[endRow] ?? screen.length),
      ).trim()) endRow -= 1
    const startRow = Math.max(0, endRow - count)
    return starts.slice(startRow, endRow).map((start, offset) => {
      const end = starts[startRow + offset + 1] ?? screen.length
      return screen.slice(start, end).replace(/\r?\n$/, '')
    }).join('\n')
  }

  static stripAnsiLower(text: string): string {
    return text.replace(ScreenTail.ansiPatternConst, '').toLowerCase()
  }

  /**
   * Whitespace is where a TUI is free: the same row arrives padded, wrapped or repainted. Removing
   * it entirely is what lets one pattern match a row the terminal broke across three lines.
   */
  static normalizeTty(text: string): string {
    return ScreenTail.stripAnsiLower(text).replace(/\s+/g, '')
  }

  /**
   * Where each physical row of the serialized screen begins, counted in cells rather than in line
   * breaks. A row ends at a `\n` or when the cell after the last column would be written, which is
   * the wrap the serializer deliberately does not spell out.
   *
   * Only the two cursor moves that carry a row's own layout are followed: forward, which the
   * serializer writes instead of a run of unstyled spaces, and back, which it writes once per
   * forced wrap as `ESC[1D ESC[1X` to erase the filler character it just used to trigger one.
   * Clamping the column at zero is what makes that pair land on the new row rather than at its far
   * end. Everything else - the absolute jumps in the prologue that restore the normal buffer before
   * `ESC[?1049h` switches to the alternate one - is counted as zero width, and it costs nothing: it
   * can only misplace rows ABOVE the alternate screen, and every window here is a tail.
   */
  private static rowStarts(screen: string, cols: number): number[] {
    const width = Math.max(1, cols)
    const starts = [0]
    let column = 0
    let index = 0
    let pendingWrapStart: number | null = null
    while (index < screen.length) {
      const escape = ScreenTail.escapeAt(screen, index)
      if (escape !== null) {
        column = Math.max(0, column + escape.move)
        index += escape.length
        continue
      }
      const character = screen[index]
      index += 1
      if (character === '\n') {
        if (pendingWrapStart !== null && starts.at(-1) === pendingWrapStart) starts.pop()
        starts.push(index)
        column = 0
        pendingWrapStart = null
      }
      else if (character === '\r') column = 0
      else {
        pendingWrapStart = null
        column += 1
        if (column >= width) {
          starts.push(index)
          column = 0
          pendingWrapStart = index
        }
      }
    }
    if (pendingWrapStart !== null && starts.at(-1) === pendingWrapStart) starts.pop()
    return starts
  }

  /**
   * SerializeAddon writes the final cursor restoration after every serialized row. An upward final
   * move proves that the blank rows at the end sit below the active TUI, rather than replacing a
   * status that used to be there. Internal wrap repairs end with a matching downward move.
   */
  private static finalVerticalMove(screen: string): 'A' | 'B' | null {
    const alternateMarker = '\x1b[?1049h\x1b[H'
    const alternateStart = screen.lastIndexOf(alternateMarker)
    const active = alternateStart < 0
      ? screen
      : screen.slice(alternateStart + alternateMarker.length)
    let final: 'A' | 'B' | null = null
    for (const match of active.matchAll(/\x1b\[[0-9]*([AB])/g)) {
      if (match[1] === 'A') final = 'A'
      else if (match[1] === 'B') final = 'B'
      else throw new Error(`Unhandled vertical cursor move ${String(match[1])}`)
    }
    return final
  }

  private static escapeAt(
    screen: string,
    index: number,
  ): { length: number, move: number } | null {
    ScreenTail.escapeAtConst.lastIndex = index
    const match = ScreenTail.escapeAtConst.exec(screen)
    if (match === null) return null
    return { length: match[0].length, move: ScreenTail.moveOf(match[1], match[2]) }
  }

  /**
   * How far a CSI moves the cursor across its row. The final byte is an open alphabet rather than a
   * closed set of ours, so anything that is not one of the two horizontal moves is zero width -
   * which is the truth for every colour, mode and erase the serializer emits.
   */
  private static moveOf(parameters: string | undefined, final: string | undefined): number {
    if (final !== 'C' && final !== 'D') return 0
    const amount = Number.parseInt(parameters ?? '', 10)
    const cells = Number.isNaN(amount) ? 1 : amount
    return final === 'C' ? cells : -cells
  }
}
