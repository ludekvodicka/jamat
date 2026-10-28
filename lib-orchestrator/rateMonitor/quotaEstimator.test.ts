import { expect, it } from 'vitest'
import { estimate } from './quotaEstimator'
import type { RateSample } from './history/rateHistoryStore'
it('keeps measured usage before reset and advances reset windows without claiming a measurement', () => {
  const reset = Date.parse('2026-10-27T12:00:00Z')
  const sample: RateSample = { at: reset - 60_000, agentId: 'claude', accountId: 'main', source: 'poll',
    windows: [{ durationMinutes: 300, usedPercent: 80, resetsAt: new Date(reset).toISOString() }] }
  expect(estimate(sample, reset - 1)).toEqual({ estimated: true, sampleAt: sample.at, ageMilliseconds: 59_999, windows: sample.windows })
  expect(estimate(sample, reset).windows).toEqual([{ durationMinutes: 300, usedPercent: 0, resetsAt: new Date(reset + 18_000_000).toISOString() }])
  expect(estimate(sample, reset + 36_000_000).windows[0].resetsAt).toBe(new Date(reset + 54_000_000).toISOString())
  expect(estimate({ ...sample, windows: [{ ...sample.windows[0], resetsAt: null }] }, reset).windows[0].usedPercent).toBe(80)
})
