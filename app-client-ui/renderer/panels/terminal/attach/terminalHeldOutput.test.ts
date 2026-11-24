import { describe, expect, it } from 'vitest'

import { TerminalHeldOutput } from './terminalHeldOutput'

describe('app-client-ui/renderer/panels/terminal/attach/terminalHeldOutput', () => {
  it('hands back what arrived while nobody was looking, once', () => {
    const held = new TerminalHeldOutput()
    held.holdData('one')
    held.holdData('two')

    expect(held.take()).toEqual({ kind: 'data', reset: false, size: null, data: 'onetwo' })
    expect(held.take()).toBeNull()
  })

  // A snapshot is the Host saying "forget what you had": what was held before it is not part of the
  // screen it describes, and writing both would draw the same output twice.
  it('drops what a snapshot supersedes and carries its geometry', () => {
    const held = new TerminalHeldOutput()
    held.holdData('before')
    held.holdSnapshot(80, 24, 'screen')
    held.holdData('after')

    expect(held.take()).toEqual({ kind: 'data', reset: true, size: { cols: 80, rows: 24 }, data: 'screenafter' })
  })

  /**
   * Past the bound, dropping the raw bytes and signalling overflow lets the panel request a clean
   * serialized snapshot from the Host on reveal instead of wiping xterm's scrollback with a blind
   * mid-sequence raw tail.
   */
  it('drops buffered bytes and reports overflow once it outgrows its bound', () => {
    const held = new TerminalHeldOutput()
    held.holdData('x'.repeat(TerminalHeldOutput.maxCharsConst))
    expect(held.isOverflowed).toBe(false)

    held.holdData('1')
    expect(held.isOverflowed).toBe(true)
    expect(held.empty).toBe(false)

    held.holdData('ignored while overflowed')
    expect(held.take()).toEqual({ kind: 'overflow' })
    expect(held.isOverflowed).toBe(false)
    expect(held.take()).toBeNull()
  })

  it('clears overflow when superseded by an in-bound snapshot', () => {
    const held = new TerminalHeldOutput()
    held.holdData('x'.repeat(TerminalHeldOutput.maxCharsConst + 1))
    expect(held.isOverflowed).toBe(true)

    held.holdSnapshot(100, 30, 'clean')
    expect(held.isOverflowed).toBe(false)
    expect(held.take()).toEqual({ kind: 'data', reset: true, size: { cols: 100, rows: 30 }, data: 'clean' })
  })

  it('keeps up to the full bound without overflowing', () => {
    const held = new TerminalHeldOutput()
    const payload = 'x'.repeat(TerminalHeldOutput.maxCharsConst)
    held.holdData(payload)

    expect(held.take()).toEqual({ kind: 'data', reset: false, size: null, data: payload })
  })

  it('says nothing happened when nothing did', () => {
    expect(new TerminalHeldOutput().take()).toBeNull()
  })
})
