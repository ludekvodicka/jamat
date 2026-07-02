import { describe, expect, it } from 'vitest'
import { niceTicks, buildLinePath, buildAreaPath, assignModelColors, heatColor, MODEL_COLORS } from './chart-utils'

describe('niceTicks', () => {
  it('returns [0] for non-positive / non-finite max', () => {
    expect(niceTicks(0)).toEqual([0])
    expect(niceTicks(-5)).toEqual([0])
    expect(niceTicks(Infinity)).toEqual([0])
  })
  it('starts at 0 and ends at or above max, ascending', () => {
    const t = niceTicks(95)
    expect(t[0]).toBe(0)
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(95)
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1])
  })
  it('picks round steps', () => {
    expect(niceTicks(100, 4)).toEqual([0, 25, 50, 75, 100])
  })
  it('top tick is always >= max (no bar/line overflow above the plot)', () => {
    for (const max of [110, 137, 999, 1.1e8, 7]) {
      const t = niceTicks(max)
      expect(t[t.length - 1]).toBeGreaterThanOrEqual(max)
    }
  })
})

describe('buildLinePath', () => {
  const sx = (x: number) => x * 10
  const sy = (y: number) => 100 - y // invert
  it('returns empty string for no points', () => {
    expect(buildLinePath([], sx, sy)).toBe('')
  })
  it('builds an M…L polyline applying the scales', () => {
    const d = buildLinePath([{ x: 0, y: 0 }, { x: 1, y: 50 }], sx, sy)
    expect(d).toBe('M 0.0 100.0 L 10.0 50.0')
  })
})

describe('buildAreaPath', () => {
  const sx = (x: number) => x
  const sy = (y: number) => y
  it('closes the band (upper forward, lower reversed, Z)', () => {
    const d = buildAreaPath([{ x: 0, y: 2 }, { x: 1, y: 3 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }], sx, sy)
    expect(d.startsWith('M 0.0 2.0 L 1.0 3.0')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
  })
})

describe('assignModelColors', () => {
  it('assigns palette colors in order and wraps past the palette length', () => {
    const models = Array.from({ length: MODEL_COLORS.length + 2 }, (_, i) => `m${i}`)
    const colors = assignModelColors(models)
    expect(colors.m0).toBe(MODEL_COLORS[0])
    expect(colors[`m${MODEL_COLORS.length}`]).toBe(MODEL_COLORS[0]) // wrapped
  })
})

describe('heatColor', () => {
  it('uses the empty color for zero intensity and a brighter stop as intensity rises', () => {
    expect(heatColor(0)).toBe('#162230')
    expect(heatColor(1)).toBe('#4fc3f7')
    expect(heatColor(0.1)).not.toBe(heatColor(0.9))
  })
})
