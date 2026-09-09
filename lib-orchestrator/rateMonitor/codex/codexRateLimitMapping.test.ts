import { describe, expect, it } from 'vitest'

import { CodexRateLimitMapping } from './codexRateLimitMapping'
import { CodexRateLimitFixtures } from './fixtures/codexRateLimitFixtures'

describe('lib-orchestrator/rateMonitor/codex/codexRateLimitMapping', () => {
  it('reads the account limit out of a live 0.146.0 answer and leaves the per-model one alone', () => {
    expect(CodexRateLimitMapping.windowsOf(CodexRateLimitFixtures.liveResult())).toEqual([
      {
        durationMinutes: 10_080,
        usedPercent: 73,
        resetsAt: new Date(1_787_251_016 * 1000).toISOString(),
      },
    ])
  })

  it('prefers rateLimitsByLimitId.codex over the flat snapshot', () => {
    const windows = CodexRateLimitMapping.windowsOf(CodexRateLimitFixtures.disagreeingResult())
    expect(windows).toEqual([{ durationMinutes: 300, usedPercent: 88, resetsAt: null }])
  })

  it('falls back to the flat snapshot and reads both primary and secondary', () => {
    expect(CodexRateLimitMapping.windowsOf(CodexRateLimitFixtures.flatOnlyResult())).toEqual([
      {
        durationMinutes: 300,
        usedPercent: 42,
        resetsAt: new Date(1_787_251_016 * 1000).toISOString(),
      },
      { durationMinutes: 10_080, usedPercent: 12.5, resetsAt: null },
    ])
  })

  it('clamps a percentage into 0-100 rather than drawing a meter out of its box', () => {
    const clamped = (usedPercent: unknown): number | undefined =>
      CodexRateLimitMapping.windowsOf({
        rateLimits: { primary: { usedPercent, windowDurationMins: 300 } },
      })[0]?.usedPercent

    expect(clamped(140)).toBe(100)
    expect(clamped(-5)).toBe(0)
    expect(clamped(0)).toBe(0)
  })

  it('drops a window it cannot draw instead of inventing a zero', () => {
    expect(CodexRateLimitMapping.windowsOf(CodexRateLimitFixtures.unusableResult())).toEqual([])
    expect(CodexRateLimitMapping.windowsOf({
      rateLimits: { primary: { usedPercent: 10 }, secondary: { windowDurationMins: 300 } },
    })).toEqual([])
    expect(CodexRateLimitMapping.windowsOf({
      rateLimits: { primary: { usedPercent: Number.NaN, windowDurationMins: 300 } },
    })).toEqual([])
  })

  it('answers one window when the server names the same length twice', () => {
    expect(CodexRateLimitMapping.windowsOf({
      rateLimits: {
        primary: { usedPercent: 10, windowDurationMins: 300 },
        secondary: { usedPercent: 20, windowDurationMins: 300 },
      },
    })).toEqual([{ durationMinutes: 300, usedPercent: 20, resetsAt: null }])
  })

  it('leaves resetsAt null when the server named none and refuses one it cannot date', () => {
    expect(CodexRateLimitMapping.windowsOf({
      rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null } },
    })[0]?.resetsAt).toBeNull()
    expect(CodexRateLimitMapping.windowsOf({
      rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1e18 } },
    })[0]?.resetsAt).toBeNull()
  })

  it('answers nothing for anything that is not a snapshot', () => {
    for (const value of [null, undefined, 7, 'text', [], {}, { rateLimits: [] }])
      expect(CodexRateLimitMapping.windowsOf(value)).toEqual([])
  })
})
