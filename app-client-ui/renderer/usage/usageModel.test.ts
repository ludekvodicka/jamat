import { describe, expect, it } from 'vitest'
import type { UsageAccount } from '../../../lib-orchestrator/rateMonitor/usageApi.types'
import { UsageModel } from './usageModel'

const account: UsageAccount = { key: { agentId: 'claude', accountId: 'main' }, label: 'Main', enabled: true,
  accountState: 'active', source: 'poll', estimated: null,
  state: { kind: 'ok', fetchedAt: 1, windows: [{ durationMinutes: 10080, usedPercent: 68, resetsAt: null },
    { durationMinutes: 10080, usedPercent: 10, resetsAt: null, model: 'opus' }] } }

describe('UsageModel', () => {
  it('says nothing about a fresh measurement and names every other reading', () => {
    expect(UsageModel.readingNote(account)).toBeNull()
    expect(UsageModel.readingNote({ ...account, state: { kind: 'never-read' } })).toBe('no reading yet')
    expect(UsageModel.readingNote({ ...account, state: { kind: 'stale', fetchedAt: 1, windows: [], reason: 'HTTP 429' } })).toBe('HTTP 429')
    expect(UsageModel.readingNote({ ...account, estimated: { estimated: true, windows: [], sampleAt: 1, ageMilliseconds: 7_200_000 } }))
      .toBe('estimate, 2h old')
  })

  it('labels only an account that is not active', () => {
    expect(UsageModel.accountNote(account)).toBeNull()
    expect(UsageModel.accountNote({ ...account, accountState: 'needs-login' })).toBe('needs login')
  })

  it('reads the provider-wide window and ignores per-model windows', () => {
    expect(UsageModel.window(account, 10080)?.usedPercent).toBe(68)
    expect(UsageModel.window(account, 300)).toBeNull()
  })

  it('formats durations with two units at most', () => {
    expect(UsageModel.duration(45 * 60_000)).toBe('45m')
    expect(UsageModel.duration(200 * 60_000)).toBe('3h 20m')
    expect(UsageModel.duration((46 * 60 + 10) * 60_000)).toBe('1d 22h')
    expect(UsageModel.duration(48 * 3_600_000)).toBe('2d')
  })

  it('formats a moment relative to now', () => {
    expect(UsageModel.relative(1_000, 0)).toBe('now')
    expect(UsageModel.relative(3_600_000, 0)).toBe('in 1h')
    expect(UsageModel.relative(0, 7_200_000)).toBe('2h ago')
  })

  it('formats token counts compactly', () => {
    expect(UsageModel.tokens(950)).toBe('950')
    expect(UsageModel.tokens(12_345)).toBe('12.3k')
    expect(UsageModel.tokens(4_560_000)).toBe('4.6M')
    expect(UsageModel.tokens(345_000_000)).toBe('345M')
  })

  it('derives the pool ranges and whole-day token periods from now', () => {
    expect(UsageModel.poolRange('forecast', 10 * 86_400_000)).toEqual({ from: 9 * 86_400_000, to: 17 * 86_400_000 })
    expect(UsageModel.poolRange('week', 10 * 86_400_000)).toEqual({ from: 3 * 86_400_000, to: 41 * 86_400_000 })
    expect(UsageModel.poolRange('month', 40 * 86_400_000)).toEqual({ from: 10 * 86_400_000, to: 71 * 86_400_000 })
    expect(UsageModel.tokenPeriod('today', new Date(2026, 10, 4, 19))).toEqual({ from: '2026-11-04', to: '2026-11-04' })
    expect(UsageModel.tokenPeriod('week', new Date(2026, 10, 4, 19))).toEqual({ from: '2026-10-29', to: '2026-11-04' })
    expect(UsageModel.day(new Date(2026, 9, 26, 23, 59))).toBe('2026-10-26')
  })

  it('draws a few projected days after 7 and 30 days, and enough to show the pool running empty', () => {
    const day = 86_400_000
    const series = { recorded: [], projected: [], burnPerHour: 1, poolEmptyAt: null, firstEmpty: null, nextReset: null,
      now: 10 * day, until: 41 * day, knownAccounts: 1, totalAccounts: 1, displayRange: { from: 3 * day, to: 41 * day } }
    expect(UsageModel.poolView('week', series)).toEqual({ from: 3 * day, to: 12 * day })
    expect(UsageModel.poolView('month', { ...series, displayRange: { from: -20 * day, to: 41 * day } })).toEqual({ from: -20 * day, to: 17 * day })
    expect(UsageModel.poolView('week', { ...series, poolEmptyAt: 11 * day })).toEqual({ from: 3 * day, to: 12 * day })
    expect(UsageModel.poolView('week', { ...series, poolEmptyAt: 23 * day })).toEqual({ from: 3 * day, to: 24 * day })
    expect(UsageModel.poolView('week', { ...series, poolEmptyAt: 40 * day })).toEqual({ from: 3 * day, to: 41 * day })
    expect(UsageModel.poolView('forecast', series)).toEqual({ from: 3 * day, to: 41 * day })
  })

  it('grades a remaining quota and averages only the accounts with a reading', () => {
    expect([UsageModel.level(80), UsageModel.level(32), UsageModel.level(5)]).toEqual(['ok', 'warn', 'danger'])
    expect(UsageModel.remainingShare(155, 2)).toBe(77.5)
    expect(UsageModel.remainingShare(0, 0)).toBeNull()
  })
})
