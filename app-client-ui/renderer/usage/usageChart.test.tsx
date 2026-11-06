import { describe, expect, it } from 'vitest'
import { type ChartScale, chartHoverPoint } from './usageChart'

describe('chartHoverPoint', () => {
  it('follows the pointer on a time axis and leaves the plot outside its range', () => {
    const time = Object.assign((value: unknown) => Number(value) / 10, { range: () => [0, 200], domain: () => [0, 2000], invert: (position: number) => new Date(position * 10) }) as ChartScale
    expect(chartHoverPoint(time, 50)).toEqual({ value: 500, at: 50 })
    expect(chartHoverPoint(time, 201)).toBeNull()
  })
  it('snaps to the middle of the bar on a band axis, gaps included', () => {
    const offsets: Record<string, number> = { a: 7.5, b: 157.5 }
    const band = Object.assign((value: unknown) => offsets[String(value)], { range: () => [0, 300], domain: () => ['a', 'b'], bandwidth: () => 135, step: () => 150 }) as ChartScale
    expect(chartHoverPoint(band, 2)).toEqual({ value: 'a', at: 75 })
    expect(chartHoverPoint(band, 151)).toEqual({ value: 'b', at: 225 })
  })
})
