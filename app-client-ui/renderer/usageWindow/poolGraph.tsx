import { useEffect, useMemo, useState } from 'react'
import type { RateAgentId } from '../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import type { PoolSeries } from '../../../lib-orchestrator/rateMonitor/usageApi.types'
import { AppControl } from '../ipc/appControl'
import { IpcSnapshotReader } from '../ipc/ipcSnapshotReader'
import { poolGraphSpec } from './poolGraphSpec'
import { UsageChart, usageChartTheme } from './usageChart'
import { UsageWindowModel } from './usageWindowModel'

export function PoolGraph({ agentId, labels }: { agentId: RateAgentId; labels: Readonly<Record<string, string>> }): React.JSX.Element {
  const [burnHours, setBurnHours] = useState<1 | 3 | 6>(3)
  const [from, setFrom] = useState(() => localInput(Date.now() - 86_400_000))
  const [to, setTo] = useState(() => localInput(Date.now() + 7 * 86_400_000))
  const [series, setSeries] = useState<PoolSeries | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const start = new Date(from).getTime(), end = new Date(to).getTime()
    setSeries(null)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { setError('Choose an end after the start.'); return }
    return new IpcSnapshotReader({ subject: 'Pool history',
      read: () => AppControl.value('usage.history', { agentId, from: start, to: end, burnHours }),
      subscribe: changed => window.appClient.onUsageChanged(changed), reportError: message => console.error(message),
    }, setSeries, setError).start()
  }, [agentId, from, to, burnHours])
  const spec = useMemo(() => series ? poolGraphSpec(series, usageChartTheme()) : null, [series])
  const historical = series !== null && (series.displayRange?.to ?? series.until) < series.now
  const account = (id: string): string => labels[id] ?? id
  return <div>
    <div className="jamat-usage__controls">
      <label>Burn range <select value={burnHours} onChange={event => {
        const value = Number(event.target.value)
        if (value === 1 || value === 3 || value === 6) setBurnHours(value)
        else throw new Error(`Unknown burn range: ${value}`)
      }}>{[1, 3, 6].map(hours => <option key={hours} value={hours}>{hours}h</option>)}</select></label>
      <label>From <input type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label>To <input type="datetime-local" value={to} onChange={event => setTo(event.target.value)} /></label>
    </div>
    {error && <p role="alert">{error}</p>}
    {historical && <p>Historical range. Projection facts are available from Now onward.</p>}
    {series && !historical && <div className="jamat-usage__facts">
      <p>Burn rate <strong>{series.burnPerHour.toFixed(1)}%/h</strong></p>
      <p>Pool empty <strong>{series.knownAccounts < series.totalAccounts ? 'Unknown (partial quota)' : series.poolEmptyAt === null
        ? `not by ${UsageWindowModel.reset(series.until)}` : UsageWindowModel.reset(series.poolEmptyAt)}</strong></p>
      <p>First empty <strong>{series.firstEmpty ? `${account(series.firstEmpty.accountId)}: ${UsageWindowModel.reset(series.firstEmpty.at)}` : 'None in range'}</strong></p>
      <p>Next reset <strong>{series.nextReset ? `${account(series.nextReset.accountId)}: ${UsageWindowModel.reset(series.nextReset.at)} (+${series.nextReset.gain.toFixed(0)}%)` : 'None known in range'}</strong></p>
    </div>}
    {spec ? <UsageChart spec={spec} label={`${UsageWindowModel.agentLabels[agentId]} ${historical ? 'recorded weekly pool' : 'recorded and projected weekly pool; projection begins at Now'}`} />
      : <p role="status">{series ? 'No recorded quota in this range' : 'Reading pool history…'}</p>}
  </div>
}

function localInput(at: number): string {
  const date = new Date(at)
  return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
