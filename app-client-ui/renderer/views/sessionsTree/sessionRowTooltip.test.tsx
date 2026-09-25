import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SessionRowTooltip,
  SessionRowTooltipConst,
  SessionRowTooltipPlacement,
  useSessionRowTooltip,
} from './sessionRowTooltip'

describe('app-client-ui/renderer/views/sessionsTree/sessionRowTooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('opens after its own short delay, with the note as a paragraph of its own under the title', () => {
    render(<Row title="i2 - fix commit pane" note="Waiting for the SVN review of r4599." />)
    fireEvent.pointerEnter(title())

    elapse(SessionRowTooltipConst.openDelayMs - 1)
    expect(screen.queryByRole('tooltip')).toBeNull()
    elapse(1)

    const tip = screen.getByRole('tooltip')
    expect(tip.querySelector('.jamat-sessions__tooltip-title')?.textContent).toBe('i2 - fix commit pane')
    expect(tip.querySelector('p.jamat-sessions__tooltip-note')?.textContent)
      .toBe('Waiting for the SVN review of r4599.')
    expect(title().getAttribute('aria-describedby')).toBe(tip.id)
    expect(title().hasAttribute('title')).toBe(false)
  })

  it('draws the title alone when the session has no note', () => {
    render(<Row title="Beta worktree" note={null} />)
    hoverOpen()
    expect(screen.getByRole('tooltip').querySelector('.jamat-sessions__tooltip-note')).toBeNull()
  })

  it('never opens for a pointer that left before the delay, and closes when it leaves', () => {
    render(<Row title="Alpha" note="n" />)
    fireEvent.pointerEnter(title())
    fireEvent.pointerLeave(title())
    elapse(SessionRowTooltipConst.openDelayMs * 2)
    expect(screen.queryByRole('tooltip')).toBeNull()

    hoverOpen()
    fireEvent.pointerLeave(title())
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows the same card for keyboard focus, and takes it away on blur and Escape', () => {
    render(<Row title="Alpha" note="n" />)
    act(() => title().focus())
    elapse(SessionRowTooltipConst.openDelayMs)
    expect(screen.getByRole('tooltip')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()

    act(() => title().blur())
    act(() => title().focus())
    elapse(SessionRowTooltipConst.openDelayMs)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    act(() => title().blur())
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('goes on any scroll, including a scroller inside the page', () => {
    render(<Row title="Alpha" note="n" />)
    hoverOpen()
    fireEvent.scroll(document.body)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  // The press opens a terminal and leaves the pointer where it was; the card must not come back
  // over that terminal until the pointer has left the row once.
  it('goes on a press and stays gone until the pointer leaves the row', () => {
    render(<Row title="Alpha" note="n" />)
    hoverOpen()
    fireEvent.pointerDown(title())
    fireEvent.click(title())
    expect(screen.queryByRole('tooltip')).toBeNull()

    fireEvent.pointerEnter(title())
    elapse(SessionRowTooltipConst.openDelayMs * 2)
    expect(screen.queryByRole('tooltip')).toBeNull()

    fireEvent.pointerLeave(title())
    hoverOpen()
    expect(screen.getByRole('tooltip')).toBeTruthy()
  })

  it('goes on a click anywhere else in the window', () => {
    render(<Row title="Alpha" note="n" />)
    hoverOpen()
    fireEvent.click(document.body)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('never survives the row it belongs to, and a pending one never opens after it', () => {
    const shown = render(<Row title="Alpha" note="n" />)
    hoverOpen()
    shown.unmount()
    expect(screen.queryByRole('tooltip')).toBeNull()

    const pending = render(<Row title="Alpha" note="n" />)
    fireEvent.pointerEnter(title())
    pending.unmount()
    elapse(SessionRowTooltipConst.openDelayMs * 2)
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  describe('placement', () => {
    const gap = SessionRowTooltipConst.gapPx

    it('sits under the row, starting where the title starts', () => {
      expect(SessionRowTooltipPlacement.beside({ left: 40, top: 100, bottom: 120 }, 200, 60, 1000, 800))
        .toEqual({ x: 40, y: 120 + gap })
    })

    it('goes above the row when the window has no room below it', () => {
      expect(SessionRowTooltipPlacement.beside({ left: 40, top: 760, bottom: 780 }, 200, 60, 1000, 800))
        .toEqual({ x: 40, y: 760 - gap - 60 })
    })

    it('is pulled back inside the window on the right', () => {
      expect(SessionRowTooltipPlacement.beside({ left: 900, top: 100, bottom: 120 }, 200, 60, 1000, 800))
        .toEqual({ x: 1000 - 200 - gap, y: 120 + gap })
    })

    it('keeps its top edge on screen in a window shorter than the card', () => {
      expect(SessionRowTooltipPlacement.beside({ left: 0, top: 20, bottom: 40 }, 200, 300, 1000, 200).y)
        .toBe(gap)
    })
  })
})

function Row(props: { title: string; note: string | null }): React.JSX.Element {
  const tooltip = useSessionRowTooltip()
  return (
    <div>
      <button type="button" {...tooltip.anchorProps}>{props.title}</button>
      {tooltip.open && (
        <SessionRowTooltip id={tooltip.id} anchor={tooltip.anchor} title={props.title} note={props.note} />
      )}
    </div>
  )
}

function title(): HTMLButtonElement {
  return screen.getByRole('button')
}

function elapse(milliseconds: number): void {
  act(() => {
    vi.advanceTimersByTime(milliseconds)
  })
}

function hoverOpen(): void {
  fireEvent.pointerEnter(title())
  elapse(SessionRowTooltipConst.openDelayMs)
  expect(screen.getByRole('tooltip')).toBeTruthy()
}
