import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AccountUsageEntry } from '../accountBrokerApi.types'
import { AccountUsageLog } from './accountUsageLog'

const roots: string[] = []

function directoryOf(): string {
  const root = mkdtempSync(join(tmpdir(), 'jamat-usage-log-'))
  roots.push(root)
  return join(root, 'account-usage')
}

function entry(at: number, overrides: Partial<AccountUsageEntry> = {}): AccountUsageEntry {
  return { at, caller: 'indexer', purpose: 'background', accountId: 'work',
    models: { 'claude-opus-5-5': { input: 3, output: 40, cacheRead: 600, cacheWrite: 9_000 } }, ...overrides }
}

function localDay(at: number): { day: string; hour: number } {
  const date = new Date(at)
  return { day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, hour: date.getHours() }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('AccountUsageLog', () => {
  it('turns each reported model into a Claude bucket of the caller in local time, labelled as third party', async () => {
    const log = new AccountUsageLog(directoryOf())
    const at = Date.UTC(2026, 10, 21, 18, 0, 0)
    await log.append(entry(at, { models: { 'claude-opus-5-5': { input: 3, output: 40, cacheRead: 600, cacheWrite: 9_000 },
      'claude-haiku-5-5': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } }))
    expect(await log.buckets()).toEqual({
      buckets: [
        { ...localDay(at), projectKey: 'third-party/indexer', agentId: 'claude', accountId: 'work', model: 'claude-opus-5-5', input: 3, output: 40, cacheRead: 600, cacheWrite: 9_000 },
        { ...localDay(at), projectKey: 'third-party/indexer', agentId: 'claude', accountId: 'work', model: 'claude-haiku-5-5', input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      ],
      labels: { 'third-party/indexer': 'indexer (3rd party)' },
    })
  })

  it('writes one month file per UTC month and reads every month back after a restart', async () => {
    const directory = directoryOf()
    const early = Date.UTC(2026, 9, 31, 23, 59, 55), late = Date.UTC(2026, 10, 1, 0, 0, 5)
    const first = new AccountUsageLog(directory)
    await first.append(entry(late, { caller: 'b' }))
    await first.append(entry(early, { caller: 'a' }))
    expect(readdirSync(directory).sort()).toEqual(['2026-10.jsonl', '2026-11.jsonl'])
    const { buckets } = await new AccountUsageLog(directory).buckets()
    expect(buckets.map(bucket => bucket.projectKey)).toEqual(['third-party/a', 'third-party/b'])
  })

  it('skips a line that is no entry and separates the next append from a partial tail', async () => {
    const directory = directoryOf()
    mkdirSync(directory, { recursive: true })
    const at = Date.UTC(2026, 10, 21, 12)
    const file = join(directory, '2026-11.jsonl')
    writeFileSync(file, `${JSON.stringify(entry(at, { caller: 'kept' }))}\n{"at":1,"caller":"x","purpose":"batch","accountId":"w","models":{}}\n`
      + `${JSON.stringify({ ...entry(at), models: { m: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } } })}\n{"at":`)
    const log = new AccountUsageLog(directory)
    await log.append(entry(at + 1, { caller: 'after' }))
    expect(readFileSync(file, 'utf8').endsWith(`{"at":\n${JSON.stringify(entry(at + 1, { caller: 'after' }))}\n`)).toBe(true)
    expect((await log.buckets()).buckets.map(bucket => bucket.projectKey)).toEqual(['third-party/kept', 'third-party/after'])
  })

  it('reads nothing before the first report and fails an append whose directory is a file', async () => {
    const directory = directoryOf()
    expect(await new AccountUsageLog(directory).buckets()).toEqual({ buckets: [], labels: {} })
    mkdirSync(join(directory, '..'), { recursive: true })
    writeFileSync(directory, 'not a directory')
    await expect(new AccountUsageLog(directory).append(entry(Date.UTC(2026, 10, 21)))).rejects.toThrow()
  })
})
