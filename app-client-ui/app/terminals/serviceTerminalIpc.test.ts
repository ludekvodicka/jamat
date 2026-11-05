import { ElectronShellPort } from '../shell/electronShellPort'
const shell = { clipboardForPaste: () => ElectronShellPort.prototype.clipboardForPaste() }
import { bindService } from '../shared/serviceIpcTestHarness'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import { ServiceTerminalIpc } from './serviceTerminalIpc'
import { WindowPorts } from '../processes/windowPorts'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  clipboard: '',
  image: null as Uint8Array | null,
  fileDrop: '',
}))

vi.mock('electron', () => ({
  MessageChannelMain: class {
    port1 = { close() {} }
    port2 = { close() {} }
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcMainMock.handlers.set(channel, handler)
    },
  },
  clipboard: {
    writeText: (text: string) => { ipcMainMock.clipboard = text },
    readText: () => ipcMainMock.clipboard,
    readBuffer: (format: string) => format === 'FileNameW' && ipcMainMock.fileDrop.length > 0
      ? Buffer.from(`${ipcMainMock.fileDrop}\u0000`, 'utf16le')
      : Buffer.alloc(0),
    readImage: () => ({
      isEmpty: () => ipcMainMock.image === null,
      toPNG: () => ipcMainMock.image,
    }),
  },
}))

class FakeSender extends EventEmitter {
  private static nextId = 0
  readonly id = ++FakeSender.nextId
  isDestroyed(): boolean { return false }
  postMessage(): void {}
  asSender(): WebContents { return this as unknown as WebContents }
}

describe('app-client-ui/app/terminals/serviceTerminalIpc', () => {
  const saved: { sessionId: string; bytes: Uint8Array }[] = []
  const grants = new Map<WebContents, Map<string, string>>()
  function grant(sender: FakeSender, attachId: string, sessionId: string): void {
    grants.set(sender.asSender(), new Map([[attachId, sessionId]]))
  }
  beforeEach(() => {
    ipcMainMock.handlers.clear()
    ipcMainMock.clipboard = ''
    ipcMainMock.image = null
    ipcMainMock.fileDrop = ''
    saved.length = 0
    grants.clear()
    bindService(new ServiceTerminalIpc({ authorize: async (sender, attachId) => {
      const sessionId = grants.get(sender)?.get(attachId)
      if (sessionId === undefined) throw new Error(`Terminal attach is not owned by this renderer: ${attachId}`)
      return sessionId
    } }, { saveImage: async (sessionId, bytes) => {
      saved.push({ sessionId, bytes })
      return { ok: true, path: `/pasted files/${sessionId}.png` }
    } }, shell)).initialize()
  })

  async function invoke(channel: keyof AppClientUiIpcInvokeMap, sender: FakeSender, ...args: unknown[]): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({ sender: sender.asSender() } as IpcMainInvokeEvent, ...args)
  }

  it('registers a handler for every channel it declares', () => {
    expect([...ipcMainMock.handlers.keys()].sort()).toEqual(Object.keys(ServiceTerminalIpc.channelsConst).sort())
  })

  it('reads and writes the clipboard for the renderer that owns the attach', async () => {
    const owner = new FakeSender()
    grant(owner, 'a1', 'session-1')

    expect(await invoke('terminal:clipboard-write', owner, 'a1', 'selected text'))
      .toEqual({ ok: true, value: true })
    expect(await invoke('terminal:clipboard-paste', owner, 'a1'))
      .toEqual({ ok: true, value: { kind: 'text', text: 'selected text' } })
  })

  it('keeps clipboard access for an existing attach while new attaches are disabled by a reversible close', async () => {
    const owner = new FakeSender()
    let accepting = true
    const windows = new WindowPorts({ open() {}, close() {}, setAccepting() {}, acceptsRenderer: () => accepting,
      authorize: async () => 'session-1', report: message => { throw new Error(message) } })
    windows.watch(owner.asSender()); owner.emit('did-finish-load')
    bindService(new ServiceTerminalIpc(windows, { saveImage: async () => { throw new Error('Unexpected image save') } }, shell)).initialize()
    accepting = false
    windows.setAccepting(owner.asSender(), false)
    expect(await invoke('terminal:clipboard-write', owner, 'a1', 'still owned')).toEqual({ ok: true, value: true })
    expect(await invoke('terminal:clipboard-paste', owner, 'a1'))
      .toEqual({ ok: true, value: { kind: 'text', text: 'still owned' } })
    windows.stop()
  })

  it('saves a clipboard image under the attach session and answers the path to paste', async () => {
    const owner = new FakeSender()
    grant(owner, 'a1', 'session-1')
    ipcMainMock.image = Uint8Array.from([0x89, 0x50])

    expect(await invoke('terminal:clipboard-paste', owner, 'a1'))
      .toEqual({ ok: true, value: { kind: 'text', text: '"/pasted files/session-1.png"' } })
    expect(saved).toEqual([{ sessionId: 'session-1', bytes: Uint8Array.from([0x89, 0x50]) }])
  })

  it('pastes the path of a file copied in Explorer, which the agent on this computer reads', async () => {
    const owner = new FakeSender()
    grant(owner, 'a1', 'session-1')
    ipcMainMock.fileDrop = 'C:/shots/one.png'
    ipcMainMock.image = Uint8Array.from([0x89, 0x50])

    expect(await invoke('terminal:clipboard-paste', owner, 'a1'))
      .toEqual({ ok: true, value: { kind: 'text', text: 'C:/shots/one.png' } })
    expect(saved).toEqual([])
  })

  it('prefers text over an image when the clipboard holds both, and answers empty for neither', async () => {
    const owner = new FakeSender()
    grant(owner, 'a1', 'session-1')
    expect(await invoke('terminal:clipboard-paste', owner, 'a1'))
      .toEqual({ ok: true, value: { kind: 'empty' } })
    ipcMainMock.clipboard = 'cells'
    ipcMainMock.image = Uint8Array.from([0x89, 0x50])
    expect(await invoke('terminal:clipboard-paste', owner, 'a1'))
      .toEqual({ ok: true, value: { kind: 'text', text: 'cells' } })
    expect(saved).toEqual([])
  })

  // The narrowing the two channels exist for: the clipboard is the user's, so it answers a window
  // that holds this terminal and nothing else in the renderer.
  it('refuses the clipboard to a renderer that does not own the attach', async () => {
    const owner = new FakeSender()
    const other = new FakeSender()
    grant(owner, 'a1', 'session-1')
    ipcMainMock.clipboard = 'not yours'

    expect(await invoke('terminal:clipboard-paste', other, 'a1')).toEqual({
      ok: false,
      error: 'Terminal attach is not owned by this renderer: a1',
    })
    expect(await invoke('terminal:clipboard-write', other, 'a1', 'overwritten')).toEqual({
      ok: false,
      error: 'Terminal attach is not owned by this renderer: a1',
    })
    expect(ipcMainMock.clipboard).toBe('not yours')
  })

})
