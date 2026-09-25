import { type RefObject, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export class SessionRowTooltipConst {
  /** Chromium holds its native tooltip back for most of a second, and nothing in markup moves it. */
  static readonly openDelayMs = 150
  /** Between the row and the card, and between the card and the window edge. */
  static readonly gapPx = 4
}

export interface SessionRowTooltipPosition {
  x: number
  y: number
}

/** What the title button spreads onto itself, so the hook is the one owner of when the card shows. */
export interface SessionRowTooltipAnchorProps {
  ref: RefObject<HTMLButtonElement | null>
  'aria-describedby': string | undefined
  onPointerEnter(): void
  onPointerLeave(): void
  onPointerDown(): void
  onFocus(event: React.FocusEvent<HTMLButtonElement>): void
  onBlur(): void
}

export interface SessionRowTooltipState {
  open: boolean
  id: string
  anchor: RefObject<HTMLButtonElement | null>
  anchorProps: SessionRowTooltipAnchorProps
}

/**
 * When a session row's card shows, and when it goes.
 *
 * The card replaced the title button's native `title` on 2026-09-24. Chromium draws that one after
 * its own fixed delay, in the system font, as one plain string, so a note arrived late, small and
 * glued to the title by two newlines, and no attribute or CSS property reaches any of the three.
 *
 * A press is a DISMISS rather than a close: the pointer is still over the row after it, and without
 * the latch the hover timer or the focus the press gives the button would open the card again under
 * the terminal the press just opened. The latch lifts when the pointer or the focus leaves.
 */
export function useSessionRowTooltip(): SessionRowTooltipState {
  const anchor = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismissed = useRef(false)
  const [open, setOpen] = useState(false)
  const id = useId()

  const cancel = useCallback((): void => {
    if (timer.current !== null)
      clearTimeout(timer.current)
    timer.current = null
  }, [])
  const close = useCallback((): void => {
    cancel()
    setOpen(false)
  }, [cancel])
  const dismiss = useCallback((): void => {
    dismissed.current = true
    close()
  }, [close])
  const schedule = useCallback((): void => {
    if (dismissed.current || timer.current !== null)
      return
    timer.current = setTimeout(() => {
      timer.current = null
      setOpen(true)
    }, SessionRowTooltipConst.openDelayMs)
  }, [])

  // The row dies with its card, and a timer outliving both would set state on nothing.
  useEffect(() => cancel, [cancel])

  // Only while it is up. Scroll does not bubble, so the capture phase is what hears the tree's own
  // scroller rather than the window's alone.
  useEffect(() => {
    if (!open)
      return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape')
        dismiss()
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    window.addEventListener('click', dismiss, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('click', dismiss, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close, dismiss])

  return {
    open,
    id,
    anchor,
    anchorProps: {
      ref: anchor,
      'aria-describedby': open ? id : undefined,
      onPointerEnter: schedule,
      onPointerLeave: () => {
        dismissed.current = false
        close()
      },
      onPointerDown: dismiss,
      // Keyboard focus only. A button focused by the press that opens its terminal, or by a menu
      // handing focus back after a right-click, is not somebody asking what the row says.
      onFocus: (event) => {
        if (event.currentTarget.matches(':focus-visible'))
          schedule()
      },
      onBlur: () => {
        dismissed.current = false
        close()
      },
    },
  }
}

/**
 * The card itself: the row's title, and under it the note as a paragraph of its own.
 *
 * Portalled to the body so the tree's scroller cannot clip it, and fitted inside the window after it
 * is measured, which the layout effect does before the first paint.
 */
export function SessionRowTooltip(props: {
  id: string
  anchor: RefObject<HTMLButtonElement | null>
  title: string
  note: string | null
}): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<SessionRowTooltipPosition>({ x: 0, y: 0 })

  useLayoutEffect(() => {
    const anchor = props.anchor.current?.getBoundingClientRect()
    const box = element.current?.getBoundingClientRect()
    if (anchor && box)
      setPlacement(SessionRowTooltipPlacement.beside(
        anchor, box.width, box.height, window.innerWidth, window.innerHeight))
  }, [props.anchor, props.title, props.note])

  return createPortal(
    <div
      ref={element}
      id={props.id}
      role="tooltip"
      className="jamat-sessions__tooltip"
      style={{ left: placement.x, top: placement.y }}
    >
      <div className="jamat-sessions__tooltip-title">{props.title}</div>
      {props.note !== null && <p className="jamat-sessions__tooltip-note">{props.note}</p>}
    </div>,
    document.body,
  )
}

export class SessionRowTooltipPlacement {
  /**
   * Under the row, starting where its title starts; above it when the window has no room below.
   * Either way the whole card stays inside the window, which is what the native tooltip did too.
   */
  static beside(
    anchor: Pick<DOMRect, 'left' | 'top' | 'bottom'>,
    width: number,
    height: number,
    viewportWidth: number,
    viewportHeight: number,
  ): SessionRowTooltipPosition {
    const gap = SessionRowTooltipConst.gapPx
    const below = anchor.bottom + gap
    const y = below + height + gap <= viewportHeight ? below : anchor.top - gap - height
    return {
      x: SessionRowTooltipPlacement.clamp(anchor.left, width, viewportWidth),
      y: SessionRowTooltipPlacement.clamp(y, height, viewportHeight),
    }
  }

  private static clamp(start: number, size: number, viewport: number): number {
    const gap = SessionRowTooltipConst.gapPx
    return Math.max(gap, Math.min(start, viewport - size - gap))
  }
}
