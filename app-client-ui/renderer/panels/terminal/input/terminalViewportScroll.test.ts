import { describe, expect, it } from 'vitest'

import { TerminalViewportScroll } from './terminalViewportScroll'

describe('app-client-ui/renderer/panels/terminal/terminalViewportScroll', () => {
  function keydown(key: string, modifiers?: Partial<KeyboardEventInit>): KeyboardEvent {
    return new KeyboardEvent('keydown', { key, ...modifiers })
  }

  it('maps Shift+PageUp and Shift+PageDown on the normal buffer to page deltas', () => {
    expect(TerminalViewportScroll.pagesOf(keydown('PageUp', { shiftKey: true }), 'normal')).toBe(-1)
    expect(TerminalViewportScroll.pagesOf(keydown('PageDown', { shiftKey: true }), 'normal')).toBe(1)
  })

  it('leaves Shift+PageUp and Shift+PageDown to alternate-screen applications', () => {
    expect(TerminalViewportScroll.pagesOf(keydown('PageUp', { shiftKey: true }), 'alternate')).toBeNull()
    expect(TerminalViewportScroll.pagesOf(keydown('PageDown', { shiftKey: true }), 'alternate')).toBeNull()
  })

  it('ignores bare PageUp/PageDown, extra modifiers, other keys and keyup', () => {
    for (const event of [
      keydown('PageUp'),
      keydown('PageDown'),
      keydown('PageUp', { shiftKey: true, ctrlKey: true }),
      keydown('PageUp', { shiftKey: true, altKey: true }),
      keydown('PageUp', { shiftKey: true, metaKey: true }),
      keydown('Home', { shiftKey: true }),
      new KeyboardEvent('keyup', { key: 'PageUp', shiftKey: true }),
    ])
      expect(TerminalViewportScroll.pagesOf(event, 'normal')).toBeNull()
  })

  it('refuses an unknown buffer type', () => {
    expect(() => TerminalViewportScroll.pagesOf(
      keydown('PageUp', { shiftKey: true }),
      'other' as unknown as 'normal',
    )).toThrow(/other/)
  })
})
