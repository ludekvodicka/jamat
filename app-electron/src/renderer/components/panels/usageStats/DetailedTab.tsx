import { useMemo, useState } from 'react'
import type { StatsView, DetailedRequest, ProjectSummary, ModelSummary24h } from '../../../../../../core/types/stats'
import { StatCard } from './StatCard'
import { DataTable, type Column } from './DataTable'
import { ModelChip } from './ModelChip'
import { DistributionBar, assignModelColors } from './charts'
import { coverageLabel, fmtAgent, fmtNum, fmtCoveredCost, fmtCoveredDuration, fmtInt, shortModel } from './format'
import { summarizeRequests, deriveLastHour } from './selectors'

const fmtTime = (iso: string) => {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

/** Full Detailed view (5h or 1h). 1h is derived client-side from the 5h request set. */
export function DetailedTab({ stats, windowHours }: { stats: StatsView; windowHours: 5 | 1 }) {
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [modelFilter, setModelFilter] = useState<string | null>(null)

  // Base time window: all 5h requests, or the last-hour slice derived from them.
  const baseRequests = useMemo(
    () => (windowHours === 1 ? deriveLastHour(stats.detailed.requests, stats.detailed.windowEnd).requests : stats.detailed.requests),
    [stats.detailed, windowHours],
  )
  const allProjects = useMemo(() => [...new Set(baseRequests.map((r) => r.project))].sort(), [baseRequests])
  const allModels = useMemo(() => [...new Set(baseRequests.map((r) => r.model))].sort(), [baseRequests])
  const modelColors = useMemo(() => assignModelColors(allModels), [allModels])

  const filtered = useMemo(
    () => baseRequests.filter((r) => (!projectFilter || r.project === projectFilter) && (!modelFilter || r.model === modelFilter)),
    [baseRequests, projectFilter, modelFilter],
  )
  const summary = useMemo(() => summarizeRequests(filtered), [filtered])

  const totals = filtered.reduce((a, r) => { a.tokens += r.totalTokens; a.cost += r.cost; a.dur += r.durationMs; return a }, { tokens: 0, cost: 0, dur: 0 })
  const maxCost = Math.max(1e-9, ...filtered.map((r) => r.cost))

  const modelWeight = (model: ModelSummary24h) => stats.costCoverage === 'full' ? model.cost : model.totalTokens
  const modelWeightSum = summary.models.reduce((sum, model) => sum + modelWeight(model), 0) || 1
  const modelWeightMax = Math.max(1e-9, ...summary.models.map(modelWeight))
  const showReasoning = stats.totals.reasoningTokens > 0
  const showAgent = new Set(baseRequests.map((request) => request.agent)).size > 1

  const modelCols: Column<ModelSummary24h>[] = [
    { key: 'model', label: 'Model', render: (m) => <ModelChip model={m.model} color={modelColors[m.model]} /> },
    { key: 'requestCount', label: 'Req', align: 'right', render: (m) => fmtInt(m.requestCount) },
    { key: 'totalTokens', label: 'Total', align: 'right', render: (m) => fmtNum(m.totalTokens) },
    { key: 'inputTokens', label: 'Input', align: 'right', render: (m) => fmtNum(m.inputTokens) },
    { key: 'outputTokens', label: 'Output', align: 'right', render: (m) => fmtNum(m.outputTokens) },
    { key: 'cacheCreationTokens', label: 'C.Create', align: 'right', render: (m) => fmtNum(m.cacheCreationTokens) },
    { key: 'cacheReadTokens', label: 'C.Read', align: 'right', render: (m) => fmtNum(m.cacheReadTokens) },
    ...(showReasoning ? [{ key: 'reasoningTokens', label: 'Reasoning', align: 'right' as const, render: (m: ModelSummary24h) => fmtNum(m.reasoningTokens) }] : []),
    { key: 'cost', label: coverageLabel(stats.costCoverage, 'API est.', 'Partial API est.', 'Cost unavailable'), align: 'right', render: (m) => fmtCoveredCost(m.cost, stats.costCoverage) },
    { key: 'share', label: 'Share', align: 'right', render: (m) => `${((modelWeight(m) / modelWeightSum) * 100).toFixed(1)}%` },
    { key: 'dist', label: '', width: '110px', render: (m) => <DistributionBar fraction={modelWeight(m) / modelWeightMax} color={modelColors[m.model]} /> },
  ]

  const projectCols: Column<ProjectSummary>[] = [
    { key: 'project', label: 'Project' },
    { key: 'requestCount', label: 'Req', align: 'right', render: (p) => fmtInt(p.requestCount) },
    { key: 'sessionCount', label: 'Sess', align: 'right', render: (p) => fmtInt(p.sessionCount) },
    { key: 'totalTokens', label: 'Total', align: 'right', render: (p) => fmtNum(p.totalTokens) },
    { key: 'inputTokens', label: 'Input', align: 'right', render: (p) => fmtNum(p.inputTokens) },
    { key: 'outputTokens', label: 'Output', align: 'right', render: (p) => fmtNum(p.outputTokens) },
    { key: 'cacheCreationTokens', label: 'C.Create', align: 'right', render: (p) => fmtNum(p.cacheCreationTokens) },
    { key: 'cacheReadTokens', label: 'C.Read', align: 'right', render: (p) => fmtNum(p.cacheReadTokens) },
    ...(showReasoning ? [{ key: 'reasoningTokens', label: 'Reasoning', align: 'right' as const, render: (p: ProjectSummary) => fmtNum(p.reasoningTokens) }] : []),
    { key: 'cost', label: coverageLabel(stats.costCoverage, 'API est.', 'Partial API est.', 'Cost unavailable'), align: 'right', render: (p) => fmtCoveredCost(p.cost, stats.costCoverage) },
    ...(stats.durationCoverage === 'none' ? [] : [{ key: 'durationMs', label: coverageLabel(stats.durationCoverage, 'API time', 'Claude time', 'API time'), align: 'right' as const, render: (p: ProjectSummary) => fmtCoveredDuration(p.durationMs, stats.durationCoverage) }]),
  ]

  const reqCols: Column<DetailedRequest>[] = [
    { key: 'timestamp', label: 'Time', render: (r) => fmtTime(r.timestamp) },
    ...(showAgent ? [{ key: 'agent', label: 'Agent', render: (r: DetailedRequest) => fmtAgent(r.agent) }] : []),
    { key: 'project', label: 'Project' },
    { key: 'model', label: 'Model', render: (r) => shortModel(r.model) },
    { key: 'totalTokens', label: 'Total', align: 'right', render: (r) => fmtNum(r.totalTokens) },
    { key: 'inputTokens', label: 'Input', align: 'right', render: (r) => fmtNum(r.inputTokens) },
    { key: 'outputTokens', label: 'Output', align: 'right', render: (r) => fmtNum(r.outputTokens) },
    { key: 'cacheCreationTokens', label: 'C.Create', align: 'right', render: (r) => fmtNum(r.cacheCreationTokens) },
    { key: 'cacheReadTokens', label: 'C.Read', align: 'right', render: (r) => fmtNum(r.cacheReadTokens) },
    ...(showReasoning ? [{ key: 'reasoningTokens', label: 'Reasoning', align: 'right' as const, render: (r: DetailedRequest) => fmtNum(r.reasoningTokens) }] : []),
    { key: 'cost', label: coverageLabel(stats.costCoverage, 'API est.', 'Partial API est.', 'Cost unavailable'), align: 'right', render: (r) => fmtCoveredCost(r.cost, stats.costCoverage) },
    ...(stats.durationCoverage === 'none' ? [] : [{ key: 'durationMs', label: coverageLabel(stats.durationCoverage, 'Duration', 'Claude time', 'Duration'), align: 'right' as const, render: (r: DetailedRequest) => fmtCoveredDuration(r.durationMs, stats.durationCoverage) }]),
    { key: 'sessionId', label: 'Session', render: (r) => r.sessionId.slice(0, 8) },
  ]

  const costClass = (r: DetailedRequest) =>
    r.cost > 0.5 * maxCost ? 'usage-row-cost-hi' : r.cost > 0.2 * maxCost ? 'usage-row-cost-mid' : r.cost > 0 ? 'usage-row-cost-lo' : undefined

  return (
    <div className="usage-stats-detailed">
      <div className="usage-filter-row">
        <span className="usage-window-range">Last {windowHours === 1 ? 'hour' : '5 hours'} · ends {fmtTime(stats.detailed.windowEnd)}</span>
        <label>Project
          <select className="usage-select" value={projectFilter ?? ''} onChange={(e) => { setProjectFilter(e.target.value || null); setModelFilter(null) }}>
            <option value="">All projects</option>
            {allProjects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label>Model
          <select className="usage-select" value={modelFilter ?? ''} onChange={(e) => { setModelFilter(e.target.value || null); setProjectFilter(null) }}>
            <option value="">All models</option>
            {allModels.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      </div>

      <div className="usage-stat-row">
        <StatCard label={`Requests (${windowHours}h)`} value={fmtInt(filtered.length)} sub={`${summary.projects.length} projects`} />
        <StatCard label={`Tokens (${windowHours}h)`} value={fmtNum(totals.tokens)} accent />
        <StatCard label={coverageLabel(stats.costCoverage, `Est. API cost (${windowHours}h)`, `Partial API est. (${windowHours}h)`, 'Cost unavailable')} value={fmtCoveredCost(totals.cost, stats.costCoverage)} />
        {stats.durationCoverage !== 'none' && <StatCard label={coverageLabel(stats.durationCoverage, `API time (${windowHours}h)`, `Claude API time (${windowHours}h)`, 'API time unavailable')} value={fmtCoveredDuration(totals.dur, stats.durationCoverage)} />}
      </div>

      {!modelFilter && (
        <section className="usage-card">
          <h3 className="usage-section-title">By model{projectFilter ? ` · ${projectFilter}` : ''}</h3>
          <DataTable columns={modelCols} rows={summary.models} rowKey={(m) => m.model} empty="No model activity in this window." />
        </section>
      )}

      {!projectFilter && (
        <section className="usage-card">
          <h3 className="usage-section-title">By project{modelFilter ? ` · ${shortModel(modelFilter)}` : ''}</h3>
          <DataTable columns={projectCols} rows={summary.projects} rowKey={(p) => p.project} empty="No project activity in this window." />
        </section>
      )}

      <section className="usage-card">
        <h3 className="usage-section-title">Request timeline</h3>
        <DataTable columns={reqCols} rows={filtered} rowKey={(r, i) => `${r.timestamp}-${i}`} rowClassName={costClass} empty="No requests in this window." />
      </section>
    </div>
  )
}
