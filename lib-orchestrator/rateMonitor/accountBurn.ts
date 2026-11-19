import type { RateAccountKey, RateSample } from './rateMonitorApi.types'

const hour = 3_600_000

/** Percent of the plain weekly window still left in a sample, or null when the sample has none. */
export function weeklyRemaining(sample: RateSample): number | null {
  const window = sample.windows.find(value => value.durationMinutes === 10080 && !value.model)
  return window ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : null
}

/**
 * The weekly percent one account spent per hour over the last `hours`, from its own samples in time
 * order; 0 with fewer than two samples in that time.
 */
export function accountBurn(ordered: readonly RateSample[], key: RateAccountKey, now: number, hours: number): number {
  const recent = ordered.filter(sample => sample.agentId === key.agentId && sample.accountId === key.accountId
    && sample.at <= now && sample.at >= now - hours * hour && weeklyRemaining(sample) !== null)
  // Weekly use only grows until a reset, so a reading above the lowest one since the last reset is
  // rounding or a lagging source (the status line and the poll alternate 88/89/88). Counting each
  // fall from such a reading counted the same percent again and doubled the burn.
  let spent = 0
  let lowest = recent.length > 0 ? weeklyRemaining(recent[0])! : 0
  for (let index = 1; index < recent.length; index++) {
    const before = recent[index - 1], after = recent[index]
    const reset = Date.parse(before.windows.find(window => window.durationMinutes === 10080 && !window.model)?.resetsAt ?? '')
    if (reset > before.at && reset <= after.at) {
      spent += 100 - weeklyRemaining(after)!
      lowest = weeklyRemaining(after)!
    } else if (weeklyRemaining(after)! < lowest) {
      spent += lowest - weeklyRemaining(after)!
      lowest = weeklyRemaining(after)!
    }
  }
  const elapsed = recent.length > 1 ? recent.at(-1)!.at - recent[0].at : 0
  return elapsed > 0 ? spent / (elapsed / hour) : 0
}
