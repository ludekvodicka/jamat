import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ScriptLogStore } from '../scripts/scriptLogStore'
import type { SessionInfo } from '../sessionManagerApi.types'
import { SessionNotifier } from './sessionNotifier'
import { SessionNotifyStore } from './sessionNotifyStore'
import { type WorktreeResultRecord, WorktreeResultsStore } from '../results/worktreeResultsStore'

describe('lib-orchestrator/sessionManager/notifies/sessionNotifier', () => {
  const minuteConst = 60_000
  const created: string[] = []

  afterEach(() => {
    vi.useRealTimers()
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  type Answer = 'delivered' | 'retry' | 'gone'

  function harness(): {
    store: WorktreeResultsStore
    notifier: SessionNotifier
    clock: { now: number }
    typed: { sessionId: string; text: string }[]
    answers: Answer[]
    put: (actionId: string, notify?: { sessionId: string; text: string }) => Promise<void>
    stateOf: (actionId: string) => WorktreeResultRecord['notify']
    notifies: SessionNotifyStore
    reloadNotifies: () => SessionNotifyStore
    snapshot: { sessions: SessionInfo[]; groups: Map<string, string | null> }
  } {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-worktree-notify-'))
    created.push(root)
    const clock = { now: 1_000 }
    const store = new WorktreeResultsStore(join(root, 'results'), {
      now: () => clock.now, logs: new ScriptLogStore(join(root, 'logs')), report: () => undefined,
    })
    const typed: { sessionId: string; text: string }[] = []
    const answers: Answer[] = []
    const reloadNotifies = () => new SessionNotifyStore(join(root, 'notifies'), { now: () => clock.now, report: () => undefined })
    const notifies = reloadNotifies()
    const snapshot = { sessions: [] as SessionInfo[], groups: new Map<string, string | null>() }
    const notifier = new SessionNotifier({
      sources: [store.notifySource(), notifies],
      watch: notifies,
      sessions: () => snapshot.sessions,
      groups: () => snapshot.groups,
      port: {
        deliver: async (sessionId, text) => {
          typed.push({ sessionId, text })
          return answers.shift() ?? 'delivered'
        },
      },
      now: () => clock.now,
      report: () => undefined,
    })
    return {
      store, notifier, clock, typed, answers, notifies, reloadNotifies, snapshot,
      put: async (actionId, notify = { sessionId: 'coordinator', text: 'wake' }) => {
        await store.put(WorktreeResultsStore.recordOf({
          actionId, action: 'finish', result: 'committed', sessionId: 'worker', title: 'worker', worktreePath: 'W', mainCopy: 'M',
          directoryId: null, removal: 'removed', revisions: [], lines: [], logs: [], at: clock.now, caller: { notify },
        }))
      },
      stateOf: (actionId) => store.list({}).find((record) => record.actionId === actionId)?.notify ?? null,
    }
  }

  it('types the line once into an empty composer and the result says delivered', async () => {
    const it_ = harness()
    await it_.put('a1')

    await it_.notifier.tick()
    await it_.notifier.tick()

    expect(it_.typed).toEqual([{ sessionId: 'coordinator', text: 'wake' }])
    expect(it_.stateOf('a1')).toMatchObject({ state: 'delivered', at: 1_000 })
  })

  it('types nothing over a draft and tries again at 1, 5, 15 and 30 minutes, then every 30', async () => {
    const it_ = harness()
    await it_.put('a1')
    it_.answers.push('retry', 'retry', 'retry', 'retry', 'retry')
    const tries: number[] = []
    for (let minute = 0; minute <= 60; minute += 1) {
      it_.clock.now = 1_000 + minute * minuteConst
      const before = it_.typed.length
      await it_.notifier.tick()
      if (it_.typed.length > before) tries.push(minute)
    }

    expect(tries).toEqual([0, 1, 5, 15, 30, 60])
    expect(it_.stateOf('a1')).toMatchObject({ state: 'delivered', attempts: 5 })
  })

  it('expires a line whose session does not run after 24 hours', async () => {
    const it_ = harness()
    await it_.put('a1')
    it_.answers.push(...Array.from({ length: 60 }, () => 'retry' as const))

    for (let hour = 0; hour <= 24; hour += 1) {
      it_.clock.now = 1_000 + hour * 60 * minuteConst
      await it_.notifier.tick()
    }
    it_.clock.now += 1
    await it_.notifier.tick()

    expect(it_.stateOf('a1')).toMatchObject({ state: 'expired', at: it_.clock.now })
    const typed = it_.typed.length
    await it_.notifier.tick()
    expect(it_.typed).toHaveLength(typed)
  })

  it('types one line for two results of the same coordinator and text, and both say delivered', async () => {
    const it_ = harness()
    await it_.put('a1')
    await it_.put('a2')
    await it_.put('a3', { sessionId: 'coordinator', text: 'another line' })

    await it_.notifier.tick()

    expect(it_.typed).toEqual([{ sessionId: 'coordinator', text: 'wake' }, { sessionId: 'coordinator', text: 'another line' }])
    expect(['a1', 'a2', 'a3'].map((actionId) => it_.stateOf(actionId)?.state)).toEqual(['delivered', 'delivered', 'delivered'])
  })

  it('expires the line at once when the target session no longer exists', async () => {
    const it_ = harness()
    await it_.put('a1')
    it_.answers.push('gone')

    await it_.notifier.tick()

    expect(it_.stateOf('a1')).toMatchObject({ state: 'expired', at: 1_000 })
  })

  it('counts a delivery that threw as refused, and a result without a line is never typed', async () => {
    const it_ = harness()
    await it_.store.put(WorktreeResultsStore.recordOf({
      actionId: 'quiet', action: 'discard', result: 'discarded', sessionId: 'worker', title: 'worker', worktreePath: 'W', mainCopy: 'M',
      directoryId: null, removal: 'removed', revisions: [], lines: [], logs: [], at: 1_000, caller: undefined,
    }))
    await it_.put('a1')
    const throwing = new SessionNotifier({
      sources: [it_.store.notifySource()],
      watch: { watched: () => [], observe: async () => undefined },
      sessions: () => [],
      groups: () => new Map(),
      port: { deliver: () => Promise.reject(new Error('socket closed')) },
      now: () => it_.clock.now,
      report: () => undefined,
    })

    await throwing.tick()

    expect(it_.stateOf('a1')).toMatchObject({ state: 'pending', attempts: 1 })
    expect(it_.stateOf('quiet')).toBeNull()
  })

  it('paces the tries from the result', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(SessionNotifier.offsetOf)).toEqual(
      [0, 1, 5, 15, 30, 60, 90].map((minutes) => minutes * minuteConst))
  })

  it('delivers a result and an end once, noting both sources even with the same item id', async () => {
    const it_ = harness()
    await it_.notifies.watch('child', { sessionId: 'coordinator', text: 'wake', onGroups: [] })
    await it_.notifies.observe('child', { life: 'gone', group: null }, it_.clock.now)
    const id = it_.notifies.pending()[0].id
    await it_.put(id)
    await it_.notifier.tick()
    await it_.notifier.tick()

    expect(it_.typed).toEqual([{ sessionId: 'coordinator', text: 'wake' }])
    expect(it_.stateOf(id)).toMatchObject({ state: 'delivered', at: 1_000 })
    expect(it_.notifies.list({})[0].events).toEqual([{ cause: 'ended', at: 1_000, state: 'delivered', attempts: 0, settledAt: 1_000 }])
  })

  it('delivers a newly observed end in the same pass together with a result', async () => {
    const it_ = harness()
    await it_.put('a1')
    await it_.notifies.watch('child', { sessionId: 'coordinator', text: 'wake', onGroups: [] })
    it_.snapshot.sessions = [{ sessionId: 'child', life: 'ended' } as SessionInfo]

    await it_.notifier.tick()

    expect(it_.typed).toEqual([{ sessionId: 'coordinator', text: 'wake' }])
    expect(it_.stateOf('a1')?.state).toBe('delivered')
    expect(it_.notifies.list({})[0].events[0]).toMatchObject({ cause: 'ended', state: 'delivered' })
  })

  it('keeps both sources pending over a draft on the same retry pace', async () => {
    const it_ = harness()
    await it_.put('a1')
    await it_.notifies.watch('child', { sessionId: 'coordinator', text: 'wake', onGroups: [] })
    it_.answers.push('retry', 'retry')
    await it_.notifier.tick()
    it_.clock.now += minuteConst - 1
    await it_.notifier.tick()
    expect(it_.typed).toHaveLength(1)
    expect(it_.stateOf('a1')).toMatchObject({ state: 'pending', attempts: 1 })
    expect(it_.notifies.pending()[0].attempts).toBe(1)
    it_.clock.now += 1
    await it_.notifier.tick()
    expect(it_.typed).toHaveLength(2)
    expect(it_.notifies.pending()[0].attempts).toBe(2)
    it_.clock.now = 1_000 + 5 * minuteConst
    await it_.notifier.tick()
    expect(it_.typed).toHaveLength(3)
    expect(it_.stateOf('a1')).toMatchObject({ state: 'delivered', attempts: 2 })
    expect(it_.notifies.list({})[0].events[0]).toMatchObject({ state: 'delivered', attempts: 2 })
  })

  it('delivers a group when any source item is due, keeping target and text separate', async () => {
    const it_ = harness()
    await it_.put('a1')
    it_.answers.push('retry')
    await it_.notifier.tick()
    it_.clock.now += 1
    await it_.notifies.watch('child', { sessionId: 'coordinator', text: 'wake', onGroups: [] })
    await it_.notifies.watch('other', { sessionId: 'other-parent', text: 'wake', onGroups: [] })
    await it_.notifies.watch('another-line', { sessionId: 'coordinator', text: 'another line', onGroups: [] })
    await it_.notifier.tick()

    expect(it_.typed.slice(1)).toEqual([
      { sessionId: 'coordinator', text: 'wake' }, { sessionId: 'other-parent', text: 'wake' },
      { sessionId: 'coordinator', text: 'another line' },
    ])
    expect(it_.stateOf('a1')).toMatchObject({ state: 'delivered', attempts: 1 })
    expect(it_.notifies.pending()).toEqual([])
  })

  it('expires old items in each source without expiring a fresh event with the same line', async () => {
    const it_ = harness()
    await it_.put('a1')
    await it_.notifies.watch('old', { sessionId: 'coordinator', text: 'wake', onGroups: [] })
    await it_.notifies.observe('old', { life: 'gone', group: null }, it_.clock.now)
    it_.clock.now += SessionNotifier.giveUpMillisecondsConst + 1
    await it_.notifies.watch('fresh', { sessionId: 'coordinator', text: 'wake', onGroups: [] })
    await it_.notifier.tick()

    expect(it_.typed).toEqual([{ sessionId: 'coordinator', text: 'wake' }])
    expect(it_.stateOf('a1')?.state).toBe('expired')
    expect(it_.notifies.list({ sessionId: 'old' })[0].events[0].state).toBe('expired')
    expect(it_.notifies.list({ sessionId: 'fresh' })[0].events[0].state).toBe('delivered')
  })

  it('expires both sources when their target is gone', async () => {
    const it_ = harness()
    await it_.put('a1')
    await it_.notifies.watch('child', { sessionId: 'coordinator', text: 'wake', onGroups: [] })
    it_.answers.push('gone')
    await it_.notifier.tick()

    expect(it_.typed).toHaveLength(1)
    expect(it_.stateOf('a1')?.state).toBe('expired')
    expect(it_.notifies.list({})[0].events[0]).toMatchObject({ state: 'expired', settledAt: 1_000 })
  })

  it.each(['ended', 'lost', 'missing'] as const)('observes an end after restart when the snapshot says %s', async (life) => {
    const it_ = harness()
    await it_.notifies.watch('child', { sessionId: 'coordinator', text: 'wake', onGroups: [] })
    const reloaded = it_.reloadNotifies()
    await reloaded.load()
    const notifier = new SessionNotifier({
      sources: [reloaded], watch: reloaded,
      sessions: () => life === 'missing' ? [] : [{ sessionId: 'child', life } as SessionInfo],
      groups: () => new Map(),
      port: { deliver: async (sessionId, text) => { it_.typed.push({ sessionId, text }); return 'delivered' } },
      now: () => it_.clock.now, report: () => undefined,
    })

    await notifier.tick()
    await notifier.tick()

    expect(it_.typed).toEqual([{ sessionId: 'coordinator', text: 'wake' }])
    expect(reloaded.list({})[0].events).toHaveLength(1)
    expect(reloaded.list({})[0].events[0]).toMatchObject({ cause: 'ended', state: 'delivered' })
  })

  it('reads the group map each pass, including a session born into a named group', async () => {
    const it_ = harness()
    await it_.notifies.watch('child', { sessionId: 'coordinator', text: 'wake', onGroups: ['waiting'] })
    it_.snapshot.sessions = [{ sessionId: 'child', life: 'starting' } as SessionInfo]
    it_.snapshot.groups.set('child', 'waiting')
    await it_.notifier.tick()
    await it_.notifier.tick()
    it_.snapshot.groups.set('child', 'automation')
    await it_.notifier.tick()
    it_.snapshot.groups.set('child', 'waiting')
    await it_.notifier.tick()

    expect(it_.typed).toHaveLength(2)
    expect(it_.notifies.list({})[0].events.map((event) => event.cause)).toEqual(['group:waiting', 'group:waiting'])
  })

  it('joins overlapping passes so observation and delivery each run once', async () => {
    const it_ = harness()
    await it_.notifies.watch('child', { sessionId: 'coordinator', text: 'wake', onGroups: [] })
    let finish!: (answer: 'delivered') => void
    const delivered = new Promise<'delivered'>((resolve) => { finish = resolve })
    let reached!: () => void
    const delivering = new Promise<void>((resolve) => { reached = resolve })
    const notifier = new SessionNotifier({
      sources: [it_.notifies], watch: it_.notifies, sessions: () => [], groups: () => new Map(),
      port: { deliver: async () => { reached(); return delivered } }, now: () => it_.clock.now, report: () => undefined,
    })
    const first = notifier.tick()
    await delivering
    expect(notifier.tick()).toBe(first)
    finish('delivered')
    await first
    expect(it_.notifies.list({})[0].events).toHaveLength(1)
    expect(it_.notifies.pending()).toEqual([])
  })

  it('starts one ten-second timer and stops scheduling when stopped', async () => {
    vi.useFakeTimers()
    const it_ = harness()
    const snapshot = vi.fn(() => [])
    const notifier = new SessionNotifier({
      sources: [], watch: it_.notifies, sessions: snapshot, groups: () => new Map(),
      port: { deliver: async () => 'delivered' }, now: () => it_.clock.now, report: () => undefined,
    })
    notifier.start()
    notifier.start()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(snapshot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(snapshot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(snapshot).toHaveBeenCalledTimes(2)
    notifier.stop()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
