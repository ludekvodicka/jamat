import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'

import { TerminalBufferScan } from './terminalBufferScan'

/**
 * `TerminalBufferScan.readerOf` over a REAL `@xterm/xterm` terminal, which nothing drove before.
 *
 * Every other test in this area builds a reader of its own, so what `readerOf` actually returns was
 * assumed. Two things rested on that assumption and both were wrong:
 *
 * - the row is not trimmed, so a click in the right-hand padding lands on a space rather than being
 *   snapped onto the last character of the row. Changing the `false` to `true` used to leave 99
 *   tests passing, and a trimmed row turns a right click on empty space into a token nobody pointed
 *   at - which the main process would then open in a tab or in VS Code.
 * - a grid column is not a string index. `你` takes two columns and one code unit, `🎉` takes one
 *   column and two, so on such a row everything right of it was off by one, in either direction.
 *
 * A real terminal fills its buffer without `open()`, so this needs no renderer and no layout - only
 * the cells, which is all the reader looks at.
 */
describe('app-client-ui/renderer/panels/terminal/terminalBufferReader', () => {
  const colsConst = 20
  const rowsConst = 6
  const cellConst = 10
  const terminals: Terminal[] = []

  afterEach(() => {
    for (const terminal of terminals.splice(0)) terminal.dispose()
  })

  /** A holder whose `.xterm-screen` answers a real rect: jsdom gives zeros unless it is told. */
  function holderOf(): HTMLElement {
    const holder = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    screen.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: colsConst * cellConst,
      height: rowsConst * cellConst,
      right: colsConst * cellConst,
      bottom: rowsConst * cellConst,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    holder.appendChild(screen)
    return holder
  }

  async function terminalWith(text: string): Promise<Terminal> {
    const terminal = new Terminal({ cols: colsConst, rows: rowsConst, allowProposedApi: true })
    terminals.push(terminal)
    await new Promise<void>((resolve) => terminal.write(text, resolve))
    return terminal
  }

  async function readerWith(text: string): Promise<ReturnType<typeof TerminalBufferScan.readerOf>> {
    return TerminalBufferScan.readerOf(await terminalWith(text), holderOf())
  }

  /** The click at the centre of a cell, the way a real pointer lands inside one. */
  function captureAt(
    reader: ReturnType<typeof TerminalBufferScan.readerOf>,
    column: number,
    row = 0,
  ): ReturnType<typeof TerminalBufferScan.capture> {
    return TerminalBufferScan.capture(
      reader,
      column * cellConst + cellConst / 2,
      row * cellConst + cellConst / 2,
    )
  }

  it('hands a row over untrimmed, so the padding is still there to click on', async () => {
    const reader = await readerWith('a.ts')

    const read = reader.row(0)
    if (read === null) throw new Error('The terminal wrote no row')
    expect(read.text).toBe('a.ts'.padEnd(colsConst))
    expect(read.text).toHaveLength(colsConst)
  })

  /*
   * The whole reason the row is not trimmed. With a trimmed row the clamp snaps this click onto the
   * `s` of `a.ts` and answers a token the person never pointed at.
   */
  it('finds nothing under a click in the empty space right of a short row', async () => {
    const reader = await readerWith('a.ts')

    expect(captureAt(reader, 12).token).toBeNull()
  })

  it('finds the token under a click that is on it', async () => {
    const reader = await readerWith('see src/a.ts here')

    expect(captureAt(reader, 5).token).toBe('src/a.ts')
  })

  /*
   * The column maths. `你好` occupies four columns and two code units, so `a.ts` begins at column 5
   * and at index 3 - and reading the column as an index answered from two characters to the left.
   */
  it('finds the token right of a wide character, where the index is not the column', async () => {
    const reader = await readerWith('你好 src/a.ts')

    const read = reader.row(0)
    if (read === null) throw new Error('The terminal wrote no row')
    expect(read.text.startsWith('你好 src/a.ts')).toBe(true)
    // Two columns each, and the second column of each is a cell with no characters of its own.
    expect(read.indexAt.slice(0, 6)).toEqual([0, 0, 1, 1, 2, 3])
    expect(captureAt(reader, 7).token).toBe('src/a.ts')
  })

  /*
   * The one that separates the two readings rather than merely shifting inside one token. Four
   * wide characters put eight columns over four code units, so the click lands four to the
   * right: on the row below, reading the column as an index answers the SECOND path where the
   * person pointed at the first, and the menu then offers to open a file nobody asked about.
   */
  it('answers the token pointed at, not the one four columns of CJK to the right', async () => {
    const reader = await readerWith('你好世界 aa.ts bbbbb.ts')

    // Column 11 is the `.` of `aa.ts`; index 11 is the first `b` of `bbbbb.ts`.
    expect(captureAt(reader, 11).token).toBe('aa.ts')
  })

  // The other direction: one column, two code units. Everything right of it shifts the other way.
  it('finds the token right of an astral character', async () => {
    const reader = await readerWith('🎉 src/a.ts')

    expect(captureAt(reader, 4).token).toBe('src/a.ts')
  })

  /*
   * A run that reaches the edge is what makes the scan stitch the next row onto it. "The edge" is a
   * column, and the run's end is an index; on a row of wide characters the two differ by the number
   * of them, so a wrapped path used to split silently.
   */
  it('stitches a path wrapped after a row of wide characters', async () => {
    // Five columns of CJK and a space, then a path that fills the row exactly and carries on below.
    const reader = await readerWith('你好 Q:/aaaa/bbbbbbb\r\nend.ts more')

    const read = reader.row(0)
    if (read === null) throw new Error('The terminal wrote no row')
    expect(read.columnAt[read.text.length]).toBe(colsConst)
    expect(captureAt(reader, 8).token).toBe('Q:/aaaa/bbbbbbbend.ts')
  })

  it('answers nothing for a click outside the screen rect', async () => {
    const reader = await readerWith('a.ts')

    expect(TerminalBufferScan.capture(reader, -1, 5).token).toBeNull()
    expect(TerminalBufferScan.capture(reader, colsConst * cellConst + 1, 5).token).toBeNull()
  })
})
