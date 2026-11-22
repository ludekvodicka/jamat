import { describe, expect, it } from 'vitest'

import { AntigravityQuotaMapper } from './antigravityQuotaMapper'

describe('lib-orchestrator/rateMonitor/antigravity/antigravityQuotaMapper', () => {
  it('maps a single gemini-weekly bucket from Antigravity statusLine JSON to a plain weekly window', () => {
    const mapped = AntigravityQuotaMapper.map(
      {
        'gemini-weekly': {
          remaining_fraction: 0.9378,
          reset_time: '2026-07-06T07:50:32Z',
          reset_in_seconds: 560_580,
        },
      },
      Date.parse('2026-06-29T20:07:32Z'),
      'Pro',
    )

    expect(mapped.windows).toEqual([
      {
        durationMinutes: 10_080,
        usedPercent: 6.2,
        resetsAt: '2026-07-06T07:50:32.000Z',
      },
    ])
    expect(mapped.extras).toEqual([{ label: 'Plan', detail: 'Pro' }])
  })

  it('maps 5h and weekly buckets alongside third-party pools and preserves credit amounts as extras', () => {
    const at = Date.parse('2026-11-21T15:00:00.000Z')
    const mapped = AntigravityQuotaMapper.map(
      {
        'gemini-5h': { remaining_fraction: 0.75, reset_in_seconds: 7_200, disabled: false },
        'gemini-weekly': { remaining_fraction: 0.5, reset_time: '2026-11-28T00:00:00Z' },
        'claude-weekly': { remaining_fraction: 0.2, reset_time: '2026-11-27T00:00:00Z' },
        'ai-credits': { remaining_amount: 42 },
        'ignored-disabled': { remaining_fraction: 0.1, disabled: true },
      },
      at,
    )

    expect(mapped.windows).toEqual([
      { durationMinutes: 300, usedPercent: 25, resetsAt: '2026-11-21T17:00:00.000Z' },
      { durationMinutes: 10_080, usedPercent: 50, resetsAt: '2026-11-28T00:00:00.000Z' },
      { durationMinutes: 10_080, usedPercent: 80, resetsAt: '2026-11-27T00:00:00.000Z', model: 'claude' },
    ])
    expect(mapped.extras).toEqual([{ label: 'Ai Credits', detail: '42 remaining' }])
  })

  it('promotes exact gemini-weekly to plain weekly even alongside gemini sub-pools like gemini-argon-wtu-weekly', () => {
    const mapped = AntigravityQuotaMapper.map({
      '3p-5h': { remaining_fraction: 1, reset_time: '2026-11-22T01:29:22Z' },
      '3p-weekly': { remaining_fraction: 1, reset_time: '2026-11-28T20:29:22Z' },
      'gemini-5h': { remaining_fraction: 0.9322895, reset_time: '2026-11-22T00:39:07Z' },
      'gemini-argon-wtu-weekly': { remaining_fraction: 1, reset_time: '2026-11-28T20:29:22Z' },
      'gemini-weekly': { remaining_fraction: 0.69470173, reset_time: '2026-11-28T14:39:07Z' },
    })

    expect(mapped.windows).toEqual([
      { durationMinutes: 300, usedPercent: 6.8, resetsAt: '2026-11-22T00:39:07.000Z' },
      { durationMinutes: 10_080, usedPercent: 30.5, resetsAt: '2026-11-28T14:39:07.000Z' },
      { durationMinutes: 300, usedPercent: 0, resetsAt: '2026-11-22T01:29:22.000Z', model: '3p' },
      { durationMinutes: 10_080, usedPercent: 0, resetsAt: '2026-11-28T20:29:22.000Z', model: '3p' },
      { durationMinutes: 10_080, usedPercent: 0, resetsAt: '2026-11-28T20:29:22.000Z', model: 'gemini-argon-wtu' },
    ])
  })

  it('keeps distinct model labels when multiple sibling pools share a duration without a plain bucket', () => {
    const mapped = AntigravityQuotaMapper.map({
      'gemini-pro-5h': { remaining_fraction: 0.6, reset_time: '2026-11-21T20:00:00Z' },
      'gemini-flash-5h': { remaining_fraction: 0.9, reset_time: '2026-11-21T20:00:00Z' },
    })

    expect(mapped.windows).toEqual([
      { durationMinutes: 300, usedPercent: 10, resetsAt: '2026-11-21T20:00:00.000Z', model: 'gemini-flash' },
      { durationMinutes: 300, usedPercent: 40, resetsAt: '2026-11-21T20:00:00.000Z', model: 'gemini-pro' },
    ])
  })

  it('clamps out-of-range fractions and returns empty for non-objects', () => {
    expect(AntigravityQuotaMapper.map(null)).toEqual({ windows: [], extras: [] })
    expect(AntigravityQuotaMapper.map({
      '5h': { remaining_fraction: 1.4 },
      weekly: { remaining_fraction: -0.2 },
    }).windows).toEqual([
      { durationMinutes: 300, usedPercent: 0, resetsAt: null },
      { durationMinutes: 10_080, usedPercent: 100, resetsAt: null },
    ])
  })
})
