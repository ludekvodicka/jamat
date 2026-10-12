import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SessionNotifyStore } from './sessionNotifyStore'

describe('lib-orchestrator/sessionManager/notifies/sessionNotifyStore', () => {
  const created: string[] = []
  const spec = { sessionId: 'parent', text: 'wake', onGroups: ['waiting', 'blocked', 'completed'] }
  const dayConst = 86_400_000

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function harness() {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-session-notifies-'))
    created.push(root)
    const directory = join(root, 'notifies')
    const clock = { now: dayConst }
    const reports: string[] = []
    return {
      directory, clock, reports,
      store: () => new SessionNotifyStore(directory, { now: () => clock.now, report: (message) => { reports.push(message) } }),
    }
  }

  it('watches once, also when repeated concurrently, preserving the first spec and pending events', async () => {
    const it_ = harness()
    const store = it_.store()
    await Promise.all([store.watch('child', spec), store.watch('child', { ...spec, text: 'another line' })])
    await store.observe('child', { life: 'gone', group: null }, it_.clock.now)
    await store.watch('child', spec)

    expect(store.list({})).toEqual([expect.objectContaining({ sessionId: 'child', target: 'parent', text: 'wake' })])
    expect(store.pending()).toHaveLength(1)
    expect(readdirSync(it_.directory)).toEqual(['child.json'])
  })

  it('records one end per live to gone transition, and none for a reopen', async () => {
    const it_ = harness()
    const store = it_.store()
    await store.watch('child', spec)

    expect(await store.observe('child', { life: 'gone', group: null }, 10)).toEqual(['ended'])
    expect(await store.observe('child', { life: 'gone', group: null }, 11)).toEqual([])
    expect(await store.observe('child', { life: 'live', group: null }, 12)).toEqual([])
    expect(store.watched()[0].endedAt).toBeNull()
    expect(await store.observe('child', { life: 'gone', group: null }, 13)).toEqual(['ended'])
    expect(store.watched()[0]).toMatchObject({ endedAt: 13, events: [{ cause: 'ended', at: 10 }, { cause: 'ended', at: 13 }] })
    expect(new Set(store.pending().map((event) => event.id)).size).toBe(2)
  })

  it('records a named group from birth and again on re-entry, ignoring other groups and unchanged observations', async () => {
    const it_ = harness()
    const store = it_.store()
    await store.watch('child', spec)

    expect(await store.observe('child', { life: 'live', group: 'waiting' }, 10)).toEqual(['group:waiting'])
    expect(await store.observe('child', { life: 'live', group: 'waiting' }, 11)).toEqual([])
    expect(await store.observe('child', { life: 'live', group: 'automation' }, 12)).toEqual([])
    expect(store.watched()[0].seenGroup).toBe('automation')
    expect(await store.observe('child', { life: 'live', group: 'waiting' }, 13)).toEqual(['group:waiting'])
    expect(await store.observe('child', { life: 'gone', group: 'completed' }, 14)).toEqual(['ended', 'group:completed'])
    expect(store.list({ sessionId: 'child' })[0].events.map((event) => event.cause))
      .toEqual(['group:waiting', 'group:waiting', 'ended', 'group:completed'])
    expect(store.list({ sessionId: 'missing' })).toEqual([])
  })

  it('reloads specs, seen values, pending events and delivery pace, and reads only once', async () => {
    const it_ = harness()
    const first = it_.store()
    await first.watch('child', spec)
    await first.observe('child', { life: 'live', group: 'waiting' }, 10)
    await first.note(first.pending().map((event) => event.id), 'attempted', 11)
    const later = it_.store()
    const loading = later.load()
    expect(later.load()).toBe(loading)
    await loading

    expect(later.watched()).toEqual(first.watched())
    expect(later.pending()).toEqual(first.pending())
    expect(later.pending()[0].attempts).toBe(1)
    writeFileSync(join(it_.directory, 'child.json'), '{}')
    await later.load()
    expect(later.watched()).toEqual(first.watched())
    expect(await later.observe('child', { life: 'live', group: 'waiting' }, 12)).toEqual([])
  })

  it('keeps concurrent observations and attempts in one whole file, and never changes a settled event', async () => {
    const it_ = harness()
    const store = it_.store()
    await store.watch('child', spec)
    await store.observe('child', { life: 'live', group: 'waiting' }, 10)
    const id = store.pending()[0].id
    await Promise.all([
      store.note([id], 'attempted', 11),
      store.observe('child', { life: 'gone', group: 'waiting' }, 12),
      store.note([id], 'attempted', 13),
    ])
    await store.note([id], 'delivered', 14)
    await store.note([id, 'missing'], 'expired', 15)

    expect(store.watched()[0].events).toMatchObject([
      { cause: 'group:waiting', state: 'delivered', attempts: 2, settledAt: 14 },
      { cause: 'ended', state: 'pending', attempts: 0, settledAt: null },
    ])
    expect(JSON.parse(readFileSync(join(it_.directory, 'child.json'), 'utf8'))).toEqual(store.watched()[0])
  })

  it('sweeps only settled ended records 30 days after the last observed end, at load', async () => {
    const it_ = harness()
    const store = it_.store()
    for (const id of ['old', 'pending', 'live', 'reopened']) {
      await store.watch(id, spec)
      await store.observe(id, { life: 'gone', group: null }, it_.clock.now)
    }
    await store.note(store.pending().filter((event) => event.id !== store.watched().find((record) => record.sessionId === 'pending')!.events[0].id)
      .map((event) => event.id), 'delivered', it_.clock.now + 10)
    await store.observe('live', { life: 'live', group: null }, it_.clock.now + 20)
    await store.observe('reopened', { life: 'live', group: null }, it_.clock.now + 20)
    await store.observe('reopened', { life: 'gone', group: null }, it_.clock.now + dayConst)
    await store.note(store.watched().find((record) => record.sessionId === 'reopened')!.events.map((event) => event.id), 'expired', it_.clock.now + dayConst)

    it_.clock.now += SessionNotifyStore.keepMillisecondsConst - 1
    const before = it_.store()
    await before.load()
    expect(before.watched()).toHaveLength(4)
    it_.clock.now += 1
    const later = it_.store()
    await later.load()

    expect(later.watched().map((record) => record.sessionId).sort()).toEqual(['live', 'pending', 'reopened'])
    expect(existsSync(join(it_.directory, 'old.json'))).toBe(false)
    expect(it_.reports).toEqual([])
  })

  it('leaves malformed files alone and refuses a session id that escapes the store directory', async () => {
    const it_ = harness()
    mkdirSync(it_.directory)
    writeFileSync(join(it_.directory, 'broken.json'), '{')
    writeFileSync(join(it_.directory, 'bad.json'), JSON.stringify({ sessionId: 'other' }))
    const store = it_.store()
    await store.load()
    await expect(store.watch('../escape', spec)).rejects.toThrow('Not a plain id')

    expect(store.watched()).toEqual([])
    expect(it_.reports).toHaveLength(2)
    expect(readdirSync(it_.directory).sort()).toEqual(['bad.json', 'broken.json'])
  })

  it('keeps the last durable observation when a write fails and can retry it', async () => {
    const it_ = harness()
    const store = it_.store()
    await store.watch('child', spec)
    rmSync(join(it_.directory, 'child.json'))
    mkdirSync(join(it_.directory, 'child.json'))

    await expect(store.observe('child', { life: 'gone', group: null }, 10)).rejects.toThrow()
    expect(store.watched()[0]).toMatchObject({ seenLife: 'live', events: [] })
    rmSync(join(it_.directory, 'child.json'), { recursive: true })
    expect(await store.observe('child', { life: 'gone', group: null }, 11)).toEqual(['ended'])
    expect(store.pending()).toHaveLength(1)
  })
})
