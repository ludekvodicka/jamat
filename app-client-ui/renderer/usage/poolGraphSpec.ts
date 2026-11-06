import type { TopLevelSpec } from 'vega-lite'
import type { PoolSeries } from '../../../lib-orchestrator/rateMonitor/usageApi.types'
import type { ChartReadout } from './usageChart'
import { UsageModel } from './usageModel'

export interface UsageChartTheme { text: string; grid: string; accent: string }
type PoolPoint = PoolSeries['recorded'][number]

/** `range` overrides the series' display bounds: the 7 and 30 day views draw less than they read. */
export function poolGraphSpec(series: PoolSeries, theme: UsageChartTheme, range = series.displayRange): TopLevelSpec | null {
  const inRange = (point: { at: number }): boolean => !range || point.at >= range.from && point.at <= range.to
  const recorded = series.recorded.filter(inRange), projected = series.projected.filter((point, index, points) => inRange(point)
    || !!range && crossesInto(point, points[index - 1], points[index + 1], range))
  if (recorded.length === 0 && projected.length === 0) return null
  // One tick per day labelled by its date: the hours of a week-long range are noise.
  const encoding = { x: { field: 'at', type: 'temporal' as const, title: null,
    axis: { format: '%a %d %b', tickCount: { interval: 'day' as const, step: 1 }, labelOverlap: true },
    ...(range ? { scale: { domain: [localDateTime(range.from), localDateTime(range.to)] } } : {}) },
    y: { field: 'remaining', type: 'quantitative' as const, title: null, scale: { domain: [0, Math.max(1, series.totalAccounts) * 100] }, axis: { tickCount: 5, labelExpr: "datum.label + '%'" } } }
  return { width: 'container', height: 180, background: 'transparent',
    config: { axis: { labelColor: theme.text, titleColor: theme.text, gridColor: theme.grid, domainColor: theme.grid, tickColor: theme.grid }, view: { stroke: null } },
    layer: [
      { data: { values: recorded }, mark: { type: 'line', color: theme.accent, clip: true }, encoding },
      ...(!range || projected.length > 0 ? [{ data: { values: projected },
        mark: { type: 'line' as const, strokeDash: [6, 4], color: theme.accent, clip: true }, encoding }] : []),
      ...(inRange({ at: series.now }) ? [{ data: { values: [{ at: series.now }] }, mark: { type: 'rule' as const, color: theme.text, clip: true },
        encoding: { x: encoding.x } }] : []),
    ] }
}

/** The pool at one moment, as the lines draw it: recorded, projected, or both where they meet. */
export function poolReadout(series: PoolSeries, at: number): ChartReadout {
  const rows = ([['Recorded', valueAt(series.recorded, at)], ['Projected', valueAt(series.projected, at)]] as const)
    .flatMap(([label, value]) => value === null ? [] : [{ label, value: `${value.toFixed(1)}%` }])
  return { title: new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    detail: UsageModel.relative(at, series.now), rows }
}

/** Linear between the two points around `at`; null outside the line. */
function valueAt(points: readonly PoolPoint[], at: number): number | null {
  const last = points.at(-1)
  if (!last || at < points[0].at || at > last.at) return null
  const after = points.findIndex(point => point.at >= at)
  const right = points[after]
  if (after === 0 || right.at === at) return right.remaining
  const left = points[after - 1]
  return left.remaining + (right.remaining - left.remaining) * (at - left.at) / (right.at - left.at)
}

/**
 * The neighbour just outside the bounds of a segment that enters them. Drawn clipped, the line then
 * reaches the edge instead of stopping at its last turn inside.
 */
function crossesInto(point: PoolPoint, before: PoolPoint | undefined, after: PoolPoint | undefined, range: { from: number; to: number }): boolean {
  return point.at > range.to && before !== undefined && before.at <= range.to
    || point.at < range.from && after !== undefined && after.at >= range.from
}

/**
 * A domain bound as a vega-lite DateTime, never a number: vega-lite emits a number as `datetime(ms)`,
 * which vega-interpreter (required by the workspace CSP) reads as a year and turns into Invalid Date.
 */
function localDateTime(at: number): { year: number; month: number; date: number; hours: number; minutes: number; seconds: number; milliseconds: number } {
  const date = new Date(at)
  return { year: date.getFullYear(), month: date.getMonth() + 1, date: date.getDate(), hours: date.getHours(),
    minutes: date.getMinutes(), seconds: date.getSeconds(), milliseconds: date.getMilliseconds() }
}
