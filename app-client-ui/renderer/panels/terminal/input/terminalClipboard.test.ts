import { afterEach, describe, expect, it, vi } from 'vitest'

import { TerminalClipboard } from './terminalClipboard'

describe('app-client-ui/renderer/panels/terminal/terminalClipboard', () => {
  function osc52Of(text: string, targets = 'c'): string {
    const bytes = new TextEncoder().encode(text)
    const binary = String.fromCharCode(...bytes)
    return `${targets};${btoa(binary)}`
  }

  it('wraps a paste in the markers that stop a shell from running it', () => {
    expect(TerminalClipboard.pasteOf('first\nsecond'))
      .toBe('\x1b[200~first\nsecond\x1b[201~')
  })

  it('has nothing to paste for an empty clipboard', () => {
    expect(TerminalClipboard.pasteOf('')).toBeNull()
  })

  /**
   * The whole point of the second paste: one big bracketed paste is what Claude Code collapses into
   * a `[Pasted text +N lines]` placeholder, so each line arrives as a paste of its own, spaced out,
   * with the break carried INSIDE the paste where it cannot submit the prompt.
   */
  describe('pasting as text, a line at a time', () => {
    afterEach(() => { vi.useRealTimers() })

    it('sends one small bracketed paste per line, in order, spaced by the delay', () => {
      vi.useFakeTimers()
      const written: string[] = []

      TerminalClipboard.pasteAsTextByLines('one\r\ntwo\nthree', (data) => written.push(data))

      expect(written).toEqual(['\x1b[200~one\n\x1b[201~'])
      vi.advanceTimersByTime(10)
      expect(written).toEqual(['\x1b[200~one\n\x1b[201~', '\x1b[200~two\n\x1b[201~'])
      vi.advanceTimersByTime(10)
      // The last line carries no newline: one there would be a blank line in the prompt.
      expect(written).toEqual([
        '\x1b[200~one\n\x1b[201~',
        '\x1b[200~two\n\x1b[201~',
        '\x1b[200~three\x1b[201~',
      ])
      vi.advanceTimersByTime(100)
      expect(written).toHaveLength(3)
    })

    it('sends a single line as one paste and nothing after it', () => {
      vi.useFakeTimers()
      const written: string[] = []

      TerminalClipboard.pasteAsTextByLines('d:\\shots\\one.png', (data) => written.push(data))

      vi.advanceTimersByTime(100)
      expect(written).toEqual(['\x1b[200~d:\\shots\\one.png\x1b[201~'])
    })

    it('writes nothing at all for an empty clipboard', () => {
      const written: string[] = []
      TerminalClipboard.pasteAsTextByLines('', (data) => written.push(data))
      expect(written).toEqual([])
    })

    // The run outlives the click that started it, and the attach it writes into may not: what comes
    // back is the way the caller stops it.
    it('stops where it was cancelled and writes no line after that', () => {
      vi.useFakeTimers()
      const written: string[] = []

      const cancel = TerminalClipboard.pasteAsTextByLines('one\ntwo\nthree', (data) =>
        written.push(data))
      vi.advanceTimersByTime(10)
      cancel()
      vi.advanceTimersByTime(1000)

      expect(written).toEqual(['\x1b[200~one\n\x1b[201~', '\x1b[200~two\n\x1b[201~'])
    })

    it('has nothing to cancel once every line has gone', () => {
      vi.useFakeTimers()
      const written: string[] = []

      const cancel = TerminalClipboard.pasteAsTextByLines('one\ntwo', (data) => written.push(data))
      vi.advanceTimersByTime(1000)
      cancel()

      expect(written).toHaveLength(2)
    })

    /**
     * Past the cap the clipboard is a file rather than a prompt: 200 lines already spend two seconds
     * writing into an attach that can be released meanwhile. Nothing is dropped - it goes in as the
     * one paste `Paste` sends.
     */
    it('sends a clipboard past the line cap as the single paste instead', () => {
      vi.useFakeTimers()
      const written: string[] = []
      const text = Array.from({ length: 201 }, (_, index) => `line ${index}`).join('\n')

      TerminalClipboard.pasteAsTextByLines(text, (data) => written.push(data))
      vi.advanceTimersByTime(10_000)

      expect(written).toEqual([`\x1b[200~${text}\x1b[201~`])
    })

    it('still goes line by line at the cap itself', () => {
      vi.useFakeTimers()
      const written: string[] = []
      const text = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n')

      TerminalClipboard.pasteAsTextByLines(text, (data) => written.push(data))
      vi.advanceTimersByTime(10_000)

      expect(written).toHaveLength(200)
    })
  })

  it('strips the quote gutter a TUI drew, per line and only leading', () => {
    expect(TerminalClipboard.withoutQuoteGutter('│ quoted\n│ more\nplain'))
      .toBe('quoted\nmore\nplain')
    expect(TerminalClipboard.withoutQuoteGutter('| ascii gutter')).toBe('ascii gutter')
    // No space after the bar, and a bar that is not at the start: one is a gutter, one is content.
    expect(TerminalClipboard.withoutQuoteGutter('│tight')).toBe('tight')
    expect(TerminalClipboard.withoutQuoteGutter('a | b')).toBe('a | b')
  })

  it('decodes an OSC 52 copy as the escape carried it', () => {
    expect(TerminalClipboard.textOfOsc52(osc52Of('copied from the TUI')))
      .toBe('copied from the TUI')
    expect(TerminalClipboard.textOfOsc52(osc52Of('ěščř unicode'))).toBe('ěščř unicode')
  })

  it('reads a payload that carries no target list', () => {
    expect(TerminalClipboard.textOfOsc52(btoa('no targets'))).toBe('no targets')
  })

  // A query is the escape asking to READ the clipboard. Answering it would hand whatever the user
  // has copied to the process inside the terminal, so it is ignored rather than served.
  it('puts nothing on the clipboard for a query or an empty payload', () => {
    expect(TerminalClipboard.textOfOsc52('c;?')).toBeNull()
    expect(TerminalClipboard.textOfOsc52('c;')).toBeNull()
    expect(TerminalClipboard.textOfOsc52('')).toBeNull()
    expect(TerminalClipboard.textOfOsc52(osc52Of(''))).toBeNull()
  })

  /**
   * The payload is written by whatever runs in the terminal, and xterm lets an OSC carry megabytes.
   * Decoded, that was a character-by-character pass on the drawing thread and then the user's
   * clipboard, from a tab that did not have to be visible or focused.
   */
  it('refuses a payload larger than a copy could be, before decoding any of it', () => {
    const huge = btoa('x'.repeat(600 * 1024))

    expect(TerminalClipboard.textOfOsc52(`c;${huge}`)).toBeNull()
    expect(TerminalClipboard.textOfOsc52(`c;${btoa('x'.repeat(1024))}`))
      .toBe('x'.repeat(1024))
  })

  it('survives a malformed escape instead of throwing into xterm\'s parser', () => {
    expect(TerminalClipboard.textOfOsc52('c;not base64 at all!!')).toBeNull()
  })

  it('reads Ctrl+V and Ctrl+Shift+V as paste, and nothing else as paste', () => {
    const paste = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)
    expect(TerminalClipboard.isPasteKey(paste({ key: 'v', ctrlKey: true }))).toBe(true)
    expect(TerminalClipboard.isPasteKey(paste({ key: 'V', ctrlKey: true, shiftKey: true })))
      .toBe(true)
    expect(TerminalClipboard.isPasteKey(paste({ key: 'v' }))).toBe(false)
    expect(TerminalClipboard.isPasteKey(paste({ key: 'v', ctrlKey: true, altKey: true })))
      .toBe(false)
    expect(TerminalClipboard.isPasteKey(new KeyboardEvent('keyup', { key: 'v', ctrlKey: true })))
      .toBe(false)
  })

  it('reads a bare Ctrl+C as the copy key, and a modified one as somebody else\'s', () => {
    const copy = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)
    expect(TerminalClipboard.isCopyKey(copy({ key: 'c', ctrlKey: true }))).toBe(true)
    expect(TerminalClipboard.isCopyKey(copy({ key: 'C', ctrlKey: true, shiftKey: true })))
      .toBe(false)
    expect(TerminalClipboard.isCopyKey(copy({ key: 'c' }))).toBe(false)
  })
})
