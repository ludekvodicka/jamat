import { describe, expect, it } from 'vitest'

import type { FileViewerDocument } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
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

  it('records the document a link replaces and steps Back and Forward with the offset left in each', () => {
    const source = (path: string) => ({ kind: 'workspace' as const, sessionId: 's1', path })
    const document = (path: string) => ({ documentKey: `doc:${path}`, source: source(path) }) as FileViewerDocument
    const at = (path: string, extra: Record<string, unknown> = {}) => ({ sessionId: 's1', source: source(path), ...extra })
    const hint = { kind: 'svn-base', revision: null }

    const opened = FileViewerPanelState.opened(at('C:/a.md', { baselineHint: hint, forward: [{ source: source('C:/x.md') }] }),
      document('C:/a.md'), document('C:/b.md'), 640)
    expect(opened).toEqual({ history: [{ source: source('C:/a.md'), baselineHint: hint,
      restoreScroll: { documentKey: 'doc:C:/a.md', scrollTop: 640 } }], forward: [] })
    // The same document again is no visit and keeps Forward; a document that never drew has no offset.
    expect(FileViewerPanelState.opened(at('C:/a.md', { forward: [{ source: source('C:/x.md') }] }), document('C:/a.md'), document('C:/a.md'), 640))
      .toEqual({ history: [], forward: [{ source: source('C:/x.md') }] })
    expect(FileViewerPanelState.opened(at('C:/a.md'), null, document('C:/b.md'), 640).history).toEqual([{ source: source('C:/a.md') }])

    const onB = at('C:/b.md', { location: { line: 4 }, ...opened })
    const back = FileViewerPanelState.stepped(onB, 'back',
      FileViewerPanelState.visitOf(onB, document('C:/b.md'), 90))!
    expect(back).toMatchObject({ source: source('C:/a.md'), location: undefined, history: [],
      forward: [{ source: source('C:/b.md'), restoreScroll: { documentKey: 'doc:C:/b.md', scrollTop: 90 } }],
      restoreScroll: { documentKey: 'doc:C:/a.md', scrollTop: 640 } })
    const restored = FileViewerPanelState.read(back)
    expect(restored.ok && restored.value.forward).toHaveLength(1)

    const forward = FileViewerPanelState.stepped(back, 'forward', FileViewerPanelState.visitOf(back, document('C:/a.md'), undefined))!
    expect(forward).toMatchObject({ source: source('C:/b.md'), forward: [], history: [{ source: source('C:/a.md') }],
      restoreScroll: { documentKey: 'doc:C:/b.md', scrollTop: 90 } })
    expect(FileViewerPanelState.stepped(forward, 'forward', null)).toBeNull()
    expect(FileViewerPanelState.stepped(at('C:/a.md'), 'back', null)).toBeNull()
  })

  it('drops visits it cannot read and keeps the newest fifty', () => {
    const entry = (index: number) => ({ source: { kind: 'workspace', sessionId: 's1', path: `C:/${index}.md` } })
    const read = FileViewerPanelState.read({
      sessionId: 's1',
      source: { kind: 'workspace', sessionId: 's1', path: 'C:/a.md' },
      history: [null, { source: { kind: 'unknown' } }, ...Array.from({ length: 60 }, (_, index) => entry(index + 1))],
      forward: [{ ...entry(0), restoreScroll: { documentKey: 'doc:0', scrollTop: -5 } }],
      restoreScroll: { documentKey: 'doc:x', scrollTop: 'far' },
    })
    expect(read.ok && read.value.history.map((visit) => visit.source.path))
      .toEqual(Array.from({ length: 50 }, (_, index) => `C:/${index + 11}.md`))
    expect(read.ok && read.value.forward).toEqual([entry(0)])
    expect(read.ok && read.value.restoreScroll).toBeUndefined()
    const old = FileViewerPanelState.read({ sessionId: 's1', source: { kind: 'workspace', sessionId: 's1', path: 'C:/a.md' } })
    expect(old.ok && [old.value.history, old.value.forward]).toEqual([[], []])
  })
})
