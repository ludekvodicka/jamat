import type { TopLevelSpec } from 'vega-lite'
import type { PoolSeries } from '../../../lib-orchestrator/rateMonitor/usageApi.types'

export interface UsageChartTheme { text: string; grid: string; accent: string }

export function poolGraphSpec(series: PoolSeries, theme: UsageChartTheme): TopLevelSpec | null {
  const range = series.displayRange
  const inRange = (point: { at: number }): boolean => !range || point.at >= range.from && point.at <= range.to
  const recorded = series.recorded.filter(inRange), projected = series.projected.filter(inRange)
  if (recorded.length === 0 && projected.length === 0) return null
  // One tick per day labelled by its date: the hours of a week-long range are noise.
  const encoding = { x: { field: 'at', type: 'temporal' as const, title: null,
    axis: { format: '%a %d %b', tickCount: { interval: 'day' as const, step: 1 }, labelOverlap: true },
    ...(range ? { scale: { domain: [localDateTime(range.from), localDateTime(range.to)] } } : {}) },
    y: { field: 'remaining', type: 'quantitative' as const, title: null, scale: { domain: [0, Math.max(1, series.totalAccounts) * 100] }, axis: { tickCount: 5, labelExpr: "datum.label + '%'" } },
    tooltip: [{ field: 'at', type: 'temporal' as const, title: 'Time' },
      { field: 'remaining', type: 'quantitative' as const, title: 'Remaining (%)', format: '.1f' }] }
  return { width: 'container', height: 180, background: 'transparent',
    config: { axis: { labelColor: theme.text, titleColor: theme.text, gridColor: theme.grid, domainColor: theme.grid, tickColor: theme.grid }, view: { stroke: null } },
    layer: [
      { data: { values: recorded }, mark: { type: 'line', color: theme.accent, clip: true }, encoding },
      ...(!range || projected.length > 0 ? [{ data: { values: projected },
        mark: { type: 'line' as const, strokeDash: [6, 4], color: theme.accent, clip: true }, encoding }] : []),
      ...(inRange({ at: series.now }) ? [{ data: { values: [{ at: series.now }] }, mark: { type: 'rule' as const, color: theme.text, clip: true },
        encoding: { x: encoding.x, tooltip: { value: 'Now' } } }] : []),
    ] }
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
