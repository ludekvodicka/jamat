import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { StatusLineRateReader } from './statusLineRateReader'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
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

it('caches unchanged rate files by mtimeMs:size and prunes stale or non-existent sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jamat-rates-reader-'))
  try {
    const now = 1_800_000_000_000
    const payload = (used: number) => JSON.stringify({
      schemaVersion: 1,
      at: now - 1_000,
      launchId: 'launch-1',
      rateLimits: { five_hour: { used_percentage: used, resets_at: Math.floor((now + 3_600_000) / 1_000) } },
    })
    const liveFile = join(dir, 'live-session.json')
    const goneFile = join(dir, 'gone-session.json')
    const oldFile = join(dir, 'old-session.json')
    await writeFile(liveFile, payload(42), 'utf8')
    await writeFile(goneFile, payload(10), 'utf8')
    await writeFile(oldFile, payload(20), 'utf8')
    const freshDate = new Date(now - 5_000)
    const oldDate = new Date(now - StatusLineRateReader.maxAgeMillisecondsConst - 60_000)
    await utimes(liveFile, freshDate, freshDate)
    await utimes(goneFile, freshDate, freshDate)
    await utimes(oldFile, oldDate, oldDate)

    const parseSpy = vi.spyOn(JSON, 'parse')
    try {
      const reader = new StatusLineRateReader(
        dir,
        (sessionId) => sessionId === 'live-session' ? { agentId: 'claude', accountId: 'main' } : null,
        {
          sessionExists: (sessionId) => sessionId !== 'gone-session',
          now: () => now,
        },
      )
      const first = await reader.read()
      expect(first).toHaveLength(1)
      expect(first[0]?.windows[0]?.usedPercent).toBe(42)
      expect(existsSync(goneFile)).toBe(false)
      expect(existsSync(oldFile)).toBe(false)
      expect(existsSync(liveFile)).toBe(true)

      const parsesAfterFirst = parseSpy.mock.calls.length
      const second = await reader.read()
      expect(second).toHaveLength(1)
      expect(second[0]?.windows[0]?.usedPercent).toBe(42)
      expect(parseSpy.mock.calls.length).toBe(parsesAfterFirst)

      await writeFile(liveFile, payload(77), 'utf8')
      const bumped = new Date(now + 5_000)
      await utimes(liveFile, bumped, bumped)
      const third = await reader.read()
      expect(third).toHaveLength(1)
      expect(third[0]?.windows[0]?.usedPercent).toBe(77)
      expect(parseSpy.mock.calls.length).toBe(parsesAfterFirst + 1)
    } finally { parseSpy.mockRestore() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
