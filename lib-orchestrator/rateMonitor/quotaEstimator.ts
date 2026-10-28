import type { RateSample } from './history/rateHistoryStore'
import type { RateEstimate } from './rateMonitorApi.types'

export function estimate(last: RateSample, now: number): RateEstimate {
  return { estimated: true, sampleAt: last.at, ageMilliseconds: Math.max(0, now - last.at),
    windows: last.windows.map(window => {
      const reset = window.resetsAt === null ? NaN : Date.parse(window.resetsAt)
      if (!Number.isFinite(reset) || now < reset) return window
      const duration = window.durationMinutes * 60_000
      const next = reset + (Math.floor((now - reset) / duration) + 1) * duration
      return { ...window, usedPercent: 0, resetsAt: new Date(next).toISOString() }
    }) }
}
