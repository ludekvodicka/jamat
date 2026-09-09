import { useCallback, useEffect, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'

import { SidebarProbeView } from '../views/sidebarProbeView'
import { SidebarDock } from '../widgets/sidebar/sidebarDock'
import { PanelSidebarLayout, usePanelSidebar } from '../widgets/tabs/panelSidebar'
import { useTabDecorationsPublisher } from '../widgets/tabs/tabDecorationsContext'
import './probePanel.css'

export interface ProbeEntry {
  sequence: number
  time: string
  text: string
}

class ProbePanelConst {
  static readonly logLimit = 50
  /** A tab's own sidebar sits on the right, away from the window's left column. */
  static readonly sidebarSide = 'right' as const
}

/**
 * Module state on purpose: it outlives the component, so a second mount of the SAME panel id is
 * the visible proof that dockview tore a panel down and built it again. Every promise this shell
 * makes about a live panel - a terminal keeping its scrollback, a stream staying attached - rests
 * on that count staying at one for the life of the window.
 */
class ProbeMountLedger {
  private static readonly counts = new Map<string, number>()

  static record(panelId: string): number {
    const next = (ProbeMountLedger.counts.get(panelId) ?? 0) + 1
    ProbeMountLedger.counts.set(panelId, next)
    return next
  }
}

export function ProbePanel(props: IDockviewPanelProps): React.JSX.Element {
  const api = props.api
  const sidebar = usePanelSidebar(props)
  const [mountCount, setMountCount] = useState(0)
  const [entries, setEntries] = useState<readonly ProbeEntry[]>([])
  const [visible, setVisible] = useState(api.isVisible)
  const [active, setActive] = useState(api.isActive)
  const [width, setWidth] = useState(api.width)
  const [height, setHeight] = useState(api.height)
  // Nothing outside the panel knows about it, which is the point: it has to survive hide, reveal,
  // drag and split without the user re-doing anything.
  const [clicks, setClicks] = useState(0)
  const [readOnly, setReadOnly] = useState(false)
  const publishDecorations = useTabDecorationsPublisher(api.id)

  const append = useCallback((text: string) => {
    setEntries((current) => [
      ...current.slice(-(ProbePanelConst.logLimit - 1)),
      { sequence: (current[current.length - 1]?.sequence ?? 0) + 1, time: ProbeClock.now(), text },
    ])
  }, [])

  useEffect(() => setMountCount(ProbeMountLedger.record(api.id)), [api.id])

  // `api` and primitives only. Dockview hands a NEW params object on every updateParameters, so an
  // effect that depended on props.params would tear these subscriptions down on every write.
  useEffect(() => {
    const disposables = [
      api.onDidVisibilityChange((event) => {
        setVisible(event.isVisible)
        append(`visibility ${event.isVisible ? 'visible' : 'hidden'}`)
      }),
      api.onDidActiveChange((event) => {
        setActive(event.isActive)
        append(`active ${event.isActive}`)
      }),
      // The width and height are logged, not just applied: a hidden panel reports 0x0, and that is
      // the reading a terminal must never fit itself to.
      api.onDidDimensionsChange((event) => {
        setWidth(event.width)
        setHeight(event.height)
        append(`dimensions ${event.width}x${event.height}`)
      }),
    ]
    return () => {
      for (const disposable of disposables)
        disposable.dispose()
    }
  }, [api, append])

  // The probe is the only content this shell has, so it is also the proof that a tab draws what its
  // content publishes and nothing else: the dot follows the panel's own activity, the second slot
  // follows its sidebar, and the badge follows a button nobody outside this panel knows about.
  useEffect(() => {
    publishDecorations({
      primary: {
        glyph: '●',
        tone: active ? 'ok' : 'muted',
        title: active ? 'Active panel' : 'Inactive panel',
      },
      secondary: sidebar.state.visible
        ? { glyph: '◧', tone: 'accent', title: 'Tab sidebar open' }
        : null,
      badges: readOnly ? [{ key: 'ro', text: 'RO', tone: 'muted', title: 'Read only' }] : [],
    })
  }, [publishDecorations, active, sidebar.state.visible, readOnly])

  return (
    <PanelSidebarLayout
      side={ProbePanelConst.sidebarSide}
      sidebar={(
        <SidebarDock
          side={ProbePanelConst.sidebarSide}
          title="Tab Probe"
          width={sidebar.state.width}
          hidden={!sidebar.state.visible}
          onResize={sidebar.resize}
          onClose={sidebar.toggle}
        >
          <SidebarProbeView
            side={ProbePanelConst.sidebarSide}
            viewKey={`tab:${api.id}`}
            width={sidebar.state.width}
          />
        </SidebarDock>
      )}
    >
      <section className="jamat-probe" aria-label="Lifecycle probe">
        <dl className="jamat-probe__facts">
          <div className="jamat-probe__fact">
            <dt>Mounts</dt>
            <dd className={mountCount > 1 ? 'jamat-probe__alarm' : undefined}>{mountCount}</dd>
          </div>
          <div className="jamat-probe__fact">
            <dt>Visible</dt>
            <dd>{String(visible)}</dd>
          </div>
          <div className="jamat-probe__fact">
            <dt>Active</dt>
            <dd>{String(active)}</dd>
          </div>
          <div className="jamat-probe__fact">
            <dt>Size</dt>
            <dd>{`${width}x${height}`}</dd>
          </div>
        </dl>
        <div className="jamat-probe__actions">
          <button
            className="jamat-probe__button"
            type="button"
            onClick={() => setClicks((current) => current + 1)}
          >
            {`Local state: ${clicks}`}
          </button>
          <button
            className="jamat-probe__button"
            type="button"
            onClick={sidebar.toggle}
          >
            {sidebar.state.visible ? 'Hide tab sidebar' : 'Show tab sidebar'}
          </button>
          <button
            className="jamat-probe__button"
            type="button"
            onClick={() => setReadOnly((current) => !current)}
          >
            {readOnly ? 'Clear RO badge' : 'Set RO badge'}
          </button>
        </div>
        <ol className="jamat-probe__log" aria-label="Lifecycle events">
          {entries.map((entry) => (
            <li className="jamat-probe__entry" key={entry.sequence}>
              <span className="jamat-probe__time">{entry.time}</span>
              {entry.text}
            </li>
          ))}
        </ol>
      </section>
    </PanelSidebarLayout>
  )
}

class ProbeClock {
  /** Wall clock trimmed to hh:mm:ss.mmm - the ordering of two events matters, the date does not. */
  static now(): string {
    return new Date().toISOString().slice(11, 23)
  }
}
