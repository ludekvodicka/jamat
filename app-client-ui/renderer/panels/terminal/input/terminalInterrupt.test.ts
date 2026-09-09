import { describe, expect, it } from 'vitest'

import { TerminalInterrupt } from './terminalInterrupt'

describe('app-client-ui/renderer/panels/terminal/terminalInterrupt', () => {
  function keydown(key: string, modifiers?: Partial<KeyboardEventInit>): KeyboardEvent {
    return new KeyboardEvent('keydown', { key, ...modifiers })
  }

  it('spells bare Escape as the console record Codex reads', () => {
    expect(TerminalInterrupt.sequenceOf(keydown('Escape'), 'codex'))
      .toBe('\x1b[27;1;27;1;0;1_')
  })

  it('leaves Escape to xterm outside a Codex session', () => {
    expect(TerminalInterrupt.sequenceOf(keydown('Escape'), 'claude')).toBeNull()
    expect(TerminalInterrupt.sequenceOf(keydown('Escape'), null)).toBeNull()
  })

  it('answers only for bare Escape going down', () => {
    for (const event of [
      keydown('Enter'),
      keydown('Escape', { ctrlKey: true }),
      keydown('Escape', { altKey: true }),
      keydown('Escape', { shiftKey: true }),
      keydown('Escape', { metaKey: true }),
      new KeyboardEvent('keyup', { key: 'Escape' }),
    ])
      expect(TerminalInterrupt.sequenceOf(event, 'codex')).toBeNull()
  })

  it('refuses an agent it has no interrupt spelling for', () => {
    expect(() => TerminalInterrupt.sequenceOf(
      keydown('Escape'),
      'gemini' as unknown as 'claude',
    )).toThrow(/gemini/)
  })
})
