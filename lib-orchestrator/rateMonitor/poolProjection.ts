import { accountBurn, weeklyRemaining } from './accountBurn'
import type { RateAccountKey, RateSample } from './rateMonitorApi.types'
import type { PoolPoint, PoolSeries } from './usageApi.types'

const hour = 3_600_000
const week = 7 * 24 * hour

/** An account of the pool with its weekly capacity weight (`PlanWeight`). */
export interface WeightedAccountKey extends RateAccountKey { weight: number }

/**
 * The weekly pool in percent of the weighted capacity of the accounts it knows: a Max 20x account
 * at 50% and an empty Max 5x account make 33%, not 25%. Account lines stay in their own percent.
 * The projection keeps the pool's spend: when an account runs empty, its spend moves to the
 * accounts that still have quota, by their weight, because the work continues on them.
 */
export function projectPool(samples: readonly RateSample[], accounts: readonly WeightedAccountKey[],
  now: number, until: number, burnHours = 3, displayRange?: { from: number; to: number }): PoolSeries {
  const ordered = samples.filter(sample => sample.at <= now && accounts.some(key =>
    key.agentId === sample.agentId && key.accountId === sample.accountId) && weeklyRemaining(sample) !== null)
    .sort((a, b) => a.at - b.at)
  const weight = new Map(accounts.map(key => [key.accountId, key.weight]))
  const weighted = (values: Iterable<[string, number]>): number => {
    let units = 0, capacity = 0
    for (const [accountId, remaining] of values) {
      units += weight.get(accountId)! * remaining
      capacity += weight.get(accountId)!
    }
    return capacity > 0 ? units / capacity : 0
  }
  const latest = new Map<string, number>()
  const recorded: PoolPoint[] = []
  const own = new Map<string, { recorded: PoolPoint[]; projected: PoolPoint[] }>(accounts.map(key => [key.accountId, { recorded: [], projected: [] }]))
  for (const sample of ordered) {
    latest.set(sample.accountId, weeklyRemaining(sample)!)
    record(recorded, { at: sample.at, remaining: weighted(latest) })
    record(own.get(sample.accountId)!.recorded, { at: sample.at, remaining: weeklyRemaining(sample)! })
  }
  const states = accounts.flatMap(key => {
    const last = ordered.filter(sample => sample.accountId === key.accountId && sample.agentId === key.agentId).at(-1)
    if (!last) return []
    let reset = Date.parse(last.windows.find(window => window.durationMinutes === 10080 && !window.model)?.resetsAt ?? '')
    let value = weeklyRemaining(last)!
    if (Number.isFinite(reset) && reset <= now) {
      value = 100
      reset += (Math.floor((now - reset) / week) + 1) * week
    }
    return [{ accountId: key.accountId, weight: key.weight, remaining: value, burn: accountBurn(ordered, key, now, burnHours), reset }]
  })
  const capacity = states.reduce((sum, state) => sum + state.weight, 0)
  const inRange = (point: { at: number }): boolean => !displayRange || point.at >= displayRange.from && point.at <= displayRange.to
  const factsFrom = Math.max(now, displayRange?.from ?? now)
  const result: PoolSeries = { recorded: recorded.filter(inRange), projected: [],
    accounts: accounts.map(key => ({ accountId: key.accountId, recorded: own.get(key.accountId)!.recorded.filter(inRange), projected: [] })),
    burnPerHour: capacity > 0 ? states.reduce((sum, state) => sum + state.weight * state.burn, 0) / capacity : 0,
    poolEmptyAt: null, firstEmpty: null, nextReset: null, now, until, knownAccounts: states.length, totalAccounts: accounts.length }
  if (displayRange) result.displayRange = displayRange
  if (states.length === 0 || until < now) return result
  const projected: PoolPoint[] = []
  const total = (): number => weighted(states.map(state => [state.accountId, state.remaining]))
  const spending = (): Map<string, number> => {
    const live = states.filter(state => state.remaining > 0)
    const liveWeight = live.reduce((sum, state) => sum + state.weight, 0)
    const orphan = states.filter(state => state.remaining <= 0).reduce((sum, state) => sum + state.weight * state.burn, 0)
    return new Map(states.map(state => [state.accountId, state.remaining > 0 ? state.burn + orphan / liveWeight : 0]))
  }
  const mark = (at: number): void => {
    if (projected.at(-1)?.at !== at || projected.at(-1)!.remaining !== total()) projected.push({ at, remaining: total() })
    for (const state of states) {
      const points = own.get(state.accountId)!.projected
      if (points.at(-1)?.at !== at || points.at(-1)!.remaining !== state.remaining) points.push({ at, remaining: state.remaining })
    }
  }
  const empties = (at: number): void => {
    if (at < factsFrom) return
    const empty = states.find(state => state.remaining <= 0)
    if (empty && result.firstEmpty === null) result.firstEmpty = { accountId: empty.accountId, at }
    if (total() <= 0 && result.poolEmptyAt === null) result.poolEmptyAt = at
  }
  let at = now
  mark(at)
  empties(at)
  while (at < until) {
    const burn = spending()
    const next = Math.min(until, factsFrom > at ? factsFrom : until, ...states.flatMap(state => [
      Number.isFinite(state.reset) && state.reset > at ? state.reset : until,
      burn.get(state.accountId)! > 0 ? at + state.remaining / burn.get(state.accountId)! * hour : until,
    ]))
    for (const state of states) {
      state.remaining = Math.max(0, state.remaining - burn.get(state.accountId)! * (next - at) / hour)
      if (state.remaining < 1e-8) state.remaining = 0
    }
    at = next
    mark(at)
    empties(at)
    for (const state of states)
      if (state.reset === at) {
        if (at >= factsFrom && result.nextReset === null)
          result.nextReset = { accountId: state.accountId, at, gain: state.weight * (100 - state.remaining) / capacity }
        state.remaining = 100
        state.reset += week
      }
    mark(at)
  }
  result.projected = projected.filter(inRange)
  result.accounts = result.accounts.map(series => ({ ...series, projected: own.get(series.accountId)!.projected.filter(inRange) }))
  return result
}

/** A later reading at the same moment replaces the earlier one: one point per moment. */
function record(points: PoolPoint[], point: PoolPoint): void {
  if (points.at(-1)?.at === point.at) points[points.length - 1] = point
  else points.push(point)
}
