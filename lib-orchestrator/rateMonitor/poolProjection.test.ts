import { describe, expect, it } from 'vitest'
import type { RateSample } from './rateMonitorApi.types'
import { projectPool } from './poolProjection'

const hour = 3_600_000
const account = [{ agentId: 'claude' as const, accountId: 'main', weight: 1 }]
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
  it('counts a percent once when the status line and the poll round it differently', () => {
    const statusLine = (at: number, used: number): RateSample => ({ ...sample(at, used), source: 'statusline' })
    const series = projectPool([statusLine(0, 11), sample(0.25 * hour, 12), statusLine(0.5 * hour, 11),
      sample(0.75 * hour, 12), statusLine(hour, 11), sample(1.5 * hour, 13), statusLine(2 * hour, 12)], account, 2 * hour, 3 * hour)
    expect(series.burnPerHour).toBe(1)
  })
  it('combines staggered accounts and moves the spend of an empty account to the account that still has quota', () => {
    const keys = [...account, { agentId: 'claude' as const, accountId: 'work', weight: 1 }]
    const work = (at: number, used: number): RateSample => ({ ...sample(at, used, 8 * hour), accountId: 'work' })
    const series = projectPool([sample(0, 50), work(hour, 10), sample(2 * hour, 90), work(3 * hour, 50)], keys, 3 * hour, 9 * hour)
    expect(series.burnPerHour).toBe(20)
    expect(series.firstEmpty).toEqual({ accountId: 'main', at: 3.5 * hour })
    expect(series.accounts[1].projected.find(point => point.at === 3.5 * hour)).toEqual({ at: 3.5 * hour, remaining: 40 })
    expect(series.poolEmptyAt).toBe(4.5 * hour)
    expect(series.nextReset).toEqual({ accountId: 'work', at: 8 * hour, gain: 50 })
    expect(series.projected.filter(point => point.at === 8 * hour)).toEqual([
      { at: 8 * hour, remaining: 0 }, { at: 8 * hour, remaining: 50 },
    ])
  })
  it('weighs the pool, its burn and a reset gain by plan', () => {
    const keys = [{ ...account[0], weight: 10 }, { agentId: 'claude' as const, accountId: 'work', weight: 5 }]
    const work = (at: number, used: number): RateSample => ({ ...sample(at, used, 10 * hour), accountId: 'work' })
    const series = projectPool([sample(0, 40), work(0, 70), sample(hour, 50), work(hour, 100)], keys, hour, 10 * hour)
    expect(series.recorded.at(-1)).toEqual({ at: hour, remaining: 100 / 3 })
    // Main spends 10%/h and Work 30%/h: (10 x 10 + 5 x 30) / 15.
    expect(series.burnPerHour).toBeCloseTo(50 / 3)
    expect(series.nextReset).toEqual({ accountId: 'work', at: 10 * hour, gain: 100 / 3 })
  })
  it('spreads the spend of an empty account by weight, which empties the pool when its weighted quota is spent', () => {
    const keys = [{ ...account[0], weight: 10 }, { agentId: 'claude' as const, accountId: 'work', weight: 5 }]
    const work = (at: number, used: number): RateSample => ({ ...sample(at, used), accountId: 'work' })
    const series = projectPool([sample(0, 0), work(0, 90), sample(hour, 0), work(hour, 100)], keys, hour, 30 * hour)
    // Work's 5 x 10 units move to the idle Main as 5%/h.
    expect(series.firstEmpty).toEqual({ accountId: 'work', at: hour })
    expect(series.poolEmptyAt).toBe(21 * hour)
    const spent = projectPool([sample(0, 0), work(0, 80), sample(hour, 10), work(hour, 90)], keys, hour, 30 * hour)
    // Main burns 10%/h and Work 10%/h; once Work is empty at 2h its 5 x 10 units move to Main as 5%/h more.
    expect(spent.firstEmpty).toEqual({ accountId: 'work', at: 2 * hour })
    expect(spent.poolEmptyAt).toBe(2 * hour + 80 / 15 * hour)
  })
  it('keeps each account\'s own recorded and projected line beside the pool', () => {
    const keys = [...account, { agentId: 'claude' as const, accountId: 'work', weight: 1 }]
    const work = (at: number, used: number): RateSample => ({ ...sample(at, used, 8 * hour), accountId: 'work' })
    const series = projectPool([sample(0, 50), work(hour, 10), sample(2 * hour, 90), work(3 * hour, 50)], keys, 3 * hour, 9 * hour)
    expect(series.accounts.map(line => line.accountId)).toEqual(['main', 'work'])
    expect(series.accounts[0].recorded).toEqual([{ at: 0, remaining: 50 }, { at: 2 * hour, remaining: 10 }])
    expect(series.accounts[1].recorded).toEqual([{ at: hour, remaining: 90 }, { at: 3 * hour, remaining: 50 }])
    expect(series.accounts[0].projected.slice(0, 2)).toEqual([{ at: 3 * hour, remaining: 10 }, { at: 3.5 * hour, remaining: 0 }])
    expect(series.accounts[1].projected.filter(point => point.at === 8 * hour)).toEqual([
      { at: 8 * hour, remaining: 0 }, { at: 8 * hour, remaining: 100 },
    ])
    expect(series.accounts.reduce((sum, line) => sum + line.projected.at(-1)!.remaining, 0) / 2).toBe(series.projected.at(-1)!.remaining)
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
