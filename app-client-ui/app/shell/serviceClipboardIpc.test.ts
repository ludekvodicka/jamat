import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiIpcInvokeMap, IpcResult } from '../../shared/appClientUiIpc'
import { ServiceClipboardIpc } from './serviceClipboardIpc'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  written: [] as string[],
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      electronMock.handlers.set(channel, handler)
    },
  },
  clipboard: {
    writeText: (text: string) => { electronMock.written.push(text) },
  },
}))

describe('app-client-ui/app/shell/serviceClipboardIpc', () => {
  let service: ServiceClipboardIpc

  beforeEach(() => {
    electronMock.handlers.clear()
    electronMock.written.length = 0
    service = new ServiceClipboardIpc()
  })

  async function write(text: string): Promise<IpcResult<void>> {
    const channel: keyof AppClientUiIpcInvokeMap = 'clipboard:write-text'
    const handler = electronMock.handlers.get(channel)
    if (!handler)
      throw new Error(`No handler for ${channel}`)
    return handler({ sender: {} }, text) as Promise<IpcResult<void>>
  }

  it('registers a handler for every channel it declares', () => {
    service.initialize()
    expect([...electronMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceClipboardIpc.channelsConst).sort())
  })

  it('fails the boot when one of its channels has no handler', () => {
    const internals = service as unknown as {
      assertComplete(channels: typeof ServiceClipboardIpc.channelsConst): void
    }
    expect(() => internals.assertComplete(ServiceClipboardIpc.channelsConst))
      .toThrow(/IPC channel is not registered/)
  })

  it('puts the text it was given into the clipboard, verbatim', async () => {
    service.initialize()

    expect(await write('C:\\Projects\\NodeJs\\AppJamatV3'))
      .toEqual({ ok: true, value: undefined })
    expect(electronMock.written).toEqual(['C:\\Projects\\NodeJs\\AppJamatV3'])
  })

  // Nothing here trims or refuses: what is copied is what the caller decided to copy.
  it('writes an empty string as readily as any other', async () => {
    service.initialize()

    await write('')

    expect(electronMock.written).toEqual([''])
  })
})
