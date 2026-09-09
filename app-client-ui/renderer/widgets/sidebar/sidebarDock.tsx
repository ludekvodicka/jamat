import { useRef } from 'react'

import { type SidebarSide, SidebarsState } from '../../../shared/sidebarsState'
import './sidebarDock.css'

/**
 * A side surface with a header, a body and a splitter. It knows nothing about where its content
 * came from or where its width is stored, which is what lets the same widget be the window's own
 * sidebar and a sidebar that belongs to a single tab.
 */
export function SidebarDock(props: {
  side: SidebarSide
  title: string
  width: number
  /**
   * Hidden by layout, never by unmounting. A closed sidebar keeps its content alive - its local
   * state, its scroll position and, once real views arrive, its subscriptions - which is what the
   * architecture promises for a surface that outlives every tab.
   */
  hidden?: boolean
  /** What the view puts on the title line. Drawn before the close, which stays the last thing there. */
  action?: React.ReactNode
  children: React.ReactNode
  onResize(width: number): void
  onClose(): void
}): React.JSX.Element {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const side = props.side

  return (
    <aside
      className={`jamat-sidebar jamat-sidebar--${side}${props.hidden ? ' jamat-sidebar--hidden' : ''}`}
      style={{ width: props.width }}
      aria-label={props.title}
      aria-hidden={props.hidden}
    >
      <header className="jamat-sidebar__header">
        <span className="jamat-sidebar__title">{props.title}</span>
        {props.action}
        <button
          className="jamat-sidebar__close"
          type="button"
          aria-label={`Close ${props.title}`}
          onClick={props.onClose}
        >
          ×
        </button>
      </header>
      <div className="jamat-sidebar__body">{props.children}</div>
      <div
        className="jamat-sidebar__splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${props.title}`}
        tabIndex={0}
        onPointerDown={(event) => {
          // Pointer capture rather than window listeners: V1's splitter lost its mouseup to an
          // alt-tab and went on resizing against a closure that was gone.
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: props.width }
        }}
        onPointerMove={(event) => {
          const active = drag.current
          if (!active || active.pointerId !== event.pointerId)
            return
          props.onResize(SidebarDockDrag.widthOf(side, active.startWidth, event.clientX - active.startX))
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId)
          drag.current = null
        }}
        // Release, cancel and the element going away all end here. Without it the OS taking the
        // pointer (a native window drag, a system dialog, an alt-tab) left a live drag record, and
        // a later buttonless move across the splitter resized the sidebar and stored the jump.
        onLostPointerCapture={() => { drag.current = null }}
        onKeyDown={(event) => {
          const step = SidebarDockDrag.stepOf(event.key)
          if (step === 0)
            return
          event.preventDefault()
          props.onResize(SidebarDockDrag.widthOf(side, props.width, step))
        }}
      />
    </aside>
  )
}

class SidebarDockDrag {
  private static readonly keyStepConst = 16

  /** The splitter sits on the inner edge, so the right sidebar grows as the pointer moves left. */
  static widthOf(side: SidebarSide, startWidth: number, deltaX: number): number {
    if (side === 'left')
      return SidebarsState.clamp(startWidth + deltaX)
    else if (side === 'right')
      return SidebarsState.clamp(startWidth - deltaX)
    else
      throw new Error(`Unknown sidebar side: ${JSON.stringify(side)}`)
  }

  static stepOf(key: string): number {
    if (key === 'ArrowLeft')
      return -SidebarDockDrag.keyStepConst
    else if (key === 'ArrowRight')
      return SidebarDockDrag.keyStepConst
    else
      return 0
  }
}
