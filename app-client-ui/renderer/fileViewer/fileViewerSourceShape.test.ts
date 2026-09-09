import { describe, expect, it } from 'vitest'

import { FileViewerSourceShape } from './fileViewerSourceShape'

describe('app-client-ui/renderer/fileViewer/fileViewerSourceShape', () => {
  it('reads each of the four source kinds', () => {
    expect(FileViewerSourceShape.read({ kind: 'workspace', sessionId: 's1', path: 'a.md' }))
      .toEqual({ kind: 'workspace', sessionId: 's1', path: 'a.md' })
    expect(FileViewerSourceShape.read({
      kind: 'external', sessionId: 's1', path: 'a.md', anchorPath: 'root',
    })).toEqual({ kind: 'external', sessionId: 's1', path: 'a.md', anchorPath: 'root' })
    expect(FileViewerSourceShape.read({ kind: 'filesystem', sessionId: 's1', path: 'a.md' }))
      .toEqual({ kind: 'filesystem', sessionId: 's1', path: 'a.md' })
    expect(FileViewerSourceShape.read({ kind: 'detected', sessionId: 's1', path: 'a.md' }))
      .toEqual({ kind: 'detected', sessionId: 's1', path: 'a.md' })
  })

  it('refuses what a layout file could hold and this build cannot read', () => {
    expect(FileViewerSourceShape.read(null)).toBe(null)
    expect(FileViewerSourceShape.read('a.md')).toBe(null)
    expect(FileViewerSourceShape.read([])).toBe(null)
    expect(FileViewerSourceShape.read({ kind: 'archive', sessionId: 's1', path: 'a.md' })).toBe(null)
    expect(FileViewerSourceShape.read({ kind: 'workspace', path: 'a.md' })).toBe(null)
    expect(FileViewerSourceShape.read({ kind: 'workspace', sessionId: 's1' })).toBe(null)
  })

  it('refuses an external source without its anchor, which is the field that bounds it', () => {
    expect(FileViewerSourceShape.read({ kind: 'external', sessionId: 's1', path: 'a.md' }))
      .toBe(null)
  })

  it('reads a baseline hint of every kind the file changes manager can name', () => {
    for (const kind of ['git-head', 'svn-base', 'git-commit', 'svn-revision', 'chat-message']) {
      expect(FileViewerSourceShape.hint({ kind, revision: null })).toEqual({ kind, revision: null })
    }
    expect(FileViewerSourceShape.hint({ kind: 'git-commit', revision: 'abc' }))
      .toEqual({ kind: 'git-commit', revision: 'abc' })
    expect(FileViewerSourceShape.hint({
      kind: 'git-head', revision: 'HEAD', workingTreeSource: 'checkpoint',
    })).toEqual({ kind: 'git-head', revision: 'HEAD', workingTreeSource: 'checkpoint' })
  })

  it('drops a hint it cannot read rather than carrying half of one', () => {
    expect(FileViewerSourceShape.hint(undefined)).toBe(undefined)
    expect(FileViewerSourceShape.hint({ kind: 'hg-parent', revision: null })).toBe(undefined)
    expect(FileViewerSourceShape.hint({ kind: 'git-head', revision: 7 })).toBe(undefined)
    expect(FileViewerSourceShape.hint({
      kind: 'git-head', revision: 'HEAD', workingTreeSource: 'archive',
    })).toBe(undefined)
  })

  it('reads only positive safe one-based locations', () => {
    expect(FileViewerSourceShape.location({ line: 1571 })).toEqual({ line: 1571 })
    for (const line of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '12'])
      expect(FileViewerSourceShape.location({ line }), String(line)).toBe(undefined)
    expect(FileViewerSourceShape.location(null)).toBe(undefined)
  })
})
