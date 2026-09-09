import { describe, expect, it } from 'vitest'

import { TerminalDraft } from './terminalDraft'

describe('app-client-ui/renderer/panels/terminal/input/terminalDraft', () => {
  it('counts what was written and takes back what was deleted', () => {
    expect(TerminalDraft.after(0, 'a')).toBe(1)
    expect(TerminalDraft.after(3, 'bc')).toBe(5)
    expect(TerminalDraft.after(5, '\x7f')).toBe(4)
    expect(TerminalDraft.after(1, '\x08')).toBe(0)
  })

  it('never falls below an empty line', () => {
    expect(TerminalDraft.after(0, '\x7f')).toBe(0)
    expect(TerminalDraft.after(1, '\x7f\x7f\x7f')).toBe(0)
  })

  it('reads Enter as the submit that empties the line', () => {
    expect(TerminalDraft.after(12, '\r')).toBe(0)
  })

  it('reads Ctrl+C, Ctrl+U and a bare Escape as the line being cleared', () => {
    expect(TerminalDraft.after(12, '\x03')).toBe(0)
    expect(TerminalDraft.after(12, '\x15')).toBe(0)
    expect(TerminalDraft.after(12, '\x1b')).toBe(0)
  })

  /** The record `TerminalInterrupt` writes for a physical Escape, which Codex reads as one. */
  it("reads Codex's Escape record as the line being cleared", () => {
    expect(TerminalDraft.after(12, '\x1b[27;1;27;1;0;1_')).toBe(0)
  })

  /** Shift+Enter puts a line into the prompt instead of submitting it, so it is one more character. */
  it('reads both spellings of the prompt newline as a character', () => {
    expect(TerminalDraft.after(4, '\x1b[13;2u')).toBe(5)
    expect(TerminalDraft.after(4, '\x1b[74;36;10;1;8;1_')).toBe(5)
  })

  it('counts nothing for keys that only move the caret', () => {
    expect(TerminalDraft.after(4, '\x1b[A')).toBe(4)
    expect(TerminalDraft.after(4, '\x1b[1;5D')).toBe(4)
    expect(TerminalDraft.after(4, '\x1bOP')).toBe(4)
  })

  it('does not mistake mouse reports or terminal replies for prompt text', () => {
    expect(TerminalDraft.after(0, '\x1b[<0;40;12M')).toBe(0)
    expect(TerminalDraft.after(0, '\x1b[<0;40;12m')).toBe(0)
    expect(TerminalDraft.after(0, '\x1b[>0;276;0c')).toBe(0)
    expect(TerminalDraft.after(4, '\x1b]11;rgb:0000/0000/0000\x1b\\')).toBe(4)
  })

  /**
   * A paste arrives as one chunk wrapped in the bracketed-paste markers, and it is the case the
   * whole rule exists for: somebody pastes a prompt, walks off, and nothing may be written over it.
   */
  it('counts the text inside a bracketed paste', () => {
    expect(TerminalDraft.after(0, '\x1b[200~hello\x1b[201~')).toBe(5)
  })

  it('counts a character and not its code units', () => {
    expect(TerminalDraft.after(0, '🎉')).toBe(1)
    expect(TerminalDraft.after(0, 'ěš')).toBe(2)
  })
})
