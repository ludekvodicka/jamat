import { describe, expect, it } from 'vitest'

import { FileViewerPanelState } from './fileViewerPanel'
import { FileViewerDocumentState } from './useFileViewerDocument'

/** What a panel makes of the parameters the layout file hands back to it. */
describe('app-client-ui/renderer/fileViewer/fileViewerPanel state', () => {
  it('validates durable panel sources and chooses the first useful mode', () => {
    expect(FileViewerPanelState.params({
      sessionId: 'session-1',
      source: { kind: 'workspace', sessionId: 'session-1', path: 'C:/work/a.ts' },
    }).source.kind).toBe('workspace')
    expect(FileViewerPanelState.params({
      sessionId: 'session-1',
      source: { kind: 'filesystem', sessionId: 'session-1', path: 'C:/outside/a.ts' },
    }).source.kind).toBe('filesystem')
    expect(FileViewerPanelState.params({
      sessionId: 'session-1',
      source: { kind: 'detected', sessionId: 'session-1', path: 'C:/outside/a.png' },
    }).source.kind).toBe('detected')
    expect(() => FileViewerPanelState.params({
      sessionId: 'session-1',
      source: { kind: 'external', sessionId: 'session-1', path: 'C:/a.ts' },
    })).toThrow(/Unknown file viewer source/)
    expect(FileViewerDocumentState.defaultMode(['preview', 'hex'])).toBe('preview')
  })

  /*
   * A panel saved while diffing against a commit reopens still diffing against it. The five kinds
   * were hand-written strings here and again in the control beside it, so a sixth kind made the
   * control fail loudly and correctly while this one answered `undefined` - the panel reopening
   * without its baseline, dropping out of diff mode, saying nothing.
   */
  it('keeps a saved baseline hint and drops one it cannot read', () => {
    const withHint = FileViewerPanelState.read({
      sessionId: 's1',
      source: { kind: 'workspace', sessionId: 's1', path: 'C:/work/a.ts' },
      baselineHint: { kind: 'git-commit', revision: 'abc123' },
    })
    expect(withHint.ok && withHint.value.baselineHint)
      .toEqual({ kind: 'git-commit', revision: 'abc123' })

    for (const hint of [
      { kind: 'not-a-vcs', revision: 'abc123' },
      { kind: 'git-commit', revision: 7 },
      'a string',
    ]) {
      const read = FileViewerPanelState.read({
        sessionId: 's1',
        source: { kind: 'workspace', sessionId: 's1', path: 'C:/work/a.ts' },
        baselineHint: hint,
      })
      expect(read.ok && read.value.baselineHint, JSON.stringify(hint)).toBeUndefined()
    }
  })

  it('reads a source it does not know as a refusal, never as a throw', () => {
    // The panel draws this. A throw here unmounts the window, and the layout restores the same
    // panel on the next start, so the window never comes back.
    const unknown = FileViewerPanelState.read({
      sessionId: 'session-1',
      source: { kind: 'from-a-later-version', sessionId: 'session-1', path: 'C:/a.ts' },
    })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.detail).toContain('Unknown file viewer source')
    const known = FileViewerPanelState.read({
      sessionId: 'session-1',
      source: { kind: 'detected', sessionId: 'session-1', path: 'C:/outside/a.png' },
    })
    expect(known.ok).toBe(true)
  })
})
