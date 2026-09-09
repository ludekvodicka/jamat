import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'

import { TerminalUnicode } from './terminalUnicode'

/**
 * The bug itself, over a REAL terminal: a row that fills the screen exactly, followed by the next row
 * with no newline between them, which is how an agent repaints a framed table. Measured with the
 * table xterm ships, the emoji costs one cell instead of two, the row ends a column early, and the
 * first character of the row after it is pulled onto the end of this one - the drift a person sees as
 * a table walking left down the screen.
 *
 * A terminal fills its buffer without `open()`, so nothing here needs a renderer or a layout.
 */
describe('app-client-ui/renderer/panels/terminal/terminalUnicode', () => {
  const colsConst = 10
  const terminals: Terminal[] = []

  afterEach(() => {
    for (const terminal of terminals.splice(0)) terminal.dispose()
  })

  async function screenOf(text: string, applied: boolean): Promise<string[]> {
    const terminal = new Terminal({ cols: colsConst, rows: 4, allowProposedApi: true })
    terminals.push(terminal)
    if (applied) TerminalUnicode.apply(terminal)
    await new Promise<void>((resolve) => terminal.write(text, resolve))
    const buffer = terminal.buffer.active
    return [0, 1].map((row) => buffer.getLine(row)?.translateToString(true) ?? '')
  }

  it('keeps a full row that ends in an emoji from stealing the next row', async () => {
    expect(await screenOf('ab✅cdefghXY', true)).toEqual(['ab✅cdefgh', 'XY'])
  })

  it('is what stops it: the same write drifts on the table xterm ships', async () => {
    expect(await screenOf('ab✅cdefghXY', false)).toEqual(['ab✅cdefghX', 'Y'])
  })
})
