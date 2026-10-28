import { describe, expect, it } from 'vitest'
import { chooseDefault } from './defaultAccount'
import type { AccountView } from './agentAccountsApi.types'
import type { RateAccountState } from '../rateMonitor/rateMonitorApi.types'
const account = (accountId: string): AccountView => ({ agentId: 'claude', accountId, label: accountId,
  isMain: accountId === 'main', state: 'active', identity: null, profileProblem: null })
const rate = (accountId: string, session: number, weekly: number, days: number): RateAccountState => ({
  key: { agentId: 'claude', accountId }, label: accountId, estimated: null, source: 'poll', state: { kind: 'ok', fetchedAt: 0,
    windows: [{ durationMinutes: 300, usedPercent: session, resetsAt: null },
      { durationMinutes: 10080, usedPercent: weekly, resetsAt: new Date(days * 86400000).toISOString() }] } })
const accounts = [account('main'), account('b')]
describe('default account', () => {
  it('uses the soonest weekly reset among accounts with free five-hour quota', () => {
    expect(chooseDefault('claude', accounts, [rate('main', 40, 20, 1), rate('b', 10, 20, 5)]).accountId).toBe('main')
    expect(chooseDefault('claude', accounts, [rate('main', 95, 20, 1), rate('b', 10, 20, 5)]).accountId).toBe('b')
  })
  it('falls back to main with a warning when every weekly window is exhausted', () => {
    expect(chooseDefault('claude', accounts, [rate('main', 0, 100, 1), rate('b', 0, 100, 5)]))
      .toEqual({ accountId: 'main', noFreeAccount: true, resetsAt: null })
  })
  it('breaks equal resets by session use and then main', () => {
    expect(chooseDefault('claude', accounts, [rate('main', 40, 20, 1), rate('b', 10, 20, 1)]).accountId).toBe('b')
    expect(chooseDefault('claude', accounts, [rate('main', 10, 20, 1), rate('b', 10, 20, 1)]).accountId).toBe('main')
  })
  it('never chooses disabled, pending-login or needs-login and puts unknown quotas last', () => {
    for (const state of ['disabled', 'pending-login', 'needs-login'] as const)
      expect(chooseDefault('claude', [account('main'), { ...account('b'), state }], [rate('b', 0, 0, 1)]).accountId).toBe('main')
    expect(chooseDefault('claude', accounts, [rate('b', 20, 20, 5)]).accountId).toBe('b')
    expect(chooseDefault('claude', accounts, []).accountId).toBe('main')
    const partial = rate('b', 20, 20, 5)
    partial.state = { kind: 'ok', fetchedAt: 0, windows: [{ durationMinutes: 300, usedPercent: 20, resetsAt: null }] }
    expect(chooseDefault('claude', accounts, [partial]).accountId).toBe('b')
  })
  it('uses an estimate after a stale sample reset', () => {
    const stale = rate('b', 100, 100, 1)
    stale.estimated = { estimated: true, sampleAt: 0, ageMilliseconds: 1000,
      windows: [{ durationMinutes: 300, usedPercent: 0, resetsAt: null }, { durationMinutes: 10080, usedPercent: 0, resetsAt: new Date(1).toISOString() }] }
    expect(chooseDefault('claude', accounts, [rate('main', 100, 100, 1), stale]).accountId).toBe('b')
  })
})
