import { describe, expect, it } from 'vitest'

import { ScreenTail } from './screenTail'

describe('lib-orchestrator/sessionManager/workState/screenTail', () => {
  const colsConst = 120

  function screenOf(rowCount: number): string {
    return Array.from({ length: rowCount }, (_value, index) => `row ${index + 1}`).join('\r\n')
  }

  function linesOf(text: string): string[] {
    return text.split(/\r?\n/)
  }

  it('reads the last eight rows into the shallow window and the last sixteen into the wide one', () => {
    const screen = screenOf(40)
    expect(linesOf(ScreenTail.rows(screen, ScreenTail.screenRowsConst, colsConst))).toHaveLength(8)
    expect(linesOf(ScreenTail.rows(screen, ScreenTail.screenRowsConst, colsConst))[0]).toBe('row 33')
    expect(linesOf(ScreenTail.rows(screen, ScreenTail.wideScreenRowsConst, colsConst))[0])
      .toBe('row 25')
  })

  it('returns the whole screen when it is shorter than the window', () => {
    expect(ScreenTail.rows('one\ntwo', ScreenTail.screenRowsConst, colsConst)).toBe('one\ntwo')
  })

  // The status line of an agent TUI sits at the bottom of the viewport, under whatever blank rows the
  // conversation left above it. Trimming them would move the window off the region it exists to read.
  it('keeps empty rows, because the window is physical rows and not content', () => {
    expect(ScreenTail.rows('busy\n\n\n', 3, colsConst)).toBe('\n\n')
  })

  it('splits on \\r\\n and on \\n alike: a serialized screen carries both', () => {
    expect(ScreenTail.rows('a\r\nb\nc', 2, colsConst)).toBe('b\nc')
  })

  /*
   * The whole reason this window is measured rather than split. `SerializeAddon` emits no break
   * between a row and its wrapped continuation, so a line of prose four times the terminal's width
   * is one chunk of text and four rows of screen.
   */
  it('counts a wrapped line as the several rows it occupies', () => {
    const screen = 'abcdefghijklmnopqrstuvwxyz'
    expect(ScreenTail.rows(screen, 2, 10)).toBe('klmnopqrst\nuvwxyz')
    expect(ScreenTail.rows(screen, 1, 10)).toBe('uvwxyz')
  })

  /*
   * Counting a wrap without spelling it into the returned window loses the very boundary the
   * classifier asked `rows` to recover. A status ending on one physical row then runs straight into
   * the prompt on the next and cannot satisfy its end-of-row guard.
   */
  it('materializes physical wrap boundaries in the classification window', () => {
    const status = '• Working (9s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close'
    const cols = 103
    const screen = `${status.padEnd(Math.ceil(status.length / cols) * cols)}› Ask Codex to do anything`

    const tail = ScreenTail.rows(screen, 3, cols)
    expect(tail).toContain('/stop to close')
    expect(tail).toContain('\n› Ask Codex to do anything')
  })

  /*
   * Reaching the final column only arms terminal autowrap. A following CRLF consumes one row, not
   * the speculative wrapped row plus a second empty one. SerializeAddon commonly pads Codex rows
   * to exactly this boundary.
   */
  it('does not count a full-width serialized row twice when CRLF follows it', () => {
    const screen = `${'a'.repeat(10)}\r\n${'b'.repeat(10)}\r\nstatus`
    expect(ScreenTail.rows(screen, 3, 10)).toBe(`${'a'.repeat(10)}\n${'b'.repeat(10)}\nstatus`)
    expect(ScreenTail.rows(screen, 2, 10)).toBe(`${'b'.repeat(10)}\nstatus`)
  })

  it('counts a cursor-forward escape as the cells it skips', () => {
    expect(ScreenTail.rows('ab\x1b[7Ccd', 1, 10)).toBe('d')
  })

  /*
   * The serializer forces a wrap by writing a filler character in the last column and erasing it
   * again with `ESC[1D ESC[1X`. The move back belongs to the row that just ended, so the row after
   * it starts at column zero and not one short of the far edge.
   */
  it('keeps a forced wrap on the row it opens', () => {
    const screen = 'abcde\x1b[1D\x1b[1Xxy'
    expect(ScreenTail.stripAnsiLower(ScreenTail.rows(screen, 1, 5))).toBe('xy')
  })

  /*
   * A tall Codex viewport can serialize unused rows after its footer and then restore the cursor
   * with CSI A. Those rows are below the active TUI. Without that final upward move, the same blank
   * rows remain authoritative and keep old text out of the status window.
   */
  it('anchors the tail above unused viewport rows only when the cursor is restored upward', () => {
    const width = 80
    const working = '◦ Working (4m 30s • esc to interrupt)'.padEnd(width)
    const prompt = '› Ask Codex to do anything'.padEnd(width)
    const footer = '  gpt-5.6-sol max · C:\\Projects\\NodeJs\\AppSecretKeeperV2'.padEnd(width)
    const active = [working, '', '', prompt, '', footer].join('\r\n')
    const unused = Array.from({ length: 20 }, () => '').join('\r\n')
    const restored = `${active}\r\n${unused}\x1b[14A\x1b[2C\x1b[0m\x1b[?2004h`
    const stale = `${active}\r\n${unused}`

    expect(ScreenTail.normalizeTty(ScreenTail.rows(restored, 8, width))).toContain('working')
    expect(ScreenTail.normalizeTty(ScreenTail.rows(restored, 8, width)))
      .toContain('askcodextodoanything')
    expect(ScreenTail.normalizeTty(ScreenTail.rows(stale, 8, width))).not.toContain('working')
  })

  it('ignores a cursor restoration from the inactive normal buffer', () => {
    const width = 40
    const normal = `old normal buffer${' '.repeat(23)}\r\n\r\n\x1b[2A`
    const alternate = [
      '◦ Working (30s • esc to interrupt)',
      ...Array.from({ length: 20 }, () => ''),
    ].join('\r\n')
    const screen = `${normal}\x1b[?1049h\x1b[H${alternate}`

    expect(ScreenTail.normalizeTty(ScreenTail.rows(screen, 8, width))).not.toContain('working')
  })

  it('caps the raw window and leaves a short one whole', () => {
    const long = 'x'.repeat(ScreenTail.rawCharsConst + 500)
    expect(ScreenTail.rawTail(long)).toHaveLength(ScreenTail.rawCharsConst)
    expect(ScreenTail.rawTail(`${long}tail`).endsWith('tail')).toBe(true)
    expect(ScreenTail.rawTail('short')).toBe('short')
  })

  it('strips ansi and lowercases, and normalizeTty also removes every space', () => {
    const painted = '\x1b[2K\x1b[1;32m\x1b]0;window title\x07Esc To Interrupt\x1b[0m'
    expect(ScreenTail.stripAnsiLower(painted)).toBe('esc to interrupt')
    expect(ScreenTail.normalizeTty('Esc To\n  Interrupt\r')).toBe('esctointerrupt')
  })

  it('builds all three windows from one projection', () => {
    const frame = ScreenTail.frameOf({ raw: 'output', screen: screenOf(20), cols: colsConst })
    expect(frame.rawTail).toBe('output')
    expect(linesOf(frame.screenTail)).toHaveLength(8)
    expect(linesOf(frame.wideScreenTail)).toHaveLength(16)
  })

  /*
   * The recorded failure, reduced. A transcript of wrapped prose carries the echo of a user message
   * that opened with a numbered list; `> 1.` is the selected menu row the prompt family trusts from
   * the shallow window, so a screen that hands the whole transcript over as eight "rows" makes a
   * working session draw the waiting diamond. Measured against `cols`, the echo sits where it
   * really is - far above the status line - and only the status region reaches the window.
   */
  it('leaves a wrapped transcript above the shallow window', () => {
    const prose = 'the quick brown fox jumps over the lazy dog and keeps going. '.repeat(6)
    const screen = `${prose}\r\n> 1. opraveno.\r\n${prose}\r\nesc to interrupt`
    const shallow = ScreenTail.rows(screen, ScreenTail.screenRowsConst, 40)
    expect(ScreenTail.normalizeTty(shallow)).toContain('esctointerrupt')
    expect(/[>❯]\d+\./.test(ScreenTail.normalizeTty(shallow))).toBe(false)
  })
})
