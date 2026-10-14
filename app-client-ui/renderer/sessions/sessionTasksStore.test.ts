import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { SessionInfo, SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionTaskListing } from '../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import type { SnapshotStoreState } from '../ipc/snapshotStore'
import { SessionsFixtures } from './fixtures/sessionsFixtures'
import { SessionTasksStore } from './sessionTasksStore'

type Reply = IpcResult<RemoteControlStepResult<Record<string, SessionTaskListing>>>

describe('app-client-ui/renderer/sessions/sessionTasksStore', () => {
  const base = SessionsFixtures.mixed().sessions.find((info) => info.sessionId === 's-working')!
  const empty: SessionTaskListing = { kind: 'tasks', rows: [], olderFinished: 0, catchingUp: false }

  function session(sessionId: string, fields: Partial<SessionInfo> = {}): SessionInfo {
    return { ...base, sessionId, ...fields }
  }

  function listings(listing: SessionTaskListing): (sessionIds: readonly string[]) => Reply {
    return (sessionIds) => ({
      ok: true,
      value: { ok: true, value: Object.fromEntries(sessionIds.map((sessionId) => [sessionId, listing])) },
    })
  }

  class Harness {
    readonly calls: string[][] = []
    readonly errors: string[] = []
    reply: (sessionIds: readonly string[]) => Reply = listings(empty)
    private state: SnapshotStoreState<SessionsSnapshot>
    private readonly listeners = new Set<() => void>()
    readonly store: SessionTasksStore

    constructor(sessions: SessionInfo[]) {
      this.state = { snapshot: { ...SessionsFixtures.mixed(), sessions }, error: null }
      this.store = new SessionTasksStore(
        { current: () => this.state, subscribe: (onChanged) => {
          this.listeners.add(onChanged)
          return () => this.listeners.delete(onChanged)
        } },
        {
          list: (sessionIds) => {
            this.calls.push([...sessionIds])
            return Promise.resolve(this.reply(sessionIds))
          },
          reportError: (message) => this.errors.push(message),
        },
      )
    }

    publish(sessions: SessionInfo[]): void {
      this.state = { snapshot: { ...this.state.snapshot!, revision: this.state.snapshot!.revision + 1, sessions }, error: null }
      for (const listener of this.listeners) listener()
    }

    drawAll(): void {
      this.store.setDrawn(new Set(this.state.snapshot!.sessions.map((info) => info.sessionId)))
    }

    asked(sessionId: string): number {
      return this.calls.filter((call) => call.includes(sessionId)).length
    }
  }

  let stop: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
  })

  /** Every session of the snapshot drawn, unless a test draws fewer itself. */
  async function started(harness: Harness, drawAll = true): Promise<Harness> {
    if (drawAll) harness.drawAll()
    stop = harness.store.start()
    await vi.advanceTimersByTimeAsync(0)
    return harness
  }

  it('asks a working session every 3 s and an idle live one every 15 s', async () => {
    const harness = await started(new Harness([
      session('working', { activity: 'working' }),
      session('idle', { activity: 'idle' }),
    ]))
    expect(harness.calls).toEqual([['working', 'idle']])

    await vi.advanceTimersByTimeAsync(3_000)
    expect(harness.calls.at(-1)).toEqual(['working'])
    await vi.advanceTimersByTimeAsync(12_000)

    expect(harness.asked('working')).toBe(6)
    expect(harness.asked('idle')).toBe(2)
  })

  it('asks an ended session again every 3 s while it is catching up, and stops once it caught up', async () => {
    const harness = new Harness([session('ended', { life: 'ended', activity: 'unknown', endedAt: 100 })])
    harness.reply = listings({ kind: 'tasks', rows: [], olderFinished: 0, catchingUp: true })
    await started(harness)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(harness.asked('ended')).toBe(2)

    harness.reply = listings(empty)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(harness.asked('ended')).toBe(3)
  })

  it('asks an idle session fast while it is catching up', async () => {
    const harness = new Harness([session('idle', { activity: 'idle' })])
    harness.reply = listings({ kind: 'tasks', rows: [], olderFinished: 0, catchingUp: true })
    await started(harness)

    await vi.advanceTimersByTimeAsync(9_000)

    expect(harness.asked('idle')).toBe(4)
  })

  it('asks an ended session once, and again only when its end moves', async () => {
    const ended = session('ended', { life: 'ended', activity: 'unknown', endedAt: 100 })
    const harness = await started(new Harness([ended]))

    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.asked('ended')).toBe(1)

    harness.publish([{ ...ended, title: 'Renamed' }])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(harness.asked('ended')).toBe(1)

    harness.publish([{ ...ended, endedAt: 200 }])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.asked('ended')).toBe(2)
  })

  it('asks a live session once more when it ends', async () => {
    const live = session('live', { activity: 'idle' })
    const harness = await started(new Harness([live]))

    harness.publish([{ ...live, life: 'ended', activity: 'unknown', endedAt: 300 }])
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(harness.asked('live')).toBe(2)
  })

  it('never asks a shell session or an agent without a native id', async () => {
    const harness = await started(new Harness([
      session('working', { activity: 'working' }),
      session('shell', { kind: 'shell', agent: undefined, activity: 'working' }),
      session('pending', { agent: { agentId: 'claude' }, activity: 'working' }),
    ]))

    await vi.advanceTimersByTimeAsync(30_000)

    expect(harness.asked('working')).toBeGreaterThan(5)
    expect(harness.asked('shell')).toBe(0)
    expect(harness.asked('pending')).toBe(0)
  })

  it('never asks a session the tree does not draw, and asks an ended one once when it is drawn', async () => {
    const harness = new Harness([
      session('shown', { activity: 'idle' }),
      session('hidden', { life: 'ended', activity: 'unknown', endedAt: 100 }),
    ])
    harness.store.setDrawn(new Set(['shown']))
    await started(harness, false)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.asked('shown')).toBeGreaterThan(0)
    expect(harness.asked('hidden')).toBe(0)

    harness.store.setDrawn(new Set(['shown', 'hidden']))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.asked('hidden')).toBe(1)

    harness.store.setDrawn(new Set(['shown']))
    harness.store.setDrawn(new Set(['shown', 'hidden']))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.asked('hidden')).toBe(1)
  })

  it('asks nothing while the window is hidden, and at once when it comes back', async () => {
    const harness = await started(new Harness([session('working', { activity: 'working' })]))
    harness.store.setWindowVisible(false)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(harness.calls).toHaveLength(1)

    harness.store.setWindowVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.calls).toHaveLength(2)
  })

  it('polls watched sessions outside the tree until the last watcher releases', async () => {
    const harness = await started(new Harness([session('watched', { activity: 'working' })]), false)
    const releaseFirst = harness.store.watch('watched')
    const releaseSecond = harness.store.watch('watched')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.calls).toEqual([['watched']])

    releaseFirst()
    releaseFirst()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(harness.asked('watched')).toBe(2)

    releaseSecond()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(harness.asked('watched')).toBe(2)
    expect(harness.store.current().has('watched')).toBe(true)
  })

  it('shares one poll between the tree and watchers and keeps the tree polling after release', async () => {
    const harness = await started(new Harness([session('shared', { activity: 'working' })]))
    const release = harness.store.watch('shared')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(harness.calls).toEqual([['shared'], ['shared']])
    release()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(harness.asked('shared')).toBe(3)

    const watchAgain = harness.store.watch('shared')
    harness.store.setDrawn(new Set())
    await vi.advanceTimersByTimeAsync(3_000)
    expect(harness.asked('shared')).toBe(4)
    watchAgain()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(harness.asked('shared')).toBe(4)
  })

  it('suspends watched sessions with the window and releases an in-flight watch without more polls', async () => {
    const harness = new Harness([session('watched', { activity: 'working' })])
    const release = harness.store.watch('watched')
    harness.store.setWindowVisible(false)
    await started(harness, false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(harness.calls).toEqual([])
    harness.store.setWindowVisible(true)
    release()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(harness.calls).toEqual([['watched']])
  })

  it('publishes a listing only when it changed, and keeps the map otherwise', async () => {
    const harness = await started(new Harness([session('working', { activity: 'working' })]))
    const onChanged = vi.fn()
    harness.store.subscribe(onChanged)
    const first = harness.store.current()
    expect(first.get('working')).toEqual(empty)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(onChanged).not.toHaveBeenCalled()
    expect(harness.store.current()).toBe(first)

    const moved: SessionTaskListing = { kind: 'tasks', rows: [], olderFinished: 4, catchingUp: false }
    harness.reply = listings(moved)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(harness.store.current().get('working')).toEqual(moved)
  })

  it('drops what it held for a session the snapshot no longer names', async () => {
    const harness = await started(new Harness([session('working', { activity: 'working' })]))
    expect(harness.store.current().has('working')).toBe(true)

    harness.publish([])

    expect(harness.store.current().has('working')).toBe(false)
  })

  it.each([
    ['a channel failure', (): Reply => ({ ok: false, error: 'the bridge is gone' }), 'Reading sub-agents: the bridge is gone'],
    ['a refusal', (): Reply => ({ ok: true, value: { ok: false, error: { code: 'operation-failed', detail: 'boom' } } }),
      'Reading sub-agents: operation-failed: boom'],
  ])('reports %s and waits the slow interval before the next call', async (_name, reply, report) => {
    const harness = new Harness([session('working', { activity: 'working' })])
    harness.reply = reply
    await started(harness)

    await vi.advanceTimersByTimeAsync(14_000)
    expect(harness.calls).toHaveLength(1)
    expect(harness.errors).toEqual([report])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.calls).toHaveLength(2)
  })

  it.each([
    ['invalid-request', 'Unknown operation: "sessionTasks.list"'],
    ['not-found', 'No operation "sessionTasks.list"'],
  ] as const)('stops asking silently when the controller answers %s for the operation', async (code, detail) => {
    const harness = new Harness([session('working', { activity: 'working' })])
    harness.reply = () => ({ ok: true, value: { ok: false, error: { code, detail } } })
    await started(harness)

    harness.store.setDrawn(new Set(['other']))
    harness.drawAll()
    harness.store.setWindowVisible(false)
    harness.store.setWindowVisible(true)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(harness.calls).toHaveLength(1)
    expect(harness.errors).toEqual([])
  })

  it('asks at most 64 sessions in one call', async () => {
    const sessions = Array.from({ length: 70 }, (_, index) => session(`s${index}`, { activity: 'idle' }))
    const harness = await started(new Harness(sessions))

    expect(harness.calls[0]).toHaveLength(64)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.calls[1]).toHaveLength(6)
  })
})
