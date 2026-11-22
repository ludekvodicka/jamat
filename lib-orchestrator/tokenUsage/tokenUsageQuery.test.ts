import { describe, expect, it } from 'vitest'
import { tokenUsageRows, tokenUsageSessionRows } from './tokenUsageQuery'

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

  it('groups session buckets across days and labels known Jamat sessions versus external transcripts', () => {
    const buckets = [
      { day: '2026-11-20', agentId: 'antigravity' as const, nativeId: 'conv-111122223333', projectKey: 'q:/app', input: 100, output: 20, cacheRead: 50, cacheWrite: 0 },
      { day: '2026-11-21', agentId: 'antigravity' as const, nativeId: 'conv-111122223333', projectKey: 'q:/app', input: 50, output: 10, cacheRead: 0, cacheWrite: 0 },
      { day: '2026-11-21', agentId: 'antigravity' as const, nativeId: 'anonymoussession', projectKey: 'q:/app', input: 30, output: 5, cacheRead: 0, cacheWrite: 0 },
      { day: '2026-11-21', agentId: 'claude' as const, nativeId: 'c1', projectKey: 'unknown', input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
    ]
    const labels = { sessions: { 'antigravity/conv-111122223333': '147 - agy' }, projects: { 'q:/app': 'Jamat' } }
    expect(tokenUsageSessionRows(buckets, { from: '2026-11-20', to: '2026-11-21', agentId: 'antigravity' }, labels)).toEqual([
      { key: 'anonymoussession', label: 'Jamat · anonymou', agentId: 'antigravity', input: 30, output: 5, cacheRead: 0, cacheWrite: 0 },
      { key: 'conv-111122223333', label: '147 - agy', agentId: 'antigravity', input: 150, output: 30, cacheRead: 50, cacheWrite: 0 },
    ])
  })
})
