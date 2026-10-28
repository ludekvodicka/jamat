import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppContext } from '../appContext'
import type { ClientStateStore, WindowBoundsKey } from '../clientState/clientStateStore'
import { UsageWindow } from './usageWindow'
const { FakeWindow } = vi.hoisted(() => {
  class FakeWindow {
    static created: FakeWindow[] = []
    destroyed = false
    minimized = false
    shows = 0
    focuses = 0
    readonly loaded: string[] = []
    readonly listeners = new Map<string, () => void>()
    readonly webContents = {
      on: () => {},
      once: () => {},
      setWindowOpenHandler: () => {},
      isDestroyed: () => this.destroyed,
    }

    readonly options: Record<string, unknown>

    constructor(options: Record<string, unknown>) {
      this.options = options
      FakeWindow.created.push(this)
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    isVisible(): boolean {
      return true
    }

    isMinimized(): boolean {
      return this.minimized
    }

    isMaximized(): boolean {
      return false
    }

    getBounds(): { x: number; y: number; width: number; height: number } {
      return { x: 0, y: 0, width: 1100, height: 800 }
    }

    getNormalBounds(): { x: number; y: number; width: number; height: number } {
      return this.getBounds()
    }

    on(event: string, listener: () => void): void {
      this.listeners.set(event, listener)
    }

    maximize(): void {}

    show(): void {
      this.shows += 1
    }

    focus(): void {
      this.focuses += 1
    }

    restore(): void {
      this.minimized = false
    }

    close(): void {
      this.destroyed = true
      this.listeners.get('close')?.()
      this.listeners.get('closed')?.()
    }

    loadFile(file: string): Promise<void> {
      this.loaded.push(file)
      return Promise.resolve()
    }

    loadURL(url: string): Promise<void> {
      this.loaded.push(url)
      return Promise.resolve()
    }
  }

  return { FakeWindow }
})

vi.mock('electron', () => ({
  BrowserWindow: FakeWindow,
  screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] },
}))

describe('app-client-ui/app/shell/usageWindow', () => {
  interface Harness {
    window: UsageWindow
    asked: WindowBoundsKey[]
    stored: WindowBoundsKey[]
    visibility: boolean[]
    closes: number
  }

  function harness(rendererDevUrl?: string): Harness {
    const context = {
      appName: 'Jamat V3',
      preloadPath: 'preload.js',
      rendererPath: 'index.html',
      rendererDevUrl,
      usageRendererPath: 'usage.html',
      usageRendererDevUrl: rendererDevUrl ? `${rendererDevUrl}/usage.html` : undefined,
    } as unknown as AppContext
    const state = {
      window: null as unknown as UsageWindow,
      asked: [] as WindowBoundsKey[],
      stored: [] as WindowBoundsKey[],
      visibility: [] as boolean[],
      closes: 0,
    }
    const store = {
      loadWindowBounds: (key: WindowBoundsKey) => { state.asked.push(key); return null },
      saveWindowBounds: (key: WindowBoundsKey) => { state.stored.push(key) },
    } as unknown as ClientStateStore
    state.window = new UsageWindow(context, {
      store,
      onVisibilityChanged: (visible) => state.visibility.push(visible),
      onClosed: () => { state.closes += 1 },
    })
    return state
  }

  beforeEach(() => {
    FakeWindow.created = []
  })
  it('opens one window and shows that one again on a second open', () => {
    const context = harness()
    context.window.open()
    expect(FakeWindow.created).toHaveLength(1)

    context.window.open()
    expect(FakeWindow.created).toHaveLength(1)
    expect(FakeWindow.created[0].shows).toBe(1)
    expect(FakeWindow.created[0].focuses).toBe(1)
  })
  it('opens again after it was closed', () => {
    const context = harness()
    context.window.open()
    FakeWindow.created[0].close()
    context.window.open()
    expect(FakeWindow.created).toHaveLength(2)
  })

  it('keeps its own bounds, not the workspace window ones', () => {
    const context = harness()
    context.window.open()
    expect(context.asked).toEqual(['usage'])

    FakeWindow.created[0].listeners.get('close')?.()
    expect(context.stored).toEqual(['usage'])
  })

  it('loads the usage document, and the dev server copy of it when there is one', () => {
    const built = harness()
    built.window.open()
    expect(FakeWindow.created[0].loaded).toEqual(['usage.html'])
    expect(FakeWindow.created[0].options).toMatchObject({
      title: 'Jamat Usage',
      width: 1100,
      height: 800,
    })

    const dev = harness('http://localhost:5173')
    dev.window.open()
    expect(FakeWindow.created[1].loaded).toEqual(['http://localhost:5173/usage.html'])
  })

  it('opens with the same sandbox and the one preload the shell has', () => {
    const context = harness()
    context.window.open()
    expect(FakeWindow.created[0].options.webPreferences).toEqual({
      preload: 'preload.js',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    })
  })
  it('reports itself on screen when it opens and out of sight when it closes', () => {
    const context = harness()
    context.window.open()
    expect(context.visibility).toEqual([true])

    FakeWindow.created[0].close()
    expect(context.visibility).toEqual([true, false])
    expect(context.closes).toBe(1)
  })
})
