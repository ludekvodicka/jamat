import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import type { SessionInfo } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionTasksStore } from '../../../sessions/sessionTasksStore'
import { SignalGlyph } from '../../../widgets/signalGlyph'
import { ProcessesModel, type ProcessesFilter, type ProcessRow } from './processesModel'
import './processesPanel.css'

export function ProcessesPanel(props: {
  sessionId: string
  info: SessionInfo | null
  tasks: Pick<SessionTasksStore, 'watch' | 'current' | 'subscribe'>
  enabled: boolean
  selectedKey: string | null
  onOpen(row: ProcessRow): void
}): React.JSX.Element {
  const [filter, setFilter] = useState<ProcessesFilter>('all')
  const [now, setNow] = useState(() => Date.now())
  const listings = useSyncExternalStore(
    useCallback((listener) => props.tasks.subscribe(listener), [props.tasks]),
    useCallback(() => props.tasks.current(), [props.tasks]),
  )
  useEffect(() => {
    if (props.enabled) return props.tasks.watch(props.sessionId)
  }, [props.tasks, props.sessionId, props.enabled])
  const listing = listings.get(props.sessionId)
  const rows = ProcessesModel.rowsOf(props.sessionId, listing, props.info?.scripts?.runs ?? [], filter, props.selectedKey, now)
  const running = rows.some((row) => row.running)
  useEffect(() => {
    if (!props.enabled || !running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [props.enabled, running])
  const loading = listing === undefined && props.info?.agent?.nativeSessionId !== undefined
  return (
    <section className="processes" aria-label="Session processes">
      <div className="processes__filters" aria-label="Process filter">
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button>
        <button type="button" aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>Active</button>
      </div>
      <ul className="processes__list">
        {rows.map((row) => (
          <li key={row.key}>
            <button type="button" className="processes__row" aria-current={row.selected ? 'true' : undefined}
              title={row.detail} onClick={() => props.onOpen(row)}>
              <span className={`processes__glyph processes__glyph--${row.paint}`} title={row.stateLabel} aria-label={row.stateLabel}>
                <SignalGlyph glyph={row.glyph} />
              </span>
              <span className="processes__label">{row.label}</span>
              <span className="processes__time">{row.time}</span>
            </button>
          </li>
        ))}
      </ul>
      {loading && <p className="processes__note">Loading processes…</p>}
      {!loading && rows.length === 0 && <p className="processes__note">{filter === 'active' ? 'No active processes.' : 'No processes.'}</p>}
      {listing?.kind === 'none' && <p className="processes__note">{listing.reason}</p>}
      {listing?.kind === 'tasks' && listing.catchingUp && <p className="processes__note">Reading earlier processes…</p>}
      {filter === 'all' && listing?.kind === 'tasks' && listing.olderFinished > 0
        && <p className="processes__note">{listing.olderFinished} older finished processes are outside the retained history.</p>}
    </section>
  )
}
