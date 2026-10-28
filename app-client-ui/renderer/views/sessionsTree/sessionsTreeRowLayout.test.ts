import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const cssConst = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sessionsTree.css'), 'utf8')

class RowCss {
  /** The declarations of the one rule whose selector is exactly `selector`. */
  static declarationsOf(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(cssConst)
    if (match === null) throw new Error(`sessionsTree.css has no rule ${selector}`)
    return match[1]
  }
}

/**
 * jsdom lays nothing out, so the row's shrink order is read off the stylesheet. A waiting row drew
 * "! C WT * Ready for validation | Open actions" without its name: the title took only the space
 * left over, and the marks beside it kept their full width.
 */
describe('app-client-ui/renderer/views/sessionsTree/row layout', () => {
  it('keeps the session name at its own width while the marks give way first', () => {
    expect(RowCss.declarationsOf('.jamat-sessions__title')).toMatch(/flex:\s*1 1 auto;/)
    const marks = RowCss.declarationsOf(
      '.jamat-sessions__row > :not(.jamat-sessions__title, .jamat-sessions__glyph, .jamat-sessions__actions, .jamat-sessions__flash)')
    expect(marks).toMatch(/flex-shrink:\s*1000;/)
    expect(marks).toMatch(/min-width:\s*0;/)
    expect(marks).toMatch(/text-overflow:\s*ellipsis;/)
    expect(RowCss.declarationsOf('.jamat-sessions__actions')).toMatch(/flex:\s*none;/)
  })

  // Measured in Electron 43 with this stylesheet: the marks at flex-shrink 1000 still left the title
  // 0.05 px short of "001 - J05 W1", and the ellipsis then replaced "W1" with "...".
  it('never takes a sub-pixel from a short name, and lets a long one shrink only to its floor', () => {
    expect(RowCss.declarationsOf('.jamat-sessions__title'))
      .toMatch(/min-width:\s*calc-size\(max-content, min\(size, 8em\)\);/)
    expect(RowCss.declarationsOf('.jamat-sessions__glyph')).toMatch(/flex:\s*none;/)
  })
})
