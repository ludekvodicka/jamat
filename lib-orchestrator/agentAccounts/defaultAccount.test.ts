import { describe, expect, it } from 'vitest'
import { accountQuota, chooseDefault, weeklyReserve, type AccountBurn } from './defaultAccount'
import type { AccountView } from './agentAccountsApi.types'
import type { RateAccountState } from '../rateMonitor/rateMonitorApi.types'
const account = (accountId: string): AccountView => ({ agentId: 'claude', accountId, label: accountId,
  isMain: accountId === 'main', state: 'active', identity: null, profileProblem: null })
const rate = (accountId: string, session: number, weekly: number, days: number): RateAccountState => ({
  key: { agentId: 'claude', accountId }, label: accountId, estimated: null, source: 'poll', state: { kind: 'ok', fetchedAt: 0,
    windows: [{ durationMinutes: 300, usedPercent: session, resetsAt: null },
      { durationMinutes: 10080, usedPercent: weekly, resetsAt: new Date(days * 86400000).toISOString() }] } })
const accounts = [account('main'), account('b')]
const day = 86_400_000
const plans = [{ ...account('main'), capacity: { weight: 10, tier: 'default_claude_max_20x' } }, { ...account('b'), capacity: { weight: 5, tier: 'default_claude_max_5x' } }]
const burn = (accountId: string, dayRate: number, recent: number): AccountBurn => ({ key: { agentId: 'claude', accountId }, day: dayRate, recent })
describe('default account', () => {
  it('summarizes the plain 5-hour and weekly windows, skipping model windows, and has none without a reading', () => {
    const reading = rate('b', 12, 64, 5)
    if (reading.state.kind !== 'ok') throw new Error('fixture')
    const withModel: RateAccountState = { ...reading, state: { ...reading.state,
      windows: [{ durationMinutes: 10080, usedPercent: 99, resetsAt: null, model: 'fable' }, ...reading.state.windows] } }
    expect(accountQuota(withModel)).toEqual({ sessionUsedPercent: 12, weeklyUsedPercent: 64, weeklyResetsAt: new Date(5 * 86400000).toISOString() })
    expect(accountQuota({ ...reading, state: { kind: 'never-read' } })).toBeNull()
    expect(accountQuota(undefined)).toBeNull()
  })
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
  it('keeps 5, 2 and 1 percent until a day, 12 hours and one hour before the reset', () => {
    expect([48, 24.5, 24, 12.5, 12, 1.5, 1, 0].map(weeklyReserve)).toEqual([5, 5, 2, 2, 1, 1, 0, 0])
  })
  it('passes over an account in its reserve while another has quota above its own', () => {
    expect(chooseDefault('claude', accounts, [rate('main', 0, 96, 2), rate('b', 0, 50, 5)], [], 0).accountId).toBe('b')
    expect(chooseDefault('claude', accounts, [rate('main', 0, 96, 0.8), rate('b', 0, 50, 5)], [], 0).accountId).toBe('main')
  })
  it('uses the soonest reset among accounts that are all in their reserve, without reporting exhaustion', () => {
    expect(chooseDefault('claude', accounts, [rate('main', 0, 97, 3), rate('b', 0, 99, 2)], [], 0))
      .toEqual({ accountId: 'b', noFreeAccount: false, resetsAt: new Date(2 * day).toISOString() })
  })
  it('gives slow spend to the soonest reset, which can still empty it in time', () => {
    const rates = [rate('main', 0, 0, 2), rate('b', 0, 0, 4)]
    expect(chooseDefault('claude', plans, rates, [burn('main', 1, 1), burn('b', 0, 0)], 0).accountId).toBe('main')
  })
  it('gives the later reset its share when the spend is faster than the soonest reset can take', () => {
    const rates = [rate('main', 0, 0, 2), rate('b', 0, 0, 4)]
    // Main at 10 x 95% over 48h takes 19.8 units/h, b 4.9; a day of 30 units/h gives b a fifth.
    expect(chooseDefault('claude', plans, rates, [burn('main', 3, 3), burn('b', 0, 0)], 0).accountId).toBe('b')
    expect(chooseDefault('claude', plans, rates, [burn('main', 2.4, 2), burn('b', 1.2, 2)], 0).accountId).toBe('main')
  })
  it('weighs the pace by plan', () => {
    const rates = [rate('main', 0, 0, 2), rate('b', 0, 0, 4)]
    const swapped = [{ ...plans[0], capacity: { weight: 5, tier: null } }, { ...plans[1], capacity: { weight: 10, tier: null } }]
    // With main the smaller plan it takes only 9.9 units/h, so 10 units/h of spend already reaches b.
    expect(chooseDefault('claude', plans, rates, [burn('main', 1, 1), burn('b', 0, 0)], 0).accountId).toBe('main')
    expect(chooseDefault('claude', swapped, rates, [burn('main', 2, 2), burn('b', 0, 0)], 0).accountId).toBe('b')
  })
  it('spends the soonest reset at once under soonest-reset, where paced passes it over for its recent spend', () => {
    const rates = [rate('main', 0, 0, 2), rate('b', 0, 0, 5)]
    const burns = [burn('main', 3, 3), burn('b', 0, 0)]
    expect(chooseDefault('claude', accounts, rates, burns, 0, 'paced').accountId).toBe('b')
    expect(chooseDefault('claude', accounts, rates, burns, 0, 'soonest-reset').accountId).toBe('main')
  })
  it('uses the soonest reset under both rules when every account is in its reserve', () => {
    const rates = [rate('main', 0, 97, 3), rate('b', 0, 99, 2)]
    expect(['paced', 'soonest-reset'].map(rule => chooseDefault('claude', accounts, rates, [], 0, rule as 'paced').accountId)).toEqual(['b', 'b'])
  })
})
