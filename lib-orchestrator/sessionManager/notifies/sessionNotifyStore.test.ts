import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SessionNotifyStore } from './sessionNotifyStore'

describe('lib-orchestrator/sessionManager/notifies/sessionNotifyStore', () => {
  const created: string[] = []
  // Manual section ids: the four bot sections are gone since 2026-11-25.
  const spec = { sessionId: 'parent', text: 'wake', onGroups: ['review', 'hold', 'shipped'] }
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
    await store.observe('child', { life: 'gone', group: null, state: null }, it_.clock.now)
    await store.watch('child', spec)

    expect(store.list({})).toEqual([expect.objectContaining({ sessionId: 'child', target: 'parent', text: 'wake' })])
    expect(store.pending()).toHaveLength(1)
    expect(readdirSync(it_.directory)).toEqual(['child.json'])
  })

  it('records one end per live to gone transition, and none for a reopen', async () => {
    const it_ = harness()
    const store = it_.store()
    await store.watch('child', spec)

    expect(await store.observe('child', { life: 'gone', group: null, state: null }, 10)).toEqual(['ended'])
    expect(await store.observe('child', { life: 'gone', group: null, state: null }, 11)).toEqual([])
    expect(await store.observe('child', { life: 'live', group: null, state: null }, 12)).toEqual([])
    expect(store.watched()[0].endedAt).toBeNull()
    expect(await store.observe('child', { life: 'gone', group: null, state: null }, 13)).toEqual(['ended'])
    expect(store.watched()[0]).toMatchObject({ endedAt: 13, events: [{ cause: 'ended', at: 10 }, { cause: 'ended', at: 13 }] })
    expect(new Set(store.pending().map((event) => event.id)).size).toBe(2)
  })

  it('records a named group from birth and again on re-entry, ignoring other groups and unchanged observations', async () => {
    const it_ = harness()
    const store = it_.store()
    await store.watch('child', spec)

    expect(await store.observe('child', { life: 'live', group: 'review', state: null }, 10)).toEqual(['group:review'])
    expect(await store.observe('child', { life: 'live', group: 'review', state: null }, 11)).toEqual([])
    expect(await store.observe('child', { life: 'live', group: 'other', state: null }, 12)).toEqual([])
    expect(store.watched()[0].seenGroup).toBe('other')
    expect(await store.observe('child', { life: 'live', group: 'review', state: null }, 13)).toEqual(['group:review'])
    expect(await store.observe('child', { life: 'gone', group: 'shipped', state: null }, 14)).toEqual(['ended', 'group:shipped'])
    expect(store.list({ sessionId: 'child' })[0].events.map((event) => event.cause))
      .toEqual(['group:review', 'group:review', 'ended', 'group:shipped'])
    expect(store.list({ sessionId: 'missing' })).toEqual([])
  })

  it('reloads specs, seen values, pending events and delivery pace, and reads only once', async () => {
    const it_ = harness()
    const first = it_.store()
    await first.watch('child', spec)
    await first.observe('child', { life: 'live', group: 'review', state: null }, 10)
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
    expect(await later.observe('child', { life: 'live', group: 'review', state: null }, 12)).toEqual([])
  })

  it('keeps concurrent observations and attempts in one whole file, and never changes a settled event', async () => {
    const it_ = harness()
    const store = it_.store()
    await store.watch('child', spec)
    await store.observe('child', { life: 'live', group: 'review', state: null }, 10)
    const id = store.pending()[0].id
    await Promise.all([
      store.note([id], 'attempted', 11),
      store.observe('child', { life: 'gone', group: 'review', state: null }, 12),
      store.note([id], 'attempted', 13),
    ])
    await store.note([id], 'delivered', 14)
    await store.note([id, 'missing'], 'expired', 15)

    expect(store.watched()[0].events).toMatchObject([
      { cause: 'group:review', state: 'delivered', attempts: 2, settledAt: 14 },
      { cause: 'ended', state: 'pending', attempts: 0, settledAt: null },
    ])
    expect(JSON.parse(readFileSync(join(it_.directory, 'child.json'), 'utf8'))).toEqual(store.watched()[0])
  })

  it('sweeps only settled ended records 30 days after the last observed end, at load', async () => {
    const it_ = harness()
    const store = it_.store()
    for (const id of ['old', 'pending', 'live', 'reopened']) {
      await store.watch(id, spec)
      await store.observe(id, { life: 'gone', group: null, state: null }, it_.clock.now)
    }
    await store.note(store.pending().filter((event) => event.id !== store.watched().find((record) => record.sessionId === 'pending')!.events[0].id)
      .map((event) => event.id), 'delivered', it_.clock.now + 10)
    await store.observe('live', { life: 'live', group: null, state: null }, it_.clock.now + 20)
    await store.observe('reopened', { life: 'live', group: null, state: null }, it_.clock.now + 20)
    await store.observe('reopened', { life: 'gone', group: null, state: null }, it_.clock.now + dayConst)
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

    await expect(store.observe('child', { life: 'gone', group: null, state: null }, 10)).rejects.toThrow()
    expect(store.watched()[0]).toMatchObject({ seenLife: 'live', events: [] })
    rmSync(join(it_.directory, 'child.json'), { recursive: true })
    expect(await store.observe('child', { life: 'gone', group: null, state: null }, 11)).toEqual(['ended'])
    expect(store.pending()).toHaveLength(1)
  })

  describe('bot state entry', () => {
    const states = { sessionId: 'parent', text: 'wake', onGroups: [], onStates: ['waiting' as const] }
    const seen = (state: 'working' | 'waiting' | null) => ({ life: 'live' as const, group: null, state })

    it('wakes on entry into a subscribed state, never on a repeat, and again on re-entry', async () => {
      const it_ = harness()
      const store = it_.store()
      await store.watch('child', states)

      expect(await store.observe('child', seen('working'), 10)).toEqual([])
      expect(await store.observe('child', seen('waiting'), 11)).toEqual(['state:waiting'])
      expect(await store.observe('child', seen('waiting'), 12)).toEqual([])
      expect(await store.observe('child', seen('working'), 13)).toEqual([])
      expect(await store.observe('child', seen('waiting'), 14)).toEqual(['state:waiting'])
      expect(store.list({})[0]).toMatchObject({ onStates: ['waiting'],
        events: [{ cause: 'state:waiting', at: 11 }, { cause: 'state:waiting', at: 14 }] })
      expect(store.watched()[0].seenState).toBe('waiting')
      // A reload keeps the state events and the seen state.
      const later = it_.store()
      await later.load()
      expect(later.watched()).toEqual(store.watched())
      expect(await later.observe('child', seen('waiting'), 15)).toEqual([])
    })

    it('loads a record written before bot states as one with no state subscription', async () => {
      const it_ = harness()
      mkdirSync(it_.directory, { recursive: true })
      writeFileSync(join(it_.directory, 'child.json'), JSON.stringify({ sessionId: 'child', target: 'parent', text: 'wake',
        onGroups: ['review'], seenLife: 'live', seenGroup: 'review', endedAt: null, events: [] }))
      const store = it_.store()
      await store.load()
      expect(store.watched()[0]).toMatchObject({ onGroups: ['review'], onStates: [], seenGroup: 'review', seenState: null })
      expect(await store.observe('child', { life: 'live', group: 'review', state: 'waiting' }, 10)).toEqual([])
    })

    it('reads a stored state event and refuses a record whose state event names an unknown state', async () => {
      const it_ = harness()
      mkdirSync(it_.directory, { recursive: true })
      const record = (cause: string) => ({ sessionId: 'x', target: 'parent', text: 'wake', onGroups: [], onStates: ['blocked'],
        seenLife: 'live', seenGroup: null, seenState: 'blocked', endedAt: null,
        events: [{ id: 'e1', cause, at: 1, state: 'pending', attempts: 0, settledAt: null }] })
      writeFileSync(join(it_.directory, 'good.json'), JSON.stringify({ ...record('state:blocked'), sessionId: 'good' }))
      writeFileSync(join(it_.directory, 'bad.json'), JSON.stringify({ ...record('state:paused'), sessionId: 'bad' }))
      const store = it_.store()
      await store.load()
      expect(store.watched().map((one) => one.sessionId)).toEqual(['good'])
      expect(it_.reports).toHaveLength(1)
    })
  })
})
