import { describe, expect, it } from 'vitest'

import { TerminalPromptNewline } from './terminalPromptNewline'

describe('app-client-ui/renderer/panels/terminal/terminalPromptNewline', () => {
  function keydown(key: string, modifiers?: Partial<KeyboardEventInit>): KeyboardEvent {
    return new KeyboardEvent('keydown', { key, ...modifiers })
  }

  it('spells the newline each agent reads', () => {
    expect(TerminalPromptNewline.sequenceOf(keydown('Enter', { shiftKey: true }), 'claude'))
      .toBe('\x1b[13;2u')
    // Not a bare LF: ConPTY delivers that as Ctrl+Enter, and Codex reads console records.
    expect(TerminalPromptNewline.sequenceOf(keydown('Enter', { shiftKey: true }), 'codex'))
      .toBe('\x1b[74;36;10;1;8;1_')
  })

  // The shell's Enter submits the line, and a session with no agent has nothing else to mean by it.
  it('spells nothing for a session with no agent behind it', () => {
    expect(TerminalPromptNewline.sequenceOf(keydown('Enter', { shiftKey: true }), null)).toBeNull()
  })

  it('answers only for Shift+Enter going down, and only on its own', () => {
    for (const event of [
      keydown('Enter'),
      keydown('a', { shiftKey: true }),
      keydown('Enter', { shiftKey: true, ctrlKey: true }),
      keydown('Enter', { shiftKey: true, altKey: true }),
      keydown('Enter', { shiftKey: true, metaKey: true }),
      new KeyboardEvent('keyup', { key: 'Enter', shiftKey: true }),
    ])
      expect(TerminalPromptNewline.sequenceOf(event, 'claude')).toBeNull()
  })

  it('refuses an agent it has no newline for', () => {
    expect(() => TerminalPromptNewline.sequenceOf(
      keydown('Enter', { shiftKey: true }),
      'gemini' as unknown as 'claude',
    )).toThrow(/gemini/)
  })
})
