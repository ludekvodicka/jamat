import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import type { AttemptRecord } from './snapinContract'
import { SnapinStore } from './snapinStore'

describe('SnapinStore', () => {
  let directory: string
  const now = 30 * 86_400_000
  const report = vi.fn()
  const store = () => new SnapinStore(directory, 'test', { now: () => now, report })
  const ended = (at: number): AttemptRecord => ({ attemptId: randomUUID(), itemKey: randomUUID(), title: 'Todo',
    mode: 'wc', projectDirectory: directory, agentId: 'claude', phase: 'ended', createdAt: at,
    endedAt: at, endedReason: 'released', appliedThrough: 0, group: 'project', leaseHeld: false })

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'snapin-store-'))
    report.mockClear()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  })

  it('reads absence as empty and persists schema 1 on the first update', async () => {
    const source = store()
    expect(await source.read()).toEqual({ ok: true, document: {
      schemaVersion: 1, kind: 'test', paused: false, attempts: [], queue: [],
    } })
    expect(await source.update((doc) => ({ ...doc, paused: true }))).toBe(true)
    expect(await store().read()).toEqual({ ok: true, document: { ...source.current, paused: true } })
  })

  it.each(['{', JSON.stringify({ schemaVersion: 2 }), JSON.stringify({ schemaVersion: 1, kind: 'test' })])(
    'latches invalid state without replacing it: %s', async (raw) => {
      await writeFile(join(directory, 'state.json'), raw)
      const source = store()
      expect(await source.read()).toHaveProperty('latched')
      expect(await source.update((doc) => doc)).toBe(false)
      expect(await readFile(join(directory, 'state.json'), 'utf8')).toBe(raw)
    },
  )

  it('latches an existing path that cannot be read as a file', async () => {
    await mkdir(join(directory, 'state.json'))
    const source = store()
    expect(await source.read()).toHaveProperty('latched')
    expect(await source.update((doc) => doc)).toBe(false)
  })

  it('drops unknown top-level fields on write', async () => {
    await writeFile(join(directory, 'state.json'), JSON.stringify({
      schemaVersion: 1, kind: 'test', paused: false, queue: [], attempts: [], future: 'ignored',
    }))
    expect(await store().update((doc) => doc)).toBe(true)
    expect(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))).not.toHaveProperty('future')
  })

  it('preserves disk and memory when a write fails before rename', async () => {
    const source = store()
    await source.update((doc) => doc)
    const before = await readFile(join(directory, 'state.json'), 'utf8')
    vi.spyOn(AtomicJsonFile, 'writeAsync').mockImplementationOnce(async (file, value) => {
      await writeFile(`${file}.interrupted.tmp`, JSON.stringify(value))
      throw new Error('rename interrupted')
    })
    expect(await source.update((doc) => ({ ...doc, paused: true }))).toBe(false)
    expect(source.current.paused).toBe(false)
    expect(await readFile(join(directory, 'state.json'), 'utf8')).toBe(before)
    expect((await store().read())).toEqual({ ok: true, document: source.current })
  })

  it('keeps recent and lease-held attempts and removes old passes after persistence', async () => {
    const old = ended(1)
    const held = { ...ended(2), leaseHeld: true }
    const recent = ended(now)
    await mkdir(join(directory, 'passes', old.attemptId), { recursive: true })
    await writeFile(join(directory, 'passes', old.attemptId, 'brief.json'), '{}')
    const source = store()
    expect(await source.update((doc) => ({ ...doc, attempts: [old, held,
      ...Array.from({ length: 200 }, (_, i) => ended(100 + i)), recent] }))).toBe(true)
    expect(source.current.attempts.map((a) => a.attemptId)).not.toContain(old.attemptId)
    expect(source.current.attempts.map((a) => a.attemptId)).toContain(held.attemptId)
    expect(source.current.attempts.map((a) => a.attemptId)).toContain(recent.attemptId)
    await expect(readFile(join(directory, 'passes', old.attemptId, 'brief.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes changes over the latest committed document and does not leak mutable state', async () => {
    const source = store()
    await Promise.all(Array.from({ length: 20 }, (_, i) => source.update((doc) => ({
      ...doc, queue: [...doc.queue, { itemKey: `${i}`, addedAt: i }],
    }))))
    expect(source.current.queue).toHaveLength(20)
    source.current.queue.splice(0)
    expect(source.current.queue).toHaveLength(20)
  })

  it('does not follow an expired pass junction into a retained pass', async () => {
    const old = ended(1)
    const kept = ended(now)
    const target = join(directory, 'passes', kept.attemptId)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'brief.json'), 'retained')
    await symlink(target, join(directory, 'passes', old.attemptId), 'junction')
    expect(await store().update((doc) => ({ ...doc, attempts: [old, kept,
      ...Array.from({ length: 200 }, (_, i) => ended(100 + i))] }))).toBe(true)
    expect(await readFile(join(target, 'brief.json'), 'utf8')).toBe('retained')
    expect(report).toHaveBeenCalledWith(expect.stringContaining('redirects'))
  })

  it('does not remove through a redirected passes root', async () => {
    const old = ended(1)
    const outside = join(directory, 'other')
    await mkdir(join(outside, old.attemptId), { recursive: true })
    await writeFile(join(outside, old.attemptId, 'brief.json'), 'keep')
    await symlink(outside, join(directory, 'passes'), 'junction')
    expect(await store().update((doc) => ({ ...doc, attempts: [old,
      ...Array.from({ length: 200 }, (_, i) => ended(100 + i))] }))).toBe(true)
    expect(await readFile(join(outside, old.attemptId, 'brief.json'), 'utf8')).toBe('keep')
    expect(report).toHaveBeenCalledWith(expect.stringContaining('Passes directory redirects'))
  })

  it('retains a transferred lease predecessor and unfinished terminal effects beyond the retention window', async () => {
    const predecessor = ended(1)
    const pending = { ...ended(now), phase: 'pending' as const, leaseHeld: true, leaseFrom: predecessor.attemptId }
    const results = { ...ended(2), phase: 'completed' as const, mode: 'wt' as const, resultsSettled: false, presentedPhase: 'completed' as const }
    const presentation = { ...ended(3), phase: 'completed' as const, mode: 'wt' as const, resultsSettled: true, presentationRetryAt: now }
    const unpresented = { ...ended(4), phase: 'completed' as const, resultsSettled: true }
    const source = store()
    expect(await source.update((doc) => ({ ...doc, attempts: [predecessor, results, presentation, unpresented,
      ...Array.from({ length: 200 }, (_, i) => ended(100 + i)), pending] }))).toBe(true)
    expect(source.current.attempts.map((a) => a.attemptId)).toEqual(expect.arrayContaining([
      predecessor.attemptId, results.attemptId, presentation.attemptId, unpresented.attemptId, pending.attemptId,
    ]))
  })

  it('latches duplicate identities and duplicate lease holders', async () => {
    const a = { ...ended(1), leaseHeld: true }
    const b = { ...a, attemptId: randomUUID() }
    await writeFile(join(directory, 'state.json'), JSON.stringify({
      schemaVersion: 1, kind: 'test', paused: false, queue: [], attempts: [a, b],
    }))
    expect(await store().read()).toHaveProperty('latched')
  })
})
