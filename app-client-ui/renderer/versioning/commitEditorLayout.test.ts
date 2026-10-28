import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const hereConst = dirname(fileURLToPath(import.meta.url))

class EditorCss {
  private static readonly sheetsConst = {
    commitPane: readFileSync(join(hereConst, 'commitPane.css'), 'utf8'),
    sessionActions: readFileSync(join(hereConst, '..', 'sessionActions', 'sessionActions.css'), 'utf8'),
  }

  /** The declarations of the one rule whose selector is exactly `selector`. */
  static declarationsOf(sheet: keyof typeof EditorCss.sheetsConst, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(EditorCss.sheetsConst[sheet])
    if (match === null) throw new Error(`${sheet}.css has no rule ${selector}`)
    return match[1]
  }
}

/**
 * jsdom lays nothing out, so the editor's sizes are read off the stylesheets. A review with a long
 * file list and a long "Missing:" list drew the commit message 18 to 22 px high: the message share of
 * the split had no minimum, so its textarea shrank to what was left and was clipped.
 */
describe('app-client-ui/renderer/versioning/commit editor layout', () => {
  it('keeps several lines of the commit message whatever the file list holds', () => {
    expect(EditorCss.declarationsOf('commitPane', '.commit-message textarea')).toMatch(/min-height:\s*5lh;/)
    expect(EditorCss.declarationsOf('commitPane', '.commit-message textarea')).toMatch(/flex:\s*1 0 auto;/)
    expect(EditorCss.declarationsOf('commitPane', '.commit-editor-message')).toMatch(/min-height:\s*min-content;/)
    expect(EditorCss.declarationsOf('commitPane', '.commit-editor')).toMatch(/min-height:\s*min-content;/)
  })

  it('lets the file list give way first and the pane scroll when nothing fits', () => {
    const files = EditorCss.declarationsOf('commitPane', '.commit-editor-files')
    expect(files).toMatch(/contain:\s*size;/)
    expect(files).toMatch(/min-height:\s*5lh;/)
    expect(EditorCss.declarationsOf('commitPane', '.commit-pane')).toMatch(/overflow:\s*auto;/)
  })

  it('keeps one repository message in view when each repository has its own', () => {
    const list = EditorCss.declarationsOf('sessionActions', '.session-actions__repositories')
    expect(list).toMatch(/contain:\s*size;/)
    expect(list).toMatch(/min-height:\s*calc\(/)
    expect(list).toMatch(/overflow:\s*auto;/)
    const textarea = EditorCss.declarationsOf('sessionActions', '.session-actions__repository-message textarea')
    expect(textarea).toMatch(/min-height:\s*5lh;/)
    expect(textarea).toMatch(/flex:\s*none;/)
  })
})
