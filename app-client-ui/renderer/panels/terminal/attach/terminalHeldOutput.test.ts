import { describe, expect, it } from 'vitest'

import { TerminalHeldOutput } from './terminalHeldOutput'

describe('app-client-ui/renderer/panels/terminal/attach/terminalHeldOutput', () => {
  it('hands back what arrived while nobody was looking, once', () => {
    const held = new TerminalHeldOutput()
    held.holdData('one')
    held.holdData('two')

    expect(held.take()).toEqual({ reset: false, size: null, data: 'onetwo' })
    expect(held.take()).toBeNull()
  })

  // A snapshot is the Host saying "forget what you had": what was held before it is not part of the
  // screen it describes, and writing both would draw the same output twice.
  it('drops what a snapshot supersedes and carries its geometry', () => {
    const held = new TerminalHeldOutput()
    held.holdData('before')
    held.holdSnapshot(80, 24, 'screen')
    held.holdData('after')

    expect(held.take()).toEqual({ reset: true, size: { cols: 80, rows: 24 }, data: 'screenafter' })
  })

  /**
   * The bound is what keeps a hidden tab from holding a night of output in memory. Past it the
   * oldest characters go and the flush resets first - a screen starting mid-sequence is what the
   * Host's own truncation produces, and the next thing the agent draws repaints it.
   */
  it('keeps the tail and asks for a reset once it has outgrown its bound', () => {
    const held = new TerminalHeldOutput()
    held.holdData('x'.repeat(TerminalHeldOutput.maxCharsConst * 2))
    held.holdData('tail')

    // Cut back to the bound when it was passed, and what arrived after the cut is on the end of it.
    const flush = held.take()
    expect(flush?.reset).toBe(true)
    expect(flush?.data).toHaveLength(TerminalHeldOutput.maxCharsConst + 'tail'.length)
    expect(flush?.data.endsWith('tail')).toBe(true)
  })

  /**
   * The slack is what keeps the cut from happening on every frame: cutting means flattening the
   * rope `data +=` builds, and a hidden panel printing a build log would pay half a megabyte of copy
   * per frame - on the thread this class exists to keep free.
   */
  it('runs past its bound before cutting, so the cut is not paid for on every frame', () => {
    const held = new TerminalHeldOutput()
    held.holdData('x'.repeat(TerminalHeldOutput.maxCharsConst))
    held.holdData('tail')

    const flush = held.take()
    expect(flush?.reset).toBe(false)
    expect(flush?.data).toHaveLength(TerminalHeldOutput.maxCharsConst + 4)
  })

  it('says nothing happened when nothing did', () => {
    expect(new TerminalHeldOutput().take()).toBeNull()
  })
})
