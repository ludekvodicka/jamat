/**
 * Tests guard CURRENT correctness for two NotesPanel concerns:
 *
 * 1. panelId race / stale view: when panelId switches mid-load, the
 *    panel must NOT briefly show the previous panel's entries. The
 *    fix gates render on `loaded` derived from `useIpcQuery.loading`
 *    so the panel returns null until B's load resolves.
 *
 * 2. sticky[] survives `removeEntry` correctly when sticky was set
 *    on entry index N > 0. Pre-fix sticky stayed length 1 even with
 *    5 loaded entries; `setSticky(sparse-spread)` produced a sparse
 *    array that `filter` collapsed wrong on removal. Post-fix sticky
 *    is resized to match entries on load → filter operates densely.
 *
 * Honest scope: these are CURRENT-behavior tests. They will fail if
 * the current panel's correct behavior regresses, but reverting just
 * one line from the source may not be enough to fail them — the
 * useIpcQuery migration changed how `loaded` is computed, so the
 * pre-fix bug's exact shape is no longer reachable by line revert.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor, act, fireEvent } from '@testing-library/react'
import { NotesPanel } from './NotesPanel'

interface ElectronAPIStub {
  loadNotes: (panelId: string) => Promise<string[]>
  saveNotes: (panelId: string, entries: string[]) => Promise<void>
}

function stubElectronAPI(api: ElectronAPIStub): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).electronAPI = api
}

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).electronAPI
  vi.useRealTimers()
})

describe('NotesPanel panelId race regression', () => {
  it('debounced save after panelId change never writes old data under new id', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    let resolveB!: (v: string[]) => void
    const saveCalls: Array<{ panelId: string; entries: string[] }> = []
    stubElectronAPI({
      loadNotes: (panelId) => {
        if (panelId === 'A') return Promise.resolve(['A1', 'A2'])
        return new Promise<string[]>((r) => { resolveB = r })
      },
      saveNotes: async (panelId, entries) => {
        saveCalls.push({ panelId, entries: [...entries] })
      },
    })

    const noop = () => {}
    const { rerender, container } = render(
      <NotesPanel panelId="A" visible={true} onPaste={noop} />,
    )

    // Wait for A's entries to land
    await waitFor(() => {
      const textareas = container.querySelectorAll('textarea')
      expect(textareas.length).toBe(2)
    })

    // Type into A's first textarea — this triggers a debounced save
    // scheduled in 500ms for panelId=A.
    const firstA = container.querySelectorAll('textarea')[0] as HTMLTextAreaElement
    fireEvent.change(firstA, { target: { value: 'A1-modified' } })

    // Switch panelId to B BEFORE the save timeout fires.
    rerender(<NotesPanel panelId="B" visible={true} onPaste={noop} />)

    // Resolve B's load — panel re-renders with B's data.
    await act(async () => {
      resolveB(['B1'])
      await Promise.resolve()
    })

    // Advance past the original 500ms save debounce window.
    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
    })

    // The fix: reset on panelId change clears saveTimeout. So no save
    // with A's content under any panelId should have fired in this
    // window. Pre-fix: a save under panelId=B with content
    // ['A1-modified', 'A2'] would appear because the timeout closure
    // captured the new panelId but old entries.
    const wrongSaves = saveCalls.filter(
      (s) => s.panelId === 'B' && s.entries.some((e) => e.includes('A1') || e === 'A2'),
    )
    expect(wrongSaves).toEqual([])
  })

  it('sticky state survives a removeEntry — pre-fix the sparse sticky array drops the wrong slot', async () => {
    stubElectronAPI({
      loadNotes: async () => ['one', 'two', 'three', 'four', 'five'],
      saveNotes: vi.fn(),
    })

    const noop = () => {}
    const { container } = render(
      <NotesPanel panelId="P" visible={true} onPaste={noop} />,
    )
    await waitFor(() => {
      expect(container.querySelectorAll('textarea').length).toBe(5)
    })

    // Mark entry 3 ('four') as sticky. Post-fix this writes sticky[3]=true
    // into a length-5 dense array. Pre-fix it writes sticky[3]=true into
    // a sparse length-1-extended-to-4 array → [false, undefined, undefined, true].
    const stickyBefore = container.querySelectorAll('.notes-sticky-btn')
    fireEvent.click(stickyBefore[3])

    await waitFor(() => {
      const btns = container.querySelectorAll('.notes-sticky-btn')
      expect(btns[3].classList.contains('active')).toBe(true)
    })

    // Remove entry 2 ('three'). After removal, what was entry 3 is now
    // entry 2 and should still be sticky.
    //
    // POST-FIX: sticky = [false, false, false, true, false], filter
    //   (i !== 2) → [false, false, true, false]. New stickyBtns[2]
    //   ('four') = sticky[2] = true → 'active'.
    // PRE-FIX:  sticky = [false, undefined, undefined, true] (sparse,
    //   length 4), filter iterates only present indices (0 and 3) →
    //   [false, true]. Length 2 vs entries length 4. New stickyBtns[2]
    //   ('four') = sticky[2] = undefined → NOT 'active'. Test FAILS.
    const removeBtns = container.querySelectorAll('.notes-entry')
    const removeBtn = removeBtns[2].querySelector('.notes-btn:not(.notes-paste-btn):not(.notes-sticky-btn):not(.notes-large-btn)') as HTMLButtonElement
    fireEvent.click(removeBtn)

    await waitFor(() => {
      expect(container.querySelectorAll('textarea').length).toBe(4)
    })

    const stickyAfter = container.querySelectorAll('.notes-sticky-btn')
    expect(stickyAfter.length).toBe(4)
    // The "four" entry is now at index 2. It must still be active.
    expect(stickyAfter[2].classList.contains('active')).toBe(true)
    // Neighboring entries unchanged.
    expect(stickyAfter[0].classList.contains('active')).toBe(false)
    expect(stickyAfter[1].classList.contains('active')).toBe(false)
    expect(stickyAfter[3].classList.contains('active')).toBe(false)
  })
})
