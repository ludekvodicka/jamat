import { bindService } from '../shared/serviceIpcTestHarness'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiIpcInvokeMap, IpcResult } from '../../shared/appClientUiIpc'
import { ServiceClipboardIpc } from './serviceClipboardIpc'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  written: [] as string[],
  rich: [] as { text: string; html: string }[],
  images: [] as { width: number; height: number }[],
  /** What the clipboard reads back; a holder process makes it answer an empty image. */
  readBack: (written: { width: number; height: number } | undefined) => written ?? { width: 0, height: 0 },
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      electronMock.handlers.set(channel, handler)
    },
  },
  clipboard: {
    writeText: (text: string) => { electronMock.written.push(text) },
    write: (data: { text: string; html: string }) => { electronMock.rich.push(data) },
    readText: () => electronMock.rich.at(-1)?.text ?? '',
    writeImage: (image: { getSize(): { width: number; height: number } }) => { electronMock.images.push(image.getSize()) },
    readImage: () => ({ getSize: () => electronMock.readBack(electronMock.images.at(-1)) }),
  },
  nativeImage: {
    createFromDataURL: (url: string) => {
      const size = url.endsWith('AAAA') ? { width: 0, height: 0 } : { width: 4, height: 3 }
      return { isEmpty: () => size.width === 0, getSize: () => size }
    },
  },
}))

describe('app-client-ui/app/shell/serviceClipboardIpc', () => {
  let service: ServiceClipboardIpc

  beforeEach(() => {
    electronMock.handlers.clear()
    electronMock.written.length = 0
    electronMock.rich.length = 0
    electronMock.images.length = 0
    electronMock.readBack = (written) => written ?? { width: 0, height: 0 }
    service = bindService(new ServiceClipboardIpc())
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

  it('writes text and HTML as one entry and confirms it by reading the text back', async () => {
    service.initialize()
    const handler = electronMock.handlers.get('clipboard:write-rich' satisfies keyof AppClientUiIpcInvokeMap)!

    expect(await handler({ sender: {} }, '# Title', '<h1>Title</h1>')).toEqual({ ok: true, value: true })
    expect(electronMock.rich).toEqual([{ text: '# Title', html: '<h1>Title</h1>' }])
  })
  describe('clipboard:write-image', () => {
    const image = (value: unknown): Promise<unknown> =>
      electronMock.handlers.get('clipboard:write-image' satisfies keyof AppClientUiIpcInvokeMap)!({ sender: {} }, value) as Promise<unknown>

    it('writes the decoded PNG and confirms it by the size it reads back', async () => {
      service.initialize()

      expect(await image('data:image/png;base64,iVBORw0KGgo=')).toEqual({ ok: true, value: true })
      expect(electronMock.images).toEqual([{ width: 4, height: 3 }])
    })

    it('refuses anything that is not a PNG data URL before touching the clipboard', async () => {
      service.initialize()

      for (const value of ['data:image/jpeg;base64,AAAA', 'jamat-v3-file://resource/x', 42])
        expect(await image(value)).toMatchObject({ ok: false, error: expect.stringContaining('PNG data URL') })
      expect(electronMock.images).toEqual([])
    })

    it('answers false for a PNG that does not decode', async () => {
      service.initialize()

      expect(await image('data:image/png;base64,AAAA')).toEqual({ ok: true, value: false })
      expect(electronMock.images).toEqual([])
    })

    it('answers false when another process holds the clipboard throughout', async () => {
      service.initialize()
      electronMock.readBack = () => ({ width: 0, height: 0 })

      expect(await image('data:image/png;base64,iVBORw0KGgo=')).toEqual({ ok: true, value: false })
      expect(electronMock.images.length).toBeGreaterThan(1)
    })
  })
})
