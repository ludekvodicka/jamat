import { describe, expect, it } from 'vitest'
import { cumulativeSeries, rangeFilter, insights, deriveLastHour, aggregateModels, dayTotal, filterDailyByModel } from './selectors'
import type { DailyUsage, HourlyUsage, DetailedRequest } from '../../../../../../core/types/stats'

const day = (date: string, input: number, output: number, model = 'claude-opus-4-8', cost = 0): DailyUsage => ({
  date, inputTokens: input, outputTokens: output, cacheCreationTokens: 0, cacheReadTokens: 0,
  totalCost: cost, modelsUsed: [model],
  modelBreakdowns: [{ modelName: model, inputTokens: input, outputTokens: output, cacheCreationTokens: 0, cacheReadTokens: 0, cost }],
})

describe('cumulativeSeries', () => {
  it('total → one running-sum series', () => {
    const s = cumulativeSeries([day('2026-06-25', 10, 5), day('2026-06-26', 20, 5)], 'total')
    expect(s).toHaveLength(1)
    expect(s[0].points.map((p) => p.y)).toEqual([15, 40])
  })
  it('inout → two series (Input, Output)', () => {
    const s = cumulativeSeries([day('2026-06-25', 10, 5), day('2026-06-26', 20, 5)], 'inout')
    expect(s.map((x) => x.label)).toEqual(['Input', 'Output'])
    expect(s[0].points.map((p) => p.y)).toEqual([10, 30])
    expect(s[1].points.map((p) => p.y)).toEqual([5, 10])
  })
})

describe('rangeFilter', () => {
  it('keeps the last N days anchored to the latest row', () => {
    const daily = [day('2026-06-25', 1, 1), day('2026-06-26', 1, 1), day('2026-06-27', 1, 1)]
    expect(rangeFilter(daily, 2).map((d) => d.date)).toEqual(['2026-06-26', '2026-06-27'])
    expect(rangeFilter(daily, null)).toHaveLength(3)
  })
})

describe('insights', () => {
  it('computes peak day, active days, streak, and API time today', () => {
    const daily = [day('2026-06-25', 0, 0), day('2026-06-26', 20, 10), day('2026-06-27', 5, 5)]
    const hourly: HourlyUsage[] = [
      { hour: 9, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, durationMs: 90000, modelsUsed: [] },
      { hour: 10, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, durationMs: 30000, modelsUsed: [] },
    ]
    const r = insights(daily, hourly)
    expect(r.peakDay).toEqual({ date: '2026-06-26', tokens: 30 })
    expect(r.activeDays).toBe(2)
    expect(r.streak).toBe(2) // 26th + 27th consecutive
    expect(r.apiTimeTodayMs).toBe(120000)
  })
})

describe('aggregateModels', () => {
  it('sums per model across days and sorts by total desc', () => {
    const daily = [day('2026-06-26', 100, 50, 'claude-opus-4-8'), day('2026-06-27', 10, 5, 'claude-haiku-4-5')]
    const rows = aggregateModels(daily)
    expect(rows[0].model).toBe('claude-opus-4-8')
    expect(rows[0].total).toBe(150)
    expect(rows[1].model).toBe('claude-haiku-4-5')
  })
})

describe('deriveLastHour', () => {
  const req = (ts: string, project: string): DetailedRequest => ({
    timestamp: ts, model: 'claude-opus-4-8', inputTokens: 10, outputTokens: 5,
    cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 15, cost: 0.1, durationMs: 1000,
    project, sessionId: 's1',
  })
  it('keeps only requests within 60 min of windowEnd and re-summarizes', () => {
    const requests = [req('2026-06-27T11:30:00.000Z', 'A'), req('2026-06-27T10:00:00.000Z', 'B')]
    const w = deriveLastHour(requests, '2026-06-27T12:00:00.000Z')
    expect(w.requests).toHaveLength(1)
    expect(w.requests[0].project).toBe('A')
    expect(w.projects).toHaveLength(1)
    expect(w.projects[0].project).toBe('A')
    expect(w.models[0].requestCount).toBe(1)
  })
})

describe('dayTotal', () => {
  it('sums all four token types', () => {
    expect(dayTotal({ ...day('2026-06-27', 1, 2), cacheCreationTokens: 3, cacheReadTokens: 4 })).toBe(10)
  })
})

describe('filterDailyByModel', () => {
  const multi = (date: string): DailyUsage => ({
    date, inputTokens: 30, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0.3,
    modelsUsed: ['claude-opus-4-8', 'claude-haiku-4-5'],
    modelBreakdowns: [
      { modelName: 'claude-opus-4-8', inputTokens: 20, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.2 },
      { modelName: 'claude-haiku-4-5', inputTokens: 10, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.1 },
    ],
  })
  it('reduces each day to one model contribution', () => {
    const out = filterDailyByModel([multi('2026-06-27')], 'claude-opus-4-8')
    expect(out[0].inputTokens).toBe(20)
    expect(out[0].totalCost).toBeCloseTo(0.2)
    expect(out[0].modelsUsed).toEqual(['claude-opus-4-8'])
  })
  it('zeroes a day the model was not used', () => {
    const out = filterDailyByModel([day('2026-06-27', 5, 5, 'claude-opus-4-8')], 'claude-haiku-4-5')
    expect(out[0].inputTokens).toBe(0)
    expect(out[0].modelsUsed).toEqual([])
  })
})
