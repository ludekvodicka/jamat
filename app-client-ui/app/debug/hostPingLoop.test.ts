import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HostPingResult } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { HostPingLoop } from './hostPingLoop'

describe('app-client-ui/app/debug/hostPingLoop', () => {
  interface Harness {
    loop: HostPingLoop
    pings: () => number
    published: HostPingResult[]
    /** Answers the ping that is out; until it is awaited the request is still in flight. */
    answer: () => Promise<void>
  }

  function harness(): Harness {
    let pings = 0
    let settle: (() => void) | null = null
    const published: HostPingResult[] = []
    const loop = new HostPingLoop({
      ping: async () => {
        pings += 1
        await new Promise<void>((resolve) => { settle = resolve })
        return { at: pings, ok: false, detail: 'host-unreachable: nothing there' }
      },
      publish: (result) => published.push(result),
    })
    return {
      loop,
      pings: () => pings,
      published,
      answer: async () => {
        const resolve = settle
        settle = null
        resolve?.()
        // Lets the loop publish and arm itself again before the clock moves on.
        await vi.advanceTimersByTimeAsync(0)
      },
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Half a gate is not a gate: a visible window on another section, or the host section in a window
  // nobody can see, both mean nobody is reading a latency.
  it('stands still until the window can be seen AND the host section is on it', async () => {
    const context = harness()

    context.loop.setWindowVisible(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(context.pings()).toBe(0)

    context.loop.setWindowVisible(false)
    context.loop.setActiveSection('host')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(context.pings()).toBe(0)

    context.loop.setWindowVisible(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(context.pings()).toBe(1)
  })

  it('keeps asking every five seconds and publishes what came back', async () => {
    const context = harness()
    context.loop.setWindowVisible(true)
    context.loop.setActiveSection('host')

    await vi.advanceTimersByTimeAsync(5_000)
    await context.answer()
    await vi.advanceTimersByTimeAsync(5_000)
    await context.answer()

    expect(context.pings()).toBe(2)
    expect(context.published.map((result) => result.at)).toEqual([1, 2])
  })

  // V1's freeze was requests stacking up behind a handler that could not keep up. A ping that has
  // not answered yet skips the next tick instead of joining it.
  it('never has two pings out at once', async () => {
    const context = harness()
    context.loop.setWindowVisible(true)
    context.loop.setActiveSection('host')

    await vi.advanceTimersByTimeAsync(5_000)
    expect(context.pings()).toBe(1)

    // The first ping is still out for the next three ticks.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(context.pings()).toBe(1)

    await context.answer()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(context.pings()).toBe(2)
  })

  it('stops on a closed gate, and asks nothing more after it', async () => {
    const context = harness()
    context.loop.setWindowVisible(true)
    context.loop.setActiveSection('host')
    await vi.advanceTimersByTimeAsync(5_000)
    await context.answer()
    expect(context.pings()).toBe(1)

    context.loop.setActiveSection(null)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(context.pings()).toBe(1)

    context.loop.setWindowVisible(false)
    context.loop.setActiveSection('host')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(context.pings()).toBe(1)
  })
})
