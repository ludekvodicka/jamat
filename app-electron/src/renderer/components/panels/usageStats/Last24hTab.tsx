import { useMemo, useState } from 'react'
import type { StatsView, Hourly24hEntry } from '../../../../../../core/types/stats'
import { StatCard } from './StatCard'
import { DataTable, type Column } from './DataTable'
import { ModelChip } from './ModelChip'
import { BarChart, DistributionBar, assignModelColors } from './charts'
import { coverageLabel, fmtNum, fmtCost, fmtCoveredCost, fmtCoveredDuration, fmtInt } from './format'

interface PRow { name: string; requestCount: number; sessionCount: number; totalTokens: number; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; reasoningTokens: number; cost: number; durationMs: number }
interface MRow { model: string; requestCount: number; totalTokens: number; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; reasoningTokens: number; cost: number; durationMs: number }

const bucketTokens = (b: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }) =>
  b.inputTokens + b.outputTokens + b.cacheCreationTokens + b.cacheReadTokens

/** Full Last-24h view: project/model filters · stat cards · hourly bar chart · per-project + per-model + hourly tables. */
export function Last24hTab({ stats }: { stats: StatsView }) {
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [modelFilter, setModelFilter] = useState<string | null>(null)
  const [hourMode, setHourMode] = useState<'tokens' | 'cost'>('tokens')

  const modelColors = useMemo(() => assignModelColors(stats.models24h.map((m) => m.model)), [stats.models24h])

  // Hourly bars follow the active filter (project bucket / model bucket / overall).
  const hourlyBars = useMemo(() => stats.hourly24h.map((h: Hourly24hEntry) => {
    const b = projectFilter ? h.byProject[projectFilter] : modelFilter ? h.byModel[modelFilter] : h
    const val = b ? (hourMode === 'tokens' ? bucketTokens(b) : b.cost) : 0
    return { label: h.label.slice(11, 13), value: val, dim: val === 0 }
  }), [stats.hourly24h, projectFilter, modelFilter, hourMode])

  // Filtered stat-card totals.
  const totals = useMemo(() => {
    if (projectFilter) {
      const p = stats.projects24h.find((x) => x.project === projectFilter)
      return { requests: p?.requestCount ?? 0, tokens: p?.totalTokens ?? 0, cost: p?.cost ?? 0, dur: p?.durationMs ?? 0 }
    }
    if (modelFilter) {
      const m = stats.models24h.find((x) => x.model === modelFilter)
      return { requests: m?.requestCount ?? 0, tokens: m?.totalTokens ?? 0, cost: m?.cost ?? 0, dur: m?.durationMs ?? 0 }
    }
    return stats.projects24h.reduce((a, p) => ({ requests: a.requests + p.requestCount, tokens: a.tokens + p.totalTokens, cost: a.cost + p.cost, dur: a.dur + p.durationMs }), { requests: 0, tokens: 0, cost: 0, dur: 0 })
  }, [stats, projectFilter, modelFilter])

  const activeHours = hourlyBars.filter((b) => b.value > 0).length

  const projectRows: PRow[] = useMemo(() => {
    if (projectFilter) return []
    if (modelFilter) {
      const rows: PRow[] = []
      for (const [proj, models] of Object.entries(stats.projectModels24h)) {
        const c = models[modelFilter]
        if (c) rows.push({ name: proj, requestCount: c.requestCount, sessionCount: c.sessionCount, totalTokens: c.totalTokens, inputTokens: c.inputTokens, outputTokens: c.outputTokens, cacheCreationTokens: c.cacheCreationTokens, cacheReadTokens: c.cacheReadTokens, reasoningTokens: c.reasoningTokens, cost: c.cost, durationMs: c.durationMs })
      }
      return rows.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens)
    }
    return stats.projects24h.map((p) => ({ name: p.project, requestCount: p.requestCount, sessionCount: p.sessionCount, totalTokens: p.totalTokens, inputTokens: p.inputTokens, outputTokens: p.outputTokens, cacheCreationTokens: p.cacheCreationTokens, cacheReadTokens: p.cacheReadTokens, reasoningTokens: p.reasoningTokens, cost: p.cost, durationMs: p.durationMs }))
  }, [stats, projectFilter, modelFilter])

  const modelRows: MRow[] = useMemo(() => {
    if (modelFilter) return []
    if (projectFilter) {
      const cells = stats.projectModels24h[projectFilter] ?? {}
      return Object.entries(cells).map(([model, c]) => ({ model, requestCount: c.requestCount, totalTokens: c.totalTokens, inputTokens: c.inputTokens, outputTokens: c.outputTokens, cacheCreationTokens: c.cacheCreationTokens, cacheReadTokens: c.cacheReadTokens, reasoningTokens: c.reasoningTokens, cost: c.cost, durationMs: c.durationMs })).sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens)
    }
    return stats.models24h.map((m) => ({ model: m.model, requestCount: m.requestCount, totalTokens: m.totalTokens, inputTokens: m.inputTokens, outputTokens: m.outputTokens, cacheCreationTokens: m.cacheCreationTokens, cacheReadTokens: m.cacheReadTokens, reasoningTokens: m.reasoningTokens, cost: m.cost, durationMs: m.durationMs }))
  }, [stats, projectFilter, modelFilter])

  const modelWeight = (model: MRow) => stats.costCoverage === 'full' ? model.cost : model.totalTokens
  const modelWeightSum = modelRows.reduce((sum, model) => sum + modelWeight(model), 0) || 1
  const modelWeightMax = Math.max(1e-9, ...modelRows.map(modelWeight))
  const showReasoning = stats.totals.reasoningTokens > 0

  const projectCols: Column<PRow>[] = [
    { key: 'name', label: 'Project' },
    { key: 'requestCount', label: 'Req', align: 'right', render: (r) => fmtInt(r.requestCount) },
    { key: 'sessionCount', label: 'Sess', align: 'right', render: (r) => fmtInt(r.sessionCount) },
    { key: 'totalTokens', label: 'Total', align: 'right', render: (r) => fmtNum(r.totalTokens) },
    { key: 'inputTokens', label: 'Input', align: 'right', render: (r) => fmtNum(r.inputTokens) },
    { key: 'outputTokens', label: 'Output', align: 'right', render: (r) => fmtNum(r.outputTokens) },
    { key: 'cacheCreationTokens', label: 'C.Create', align: 'right', render: (r) => fmtNum(r.cacheCreationTokens) },
    { key: 'cacheReadTokens', label: 'C.Read', align: 'right', render: (r) => fmtNum(r.cacheReadTokens) },
    ...(showReasoning ? [{ key: 'reasoningTokens', label: 'Reasoning', align: 'right' as const, render: (r: PRow) => fmtNum(r.reasoningTokens) }] : []),
    { key: 'cost', label: coverageLabel(stats.costCoverage, 'API est.', 'Partial API est.', 'Cost unavailable'), align: 'right', render: (r) => fmtCoveredCost(r.cost, stats.costCoverage) },
    ...(stats.durationCoverage === 'none' ? [] : [{ key: 'durationMs', label: coverageLabel(stats.durationCoverage, 'API time', 'Claude time', 'API time'), align: 'right' as const, render: (r: PRow) => fmtCoveredDuration(r.durationMs, stats.durationCoverage) }]),
  ]

  const modelCols: Column<MRow>[] = [
    { key: 'model', label: 'Model', render: (r) => <ModelChip model={r.model} color={modelColors[r.model]} /> },
    { key: 'requestCount', label: 'Req', align: 'right', render: (r) => fmtInt(r.requestCount) },
    { key: 'totalTokens', label: 'Total', align: 'right', render: (r) => fmtNum(r.totalTokens) },
    { key: 'inputTokens', label: 'Input', align: 'right', render: (r) => fmtNum(r.inputTokens) },
    { key: 'outputTokens', label: 'Output', align: 'right', render: (r) => fmtNum(r.outputTokens) },
    { key: 'cacheCreationTokens', label: 'C.Create', align: 'right', render: (r) => fmtNum(r.cacheCreationTokens) },
    { key: 'cacheReadTokens', label: 'C.Read', align: 'right', render: (r) => fmtNum(r.cacheReadTokens) },
    ...(showReasoning ? [{ key: 'reasoningTokens', label: 'Reasoning', align: 'right' as const, render: (r: MRow) => fmtNum(r.reasoningTokens) }] : []),
    { key: 'cost', label: coverageLabel(stats.costCoverage, 'API est.', 'Partial API est.', 'Cost unavailable'), align: 'right', render: (r) => fmtCoveredCost(r.cost, stats.costCoverage) },
    { key: 'share', label: 'Share', align: 'right', render: (r) => `${((modelWeight(r) / modelWeightSum) * 100).toFixed(1)}%` },
    { key: 'dist', label: '', width: '110px', render: (r) => <DistributionBar fraction={modelWeight(r) / modelWeightMax} color={modelColors[r.model]} /> },
  ]

  const hourlyCols: Column<Hourly24hEntry>[] = [
    { key: 'label', label: 'Hour', render: (h) => h.label.slice(11) },
    { key: 'total', label: 'Total', align: 'right', render: (h) => fmtNum(bucketTokens(h)) },
    { key: 'inputTokens', label: 'Input', align: 'right', render: (h) => fmtNum(h.inputTokens) },
    { key: 'outputTokens', label: 'Output', align: 'right', render: (h) => fmtNum(h.outputTokens) },
    { key: 'cacheCreationTokens', label: 'C.Create', align: 'right', render: (h) => fmtNum(h.cacheCreationTokens) },
    { key: 'cacheReadTokens', label: 'C.Read', align: 'right', render: (h) => fmtNum(h.cacheReadTokens) },
    ...(showReasoning ? [{ key: 'reasoningTokens', label: 'Reasoning', align: 'right' as const, render: (h: Hourly24hEntry) => fmtNum(h.reasoningTokens) }] : []),
    { key: 'cost', label: coverageLabel(stats.costCoverage, 'API est.', 'Partial API est.', 'Cost unavailable'), align: 'right', render: (h) => fmtCoveredCost(h.cost, stats.costCoverage) },
    ...(stats.durationCoverage === 'none' ? [] : [{ key: 'durationMs', label: coverageLabel(stats.durationCoverage, 'API time', 'Claude time', 'API time'), align: 'right' as const, render: (h: Hourly24hEntry) => fmtCoveredDuration(h.durationMs, stats.durationCoverage) }]),
    { key: 'projects', label: 'Proj', align: 'right', render: (h) => fmtInt(h.projects.length) },
    { key: 'models', label: 'Models', align: 'right', render: (h) => fmtInt(h.modelsUsed.length) },
  ]

  return (
    <div className="usage-stats-24h">
      <div className="usage-filter-row">
        <span className="usage-window-range">Last 24 hours</span>
        <label>Project
          <select className="usage-select" value={projectFilter ?? ''} onChange={(e) => { setProjectFilter(e.target.value || null); setModelFilter(null) }}>
            <option value="">All projects</option>
            {stats.projects24h.map((p) => <option key={p.project} value={p.project}>{p.project}</option>)}
          </select>
        </label>
        <label>Model
          <select className="usage-select" value={modelFilter ?? ''} onChange={(e) => { setModelFilter(e.target.value || null); setProjectFilter(null) }}>
            <option value="">All models</option>
            {stats.models24h.map((m) => <option key={m.model} value={m.model}>{m.model}</option>)}
          </select>
        </label>
      </div>

      <div className="usage-stat-row">
        <StatCard label="Requests (24h)" value={fmtInt(totals.requests)} sub={`${activeHours} active hours`} />
        <StatCard label="Tokens (24h)" value={fmtNum(totals.tokens)} accent />
        <StatCard label={coverageLabel(stats.costCoverage, 'Est. API cost (24h)', 'Partial API est. (24h)', 'Cost unavailable')} value={fmtCoveredCost(totals.cost, stats.costCoverage)} />
        {stats.durationCoverage !== 'none' && <StatCard label={coverageLabel(stats.durationCoverage, 'API time (24h)', 'Claude API time (24h)', 'API time unavailable')} value={fmtCoveredDuration(totals.dur, stats.durationCoverage)} />}
      </div>

      <section className="usage-card">
        <div className="usage-chart-pills">
          <button className={`usage-pill${hourMode === 'tokens' ? ' active' : ''}`} onClick={() => setHourMode('tokens')}>Tokens</button>
          <button className={`usage-pill${hourMode === 'cost' ? ' active' : ''}`} onClick={() => setHourMode('cost')} disabled={stats.costCoverage === 'none'}>{coverageLabel(stats.costCoverage, 'API cost est.', 'Partial API est.', 'Cost')}</button>
        </div>
        <BarChart bars={hourlyBars} yFormat={hourMode === 'cost' ? fmtCost : fmtNum} />
      </section>

      {!projectFilter && (
        <section className="usage-card">
          <h3 className="usage-section-title">By project{modelFilter ? ` · ${modelFilter}` : ''}</h3>
          <DataTable columns={projectCols} rows={projectRows} rowKey={(r) => r.name} empty="No project activity in this window." />
        </section>
      )}

      {!modelFilter && (
        <section className="usage-card">
          <h3 className="usage-section-title">By model{projectFilter ? ` · ${projectFilter}` : ''}</h3>
          <DataTable columns={modelCols} rows={modelRows} rowKey={(r) => r.model} empty="No model activity in this window." />
        </section>
      )}

      <section className="usage-card">
        <h3 className="usage-section-title">Hourly consumption</h3>
        <DataTable columns={hourlyCols} rows={stats.hourly24h} rowKey={(h) => h.label} empty="No hourly data." />
      </section>
    </div>
  )
}
