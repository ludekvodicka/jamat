import { useState } from 'react'
import { buildLinePath, niceTicks, CHART_GRID, CHART_AXIS_TEXT, CHART_GUIDE } from './chart-utils'
import { useChartWidth } from './useChartWidth'
import type { LineChartProps } from './types'

const PAD = { l: 48, r: 12, t: 8, b: 20 }

/**
 * Multi-series line chart (used for cumulative tokens / spend). All series are
 * assumed to share the same point indices. Hover shows a vertical guide + a
 * tooltip listing each series' value at that index.
 */
export function LineChart({ series, height = 220, yFormat = String, xLabels }: LineChartProps) {
  const [ref, w] = useChartWidth()
  const [hover, setHover] = useState<number | null>(null)

  const n = series[0]?.points.length ?? 0
  const plotW = Math.max(0, w - PAD.l - PAD.r)
  const plotH = Math.max(0, height - PAD.t - PAD.b)
  const yMaxData = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.y)))
  const ticks = niceTicks(yMaxData)
  const yTop = ticks[ticks.length - 1] || 1

  const sx = (i: number) => PAD.l + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const sy = (v: number) => PAD.t + plotH - (v / yTop) * plotH

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (n === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const rel = e.clientX - rect.left
    const idx = Math.max(0, Math.min(n - 1, Math.round((rel / Math.max(1, plotW)) * (n - 1))))
    setHover(idx)
  }

  const xTickIdx = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i)

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
          {series.map((s) => (
            <path key={s.label} d={buildLinePath(s.points, sx, sy)} stroke={s.color} strokeWidth={1.5} fill="none" />
          ))}
          {hover != null && (
            <g>
              <line x1={sx(hover)} y1={PAD.t} x2={sx(hover)} y2={PAD.t + plotH} stroke={CHART_GUIDE} strokeWidth={1} strokeDasharray="3 3" />
              {series.map((s) => s.points[hover] && (
                <circle key={s.label} cx={sx(hover)} cy={sy(s.points[hover].y)} r={2.5} fill={s.color} />
              ))}
            </g>
          )}
          <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} fill="transparent"
            onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
      )}
      {hover != null && series[0]?.points[hover] && (
        <div className="usage-chart-tooltip" style={{ left: Math.min(sx(hover) + 8, w - 130), top: PAD.t + 4 }}>
          {xLabels?.[hover] && <div className="usage-chart-tooltip-title">{xLabels[hover]}</div>}
          {series.map((s) => (
            <div key={s.label} className="usage-chart-tooltip-row">
              <span className="usage-chart-dot" style={{ background: s.color }} />
              <span className="usage-chart-tooltip-label">{s.label}</span>
              <span className="usage-chart-tooltip-val">{yFormat(s.points[hover]?.y ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
