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
 * jsdom lays nothing out, so the editor's sizes are read off the stylesheets. Both single-message
 * and per-group textareas size tightly to their content (`field-sizing: content`) without empty
 * dead space inside the collapsible wrapper, while collapsing cleanly to one summary line.
 */
describe('app-client-ui/renderer/versioning/commit editor layout', () => {
  it('sizes a single commit message tightly to its content and collapses it cleanly to its summary', () => {
    const textarea = EditorCss.declarationsOf('commitPane', '.commit-message textarea')
    expect(textarea).toMatch(/field-sizing:\s*content;/)
    expect(textarea).toMatch(/min-height:\s*4lh;/)
    expect(textarea).toMatch(/flex:\s*1 0 auto;/)
    expect(EditorCss.declarationsOf('commitPane', '.commit-editor-message')).toMatch(/min-height:\s*min-content;/)
    expect(EditorCss.declarationsOf('commitPane', '.commit-editor-message--collapsed')).toMatch(/flex:\s*none;/)
    expect(EditorCss.declarationsOf('commitPane', '.commit-editor-message--auto')).toMatch(/flex:\s*none;/)
    expect(EditorCss.declarationsOf('commitPane', '.commit-editor')).toMatch(/min-height:\s*min-content;/)
  })

  it('lets the file list give way first and the pane scroll when nothing fits', () => {
    const files = EditorCss.declarationsOf('commitPane', '.commit-editor-files')
    expect(files).toMatch(/contain:\s*size;/)
    expect(files).toMatch(/min-height:\s*5lh;/)
    expect(EditorCss.declarationsOf('commitPane', '.commit-pane')).toMatch(/overflow:\s*auto;/)
  })

  it('sizes each inline repository message tightly to its content and scrolls groups as one list', () => {
    const list = EditorCss.declarationsOf('commitPane', '.commit-groups')
    expect(list).toMatch(/overflow:\s*auto;/)
    const textarea = EditorCss.declarationsOf('commitPane', '.commit-group-message-body textarea')
    expect(textarea).toMatch(/field-sizing:\s*content;/)
    expect(textarea).toMatch(/min-height:\s*4lh;/)
    expect(textarea).toMatch(/resize:\s*vertical;/)
  })
})
