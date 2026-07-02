/** Shared prop contracts for the hand-rolled SVG chart primitives. */

/** A named, colored polyline/area. `points[i].x` is the data x (usually a row index). */
export interface Series {
  label: string
  color: string
  points: { x: number; y: number }[]
}

export interface LineChartProps {
  series: Series[]
  height?: number
  /** Format a y value for the axis + tooltip. */
  yFormat?: (n: number) => string
  /** Per-index x labels (e.g. dates), aligned to the series' point indices. */
  xLabels?: string[]
}

export interface StackedAreaChartProps {
  series: Series[]
  height?: number
  yFormat?: (n: number) => string
  xLabels?: string[]
}

export interface BarChartProps {
  bars: { label: string; value: number; dim?: boolean }[]
  height?: number
  color?: string
  yFormat?: (n: number) => string
}

export interface HeatmapProps {
  days: { date: string; value: number }[]
  weeks?: number
  valueFormat?: (n: number) => string
}

export interface DistributionBarProps {
  /** 0..1 share of the row's metric relative to the column max. */
  fraction: number
  color?: string
}
