import './usageStats/usageStats.css'
import { IDockviewPanelProps } from 'dockview'
import { useEffect, useRef, useState } from 'react'
import { useIpcQuery } from '../../hooks/useIpcQuery'
import type { StatsDataResult, Stats } from '../../../../../core/types/stats'
import { OverviewTab } from './usageStats/OverviewTab'
import { Last24hTab } from './usageStats/Last24hTab'
import { DetailedTab } from './usageStats/DetailedTab'

type TabKey = 'overview' | '24h' | '5h' | '1h'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: '24h', label: 'Last 24h' },
  { key: '5h', label: 'Detailed 5h' },
  { key: '1h', label: 'Detailed 1h' },
]

/**
 * Native-React Usage Stats tab. Fetches the parsed stats.json over the `stats:data`
 * IPC channel (one-shot on mount via useIpcQuery; the ↻ button forces a regenerate by
 * flipping forceRef before refetch). Renders the 4 report views in native React with
 * hand-rolled SVG/CSS charts — no webview, no Chart.js CDN. Replaces the legacy
 * webview-based UsageStatsPanel (kept alongside as "Usage Stats (HTML)").
 */
export function UsageStatsNativePanel({ api }: IDockviewPanelProps) {
  const forceRef = useRef(false)
  const [tab, setTab] = useState<TabKey>('overview')
  const q = useIpcQuery<StatsDataResult>(
    () => { const f = forceRef.current; forceRef.current = false; return window.electronAPI.getStatsData(f) },
    [],
  )
  useEffect(() => { api.setTitle('📊 Usage Stats') }, [api])

  const refresh = () => { forceRef.current = true; q.refetch() }
  const result = q.data
  const stats: Stats | null = result?.ok ? result.data : null

  if (q.loading && !stats) {
    return <div className="usage-stats-empty"><div className="usage-spinner" />Generating usage statistics…</div>
  }
  if (q.error || (result && !result.ok)) {
    const msg = q.error?.message || (result && !result.ok ? result.error : 'Unknown error')
    return (
      <div className="usage-stats-error">
        <div>Failed to load usage stats</div>
        <div className="usage-stats-error-detail">{msg}</div>
        <button className="usage-stats-refresh" onClick={refresh}>Retry</button>
      </div>
    )
  }
  if (!stats) return <div className="usage-stats-empty">No usage data yet.</div>

  return (
    <div className="usage-stats-panel">
      <div className="usage-stats-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`usage-stats-tab${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
        <div className="usage-stats-tabs-spacer" />
        <span className="usage-stats-generatedat">{new Date(stats.generatedAt).toLocaleString()}</span>
        <button className="usage-stats-refresh" onClick={refresh} disabled={q.loading}>
          {q.loading ? <span className="usage-spinner-sm" /> : '⟳'} Refresh
        </button>
      </div>
      <div className="usage-stats-body">
        <div className="usage-stats-content">
          {tab === 'overview' && <OverviewTab stats={stats} />}
          {tab === '24h' && <Last24hTab stats={stats} />}
          {(tab === '5h' || tab === '1h') && <DetailedTab stats={stats} windowHours={tab === '5h' ? 5 : 1} />}
        </div>
      </div>
    </div>
  )
}
