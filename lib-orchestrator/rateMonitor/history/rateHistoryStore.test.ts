import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RateHistoryStore, type RateSample } from './rateHistoryStore'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function world() {
  const temp = resolve('../.aidocs/temp')
  mkdirSync(temp, { recursive: true })
  const root = mkdtempSync(join(temp, 'U9-history-'))
  roots.push(root)
  return { root, store: new RateHistoryStore(root) }
}
const sample: RateSample = { at: Date.parse('2026-10-27T12:00:00Z'), agentId: 'claude', accountId: 'main', source: 'poll',
  windows: [{ durationMinutes: 300, usedPercent: 37, resetsAt: null }] }

it('deduplicates identical windows for five minutes per account, including a restarted writer', async () => {
  const { root, store } = world()
  await store.append(sample)
  await store.append({ ...sample, at: sample.at + 120_000 })
  await new RateHistoryStore(root).append({ ...sample, at: sample.at + 180_000 })
  expect(readFileSync(join(root, '2026-10.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
  await store.append({ ...sample, at: sample.at + 240_000, windows: [{ durationMinutes: 300, usedPercent: 38, resetsAt: null }] })
  expect(await store.read({ from: sample.at, to: sample.at + 300_000 })).toHaveLength(2)
  await store.append({ ...sample, accountId: 'other' })
  expect(await store.read({ from: sample.at, to: sample.at + 300_000 })).toHaveLength(3)
})

it('hydrates an older first receipt for A without rewinding B deduplication', async () => {
  const { store } = world()
  const first = { ...sample, accountId: 'b' }
  const changed = { ...first, at: sample.at + 240_000,
    windows: [{ durationMinutes: 300, usedPercent: 38, resetsAt: null }] }
  const other = { ...sample, accountId: 'a', at: sample.at + 120_000 }
  const changedBack = { ...first, at: sample.at + 280_000 }
  await store.append(first)
  await store.append(changed)
  await store.append(other)
  await store.append({ ...changed, at: sample.at + 260_000 })
  await store.append(changedBack)
  expect(await store.read({ from: 0, to: Infinity })).toEqual([first, other, changed, changedBack])
})

it('skips a torn last line and separates the next append from it', async () => {
  const { root, store } = world()
  await store.append(sample)
  appendFileSync(join(root, '2026-10.jsonl'), '{"at":')
  expect(await store.read({ from: 0, to: Infinity })).toEqual([sample])
  const next = { ...sample, at: sample.at + 300_000 }
  await store.append(next)
  expect(await store.read({ from: 0, to: Infinity })).toEqual([sample, next])
})

it('prunes whole months outside 90 days and retains the current and boundary month', async () => {
  const { root, store } = world()
  for (const month of ['2026-01', '2026-07', '2026-10']) writeFileSync(join(root, month + '.jsonl'), '')
  await store.prune(sample.at)
  expect(existsSync(join(root, '2026-01.jsonl'))).toBe(false)
  expect(existsSync(join(root, '2026-07.jsonl'))).toBe(true)
  expect(existsSync(join(root, '2026-10.jsonl'))).toBe(true)
})

it('backfills older samples once across restart and preserves recent poll deduplication', async () => {
  const { root, store } = world()
  const recent = { ...sample, at: sample.at + 3_600_000 }
  const old = { ...sample, source: 'rollout' as const, agentId: 'codex' as const }
  const changed = { ...old, at: old.at + 120_000, windows: [{ durationMinutes: 300, usedPercent: 42, resetsAt: null }] }
  const unchanged = { ...changed, at: changed.at + 60_000 }
  await store.append(recent)
  await store.backfill([unchanged, changed, old])
  await new RateHistoryStore(root).backfill([old, changed, unchanged])
  await store.append({ ...recent, at: recent.at + 60_000 })
  expect(await store.read({ from: 0, to: Infinity })).toEqual([old, changed, recent])
})
