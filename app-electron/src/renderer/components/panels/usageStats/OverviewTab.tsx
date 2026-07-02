import { useMemo, useState } from 'react'
import type { Stats, DailyUsage } from '../../../../../../core/types/stats'
import { StatCard } from './StatCard'
import { DataTable, type Column } from './DataTable'
import { ModelChip } from './ModelChip'
import { LineChart, StackedAreaChart, Heatmap, DistributionBar, assignModelColors } from './charts'
import { fmtNum, fmtCost, fmtInt, fmtDuration, fmtDayLabel } from './format'
import { dayTotal, rangeFilter, cumulativeSeries, modelStackedSeries, aggregateModels, insights, filterDailyByModel, type ModelAgg } from './selectors'

type ChartTab = 'tokens' | 'spend' | 'models'
type Range = { label: string; days: number | null }
const RANGES: Range[] = [
  { label: 'All', days: null }, { label: '1Y', days: 365 }, { label: '90D', days: 90 }, { label: '30D', days: 30 },
]

/** Full Overview: model filter · summary cards · over-time chart · heatmap · insights · model + daily tables. */
export function OverviewTab({ stats }: { stats: Stats }) {
  const [chartTab, setChartTab] = useState<ChartTab>('tokens')
  const [rangeIdx, setRangeIdx] = useState(0)
  const [tokenMode, setTokenMode] = useState<'total' | 'inout'>('total')
  const [modelFilter, setModelFilter] = useState<string | null>(null)
  const range = RANGES[rangeIdx].days

  // Model dropdown + stable per-model colors (assigned from the all-time set so a filtered model keeps its color).
  const allModels = useMemo(() => aggregateModels(stats.daily), [stats.daily])
  const modelColors = useMemo(() => assignModelColors(allModels.map((m) => m.model)), [allModels])

  // The Overview is all-time. There is no per-project all-time series (only the 24h/5h windows track
  // per-project), so the filter is by MODEL — each daily row reduced to that model's contribution.
  const effectiveDaily = useMemo(
    () => (modelFilter ? filterDailyByModel(stats.daily, modelFilter) : stats.daily),
    [stats.daily, modelFilter],
  )

  const todayStr = new Date().toISOString().slice(0, 10)
  const todayRow = effectiveDaily.find((d) => d.date === todayStr) ?? effectiveDaily[effectiveDaily.length - 1]
  const todayTokens = todayRow ? dayTotal(todayRow) : 0
  const allTimeTokens = useMemo(() => effectiveDaily.reduce((s, d) => s + dayTotal(d), 0), [effectiveDaily])
  const allTimeCost = useMemo(() => effectiveDaily.reduce((s, d) => s + d.totalCost, 0), [effectiveDaily])
  const last30 = useMemo(() => rangeFilter(effectiveDaily, 30).reduce((s, d) => s + dayTotal(d), 0), [effectiveDaily])
  const sessionCount = modelFilter ? stats.sessions.filter((s) => s.modelsUsed?.includes(modelFilter)).length : stats.sessions.length

  const filtered = useMemo(() => rangeFilter(effectiveDaily, range), [effectiveDaily, range])
  const xLabels = useMemo(() => filtered.map((d) => fmtDayLabel(d.date)), [filtered])

  const tokenSeries = useMemo(() => cumulativeSeries(filtered, tokenMode === 'inout' ? 'inout' : 'total'), [filtered, tokenMode])
  const spendSeries = useMemo(() => cumulativeSeries(filtered, 'cost'), [filtered])
  const modelSeries = useMemo(() => modelStackedSeries(filtered), [filtered])

  const models = useMemo(() => aggregateModels(effectiveDaily), [effectiveDaily])
  const ins = useMemo(() => insights(effectiveDaily, stats.hourly), [effectiveDaily, stats.hourly])

  const modelTotalSum = models.reduce((s, m) => s + m.total, 0) || 1
  const modelTotalMax = Math.max(1, ...models.map((m) => m.total))

  const chart = chartTab === 'spend'
    ? <LineChart series={spendSeries} yFormat={fmtCost} xLabels={xLabels} />
    : chartTab === 'models'
      ? <StackedAreaChart series={modelSeries} yFormat={fmtNum} xLabels={xLabels} />
      : <LineChart series={tokenSeries} yFormat={fmtNum} xLabels={xLabels} />

  const legendSeries = chartTab === 'models' ? modelSeries : chartTab === 'tokens' && tokenMode === 'inout' ? tokenSeries : []

  const modelCols: Column<ModelAgg>[] = [
    { key: 'model', label: 'Model', render: (m) => <ModelChip model={m.model} color={modelColors[m.model]} /> },
    { key: 'input', label: 'Input', align: 'right', render: (m) => fmtNum(m.input) },
    { key: 'output', label: 'Output', align: 'right', render: (m) => fmtNum(m.output) },
    { key: 'cached', label: 'Cached', align: 'right', render: (m) => fmtNum(m.cached) },
    { key: 'total', label: 'Total', align: 'right', render: (m) => fmtNum(m.total) },
    { key: 'cost', label: 'Cost', align: 'right', render: (m) => fmtCost(m.cost) },
    { key: 'share', label: 'Share', align: 'right', render: (m) => `${((m.total / modelTotalSum) * 100).toFixed(1)}%` },
    { key: 'dist', label: '', width: '120px', render: (m) => <DistributionBar fraction={m.total / modelTotalMax} color={modelColors[m.model]} /> },
  ]

  const dailyRows = useMemo(() => [...effectiveDaily].reverse(), [effectiveDaily])
  const dailyCols: Column<DailyUsage>[] = [
    { key: 'date', label: 'Date', render: (d) => fmtDayLabel(d.date) },
    { key: 'total', label: 'Total', align: 'right', render: (d) => fmtNum(dayTotal(d)) },
    { key: 'inputTokens', label: 'Input', align: 'right', render: (d) => fmtNum(d.inputTokens) },
    { key: 'outputTokens', label: 'Output', align: 'right', render: (d) => fmtNum(d.outputTokens) },
    { key: 'cacheCreationTokens', label: 'Cache Create', align: 'right', render: (d) => fmtNum(d.cacheCreationTokens) },
    { key: 'cacheReadTokens', label: 'Cache Read', align: 'right', render: (d) => fmtNum(d.cacheReadTokens) },
    { key: 'totalCost', label: 'Cost', align: 'right', render: (d) => fmtCost(d.totalCost) },
    { key: 'models', label: 'Models', render: (d) => <span className="usage-model-chips">{d.modelsUsed.map((m) => <ModelChip key={m} model={m} color={modelColors[m]} />)}</span> },
  ]

  return (
    <div className="usage-stats-overview">
      <div className="usage-filter-row">
        <span className="usage-window-range">All time</span>
        <label>Model
          <select className="usage-select" value={modelFilter ?? ''} onChange={(e) => setModelFilter(e.target.value || null)}>
            <option value="">All models</option>
            {allModels.map((m) => <option key={m.model} value={m.model}>{m.model}</option>)}
          </select>
        </label>
      </div>

      <div className="usage-stat-row">
        <StatCard label="All-time tokens" value={fmtNum(allTimeTokens)} accent />
        <StatCard label="Today" value={fmtNum(todayTokens)} />
        <StatCard label="Last 30 days" value={fmtNum(last30)} />
        <StatCard label="Sessions" value={fmtInt(sessionCount)} />
        <StatCard label="Total spend" value={fmtCost(allTimeCost)} />
      </div>

      <section className="usage-card">
        <div className="usage-chart-pills">
          {(['tokens', 'spend', 'models'] as ChartTab[]).map((t) => (
            <button key={t} className={`usage-pill${chartTab === t ? ' active' : ''}`} onClick={() => setChartTab(t)}>
              {t === 'tokens' ? 'Tokens' : t === 'spend' ? 'Spend' : 'Models'}
            </button>
          ))}
          <div className="usage-pill-group">
            {RANGES.map((r, i) => (
              <button key={r.label} className={`usage-pill${rangeIdx === i ? ' active' : ''}`} onClick={() => setRangeIdx(i)}>{r.label}</button>
            ))}
          </div>
        </div>
        {chartTab === 'tokens' && (
          <div className="usage-chart-pills">
            <button className={`usage-pill${tokenMode === 'total' ? ' active' : ''}`} onClick={() => setTokenMode('total')}>All</button>
            <button className={`usage-pill${tokenMode === 'inout' ? ' active' : ''}`} onClick={() => setTokenMode('inout')}>In/Out</button>
          </div>
        )}
        {chart}
        {legendSeries.length > 0 && (
          <div className="usage-chart-legend">
            {legendSeries.map((s) => (
              <span key={s.label} className="usage-chart-legend-item"><span className="usage-chart-dot" style={{ background: s.color }} />{s.label}</span>
            ))}
          </div>
        )}
      </section>

      <section className="usage-card">
        <h3 className="usage-section-title">Daily activity · last 26 weeks</h3>
        <Heatmap days={effectiveDaily.map((d) => ({ date: d.date, value: dayTotal(d) }))} weeks={26} valueFormat={fmtNum} />
      </section>

      <div className="usage-insight-grid">
        <div className="usage-insight-card"><div className="usage-insight-value">{ins.peakDay.date ? fmtNum(ins.peakDay.tokens) : '—'}</div><div className="usage-insight-label">Peak day{ins.peakDay.date ? ` · ${fmtDayLabel(ins.peakDay.date)}` : ''}</div></div>
        <div className="usage-insight-card"><div className="usage-insight-value">{fmtInt(ins.activeDays)}</div><div className="usage-insight-label">Active days</div></div>
        <div className="usage-insight-card"><div className="usage-insight-value">{ins.streak}d</div><div className="usage-insight-label">Current streak</div></div>
        <div className="usage-insight-card"><div className="usage-insight-value">{fmtDuration(ins.apiTimeTodayMs)}</div><div className="usage-insight-label">API time today</div></div>
      </div>

      <section className="usage-card">
        <h3 className="usage-section-title">Model breakdown</h3>
        <DataTable columns={modelCols} rows={models} rowKey={(m) => m.model} empty="No model usage yet." />
      </section>

      <section className="usage-card">
        <h3 className="usage-section-title">Daily consumption</h3>
        <DataTable columns={dailyCols} rows={dailyRows} rowKey={(d) => d.date} empty="No daily data yet." />
      </section>
    </div>
  )
}
