import type { DailyUsage, HourlyUsage, DetailedRequest, ProjectSummary, ModelSummary24h } from '../../../../../../core/types/stats'
import type { Series } from './charts/types'
import { assignModelColors } from './charts/chart-utils'
import { shortModel } from './format'

const DAY_MS = 24 * 60 * 60 * 1000

/** Sum of all four token types for a daily row. */
export const dayTotal = (d: DailyUsage): number =>
  d.inputTokens + d.outputTokens + d.cacheCreationTokens + d.cacheReadTokens

// Parse as UTC ('…Z') so the toISOString() round-trip can't drift a day in non-UTC zones.
const isoMinus = (date: string, days: number) =>
  new Date(new Date(date + 'T00:00:00Z').getTime() - days * DAY_MS).toISOString().slice(0, 10)

/** Keep only the daily rows within the last `days` (anchored to the latest row's date). null = all. */
export function rangeFilter(daily: DailyUsage[], days: number | null): DailyUsage[] {
  if (!days || daily.length === 0) return daily
  const cutoff = isoMinus(daily[daily.length - 1].date, days - 1)
  return daily.filter((d) => d.date >= cutoff)
}

export type TokenMetric = 'total' | 'inout' | 'cost'

/** Cumulative series over the given daily rows. 'inout' → two series (Input/Output). */
export function cumulativeSeries(rows: DailyUsage[], metric: TokenMetric): Series[] {
  if (metric === 'inout') {
    let ai = 0, ao = 0
    const inp: Series['points'] = [], out: Series['points'] = []
    rows.forEach((d, i) => { ai += d.inputTokens; ao += d.outputTokens; inp.push({ x: i, y: ai }); out.push({ x: i, y: ao }) })
    return [{ label: 'Input', color: '#4fc3f7', points: inp }, { label: 'Output', color: '#81c784', points: out }]
  }
  if (metric === 'cost') {
    let acc = 0
    const pts: Series['points'] = []
    rows.forEach((d, i) => { acc += d.totalCost; pts.push({ x: i, y: acc }) })
    return [{ label: 'API cost est.', color: '#ffb74d', points: pts }]
  }
  let acc = 0
  const pts: Series['points'] = []
  rows.forEach((d, i) => { acc += dayTotal(d); pts.push({ x: i, y: acc }) })
  return [{ label: 'Total tokens', color: '#4fc3f7', points: pts }]
}

/** One cumulative series per model (stacked-area), sorted by overall total desc. */
export function modelStackedSeries(rows: DailyUsage[]): Series[] {
  const totals: Record<string, number> = {}
  for (const d of rows) for (const mb of d.modelBreakdowns) {
    const t = mb.inputTokens + mb.outputTokens + mb.cacheCreationTokens + mb.cacheReadTokens
    totals[mb.modelName] = (totals[mb.modelName] || 0) + t
  }
  const models = Object.keys(totals).sort((a, b) => totals[b] - totals[a])
  const colors = assignModelColors(models)
  const acc: Record<string, number> = {}
  const series: Series[] = models.map((m) => ({ label: shortModel(m), color: colors[m], points: [] }))
  models.forEach((m) => { acc[m] = 0 })
  rows.forEach((d, i) => {
    const perDay: Record<string, number> = {}
    for (const mb of d.modelBreakdowns) {
      perDay[mb.modelName] = (perDay[mb.modelName] || 0) + mb.inputTokens + mb.outputTokens + mb.cacheCreationTokens + mb.cacheReadTokens
    }
    models.forEach((m, k) => { acc[m] += perDay[m] || 0; series[k].points.push({ x: i, y: acc[m] }) })
  })
  return series
}

/**
 * Reduce each daily row to a single model's contribution (for the Overview model filter).
 * All-time data has no per-project dimension, but it does carry per-model breakdowns, so the
 * chart / heatmap / tables / cards can all be scoped to one model from this.
 */
export function filterDailyByModel(daily: DailyUsage[], model: string): DailyUsage[] {
  return daily.map((d) => {
    const mb = d.modelBreakdowns.find((b) => b.modelName === model)
    return {
      date: d.date,
      inputTokens: mb?.inputTokens ?? 0,
      outputTokens: mb?.outputTokens ?? 0,
      cacheCreationTokens: mb?.cacheCreationTokens ?? 0,
      cacheReadTokens: mb?.cacheReadTokens ?? 0,
      reasoningTokens: mb?.reasoningTokens ?? 0,
      totalCost: mb?.cost ?? 0,
      modelsUsed: mb ? [model] : [],
      modelBreakdowns: mb ? [mb] : [],
    }
  })
}

export interface ModelAgg {
  model: string
  input: number; output: number; cacheCreate: number; cacheRead: number
  reasoning: number; cached: number; total: number; cost: number
}

/** Per-model all-time aggregation for the Overview Model Breakdown table (sorted by total desc). */
export function aggregateModels(daily: DailyUsage[]): ModelAgg[] {
  const map: Record<string, ModelAgg> = {}
  for (const d of daily) for (const mb of d.modelBreakdowns) {
    const a = map[mb.modelName] || (map[mb.modelName] = { model: mb.modelName, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, reasoning: 0, cached: 0, total: 0, cost: 0 })
    a.input += mb.inputTokens; a.output += mb.outputTokens
    a.cacheCreate += mb.cacheCreationTokens; a.cacheRead += mb.cacheReadTokens
    a.reasoning += mb.reasoningTokens; a.cost += mb.cost
  }
  const rows = Object.values(map)
  rows.forEach((a) => { a.cached = a.cacheCreate + a.cacheRead; a.total = a.input + a.output + a.cacheCreate + a.cacheRead })
  return rows.sort((a, b) => b.total - a.total)
}

export interface Insights {
  peakDay: { date: string; tokens: number }
  activeDays: number
  streak: number
  apiTimeTodayMs: number
}

/** Overview insight cards: peak day, active days, current streak, API time today. */
export function insights(daily: DailyUsage[], hourly: HourlyUsage[]): Insights {
  let peakDay = { date: '', tokens: 0 }
  let activeDays = 0
  for (const d of daily) {
    const t = dayTotal(d)
    if (t > 0) activeDays++
    if (t > peakDay.tokens) peakDay = { date: d.date, tokens: t }
  }
  const active = new Set(daily.filter((d) => dayTotal(d) > 0).map((d) => d.date))
  let streak = 0
  if (active.size) {
    const sorted = [...active].sort()
    let cursor = sorted[sorted.length - 1]
    while (active.has(cursor)) { streak++; cursor = isoMinus(cursor, 1) }
  }
  const apiTimeTodayMs = hourly.reduce((s, h) => s + h.durationMs, 0)
  return { peakDay, activeDays, streak, apiTimeTodayMs }
}

// ── rolling-window request summaries (for the Detailed 1h view, derived from 5h) ──

function summarizeProjects(reqs: DetailedRequest[]): ProjectSummary[] {
  const map: Record<string, { p: ProjectSummary; models: Set<string>; sessions: Set<string> }> = {}
  for (const r of reqs) {
    const e = map[r.project] || (map[r.project] = {
      p: { project: r.project, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0, durationMs: 0, requestCount: 0, sessionCount: 0, modelsUsed: [] },
      models: new Set(), sessions: new Set(),
    })
    e.p.inputTokens += r.inputTokens; e.p.outputTokens += r.outputTokens
    e.p.cacheCreationTokens += r.cacheCreationTokens; e.p.cacheReadTokens += r.cacheReadTokens
    e.p.reasoningTokens += r.reasoningTokens
    e.p.cost += r.cost; e.p.durationMs += r.durationMs; e.p.requestCount++
    e.models.add(r.model); e.sessions.add(`${r.agent}:${r.sessionId}`)
  }
  return Object.values(map).map(({ p, models, sessions }) => ({
    ...p,
    totalTokens: p.inputTokens + p.outputTokens + p.cacheCreationTokens + p.cacheReadTokens,
    sessionCount: sessions.size, modelsUsed: [...models],
  })).sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens)
}

function summarizeModels(reqs: DetailedRequest[]): ModelSummary24h[] {
  const map: Record<string, { m: ModelSummary24h; sessions: Set<string> }> = {}
  for (const r of reqs) {
    const e = map[r.model] || (map[r.model] = {
      m: { model: r.model, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0, durationMs: 0, requestCount: 0, sessionCount: 0 },
      sessions: new Set(),
    })
    e.m.inputTokens += r.inputTokens; e.m.outputTokens += r.outputTokens
    e.m.cacheCreationTokens += r.cacheCreationTokens; e.m.cacheReadTokens += r.cacheReadTokens
    e.m.reasoningTokens += r.reasoningTokens
    e.m.cost += r.cost; e.m.durationMs += r.durationMs; e.m.requestCount++
    e.sessions.add(`${r.agent}:${r.sessionId}`)
  }
  return Object.values(map).map(({ m, sessions }) => ({
    ...m,
    totalTokens: m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens,
    sessionCount: sessions.size,
  })).sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens)
}

export interface WindowData {
  requests: DetailedRequest[]
  projects: ProjectSummary[]
  models: ModelSummary24h[]
}

/** Build per-project + per-model summaries (sorted by cost desc) for an arbitrary request set. */
export function summarizeRequests(requests: DetailedRequest[]): WindowData {
  return { requests, projects: summarizeProjects(requests), models: summarizeModels(requests) }
}

/** Derive the last-hour window from the five-hour detailed requests. */
export function deriveLastHour(requests: DetailedRequest[], windowEnd: string): WindowData {
  const cutoff = new Date(windowEnd).getTime() - 60 * 60 * 1000
  return summarizeRequests(requests.filter((r) => new Date(r.timestamp).getTime() >= cutoff))
}
