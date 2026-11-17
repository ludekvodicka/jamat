import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextCompactionCooldowns } from './contextCompactionCooldowns'

describe('ContextCompactionCooldowns', () => {
  const minutes = 60_000
  let directory: string
  let file: string
  let now: number

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'compact-cooldowns-'))
    file = join(directory, 'state', 'context-compaction-cooldowns.json')
    now = 1_000_000
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  /** Session 047: a restart during the compaction let the next check send a second /compact. */
  it('keeps a claimed pause across a restart', () => {
    expect(new ContextCompactionCooldowns(file, vi.fn(), () => now).claim('s')).toBe(true)
    now += 2 * minutes
    const restarted = new ContextCompactionCooldowns(file, vi.fn(), () => now)
    expect(restarted.claim('s')).toBe(false)
    expect(restarted.read('s')).toEqual({ requestedAt: 1_000_000, expiresAt: 1_000_000 + 10 * minutes })
  })

  it('lets a pause end, and a manual request restart it', () => {
    const cooldowns = new ContextCompactionCooldowns(file, vi.fn(), () => now)
    cooldowns.note('s')
    now += 10 * minutes
    expect(cooldowns.read('s')).toBeNull()
    expect(cooldowns.claim('s')).toBe(true)
    cooldowns.note('s')
    expect(cooldowns.read('s')?.requestedAt).toBe(now)
  })

  it('starts empty from a damaged file and says so, and never stretches a pause past ten minutes', () => {
    const report = vi.fn()
    new ContextCompactionCooldowns(file, vi.fn(), () => now).note('s')
    writeFileSync(file, '{')
    expect(new ContextCompactionCooldowns(file, report, () => now).claim('s')).toBe(true)
    expect(report).toHaveBeenCalledWith(expect.stringContaining('unreadable'))
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, expiries: { s: now + 60 * minutes } }))
    expect(new ContextCompactionCooldowns(file, vi.fn(), () => now).read('s')?.expiresAt).toBe(now + 10 * minutes)
  })
})
