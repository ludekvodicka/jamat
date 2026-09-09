import { describe, expect, it } from 'vitest'

import type { TerminalMenuCapture } from '../../../../../lib-orchestrator/terminalDetector/terminalDetectorApi.types'
import { TerminalDetectorLimits } from '../../../../../lib-orchestrator/terminalDetector/terminalDetectorLimits'
import { type TerminalBufferReader, TerminalBufferScan } from './terminalBufferScan'

describe('app-client-ui/renderer/panels/terminal/terminalBufferScan', () => {
  const cellWidthConst = 10
  const cellHeightConst = 20

  interface Screen {
    rows: readonly string[]
    cols?: number
    terminalRows?: number
    viewportY?: number
  }

  function readerOf(screen: Screen): TerminalBufferReader {
    const cols = screen.cols ?? 40
    const terminalRows = screen.terminalRows ?? screen.rows.length
    return {
      /*
       * Padded to full `cols`, the way `translateToString(false, ...)` hands a row over, and with
       * one column per code unit - which is what a row of plain text really is. A row carrying a
       * wide or an astral character is NOT that, and no fake can say so honestly: those rows are
       * driven through `TerminalBufferScan.readerOf` over a real `Terminal` in
       * `terminalBufferReader.test.ts`.
       */
      row: (row) => {
        if (row < 0 || row >= screen.rows.length) return null
        const text = screen.rows[row].padEnd(cols).slice(0, cols)
        return {
          text,
          columnAt: [...text].map((_character, index) => index).concat([cols]),
          indexAt: [...text].map((_character, index) => index),
        }
      },
      cols,
      rows: terminalRows,
      viewportY: screen.viewportY ?? 0,
      length: screen.rows.length,
      screenRect: {
        left: 0,
        top: 0,
        width: cols * cellWidthConst,
        height: terminalRows * cellHeightConst,
      },
    }
  }

  function captureAt(screen: Screen, viewportRow: number, column: number): TerminalMenuCapture {
    return TerminalBufferScan.capture(
      readerOf(screen),
      column * cellWidthConst + cellWidthConst / 2,
      viewportRow * cellHeightConst + cellHeightConst / 2,
    )
  }

  /**
   * The stitch is what turns a wrapped path back into one token, and it was the only axis of this
   * scan with no bound: it climbed while the rows above were full-width runs of path characters,
   * which is every row of a base64 blob or a hex dump. Over a 10 000-row scrollback that is one
   * right click building a token of megabytes, synchronously, in the contextmenu handler, before the
   * menu is even drawn - and the library then cut it to 1 024 characters at the far end of the bridge.
   */
  it('stops stitching after a bounded number of rows, whatever the wall of text does', () => {
    const cols = 40
    const wall = Array.from({ length: 400 }, () => 'a/b/c'.repeat(8).slice(0, cols))

    const capture = captureAt({ rows: wall, cols, terminalRows: 24, viewportY: 200 }, 10, 20)

    const rows = TerminalDetectorLimits.captureStitchRowsMax * 2 + 1
    expect(capture.token).to.not.equal(null)
    expect((capture.token ?? '').length).to.be.at.most(rows * cols)
    expect((capture.token ?? '').length)
      .to.be.at.most(TerminalDetectorLimits.captureTokenCharactersMax)
    expect(capture.contextText.length)
      .to.be.at.most(TerminalDetectorLimits.captureContextCharactersMax)
  })

  it('reads the path-char run around a click on one row', () => {
    const rows = ['Read Q:\\proj\\src\\main.ts now']
    const capture = captureAt({ rows }, 0, rows[0].indexOf('main.ts'))
    expect(capture.token).toBe('Q:\\proj\\src\\main.ts')
    expect(capture.contextText).toBe('Read Q:\\proj\\src\\main.ts now')
    expect(capture.selection).toBeNull()
  })

  it('reads a slash-prefixed Windows link target from Codex document output', () => {
    const path = '/C:/Projects/NodeJs/AppBackendV2/.aidocs/plans/2026-08-29-001e-refactor-plan.md'
    const rows = [`  - ${path} - implementační plán B1`]
    expect(captureAt({ rows, cols: rows[0].length }, 0, rows[0].indexOf('refactor')).token).toBe(path)
  })

  it('maps a click through the scrolled viewport, not through the top of the buffer', () => {
    const rows = ['scrolled off', 'and this one too', 'see Q:\\proj\\visible.ts']
    expect(captureAt({ rows, viewportY: 2 }, 0, rows[2].indexOf('proj')).token)
      .toBe('Q:\\proj\\visible.ts')
  })

  it('stitches a soft wrap, where the run reaches the last column', () => {
    const rows = ['Q:\\project\\src\\fileV', 'iewer.ts done']
    const capture = captureAt({ rows, cols: 20 }, 0, rows[0].indexOf('project'))
    expect(capture.token).toBe('Q:\\project\\src\\fileViewer.ts')
    expect(capture.contextText).toBe('Q:\\project\\src\\fileV\niewer.ts done')
  })

  it('stitches a hard wrap the source made itself, with the continuation at column 0', () => {
    const rows = ['Wrote Q:\\proj\\src\\', 'terminalPanel.tsx now']
    expect(captureAt({ rows, cols: 18 }, 0, rows[0].indexOf('proj')).token)
      .toBe('Q:\\proj\\src\\terminalPanel.tsx')
  })

  it('stitches a hanging indent from either half of it', () => {
    const rows = ['Update(Q:\\proj\\renderer\\panels\\', '        terminal\\scan.ts)']
    const expected = 'Q:\\proj\\renderer\\panels\\terminal\\scan.ts'
    expect(captureAt({ rows, cols: 31 }, 0, rows[0].indexOf('renderer')).token).toBe(expected)
    expect(captureAt({ rows, cols: 31 }, 1, rows[1].indexOf('scan.ts')).token).toBe(expected)
  })

  /*
   * Codex wraps at the last break opportunity that fits, so its rows stop several columns short of
   * the edge, and it draws its own border down the left of every continuation. Both rows below are
   * real, taken off a live Codex session at 80 columns on 2026-09-07; before this the click found
   * only half a path and the person got no file at all.
   */
  it('stitches a Codex wrap that stops short of the edge and continues behind its border', () => {
    const rows = [
      '  \u2502 screenshot svg C:/Projects/Studies/worker-agent/.aidocs/screenshots/',
      '  \u2502 worker-agent-modules-overview-1720x1450.png',
    ]
    const expected = 'C:/Projects/Studies/worker-agent/.aidocs/screenshots/'
      + 'worker-agent-modules-overview-1720x1450.png'
    expect(captureAt({ rows, cols: 80 }, 0, rows[0].indexOf('.aidocs')).token).toBe(expected)
    expect(captureAt({ rows, cols: 80 }, 1, rows[1].indexOf('modules')).token).toBe(expected)
  })

  it('stitches an early wrap into a hanging indent, the shape a Codex list item makes', () => {
    const rows = [
      '  - Opravneni a schvalovani (.aidocs/screenshots/worker-agent-modules-permissions-',
      '    1440x770.png)',
    ]
    const expected = '.aidocs/screenshots/worker-agent-modules-permissions-1440x770.png'
    expect(captureAt({ rows, cols: 88 }, 0, rows[0].indexOf('screenshots')).token).toBe(expected)
    expect(captureAt({ rows, cols: 88 }, 1, rows[1].indexOf('1440')).token).toBe(expected)
  })

  /*
   * The stitch is a guess about how a source wrapped, and the disk is what settles it. Handing the
   * plain run over beside the stitched one is what makes a wrong guess cost a `stat` rather than
   * the path that was actually clicked.
   */
  it('carries the single-row run beside a stitched token, and nothing when it did not stitch', () => {
    const rows = ['Q:\\project\\src\\fileV', 'iewer.ts done']
    const stitched = captureAt({ rows, cols: 20 }, 0, rows[0].indexOf('project'))
    expect(stitched.token).toBe('Q:\\project\\src\\fileViewer.ts')
    expect(stitched.fallbackToken).toBe('Q:\\project\\src\\fileV')
    expect(captureAt({ rows: ['Read Q:\\proj\\a.ts now'] }, 0, 8).fallbackToken).toBeNull()
  })

  // A second path below a short one would have fitted beside it, so it was never a continuation.
  // That is what keeps the relaxed rule above away from a column of paths, whatever they indent to.
  it('leaves a column of paths alone even when the rows indent differently', () => {
    const rows = ['  Q:\\a\\b.ts', '    Q:\\a\\c.ts']
    expect(captureAt({ rows }, 0, rows[0].indexOf('b.ts')).token).toBe('Q:\\a\\b.ts')
    expect(captureAt({ rows }, 1, rows[1].indexOf('c.ts')).token).toBe('Q:\\a\\c.ts')
  })

  // The guard the whole heuristic rests on: both halves of a wrapped sentence end and begin with
  // path chars, and gluing them would hand the detector a word that was never one token.
  it('leaves an ordinary wrapped sentence alone, because the run holds no separator', () => {
    const rows = ['Hello world', '   I am here']
    const capture = captureAt({ rows, cols: 20 }, 0, rows[0].indexOf('world'))
    expect(capture.token).toBe('world')
    expect(capture.contextText).toBe('Hello world')
  })

  // A short row is padded to `cols` like every other, so "everything right of the run is whitespace"
  // says nothing on its own. Only the row that reached the edge was continued on the next one.
  it('leaves a two-row column of paths as two tokens', () => {
    const rows = ['  Q:\\a\\b.ts', '  Q:\\a\\c.ts']
    expect(captureAt({ rows }, 0, rows[0].indexOf('Q:')).token).toBe('Q:\\a\\b.ts')
    expect(captureAt({ rows }, 1, rows[1].indexOf('Q:')).token).toBe('Q:\\a\\c.ts')
  })

  it('leaves a three-row column of paths as three tokens', () => {
    const rows = ['  Q:\\a\\b.ts', '  Q:\\a\\c.ts', '  Q:\\a\\d.ts']
    expect(captureAt({ rows }, 0, rows[0].indexOf('Q:')).token).toBe('Q:\\a\\b.ts')
    expect(captureAt({ rows }, 1, rows[1].indexOf('Q:')).token).toBe('Q:\\a\\c.ts')
    expect(captureAt({ rows }, 2, rows[2].indexOf('Q:')).token).toBe('Q:\\a\\d.ts')
  })

  it('reads one path out of git status output, not the column around it', () => {
    const rows = ['   modified:   app/foo.ts', '   modified:   app/bar.ts']
    expect(captureAt({ rows }, 0, rows[0].indexOf('app/foo.ts')).token).toBe('app/foo.ts')
    expect(captureAt({ rows }, 1, rows[1].indexOf('app/bar.ts')).token).toBe('app/bar.ts')
    expect(captureAt({ rows }, 1, rows[1].indexOf('modified')).token).toBe('modified:')
  })

  it('walks forward past the visible region, because the cap is the buffer length', () => {
    const rows = ['header (line)', 'Q:\\proj\\src\\', 'deep\\file.ts', '(done)']
    expect(captureAt({ rows, cols: 13, terminalRows: 2 }, 1, rows[1].indexOf('proj')).token)
      .toBe('Q:\\proj\\src\\deep\\file.ts')
  })

  it('takes the cell to the left when the clicked one is not a path char', () => {
    const rows = ['Q:\\proj\\a.ts done']
    expect(captureAt({ rows }, 0, rows[0].indexOf(' done')).token).toBe('Q:\\proj\\a.ts')
  })

  it('has no token for a click into empty space, and hands back the clicked row', () => {
    const rows = ['Read Q:\\a.ts']
    const capture = captureAt({ rows }, 0, 30)
    expect(capture.token).toBeNull()
    expect(capture.contextText).toBe('Read Q:\\a.ts')
  })

  it('reads a quoted span as one token, spaces and all', () => {
    const rows = ['Opened "Q:\\my docs\\notes.md" today']
    expect(captureAt({ rows }, 0, rows[0].indexOf('docs')).token).toBe('Q:\\my docs\\notes.md')
    expect(captureAt({ rows }, 0, rows[0].indexOf('Opened')).token).toBe('Opened')
  })

  it('reads a quoted path with spaces whole, in either quote character', () => {
    const doubled = ['saved "C:\\a b\\file name.md" ok']
    expect(captureAt({ rows: doubled }, 0, doubled[0].indexOf('file')).token).toBe('C:\\a b\\file name.md')
    const singled = ['saved \'C:\\a b\\file name.md\' ok']
    expect(captureAt({ rows: singled }, 0, singled[0].indexOf('file')).token).toBe('C:\\a b\\file name.md')
  })

  it('reads a quoted argument out of a call the way an agent prints one', () => {
    const rows = ['Read("C:\\a b\\x.md")']
    expect(captureAt({ rows }, 0, rows[0].indexOf('b\\x')).token).toBe('C:\\a b\\x.md')
  })

  // Agents write contractions all day, and a pair of them reads as a quoted span to anything that
  // only counts quote characters.
  it('does not pair the apostrophes of ordinary prose around a path', () => {
    const rows = ['don\'t edit Q:\\proj\\src\\main.ts, it\'s locked']
    expect(captureAt({ rows, cols: 60 }, 0, rows[0].indexOf('main.ts')).token).toBe('Q:\\proj\\src\\main.ts')
  })

  it('reads the path out of a row that opens with a contraction', () => {
    const rows = ['it\'s Q:\\a.ts, that\'s fine']
    expect(captureAt({ rows }, 0, rows[0].indexOf('Q:')).token).toBe('Q:\\a.ts')
  })

  // The written limit: quotes are read on one row only, so a quoted path broken over two rows comes
  // back as the stitched run through it and loses the space the quotes were there to carry.
  it('does not carry a quoted span across rows', () => {
    const rows = ['Opened "Q:\\my docs\\', 'notes.md" now']
    expect(captureAt({ rows, cols: 19 }, 0, rows[0].indexOf('docs')).token).toBe('docs\\notes.md')
  })

  // The listener sits on the padded holder, so a click can land beside the cell grid entirely.
  it('has no capture for a click in the padding right of the grid', () => {
    const rows = ['Read Q:\\a.ts']
    const capture = captureAt({ rows, cols: 12 }, 0, 20)
    expect(capture.token).toBeNull()
    expect(capture.contextText).toBe('')
  })

  it('has no capture for a click below the grid while the buffer is scrolled up', () => {
    const rows = ['Q:\\a\\one.ts', 'Q:\\a\\two.ts', 'Q:\\a\\three.ts', 'Q:\\a\\four.ts']
    const capture = captureAt({ rows, terminalRows: 2, viewportY: 1 }, 2, 2)
    expect(capture.token).toBeNull()
    expect(capture.contextText).toBe('')
  })

  it('has nothing to say about a screen that has not been measured yet', () => {
    const reader = { ...readerOf({ rows: ['Q:\\proj\\a.ts'] }), screenRect: { left: 0, top: 0, width: 0, height: 0 } }
    const capture = TerminalBufferScan.capture(reader, 5, 10)
    expect(capture.token).toBeNull()
    expect(capture.contextText).toBe('')
  })
})
