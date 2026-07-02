import { useState, useRef, useEffect, type ReactNode } from 'react'

interface MasterDetailLayoutProps {
  /** Fixed bar above the split — toggles, search box, picker, refresh. */
  header?: ReactNode
  /** Top pane: navigation / list. Scrolls independently. */
  nav: ReactNode
  /** Bottom pane: detail for the selected nav item. Scrolls independently. */
  detail: ReactNode
  /** Initial nav-pane height as a % of the split. Default 55. */
  defaultNavBasis?: number
  /** Extra class on the root, e.g. for panel-specific font sizing. */
  className?: string
}

/**
 * Generic master-detail panel shell: a fixed header, a scrollable navigation
 * pane, a draggable splitter, and a scrollable detail pane. Owns only the
 * splitter geometry — selection state and pane content belong to the caller.
 *
 * Shared by SessionChangesPanel (turn/file diffs) and SessionSearchPanel
 * (session list → conversation).
 */
export function MasterDetailLayout({
  header,
  nav,
  detail,
  defaultNavBasis = 55,
  className,
}: MasterDetailLayoutProps) {
  const [navBasis, setNavBasis] = useState(defaultNavBasis)
  const splitRef = useRef<HTMLDivElement>(null)
  // Cleanup for an in-progress drag, so listeners are removed if the panel
  // unmounts mid-drag.
  const dragCleanup = useRef<(() => void) | null>(null)

  useEffect(() => () => dragCleanup.current?.(), [])

  const onSplitterDown = (e: React.MouseEvent) => {
    e.preventDefault()
    // If a prior drag never received its mouseup (OS swallowed it via alt-tab
    // / focus loss / modal dialog), dispose those orphan listeners before
    // allocating new ones — otherwise they accumulate.
    dragCleanup.current?.()
    const onMove = (ev: MouseEvent) => {
      const box = splitRef.current?.getBoundingClientRect()
      if (!box || box.height === 0) return
      const pct = ((ev.clientY - box.top) / box.height) * 100
      setNavBasis(Math.min(80, Math.max(20, pct)))
    }
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      dragCleanup.current = null
    }
    function onUp() {
      cleanup()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    dragCleanup.current = cleanup
  }

  return (
    <div className={`master-detail${className ? ` ${className}` : ''}`}>
      {header}
      <div className="split-body" ref={splitRef}>
        <div className="split-nav" style={{ flexBasis: `${navBasis}%` }}>
          {nav}
        </div>
        <div className="split-divider" onMouseDown={onSplitterDown} />
        <div className="split-detail" style={{ flexBasis: `${100 - navBasis}%` }}>
          {detail}
        </div>
      </div>
    </div>
  )
}
