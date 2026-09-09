import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { type SidebarSide, SidebarsState } from '../../../shared/sidebarsState'
import { SidebarDock } from './sidebarDock'

describe('app-client-ui/renderer/widgets/sidebar/sidebarDock', () => {
  function mount(side: SidebarSide, width = 260) {
    const onResize = vi.fn()
    const onClose = vi.fn()
    render(
      <SidebarDock side={side} title="Explorer" width={width} onResize={onResize} onClose={onClose}>
        <p>content of the view</p>
      </SidebarDock>,
    )
    return { onResize, onClose, splitter: screen.getByRole('separator') }
  }

  function drag(splitter: HTMLElement, fromX: number, toX: number): void {
    fireEvent.pointerDown(splitter, { pointerId: 1, clientX: fromX })
    fireEvent.pointerMove(splitter, { pointerId: 1, clientX: toX })
  }

  it('shows the title and whatever content it was handed', () => {
    mount('left')
    expect(screen.getByText('Explorer')).toBeTruthy()
    expect(screen.getByText('content of the view')).toBeTruthy()
  })

  it('applies the width it is given', () => {
    mount('left', 320)
    expect(screen.getByLabelText('Explorer').style.width).toBe('320px')
  })

  it('closes through the handler rather than hiding itself', () => {
    const { onClose } = mount('left')
    fireEvent.click(screen.getByLabelText('Close Explorer'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('grows the left sidebar when the splitter is dragged right', () => {
    const { onResize, splitter } = mount('left', 260)
    drag(splitter, 400, 460)
    expect(onResize).toHaveBeenLastCalledWith(320)
  })

  // The splitter is on the inner edge, so the same gesture means the opposite width on the right.
  it('shrinks the right sidebar when the splitter is dragged right', () => {
    const { onResize, splitter } = mount('right', 260)
    drag(splitter, 400, 460)
    expect(onResize).toHaveBeenLastCalledWith(200)
  })

  it('never reports a width outside the allowed range', () => {
    const { onResize, splitter } = mount('left', 260)
    drag(splitter, 400, 4000)
    expect(onResize).toHaveBeenLastCalledWith(SidebarsState.maxWidthConst)
    drag(splitter, 400, 0)
    expect(onResize).toHaveBeenLastCalledWith(SidebarsState.minWidthConst)
  })

  it('ignores a pointer that moves without having pressed the splitter', () => {
    const { onResize, splitter } = mount('left')
    fireEvent.pointerMove(splitter, { pointerId: 1, clientX: 900 })
    expect(onResize).not.toHaveBeenCalled()
  })

  // The OS can take the pointer away (a native drag, a dialog, an alt-tab) with neither pointerup
  // nor pointercancel. The drag record used to survive that, and the next buttonless move across
  // the splitter resized the sidebar and stored the jump.
  it('stops resizing when the capture is lost without a release', () => {
    const { onResize, splitter } = mount('left', 260)
    fireEvent.pointerDown(splitter, { pointerId: 1, clientX: 400 })
    fireEvent.lostPointerCapture(splitter, { pointerId: 1 })

    fireEvent.pointerMove(splitter, { pointerId: 1, clientX: 900 })

    expect(onResize).not.toHaveBeenCalled()
  })

  it('stops resizing once the pointer is released', () => {
    const { onResize, splitter } = mount('left', 260)
    fireEvent.pointerDown(splitter, { pointerId: 1, clientX: 400 })
    fireEvent.pointerUp(splitter, { pointerId: 1, clientX: 400 })
    fireEvent.pointerMove(splitter, { pointerId: 1, clientX: 900 })
    expect(onResize).not.toHaveBeenCalled()
  })

  // A splitter that only answers a mouse is a splitter half the users cannot move.
  it('resizes with the arrow keys, in the direction the splitter moves', () => {
    const { onResize, splitter } = mount('left', 260)
    fireEvent.keyDown(splitter, { key: 'ArrowRight' })
    expect(onResize).toHaveBeenLastCalledWith(276)
    fireEvent.keyDown(splitter, { key: 'ArrowLeft' })
    expect(onResize).toHaveBeenLastCalledWith(244)
  })

  it('leaves other keys to the surface underneath', () => {
    const { onResize, splitter } = mount('left')
    fireEvent.keyDown(splitter, { key: 'Enter' })
    expect(onResize).not.toHaveBeenCalled()
  })
})
