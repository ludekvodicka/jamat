import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { ClaimCache, type ClaimCacheContent } from './claimCache'

describe('lib-orchestrator/sessionUncommitted/claims/claimCache', () => {
  let root: string
  let file: string
  let now: number
  const day = 24 * 60 * 60_000

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-claim-cache-'))
    file = join(root, 'orchestrator', 'session-claims.json')
    now = Date.parse('2026-11-26T08:00:00.000Z')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  function content(claimPath: string, nativeIds = ['native-a']): ClaimCacheContent {
    return { schema: 1, sessions: { 'session-1': { nativeIds, cursors: {}, shellRuns: [], seenAt: now,
      claims: [{ path: claimPath, source: 'tool', lastWriteAt: now, settledAt: null }] } } }
  }

  it('writes three changes within a minute once, and an unchanged content never', async () => {
    const writes = vi.spyOn(AtomicJsonFile, 'writeAsync')
    const cache = new ClaimCache(file, () => now)
    cache.scheduleWrite(content('Q:/P/a.ts'))
    await vi.advanceTimersByTimeAsync(10_000)
    cache.scheduleWrite(content('Q:/P/b.ts'))
    await vi.advanceTimersByTimeAsync(10_000)
    cache.scheduleWrite(content('Q:/P/c.ts'))
    expect(writes).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(ClaimCache.writeIntervalMillisecondsConst)
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1))
    await writes.mock.results[0]!.value
    expect(new ClaimCache(file, () => now).load().sessions['session-1']!.claims.map((claim) => claim.path)).toEqual(['Q:/P/c.ts'])

    cache.scheduleWrite(content('Q:/P/c.ts'))
    await vi.advanceTimersByTimeAsync(2 * ClaimCache.writeIntervalMillisecondsConst)
    expect(writes).toHaveBeenCalledTimes(1)
  })

  it('does not write what it just loaded', async () => {
    const first = new ClaimCache(file, () => now)
    first.scheduleWrite(content('Q:/P/a.ts'))
    await first.flush()
    const writes = vi.spyOn(AtomicJsonFile, 'writeAsync')
    const second = new ClaimCache(file, () => now)
    second.scheduleWrite(second.load())
    await second.flush()
    expect(writes).not.toHaveBeenCalled()
  })

  it('writes a pending change at once on flush', async () => {
    const cache = new ClaimCache(file, () => now)
    cache.scheduleWrite(content('Q:/P/a.ts'))
    expect(existsSync(file)).toBe(false)
    await cache.flush()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(content('Q:/P/a.ts'))
    await vi.advanceTimersByTimeAsync(2 * ClaimCache.writeIntervalMillisecondsConst)
  })

  it.each([
    ['truncated', '{"schema":1,"sessions":{"s'],
    ['schema-invalid', JSON.stringify({ schema: 1, sessions: { s: { nativeIds: 'a' } } })],
    ['another schema', JSON.stringify({ schema: 2, sessions: {} })],
  ])('reads a %s file as empty, keeps one bad copy and does not throw', async (_name, text) => {
    const cache = new ClaimCache(file, () => now)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(root, 'orchestrator'), { recursive: true })
    const invalid = join(root, 'orchestrator', 'session-claims.invalid.json')
    writeFileSync(invalid, 'older bad copy')
    writeFileSync(file, text)
    expect(cache.load()).toEqual(ClaimCache.empty())
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(invalid, 'utf8')).toBe(text)
    cache.scheduleWrite(content('Q:/P/a.ts'))
    await cache.flush()
    expect(new ClaimCache(file, () => now).load()).toEqual(content('Q:/P/a.ts'))
  })

  it('reads a missing file as empty', () => {
    expect(new ClaimCache(file, () => now).load()).toEqual(ClaimCache.empty())
  })

  it('keeps both native ids, oldest first, and the claims of A after the session rebound to B', async () => {
    const cache = new ClaimCache(file, () => now)
    cache.scheduleWrite(content('Q:/P/a.ts', ['native-a', 'native-b']))
    await cache.flush()
    const loaded = new ClaimCache(file, () => now).load().sessions['session-1']!
    expect(loaded.nativeIds).toEqual(['native-a', 'native-b'])
    expect(loaded.claims.map((claim) => claim.path)).toEqual(['Q:/P/a.ts'])
  })

  it('drops a session absent for more than 7 days at the next write', async () => {
    const value = content('Q:/P/a.ts')
    value.sessions['session-2'] = { ...value.sessions['session-1']!, nativeIds: ['native-c'], seenAt: now + 8 * day }
    now += 8 * day
    const cache = new ClaimCache(file, () => now)
    cache.scheduleWrite(value)
    await cache.flush()
    expect(Object.keys(new ClaimCache(file, () => now).load().sessions)).toEqual(['session-2'])
    expect(ClaimCache.expired(now - 7 * day, now)).toBe(false)
    expect(ClaimCache.expired(now - 7 * day - 1, now)).toBe(true)
  })
})
