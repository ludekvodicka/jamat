import type { NativeImage, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiIpcInvokeMap, IpcResult } from '../../shared/appClientUiIpc'
import type { WindowInfo } from '../../shared/windowInfo'
import type { ClientStateStore } from '../clientState/clientStateStore'
import { ServiceWindowsIpc } from './serviceWindowsIpc'
import type { WorkspaceWindows } from './workspaceWindows'

type IpcHandler = (event: { sender: WebContents }, ...args: unknown[]) => Promise<unknown>

const { iconOfMock, ipcMainMock } = vi.hoisted(() => ({
  iconOfMock: vi.fn(),
  ipcMainMock: {
    handlers: new Map<string, IpcHandler>(),
    handle(channel: string, handler: IpcHandler): void {
      ipcMainMock.handlers.set(channel, handler)
    },
  },
}))

vi.mock('electron', () => ({ ipcMain: ipcMainMock }))
vi.mock('./windowIcon', () => ({ WindowIcon: { of: iconOfMock } }))

describe('app-client-ui/app/shell/serviceWindowsIpc', () => {
  const mainSender = { id: 1 } as unknown as WebContents
  const unknownSender = { id: 2 } as unknown as WebContents
  let service: ServiceWindowsIpc
  let order: string[]
  let saved: unknown[]
  let applied: unknown[]
  let published: unknown[][]
  let appearanceChanges: number

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    iconOfMock.mockReset()
    order = []
    saved = []
    applied = []
    published = []
    appearanceChanges = 0
    iconOfMock.mockImplementation((color: string | null) => {
      order.push(`icon:${color ?? 'default'}`)
      return { isEmpty: () => false } as unknown as NativeImage
    })
    const workspaceWindow = {
      setAppearance: (info: WindowInfo, icon: NativeImage) => {
        order.push('apply')
        applied.push({ info, icon })
      },
    }
    const windows = {
      windowIdOf: (sender: WebContents) => sender === mainSender ? 'main' : null,
      roleOf: (sender: WebContents) => sender === mainSender ? 'main' as const : null,
      acceptsRenderer: (sender: WebContents) => sender === mainSender,
      window: (windowId: string) => windowId === 'main' ? workspaceWindow : null,
      publishTo: (...args: unknown[]) => {
        order.push('publish')
        published.push(args)
      },
    } as WorkspaceWindows
    const store = {
      loadWindowAppearance: () => ({ name: 'Primary', color: '#123456' }),
      saveWindowAppearance: (_windowId: string, appearance: unknown) => {
        order.push('store')
        saved.push(appearance)
        return true
      },
    } as unknown as ClientStateStore
    service = new ServiceWindowsIpc(windows, store, () => {
      order.push('menu')
      appearanceChanges += 1
    })
  })

  async function info(sender: WebContents): Promise<IpcResult<WindowInfo>> {
    const channel: keyof AppClientUiIpcInvokeMap = 'shell:window-info'
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler)
      throw new Error(`No handler for ${channel}`)
    return handler({ sender }) as Promise<IpcResult<WindowInfo>>
  }

  async function save(sender: WebContents, appearance: unknown): Promise<IpcResult<WindowInfo>> {
    const channel: keyof AppClientUiIpcInvokeMap = 'window:save-appearance'
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler)
      throw new Error(`No handler for ${channel}`)
    return handler({ sender }, appearance) as Promise<IpcResult<WindowInfo>>
  }

  it('returns the id, role and appearance of the requesting workspace renderer', async () => {
    service.initialize()

    expect(await info(mainSender)).toEqual({
      ok: true,
      value: {
        windowId: 'main',
        role: 'main',
        name: 'Primary',
        color: '#123456',
      },
    })
  })

  it('refuses a renderer that does not belong to a workspace window', async () => {
    service.initialize()

    const answer = await info(unknownSender)

    expect(answer.ok).toBe(false)
    if (!answer.ok)
      expect(answer.error).toContain('unknown workspace renderer')
  })

  it('normalizes, renders, stores, applies and publishes in that order', async () => {
    service.initialize()

    expect(await save(mainSender, { name: '  Review  ', color: ' #A1B2C3 ' })).toEqual({
      ok: true,
      value: {
        windowId: 'main',
        role: 'main',
        name: 'Review',
        color: '#a1b2c3',
      },
    })
    expect(order).toEqual(['icon:#a1b2c3', 'store', 'apply', 'publish', 'menu'])
    expect(saved).toEqual([{ name: 'Review', color: '#a1b2c3' }])
    expect(applied).toHaveLength(1)
    expect(published).toEqual([['main', 'window:changed']])
    expect(appearanceChanges).toBe(1)
  })

  it('does not write state when icon generation fails', async () => {
    iconOfMock.mockImplementation(() => {
      order.push('icon')
      throw new Error('resvg binding failed')
    })
    service.initialize()

    const answer = await save(mainSender, { name: 'Review', color: '#123456' })

    expect(answer.ok).toBe(false)
    if (!answer.ok)
      expect(answer.error).toContain('resvg binding failed')
    expect(order).toEqual(['icon'])
    expect(saved).toEqual([])
  })

  it('refuses appearance from an unknown renderer', async () => {
    service.initialize()

    const answer = await save(unknownSender, { name: 'Review', color: null })

    expect(answer.ok).toBe(false)
    expect(saved).toEqual([])
  })
})
