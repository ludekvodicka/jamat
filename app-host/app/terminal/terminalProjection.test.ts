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
    const snapshot = await projection.snapshot(true)
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
    const pending = busy.snapshot(true)
    // Queued while that snapshot is being answered, which is the state a flood holds a terminal in.
    busy.append('\u001b[31mtwo')
    const behind = await pending

    const settled = new TerminalProjection('runtime-settled', 1, 1, 20, 4)
    settled.append('one\r\n\u001b[31mtwo')
    const caught = await settled.snapshot(true)

    expect(behind.outputSeq).to.equal(caught.outputSeq)
    expect(await TerminalProjectionTest.drawn(behind.screen))
      .to.equal(await TerminalProjectionTest.drawn(caught.screen))
    busy.dispose()
    settled.dispose()
  })
})

/** What a screen looks like once a terminal has drawn it, which is the only thing a client sees. */
class TerminalProjectionTest {
  static async drawn(screen: string): Promise<string> {
    const terminal = new TerminalProjection('runtime-drawn', 1, 1, 20, 4)
    terminal.append(screen)
    const snapshot = await terminal.snapshot(true)
    terminal.dispose()
    return snapshot.screen
  }
}
