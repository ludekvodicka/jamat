import { describe, expect, it } from 'vitest'
import { RegistryBench } from '../remoteControl/fixtures/registryBench'
import { TokenUsageOperations } from './tokenUsageOperations'

describe('TokenUsageOperations', () => {
  it('refuses unknown grouping and invalid dates and dispatches explicit reload and rescan', async () => {
    const bench = new RegistryBench(), rescans: boolean[] = []
    new TokenUsageOperations({ snapshot: () => ({ buckets: [], sessionBuckets: [], labels: {}, accountLabels: {}, sessionLabels: {},
      progress: { running: true, completed: 3, total: 4, error: null, scannedAt: null } }),
    refresh: async rescan => { rescans.push(rescan ?? false) } }, { list: async () => [] },
    { buckets: async () => ({ buckets: [], labels: {} }) }).register(bench.registry)
    expect((await bench.call('usage.tokens', { from: '2026-10-01', to: '2026-10-26', groupBy: 'unknown' })).ok).toBe(false)
    expect((await bench.call('usage.tokens', { from: '2026-02-30', to: '2026-10-26', groupBy: 'day' })).ok).toBe(false)
    expect(await bench.call('usage.tokens', { from: '2026-10-01', to: '2026-10-26', groupBy: 'day' })).toMatchObject({
      ok: true, value: { rows: [], progress: { running: true, completed: 3, total: 4 } },
    })
    expect((await bench.call('usage.refresh')).ok).toBe(true)
    expect((await bench.call('usage.rescan')).ok).toBe(true)
    expect(rescans).toEqual([false, true])
  })

  it('counts session transcripts, reported third-party runs or both, by the chosen origin', async () => {
    const bench = new RegistryBench()
    const counts = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }
    const session = { day: '2026-11-21', hour: 9, projectKey: 'q:/projects/jamat', agentId: 'claude' as const, accountId: 'main', model: 'opus', ...counts }
    const reported = { ...session, hour: 19, projectKey: 'third-party/indexer', accountId: 'work', input: 100 }
    const sessionBucket = { day: '2026-11-21', agentId: 'antigravity' as const, nativeId: 'conv-1', projectKey: 'q:/projects/jamat', ...counts }
    new TokenUsageOperations({ snapshot: () => ({ buckets: [session], sessionBuckets: [sessionBucket], labels: { 'q:/projects/jamat': 'Jamat' }, accountLabels: {}, sessionLabels: { 'antigravity/conv-1': '147 - agy' },
      progress: { running: false, completed: 1, total: 1, error: null, scannedAt: 1 } }), refresh: async () => {} },
    { list: async () => [] }, { buckets: async () => ({ buckets: [reported], labels: { 'third-party/indexer': 'indexer (3rd party)' } }) })
      .register(bench.registry)
    const labels = async (origin?: string) => {
      const reply = await bench.call('usage.tokens', { from: '2026-11-21', to: '2026-11-21', groupBy: 'project', ...(origin ? { origin } : {}) })
      return reply.ok ? (reply.value as { rows: { label: string }[] }).rows.map(row => row.label) : reply
    }
    expect(await labels()).toEqual(['Jamat', 'indexer (3rd party)'])
    expect(await labels('jamat')).toEqual(['Jamat'])
    expect(await labels('thirdParty')).toEqual(['indexer (3rd party)'])
    expect(await bench.call('usage.tokens', { from: '2026-11-21', to: '2026-11-21', groupBy: 'session', agentId: 'antigravity' })).toMatchObject({
      ok: true,
      value: { rows: [{ key: 'conv-1', label: '147 - agy', agentId: 'antigravity', ...counts }] },
    })
    expect(await bench.call('usage.tokens', { from: '2026-11-21', to: '2026-11-21', groupBy: 'session', origin: 'thirdParty' })).toMatchObject({
      ok: true,
      value: { rows: [] },
    })
    expect((await bench.call('usage.tokens', { from: '2026-11-21', to: '2026-11-21', groupBy: 'day', origin: 'other' })).ok).toBe(false)
  })
})
