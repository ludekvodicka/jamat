/**
 * Pure helpers for the hand-rolled SVG charts — no React imports, so they can be
 * unit-tested in isolation (see chart-utils.test.ts). The charts are dependency-free
 * (no Chart.js / recharts / vega) to match the app's minimalistic, MUI-free style.
 */

/** 13-color model palette, ported verbatim from the legacy dashboard for visual parity. */
export const MODEL_COLORS = [
  '#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8',
  '#4db6ac', '#ff8a65', '#aed581', '#f06292', '#7986cb',
  '#ffd54f', '#a1887f', '#90a4ae',
] as const

/** Assign a stable color to each model in the given order (e.g. sorted by total desc). */
export function assignModelColors(models: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  models.forEach((m, i) => { out[m] = MODEL_COLORS[i % MODEL_COLORS.length] })
  return out
}

export interface Pt { x: number; y: number }

/**
 * "Nice" axis ticks from 0..max (ascending, including 0 and a top tick >= max).
 * Used for y-axis gridlines.
 */
export function niceTicks(max: number, count = 4): number[] {
  if (!isFinite(max) || max <= 0) return [0]
  const rawStep = max / count
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const norm = rawStep / mag
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10
  const step = niceNorm * mag
  // Round the top tick UP to a multiple of step so it is always >= max — otherwise the
  // tallest bar/line would render above the top gridline (overflow the plot).
  const top = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = 0; v <= top + step * 0.5; v += step) ticks.push(v)
  return ticks
}

/** SVG path "M x y L x y …" for a polyline. `sx`/`sy` map data → pixels (sy already inverts). */
export function buildLinePath(points: Pt[], sx: (x: number) => number, sy: (y: number) => number): string {
  if (!points.length) return ''
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ')
}

/** Closed area path between an upper polyline and a lower one (for stacked bands). */
export function buildAreaPath(upper: Pt[], lower: Pt[], sx: (x: number) => number, sy: (y: number) => number): string {
  if (!upper.length) return ''
  const up = upper.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ')
  const down = [...lower].reverse().map((p) => `L ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ')
  return `${up} ${down} Z`
}

/** Map a 0..1 daily-intensity to a heatmap cell color (empty → accent blue, GitHub-style ramp). */
export function heatColor(intensity: number): string {
  if (intensity <= 0) return '#162230'
  const stops = ['#1a3a4a', '#1a5a6a', '#2a8aaa', '#4fc3f7']
  const idx = Math.min(stops.length - 1, Math.floor(intensity * stops.length))
  return stops[idx]
}

/** Shared axis/grid colors (blue-tinted, matching the panel's report theme). */
export const CHART_GRID = '#22303f'
export const CHART_AXIS_TEXT = '#8899aa'
export const CHART_ACCENT = '#4fc3f7'
export const CHART_GUIDE = '#3a5068'
export const CHART_ZERO_BAR = '#22303f'
