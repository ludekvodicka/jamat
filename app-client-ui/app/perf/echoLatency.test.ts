import { describe, expect, it } from 'vitest'

import { EchoLatency } from './echoLatency'

describe('app-client-ui/app/perf/echoLatency', () => {
  function at(): { echo: EchoLatency; tick: (milliseconds: number) => void } {
    let now = 1_000
    return {
      echo: new EchoLatency(() => now),
      tick: (milliseconds) => { now += milliseconds },
    }
  }

  it('measures the wait from a keystroke to the first byte back', () => {
    const { echo, tick } = at()
    echo.typed('attach-1')
    tick(120)
    echo.answered('attach-1')

    expect(echo.sample()).toBe(120)
    // The window starts again at the read: a wait is reported once.
    expect(echo.sample()).toBeNull()
  })

  // Typing is a burst and the answer comes once. Timing each key would report the last one's wait,
  // which is the shortest, and call the whole stall fast.
  it('keeps the first unanswered keystroke and not the last', () => {
    const { echo, tick } = at()
    echo.typed('attach-1')
    tick(50)
    echo.typed('attach-1')
    tick(50)
    echo.answered('attach-1')

    expect(echo.sample()).toBe(100)
  })

  it('keeps the worst of several attaches in one window', () => {
    const { echo, tick } = at()
    echo.typed('attach-1')
    echo.typed('attach-2')
    tick(30)
    echo.answered('attach-2')
    tick(400)
    echo.answered('attach-1')

    expect(echo.sample()).toBe(430)
  })

  /**
   * Past the ceiling nothing is being waited for any more: an agent reading a file for ten minutes
   * would otherwise leave one enormous number on the bar long after it stopped being true.
   */
  it('drops an answer that took longer than anybody was waiting', () => {
    const { echo, tick } = at()
    echo.typed('attach-1')
    tick(120_000)
    echo.answered('attach-1')

    expect(echo.sample()).toBeNull()
  })

  it('forgets a keystroke typed into an attach that has gone', () => {
    const { echo, tick } = at()
    echo.typed('attach-1')
    echo.forget('attach-1')
    tick(80)
    echo.answered('attach-1')

    expect(echo.sample()).toBeNull()
  })
})
