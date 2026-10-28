import type { TopLevelSpec } from 'vega-lite'
import type { PoolSeries } from '../../../lib-orchestrator/rateMonitor/usageApi.types'

export interface UsageChartTheme { text: string; grid: string; accent: string }

export function poolGraphSpec(series: PoolSeries, theme: UsageChartTheme): TopLevelSpec | null {
  const range = series.displayRange
  const inRange = (point: { at: number }): boolean => !range || point.at >= range.from && point.at <= range.to
  const recorded = series.recorded.filter(inRange), projected = series.projected.filter(inRange)
  if (recorded.length === 0 && projected.length === 0) return null
  const encoding = { x: { field: 'at', type: 'temporal' as const, title: 'Time',
    ...(range ? { scale: { domain: [range.from, range.to] } } : {}) },
    y: { field: 'remaining', type: 'quantitative' as const, title: 'Weekly quota remaining (%)', scale: { zero: true } },
    tooltip: [{ field: 'at', type: 'temporal' as const, title: 'Time' },
      { field: 'remaining', type: 'quantitative' as const, title: 'Remaining (%)', format: '.1f' }] }
  return { width: 'container', height: 230, background: 'transparent',
    config: { axis: { labelColor: theme.text, titleColor: theme.text, gridColor: theme.grid }, view: { stroke: null } },
    layer: [
      { data: { values: recorded }, mark: { type: 'line', color: theme.accent, clip: true }, encoding },
      ...(!range || projected.length > 0 ? [{ data: { values: projected },
        mark: { type: 'line' as const, strokeDash: [6, 4], color: theme.accent, clip: true }, encoding }] : []),
      ...(inRange({ at: series.now }) ? [{ data: { values: [{ at: series.now }] }, mark: { type: 'rule' as const, color: theme.text, clip: true },
        encoding: { x: encoding.x, tooltip: { value: 'Now' } } }] : []),
    ] }
}
