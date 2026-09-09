import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import './contextMenu.css'

export interface ContextMenuPosition {
  x: number
  y: number
}

/** A line between two blocks of items. It carries a key because React needs one, and nothing else. */
export interface ContextMenuSeparator {
  kind: 'separator'
  key: string
}

interface ContextMenuRow {
  key: string
  label: string
  className?: string
  disabled?: boolean
  checked?: boolean
  keepOpenOnSelect?: boolean
  onContextMenu?(): void
  /**
   * The class of a small colour square drawn before the label. A CLASS and never a colour: values
   * live in the tokens file alone, which is what the token gate holds.
   */
  swatchClassName?: string
}

/** A row that does something when it is chosen. */
export interface ContextMenuAction extends ContextMenuRow {
  onSelect(): void
  children?: never
}

/**
 * A row that opens others instead of acting. Its children are actions, never submenus: a second
 * level would need its own opening state and its own side to fit on, and nothing has asked for one.
 */
export interface ContextMenuSubmenu extends ContextMenuRow {
  children: readonly ContextMenuAction[]
  onSelect?: never
}

/**
 * Exactly one of `onSelect` and `children`, said in the type rather than in a comment.
 *
 * It was a comment until 2026-08-23, and the invariant was held by two `throw`s inside the render.
 * That is the worst place for it: React unmounts the whole root when a render throws, so a menu
 * somebody built wrong took the window rather than the row - and `pnpm typecheck` said nothing,
 * because a row with neither was a perfectly good `ContextMenuItem`.
 */
export type ContextMenuItem = ContextMenuAction | ContextMenuSubmenu

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator

export function ContextMenu(props: {
  position: ContextMenuPosition
  ariaLabel: string
  className?: string
  items: readonly ContextMenuEntry[]
  onClose(): void
}): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState(props.position)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const onClose = props.onClose

  // Measured again whenever the rows change, not only when the click moves. A menu whose contents
  // arrive after it opens - the terminal's detections do - was placed for the box it had at the
  // first paint and then grew past the edge it had just been fitted inside.
  useLayoutEffect(() => {
    const box = element.current?.getBoundingClientRect()
    if (box)
      setPlacement(ContextMenuPlacement.inside(props.position, box.width, box.height))
  }, [props.position, props.items])

  // The keys are the menu's while it is up. Without this the surface underneath keeps focus, and
  // under a terminal that surface sends every keystroke - Escape included - to the agent as well.
  useLayoutEffect(() => {
    const restore = document.activeElement
    element.current?.focus()
    return () => {
      if (restore instanceof HTMLElement)
        restore.focus()
    }
  }, [])

  useEffect(() => {
    const close = (): void => onClose()
    const onMouseDown = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || !element.current?.contains(event.target))
        onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape')
        onClose()
    }
    // Capture, so a press a surface below stops for its own reasons still dismisses this: the
    // terminal takes the right button off xterm in the capture phase, and that press never got here.
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', close)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={element}
      className={`jamat-context-menu${props.className ? ` ${props.className}` : ''}`}
      role="menu"
      aria-label={props.ariaLabel}
      tabIndex={-1}
      style={{ left: placement.x, top: placement.y }}
    >
      {props.items.map((entry) => ContextMenuEntries.isSeparator(entry)
        ? (
            <div
              key={entry.key}
              className="jamat-context-menu__separator"
              role="separator"
            />
          )
        : (
            <ContextMenuRowView
              key={entry.key}
              item={entry}
              open={openKey === entry.key}
              onOpen={() => setOpenKey(entry.key)}
              onClose={onClose}
            />
          ))}
    </div>,
    document.body,
  )
}

/**
 * One row, which is either an action or the way into a submenu.
 *
 * The submenu stays inside the row's DOM tree rather than getting a portal of its own, so the
 * menu's close and focus ownership still includes it. Its fixed coordinates escape the main
 * menu's scroll clip.
 */
function ContextMenuRowView(props: {
  item: ContextMenuItem
  open: boolean
  onOpen(): void
  onClose(): void
}): React.JSX.Element {
  const item = props.item
  const children = item.children
  const row = useRef<HTMLDivElement>(null)
  const flyout = useRef<HTMLDivElement>(null)
  const [flyoutPlacement, setFlyoutPlacement] = useState<ContextMenuPosition>({ x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!props.open) return
    const anchor = row.current?.getBoundingClientRect()
    const box = flyout.current?.getBoundingClientRect()
    if (anchor && box)
      setFlyoutPlacement(ContextMenuPlacement.flyout(anchor, box.width, box.height))
  }, [children, props.open])

  return (
    <div ref={row} className="jamat-context-menu__row" onMouseEnter={props.onOpen}>
      <button
        className={`jamat-context-menu__item${item.className ? ` ${item.className}` : ''}`}
        type="button"
        role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
        aria-checked={item.checked}
        disabled={item.disabled}
        aria-haspopup={children === undefined ? undefined : 'menu'}
        aria-expanded={children === undefined ? undefined : props.open}
        onClick={() => {
          if (children !== undefined) {
            props.onOpen()
            return
          }
          item.onSelect?.()
          if (!item.keepOpenOnSelect) props.onClose()
        }}
        onContextMenu={item.onContextMenu === undefined ? undefined : (event) => {
          event.preventDefault()
          event.stopPropagation()
          item.onContextMenu?.()
          props.onClose()
        }}
      >
        {item.checked !== undefined && (
          <span className="jamat-context-menu__check" aria-hidden="true">{item.checked ? '✓' : ''}</span>
        )}
        {item.swatchClassName !== undefined && (
          <span className={`jamat-context-menu__swatch ${item.swatchClassName}`} aria-hidden="true" />
        )}
        <span className="jamat-context-menu__label">{item.label}</span>
        {children !== undefined && <span className="jamat-context-menu__more" aria-hidden="true">›</span>}
      </button>
      {children !== undefined && props.open && (
        <div
          ref={flyout}
          className="jamat-context-menu__flyout"
          role="menu"
          aria-label={item.label}
          style={{ left: flyoutPlacement.x, top: flyoutPlacement.y }}
        >
          {children.map((child) => (
            <ContextMenuRowView
              key={child.key}
              item={child}
              open={false}
              onOpen={() => {}}
              onClose={props.onClose}
            />
          ))}
        </div>
      )}
    </div>
  )
}

class ContextMenuEntries {
  static isSeparator(entry: ContextMenuEntry): entry is ContextMenuSeparator {
    return 'kind' in entry
  }
}

class ContextMenuPlacement {
  static inside(
    position: ContextMenuPosition,
    width: number,
    height: number,
  ): ContextMenuPosition {
    return {
      x: ContextMenuPlacement.axis(position.x, width, window.innerWidth),
      y: ContextMenuPlacement.axis(position.y, height, window.innerHeight),
    }
  }

  static flyout(
    anchor: DOMRect,
    width: number,
    height: number,
  ): ContextMenuPosition {
    return {
      x: anchor.right + width <= window.innerWidth
        ? anchor.right
        : Math.max(0, anchor.left - width),
      y: Math.min(
        Math.max(0, anchor.top),
        Math.max(0, window.innerHeight - height),
      ),
    }
  }

  private static axis(start: number, size: number, viewport: number): number {
    if (start + size <= viewport)
      return start
    return Math.max(0, start - size)
  }
}
