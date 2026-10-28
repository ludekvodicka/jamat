import { describe, expect, it } from 'vitest'
import { usageSummary } from './usageSummary'

describe('usageSummary', () => {
  it('sums enabled accounts and excludes disabled accounts', () => {
    const summary = usageSummary({ revision: 0, providers: { claude: { kind: 'never-read' }, codex: { kind: 'never-read' } },
      accounts: ['main', 'work', 'off'].map((accountId, index) => ({ key: { agentId: 'claude', accountId }, label: accountId,
        state: { kind: 'ok', fetchedAt: 1, windows: [{ durationMinutes: 10080, usedPercent: [20, 25, 0][index], resetsAt: null }] },
        estimated: null, source: 'poll' })) },
    ['main', 'work', 'off'].map(accountId => ({ agentId: 'claude', accountId, label: accountId,
      state: accountId === 'off' ? 'disabled' : 'active', isMain: accountId === 'main', identity: null, profileProblem: null })), 2)
    expect(summary.pools[0]).toEqual({ agentId: 'claude', weeklyRemaining: 155, weeklyCapacity: 200,
      sessionRemaining: 0, sessionCapacity: 200, weeklyKnown: 2, sessionKnown: 0 })
    expect(summary.accounts).toHaveLength(3)
  })
})
