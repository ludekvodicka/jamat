import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { StatusLineRateReader } from './statusLineRateReader'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const limits = { five_hour: { used_percentage: 37, resets_at: 1793115673 }, seven_day: { used_percentage: 21, resets_at: 1793702473 } }

it('maps the installed CLI percentage and Unix-second fields and rejects malformed limits', () => {
  expect(StatusLineRateReader.windowsOf(limits)).toEqual([
    { durationMinutes: 300, usedPercent: 37, resetsAt: new Date(1793115673000).toISOString() },
    { durationMinutes: 10080, usedPercent: 21, resetsAt: new Date(1793702473000).toISOString() },
  ])
  expect(StatusLineRateReader.windowsOf({ five_hour: { used_percentage: '37', resets_at: 1793115673 } })).toEqual([])
  expect(StatusLineRateReader.windowsOf(null)).toEqual([])
})

it('attributes to the current launch and ignores an old account receipt after switching', async () => {
  const temp = resolve('../.aidocs/temp')
  mkdirSync(temp, { recursive: true })
  const root = mkdtempSync(join(temp, 'U8-reader-'))
  roots.push(root)
  let current = { accountId: 'a', launchId: 'launch-a' }
  const reader = new StatusLineRateReader(root, (session, launch) =>
    session === 'session' && launch === current.launchId ? { agentId: 'claude', accountId: current.accountId } : null)
  const write = (launchId: string, at: number) => writeFileSync(join(root, 'session.json'),
    JSON.stringify({ schemaVersion: 1, at, launchId, rateLimits: limits }))
  write('launch-a', 1)
  expect(await reader.read()).toEqual([{ key: { agentId: 'claude', accountId: 'a' }, at: 1,
    source: 'statusline', windows: StatusLineRateReader.windowsOf(limits) }])
  current = { accountId: 'b', launchId: 'launch-b' }
  expect(await reader.read()).toEqual([])
  write('launch-b', 2)
  expect((await reader.read())[0].key.accountId).toBe('b')
  writeFileSync(join(root, 'session.json'), '{broken')
  expect(await reader.read()).toEqual([])
})

it('reads Antigravity statusLine quota receipts and preserves extras and raw payload', async () => {
  const temp = resolve('../.aidocs/temp')
  mkdirSync(temp, { recursive: true })
  const root = mkdtempSync(join(temp, 'U8-agy-reader-'))
  roots.push(root)
  const quota = {
    'gemini-5h': { remaining_fraction: 0.75, reset_in_seconds: 3_600 },
    'gemini-weekly': { remaining_fraction: 0.9, reset_time: '2026-11-28T00:00:00Z' },
  }
  const at = Date.parse('2026-11-21T15:00:00.000Z')
  writeFileSync(join(root, 'agy-session.json'), JSON.stringify({
    schemaVersion: 1,
    at,
    launchId: 'launch-agy',
    planTier: 'Pro',
    antigravityQuota: quota,
  }))
  const reader = new StatusLineRateReader(root, (session, launch) =>
    session === 'agy-session' && launch === 'launch-agy' ? { agentId: 'antigravity', accountId: 'main' } : null)
  expect(await reader.read()).toEqual([{
    key: { agentId: 'antigravity', accountId: 'main' },
    at,
    source: 'statusline',
    windows: [
      { durationMinutes: 300, usedPercent: 25, resetsAt: '2026-11-21T16:00:00.000Z' },
      { durationMinutes: 10_080, usedPercent: 10, resetsAt: '2026-11-28T00:00:00.000Z' },
    ],
    extras: [{ label: 'Plan', detail: 'Pro' }],
    raw: quota,
  }])
})
