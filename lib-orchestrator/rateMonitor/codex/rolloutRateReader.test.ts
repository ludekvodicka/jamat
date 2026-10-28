import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AccountView } from '../../agentAccounts/agentAccountsApi.types'
import { RolloutRateReader } from './rolloutRateReader'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const now = Date.now() - 60_000
function world(creator: string | null = 'known') {
  const temp = resolve(import.meta.dirname, '../../../.aidocs/temp')
  mkdirSync(temp, { recursive: true })
  const home = mkdtempSync(join(temp, 'codex-rollout-rates-'))
  roots.push(home)
  mkdirSync(join(home, 'sessions/2026'), { recursive: true })
  const file = join(home, 'sessions/2026/rollout-fixture.jsonl')
  writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { creator_account_id: creator } }) + '\n')
  let accounts: AccountView[] = [{ accountId: 'work', agentId: 'codex', isMain: false, label: 'Work', state: 'active',
    identity: { key: 'known', label: 'Known' }, profileProblem: null }]
  return { home, file, reader: new RolloutRateReader(home, async () => accounts),
    setAccounts: (next: AccountView[]) => { accounts = next } }
}
function event(at = now, used = 37): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'token_count',
    rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 1893456000 },
      secondary: { used_percent: 20, window_minutes: 10080, resets_at: 1894060800 } } } }) + '\n'
}

it('attributes native rollout windows to the registered creator identity and emits incremental history', async () => {
  const { file, reader } = world()
  appendFileSync(file, event())
  expect(await reader.read()).toEqual([{ key: { agentId: 'codex', accountId: 'work' }, at: now, source: 'rollout', backfill: true,
    windows: [{ durationMinutes: 300, usedPercent: 37, resetsAt: '2030-01-01T00:00:00.000Z' },
      { durationMinutes: 10080, usedPercent: 20, resetsAt: '2030-01-08T00:00:00.000Z' }] }])
  expect(await reader.read()).toEqual([])
  const next = event(now + 1000, 42)
  appendFileSync(file, next.slice(0, -2))
  expect(await reader.read()).toEqual([])
  appendFileSync(file, next.slice(-2))
  expect(await reader.read()).toMatchObject([{ at: now + 1000, windows: [{ usedPercent: 42 }, { usedPercent: 20 }] }])
})

it('retains unknown creator readings until that identity is registered, without borrowing Main quota', async () => {
  const { file, reader, setAccounts } = world('later')
  appendFileSync(file, event())
  expect(await reader.read()).toEqual([])
  setAccounts([{ accountId: 'later-profile', agentId: 'codex', isMain: false, label: 'Later', state: 'active',
    identity: { key: 'later', label: 'Later' }, profileProblem: null }])
  expect(await reader.read()).toMatchObject([{ key: { accountId: 'later-profile' }, at: now }])
})

it('attributes legacy rollouts to Main and drops old, malformed and unrelated model limits', async () => {
  const { file, reader } = world(null)
  appendFileSync(file, 'invalid\n' + event(now - 91 * 24 * 60 * 60_000) + event())
  expect(await reader.read()).toMatchObject([{ key: { accountId: 'main' }, at: now }])
  expect(RolloutRateReader.windowsOf({ limit_id: 'model-extra', primary: { used_percent: 20, window_minutes: 300 } })).toEqual([])
  expect(RolloutRateReader.windowsOf({ primary: { used_percent: 'broken', window_minutes: 300 } })).toEqual([])
})

it('resets a replaced or truncated rollout cursor', async () => {
  const { file, reader } = world()
  appendFileSync(file, event())
  await reader.read()
  writeFileSync(file, event(now + 500, 1))
  expect(await reader.read()).toMatchObject([{ key: { accountId: 'main' }, windows: [{ usedPercent: 1 }, { usedPercent: 20 }] }])
})
