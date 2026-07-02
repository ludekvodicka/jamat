import { useState } from 'react'
import { buildAreaPath, niceTicks, CHART_GRID, CHART_AXIS_TEXT, CHART_GUIDE } from './chart-utils'
import { useChartWidth } from './useChartWidth'
import type { StackedAreaChartProps, Series } from './types'

const PAD = { l: 48, r: 12, t: 8, b: 20 }

/**
 * Stacked-area chart (cumulative tokens per model over time). Series are stacked
 * in array order; each band spans from the running total below it to the total
 * including it. Hover lists every series' value at that index.
 */
export function StackedAreaChart({ series, height = 220, yFormat = String, xLabels }: StackedAreaChartProps) {
  const [ref, w] = useChartWidth()
  const [hover, setHover] = useState<number | null>(null)

  const n = series[0]?.points.length ?? 0
  const plotW = Math.max(0, w - PAD.l - PAD.r)
  const plotH = Math.max(0, height - PAD.t - PAD.b)

  // Running cumulative totals → per-band upper/lower polylines.
  const lowers: { x: number; y: number }[][] = []
  const uppers: { x: number; y: number }[][] = []
  const running = new Array(n).fill(0) as number[]
  for (const s of series) {
    const lower = s.points.map((p, i) => ({ x: p.x, y: running[i] }))
    for (let i = 0; i < n; i++) running[i] += s.points[i]?.y ?? 0
    const upper = s.points.map((p, i) => ({ x: p.x, y: running[i] }))
    lowers.push(lower)
    uppers.push(upper)
  }
  const yMaxData = Math.max(1, ...running)
  const ticks = niceTicks(yMaxData)
  const yTop = ticks[ticks.length - 1] || 1

  const sx = (i: number) => PAD.l + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const sy = (v: number) => PAD.t + plotH - (v / yTop) * plotH

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (n === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const idx = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - rect.left) / Math.max(1, plotW)) * (n - 1))))
    setHover(idx)
  }
  const xTickIdx = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i)
  const valAt = (s: Series, i: number) => s.points[i]?.y ?? 0

  return (
    <div ref={ref} className="usage-chart" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} className="usage-chart-svg">
          {ticks.map((t) => {
            const y = sy(t)
            return (
              <g key={t}>
                <line x1={PAD.l} y1={y} x2={w - PAD.r} y2={y} stroke={CHART_GRID} strokeWidth={1} />
                <text x={PAD.l - 6} y={y + 3} textAnchor="end" fontSize={9} fill={CHART_AXIS_TEXT}>{yFormat(t)}</text>
              </g>
            )
          })}
          {xLabels && xTickIdx.map((i) => (
            <text key={i} x={sx(i)} y={height - 6} textAnchor="middle" fontSize={9} fill={CHART_AXIS_TEXT}>{xLabels[i]}</text>
          ))}
          {series.map((s, k) => (
            <path key={s.label} d={buildAreaPath(uppers[k], lowers[k], sx, sy)} fill={s.color} fillOpacity={0.85} stroke="none" />
          ))}
          {hover != null && (
            <line x1={sx(hover)} y1={PAD.t} x2={sx(hover)} y2={PAD.t + plotH} stroke={CHART_GUIDE} strokeWidth={1} strokeDasharray="3 3" />
          )}
          <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} fill="transparent"
            onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
      )}
      {hover != null && (
        <div className="usage-chart-tooltip" style={{ left: Math.min(sx(hover) + 8, w - 140), top: PAD.t + 4 }}>
          {xLabels?.[hover] && <div className="usage-chart-tooltip-title">{xLabels[hover]}</div>}
          {series.filter((s) => valAt(s, hover) > 0).map((s) => (
            <div key={s.label} className="usage-chart-tooltip-row">
              <span className="usage-chart-dot" style={{ background: s.color }} />
              <span className="usage-chart-tooltip-label">{s.label}</span>
              <span className="usage-chart-tooltip-val">{yFormat(valAt(s, hover))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
