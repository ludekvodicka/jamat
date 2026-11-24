import { cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it } from 'vitest'

import { FileViewerKeyboardScroll } from './fileViewerKeyboardScroll'

function ScrollableViewer(props: { diff?: boolean; children?: React.ReactNode }): React.JSX.Element {
  const body = useRef<HTMLDivElement>(null)
  return (
    <section
      className="file-viewer"
      aria-label="Viewer"
      tabIndex={-1}
      onKeyDown={(event) => { FileViewerKeyboardScroll.handle(event, body.current) }}
    >
      <div className="file-viewer-toolbar">
        <button type="button">Wrap</button>
        <select aria-label="Diff against">
          <option value="a">A</option>
          <option value="b">B</option>
        </select>
        <input type="text" aria-label="Find in file" />
      </div>
      <div className="file-viewer-body" ref={body} tabIndex={-1}>
        {props.diff
          ? <div className="file-diff-scroll" tabIndex={-1}>{props.children}</div>
          : props.children}
      </div>
    </section>
  )
}

function setMetrics(element: HTMLElement, clientHeight: number, scrollHeight: number): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
  })
}

describe('app-client-ui/renderer/fileViewer/fileViewerKeyboardScroll', () => {
  afterEach(() => {
    cleanup()
  })

  it('scrolls the viewer body on PageDown, PageUp, Home, End and Ctrl+Home/End when the outer section or toolbar has focus', () => {
    const view = render(<ScrollableViewer><input type="checkbox" aria-label="Step" /></ScrollableViewer>)
    const viewer = view.getByLabelText('Viewer')
    const body = view.container.querySelector<HTMLElement>('.file-viewer-body')!
    setMetrics(body, 400, 2000)

    expect(fireEvent.keyDown(viewer, { key: 'PageDown' })).toBe(false)
    expect(body.scrollTop).toBe(360)

    expect(fireEvent.keyDown(view.getByRole('button', { name: 'Wrap' }), { key: 'PageDown' })).toBe(false)
    expect(body.scrollTop).toBe(720)

    expect(fireEvent.keyDown(view.getByRole('checkbox', { name: 'Step' }), { key: 'End' })).toBe(false)
    expect(body.scrollTop).toBe(1600)

    expect(fireEvent.keyDown(body, { key: 'PageUp' })).toBe(false)
    expect(body.scrollTop).toBe(1240)

    expect(fireEvent.keyDown(viewer, { key: 'Home' })).toBe(false)
    expect(body.scrollTop).toBe(0)

    expect(fireEvent.keyDown(viewer, { key: 'End', ctrlKey: true })).toBe(false)
    expect(body.scrollTop).toBe(1600)

    expect(fireEvent.keyDown(viewer, { key: 'Home', ctrlKey: true })).toBe(false)
    expect(body.scrollTop).toBe(0)
  })

  it('scrolls the inner diff scroller in diff mode', () => {
    const view = render(<ScrollableViewer diff />)
    const viewer = view.getByLabelText('Viewer')
    const body = view.container.querySelector<HTMLElement>('.file-viewer-body')!
    const diffScroller = view.container.querySelector<HTMLElement>('.file-diff-scroll')!
    setMetrics(body, 400, 400)
    setMetrics(diffScroller, 300, 1500)

    expect(fireEvent.keyDown(viewer, { key: 'PageDown' })).toBe(false)
    expect(diffScroller.scrollTop).toBe(263)
    expect(body.scrollTop).toBe(0)

    expect(fireEvent.keyDown(viewer, { key: 'End' })).toBe(false)
    expect(diffScroller.scrollTop).toBe(1200)

    expect(fireEvent.keyDown(viewer, { key: 'Home' })).toBe(false)
    expect(diffScroller.scrollTop).toBe(0)
  })

  it('leaves text inputs, selects, modified chords and non-overflowing views alone', () => {
    const view = render(<ScrollableViewer />)
    const viewer = view.getByLabelText('Viewer')
    const body = view.container.querySelector<HTMLElement>('.file-viewer-body')!
    setMetrics(body, 400, 2000)

    expect(fireEvent.keyDown(view.getByRole('textbox', { name: 'Find in file' }), { key: 'End' })).toBe(true)
    expect(fireEvent.keyDown(view.getByRole('combobox', { name: 'Diff against' }), { key: 'PageDown' })).toBe(true)
    expect(fireEvent.keyDown(viewer, { key: 'PageDown', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(viewer, { key: 'PageDown', shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(viewer, { key: 'Home', altKey: true })).toBe(true)
    expect(body.scrollTop).toBe(0)

    setMetrics(body, 400, 400)
    expect(fireEvent.keyDown(viewer, { key: 'PageDown' })).toBe(true)
    expect(body.scrollTop).toBe(0)
  })

  it('ignores key presses coming from a React portal outside the viewer DOM', () => {
    const view = render(
      <ScrollableViewer>
        {createPortal(<div role="menu" tabIndex={-1} aria-label="Portal menu" />, document.body)}
      </ScrollableViewer>,
    )
    const body = view.container.querySelector<HTMLElement>('.file-viewer-body')!
    setMetrics(body, 400, 2000)

    expect(fireEvent.keyDown(view.getByRole('menu', { name: 'Portal menu' }), { key: 'PageDown' })).toBe(true)
    expect(body.scrollTop).toBe(0)
  })
})
