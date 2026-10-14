import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileViewerSearchBar, useFileViewerSearch } from './fileViewerSearch'
import { FileViewerSearchRanges } from './fileViewerSearchRanges'

function SearchViewer(props: { name: string; children: React.ReactNode }): React.JSX.Element {
  const body = useRef<HTMLDivElement>(null)
  const search = useFileViewerSearch(body, () => undefined)
  return (
    <section className="file-viewer" aria-label={props.name} tabIndex={-1} onKeyDown={search.onKeyDown}>
      <button onClick={search.show}>Find</button>
      <FileViewerSearchBar search={search} />
      <div ref={body}>{props.children}</div>
    </section>
  )
}

describe('FileViewer search', () => {
  beforeEach(() => {
    vi.stubGlobal('Highlight', class extends Set<Range> { priority = 0 })
    vi.stubGlobal('CSS', { highlights: new Map<string, Highlight>() })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('finds literal text across inline markup without joining different paragraphs or hidden controls', () => {
    const view = render(<div>
      <p>Hello <strong>WO</strong>rld</p>
      <p>Hello </p><p>world</p>
      <button>Hello world</button>
      <p hidden>Hello world</p>
      <p style={{ display: 'none' }}>Hello world</p>
      <p>İ: [a.b] and [A.B]</p>
    </div>)
    expect(FileViewerSearchRanges.find(view.container, 'hello world').map((range) => range.toString()))
      .toEqual(['Hello WOrld'])
    expect(FileViewerSearchRanges.find(view.container, '[a.b]').map((range) => range.toString()))
      .toEqual(['[a.b]', '[A.B]'])
  })

  it('ignores diff gutters and searches only the displayed line text', () => {
    const view = render(<div>
      <div className="file-diff-toolbar">needle</div>
      <span className="file-diff-line">
        <span className="file-diff-gutter">123</span>
        <span className="file-diff-marker">+</span>
        <span className="file-diff-text">needle <span>123</span></span>
      </span>
    </div>)
    expect(FileViewerSearchRanges.find(view.container, '123')).toHaveLength(1)
    expect(FileViewerSearchRanges.find(view.container, 'needle')).toHaveLength(1)
  })

  it('bounds ranges for a broad query and reports that narrowing the search is needed', () => {
    render(<SearchViewer name="Large"><pre>{'a'.repeat(20_000)}</pre></SearchViewer>)
    fireEvent.click(screen.getByRole('button', { name: 'Find' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a' } })
    expect(screen.getByText('1 / 10000+')).toBeVisible()
    expect(CSS.highlights.get('file-viewer-search')?.size).toBe(10_000)
    cleanup()
    expect(CSS.highlights.size).toBe(0)
  })

  it('wraps through matches with Enter, Shift+Enter, arrows and buttons without replacing text or selection', async () => {
    const view = render(<SearchViewer name="Document"><pre>one ONE one</pre></SearchViewer>)
    const viewer = screen.getByLabelText('Document')
    viewer.focus()
    fireEvent.keyDown(viewer, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('textbox', { name: 'Find in file' })
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: 'one' } })
    expect(await screen.findByText('1 / 3')).toBeVisible()
    expect(CSS.highlights.get('file-viewer-search')?.size).toBe(3)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('2 / 3')).toBeVisible()
    expect([...CSS.highlights.get('file-viewer-search-active')!][0].startOffset).toBe(4)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('1 / 3')).toBeVisible()
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(screen.getByText('3 / 3')).toBeVisible()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByText('1 / 3')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
    expect(screen.getByText('2 / 3')).toBeVisible()
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(screen.getByText('2 / 3')).toBeVisible()
    fireEvent.keyDown(viewer, { key: 'f', ctrlKey: true })
    expect(input).toHaveFocus()
    expect((input as HTMLInputElement).selectionEnd).toBe(3)

    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(view.container.querySelector('pre')!)
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(selection.toString()).toBe('one ONE one')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(viewer).toHaveFocus()
    expect(CSS.highlights.size).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Find' }))
    expect(screen.getByRole('textbox')).toHaveValue('one')
  })

  it('keeps each pane scoped, updates after async rendering and removes only its own highlights', async () => {
    const view = render(<>
      <input aria-label="Terminal" />
      <SearchViewer name="First"><p>target target</p></SearchViewer>
      <SearchViewer name="Second"><p>target</p></SearchViewer>
    </>)
    fireEvent.keyDown(screen.getByLabelText('Terminal'), { key: 'f', ctrlKey: true })
    expect(screen.queryByRole('search')).toBeNull()
    const first = within(screen.getByLabelText('First'))
    const second = within(screen.getByLabelText('Second'))
    for (const pane of [first, second]) {
      fireEvent.click(pane.getByRole('button', { name: 'Find' }))
      fireEvent.change(pane.getByRole('textbox'), { target: { value: 'target' } })
    }
    expect(first.getByText('1 / 2')).toBeVisible()
    expect(second.getByText('1 / 1')).toBeVisible()
    expect(CSS.highlights.get('file-viewer-search')?.size).toBe(3)
    fireEvent.click(first.getByRole('button', { name: 'Close search' }))
    expect(CSS.highlights.get('file-viewer-search')?.size).toBe(1)

    view.rerender(<>
      <input aria-label="Terminal" />
      <SearchViewer name="First"><p>target target</p></SearchViewer>
      <SearchViewer name="Second"><p>target <strong>target</strong> target</p></SearchViewer>
    </>)
    await waitFor(() => expect(second.getByText('1 / 3')).toBeVisible())
    expect(CSS.highlights.get('file-viewer-search')?.size).toBe(3)
    fireEvent.change(second.getByRole('textbox'), { target: { value: 'absent' } })
    expect(second.getByText('No matches')).toBeVisible()
    expect(second.getByRole('button', { name: 'Next match' })).toBeDisabled()
    expect(CSS.highlights.size).toBe(0)
    view.unmount()
    expect(CSS.highlights.size).toBe(0)
  })

  it('opens collapsed details and scrolls to the exact range inside a large raw text node', () => {
    const view = render(<div style={{ overflow: 'auto' }}>
      <details><summary>More</summary><pre>first\nlast match</pre></details>
    </div>)
    const root = view.container.firstElementChild as HTMLElement
    Object.defineProperties(root, { clientHeight: { value: 100 }, scrollHeight: { value: 1000 } })
    const range = FileViewerSearchRanges.find(root, 'match')[0]
    range.getBoundingClientRect = () => ({ top: 600, height: 20 } as DOMRect)
    act(() => FileViewerSearchRanges.reveal(root, range))
    expect(view.container.querySelector('details')).toHaveAttribute('open')
    expect(root.scrollTop).toBe(560)
  })
})
