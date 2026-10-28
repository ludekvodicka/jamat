import { describe, expect, it } from 'vitest'
import { RegistryBench } from '../remoteControl/fixtures/registryBench'
import { TokenUsageOperations } from './tokenUsageOperations'

describe('TokenUsageOperations', () => {
  it('refuses unknown grouping and invalid dates and dispatches explicit rescan', async () => {
    const bench = new RegistryBench(), rescans: boolean[] = []
    new TokenUsageOperations({ snapshot: () => ({ buckets: [], labels: {}, accountLabels: {},
      progress: { running: true, completed: 3, total: 4, error: null, scannedAt: null } }),
    refresh: async rescan => { rescans.push(rescan ?? false) } }, { list: async () => [] }).register(bench.registry)
    expect((await bench.call('usage.tokens', { from: '2026-10-01', to: '2026-10-26', groupBy: 'unknown' })).ok).toBe(false)
    expect((await bench.call('usage.tokens', { from: '2026-02-30', to: '2026-10-26', groupBy: 'day' })).ok).toBe(false)
    expect(await bench.call('usage.tokens', { from: '2026-10-01', to: '2026-10-26', groupBy: 'day' })).toMatchObject({
      ok: true, value: { rows: [], progress: { running: true, completed: 3, total: 4 } },
    })
    expect((await bench.call('usage.rescan')).ok).toBe(true)
    expect(rescans).toEqual([true])
  })
})
