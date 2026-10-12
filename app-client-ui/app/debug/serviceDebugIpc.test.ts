import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  const sections: (string | null)[] = []
  let service: ServiceDebugIpc

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    sections.length = 0
    service = new ServiceDebugIpc({
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

  // The two Host reads are the control API's `host.status` and `host.ping` now; what is left is the window.
  it('declares only the section the window shows', () => {
    expect(Object.keys(ServiceDebugIpc.channelsConst)).toEqual(['debug:section-active'])
  })

  it('tells the ping gate which section is on screen', async () => {
    service.initialize()
    await invoke('debug:section-active', 'host')
    await invoke('debug:section-active', null)
    expect(sections).toEqual(['host', null])
  })
})
