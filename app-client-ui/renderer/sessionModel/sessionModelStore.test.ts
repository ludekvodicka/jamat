import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  SessionModelInfo,
  SessionModelReading,
} from '../../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { type SessionModelPorts, SessionModelStore } from './sessionModelStore'
import type { ActiveAgentTerminal } from '../statusBar/useActiveAgentTerminal'

describe('app-client-ui/renderer/sessionModel/sessionModelStore', () => {
  class Ports implements SessionModelPorts {
    readonly reads: string[] = []
    readonly errors: string[] = []
    readonly answers = new Map<string, IpcResult<SessionModelReading>>()
    /** Set before a read to keep it in flight, so the single-flight rule can be looked at. */
    held: ((answer: IpcResult<SessionModelReading>) => void) | null = null
    holding = false

    read(sessionId: string): Promise<IpcResult<SessionModelReading>> {
      this.reads.push(sessionId)
      if (this.holding)
        return new Promise((resolve) => {
          this.held = resolve
        })
      return Promise.resolve(this.answers.get(sessionId)
        ?? { ok: true, value: { kind: 'none', reason: 'nothing has been written yet' } })
    }

    reportError(message: string): void {
      this.errors.push(message)
    }

    answer(sessionId: string, info: SessionModelInfo): void {
      this.answers.set(sessionId, { ok: true, value: { kind: 'ok', info } })
    }
  }

  function infoOf(contextTokens: number): SessionModelInfo {
    return {
      model: 'claude-sonnet-4-5-20260101',
      modelLabel: 'Sonnet 4.5',
      effortLevel: 'high',
      contextTokens,
      contextWindow: 1_000_000,
    }
  }

  function focusOf(sessionId: string): ActiveAgentTerminal {
    return { sessionId, agentId: 'claude', life: 'live' }
  }

  const stops: (() => void)[] = []

  function started(ports: Ports): SessionModelStore {
    const store = new SessionModelStore(ports)
    stops.push(store.start())
    return store
  }

  /** Every read is a promise chain, so the answers land on microtasks rather than on the clock. */
  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0)
  }

  beforeEach(() => vi.useFakeTimers())

  afterEach(() => {
    for (const stop of stops.splice(0)) stop()
    vi.useRealTimers()
  })

  it('asks nobody anything while no agent terminal is in front', async () => {
    const ports = new Ports()
    started(ports)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(ports.reads).toEqual([])
  })

  it('reads the session of the tab that just came forward, at once', async () => {
    const ports = new Ports()
    ports.answer('s-a', infoOf(90_000))
    const store = started(ports)

    store.setFocus(focusOf('s-a'))
    await settle()

    expect(ports.reads).toEqual(['s-a'])
    expect(store.current()).toMatchObject({ focus: focusOf('s-a'), info: infoOf(90_000) })
  })

  // V1's cadence, and the whole of it: 8 s while there is nothing to draw, 20 s once there is.
  // The cold cadence is for a session that has not answered YET, not for one that answered with
  // nothing to say. Behind a Codex session whose rollout cannot be resolved the second is permanent,
  // and every one of those asks walks the whole rollout store on the client's main thread.
  it('asks again after 8 s, and gives the fast cadence up after four silent answers', async () => {
    const ports = new Ports()
    const store = started(ports)
    store.setFocus(focusOf('s-a'))
    await settle()

    await vi.advanceTimersByTimeAsync(7_999)
    expect(ports.reads).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(ports.reads).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(8_000 * 2)
    expect(ports.reads).toHaveLength(4)

    await vi.advanceTimersByTimeAsync(8_000)
    expect(ports.reads).toHaveLength(4)

    await vi.advanceTimersByTimeAsync(12_000)
    expect(ports.reads).toHaveLength(5)
  })

  it('asks again after 20 s once the session has answered', async () => {
    const ports = new Ports()
    ports.answer('s-a', infoOf(90_000))
    const store = started(ports)
    store.setFocus(focusOf('s-a'))
    await settle()

    await vi.advanceTimersByTimeAsync(19_999)
    expect(ports.reads).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(ports.reads).toHaveLength(2)
  })

  // Every session ever focused used to leave an entry, and nothing removed one - not a session that
  // ended, not a tab that closed. Both library caches over the same data are capped at sixteen.
  it('remembers sixteen sessions and forgets the oldest beyond that', async () => {
    const ports = new Ports()
    const store = started(ports)
    for (let index = 0; index <= 16; index += 1) {
      ports.answer(`s-${index}`, infoOf(1_000 + index))
      store.setFocus(focusOf(`s-${index}`))
      await settle()
    }

    store.setFocus(focusOf('s-16'))
    expect(store.current()).toMatchObject({ focus: focusOf('s-16'), info: infoOf(1_016) })

    store.setFocus(focusOf('s-0'))
    expect(store.current()).toBeNull()
  })

  // The poll runs behind a bare `void tick()`, so an unknown reading would both escape as a rejected
  // promise and skip the re-arm: the widget would then freeze until another tab came forward.
  it('reports a reading it was never taught and keeps polling', async () => {
    const ports = new Ports()
    const store = started(ports)
    ports.answers.set('s-a', { ok: true, value: { kind: 'napping' } as unknown as SessionModelReading })

    store.setFocus(focusOf('s-a'))
    await settle()

    expect(ports.errors).toHaveLength(1)
    expect(ports.errors[0]).toContain('napping')
    await vi.advanceTimersByTimeAsync(8_000)
    expect(ports.reads).toHaveLength(2)
  })

  it('tells its subscribers when a reading arrives, and only then', async () => {
    const ports = new Ports()
    const store = started(ports)
    let changes = 0
    store.subscribe(() => {
      changes += 1
    })

    store.setFocus(focusOf('s-a'))
    await settle()
    expect(changes).toBe(0)

    ports.answer('s-a', infoOf(90_000))
    await vi.advanceTimersByTimeAsync(8_000)

    expect(changes).toBe(1)
  })

  /**
   * A `none` is not an erasure. A live session that has answered once and then falls silent, and an
   * ended one that will never answer again, look identical from here - and the last reading that WAS
   * true stays the truest thing this window knows about either.
   */
  it('keeps the last reading when the session stops answering', async () => {
    const ports = new Ports()
    ports.answer('s-a', infoOf(90_000))
    const store = started(ports)
    store.setFocus(focusOf('s-a'))
    await settle()
    ports.answers.delete('s-a')

    await vi.advanceTimersByTimeAsync(20_000)

    expect(ports.reads).toHaveLength(2)
    expect(store.current()?.info).toEqual(infoOf(90_000))
  })

  it('reports a read the channel never carried and keeps what it had', async () => {
    const ports = new Ports()
    ports.answer('s-a', infoOf(90_000))
    const store = started(ports)
    store.setFocus(focusOf('s-a'))
    await settle()
    ports.answers.set('s-a', { ok: false, error: 'main process is gone' })

    await vi.advanceTimersByTimeAsync(20_000)

    expect(ports.errors).toEqual([
      'The session model could not be read: main process is gone',
    ])
    expect(store.current()?.info).toEqual(infoOf(90_000))
  })

  /** The whole point of the map: a tab that has been looked at before draws before anything is read. */
  it('draws a session it has read before the moment its tab comes back', async () => {
    const ports = new Ports()
    ports.answer('s-a', infoOf(90_000))
    ports.answer('s-b', infoOf(300_000))
    const store = started(ports)
    store.setFocus(focusOf('s-a'))
    await settle()
    store.setFocus(focusOf('s-b'))
    await settle()

    store.setFocus(focusOf('s-a'))

    expect(store.current()?.info).toEqual(infoOf(90_000))
    expect(ports.reads).toEqual(['s-a', 's-b', 's-a'])
  })

  it('holds its timer down when the tab in front stops being a terminal', async () => {
    const ports = new Ports()
    const store = started(ports)
    store.setFocus(focusOf('s-a'))
    await settle()

    store.setFocus(null)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(ports.reads).toEqual(['s-a'])
    expect(store.current()).toBeNull()
  })

  it('runs one read at a time and reads the new tab as soon as the old one answers', async () => {
    const ports = new Ports()
    const store = started(ports)
    ports.holding = true
    store.setFocus(focusOf('s-a'))
    await settle()

    store.setFocus(focusOf('s-b'))
    expect(ports.reads).toEqual(['s-a'])

    ports.holding = false
    ports.answer('s-b', infoOf(300_000))
    ports.held?.({ ok: true, value: { kind: 'ok', info: infoOf(90_000) } })
    await settle()

    expect(ports.reads).toEqual(['s-a', 's-b'])
    expect(store.current()?.info).toEqual(infoOf(300_000))
  })

  it('stops reading when the document that armed it goes away', async () => {
    const ports = new Ports()
    const store = started(ports)
    store.setFocus(focusOf('s-a'))
    await settle()

    for (const stop of stops.splice(0)) stop()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(ports.reads).toEqual(['s-a'])
  })

  /*
   * "No agent terminal in front" and "this window is out of sight" are different questions, and this
   * poll asked only the first: the sessions poll and the rate monitor both stop entirely when no
   * window is visible, and a holder minimised for the afternoon went on asking every twenty seconds.
   */
  /*
   * A reading is kept when a later read answers nothing, and its AGE has to date from the read that
   * was true - not from the poll that found nothing. Re-dated on every tick, a session that stopped
   * answering hours ago would go on looking freshly read.
   */
  it('dates a kept reading from the read that was true', async () => {
    const ports = new Ports()
    ports.answer('s-a', infoOf(90_000))
    const store = started(ports)
    store.setFocus(focusOf('s-a'))
    await settle()
    const first = store.current()?.readAt
    expect(first).toBeGreaterThan(0)

    // The session stops answering, and two polls go by.
    ports.answers.delete('s-a')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(ports.reads.length).toBeGreaterThan(1)
    expect(store.current()?.readAt).toBe(first)
  })

  it('exposes the cached reading by session for a second renderer consumer', async () => {
    const ports = new Ports()
    ports.answer('s-a', infoOf(90_000))
    const store = started(ports)
    store.setFocus(focusOf('s-a'))
    await settle()

    expect(store.readingFor('s-a')).toMatchObject({ info: infoOf(90_000) })
    expect(store.readingFor('s-never-read')).toBeNull()
  })

  it('coalesces fresh asks for one background session and puts the result in the same cache', async () => {
    const ports = new Ports()
    ports.holding = true
    const store = started(ports)

    const first = store.readNow('s-background')
    const second = store.readNow('s-background')
    expect(ports.reads).toEqual(['s-background'])

    ports.holding = false
    ports.held?.({ ok: true, value: { kind: 'ok', info: infoOf(850_000) } })
    await settle()

    await expect(first).resolves.toEqual(infoOf(850_000))
    await expect(second).resolves.toEqual(infoOf(850_000))
    expect(store.readingFor('s-background')?.info).toEqual(infoOf(850_000))
  })

  describe('while the window is out of sight', () => {
    it('does not read for a tab that comes forward while it is hidden', async () => {
      const ports = new Ports()
      ports.answer('s-a', infoOf(90_000))
      const store = started(ports)
      store.setWindowVisible(false)

      store.setFocus(focusOf('s-a'))
      await settle()

      // `setFocus` reads at once while the window is on screen; hidden, it reads nothing at all.
      expect(ports.reads).toEqual([])
    })

    it('does not re-arm behind a read that was already out when it went hidden', async () => {
      const ports = new Ports()
      const store = started(ports)
      ports.holding = true
      store.setFocus(focusOf('s-a'))
      await settle()
      expect(ports.reads.length).toBe(1)

      store.setWindowVisible(false)
      ports.holding = false
      ports.held?.({ ok: true, value: { kind: 'ok', info: infoOf(90_000) } })
      await settle()

      // That read lands and would arm the next tick. A hidden window holds no timer at all: the
      // reads are the visible cost, and the timer is the one that outlives being looked at.
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(ports.reads.length).toBe(1)
    })

    it('stops asking, and asks at once when it comes back', async () => {
      const ports = new Ports()
      ports.answer('s-a', infoOf(90_000))
      const store = started(ports)
      store.setFocus(focusOf('s-a'))
      await settle()
      const asked = ports.reads.length
      expect(asked).toBeGreaterThan(0)

      store.setWindowVisible(false)
      await vi.advanceTimersByTimeAsync(5 * 60_000)

      expect(ports.reads.length).toBe(asked)

      store.setWindowVisible(true)
      await settle()

      // Immediately, not after a whole interval of drawing nothing new.
      expect(ports.reads.length).toBe(asked + 1)
    })

    it('does nothing when told what it already knows', async () => {
      const ports = new Ports()
      ports.answer('s-a', infoOf(90_000))
      const store = started(ports)
      store.setFocus(focusOf('s-a'))
      await settle()
      const asked = ports.reads.length

      store.setWindowVisible(true)
      await settle()

      expect(ports.reads.length).toBe(asked)
    })
  })
})
