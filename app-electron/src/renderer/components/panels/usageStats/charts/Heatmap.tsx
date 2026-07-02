import { heatColor } from './chart-utils'
import type { HeatmapProps } from './types'

const DAY_MS = 24 * 60 * 60 * 1000
const iso = (d: Date) => d.toISOString().slice(0, 10)

/**
 * GitHub-style daily heatmap: `weeks` columns × 7 day-rows, intensity ∝ daily tokens.
 * Anchored to today; columns are aligned to week boundaries (Sunday-first). Each cell
 * carries a native title tooltip ("date: N tokens") — 180+ cells make a React tooltip
 * per cell overkill.
 */
export function Heatmap({ days, weeks = 26, valueFormat = String }: HeatmapProps) {
  const map = new Map<string, number>()
  let max = 0
  for (const d of days) {
    map.set(d.date, d.value)
    if (d.value > max) max = d.value
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const rawStart = new Date(today.getTime() - (weeks * 7 - 1) * DAY_MS)
  const start = new Date(rawStart.getTime() - rawStart.getDay() * DAY_MS) // back to Sunday

  const cols: { date: string; value: number; future: boolean }[][] = []
  for (let c = 0; c <= weeks; c++) {
    const col: { date: string; value: number; future: boolean }[] = []
    for (let r = 0; r < 7; r++) {
      const cellDate = new Date(start.getTime() + (c * 7 + r) * DAY_MS)
      const key = iso(cellDate)
      col.push({ date: key, value: map.get(key) ?? 0, future: cellDate.getTime() > today.getTime() })
    }
    cols.push(col)
  }

  return (
    <div className="usage-heatmap">
      {cols.map((col, ci) => (
        <div key={ci} className="usage-heatmap-col">
          {col.map((cell) => (
            <div
              key={cell.date}
              className="usage-heatmap-cell"
              style={{ background: cell.future ? 'transparent' : heatColor(max > 0 ? cell.value / max : 0) }}
              title={cell.future ? '' : `${cell.date}: ${valueFormat(cell.value)} tokens`}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
