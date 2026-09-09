import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ContextMenu, type ContextMenuEntry } from './contextMenu'

describe('app-client-ui/renderer/widgets/contextMenu', () => {
  const initialViewport = { width: window.innerWidth, height: window.innerHeight }

  afterEach(() => {
    vi.restoreAllMocks()
    window.innerWidth = initialViewport.width
    window.innerHeight = initialViewport.height
  })

  function draw(items: readonly ContextMenuEntry[], onClose = vi.fn()): { onClose: () => void } {
    render(
      <ContextMenu
        position={{ x: 10, y: 10 }}
        ariaLabel="Tab actions"
        items={items}
        onClose={onClose}
      />,
    )
    return { onClose }
  }

  function rectangle(left: number, top: number, width: number, height: number): DOMRect {
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect
  }

  function mockSubmenuLayout(row: DOMRect, flyout: DOMRect): void {
    const menu = rectangle(10, 10, 176, 100)
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLDivElement,
    ): DOMRect {
      if (this.classList.contains('jamat-context-menu__row')) return row
      if (this.classList.contains('jamat-context-menu__flyout')) return flyout
      return menu
    })
  }

  /**
   * The terminal's menu is drawn before its detections land and grows when they do. Measured only
   * against the click, it kept the top it was given for the small box: opened near the bottom edge
   * it had been flipped upward to fit, and the rows that arrived afterwards went past the edge with
   * nothing to scroll them back.
   */
  it('measures again when the rows change, not only when the click moves', () => {
    const rowHeight = 30
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLDivElement,
    ): DOMRect {
      const rows = this.querySelectorAll('[role="menuitem"]').length
      return { width: 200, height: rows * rowHeight, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0,
        toJSON: () => ({}) } as DOMRect
    })
    window.innerHeight = 200
    const short: ContextMenuEntry[] = [
      { key: 'a', label: 'Paste', onSelect: vi.fn() },
      { key: 'b', label: 'Paste as text', onSelect: vi.fn() },
    ]
    const grown: ContextMenuEntry[] = [
      ...short,
      ...Array.from({ length: 4 }, (_, index) => ({
        key: `found-${index}`,
        label: `Open found-${index}.md in tab`,
        onSelect: vi.fn(),
      })),
    ]

    // One object, both renders: the caller mints the position at the click and holds it, so its
    // identity never changes while the menu is up. A fresh literal per render would re-run the
    // effect on its own and prove nothing.
    const position = { x: 10, y: 100 }
    const view = render(
      <ContextMenu position={position} ariaLabel="Terminal actions" items={short}
        onClose={vi.fn()} />,
    )
    const menu = screen.getByRole('menu')
    const placed = menu.style.top

    view.rerender(
      <ContextMenu position={position} ariaLabel="Terminal actions" items={grown}
        onClose={vi.fn()} />,
    )

    // Two rows fitted below the click in a 200px window; six do not, so the grown box is lifted.
    expect(placed).to.equal('100px')
    expect(menu.style.top).to.not.equal(placed)
    expect(Number.parseInt(menu.style.top, 10)).to.be.lessThan(100)
  })

  it('draws a flat list of actions, which is what every caller before submenus passed', () => {
    const first = vi.fn()
    draw([
      { key: 'a', label: 'Close Tab', onSelect: first },
      { key: 'b', label: 'Split Right', onSelect: vi.fn() },
    ])

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent))
      .toEqual(['Close Tab', 'Split Right'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close Tab' }))
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('closes the whole menu once an action has run', () => {
    const onClose = vi.fn()
    draw([{ key: 'a', label: 'Close Tab', onSelect: vi.fn() }], onClose)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Close Tab' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('draws a separator that no keyboard or pointer can land on', () => {
    draw([
      { key: 'a', label: 'Close Tab', onSelect: vi.fn() },
      { kind: 'separator', key: 's1' },
      { key: 'b', label: 'Split Right', onSelect: vi.fn() },
    ])

    expect(screen.getAllByRole('separator')).toHaveLength(1)
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
  })

  it('opens a submenu on hover and again on a click of its parent', () => {
    draw([{
      key: 'colour',
      label: 'Session Appearance',
      children: [{ key: 'red', label: 'Red', onSelect: vi.fn() }],
    }])

    const parent = screen.getByRole('menuitem', { name: /Session Appearance/ })
    expect(parent).toHaveAttribute('aria-haspopup', 'menu')
    expect(parent).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu', { name: 'Session Appearance' })).toBeNull()

    fireEvent.mouseEnter(parent.parentElement as HTMLElement)

    expect(parent).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu', { name: 'Session Appearance' })).toBeTruthy()
  })

  it('places a submenu to the right when it fits in the viewport', () => {
    window.innerWidth = 500
    window.innerHeight = 400
    mockSubmenuLayout(rectangle(100, 50, 176, 30), rectangle(0, 0, 160, 200))
    draw([{
      key: 'colour',
      label: 'Session Appearance',
      children: [{ key: 'red', label: 'Red', onSelect: vi.fn() }],
    }])

    fireEvent.mouseEnter(
      screen.getByRole('menuitem', { name: /Session Appearance/ }).parentElement as HTMLElement,
    )

    const submenu = screen.getByRole('menu', { name: 'Session Appearance' })
    expect(submenu.style.left).to.equal('276px')
    expect(submenu.style.top).to.equal('50px')
  })

  it('places a submenu to the left and lifts it above the viewport bottom', () => {
    window.innerWidth = 500
    window.innerHeight = 300
    mockSubmenuLayout(rectangle(300, 260, 176, 30), rectangle(0, 0, 160, 200))
    draw([{
      key: 'colour',
      label: 'Session Appearance',
      children: [{ key: 'red', label: 'Red', onSelect: vi.fn() }],
    }])

    fireEvent.mouseEnter(
      screen.getByRole('menuitem', { name: /Session Appearance/ }).parentElement as HTMLElement,
    )

    const submenu = screen.getByRole('menu', { name: 'Session Appearance' })
    expect(submenu.style.left).to.equal('140px')
    expect(submenu.style.top).to.equal('100px')
  })

  // A parent is a way in, not an action: clicking it must not close the menu it just opened.
  it('does not close the menu when the parent of a submenu is clicked', () => {
    const onClose = vi.fn()
    draw([{
      key: 'colour',
      label: 'Session Appearance',
      children: [{ key: 'red', label: 'Red', onSelect: vi.fn() }],
    }], onClose)

    fireEvent.click(screen.getByRole('menuitem', { name: /Session Appearance/ }))

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('menu', { name: 'Session Appearance' })).toBeTruthy()
  })

  it('runs a submenu choice and closes everything', () => {
    const chosen = vi.fn()
    const onClose = vi.fn()
    draw([{
      key: 'colour',
      label: 'Session Appearance',
      children: [
        { key: 'none', label: 'None', onSelect: vi.fn() },
        { key: 'red', label: 'Red', onSelect: chosen },
      ],
    }], onClose)

    const parent = screen.getByRole('menuitem', { name: /Session Appearance/ })
    fireEvent.mouseEnter(parent.parentElement as HTMLElement)
    const submenu = screen.getByRole('menu', { name: 'Session Appearance' })
    fireEvent.click(within(submenu).getByRole('menuitem', { name: 'Red' }))

    expect(chosen).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes one submenu when the pointer moves to another row', () => {
    draw([
      {
        key: 'colour',
        label: 'Session Appearance',
        children: [{ key: 'red', label: 'Red', onSelect: vi.fn() }],
      },
      { key: 'close', label: 'Close Tab', onSelect: vi.fn() },
    ])

    const parent = screen.getByRole('menuitem', { name: /Session Appearance/ })
    fireEvent.mouseEnter(parent.parentElement as HTMLElement)
    expect(screen.getByRole('menu', { name: 'Session Appearance' })).toBeTruthy()

    const other = screen.getByRole('menuitem', { name: 'Close Tab' })
    fireEvent.mouseEnter(other.parentElement as HTMLElement)

    expect(screen.queryByRole('menu', { name: 'Session Appearance' })).toBeNull()
  })

  it('draws a swatch before the label when one is asked for', () => {
    draw([{
      key: 'colour',
      label: 'Session Appearance',
      children: [{
        key: 'red',
        label: 'Red',
        swatchClassName: 'jamat-tab-menu__swatch--red',
        onSelect: vi.fn(),
      }],
    }])

    const parent = screen.getByRole('menuitem', { name: /Session Appearance/ })
    fireEvent.mouseEnter(parent.parentElement as HTMLElement)

    const swatch = document.querySelector('.jamat-tab-menu__swatch--red')
    expect(swatch).toBeTruthy()
    expect(swatch).toHaveAttribute('aria-hidden', 'true')
  })

  it('escapes and outside clicks still close a menu that has a submenu open', () => {
    const onClose = vi.fn()
    draw([{
      key: 'colour',
      label: 'Session Appearance',
      children: [{ key: 'red', label: 'Red', onSelect: vi.fn() }],
    }], onClose)

    fireEvent.mouseEnter(
      (screen.getByRole('menuitem', { name: /Session Appearance/ }).parentElement) as HTMLElement,
    )
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  /**
   * The keys are the menu's while it is up. The terminal is the caller that makes this load-bearing:
   * xterm parks its hidden textarea under the cursor and focuses it, so a menu that left focus there
   * would send Escape to the agent as well as closing itself.
   */
  it('takes focus while it is up, and hands it back to whoever had it', () => {
    const before = document.createElement('button')
    document.body.appendChild(before)
    before.focus()

    const view = render(
      <ContextMenu
        position={{ x: 10, y: 10 }}
        ariaLabel="Tab actions"
        items={[{ key: 'a', label: 'Close Tab', onSelect: vi.fn() }]}
        onClose={vi.fn()}
      />,
    )

    expect(document.activeElement).toBe(screen.getByRole('menu', { name: 'Tab actions' }))

    view.unmount()

    expect(document.activeElement).toBe(before)
    before.remove()
  })

  // The terminal takes the right button off xterm with a capture-phase `stopPropagation`, so a
  // bubble-phase listener never sees the press that should dismiss whatever menu is already open.
  it('closes on an outside press that a surface below stopped for its own reasons', () => {
    const below = document.createElement('div')
    below.addEventListener('mousedown', (event) => event.stopPropagation(), true)
    document.body.appendChild(below)
    const onClose = vi.fn()
    draw([{ key: 'a', label: 'Close Tab', onSelect: vi.fn() }], onClose)

    fireEvent.mouseDown(below)

    expect(onClose).toHaveBeenCalledTimes(1)
    below.remove()
  })

  /*
   * Two tests stood here until 2026-08-23: a row that neither acts nor opens anything, and a
   * submenu nested two levels deep. Both were runtime refusals thrown inside the render, and both
   * are now impossible to write - `ContextMenuAction` and `ContextMenuSubmenu` are exclusive, and a
   * submenu's children are actions. Neither case compiles any more, which is why neither has a test:
   * the throw they proved is gone, and what replaced it fails before the code runs.
   */
})
