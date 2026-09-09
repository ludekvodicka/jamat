import { describe, expect, it } from 'vitest'

import { ClaudeUsageFixtures } from './fixtures/claudeUsageFixtures'
import { ClaudeUsageResponse } from './claudeUsageResponse'

describe('lib-orchestrator/rateMonitor/claude/claudeUsageResponse', () => {
  // The captured body is the whole reason `limits[]` is read: this account's flat model-scoped pair
  // was null, and its only model-scoped weekly arrived as a `weekly_scoped` entry in the list.
  it('reads the session, the weekly and the model-scoped weekly out of a live body', () => {
    const { windows } = ClaudeUsageResponse.of(ClaudeUsageFixtures.live())

    expect(windows).toEqual([
      { durationMinutes: 300, usedPercent: 21, resetsAt: '2026-08-17T11:39:59.916741+00:00' },
      { durationMinutes: 10_080, usedPercent: 5, resetsAt: '2026-08-23T14:59:59.916762+00:00' },
      {
        durationMinutes: 10_080,
        usedPercent: 5,
        resetsAt: '2026-08-23T14:59:59.916979+00:00',
        model: 'fable',
      },
    ])
  })

  // The captured body carries nine codenamed buckets, one of them filled in. They are server-side
  // experiments: none is a window, and none is named anywhere in the mapper.
  it('walks past the codenamed buckets it was never told about', () => {
    const { windows } = ClaudeUsageResponse.of({
      nimbus_quill: { utilization: 0, resets_at: null },
      tangelo: { utilization: 42, resets_at: null },
    })

    expect(windows).toEqual([])
  })

  it('reads the flat model-scoped pair where an account fills it in', () => {
    const { windows } = ClaudeUsageResponse.of(ClaudeUsageFixtures.flatModelScoped())

    const shape = windows.map((window) => [window.durationMinutes, window.model, window.usedPercent])
    expect(shape).toEqual([
      [300, undefined, 12],
      [10_080, undefined, 40],
      [10_080, 'opus', 63],
      [10_080, 'sonnet', 7],
    ])
  })

  // The same weekly reaches the mapper from the flat field and from `limits[]`; it is one window,
  // and the flat field is the one that wins.
  it('lands a weekly named twice exactly once', () => {
    const { windows } = ClaudeUsageResponse.of(ClaudeUsageFixtures.flatModelScoped())

    const opus = windows.filter((window) => window.model === 'opus')
    expect(opus).toHaveLength(1)
    expect(opus[0]?.usedPercent).toBe(63)
  })

  it('answers only what was named, never a zero for what was not', () => {
    const { windows } = ClaudeUsageResponse.of(ClaudeUsageFixtures.weeklyOnly())

    expect(windows).toEqual([
      { durationMinutes: 10_080, usedPercent: 5, resetsAt: '2026-08-23T14:59:59Z' },
    ])
  })

  it('maps an empty body to no windows and no extras', () => {
    expect(ClaudeUsageResponse.of(ClaudeUsageFixtures.empty())).toEqual({ windows: [], extras: [] })
  })

  it('maps a body that is not an object at all to nothing', () => {
    expect(ClaudeUsageResponse.of(null)).toEqual({ windows: [], extras: [] })
    expect(ClaudeUsageResponse.of('rate limited')).toEqual({ windows: [], extras: [] })
    expect(ClaudeUsageResponse.of([1, 2])).toEqual({ windows: [], extras: [] })
  })

  it('says extra usage is off, and how far it is used when it is on', () => {
    expect(ClaudeUsageResponse.of(ClaudeUsageFixtures.live()).extras)
      .toEqual([{ label: 'Extra usage', detail: 'off' }])
    expect(ClaudeUsageResponse.of(ClaudeUsageFixtures.flatModelScoped()).extras)
      .toEqual([{ label: 'Extra usage', detail: '18% used' }])
  })

  it('says nothing about extra usage the body did not mention', () => {
    expect(ClaudeUsageResponse.of(ClaudeUsageFixtures.weeklyOnly()).extras).toEqual([])
  })

  it('drops a bucket whose percentage is not a number', () => {
    const { windows } = ClaudeUsageResponse.of({
      five_hour: { utilization: null, resets_at: '2026-08-17T11:39:59Z' },
      seven_day: { utilization: 5, resets_at: null },
    })

    expect(windows).toEqual([{ durationMinutes: 10_080, usedPercent: 5, resetsAt: null }])
  })

  it('keeps a percentage inside the track a meter is drawn in', () => {
    const { windows } = ClaudeUsageResponse.of({
      five_hour: { utilization: 130, resets_at: null },
      seven_day: { utilization: -4, resets_at: null },
    })

    expect(windows.map((window) => window.usedPercent)).toEqual([100, 0])
  })

  it('ignores a scoped weekly that names no model', () => {
    const { windows } = ClaudeUsageResponse.of({
      limits: [
        { kind: 'weekly_scoped', percent: 9, resets_at: null, scope: null },
        { kind: 'weekly_scoped', percent: 9, scope: { model: { display_name: '' } } },
        { kind: 'weekly_all', percent: 9, resets_at: null, scope: null },
      ],
    })

    expect(windows).toEqual([])
  })
})
