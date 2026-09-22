import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EchoLatency } from './echoLatency'
import { MainWorkLedger } from './mainWorkLedger'
import type { LoopDelaySampler } from './loopDelaySampler'
import { ServicePerfIpc } from './servicePerfIpc'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcMainMock.handlers.set(channel, handler)
    },
  },
}))

describe('app-client-ui/app/perf/servicePerfIpc', () => {
  let now = 1_000
  let loopSamples: { p95: number; max: number }[]
  let hostCalls: (number | null)[]
  let echo: EchoLatency
  let work: MainWorkLedger

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    now = 1_000
    loopSamples = [{ p95: 4, max: 90 }, { p95: 1, max: 2 }]
    hostCalls = [140, null]
    echo = new EchoLatency(() => now)
    work = new MainWorkLedger()
  })

  function service(): ServicePerfIpc {
    const loopDelay = {
      sample: () => loopSamples.shift() ?? { p95: 0, max: 0 },
    } as unknown as LoopDelaySampler
    return new ServicePerfIpc(loopDelay, echo, work, () => hostCalls.shift() ?? null, () => now)
  }

  async function sample(): Promise<unknown> {
    const handler = ipcMainMock.handlers.get('perf:sample')
    if (!handler) throw new Error('No handler for perf:sample')
    return handler({} as IpcMainInvokeEvent)
  }

  /**
   * Every number is a window since the previous call, so the channel is what closes each window: a
   * caller that asks once a second is asking for the worst of that second.
   */
  it('answers with the window each reading has collected and starts the next one', async () => {
    const perf = service()
    perf.initialize()
    echo.typed('attach-1')
    now += 220
    echo.answered('attach-1')
    // What held the loop, as the IPC funnel would have recorded it.
    work.note('sessions:snapshot', 140)
    work.note('tabs:list', 12)

    expect(await sample()).toEqual({
      ok: true,
      value: {
        mainLoopDelayP95Ms: 4,
        mainLoopDelayMaxMs: 90,
        hostCallMaxMs: 140,
        echoMaxMs: 220,
        mainWorst: { label: 'sessions:snapshot', milliseconds: 140 },
      },
    })

    // Nothing happened in the second window: a quiet Host and nobody typing say so with null rather
    // than with a zero somebody would read as "instant".
    now += 1_000
    expect(await sample()).toEqual({
      ok: true,
      value: {
        mainLoopDelayP95Ms: 1,
        mainLoopDelayMaxMs: 2,
        hostCallMaxMs: null,
        echoMaxMs: null,
        mainWorst: null,
      },
    })
  })

  /**
   * Two workspace windows draw the same bar over the same process. Read-and-reset per call would
   * hand each of them the half of the second the other had not taken, and both would draw a client
   * half as slow as it is.
   */
  it('answers a second window inside the same window with the same numbers', async () => {
    const perf = service()
    perf.initialize()

    const first = await sample()
    now += 100
    expect(await sample()).toEqual(first)

    now += 1_000
    expect(await sample()).not.toEqual(first)
  })

  it('registers a handler for every channel it declares', () => {
    service().initialize()
    expect([...ipcMainMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServicePerfIpc.channelsConst).sort())
  })
})
