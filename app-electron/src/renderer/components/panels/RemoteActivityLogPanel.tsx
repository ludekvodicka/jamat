import { IDockviewPanelProps } from 'dockview'
import { useEffect, useRef, useState } from 'react'

/** One Remote Activity Log line (mirrors the `remote:activity` IPC payload). */
export interface RemoteActivityEntry {
  ts: number
  /** `controller` = this PC drove a peer; `controlled` = a peer drove this PC. */
  side: 'controller' | 'controlled'
  /** Who drove it. */
  via: 'human' | 'ai'
  /** The other machine (peer we acted on / caller that acted on us). */
  machine: string
  action?: string
  phase?: string
  target?: string
  payload?: string
  corrId?: string
  scenario?: string
  message: string
}

// Module-level ring + listeners, same pattern as ErrorLogPanel — the buffer
// survives the panel being closed/reopened and is filled by `useRemoteActivityLog`
// even before the panel mounts (it auto-opens on the first entry).
const buffer: RemoteActivityEntry[] = []
const listeners = new Set<() => void>()

export function pushRemoteActivity(e: RemoteActivityEntry): void {
  buffer.push(e)
  if (buffer.length > 1000) buffer.shift()
  listeners.forEach((fn) => fn())
}

export function getRemoteActivity(): RemoteActivityEntry[] {
  return buffer
}

function fmt(e: RemoteActivityEntry): string {
  const t = new Date(e.ts).toLocaleTimeString()
  const arrow = e.side === 'controller' ? '▶' : '◀'
  const who = e.via === 'ai' ? 'AI' : 'human'
  const scen = e.scenario ? ` (${e.scenario})` : ''
  const kind = e.phase ?? e.action ?? ''
  return `${t} ${arrow} [${who}] ${e.machine}${scen}${kind ? ` · ${kind}` : ''}: ${e.message}`
}

type Filter = 'all' | 'human' | 'ai'

export function RemoteActivityLogPanel(_props: IDockviewPanelProps) {
  const [, setTick] = useState(0)
  const [filter, setFilter] = useState<Filter>('all')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const boxRef = useRef<HTMLDivElement>(null)
  const toggle = (ts: number) => setExpanded((s) => { const n = new Set(s); n.has(ts) ? n.delete(ts) : n.add(ts); return n })

  useEffect(() => {
    const update = () => setTick((t) => t + 1)
    listeners.add(update)
    return () => { listeners.delete(update) }
  }, [])

  // Autoscroll to the newest line on each update.
  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  })

  const shown = filter === 'all' ? buffer : buffer.filter((e) => e.via === filter)
  const copyAll = () => navigator.clipboard.writeText(shown.map(fmt).join('\n'))
  const clear = () => { buffer.length = 0; setTick((t) => t + 1) }

  const tabBtn = (f: Filter, label: string) => (
    <button
      className="notes-btn"
      onClick={() => setFilter(f)}
      style={filter === f ? { borderColor: '#5a9', color: '#9ec' } : undefined}
    >{label}</button>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#161616', color: '#ddd', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid #2a2a2a', fontSize: 12 }}>
        <span style={{ color: '#888' }}>Remote Activity — {shown.length}/{buffer.length} event{buffer.length !== 1 ? 's' : ''}</span>
        {tabBtn('all', 'All')}
        {tabBtn('human', 'Human')}
        {tabBtn('ai', 'AI')}
        <span style={{ marginLeft: 'auto', color: '#666' }}>▶ this PC drives a peer · ◀ a peer drives us</span>
        <button className="notes-btn" onClick={copyAll}>Copy</button>
        <button className="notes-btn" onClick={clear}>Clear</button>
      </div>
      <div ref={boxRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 }}>
        {shown.length === 0
          ? <div style={{ color: '#666' }}>No remote-control activity yet. This tab opens automatically when a peer is controlled — by you or by the AI, in or out.</div>
          : shown.map((e, i) => {
              const hasPayload = !!e.payload
              const open = hasPayload && expanded.has(e.ts)
              return (
                <div key={i}>
                  <div
                    onClick={hasPayload ? () => toggle(e.ts) : undefined}
                    title={hasPayload ? 'click to show the exact text' : undefined}
                    style={{ color: e.side === 'controller' ? '#7fb0e0' : '#e0a85f', whiteSpace: 'pre-wrap', wordBreak: 'break-word', cursor: hasPayload ? 'pointer' : 'default' }}
                  >{hasPayload ? (open ? '▾ ' : '▸ ') : '  '}{fmt(e)}</div>
                  {open && (
                    <pre style={{ margin: '2px 0 6px 16px', padding: '6px 8px', background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 3, color: '#bbb', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, lineHeight: 1.4, maxHeight: 320, overflow: 'auto' }}>{e.payload}</pre>
                  )}
                </div>
              )
            })}
      </div>
    </div>
  )
}
