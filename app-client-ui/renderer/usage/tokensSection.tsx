import { useEffect, useMemo, useRef, useState } from 'react'
import type { TokenAgentId, TokenUsageQuery, TokenUsageResult, TokenUsageRow } from '../../../lib-orchestrator/tokenUsage/tokenUsageApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { AppControl } from '../ipc/appControl'
import { IpcSnapshotReader } from '../ipc/ipcSnapshotReader'
import { UsageChart, usageChartTheme } from './usageChart'
import { TokensSectionModel } from './tokensSectionModel'
import { type TokenPeriodPreset, UsageModel } from './usageModel'
import { Segmented, Tile } from './usageParts'

type TokenViews = Record<TokenUsageQuery['groupBy'], TokenUsageResult>
type AgentChoice = TokenAgentId | 'all'

const agentOptionsConst: readonly { value: AgentChoice; label: string }[] = [
  { value: 'all', label: 'All agents' }, { value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' },
]

export function TokensSection(): React.JSX.Element {
  const [preset, setPreset] = useState<TokenPeriodPreset>('week')
  const [custom, setCustom] = useState(() => UsageModel.tokenPeriod('week', new Date()))
  const period = useMemo(() => preset === 'custom' ? custom : UsageModel.tokenPeriod(preset, new Date()), [preset, custom])
  const [agent, setAgent] = useState<AgentChoice>('all')
  const [views, setViews] = useState<TokenViews | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rescanning, setRescanning] = useState(false)
  const reader = useRef<IpcSnapshotReader<TokenViews> | null>(null)
  const live = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    setViews(null)
    setError(null)
    const { from, to } = period
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
  }, [period, agent])
  const charts = useMemo(() => views ? {
    day: TokensSectionModel.chart(views.day.rows, usageChartTheme()),
    hour: TokensSectionModel.chart(views.hour.rows, usageChartTheme()),
  } : null, [views])
  const totals = useMemo(() => views ? TokensSectionModel.sum(views.day.rows) : null, [views])
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
  const scanning = !views || progress?.running === true
  return <section aria-label="Tokens" className="jamat-usage__card jamat-usage__tokens">
    <div className="jamat-usage__toolbar">
      <h2>Tokens</h2>
      <Segmented label="Period" options={UsageModel.tokenPeriodsConst} value={preset} onChange={setPreset} />
      {preset === 'custom' && <>
        <input type="date" aria-label="Period from" value={custom.from} onChange={event => setCustom({ ...custom, from: event.target.value })} />
        <input type="date" aria-label="Period to" value={custom.to} onChange={event => setCustom({ ...custom, to: event.target.value })} />
      </>}
      <Segmented label="Agent" options={agentOptionsConst} value={agent} onChange={setAgent} />
      <span className="jamat-usage__spacer" />
      {scanning && <span role="status" className="jamat-usage__muted">Scanning transcripts… {progress ? `${progress.completed} / ${progress.total} files` : ''}</span>}
      <button type="button" disabled={rescanning || progress?.running} onClick={() => { void rescan() }}>Rescan</button>
    </div>
    {error && <p role="alert" className="jamat-usage__alert">{error}</p>}
    {progress?.error && <p role="alert" className="jamat-usage__alert">{progress.error}</p>}
    {views && views.day.rows.length === 0 && !progress?.running && <p className="jamat-usage__empty">No usage in this period</p>}
    {views && charts && totals && views.day.rows.length > 0 && <>
      <div className="jamat-usage__tiles">
        <Tile label="Total" value={UsageModel.tokens(TokensSectionModel.total(totals))} />
        <Tile label="Input" value={UsageModel.tokens(totals.input)} />
        <Tile label="Output" value={UsageModel.tokens(totals.output)} />
        <Tile label="Cache read" value={UsageModel.tokens(totals.cacheRead)} />
        <Tile label="Cache write" value={UsageModel.tokens(totals.cacheWrite)} />
      </div>
      <div className="jamat-usage__pair">
        <figure><figcaption>Per day</figcaption><UsageChart spec={charts.day} label="Token usage per day" readout={label => TokensSectionModel.readout(views.day.rows, String(label))} /></figure>
        <figure><figcaption>Hour of day</figcaption><UsageChart spec={charts.hour} label="Token usage per hour in this machine's local time" readout={label => TokensSectionModel.readout(views.hour.rows, String(label))} /></figure>
      </div>
      <div className="jamat-usage__pair">
        <TokenTable rows={views.project.rows} subject="Project" showAgent={agent === 'all'} />
        <TokenTable rows={views.account.rows} subject="Account" showAgent={agent === 'all'} />
      </div>
    </>}
  </section>
}

/** Largest first, compact numbers, the full count on hover. */
function TokenTable({ rows, subject, showAgent }: { rows: readonly TokenUsageRow[]; subject: string; showAgent: boolean }): React.JSX.Element {
  const sorted = [...rows].sort((left, right) => TokensSectionModel.total(right) - TokensSectionModel.total(left))
  const largest = sorted[0] ? TokensSectionModel.total(sorted[0]) : 0
  const cell = (value: number): React.JSX.Element => <td className="jamat-usage__number" title={value.toLocaleString()}>{UsageModel.tokens(value)}</td>
  return <table className="jamat-usage__table">
    <thead><tr><th>{subject}</th>{showAgent && <th>Agent</th>}<th className="jamat-usage__number">Input</th><th className="jamat-usage__number">Output</th>
      <th className="jamat-usage__number">Cache read</th><th className="jamat-usage__number">Cache write</th><th className="jamat-usage__number">Total</th></tr></thead>
    <tbody>{sorted.map(row => {
      const total = TokensSectionModel.total(row)
      return <tr key={`${row.agentId}/${row.key}`}>
        <td className="jamat-usage__share" style={{ '--share': `${largest === 0 ? 0 : total / largest * 100}%` } as React.CSSProperties}>{row.label}</td>
        {showAgent && <td className="jamat-usage__muted">{UsageModel.agentLabels[row.agentId]}</td>}
        {cell(row.input)}{cell(row.output)}{cell(row.cacheRead)}{cell(row.cacheWrite)}
        <td className="jamat-usage__number jamat-usage__strong" title={total.toLocaleString()}>{UsageModel.tokens(total)}</td>
      </tr>
    })}</tbody>
  </table>
}
