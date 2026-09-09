import { describe, expect, it } from 'vitest'

import { FileViewerLimits } from '../../../lib-orchestrator/fileViewer/fileViewerLimits'
import { FileHexRows } from './fileHexView'

describe('app-client-ui/renderer/fileViewer/fileHexView', () => {
  /*
   * Every chunk used to be appended to one growing array whose rows were ALL rebuilt on every press,
   * with a `<span>` per row and no virtualisation: twenty presses over a large binary is 81 920 DOM
   * nodes and twenty rebuilds of everything before them.
   */
  it('keeps a sliding window of hex rows at their real offsets in the file', () => {
    const second = FileHexRows.of(new Uint8Array([1, 2, 3]), 64 * 1024)
    expect(second[0]?.offset).toBe(65_536)

    const many = Array.from(
      { length: FileViewerLimits.hexRowsMax + 100 },
      (_, index) => ({ offset: index * 16, hex: '', ascii: '' }),
    )
    const windowed = FileHexRows.window(many)

    expect(windowed).toHaveLength(FileViewerLimits.hexRowsMax)
    // The LAST rows, so what is on screen is what was just read.
    expect(windowed.at(-1)?.offset).toBe(many.at(-1)?.offset)
    expect(windowed[0]?.offset).toBe(100 * 16)
    expect(FileHexRows.window(many.slice(0, 10))).toHaveLength(10)
  })

  it('formats fixed-width hex rows with printable ASCII', () => {
    const rows = FileHexRows.of(new Uint8Array([0, 65, 66, 255]))
    expect(rows).toEqual([{ offset: 0, hex: '00 41 42 ff', ascii: '.AB.' }])
  })
})
