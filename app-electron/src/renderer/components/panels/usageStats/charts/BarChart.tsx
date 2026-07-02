import { useState } from 'react'
import { niceTicks, CHART_GRID, CHART_AXIS_TEXT, CHART_ACCENT, CHART_ZERO_BAR } from './chart-utils'
import { useChartWidth } from './useChartWidth'
import type { BarChartProps } from './types'

const PAD = { l: 48, r: 12, t: 8, b: 22 }

/** Vertical bar chart (24h hourly tokens/cost). Zero-value bars render dim. Hover → tooltip. */
export function BarChart({ bars, height = 200, color = CHART_ACCENT, yFormat = String }: BarChartProps) {
  const [ref, w] = useChartWidth()
  const [hover, setHover] = useState<number | null>(null)

  const n = bars.length
  const plotW = Math.max(0, w - PAD.l - PAD.r)
  const plotH = Math.max(0, height - PAD.t - PAD.b)
  const yMaxData = Math.max(1, ...bars.map((b) => b.value))
  const ticks = niceTicks(yMaxData)
  const yTop = ticks[ticks.length - 1] || 1

  const slot = n > 0 ? plotW / n : plotW
  const bw = Math.max(1, slot * 0.7)
  const bx = (i: number) => PAD.l + i * slot + (slot - bw) / 2
  const sy = (v: number) => PAD.t + plotH - (v / yTop) * plotH
  const labelStep = n > 12 ? Math.ceil(n / 12) : 1

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
          {bars.map((b, i) => {
            const y = sy(b.value)
            return (
              <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect x={bx(i)} y={y} width={bw} height={Math.max(0, PAD.t + plotH - y)}
                  fill={b.value === 0 ? CHART_ZERO_BAR : (hover === i ? '#7fd4ff' : color)} rx={2} />
                {i % labelStep === 0 && (
                  <text x={bx(i) + bw / 2} y={height - 7} textAnchor="middle" fontSize={8} fill={CHART_AXIS_TEXT}>{b.label}</text>
                )}
              </g>
            )
          })}
        </svg>
      )}
      {hover != null && bars[hover] && (
        <div className="usage-chart-tooltip" style={{ left: Math.min(bx(hover), w - 130), top: PAD.t + 4 }}>
          <div className="usage-chart-tooltip-title">{bars[hover].label}</div>
          <div className="usage-chart-tooltip-row">
            <span className="usage-chart-tooltip-val">{yFormat(bars[hover].value)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
