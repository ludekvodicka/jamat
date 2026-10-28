import type { RateAccountKey, RateSample } from './rateMonitorApi.types'
import type { PoolSeries } from './usageApi.types'

const hour = 3_600_000
const week = 7 * 24 * hour
const remaining = (sample: RateSample): number | null => {
  const window = sample.windows.find(value => value.durationMinutes === 10080 && !value.model)
  return window ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : null
}

export function projectPool(samples: readonly RateSample[], accounts: readonly RateAccountKey[],
  now: number, until: number, burnHours = 3, displayRange?: { from: number; to: number }): PoolSeries {
  const ordered = samples.filter(sample => sample.at <= now && accounts.some(key =>
    key.agentId === sample.agentId && key.accountId === sample.accountId) && remaining(sample) !== null)
    .sort((a, b) => a.at - b.at)
  const latest = new Map<string, number>()
  const recorded: PoolSeries['recorded'][number][] = []
  for (const sample of ordered) {
    latest.set(sample.accountId, remaining(sample)!)
    const point = { at: sample.at, remaining: [...latest.values()].reduce((sum, value) => sum + value, 0) }
    if (recorded.at(-1)?.at === sample.at) recorded[recorded.length - 1] = point
    else recorded.push(point)
  }
  const states = accounts.flatMap(key => {
    const own = ordered.filter(sample => sample.accountId === key.accountId && sample.agentId === key.agentId)
    const last = own.at(-1)
    if (!last) return []
    const recent = own.filter(sample => sample.at >= now - burnHours * hour)
    let spent = 0
    for (let index = 1; index < recent.length; index++) {
      const before = recent[index - 1], after = recent[index]
      const reset = Date.parse(before.windows.find(window => window.durationMinutes === 10080 && !window.model)?.resetsAt ?? '')
      const resetGain = reset > before.at && reset <= after.at ? 100 - remaining(before)! : 0
      spent += Math.max(0, remaining(before)! - remaining(after)! + resetGain)
    }
    const elapsed = recent.length > 1 ? recent.at(-1)!.at - recent[0].at : 0
    const burn = elapsed > 0 ? spent / (elapsed / hour) : 0
    let reset = Date.parse(last.windows.find(window => window.durationMinutes === 10080 && !window.model)?.resetsAt ?? '')
    let value = remaining(last)!
    if (Number.isFinite(reset) && reset <= now) {
      value = 100
      reset += (Math.floor((now - reset) / week) + 1) * week
    }
    return [{ accountId: key.accountId, remaining: value, burn, reset }]
  })
  const inRange = (point: { at: number }): boolean => !displayRange || point.at >= displayRange.from && point.at <= displayRange.to
  const factsFrom = Math.max(now, displayRange?.from ?? now)
  const result: PoolSeries = { recorded: recorded.filter(inRange), projected: [], burnPerHour: states.reduce((sum, state) => sum + state.burn, 0),
    poolEmptyAt: null, firstEmpty: null, nextReset: null, now, until, knownAccounts: states.length, totalAccounts: accounts.length }
  if (displayRange) result.displayRange = displayRange
  if (states.length === 0 || until < now) return result
  const projected: { at: number; remaining: number }[] = []
  const total = (): number => states.reduce((sum, state) => sum + state.remaining, 0)
  const empties = (at: number): void => {
    if (at < factsFrom) return
    const empty = states.find(state => state.remaining <= 0)
    if (empty && result.firstEmpty === null) result.firstEmpty = { accountId: empty.accountId, at }
    if (total() <= 0 && result.poolEmptyAt === null) result.poolEmptyAt = at
  }
  let at = now
  projected.push({ at, remaining: total() })
  empties(at)
  while (at < until) {
    const next = Math.min(until, factsFrom > at ? factsFrom : until, ...states.flatMap(state => [
      Number.isFinite(state.reset) && state.reset > at ? state.reset : until,
      state.burn > 0 && state.remaining > 0 ? at + state.remaining / state.burn * hour : until,
    ]))
    for (const state of states) {
      state.remaining = Math.max(0, state.remaining - state.burn * (next - at) / hour)
      if (state.remaining < 1e-8) state.remaining = 0
    }
    at = next
    projected.push({ at, remaining: total() })
    empties(at)
    for (const state of states)
      if (state.reset === at) {
        if (at >= factsFrom && result.nextReset === null) result.nextReset = { accountId: state.accountId, at, gain: 100 - state.remaining }
        state.remaining = 100
        state.reset += week
      }
    if (projected.at(-1)!.remaining !== total()) projected.push({ at, remaining: total() })
  }
  result.projected = projected.filter(inRange)
  return result
}
