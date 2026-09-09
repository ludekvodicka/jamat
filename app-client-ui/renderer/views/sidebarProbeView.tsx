import { useEffect, useState } from 'react'

import type { SidebarViewProps } from '../widgets/sidebar/sidebarRegistry'
import './sidebarProbeView.css'

/**
 * The sidebar's half of the lifecycle probe. It proves the contract the widget promises: a view
 * mounts once and keeps its own state while the sidebar is resized, and the width it is told about
 * is the width that was stored. Like the panel probe, it stays in the app as a diagnostic.
 */
class SidebarProbeLedger {
  private static readonly counts = new Map<string, number>()

  static record(viewKey: string): number {
    const next = (SidebarProbeLedger.counts.get(viewKey) ?? 0) + 1
    SidebarProbeLedger.counts.set(viewKey, next)
    return next
  }
}

export function SidebarProbeView(props: SidebarViewProps): React.JSX.Element {
  const [mountCount, setMountCount] = useState(0)
  const [clicks, setClicks] = useState(0)

  useEffect(() => setMountCount(SidebarProbeLedger.record(props.viewKey)), [props.viewKey])

  return (
    <section className="jamat-sidebar-probe" aria-label={`Sidebar probe ${props.side}`}>
      <dl className="jamat-sidebar-probe__facts">
        <div className="jamat-sidebar-probe__fact">
          <dt>Side</dt>
          <dd>{props.side}</dd>
        </div>
        <div className="jamat-sidebar-probe__fact">
          <dt>View</dt>
          <dd>{props.viewKey}</dd>
        </div>
        <div className="jamat-sidebar-probe__fact">
          <dt>Width</dt>
          <dd>{props.width}</dd>
        </div>
        <div className="jamat-sidebar-probe__fact">
          <dt>Mounts</dt>
          <dd className={mountCount > 1 ? 'jamat-sidebar-probe__alarm' : undefined}>{mountCount}</dd>
        </div>
      </dl>
      <button
        className="jamat-sidebar-probe__button"
        type="button"
        onClick={() => setClicks((current) => current + 1)}
      >
        {`Local state: ${clicks}`}
      </button>
    </section>
  )
}
