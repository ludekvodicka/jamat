import { useEffect, useMemo, useRef, useState } from 'react'

import type { SessionHistoryOpenSpec } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ErrorText } from '../../../../shared/errorText'
import type { TerminalTarget } from '../../../../shared/terminalTarget'
import type { PanelOpenOutcome } from '../../../shell/appShell.types'
import { HistoricSessionsEffects } from './historicSessionsEffects'
import { HistoricSessionsModel, type HistoricSessionRow } from './historicSessionsModel'
import './history.css'

export function HistoricSessionsOverlay(props: {
  onOpenTerminal(target: TerminalTarget, title: string): Promise<PanelOpenOutcome>
  onClose(): void
}): React.JSX.Element {
  const [rows, setRows] = useState<HistoricSessionRow[]>([])
  const [query, setQuery] = useState('')
  const [range, setRange] = useState<typeof HistoricSessionsModel.rangesConst[number]>('2d')
  const [source, setSource] = useState<typeof HistoricSessionsModel.sourcesConst[number]>('AppJamat')
  const [displayedSource, setDisplayedSource] = useState(source)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [action, setAction] = useState<NonNullable<SessionHistoryOpenSpec['action']>>('rerun')
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState({ completed: 0, total: 0 })
  const [errors, setErrors] = useState<string[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [effects] = useState(() => new HistoricSessionsEffects())
  const busyRef = useRef(false)
  const handedOff = useRef(false)
  const filter = useRef<HTMLInputElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const selectedElement = useRef<HTMLDivElement>(null)
  const filtered = useMemo(() => HistoricSessionsModel.filtered(rows, query), [rows, query])
  const selected = filtered.find((row) => row.key === selectedKey) ?? filtered[0]
  const canOpen = selected !== undefined && (action === 'fork' || !selected.active) && !busy && !loading

  useEffect(() => {
    const restore = document.activeElement
    filter.current?.focus()
    return () => {
      if (!handedOff.current && restore instanceof HTMLElement) restore.focus()
    }
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setErrors([])
    setProgress({ completed: 0, total: 0 })
    void HistoricSessionsEffects.load(
      source,
      HistoricSessionsModel.lastUsedSince(range),
      () => active,
      (detail) => setErrors((current) => [...current, detail]),
      (completed, total) => setProgress({ completed, total }),
    ).then((loaded) => {
      if (active) { setRows(loaded); setDisplayedSource(source) }
    }).catch((error: unknown) => {
      if (active) { setRows([]); setErrors((current) => [...current, ErrorText.of(error)]) }
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [range, source])

  useEffect(() => { selectedElement.current?.scrollIntoView({ block: 'nearest' }) }, [selected?.key])

  const close = (): void => { if (!busyRef.current) props.onClose() }
  const open = async (row = selected): Promise<void> => {
    if (!row || action === 'rerun' && row.active || busyRef.current || loading) return
    busyRef.current = true
    setSelectedKey(row.key)
    setBusy(true)
    setFailure(null)
    try {
      await effects.open(HistoricSessionsModel.spec(row, action), props.onOpenTerminal)
      handedOff.current = true
      props.onClose()
    } catch (error) {
      setFailure(ErrorText.of(error))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="jamat-launcher" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <div className="jamat-launcher__card jamat-launcher__card--wide jamat-launcher-history" role="dialog"
        aria-modal="true" aria-label="Historic sessions" ref={card} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (busy || effects.hasStarted()) return
            const index = filtered.findIndex((row) => row.key === selected?.key)
            const next = Math.max(0, Math.min(filtered.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
            setSelectedKey(filtered[next]?.key ?? null)
          } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
            event.preventDefault()
            void open()
          } else if (event.key === 'Tab') {
            const controls = Array.from(card.current?.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)') ?? [])
            const index = controls.indexOf(document.activeElement as HTMLElement)
            event.preventDefault()
            controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
          }
        }}>
        <header className="jamat-launcher__head">
          <span className="jamat-launcher__title">Historic sessions</span>
          <span className="jamat-launcher-history__count">{filtered.length} / {rows.length}</span>
          <button className="jamat-launcher__close" type="button" aria-label="Close Historic sessions" disabled={busy} onClick={close}>×</button>
        </header>
        <div className="jamat-launcher-history__toolbar">
          <input ref={filter} aria-label="Filter historic sessions" placeholder="Filter by root, directory, session or model…"
            value={query} disabled={busy || effects.hasStarted()} role="combobox" aria-expanded="true" aria-controls="historic-sessions-list"
            aria-autocomplete="list" aria-activedescendant={selected ? `historic-session-${filtered.indexOf(selected)}` : undefined}
            onChange={(event) => { setQuery(event.target.value); setSelectedKey(null) }} />
          <div className="jamat-launcher-history__actions" role="group" aria-label="History source" title="AppJamat reads saved session records; All includes external Claude and Codex history">
            {HistoricSessionsModel.sourcesConst.map((value) => (
              <button key={value} type="button" aria-pressed={source === value} disabled={busy || effects.hasStarted()}
                onClick={() => {
                  if (value !== source) { setSource(value); setLoading(true) }
                  filter.current?.focus()
                }}>{value}</button>
            ))}
          </div>
          <div className="jamat-launcher-history__actions" role="group" aria-label="Last used range" title="Filter by last use; 1m is 30 days">
            {HistoricSessionsModel.rangesConst.map((value) => (
              <button key={value} type="button" aria-pressed={range === value} disabled={busy || effects.hasStarted()}
                onClick={() => {
                  if (value !== range) { setRange(value); setLoading(true) }
                  filter.current?.focus()
                }}>{value}</button>
            ))}
          </div>
          <div className="jamat-launcher-history__actions" role="group" aria-label="Session action">
            <button type="button" aria-pressed={action === 'rerun'} disabled={busy || effects.hasStarted()}
              onClick={() => { setAction('rerun'); filter.current?.focus() }}>Re-run</button>
            <button type="button" aria-pressed={action === 'fork'} disabled={busy || effects.hasStarted()}
              onClick={() => { setAction('fork'); filter.current?.focus() }}>Fork</button>
          </div>
        </div>
        {errors.length > 0 && <div className="jamat-launcher-history__errors" role="status">{errors.map((error, i) => <p key={i}>{error}</p>)}</div>}
        <div className="jamat-launcher-history__table">
          <div className="jamat-launcher-history__columns" aria-hidden="true">
            <span>Root</span><span>Directory</span><span>Session</span><span>Model</span><span>Created</span><span>Last used ↓</span>
          </div>
          <div className="jamat-launcher-history__list" id="historic-sessions-list" role="listbox" aria-label="Historic sessions" aria-busy={loading}>
            {filtered.map((row, index) => (
              <div key={row.key} id={`historic-session-${index}`} ref={row === selected ? selectedElement : undefined}
                role="option" aria-selected={row === selected}
                className={`jamat-launcher-history__row${row === selected ? ' jamat-launcher-history__row--selected' : ''}`}
                onClick={() => { if (!busy && !effects.hasStarted()) setSelectedKey(row.key) }}
                onDoubleClick={() => { if (!effects.hasStarted()) void open(row) }}>
                <span title={row.root.path}>{row.root.label}</span>
                <span title={row.project.path}>{row.project.name}</span>
                <span title={row.label}>{row.label}{row.active && <small>Running</small>}</span>
                <span title={displayedSource === 'AppJamat' ? `Model saved at launch: ${row.model ?? 'Unknown'}` : row.model ?? 'Model was not recorded'}>{row.model ?? 'Unknown'}<small>{row.agentId === 'claude' ? 'Claude' : 'Codex'}</small></span>
                <time dateTime={new Date(row.createdAt).toISOString()}>{row.createdLabel}</time>
                <time dateTime={row.lastActivity === null ? undefined : new Date(row.lastActivity).toISOString()} title={displayedSource === 'AppJamat' ? row.lastActivity === null ? 'User input time was not recorded. Older sessions are available with the all time range.' : 'Last user input recorded by AppJamat' : 'Transcript last modified'}>{row.lastUsedLabel}</time>
              </div>
            ))}
            {filtered.length === 0 && <p className="jamat-launcher-history__empty">{loading ? 'Loading sessions…' : rows.length === 0 ? displayedSource === 'AppJamat' && range !== 'all' ? 'No sessions with recorded user input in this range. Choose all to include older sessions with an unknown last-use time.' : 'No historic sessions found.' : 'No sessions match this filter.'}</p>}
          </div>
        </div>
        {failure && <p className="jamat-launcher__error" role="alert">{failure}</p>}
        <footer className="jamat-launcher__foot">
          <span role="status">{loading ? progress.total > 0 ? `Loading history… (${progress.completed}/${progress.total} projects)` : 'Loading history…' : '↑ ↓ Select · Enter Open · Esc Close'}</span>
          <span className="jamat-launcher-history__hint">{selected?.active && action === 'rerun' ? 'This session is running. Select Fork.' : ''}</span>
          <button type="button" className="jamat-launcher-history__submit" disabled={!canOpen} onClick={() => { void open() }}>
            {busy ? 'Opening…' : effects.hasStarted() ? 'Open started session' : action === 'rerun' ? 'Re-run session' : 'Fork session'}
          </button>
        </footer>
      </div>
    </div>
  )
}
