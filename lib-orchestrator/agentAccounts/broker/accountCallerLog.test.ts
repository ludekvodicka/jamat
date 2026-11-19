import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AccountCallerEntry } from '../accountBrokerApi.types'
import { AccountCallerLog } from './accountCallerLog'

const dayMs = 24 * 60 * 60_000
const roots: string[] = []

function logOf(): { log: AccountCallerLog; directory: string } {
  const root = mkdtempSync(join(tmpdir(), 'jamat-caller-log-'))
  roots.push(root)
  const directory = join(root, 'account-callers')
  return { log: new AccountCallerLog(directory), directory }
}

function entry(at: number, overrides: Partial<AccountCallerEntry> = {}): AccountCallerEntry {
  return { at, caller: 'indexer', purpose: 'background', accountId: 'work', accountLabel: 'Work', fallback: false,
    reason: 'chosen', durationMs: 12, ...overrides }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('AccountCallerLog', () => {
  it('reads two picks across a month boundary back in time order', async () => {
    const { log, directory } = logOf()
    const late = Date.UTC(2026, 10, 1, 0, 0, 5)
    const early = Date.UTC(2026, 9, 31, 23, 59, 55)
    await log.append(entry(late, { caller: 'b' }))
    await log.append(entry(early, { caller: 'a' }))
    expect(readdirSync(directory).sort()).toEqual(['2026-10.jsonl', '2026-11.jsonl'])
    const view = await log.view(late + 1_000)
    expect(view.recent.map(item => item.caller)).toEqual(['b', 'a'])
    expect(view.callers.map(item => item.caller)).toEqual(['b', 'a'])
    expect(view).toMatchObject({ capturedAt: late + 1_000, windowDays: 30 })
  })

  it('leaves an entry 31 days old out of the view while its month file still exists', async () => {
    const { log, directory } = logOf()
    const now = Date.UTC(2026, 10, 30, 12)
    await log.append(entry(now - 31 * dayMs, { caller: 'old' }))
    await log.append(entry(now - dayMs, { caller: 'new' }))
    expect(existsSync(join(directory, '2026-10.jsonl'))).toBe(true)
    expect((await log.view(now)).callers.map(item => item.caller)).toEqual(['new'])
  })

  it('prunes a month file that ended more than 30 days ago and keeps the current one', async () => {
    const { log, directory } = logOf()
    const now = Date.UTC(2026, 11, 5, 12)
    await log.append(entry(Date.UTC(2026, 9, 20)))
    await log.append(entry(Date.UTC(2026, 10, 20)))
    await log.append(entry(now))
    await log.prune(now)
    expect(readdirSync(directory).sort()).toEqual(['2026-11.jsonl', '2026-12.jsonl'])
    await logOf().log.prune(now)
  })

  it('skips a partial last line and starts the next append on a new line', async () => {
    const { log, directory } = logOf()
    const at = Date.UTC(2026, 10, 19, 10)
    await log.append(entry(at, { caller: 'first' }))
    const file = join(directory, '2026-11.jsonl')
    writeFileSync(file, readFileSync(file, 'utf8') + '{"at":17,"cal', 'utf8')
    expect((await log.view(at + 1)).callers.map(item => item.caller)).toEqual(['first'])
    await log.append(entry(at + 2, { caller: 'second' }))
    const lines = readFileSync(file, 'utf8').split('\n')
    expect(lines).toHaveLength(4)
    expect(JSON.parse(lines[2]!)).toMatchObject({ caller: 'second' })
    expect((await log.view(at + 3)).callers.map(item => item.caller)).toEqual(['second', 'first'])
  })

  it('summarizes calls, fallbacks, purposes and accounts per caller, newest caller first, and keeps the 50 newest calls', async () => {
    const { log } = logOf()
    const base = Date.UTC(2026, 10, 19, 8)
    await log.append(entry(base, { caller: 'assistant', purpose: 'interactive', accountId: 'main', accountLabel: 'Main', fallback: true, reason: 'jamat-unavailable' }))
    await log.append(entry(base + 1, { caller: 'indexer' }))
    await log.append(entry(base + 2, { caller: 'assistant', purpose: 'interactive', accountId: 'work', accountLabel: 'Work renamed' }))
    await log.append(entry(base + 3, { caller: 'assistant', purpose: 'background', accountId: 'work', accountLabel: 'Work renamed' }))
    for (let index = 0; index < 50; index++) await log.append(entry(base + 10 + index, { caller: 'bulk' }))
    const view = await log.view(base + 1_000)
    expect(view.callers.map(item => item.caller)).toEqual(['bulk', 'assistant', 'indexer'])
    expect(view.callers[1]).toEqual({ caller: 'assistant', lastAt: base + 3, calls: 3, fallbacks: 1,
      purposes: { interactive: 2, background: 1 },
      accounts: [{ accountId: 'work', label: 'Work renamed', calls: 2 }, { accountId: 'main', label: 'Main', calls: 1 }] })
    expect(view.callers[0]).toMatchObject({ calls: 50, fallbacks: 0 })
    expect(view.recent).toHaveLength(50)
    expect(view.recent[0]!.at).toBe(base + 59)
    expect(view.recent.at(-1)!.at).toBe(base + 10)
  })

  it('leaves two whole lines after two concurrent appends', async () => {
    const { log, directory } = logOf()
    const at = Date.UTC(2026, 10, 19, 9)
    await Promise.all([log.append(entry(at, { caller: 'one' })), log.append(entry(at + 1, { caller: 'two' }))])
    const lines = readFileSync(join(directory, '2026-11.jsonl'), 'utf8').split('\n').filter(line => line.length > 0)
    expect(lines.map(line => JSON.parse(line).caller)).toEqual(['one', 'two'])
  })

  it('answers an empty view when nothing was logged', async () => {
    expect(await logOf().log.view(5)).toEqual({ capturedAt: 5, windowDays: 30, callers: [], recent: [] })
  })
})
