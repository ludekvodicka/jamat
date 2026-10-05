import { describe, expect, it } from 'vitest'

import { TerminalNotesState } from './terminalNotesState'
import type { TerminalNotesView } from './terminalNotesState'

describe('app-client-ui/renderer/panels/terminal/notes/terminalNotesState', () => {
  function ready(texts: readonly string[]): TerminalNotesView {
    return TerminalNotesState.loaded(TerminalNotesState.initial(), {
      directory: 'C:/work',
      notes: texts.map((text) => ({ text })),
    })
  }

  it('adds an empty note at the end and asks for its focus', () => {
    const view = TerminalNotesState.added(ready(['a']))

    expect(view.entries.map((entry) => entry.text)).toEqual(['a', ''])
    expect(view.focusId).toBe(view.entries[1].id)
    expect(new Set(view.entries.map((entry) => entry.id)).size).toBe(2)
  })

  it('removes a note and keeps the order of the others', () => {
    const view = ready(['a', 'b', 'c'])

    const next = TerminalNotesState.removedOrCleared(view, view.entries[1].id)

    expect(next.entries.map((entry) => entry.text)).toEqual(['a', 'c'])
    expect(next.entries.map((entry) => entry.id)).toEqual([view.entries[0].id, view.entries[2].id])
  })

  it('only empties the last note and keeps its flags', () => {
    const view = TerminalNotesState.toggled(ready(['only']), 'note-1', 'large')

    const next = TerminalNotesState.removedOrCleared(view, 'note-1')

    expect(next.entries).toEqual([{ id: 'note-1', text: '', large: true, sticky: false }])
  })

  it('drops a pasted note that is not sticky and keeps a sticky one', () => {
    const view = TerminalNotesState.toggled(ready(['plain', 'sticky']), 'note-2', 'sticky')

    const plain = TerminalNotesState.pasted(view, 'note-1')
    const sticky = TerminalNotesState.pasted(view, 'note-2')
    const last = TerminalNotesState.pasted(ready(['only']), 'note-1')

    expect(plain.entries.map((entry) => entry.text)).toEqual(['sticky'])
    expect(sticky.entries).toEqual(view.entries)
    expect(last.entries.map((entry) => entry.text)).toEqual([''])
  })

  it('stores only the flags that are true', () => {
    const view = TerminalNotesState.toggled(
      TerminalNotesState.toggled(ready(['a', 'b']), 'note-1', 'large'), 'note-2', 'sticky')

    expect(TerminalNotesState.stored(view.entries)).toEqual([
      { text: 'a', large: true },
      { text: 'b', sticky: true },
    ])
    expect(TerminalNotesState.stored(ready(['c']).entries)).toEqual([{ text: 'c' }])
  })

  it('keeps ids by index when the notes are read again', () => {
    const view = ready(['a', 'b'])

    const next = TerminalNotesState.loaded(view, {
      directory: 'C:/work',
      notes: [{ text: 'a2' }, { text: 'b2', large: true }, { text: 'c' }],
    })

    expect(next.entries.map((entry) => entry.id)).toEqual(['note-1', 'note-2', 'note-3'])
    expect(next.entries[1]).toEqual({ id: 'note-2', text: 'b2', large: true, sticky: false })
  })

  it('shows loading only before the first list, and a failed read leaves nothing to edit', () => {
    expect(TerminalNotesState.loading(TerminalNotesState.initial()).phase).toBe('loading')
    const view = ready(['a'])
    expect(TerminalNotesState.loading(view)).toBe(view)

    const failed = TerminalNotesState.failed(view, 'section damaged')

    expect(failed.phase).toBe('failed')
    expect(failed.entries).toEqual([])
    expect(failed.error).toBe('section damaged')
  })

  it('adopts an imported list and focuses the imported note', () => {
    const view = ready(['a'])

    const next = TerminalNotesState.adopted(view, [{ text: 'a' }, { text: 'draft' }], 1, 'partial')

    expect(next.entries.map((entry) => entry.text)).toEqual(['a', 'draft'])
    expect(next.focusId).toBe(next.entries[1].id)
    expect(next.notice).toBe('partial')
  })

  it('lets an edit drop a focus request', () => {
    const view = TerminalNotesState.added(ready(['a']))

    expect(TerminalNotesState.updated(view, view.entries[1].id, 'x').focusId).toBeNull()
  })
})
