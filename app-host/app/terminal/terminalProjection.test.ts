import { describe, expect, it } from 'vitest'

import { TerminalProjection } from './terminalProjection.js'

describe('app-host/app/terminal/terminalProjection', () => {
  /**
   * The width table this projection measures with, which is the only thing here a client can
   * disagree with: the screen serialized out of this buffer is written into the client's.
   *
   * The damage it prevents is a line that wraps one cell early, and that one cannot be asserted
   * through the serializer: it re-emits a wrapped line as continuous text, so a drifted screen and an
   * intact one serialize to the same string. The column addressed below reads the same table where it
   * does leave a mark - in the gap in front of a cell placed by number.
   */
  it('measures an emoji at two cells, the way whatever wrote it did', async () => {
    const projection = new TerminalProjection('runtime-1', 1, 1, 20, 4)
    // Column 9 is addressed outright, so the emoji in front of it is all that decides the gap: four
    // columns behind a two-cell emoji, five behind the one-cell one xterm ships by default.
    projection.append('ab✅\u001b[1;9HZ')
    const snapshot = await projection.snapshot(true, TerminalProjection.attachOptionsConst)
    expect(snapshot.screen).to.include('ab✅\u001b[4CZ')
    projection.dispose()
  })

  /*
   * A snapshot is what an attach waits for, and it used to REJECT when the buffer had not caught up
   * within five seconds. A terminal under a flood never catches up - a ConPTY repaint after a resize
   * is exactly that, and `pendingChars` reaches zero only between writes - so a busy terminal became
   * one nobody could attach to, and the attach died past its own ack with the client believing it
   * had one.
   *
   * It answers now whatever the buffer is doing, and the answer stays whole because the screen and
   * the tail the buffer has not taken are read in the same tick: what the client writes into a reset
   * terminal is the same picture either way, and `outputSeq` names every byte of it. This is that
   * equality, over a projection whose buffer is behind at the moment it is asked.
   */
  it('names every byte and draws the same screen whatever the buffer is doing', async () => {
    const busy = new TerminalProjection('runtime-busy', 1, 1, 20, 4)
    busy.append('one\r\n')
    const pending = busy.snapshot(true, TerminalProjection.attachOptionsConst)
    // Queued while that snapshot is being answered, which is the state a flood holds a terminal in.
    busy.append('\u001b[31mtwo')
    const behind = await pending

    const settled = new TerminalProjection('runtime-settled', 1, 1, 20, 4)
    settled.append('one\r\n\u001b[31mtwo')
    const caught = await settled.snapshot(true, TerminalProjection.attachOptionsConst)

    expect(behind.outputSeq).to.equal(caught.outputSeq)
    expect(await TerminalProjectionTest.drawn(behind.screen))
      .to.equal(await TerminalProjectionTest.drawn(caught.screen))
    busy.dispose()
    settled.dispose()
  })

  /**
   * Three callers, three needs. An attach writes `screen` into a reset terminal and has never read a
   * ring from one; the work-state classifier reads a couple of thousand characters of ring and
   * sixteen rows off the bottom; anything naming no view still gets everything, which is what
   * `runtime.inspect` answered before views existed and what the smokes read.
   */
  it('carries the part of itself each caller reads, and no more', async () => {
    const projection = new TerminalProjection('runtime-view', 1, 1, 20, 4)
    const rows = Array.from({ length: 40 }, (_, row) => `row ${row}\r\n`)
    for (const row of rows) projection.append(row)

    const attached = await projection.snapshot(true, TerminalProjection.attachOptionsConst)
    const whole = await projection.snapshot(true, TerminalProjection.optionsOf(null))
    const viewed = await projection.snapshot(true, TerminalProjection.optionsOf(
      { rawTailChars: 20, screenScrollbackRows: 2 }))

    expect(attached.raw).to.equal(undefined)
    expect(attached.screen).to.include('row 39')
    expect(attached.screen).to.include('row 0')

    expect(whole.raw).to.equal(rows.join(''))

    expect(viewed.raw).to.have.length(20)
    expect(viewed.raw).to.include('39')
    expect(viewed.screen).to.include('row 39')
    expect(viewed.screen).to.not.include('row 20')
    expect(viewed.screen.length).to.be.lessThan(whole.screen.length)

    projection.dispose()
  })

  /**
   * The ceiling belongs to the arm that has no natural one - a ring delta the ring itself has lost,
   * where `screen` IS the ring. A serialized screen is bounded by the buffer that made it, and
   * cutting one at a raw character index can split the `ESC[?1049h ESC[H` the serializer writes in
   * front of an alternate screen: the client then draws that content into its normal buffer.
   */
  it('never cuts a serialized screen, however much of one there is', async () => {
    const projection = new TerminalProjection('runtime-wide', 1, 1, 500, 50)
    // More serialized screen than the 256 KB ceiling the truncated arm carries: a thousand rows of
    // coloured full-width text is what the buffer keeps, and all of it belongs to the client.
    for (let row = 0; row < 1_100; row += 1)
      projection.append(`\u001b[3${row % 8}m${'wide '.repeat(98)}\r\n`)

    const attached = await projection.snapshot(true, TerminalProjection.attachOptionsConst)

    expect(attached.screen.length).to.be.greaterThan(256 * 1_024)
    projection.dispose()
  })
})

/** What a screen looks like once a terminal has drawn it, which is the only thing a client sees. */
class TerminalProjectionTest {
  static async drawn(screen: string): Promise<string> {
    const terminal = new TerminalProjection('runtime-drawn', 1, 1, 20, 4)
    terminal.append(screen)
    const snapshot = await terminal.snapshot(true, TerminalProjection.attachOptionsConst)
    terminal.dispose()
    return snapshot.screen
  }
}
