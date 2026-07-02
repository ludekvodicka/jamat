import { CHART_ACCENT } from './chart-utils'
import type { DistributionBarProps } from './types'

/** In-table horizontal share bar (a row's metric vs the column max). */
export function DistributionBar({ fraction, color = CHART_ACCENT }: DistributionBarProps) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100
  return (
    <div className="usage-dist-bar">
      <div className="usage-dist-bar-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}
