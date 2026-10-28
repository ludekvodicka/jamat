import { useEffect, useMemo, useRef, useState } from 'react'
import type { TokenAgentId, TokenUsageQuery, TokenUsageResult, TokenUsageRow } from '../../../lib-orchestrator/tokenUsage/tokenUsageApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { AppControl } from '../ipc/appControl'
import { IpcSnapshotReader } from '../ipc/ipcSnapshotReader'
import { UsageChart, usageChartTheme } from './usageChart'
import { TokensSectionModel } from './tokensSectionModel'
import { UsageWindowModel } from './usageWindowModel'

type TokenViews = Record<TokenUsageQuery['groupBy'], TokenUsageResult>

export function TokensSection(): React.JSX.Element {
  const [from, setFrom] = useState(() => TokensSectionModel.day(new Date(Date.now() - 6 * 86_400_000)))
  const [to, setTo] = useState(() => TokensSectionModel.day(new Date()))
  const [agent, setAgent] = useState<TokenAgentId | 'all'>('all')
  const [views, setViews] = useState<TokenViews | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rescanning, setRescanning] = useState(false)
  const reader = useRef<IpcSnapshotReader<TokenViews> | null>(null)
  const live = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    setViews(null)
    if (!from || !to || from > to) { setError('Choose a valid period.'); return }
    const read = async (): Promise<IpcResult<TokenViews>> => {
      const groups = ['day', 'project', 'hour', 'account'] as const
      const replies = await Promise.all(groups.map(groupBy => AppControl.value('usage.tokens', {
        from, to, groupBy, ...(agent === 'all' ? {} : { agentId: agent }),
      })))
      const values: Partial<TokenViews> = {}
      for (let index = 0; index < groups.length; index++) {
        const reply = replies[index]
        if (!reply.ok) return reply
        values[groups[index]] = reply.value
      }
      return { ok: true, value: values as TokenViews }
    }
    const engine = new IpcSnapshotReader({ subject: 'Token statistics', read,
      subscribe: changed => window.appClient.onUsageChanged(changed), reportError: message => console.error(message),
    }, setViews, setError)
    reader.current = engine
    const stop = engine.start()
    return () => { reader.current = null; stop() }
  }, [from, to, agent])
  const charts = useMemo(() => views ? {
    day: TokensSectionModel.chart(views.day.rows, 'Day', usageChartTheme()),
    hour: TokensSectionModel.chart(views.hour.rows, 'Hour (local time)', usageChartTheme()),
  } : null, [views])
  const progress = views?.day.progress
  const rescan = async (): Promise<void> => {
    setRescanning(true)
    try {
      const result = await AppControl.value('usage.rescan', {})
      if (!live.current) return
      if (!result.ok) setError(result.error)
      reader.current?.refresh()
    } catch (error) { if (live.current) setError(String(error)) }
    finally { if (live.current) setRescanning(false) }
  }
  return <section aria-label="Tokens" className="jamat-usage__tokens">
    <h2>Tokens</h2>
    <div className="jamat-usage__controls">
      <label>Period from <input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label>Period to <input type="date" value={to} onChange={event => setTo(event.target.value)} /></label>
      <label>Agent <select value={agent} onChange={event => {
        const value = event.target.value
        if (value === 'all' || value === 'claude' || value === 'codex') setAgent(value)
        else throw new Error(`Unknown token agent: ${value}`)
      }}><option value="all">All agents</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
      <button type="button" disabled={rescanning || progress?.running} onClick={() => { void rescan() }}>Rescan</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {progress?.error && <p role="alert">{progress.error}</p>}
    {(!views || progress?.running) && <p role="status">Scanning local transcripts… {progress ? `${progress.completed} / ${progress.total} files` : ''}</p>}
    {views && views.day.rows.length === 0 && !progress?.running && <p>No usage in this period</p>}
    {views && charts && views.day.rows.length > 0 && <>
      <h3>Daily tokens</h3><UsageChart spec={charts.day} label="Token usage per day" />
      <h3>Projects</h3><TokenTable rows={views.project.rows} subject="Project" />
      <h3>Hour of day</h3><UsageChart spec={charts.hour} label="Token usage per hour in this machine's local time" />
      <h3>Accounts</h3><TokenTable rows={views.account.rows} subject="Account" />
    </>}
  </section>
}

function TokenTable({ rows, subject }: { rows: readonly TokenUsageRow[]; subject: string }): React.JSX.Element {
  const number = (value: number): string => value.toLocaleString()
  return <table><thead><tr><th>{subject}</th><th>Agent</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Total</th></tr></thead>
    <tbody>{rows.map(row => <tr key={`${row.agentId}/${row.key}`}><td>{row.label}</td><td>{UsageWindowModel.agentLabels[row.agentId]}</td>
      <td>{number(row.input)}</td><td>{number(row.output)}</td><td>{number(row.cacheRead)}</td><td>{number(row.cacheWrite)}</td><td>{number(TokensSectionModel.total(row))}</td></tr>)}</tbody>
  </table>
}
