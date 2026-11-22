import { act, cleanup, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FileViewerDisclosures,
  FileViewerPlace,
  FileViewerScrollTop,
  useFileViewerPlaceRestore,
  useFileViewerScrollSave,
} from './fileViewerScrollRestore'

class FileViewerDisclosuresHarness {
  static body(summaries: readonly string[]): HTMLElement {
    const body = document.createElement('div')
    for (const summary of summaries) {
      const details = document.createElement('details')
      details.append(Object.assign(document.createElement('summary'), { textContent: summary }), 'content')
      body.append(details)
    }
    return body
  }

  static open(body: HTMLElement): boolean[] {
    return [...body.querySelectorAll('details')].map((details) => details.open)
  }
}

describe('app-client-ui/renderer/fileViewer/fileViewerScrollRestore', () => {
  it('reopens sections by summary and occurrence after an edit inserts one above them', () => {
    const before = FileViewerDisclosuresHarness.body(['Guide', 'Step', 'Step'])
    before.querySelectorAll('details')[2]!.open = true
    const open = FileViewerDisclosures.of(before)

    const after = FileViewerDisclosuresHarness.body(['New', 'Guide', 'Step', 'Step'])
    FileViewerDisclosures.apply(after, open)

    expect(FileViewerDisclosuresHarness.open(after)).toEqual([false, false, false, true])
  })

  it('closes a section the reader closed and leaves an unknown one as drawn', () => {
    const before = FileViewerDisclosuresHarness.body(['Guide'])
    const open = FileViewerDisclosures.of(before)
    const after = FileViewerDisclosuresHarness.body(['Guide', 'Fresh'])
    for (const details of after.querySelectorAll('details')) details.open = true

    FileViewerDisclosures.apply(after, open)

    expect(FileViewerDisclosuresHarness.open(after)).toEqual([false, true])
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('keeps no place for the top of a visit and the offset of a reload taken there', () => {
    expect(FileViewerPlace.at(undefined)).toBeUndefined()
    expect(FileViewerPlace.of(null)).toBeUndefined()
    expect(FileViewerPlace.of(FileViewerDisclosuresHarness.body([]))?.scrollTop).toBe(0)
  })

  it('reads and restores the inner diff scroller when diff mode is drawn inside the viewer body', () => {
    const body = document.createElement('div')
    const diffScroller = document.createElement('div')
    diffScroller.className = 'file-diff-scroll'
    diffScroller.scrollTop = 340
    body.append(diffScroller)

    expect(FileViewerScrollTop.of(body)).toBe(340)
    const captured = FileViewerPlace.of(body)
    expect(captured?.scrollTop).toBe(340)

    diffScroller.scrollTop = 0
    captured?.apply(body)
    expect(diffScroller.scrollTop).toBe(340)
    expect(body.scrollTop).toBe(0)
  })

  it('ignores key presses outside the viewer while cancelling restore on key presses inside it', () => {
    const terminal = document.createElement('div')
    terminal.className = 'jamat-terminal'
    const viewer = document.createElement('section')
    viewer.className = 'file-viewer'
    const body = document.createElement('div')
    body.className = 'file-viewer-body'
    viewer.append(body)
    document.body.append(terminal, viewer)

    const onDone = vi.fn()
    const place = FileViewerPlace.at(500)
    renderHook(() => useFileViewerPlaceRestore({ current: body }, place, true, onDone))
    expect(body.scrollTop).toBe(500)

    fireEvent.keyDown(terminal, { key: 'Enter' })
    expect(onDone).not.toHaveBeenCalled()

    fireEvent.keyDown(viewer, { key: 'PageDown' })
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('persists scroll offsets after a pause or scrollend and ignores scrolling while disabled', () => {
    vi.useFakeTimers()
    const body = document.createElement('div')
    document.body.append(body)
    const onSave = vi.fn()
    const view = renderHook(
      ({ enabled }) => useFileViewerScrollSave({ current: body }, enabled, onSave),
      { initialProps: { enabled: false } },
    )

    body.scrollTop = 220
    fireEvent.scroll(body)
    act(() => vi.advanceTimersByTime(FileViewerScrollTop.saveDebounceMillisecondsConst))
    expect(onSave).not.toHaveBeenCalled()

    view.rerender({ enabled: true })
    body.scrollTop = 410
    fireEvent.scroll(body)
    act(() => vi.advanceTimersByTime(FileViewerScrollTop.saveDebounceMillisecondsConst - 1))
    expect(onSave).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onSave).toHaveBeenCalledWith(410)

    onSave.mockClear()
    body.scrollTop = 0
    fireEvent.scroll(body)
    fireEvent(body, new Event('scrollend'))
    expect(onSave).toHaveBeenCalledWith(undefined)
  })
})
