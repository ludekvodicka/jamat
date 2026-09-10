import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { IDockviewPanelProps } from 'dockview'
import { describe, expect, it, vi } from 'vitest'

import type { FileViewerDocumentSource } from '../../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import {
  PanelSplitLayout,
  PanelSplitParams,
  PanelSplitStrip,
  usePanelSplit,
  type PanelSplitFileItem,
} from './panelSplit'

describe('app-client-ui/renderer/widgets/tabs/panelSplit', () => {
  it('keeps legacy files and eight files alongside four permanent commit scopes', () => {
    const files = Array.from({ length: 8 }, (_, i) => ({ key: `f${i}`, title: `f${i}`, source: sourceFixture(`f${i}`) }))
    const commits = Array.from({ length: 4 }, (_, i) => ({ kind: 'commit', key: `c${i}`, title: `c${i}`, vcs: 'svn', scopeRoot: `Q:/scope${i}`, draftId: 'must-not-persist' }))
    const state = PanelSplitParams.of({ split: { items: [...files, ...commits, { kind: 'unknown', key: 'bad' }], active: 'c0', preview: 'c0', history: commits } })
    expect(state.items).toHaveLength(12)
    expect(state.items[0].kind).toBe('file')
    expect(state.items[8]).not.toHaveProperty('draftId')
    expect(state.preview).toBeNull()
    expect(state.history).toEqual([])
    const refusal = PanelSplitParams.opened(state, itemFixture('ninth'))
    expect(refusal).toEqual({ ok: false, refusal: 'The split already holds 8 files. Close one before opening another.' })
    const opened = PanelSplitParams.opened(state, { kind: 'commit', key: 'c4', title: 'Fifth', vcs: 'git', scopeRoot: 'Q:/fifth' })
    if (!opened.ok) throw new Error(opened.refusal)
    expect(opened.state.items).toHaveLength(13)
    expect(opened.state.preview).toBeNull()
    expect(opened.state.history).toEqual([])
  })

  it('never replaces a commit with a preview and refuses the ninth commit', () => {
    let state = PanelSplitParams.default()
    for (let i = 0; i < 8; i++) {
      const result = PanelSplitParams.opened(state, { kind: 'commit', key: `c${i}`, title: `c${i}`, vcs: 'svn', scopeRoot: `Q:/scope${i}` })
      if (!result.ok) throw new Error(result.refusal)
      state = result.state
    }
    expect(PanelSplitParams.opened(state, { kind: 'commit', key: 'ninth', title: 'Ninth', vcs: 'svn', scopeRoot: 'Q:/ninth' }).ok).toBe(false)
    const first = PanelSplitParams.opened(state, itemFixture('first'))
    if (!first.ok) throw new Error(first.refusal)
    const second = PanelSplitParams.opened(first.state, itemFixture('second'))
    if (!second.ok) throw new Error(second.refusal)
    expect(second.state.items.filter((item) => item.kind === 'commit')).toEqual(state.items)
    expect(second.state.preview).toBe('key:second')
  })

  it('shows the commit scope and offers Close without Detach', () => {
    render(<PanelSplitStrip items={[{ kind: 'commit', key: 'c', title: 'Commit SVN', vcs: 'svn', scopeRoot: 'Q:/app' }]}
      active="c" preview={null} onActivate={vi.fn()} onKeepOpen={vi.fn()} onClose={vi.fn()} onDetach={vi.fn()} />)
    fireEvent.contextMenu(screen.getByTitle('Q:/app'))
    expect(screen.getByRole('menuitem', { name: 'Close' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Detach from split' })).toBeNull()
  })

  function sourceFixture(path: string): FileViewerDocumentSource {
    return { kind: 'workspace', sessionId: 's1', path }
  }

  function itemFixture(path: string): PanelSplitFileItem {
    return { kind: 'file', key: `key:${path}`, title: path, source: sourceFixture(path) }
  }

  /** Only what the hook touches, the same shape the sidebar's own test uses. */
  function propsFixture(params: Record<string, unknown> = {}): {
    props: IDockviewPanelProps
    updates: Record<string, unknown>[]
    setParameters(next: Record<string, unknown>): void
  } {
    const updates: Record<string, unknown>[] = []
    const listeners: ((params: Record<string, unknown>) => void)[] = []
    const updateParameters = (next: Record<string, unknown>): void => {
      updates.push(next)
      for (const listener of [...listeners]) listener(next)
    }
    const props = {
      api: {
        id: 'terminal:{"sessionId":"s1"}',
        getParameters: () => ({}),
        updateParameters,
        onDidParametersChange: (listener: (next: Record<string, unknown>) => void) => {
          listeners.push(listener)
          return {
            dispose: () => {
              const at = listeners.indexOf(listener)
              if (at >= 0) listeners.splice(at, 1)
            },
          }
        },
      },
      params,
    } as unknown as IDockviewPanelProps
    return {
      props,
      updates,
      setParameters: (next) => {
        for (const listener of [...listeners]) listener(next)
      },
    }
  }

  describe('PanelSplitParams', () => {
    it('opens a tab without a split, and remembers no width it was never given', () => {
      expect(PanelSplitParams.of({})).toEqual({
        ratio: 0.5,
        active: null,
        preview: null,
        items: [],
        history: [],
      })
      expect(PanelSplitParams.of(null)).toEqual(PanelSplitParams.default())
      expect(PanelSplitParams.of({ split: 'yes' })).toEqual(PanelSplitParams.default())
    })

    it('drops an item it cannot read and keeps the rest of the layout', () => {
      const state = PanelSplitParams.of({
        split: {
          ratio: 0.4,
          active: 'key:b.md',
          items: [
            { key: 'key:a.md', title: 'a.md', source: { kind: 'archive', sessionId: 's1', path: 'a.md' } },
            itemFixture('b.md'),
            { key: 'key:c.md', source: sourceFixture('c.md') },
          ],
        },
      })
      expect(state.items.map((item) => item.key)).toEqual(['key:b.md'])
      expect(state.active).toBe('key:b.md')
      expect(state.ratio).toBe(0.4)
    })

    it('falls back to the first item when the stored active one did not survive', () => {
      const state = PanelSplitParams.of({
        split: { ratio: 0.5, active: 'key:gone.md', items: [itemFixture('b.md')] },
      })
      expect(state.active).toBe('key:b.md')
    })

    it('keeps only a valid stored preview key', () => {
      expect(PanelSplitParams.of({
        split: { preview: 'key:a.md', items: [itemFixture('a.md')] },
      }).preview).toBe('key:a.md')
      expect(PanelSplitParams.of({
        split: { preview: 'key:gone.md', items: [itemFixture('a.md')] },
      }).preview).toBe(null)
    })

    it('never carries more items than the cap, whoever wrote the layout', () => {
      const items = Array.from({ length: 12 }, (_, index) => itemFixture(`f${index}.md`))
      expect(PanelSplitParams.of({ split: { items } }).items).toHaveLength(
        PanelSplitParams.itemsMaxConst,
      )
    })

    it('keeps a pinned document and retargets it instead of adding a second tab', () => {
      const opened = PanelSplitParams.opened(PanelSplitParams.default(), itemFixture('a.md'))
      if (!opened.ok) throw new Error('expected the first open to be taken')
      const pinned = PanelSplitParams.keptOpen(opened.state, 'key:a.md')
      const withSecond = PanelSplitParams.opened(pinned, itemFixture('b.md'))
      if (!withSecond.ok) throw new Error('expected the second open to be taken')
      const again = PanelSplitParams.opened(withSecond.state, {
        ...itemFixture('a.md'),
        baselineHint: { kind: 'git-head', revision: null },
        location: { line: 1571 },
      })
      if (!again.ok) throw new Error('expected the repeat open to be taken')
      expect(again.state.items).toHaveLength(2)
      expect(again.state.active).toBe('key:a.md')
      expect(again.state.preview).toBe('key:b.md')
      expect(again.state.items[0].kind === 'file' && again.state.items[0].baselineHint).toEqual({ kind: 'git-head', revision: null })
      expect(again.state.items[0].kind === 'file' && again.state.items[0].location).toEqual({ line: 1571 })
    })

    it('replaces the previous preview in place', () => {
      const first = PanelSplitParams.opened(PanelSplitParams.default(), itemFixture('a.md'))
      if (!first.ok) throw new Error('expected the first open to be taken')
      const second = PanelSplitParams.opened(first.state, itemFixture('b.md'))
      if (!second.ok) throw new Error('expected the second open to be taken')

      expect(second.state.items).toEqual([itemFixture('b.md')])
      expect(second.state.active).toBe('key:b.md')
      expect(second.state.preview).toBe('key:b.md')
    })

    it('drops an invalid saved location without dropping its split item', () => {
      const state = PanelSplitParams.of({
        split: { items: [{ ...itemFixture('a.md'), location: { line: 0 } }] },
      })

      expect(state.items).toEqual([{ ...itemFixture('a.md'), baselineHint: undefined }])
    })

    it('refuses the ninth file out loud and changes nothing', () => {
      let state = PanelSplitParams.default()
      for (let index = 0; index < PanelSplitParams.itemsMaxConst; index += 1) {
        const step = PanelSplitParams.opened(state, itemFixture(`f${index}.md`))
        if (!step.ok) throw new Error('expected the file to fit')
        state = PanelSplitParams.keptOpen(step.state, `key:f${index}.md`)
      }
      const refused = PanelSplitParams.opened(state, itemFixture('one-too-many.md'))
      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.refusal).toContain('8')
      expect(state.items).toHaveLength(PanelSplitParams.itemsMaxConst)
    })

    it('replaces the preview even when the split is at its cap', () => {
      let state = PanelSplitParams.default()
      for (let index = 0; index < PanelSplitParams.itemsMaxConst - 1; index += 1) {
        const step = PanelSplitParams.opened(state, itemFixture(`pinned-${index}.md`))
        if (!step.ok) throw new Error('expected the pinned file to fit')
        state = PanelSplitParams.keptOpen(step.state, `key:pinned-${index}.md`)
      }
      const preview = PanelSplitParams.opened(state, itemFixture('preview.md'))
      if (!preview.ok) throw new Error('expected the preview to fit')
      const replacement = PanelSplitParams.opened(preview.state, itemFixture('replacement.md'))
      if (!replacement.ok) throw new Error('expected the preview replacement to fit')

      expect(replacement.state.items).toHaveLength(PanelSplitParams.itemsMaxConst)
      expect(replacement.state.items.some((item) => item.key === 'key:preview.md')).toBe(false)
      expect(replacement.state.preview).toBe('key:replacement.md')
    })

    it('hands the active tab to its next sibling on close, and to the previous one at the end', () => {
      let state = PanelSplitParams.default()
      for (const path of ['a.md', 'b.md', 'c.md']) {
        const step = PanelSplitParams.opened(state, itemFixture(path))
        if (!step.ok) throw new Error('expected the file to fit')
        state = PanelSplitParams.keptOpen(step.state, `key:${path}`)
      }
      const middle = PanelSplitParams.closed(PanelSplitParams.activated(state, 'key:b.md'), 'key:b.md')
      expect(middle.active).toBe('key:c.md')
      const last = PanelSplitParams.closed(middle, 'key:c.md')
      expect(last.active).toBe('key:a.md')
    })

    it('closing an inactive tab leaves the active one where it was', () => {
      const opened = PanelSplitParams.opened(PanelSplitParams.default(), itemFixture('a.md'))
      if (!opened.ok) throw new Error('expected the file to fit')
      const withSecond = PanelSplitParams.opened(
        PanelSplitParams.keptOpen(opened.state, 'key:a.md'),
        itemFixture('b.md'),
      )
      if (!withSecond.ok) throw new Error('expected the file to fit')
      const closed = PanelSplitParams.closed(withSecond.state, 'key:a.md')
      expect(closed.active).toBe('key:b.md')
      expect(closed.items).toHaveLength(1)
      expect(closed.preview).toBe('key:b.md')
    })

    it('keeps the dragged width after the last tab closes', () => {
      const opened = PanelSplitParams.opened({ ...PanelSplitParams.default(), ratio: 0.7 }, itemFixture('a.md'))
      if (!opened.ok) throw new Error('expected the file to fit')
      const empty = PanelSplitParams.closed(opened.state, 'key:a.md')
      expect(empty.items).toHaveLength(0)
      expect(empty.active).toBe(null)
      expect(empty.preview).toBe(null)
      expect(empty.ratio).toBe(0.7)
    })

    it('keeps a preview open only when its own tab is promoted', () => {
      const opened = PanelSplitParams.opened(PanelSplitParams.default(), itemFixture('a.md'))
      if (!opened.ok) throw new Error('expected the file to fit')
      expect(PanelSplitParams.keptOpen(opened.state, 'key:gone.md')).toBe(opened.state)
      expect(PanelSplitParams.keptOpen(opened.state, 'key:a.md').preview).toBe(null)
    })

    it('ignores a close or an activate naming a tab that is not there', () => {
      const state = PanelSplitParams.default()
      expect(PanelSplitParams.closed(state, 'key:gone.md')).toBe(state)
      expect(PanelSplitParams.activated(state, 'key:gone.md')).toBe(state)
    })

    it('clamps the ratio and rounds it, so a drag writes one layout rather than noise', () => {
      expect(PanelSplitParams.clampRatio(0.5004)).toBe(0.5)
      expect(PanelSplitParams.clampRatio(0.0)).toBe(0.15)
      expect(PanelSplitParams.clampRatio(1.4)).toBe(0.85)
      expect(PanelSplitParams.clampRatio(Number.NaN)).toBe(0.5)
      // Clamped first, then rounded: a value under the floor is the floor, not a rounded version
      // of a width the pane may not have.
      expect(PanelSplitParams.clampRatio(0.123456)).toBe(0.15)
      expect(PanelSplitParams.clampRatio(0.654321)).toBe(0.654)
    })

    it('merges under its own key and leaves every other parameter alone', () => {
      const merged = PanelSplitParams.merged(
        { sessionId: 's1', sidebar: { visible: true } },
        PanelSplitParams.default(),
      )
      expect(merged.sessionId).toBe('s1')
      expect(merged.sidebar).toEqual({ visible: true })
      expect(merged.split).toEqual(PanelSplitParams.default())
    })
  })

  describe('document history', () => {
    function open(state: ReturnType<typeof PanelSplitParams.default>, path: string) {
      const result = PanelSplitParams.opened(state, itemFixture(path))
      if (!result.ok) throw new Error(result.refusal)
      return result.state
    }

    function back(state: ReturnType<typeof PanelSplitParams.default>) {
      const result = PanelSplitParams.navigatedBack(state)
      if (!result.ok) throw new Error(result.refusal)
      return result.state
    }

    it('returns through replaced preview documents without adding the return trip', () => {
      const a = open(PanelSplitParams.default(), 'a.md')
      const b = open(a, 'b.md')
      const c = open(b, 'c.md')
      const returned = back(c)

      expect(returned.items.map((item) => item.title)).toEqual(['b.md'])
      expect(returned.preview).toBe('key:b.md')
      expect(returned.history.map((item) => item.title)).toEqual(['a.md'])
      expect(back(returned).items.map((item) => item.title)).toEqual(['a.md'])
      expect(back(returned).history).toEqual([])
      expect(back(a)).toBe(a)
    })

    it('remembers tab activation and reuses a kept destination', () => {
      const a = PanelSplitParams.keptOpen(open(PanelSplitParams.default(), 'a.md'), 'key:a.md')
      const b = open(a, 'b.md')
      const returned = back(b)
      expect(returned.active).toBe('key:a.md')
      expect(returned.items).toHaveLength(2)
      expect(returned.preview).toBe('key:b.md')

      const selected = PanelSplitParams.activated(returned, 'key:b.md')
      expect(back(selected).active).toBe('key:a.md')
      expect(PanelSplitParams.activated(selected, 'key:b.md').history).toEqual(selected.history)
    })

    it('does not add history when the active document changes its baseline or line', () => {
      const a = open(PanelSplitParams.default(), 'a.md')
      const updated = PanelSplitParams.opened(a, {
        ...itemFixture('a.md'),
        baselineHint: { kind: 'svn-base', revision: '40' },
        location: { line: 23 },
      })
      if (!updated.ok) throw new Error(updated.refusal)
      expect(updated.state.history).toEqual([])
      expect(back(open(updated.state, 'b.md')).items[0]).toEqual(updated.state.items[0])
    })

    it('preserves repeated visits and limits the newest history to fifty entries', () => {
      const a = open(PanelSplitParams.default(), 'a.md')
      const revisited = open(open(a, 'b.md'), 'a.md')
      expect(back(revisited).active).toBe('key:b.md')
      expect(back(back(revisited)).active).toBe('key:a.md')
      let state = a
      for (let index = 0; index < 60; index += 1)
        state = open(state, `f${index}.md`)
      expect(state.history).toHaveLength(50)
      expect(state.history[0].title).toBe('f9.md')
      expect(state.history.at(-1)?.title).toBe('f58.md')
    })

    it('restores history without grant ids and reads old layouts with an empty history', () => {
      const current = open(open(PanelSplitParams.default(), 'a.md'), 'b.md')
      const restored = PanelSplitParams.of({ split: JSON.parse(JSON.stringify(current)) })
      expect(back(restored).active).toBe('key:a.md')
      const dirty = PanelSplitParams.of({ split: {
        ...current,
        history: [null, { bad: true }, { ...itemFixture('a.md'), documentId: 'grant-a' }],
      } })
      expect(dirty.history).toHaveLength(1)
      expect(JSON.stringify(dirty.history)).not.toContain('grant-a')
      expect(PanelSplitParams.of({ split: { items: current.items } }).history).toEqual([])
      expect(PanelSplitParams.of({ split: {
        items: current.items,
        history: Array.from({ length: 60 }, (_, index) => itemFixture(`f${index}.md`)),
      } }).history.map((item) => item.title))
        .toEqual(Array.from({ length: 50 }, (_, index) => `f${index + 10}.md`))
    })

    it('removes explicitly closed files from history and clears it when the split closes', () => {
      const a = PanelSplitParams.keptOpen(open(PanelSplitParams.default(), 'a.md'), 'key:a.md')
      const b = open(a, 'b.md')
      const c = open(PanelSplitParams.activated(b, 'key:a.md'), 'c.md')
      const closed = PanelSplitParams.closed(c, 'key:a.md')
      expect(closed.history.map((item) => item.title)).toEqual(['b.md'])
      expect(PanelSplitParams.closed(closed, 'key:c.md').history).toEqual([])
      const sibling = PanelSplitParams.closed(b, 'key:b.md')
      expect(PanelSplitParams.backTargetOf(sibling)).toBe(null)
    })

    it('keeps the history when a return cannot fit among eight kept files', () => {
      let state = open(PanelSplitParams.default(), 'previous.md')
      for (let index = 0; index < 8; index += 1)
        state = PanelSplitParams.keptOpen(open(state, `f${index}.md`), `key:f${index}.md`)
      for (let index = 0; index < 7; index += 1)
        state = back(state)
      const before = JSON.stringify(state)
      expect(PanelSplitParams.navigatedBack(state)).toMatchObject({ ok: false })
      expect(JSON.stringify(state)).toBe(before)
      expect(PanelSplitParams.backTargetOf(state)?.title).toBe('previous.md')
    })
  })

  describe('usePanelSplit', () => {
    it('returns through current parameters without changing another split or losing sidebar state', () => {
      const first = propsFixture({ sidebar: { visible: true } })
      const second = propsFixture()
      const one = renderHook(() => usePanelSplit(first.props))
      const two = renderHook(() => usePanelSplit(second.props))
      act(() => {
        one.result.current.open(itemFixture('a.md'))
        one.result.current.open(itemFixture('b.md'))
        two.result.current.open(itemFixture('other.md'))
      })
      act(() => { one.result.current.back() })
      expect(one.result.current.state.active).toBe('key:a.md')
      expect(two.result.current.state.active).toBe('key:other.md')
      expect(first.updates.at(-1)?.sidebar).toEqual({ visible: true })
      one.unmount()
      two.unmount()
    })

    it('starts from what the panel parameters carried, which is what a restore hands back', () => {
      const { props } = propsFixture({ split: { ratio: 0.3, items: [itemFixture('a.md')] } })
      const { result } = renderHook(() => usePanelSplit(props))
      expect(result.current.state.ratio).toBe(0.3)
      expect(result.current.state.items).toHaveLength(1)
    })

    it('writes through the public api, which is the only path that reaches the layout save', () => {
      const { props, updates } = propsFixture({ sessionId: 's1' })
      const { result } = renderHook(() => usePanelSplit(props))
      act(() => { expect(result.current.open(itemFixture('a.md'))).toBe(null) })
      expect(updates).toHaveLength(1)
      expect(updates[0].sessionId).toBe('s1')
      expect((updates[0].split as { items: unknown[] }).items).toHaveLength(1)
      expect(result.current.state.active).toBe('key:a.md')
    })

    it('replaces a preview opened earlier in the same React batch', () => {
      const { props } = propsFixture({ sessionId: 's1' })
      const { result } = renderHook(() => usePanelSplit(props))

      act(() => {
        expect(result.current.open(itemFixture('a.md'))).toBe(null)
        expect(result.current.open(itemFixture('b.md'))).toBe(null)
      })

      expect(result.current.state.items.map((item) => item.key))
        .toEqual(['key:b.md'])
      expect(result.current.state.preview).toBe('key:b.md')
    })

    it('keeps a promoted file when the next preview opens', () => {
      const { props } = propsFixture({ sessionId: 's1' })
      const { result } = renderHook(() => usePanelSplit(props))

      act(() => {
        expect(result.current.open(itemFixture('a.md'))).toBe(null)
        result.current.keepOpen('key:a.md')
        expect(result.current.open(itemFixture('b.md'))).toBe(null)
      })

      expect(result.current.state.items.map((item) => item.key))
        .toEqual(['key:a.md', 'key:b.md'])
      expect(result.current.state.preview).toBe('key:b.md')
    })

    it('hands the refusal back to the caller instead of writing anything', () => {
      const items = Array.from({ length: 8 }, (_, index) => itemFixture(`f${index}.md`))
      const { props, updates } = propsFixture({ split: { items } })
      const { result } = renderHook(() => usePanelSplit(props))
      let refusal: string | null = null
      act(() => { refusal = result.current.open(itemFixture('one-too-many.md')) })
      expect(refusal).toContain('8')
      expect(updates).toHaveLength(0)
    })

    it('adopts parameters written from outside, and its own write does not put the old back', () => {
      const { props, updates } = propsFixture({ split: { items: [] } })
      const { result, rerender } = renderHook(
        (current: IDockviewPanelProps) => usePanelSplit(current),
        { initialProps: props },
      )
      // What the open-file control arm does: the parameters change under a live panel.
      const outside = {
        ...props,
        params: { split: { ratio: 0.5, active: 'key:agent.md', items: [itemFixture('agent.md')] } },
      } as IDockviewPanelProps
      rerender(outside)
      expect(result.current.state.items.map((item) => item.key)).toEqual(['key:agent.md'])
      act(() => { result.current.resize(0.7) })
      expect(result.current.state.items.map((item) => item.key)).toEqual(['key:agent.md'])
      expect(updates.at(-1)).toBeDefined()
      expect((updates.at(-1)?.split as { ratio: number }).ratio).toBe(0.7)
    })

    it('merges an immediate resize into live external parameters', () => {
      const { props, updates, setParameters } = propsFixture({
        serial: 1,
        sidebar: { visible: false, width: 440, activeView: null },
      })
      const { result } = renderHook(() => usePanelSplit(props))
      setParameters({
        sidebar: { visible: true, width: 320, activeView: 'fileChanges' },
        split: { ratio: 0.5, active: 'key:agent.md', items: [itemFixture('agent.md')] },
      })

      act(() => { result.current.resize(0.7) })

      expect(updates.at(-1)?.sidebar).toEqual({
        visible: true,
        width: 320,
        activeView: 'fileChanges',
      })
      expect(updates.at(-1)?.serial).toBe(1)
      expect(PanelSplitParams.of(updates.at(-1))).toMatchObject({
        ratio: 0.7,
        items: [{ key: 'key:agent.md' }],
      })
    })

    it('closes a captured item after only the sidebar changes', () => {
      const item = itemFixture('agent.md')
      const initial = {
        sidebar: { visible: false, width: 440, activeView: null },
        split: { ratio: 0.5, active: item.key, items: [item] },
      }
      const { props, setParameters } = propsFixture(initial)
      const { result } = renderHook(() => usePanelSplit(props))
      const capture = result.current.capture(item.key)
      if (capture === null) throw new Error('expected the split item to be captured')

      setParameters({
        ...initial,
        sidebar: { visible: true, width: 320, activeView: 'fileChanges' },
      })

      act(() => { expect(result.current.closeCaptured(capture)).toBe(true) })
      expect(result.current.state.items).toEqual([])
    })
  })

  describe('PanelSplitStrip', () => {
    function stripFixture(): {
      activated: string[]
      keptOpen: string[]
      closed: string[]
      detached: string[]
    } {
      const activated: string[] = []
      const keptOpen: string[] = []
      const closed: string[] = []
      const detached: string[] = []
      render(
        <PanelSplitStrip
          items={[itemFixture('a.md'), itemFixture('b.md')]}
          active="key:a.md"
          preview="key:a.md"
          onActivate={(key) => activated.push(key)}
          onKeepOpen={(key) => keptOpen.push(key)}
          onClose={(key) => closed.push(key)}
          onDetach={(key) => detached.push(key)}
        />,
      )
      return { activated, keptOpen, closed, detached }
    }

    it('draws one tab per item and marks the active one', () => {
      stripFixture()
      const tabs = screen.getAllByRole('tab')
      expect(tabs).toHaveLength(2)
      expect(tabs[0].getAttribute('aria-selected')).toBe('true')
      expect(tabs[1].getAttribute('aria-selected')).toBe('false')
      expect(tabs[0].classList.contains('is-preview')).toBe(true)
      expect(tabs[1].classList.contains('is-preview')).toBe(false)
    })

    it('activates on click', () => {
      const { activated } = stripFixture()
      fireEvent.click(screen.getAllByRole('tab')[1])
      expect(activated).toEqual(['key:b.md'])
    })

    it('keeps the preview open on double click', () => {
      const { keptOpen } = stripFixture()
      fireEvent.doubleClick(screen.getAllByRole('tab')[0])
      expect(keptOpen).toEqual(['key:a.md'])
    })

    it('closes from the cross without activating the tab it is removing', () => {
      const { activated, closed } = stripFixture()
      fireEvent.click(screen.getByLabelText('Close b.md'))
      expect(closed).toEqual(['key:b.md'])
      expect(activated).toEqual([])
    })

    it('offers exactly the two catalog verbs on a right click', async () => {
      const { detached } = stripFixture()
      fireEvent.contextMenu(screen.getAllByRole('tab')[1])
      const menu = screen.getByRole('menu', { name: 'Split tab actions' })
      const items = menu.querySelectorAll('[role="menuitem"]')
      expect(Array.from(items).map((item) => item.textContent)).toEqual([
        'Detach from split',
        'Close',
      ])
      fireEvent.click(items[0])
      await waitFor(() => expect(detached).toEqual(['key:b.md']))
    })

    it('starts detach after the menu has restored its previous focus', async () => {
      const before = document.createElement('button')
      const detached = document.createElement('button')
      document.body.append(before, detached)
      before.focus()
      render(
        <PanelSplitStrip
          items={[itemFixture('a.md')]}
          active="key:a.md"
          preview="key:a.md"
          onActivate={() => {}}
          onKeepOpen={() => {}}
          onClose={() => {}}
          onDetach={() => detached.focus()}
        />,
      )
      fireEvent.contextMenu(screen.getByRole('tab'))
      screen.getByRole('menuitem', { name: 'Detach from split' }).dispatchEvent(new MouseEvent(
        'click',
        { bubbles: true },
      ))
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(document.activeElement).toBe(detached)
      before.remove()
      detached.remove()
    })
  })

  describe('PanelSplitLayout', () => {
    it('gives the pane the stored share and leaves the content the rest', () => {
      const { container } = render(
        <PanelSplitLayout ratio={0.35} strip={<div />} pane={<p>document</p>} onResize={() => {}}>
          <p>terminal</p>
        </PanelSplitLayout>,
      )
      const pane = container.querySelector('.jamat-panel-split__pane')
      expect((pane as HTMLElement).style.flexBasis).toBe('35%')
      expect(screen.getByText('terminal')).toBeDefined()
      expect(screen.getByText('document')).toBeDefined()
    })

    it('turns a drag into a clamped ratio, and the pane grows as the pointer moves left', () => {
      const onResize = vi.fn()
      const { container } = render(
        <PanelSplitLayout ratio={0.5} strip={<div />} pane={<p>document</p>} onResize={onResize}>
          <p>terminal</p>
        </PanelSplitLayout>,
      )
      const root = container.querySelector('.jamat-panel-split') as HTMLElement
      root.getBoundingClientRect = () => ({ width: 1000 } as DOMRect)
      const splitter = screen.getByRole('separator', { name: 'Resize split' })
      splitter.setPointerCapture = () => {}
      splitter.releasePointerCapture = () => {}
      fireEvent.pointerDown(splitter, { pointerId: 1, clientX: 500 })
      fireEvent.pointerMove(splitter, { pointerId: 1, clientX: 400 })
      expect(onResize).toHaveBeenCalledWith(0.6)
      fireEvent.pointerUp(splitter, { pointerId: 1 })
      fireEvent.pointerMove(splitter, { pointerId: 1, clientX: 100 })
      expect(onResize).toHaveBeenCalledTimes(1)
    })

    it('resizes from the keyboard in both directions', () => {
      const onResize = vi.fn()
      render(
        <PanelSplitLayout ratio={0.5} strip={<div />} pane={<p>document</p>} onResize={onResize}>
          <p>terminal</p>
        </PanelSplitLayout>,
      )
      const splitter = screen.getByRole('separator', { name: 'Resize split' })
      fireEvent.keyDown(splitter, { key: 'ArrowLeft' })
      fireEvent.keyDown(splitter, { key: 'ArrowRight' })
      fireEvent.keyDown(splitter, { key: 'Enter' })
      expect(onResize.mock.calls.map((call) => call[0])).toEqual([0.52, 0.48])
    })

    it('keeps the content slot mounted while an empty pane hides its splitter', () => {
      const terminal = <p>terminal</p>
      const { container, rerender } = render(
        <PanelSplitLayout ratio={0.5} strip={<div />} pane={null} onResize={() => {}}>
          {terminal}
        </PanelSplitLayout>,
      )
      const before = screen.getByText('terminal')
      expect(container.querySelector('.jamat-panel-split__pane')).toBeNull()

      rerender(
        <PanelSplitLayout ratio={0.5} strip={<div />} pane={<p>document</p>} onResize={() => {}}>
          {terminal}
        </PanelSplitLayout>,
      )

      expect(screen.getByText('terminal')).toBe(before)
      expect(container.querySelector('.jamat-panel-split__pane')).not.toBeNull()
    })
  })
})
