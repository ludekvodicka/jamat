import { describe, expect, it } from 'vitest'
import { tokenUsageRows } from './tokenUsageQuery'

describe('tokenUsageRows', () => {
  it('sums all accounts and models per project in an inclusive period, retaining agent identity', () => {
    const buckets = ['main', 'work'].map((accountId, index) => ({ accountId, model: `model-${index}`, day: '2026-10-26', hour: 9,
      projectKey: 'Q:/App', agentId: 'claude' as const, input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }))
    const query = { from: '2026-10-26', to: '2026-10-26', groupBy: 'project' as const }
    expect(tokenUsageRows(buckets, query, { projects: { 'Q:/App': 'App' }, accounts: {} })).toEqual([
      { key: 'Q:/App', label: 'App', agentId: 'claude', input: 20, output: 10, cacheRead: 4, cacheWrite: 2 },
    ])
    expect(tokenUsageRows(buckets, { ...query, from: '2026-10-27', to: '2026-10-28' }, { projects: {}, accounts: {} })).toEqual([])
    expect(tokenUsageRows(buckets, { ...query, groupBy: 'hour' }, { projects: {}, accounts: {} })[0].label).toBe('09:00')
  })
})
