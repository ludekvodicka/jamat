import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { RateMonitor } from './rateMonitor'
import { RolloutRateReader } from './codex/rolloutRateReader'
import { RateHistoryStore } from './history/rateHistoryStore'

it.each([false, true])('retries an incremental rollout batch after persistence failure, partial=%s', async partial => {
  const temp = resolve(import.meta.dirname, '../../.aidocs/temp')
  mkdirSync(temp, { recursive: true })
  const root = mkdtempSync(join(temp, 'rollout-persistence-')), now = Date.now()
  const cache = join(root, 'cache.json'), home = join(root, 'profile')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(join(home, 'sessions/rollout-fixture.jsonl'), [20, 30].map((used, index) => JSON.stringify({
    timestamp: new Date(now - 60_000 + index * 1_000).toISOString(), type: 'event_msg', payload: { type: 'token_count',
      rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 1893456000 } } },
  })).join('\n') + '\n')
  const cached = { fetchedAt: now, windows: [{ durationMinutes: 300, usedPercent: 50, resetsAt: null }], extras: [] }
  writeFileSync(cache, JSON.stringify({ schemaVersion: 2, accounts: [{ key: { agentId: 'codex', accountId: 'main' }, entry: cached }] }))
  const reader = new RolloutRateReader(home, async () => []), readings = vi.fn(() => reader.read()), errors: string[] = []
  const original = RateHistoryStore.prototype.backfill
  const backfill = vi.spyOn(RateHistoryStore.prototype, 'backfill').mockImplementationOnce(async function(this: RateHistoryStore, samples) {
    if (partial) await original.call(this, samples.slice(0, 1))
    throw new Error('fixture persistence refused')
  })
  const monitor = new RateMonitor({ configIdentity: 'fixture', channel: 'development', cacheFile: cache,
    onChanged: () => {}, onError: error => errors.push(error), now: () => now, readings,
    sources: () => [{ agentId: 'codex', read: async () => ({ kind: 'failed', reason: 'unused', oauthExpiresAt: null }), stop: () => {} }] })
  vi.useFakeTimers()
  try {
    await monitor.start()
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(async () => expect(await monitor.readHistory({ from: 0, to: now })).toHaveLength(2))
    expect((await monitor.readHistory({ from: 0, to: now })).map(sample => sample.windows[0].usedPercent)).toEqual([20, 30])
    expect(monitor.snapshot().providers.codex).toEqual({ kind: 'ok', fetchedAt: now, windows: cached.windows })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await monitor.readHistory({ from: 0, to: now })).toHaveLength(2)
    expect(backfill.mock.calls[1][0]).toHaveLength(2)
  } finally {
    await monitor.stop()
    vi.useRealTimers()
    backfill.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})
