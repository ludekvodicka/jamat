import type { Terminal } from '@xterm/xterm'

import type { TerminalMenuCapture } from '../../../../../lib-orchestrator/terminalDetector/terminalDetectorApi.types'
// A VALUE import, and the third one the renderer takes from the library. The same reason as the
// other two: these are the limits BOTH sides measure the same capture against, and while the
// renderer named its own copy of 4 096 beside the library's, raising one of them changed nothing.
import { TerminalDetectorLimits } from '../../../../../lib-orchestrator/terminalDetector/terminalDetectorLimits'

/**
 * Everything the scan reads from a live terminal, handed in rather than reached for: jsdom answers
 * `getBoundingClientRect` with zeros, so a scan that measured the screen itself could only ever be
 * tested against the real thing.
 */
/**
 * One row of the buffer, and the two maps between where a character SITS and where it is WRITTEN.
 *
 * They are not the same number, and were assumed to be. A grid column holds one cell; a cell holds
 * anything from zero to several code units. `你` occupies two columns and one code unit, its second
 * column is a cell with none at all, and `🎉` occupies one column and two code units - so on any row
 * carrying either, every index right of it is off, in opposite directions.
 *
 * Both maps are needed because the scan runs both ways: a click arrives as a column and has to become
 * an index, and a run's end is an index that has to become a column to ask whether it reached the
 * edge of the screen.
 */
export interface TerminalBufferRow {
  /** `line.translateToString(false, 0, cols)`: never trimmed, so the padding is part of the row. */
  text: string
  /** The grid column each code unit of `text` sits in, plus one entry for one past its end. */
  columnAt: readonly number[]
  /** Where in `text` each grid column begins; a column inside a wide character points at its start. */
  indexAt: readonly number[]
}

export interface TerminalBufferReader {
  row(row: number): TerminalBufferRow | null
  cols: number
  rows: number
  viewportY: number
  /** Buffer rows, scrollback included - not the visible height, which is `rows`. */
  length: number
  /** The `.xterm-screen` rect - the cell grid is measured on it, not on the holder around it. */
  screenRect: { left: number; top: number; width: number; height: number }
}

/**
 * The path-like text under a right click, read straight off the buffer. V1's heuristic
 * (`AppJamat/app-electron/src/renderer/utils/terminal-helpers.ts:349-422`) with its guards.
 *
 * Strategy: find the path-char run around the click on the clicked row, then - only if that run
 * looks path-like (contains `\`, `/` or `:`) - stitch it with the adjacent rows. Stitching covers
 * four different ways one path ends up on two rows:
 *   - xterm soft wrap                                     (continuation row starts at column 0)
 *   - source hard wrap at the terminal edge (Ink / Claude Code, no indent)
 *   - hanging-indent continuation (Claude Code `Update(<long path>)`)
 *   - a source wrapping EARLY at a break opportunity, several columns short of the edge, with the
 *     continuation behind its own frame border (Codex)
 *
 * Cross-row rule, both directions: the row being continued has to have been unable to hold what
 * follows it - either it was filled to the terminal edge, or the next fragment would not have fitted
 * after it. The second half is what the fourth case needs and what a column of stacked paths never
 * satisfies: a second short path on the row below would have fitted beside the first one, so it was
 * never a continuation of it. Step back when everything LEFT of the run on the current row is a row
 * prefix and the previous row ends in a path-char run it could not have carried on; step forward
 * when everything RIGHT of the run is whitespace and the next row's fragment could not have stayed
 * on this one.
 *
 * The stitched token never replaces the plain one: the capture carries the single-row run as
 * `fallbackToken`, and the detector resolves both against the disk. So a stitch that guessed wrong
 * costs a `stat` rather than the path that was actually clicked.
 *
 * A quoted span is the one case that beats the run: a path written with spaces can only be read out
 * of the quotes around it. The quote has to open at a token boundary and close before whitespace or
 * sentence punctuation, or every apostrophe in ordinary prose would open a span. One row only - a
 * quoted span broken over two rows is a written limit.
 */
export class TerminalBufferScan {
  /** One class for every agent: the base run plus U+2026 (Claude's elision) and `%` (`file://` escapes). */
  private static readonly pathCharConst = /[a-zA-Z0-9._\-\\/:~…%]/
  private static readonly pathSeparatorConst = /[\\/:]/
  /**
   * What a run has to hold before a stitch is attempted at all.
   *
   * A separator OR a dot, because the two halves of one path are not alike: the half a click
   * lands on can be the TAIL - `1440x770.png`, `iewer.ts` - which carries no separator of its
   * own and was therefore never stitched back onto the half above it. Ordinary prose still
   * fails this, and what actually keeps two unrelated rows apart is `continues` below.
   */
  private static readonly stitchableConst = /[\\/:.]/
  private static readonly whitespaceConst = /\s/
  private static readonly whitespaceOnlyConst = /^\s*$/
  /** A TUI's own left border, which Codex draws down the side of everything it prints. */
  private static readonly gutterConst = /[│┃┆┊▌▍▎▏▐]/
  /** What may stand left of a run on a continuation row: indentation, and at most one border. */
  private static readonly rowPrefixConst = /^\s*(?:[│┃┆┊▌▍▎▏▐]\s*)?$/
  /** Agents print a quoted argument inside a call, `Read("C:\a b\x.md")`, so a bracket opens a span
   *  as much as whitespace does and its partner closes one. */
  private static readonly quoteOpenAfterConst = /[\s([{<]/
  private static readonly quoteCloseFollowConst = /[\s,.)\]}>]/
  /** One cell, because a wide character takes two: a wrapped run can stop one column short of `cols`. */
  private static readonly wrapEdgeToleranceConst = 1

  /**
   * `selection` is left null: what the terminal has selected is the hook's to read, and it reads it
   * from `terminal.getSelection()` at the same moment it calls this.
   */
  static capture(reader: TerminalBufferReader, clientX: number, clientY: number): TerminalMenuCapture {
    const rect = reader.screenRect
    if (rect.width <= 0 || rect.height <= 0) return TerminalBufferScan.captureOf(null, '')
    if (clientX < rect.left || clientX >= rect.left + rect.width) return TerminalBufferScan.captureOf(null, '')
    if (clientY < rect.top || clientY >= rect.top + rect.height) return TerminalBufferScan.captureOf(null, '')
    const column = Math.floor((clientX - rect.left) / (rect.width / reader.cols))
    const row = Math.floor((clientY - rect.top) / (rect.height / reader.rows))
    const bufferRow = row + reader.viewportY
    const clickedRow = reader.row(bufferRow)
    if (clickedRow === null) return TerminalBufferScan.captureOf(null, '')
    const clicked = clickedRow.text

    const rowContext = TerminalBufferScan.contextOf(reader, bufferRow, bufferRow)
    // The column becomes an index HERE and nowhere else. It used to be used as one directly, which
    // is right for a row of plain ASCII and wrong by one per wide or astral character otherwise.
    const clamped = clickedRow.indexAt[column] ?? clicked.length - 1
    if (clamped < 0 || clamped >= clicked.length)
      return TerminalBufferScan.captureOf(null, rowContext)

    const quoted = TerminalBufferScan.quotedSpanAt(clicked, clamped)
    if (quoted !== null) return TerminalBufferScan.captureOf(quoted, rowContext)

    const clickColumn = TerminalBufferScan.runColumnAt(clicked, clamped)
    if (clickColumn === null) return TerminalBufferScan.captureOf(null, rowContext)

    let start = clickColumn
    let end = clickColumn + 1
    while (start > 0 && TerminalBufferScan.pathCharConst.test(clicked[start - 1])) start--
    while (end < clicked.length && TerminalBufferScan.pathCharConst.test(clicked[end])) end++
    let token = clicked.slice(start, end)
    let firstRow = bufferRow
    let lastRow = bufferRow

    // The pre-filter that keeps ordinary prose out: a wrapped sentence whose two halves happen to
    // end and begin with word characters holds neither a separator nor a dot, so it is never
    // stitched. `isWrapped` is deliberately never read - it is false for Ink's own hard wrap, for a
    // hanging indent and for a source that wraps early, which are three of the four cases this has
    // to catch. `plain` is kept because the stitched token never replaces it: both are handed over.
    const plain = token
    if (TerminalBufferScan.stitchableConst.test(token)) {
      let text = clicked
      let runStart = start
      let fragment = end - start
      let currentRow = bufferRow
      let stitched = 0
      while (currentRow > 0
        && stitched < TerminalDetectorLimits.captureStitchRowsMax
        && TerminalBufferScan.rowPrefixConst.test(text.slice(0, runStart))) {
        const previousRow = reader.row(currentRow - 1)
        if (previousRow === null) break
        const previous = previousRow.text
        let previousEnd = previous.length
        while (previousEnd > 0 && TerminalBufferScan.whitespaceConst.test(previous[previousEnd - 1])) previousEnd--
        if (previousEnd === 0 || !TerminalBufferScan.pathCharConst.test(previous[previousEnd - 1])) break
        if (!TerminalBufferScan.continues(previousRow, previousEnd, fragment, reader.cols)) break
        let previousStart = previousEnd - 1
        while (previousStart > 0 && TerminalBufferScan.pathCharConst.test(previous[previousStart - 1])) previousStart--
        token = previous.slice(previousStart, previousEnd) + token
        stitched += 1
        currentRow -= 1
        text = previous
        runStart = previousStart
        fragment = previousEnd - previousStart
      }
      firstRow = currentRow

      text = clicked
      let runEnd = end
      let runRow = clickedRow
      currentRow = bufferRow
      // The cap is the buffer length, not `viewportY + rows`: that is where the VISIBLE region ends,
      // and soft-wrapped output carries on past it.
      stitched = 0
      while (currentRow + 1 < reader.length
        && stitched < TerminalDetectorLimits.captureStitchRowsMax
        && TerminalBufferScan.whitespaceOnlyConst.test(text.slice(runEnd))) {
        const nextRow = reader.row(currentRow + 1)
        if (nextRow === null) break
        const next = nextRow.text
        const nextStart = TerminalBufferScan.fragmentStart(next)
        if (nextStart === null) break
        let nextEnd = nextStart
        while (nextEnd < next.length && TerminalBufferScan.pathCharConst.test(next[nextEnd])) nextEnd++
        if (!TerminalBufferScan.continues(runRow, runEnd, nextEnd - nextStart, reader.cols)) break
        token = token + next.slice(nextStart, nextEnd)
        stitched += 1
        currentRow += 1
        text = next
        runRow = nextRow
        runEnd = nextEnd
      }
      lastRow = currentRow
    }

    // Cut here rather than in the library: the truncation used to happen after the whole thing had
    // been built and structure-cloned across the bridge, so the renderer paid for every character it
    // was about to throw away.
    const cut = token.slice(0, TerminalDetectorLimits.captureTokenCharactersMax)
    return TerminalBufferScan.captureOf(
      cut,
      TerminalBufferScan.contextOf(reader, firstRow, lastRow),
      token === plain ? null : plain.slice(0, TerminalDetectorLimits.captureTokenCharactersMax),
    )
  }

  static readerOf(terminal: Terminal, holder: HTMLElement): TerminalBufferReader {
    const buffer = terminal.buffer.active
    const cols = terminal.cols
    const screen = holder.querySelector('.xterm-screen')
    const rect = screen === null ? null : screen.getBoundingClientRect()
    return {
      row: (row: number): TerminalBufferRow | null => {
        const line = buffer.getLine(row)
        if (line === undefined) return null
        /*
         * Walked cell by cell rather than taken from `translateToString` alone, because the string
         * on its own cannot say which column a character came from. xterm knows - it fills a fourth
         * `outColumns` argument - but that argument is not in the public typings of
         * `@xterm/xterm@6.1.0-beta.287`, and reaching past the typings to get it would be a cast
         * onto an undeclared API. `getCell` says the same thing in public.
         */
        const cell = buffer.getNullCell()
        let text = ''
        const columnAt: number[] = []
        const indexAt: number[] = []
        for (let column = 0; column < cols; column++) {
          line.getCell(column, cell)
          // Width 0 is the second half of a wide character: no characters of its own, and a click on
          // it points at the character that owns it.
          if (cell.getWidth() === 0) {
            indexAt.push(indexAt[indexAt.length - 1] ?? 0)
            continue
          }
          indexAt.push(text.length)
          // An empty cell is one space, which is what `translateToString` writes for it too.
          const chars = cell.getChars() === '' ? ' ' : cell.getChars()
          for (let unit = 0; unit < chars.length; unit++) columnAt.push(column)
          text += chars
        }
        // One past the end, for a run that stopped at the edge of the screen.
        columnAt.push(cols)
        return { text, columnAt, indexAt }
      },
      cols,
      rows: terminal.rows,
      viewportY: buffer.viewportY,
      length: buffer.length,
      screenRect: rect === null
        ? { left: 0, top: 0, width: 0, height: 0 }
        : { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    }
  }

  /** One cell of tolerance to the left, then it gives up: a click on the space beside a path finds it. */
  private static runColumnAt(text: string, column: number): number | null {
    if (TerminalBufferScan.pathCharConst.test(text[column])) return column
    if (column > 0 && TerminalBufferScan.pathCharConst.test(text[column - 1])) return column - 1
    return null
  }

  /**
   * Whether the row could still have carried `fragment` after the run that ends at `runEnd`.
   *
   * `runEnd` is an INDEX; what "the edge" means is a column, and the row is what turns one into the
   * other. The second half is what reads a source that wraps EARLY: Codex breaks at the last
   * opportunity that fits, so its rows stop several columns short of the edge and the fragment below
   * is one that plainly could not have gone there. A column of stacked paths fails it - a second
   * short path would have fitted beside the first - which is what keeps two of them apart.
   */
  private static continues(
    row: TerminalBufferRow,
    runEnd: number,
    fragment: number,
    cols: number,
  ): boolean {
    const column = row.columnAt[runEnd] ?? cols
    if (column >= cols - TerminalBufferScan.wrapEdgeToleranceConst) return true
    return column + fragment > cols
  }

  /**
   * Where a continuation row's fragment starts: past its indentation, and past the frame border a
   * TUI draws down the left of everything it prints. `null` when nothing path-like follows.
   */
  private static fragmentStart(text: string): number | null {
    let index = 0
    while (index < text.length && TerminalBufferScan.whitespaceConst.test(text[index])) index++
    if (index < text.length && TerminalBufferScan.gutterConst.test(text[index])) {
      index += 1
      while (index < text.length && TerminalBufferScan.whitespaceConst.test(text[index])) index++
    }
    if (index >= text.length || !TerminalBufferScan.pathCharConst.test(text[index])) return null
    return index
  }

  private static captureOf(
    token: string | null,
    contextText: string,
    fallbackToken: string | null = null,
  ): TerminalMenuCapture {
    return { token, selection: null, contextText, fallbackToken }
  }

  private static quotedSpanAt(text: string, column: number): string | null {
    for (let index = 0; index < text.length; index++) {
      const quote = text[index]
      if (quote !== '"' && quote !== '\'') continue
      if (index > 0 && !TerminalBufferScan.quoteOpenAfterConst.test(text[index - 1])) continue
      const close = text.indexOf(quote, index + 1)
      if (close < 0) continue
      if (close + 1 < text.length && !TerminalBufferScan.quoteCloseFollowConst.test(text[close + 1])) continue
      if (column < index || column > close) {
        index = close
        continue
      }
      if (close === index + 1) return null
      const span = text.slice(index + 1, close)
      // Nothing without a separator can be a path, and a pair of apostrophes around prose is what a
      // sentence like "don't edit it, it's locked" looks like from here.
      return TerminalBufferScan.pathSeparatorConst.test(span) ? span : null
    }
    return null
  }

  private static contextOf(reader: TerminalBufferReader, firstRow: number, lastRow: number): string {
    const lines: string[] = []
    let held = 0
    for (let row = firstRow; row <= lastRow; row++) {
      const read = reader.row(row)
      if (read === null) continue
      const line = read.text.trimEnd()
      lines.push(line)
      held += line.length + 1
      if (held >= TerminalDetectorLimits.captureContextCharactersMax) break
    }
    return lines.join('\n').slice(0, TerminalDetectorLimits.captureContextCharactersMax)
  }
}
