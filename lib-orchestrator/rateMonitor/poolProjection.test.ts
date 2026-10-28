import { describe, expect, it } from 'vitest'
import type { RateSample } from './rateMonitorApi.types'
import { projectPool } from './poolProjection'

const hour = 3_600_000
const account = [{ agentId: 'claude' as const, accountId: 'main' }]
function sample(at: number, usedPercent: number, reset: number | null = null): RateSample {
  return { at, agentId: 'claude', accountId: 'main', source: 'poll',
    windows: [{ durationMinutes: 10080, usedPercent, resetsAt: reset === null ? null : new Date(reset).toISOString() }] }
}
describe('projectPool', () => {
  it('measures a falling three-hour series and predicts first and pool empty', () => {
    const series = projectPool([sample(0, 10), sample(3 * hour, 40)], account, 3 * hour, 12 * hour)
    expect(series.burnPerHour).toBe(10)
    expect(series.poolEmptyAt).toBe(9 * hour)
    expect(series.firstEmpty).toEqual({ accountId: 'main', at: 9 * hour })
  })
  it('adds only the per-account gain at reset, capped at100', () => {
    const series = projectPool([sample(0, 50, 2 * hour), sample(hour, 60, 2 * hour)], account, hour, 3 * hour)
    expect(series.projected.filter(point => point.at === 2 * hour)).toEqual([
      { at: 2 * hour, remaining: 30 }, { at: 2 * hour, remaining: 100 },
    ])
    expect(series.nextReset).toEqual({ accountId: 'main', at: 2 * hour, gain: 70 })
  })
  it('reports no empty time for zero burn and no series without samples', () => {
    expect(projectPool([sample(0, 10), sample(hour, 10)], account, hour, 9 * hour).poolEmptyAt).toBeNull()
    expect(projectPool([], account, hour, 9 * hour).projected).toEqual([])
  })
  it('does not mistake a measured reset for negative consumption', () => {
    const series = projectPool([sample(0, 90, hour), sample(2 * hour, 10)], account, 2 * hour, 3 * hour)
    expect(series.burnPerHour).toBe(5)
  })
  it('combines staggered accounts while distinguishing first empty, pool empty and a later reset', () => {
    const keys = [...account, { agentId: 'claude' as const, accountId: 'work' }]
    const work = (at: number, used: number): RateSample => ({ ...sample(at, used, 8 * hour), accountId: 'work' })
    const series = projectPool([sample(0, 50), work(hour, 10), sample(2 * hour, 90), work(3 * hour, 50)], keys, 3 * hour, 9 * hour)
    expect(series.burnPerHour).toBe(40)
    expect(series.firstEmpty).toEqual({ accountId: 'main', at: 3.5 * hour })
    expect(series.poolEmptyAt).toBe(5.5 * hour)
    expect(series.nextReset).toEqual({ accountId: 'work', at: 8 * hour, gain: 100 })
    expect(series.projected.filter(point => point.at === 8 * hour)).toEqual([
      { at: 8 * hour, remaining: 0 }, { at: 8 * hour, remaining: 100 },
    ])
  })
  it('keeps a historical display range free of present-day projection and facts', () => {
    const range = { from: hour, to: 2 * hour }
    const series = projectPool([sample(hour, 10), sample(2 * hour, 20), sample(3 * hour, 30)], account, 3 * hour, range.to, 3, range)
    expect(series.recorded).toEqual([{ at: hour, remaining: 90 }, { at: 2 * hour, remaining: 80 }])
    expect(series.projected).toEqual([])
    expect(series).toMatchObject({ displayRange: range, until: range.to, poolEmptyAt: null, firstEmpty: null, nextReset: null })
  })
  it('clips a future range at its boundary and reports exhaustion already present at that boundary', () => {
    const range = { from: 7 * hour, to: 9 * hour }
    const series = projectPool([sample(0, 50, 8 * hour), sample(hour, 60, 8 * hour)], account, hour, range.to, 3, range)
    expect(series.recorded).toEqual([])
    expect(series.projected).toEqual([{ at: 7 * hour, remaining: 0 }, { at: 8 * hour, remaining: 0 },
      { at: 8 * hour, remaining: 100 }, { at: 9 * hour, remaining: 90 }])
    expect(series.firstEmpty).toEqual({ accountId: 'main', at: range.from })
    expect(series.poolEmptyAt).toBe(range.from)
    expect(series.nextReset).toEqual({ accountId: 'main', at: 8 * hour, gain: 100 })
  })
  it('keeps the projection from Now through the selected current range end', () => {
    const range = { from: 0, to: 2 * hour }
    const series = projectPool([sample(0, 10), sample(hour, 20)], account, hour, range.to, 3, range)
    expect(series.projected).toEqual([{ at: hour, remaining: 80 }, { at: 2 * hour, remaining: 70 }])
    expect(series).toMatchObject({ displayRange: range, poolEmptyAt: null, firstEmpty: null, nextReset: null })
  })
})
