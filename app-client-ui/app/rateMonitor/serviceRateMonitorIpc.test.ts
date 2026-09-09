import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RateMonitor } from '../../../lib-orchestrator/rateMonitor/rateMonitor'
import type {
  RateMonitorDebugStatus,
  RateMonitorSnapshot,
} from '../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import { ServiceRateMonitorIpc } from './serviceRateMonitorIpc'

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

describe('app-client-ui/app/rateMonitor/serviceRateMonitorIpc', () => {
  const snapshotConst: RateMonitorSnapshot = {
    revision: 4,
    providers: {
      claude: { kind: 'ok', fetchedAt: 1_000, windows: [
        { durationMinutes: 300, usedPercent: 42, resetsAt: null },
      ] },
      codex: { kind: 'unconfigured', reason: 'Codex is not installed' },
    },
  }
  const refreshedConst: RateMonitorSnapshot = {
    revision: 5,
    providers: {
      claude: { kind: 'ok', fetchedAt: 2_000, windows: [] },
      codex: { kind: 'unconfigured', reason: 'Codex is not installed' },
    },
  }
  const debugStatusConst: RateMonitorDebugStatus = {
    capturedAt: 3_000,
    poll: { windowVisible: true, cadenceMilliseconds: 600_000, claudeFloorMilliseconds: 180_000 },
    providers: {
      claude: {
        state: snapshotConst.providers.claude,
        lastAttemptAt: 2_000,
        lastSuccessAt: 1_000,
        lastReason: null,
        oauthExpiresAt: 9_999,
        extras: [{ label: 'extra usage', detail: '3 of 10 credits' }],
        raw: { five_hour: { utilization: 42 } },
      },
      codex: {
        state: snapshotConst.providers.codex,
        lastAttemptAt: 2_000,
        lastSuccessAt: null,
        lastReason: 'Codex is not installed',
        oauthExpiresAt: null,
        extras: [],
        raw: null,
      },
    },
  }
  let refreshes: number
  let service: ServiceRateMonitorIpc

  /** What the facade answers is fixed here; that it holds a floor and a revision is its own tests. */
  function monitorUnderTest(): RateMonitor {
    return {
      snapshot: () => snapshotConst,
      refresh: async () => {
        refreshes += 1
        return refreshedConst
      },
      debugStatus: () => debugStatusConst,
    } as unknown as RateMonitor
  }

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    refreshes = 0
    service = new ServiceRateMonitorIpc(monitorUnderTest())
    service.initialize()
  })

  async function invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({} as IpcMainInvokeEvent, ...args)
  }

  it('registers a handler for every channel it declares', () => {
    expect([...ipcMainMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceRateMonitorIpc.channelsConst).sort())
  })

  it('fails the boot when one of its channels has no handler', () => {
    const internals = new ServiceRateMonitorIpc(monitorUnderTest()) as unknown as {
      assertComplete(channels: typeof ServiceRateMonitorIpc.channelsConst): void
    }
    expect(() => internals.assertComplete(ServiceRateMonitorIpc.channelsConst))
      .toThrow(/IPC channel is not registered/)
  })

  it('answers the read with the snapshot the monitor holds', async () => {
    expect(await invoke('rate:get')).toEqual({ ok: true, value: snapshotConst })
  })

  /*
   * The manual read answers the snapshot the reads settled on, not the one from before them: a
   * caller then never has to race the event it would otherwise wait for.
   */
  it('answers the manual read with the snapshot after it settled', async () => {
    expect(await invoke('rate:refresh')).toEqual({ ok: true, value: refreshedConst })
    expect(refreshes).toBe(1)
  })

  /*
   * The name used to promise "and no credential can be in it" and the body could not have caught
   * one: its closing assertion read the LITERAL this file declares, so no change to the service
   * could make it fail. Where that promise is actually kept is `rateMonitor.test.ts`, over the
   * value the library composes, and `scripts/smoke/rate-monitor.ts` over a real read.
   *
   * What this seam owns is narrower and is what is asserted now: it hands the view over whole, off
   * the wire, reshaping nothing on the way.
   */
  it('hands the Debug window the unreduced view whole', async () => {
    const answer = await invoke('rate:debug-status') as
      { ok: true; value: RateMonitorDebugStatus } | { ok: false; error: string }

    expect(answer).toEqual({ ok: true, value: debugStatusConst })
    if (!answer.ok) throw new Error(`The debug status was refused: ${answer.error}`)
    expect(Object.keys(answer.value.providers.claude).sort()).toEqual([
      'extras',
      'lastAttemptAt',
      'lastReason',
      'lastSuccessAt',
      'oauthExpiresAt',
      'raw',
      'state',
    ])
  })
})
