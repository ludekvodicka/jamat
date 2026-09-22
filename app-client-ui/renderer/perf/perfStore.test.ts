import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IpcResult } from '../../shared/appClientUiIpc'
import type { PerfSample } from '../../shared/perfSample'
import { PerfStore } from './perfStore'

describe('app-client-ui/renderer/perf/perfStore', () => {
  const sampleConst: PerfSample = {
    mainLoopDelayP95Ms: 2,
    mainLoopDelayMaxMs: 6,
    hostCallMaxMs: 14,
    echoMaxMs: null,
    mainWorst: null,
  }
  let calls: number
  let answer: () => Promise<IpcResult<PerfSample>>
  let errors: string[]
  /** The store's own clock, so a test can stage a tick that ran late. */
  let clock: number
  let hidden: boolean

  beforeEach(() => {
    vi.useFakeTimers()
    // Fake timers move `Date.now`, and `performance.now` with it in this environment, so a store
    // that measures wall time measures exactly the time the test advanced.
    calls = 0
    errors = []
    clock = 0
    hidden = false
    answer = () => {
      calls += 1
      return Promise.resolve({ ok: true as const, value: sampleConst })
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function store(): PerfStore {
    return new PerfStore({
      sample: () => answer(),
      reportError: (message) => errors.push(message),
      now: () => clock,
      hidden: () => hidden,
    })
  }

  /** One probe tick, as late as the test says, with the timers moved the same distance. */
  async function tick(milliseconds: number): Promise<void> {
    clock += milliseconds
    await vi.advanceTimersByTimeAsync(50)
  }

  it('reads nothing until it has sampled, then holds the last reading', async () => {
    const perf = store()
    const stop = perf.start()
    expect(perf.current()).toBeNull()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toBe(1)
    expect(perf.current()).toMatchObject(sampleConst)
    stop()
  })

  it('tells its subscribers on every sample and stops when it is stopped', async () => {
    const perf = store()
    let changes = 0
    perf.subscribe(() => { changes += 1 })
    const stop = perf.start()

    await vi.advanceTimersByTimeAsync(3_000)
    expect(changes).toBe(3)

    stop()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(changes).toBe(3)
  })

  /**
   * The main process answers a window since the previous call. Two calls in flight would each be
   * handed part of one window, and the bar would draw whichever landed last - which is the half
   * that saw nothing.
   */
  it('never has two samples in flight', async () => {
    const settlers: ((answer: IpcResult<PerfSample>) => void)[] = []
    answer = () => {
      calls += 1
      return new Promise<IpcResult<PerfSample>>((resolve) => { settlers.push(resolve) })
    }
    const perf = store()
    const stop = perf.start()

    await vi.advanceTimersByTimeAsync(3_000)
    expect(calls).toBe(1)

    settlers[0]?.({ ok: true, value: sampleConst })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toBe(2)
    stop()
  })

  /**
   * Once per run of failures, not once a second: the sink is the console of every workspace window,
   * and a channel that breaks would fill it at 1 Hz over whatever else is being read there.
   */
  it('reports a refused sample once and keeps the last reading it had', async () => {
    const perf = store()
    const stop = perf.start()
    await vi.advanceTimersByTimeAsync(1_000)
    const kept = perf.current()

    answer = () => Promise.resolve({ ok: false as const, error: 'the main process is gone' })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(perf.current()).toBe(kept)
    expect(errors).toEqual(['The performance sample could not be read: the main process is gone'])

    // It says so again once it has broken again, rather than staying quiet for the rest of the run.
    answer = () => Promise.resolve({ ok: true as const, value: sampleConst })
    await vi.advanceTimersByTimeAsync(1_000)
    answer = () => Promise.resolve({ ok: false as const, error: 'and gone again' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(errors).toHaveLength(2)
    stop()
  })

  /** A loop blocked for a second is what this window can measure about itself and nothing else can. */
  it('reports the worst lateness of its own timer', async () => {
    const perf = store()
    const stop = perf.start()
    await tick(50)
    await tick(850)
    await tick(50)
    clock += 50
    await vi.advanceTimersByTimeAsync(1_000)

    expect(perf.current()?.rendererLagMs).toBe(800)
    stop()
  })

  /**
   * Chromium throttles a hidden window's timers to about a second, and to about a minute after five
   * of them. Recorded, that is a red `R 59950` for a window that is answering perfectly - the widget
   * that exists to find the fault, inventing one.
   */
  it('records nothing while nobody is looking, and drops the tick that comes back', async () => {
    const perf = store()
    const stop = perf.start()

    hidden = true
    await tick(60_000)
    await tick(60_000)
    hidden = false
    // The first tick back is the gap this window spent minimized, not lateness of its own.
    await tick(60_000)
    await tick(50)
    clock += 50
    await vi.advanceTimersByTimeAsync(1_000)

    expect(perf.current()?.rendererLagMs).toBe(0)
    stop()
  })

  /**
   * A main process that has stopped answering is the fault this widget exists to show. Freezing on
   * the last number while it happened would be the one thing worse than having no widget.
   */
  it('draws how long a call has been out when one does not come back', async () => {
    const perf = store()
    const stop = perf.start()
    clock += 1_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(perf.current()?.mainRoundTripMs).toBe(0)

    const settlers: ((answer: IpcResult<PerfSample>) => void)[] = []
    answer = () => new Promise<IpcResult<PerfSample>>((resolve) => { settlers.push(resolve) })
    clock += 1_000
    await vi.advanceTimersByTimeAsync(1_000)
    clock += 5_000
    await vi.advanceTimersByTimeAsync(1_000)

    expect(perf.current()?.mainRoundTripMs).toBe(5_000)
    settlers[0]?.({ ok: true, value: sampleConst })
    stop()
  })
})
