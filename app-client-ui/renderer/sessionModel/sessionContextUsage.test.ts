import { describe, expect, it } from 'vitest'

import type { SessionModelInfo } from '../../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import { SessionContextUsage } from './sessionContextUsage'

describe('app-client-ui/renderer/sessionModel/sessionContextUsage', () => {
  function infoOf(overrides: Partial<SessionModelInfo> = {}): SessionModelInfo {
    return {
      model: 'claude-sonnet-4-5-20260101',
      modelLabel: 'Sonnet 4.5',
      effortLevel: 'high',
      contextTokens: 90_000,
      contextWindow: 1_000_000,
      ...overrides,
    }
  }

  it('rounds used tokens over the known context window', () => {
    expect(SessionContextUsage.percentOf(infoOf())).toBe(9)
    expect(SessionContextUsage.percentOf(infoOf({ contextTokens: 85_500 }))).toBe(9)
    expect(SessionContextUsage.percentOf(infoOf({ contextTokens: 854_999 }))).toBe(85)
  })

  it('answers no percentage for an unusable measurement', () => {
    expect(SessionContextUsage.percentOf(infoOf({ contextWindow: null }))).toBeNull()
    expect(SessionContextUsage.percentOf(infoOf({ contextWindow: 0 }))).toBeNull()
    expect(SessionContextUsage.percentOf(infoOf({ contextTokens: -1 }))).toBeNull()
    expect(SessionContextUsage.percentOf(infoOf({ contextTokens: Number.NaN }))).toBeNull()
  })

  it('formats compact and exact token counts for both consumers', () => {
    expect(SessionContextUsage.shortTokens(0)).toBe('0')
    expect(SessionContextUsage.shortTokens(999)).toBe('999')
    expect(SessionContextUsage.shortTokens(1_000)).toBe('1k')
    expect(SessionContextUsage.shortTokens(90_000)).toBe('90k')
    expect(SessionContextUsage.shortTokens(1_000_000)).toBe('1M')
    expect(SessionContextUsage.shortTokens(1_500_000)).toBe('1.5M')
    expect(SessionContextUsage.exactTokens(258_400)).toBe('258,400')
  })

  it('calls a reading stale after two warm polling intervals', () => {
    expect(SessionContextUsage.isStale(39_999)).toBe(false)
    expect(SessionContextUsage.isStale(40_000)).toBe(true)
    expect(SessionContextUsage.freshMillisecondsRemaining(39_999)).toBe(1)
    expect(SessionContextUsage.freshMillisecondsRemaining(40_000)).toBe(0)
  })
})
