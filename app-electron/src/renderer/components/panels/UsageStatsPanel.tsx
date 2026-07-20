import './usageStats/usageStats.css'
import { IDockviewPanelProps } from 'dockview'
import { useEffect, useRef, useState } from 'react'
import { useIpcQuery } from '../../hooks/useIpcQuery'
import { formatStatsGenerationProgress, useStatsGenerationProgress } from '../../hooks/useStatsGenerationProgress'
import type { StatsAgentFilter, StatsDataResult, Stats, StatsView } from '../../../../../core/types/stats'
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
const AGENT_FILTERS: { key: StatsAgentFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'claude', label: 'Claude' },
  { key: 'codex', label: 'Codex' },
]

function statsViewForFilter(stats: Stats, filter: StatsAgentFilter): StatsView {
  if (filter === 'all') return stats
  else if (filter === 'claude') return stats.byAgent.claude
  else if (filter === 'codex') return stats.byAgent.codex
  else
    throw new Error(`Unknown stats agent filter: ${JSON.stringify(filter)}`)
}

export function UsageStatsPanel({ api }: IDockviewPanelProps) {
  const forceRef = useRef(false)
  const [tab, setTab] = useState<TabKey>('overview')
  const [agentFilter, setAgentFilter] = useState<StatsAgentFilter>('all')
  const generation = useStatsGenerationProgress()
  const q = useIpcQuery<StatsDataResult>(
    () => {
      const force = forceRef.current
      forceRef.current = false
      const requestId = generation.begin()
      return window.electronAPI.getStatsData(force, requestId).finally(generation.finish)
    },
    [],
  )
  useEffect(() => { api.setTitle('📊 Usage Stats') }, [api])

  const refresh = () => { forceRef.current = true; q.refetch() }
  const result = q.data
  const stats: Stats | null = result?.ok ? result.data : null

  if (q.loading && !stats) {
    return (
      <div className="usage-stats-empty">
        <div className="usage-spinner" />
        <div className="usage-stats-loading-title">Loading usage statistics…</div>
        <div>{formatStatsGenerationProgress(generation.progress)}</div>
        <div className="usage-stats-elapsed">Elapsed: {generation.elapsedSeconds}s</div>
      </div>
    )
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
  const activeStats = statsViewForFilter(stats, agentFilter)

  return (
    <div className="usage-stats-panel">
      <div className="usage-stats-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`usage-stats-tab${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
        <div className="usage-agent-toggle" role="group" aria-label="Usage source">
          {AGENT_FILTERS.map((agent) => (
            <button key={agent.key} className={`usage-agent-option${agentFilter === agent.key ? ' active' : ''}`} onClick={() => setAgentFilter(agent.key)}>
              {agent.label}
            </button>
          ))}
        </div>
        <div className="usage-stats-tabs-spacer" />
        <span className="usage-stats-generatedat">{new Date(stats.generatedAt).toLocaleString()}</span>
        <button className="usage-stats-refresh" onClick={refresh} disabled={q.loading}>
          {q.loading ? <span className="usage-spinner-sm" /> : '⟳'} Refresh
        </button>
      </div>
      {q.loading && (
        <div className="usage-stats-progress">
          <span>{formatStatsGenerationProgress(generation.progress)}</span>
          <span>Elapsed: {generation.elapsedSeconds}s</span>
        </div>
      )}
      <div className="usage-stats-body">
        <div className="usage-stats-content">
          {tab === 'overview' && <OverviewTab key={agentFilter} stats={activeStats} />}
          {tab === '24h' && <Last24hTab key={agentFilter} stats={activeStats} />}
          {(tab === '5h' || tab === '1h') && <DetailedTab key={agentFilter} stats={activeStats} windowHours={tab === '5h' ? 5 : 1} />}
        </div>
      </div>
    </div>
  )
}
