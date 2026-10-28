import { describe, expect, it } from 'vitest'
import { TokensSectionModel } from './tokensSectionModel'

describe('TokensSectionModel', () => {
  it('totals each non-overlapping counter once', () => {
    expect(TokensSectionModel.total({ key: 'a', label: 'a', agentId: 'codex', input: 70, cacheRead: 30, output: 20, cacheWrite: 0 })).toBe(120)
  })
  it('uses the local calendar day for period controls', () => {
    expect(TokensSectionModel.day(new Date(2026, 9, 26, 23, 59))).toBe('2026-10-26')
  })
})
