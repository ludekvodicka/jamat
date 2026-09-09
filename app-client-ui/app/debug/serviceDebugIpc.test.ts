import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  HostDebugStatus,
  HostPingResult,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import { ServiceDebugIpc } from './serviceDebugIpc'

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

describe('app-client-ui/app/debug/serviceDebugIpc', () => {
  const statusConst = { capturedAt: 1, presence: 'unreachable' } as unknown as HostDebugStatus
  const pingConst: HostPingResult = { at: 2, ok: false, detail: 'host-unreachable: no descriptor' }

  const sections: (string | null)[] = []
  let pings = 0
  let service: ServiceDebugIpc

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    sections.length = 0
    pings = 0
    service = new ServiceDebugIpc({
      debugStatusOf: () => statusConst,
      pingHost: () => {
        pings += 1
        return Promise.resolve(pingConst)
      },
      sectionActive: (section) => { sections.push(section) },
    })
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
    service.initialize()
    expect([...ipcMainMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceDebugIpc.channelsConst).sort())
  })

  /*
   * The names themselves, in order, so a fourth one is looked at rather than added. It was called
   * "three read-only channels and nothing that passes anything through" and checked neither claim -
   * and `debug:section-active` breaks both: it takes a value and drives the Host ping gate. What is
   * true of it is checked below, where the value is followed.
   */
  it('declares exactly these three channels', () => {
    expect(Object.keys(ServiceDebugIpc.channelsConst)).toEqual([
      'debug:host-status',
      'debug:host-ping',
      'debug:section-active',
    ])
  })

  it('hands each channel to the subsystem behind it', async () => {
    service.initialize()

    // The channel itself failing is what `IpcResult` is for; the value is the subsystem's answer.
    expect(await invoke('debug:host-status')).toEqual({ ok: true, value: statusConst })
    expect(await invoke('debug:host-ping')).toEqual({ ok: true, value: pingConst })
    expect(pings).toBe(1)

    // The one channel that carries a value: what the gate is told is what came over the wire, and
    // the two reads beside it tell it nothing at all.
    await invoke('debug:section-active', 'host')
    await invoke('debug:section-active', null)
    expect(sections).toEqual(['host', null])

    await invoke('debug:host-status')
    await invoke('debug:host-ping')
    expect(sections).toEqual(['host', null])
  })
})
