import type { Rectangle, WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppContext } from '../appContext'
import type {
  ClientStateStore,
  ExtraWindowState,
  WindowBounds,
  WindowBoundsKey,
} from '../clientState/clientStateStore'
import { WorkspaceWindow } from './workspaceWindow'
import { WorkspaceWindows } from './workspaceWindows'

const { FakeWindow, screenMock } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  class FakeWindow {
    static created: FakeWindow[] = []
    static loadFailure: Error | null = null
    readonly listeners = new Map<string, Listener[]>()
    readonly loadedFiles: string[] = []
    destroyed = false
    visible = true
    minimized = false
    focused = false
    webContentsDestroyed = false
    focuses = 0
    closeAttempts = 0
    title = ''
    icon: unknown = null
    readonly sent: unknown[][] = []
    readonly webContents = {
      id: FakeWindow.created.length + 1,
      listeners: new Map<string, Listener[]>(),
      on: (event: string, listener: Listener) => {
        const existing = this.webContents.listeners.get(event) ?? []
        existing.push(listener)
        this.webContents.listeners.set(event, existing)
      },
      once: (event: string, listener: Listener) => this.webContents.on(event, listener),
      setWindowOpenHandler: () => {},
      reload: () => {},
      isDestroyed: () => this.webContentsDestroyed,
      send: (channel: string, ...args: unknown[]) => {
        if (this.webContentsDestroyed) throw new Error('Object has been destroyed')
        this.sent.push([channel, ...args])
      },
    }

    constructor(readonly options: Record<string, unknown>) {
      FakeWindow.created.push(this)
    }

    isDestroyed(): boolean { return this.destroyed }
    isVisible(): boolean { return this.visible }
    isMinimized(): boolean { return this.minimized }
    isMaximized(): boolean { return false }
    isFocused(): boolean { return this.focused }
    maximize(): void {}
    show(): void { this.visible = true }
    focus(): void { this.focuses += 1; this.focused = true }
    restore(): void { this.minimized = false }
    setTitle(title: string): void { this.title = title }
    setIcon(icon: unknown): void { this.icon = icon }

    getBounds(): { x: number; y: number; width: number; height: number } {
      return { x: 1, y: 2, width: 900, height: 600 }
    }

    getNormalBounds(): { x: number; y: number; width: number; height: number } {
      return this.getBounds()
    }

    on(event: string, listener: Listener): void {
      const existing = this.listeners.get(event) ?? []
      existing.push(listener)
      this.listeners.set(event, existing)
    }

    close(): void {
      if (this.destroyed)
        return
      this.closeAttempts += 1
      const event = {
        defaultPrevented: false,
        preventDefault(): void { this.defaultPrevented = true },
      }
      this.emitWindow('close', event)
      if (event.defaultPrevented || this.destroyed)
        return
      this.destroyed = true
      this.emitWindow('closed')
    }

    loadFile(file: string): Promise<void> {
      this.loadedFiles.push(file)
      return FakeWindow.settleLoad()
    }

    loadURL(url: string): Promise<void> {
      this.loadedFiles.push(url)
      return FakeWindow.settleLoad()
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.webContents.listeners.get(event) ?? [])
        listener({}, ...args)
    }

    emitWindow(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? [])
        listener(...args)
    }

    private static settleLoad(): Promise<void> {
      return FakeWindow.loadFailure === null
        ? Promise.resolve()
        : Promise.reject(FakeWindow.loadFailure)
    }
  }

  return {
    FakeWindow,
    screenMock: { workAreas: [{ x: 0, y: 0, width: 1920, height: 1040 }] },
  }
})

/**
 * Rendering, luminance, the cache and the empty-image refusal are owned by `windowIcon.test.ts`.
 * This file is about a stored appearance reaching a window, so the native rasteriser has no business
 * running here. NOTE for finding 083: this also removes "a native Resvg exception" from the causes
 * that could still be observed in this file, so a flake that does not come back is weak indirect
 * evidence and never a closure.
 */
vi.mock('./windowIcon', () => ({
  WindowIcon: {
    of: () => ({ isEmpty: () => false }),
    clearCache: () => {},
  },
}))

vi.mock('electron', () => ({
  BrowserWindow: FakeWindow,
  nativeImage: {
    createFromDataURL: () => ({ isEmpty: () => false }),
    createFromBuffer: () => ({ isEmpty: () => false }),
  },
  screen: { getAllDisplays: () => screenMock.workAreas.map((workArea) => ({ workArea })) },
}))

describe('app-client-ui/app/shell/workspaceWindows', () => {
  const storedBoundsConst: WindowBounds =
    { x: 120, y: 80, width: 1280, height: 800, maximized: false }
  const contextConst = {
    appName: 'Jamat V3',
    preloadPath: 'preload.js',
    rendererPath: 'index.html',
    rendererDevUrl: undefined,
  } as unknown as AppContext

  interface Placement {
    restoreBounds(
      stored: WindowBounds | null,
      workAreas: readonly Rectangle[],
    ): { rectangle: Rectangle | null; maximized: boolean }
  }

  interface Harness {
    registry: WorkspaceWindows
    store: StateStore
    created: string[]
    visibility: { windowId: string; visible: boolean }[]
    rendererGone: string[]
    closed: string[]
    close: CloseControl
  }

  class CloseControl {
    readonly confirmations: { parent: unknown; holderCount: number }[] = []
    readonly plainCalls: (readonly string[])[] = []
    readonly explicitClose: string[] = []
    readonly acceptingDuringExplicit: boolean[] = []
    readonly reports: string[] = []
    readonly plainByWindow = new Map<string, readonly string[]>()
    confirmationResult: Promise<boolean> = Promise.resolve(true)
    plainResult: Promise<boolean> = Promise.resolve(true)
    quitRequests = 0
  }

  class StateStore {
    readonly askedBounds: WindowBoundsKey[] = []
    readonly savedBounds: WindowBoundsKey[] = []
    readonly extraWindows: Record<string, ExtraWindowState> = {}
    readonly markedClosed: string[] = []
    mainBounds: WindowBounds | null = null
    mainAppearance = { name: null as string | null, color: null as string | null }

    loadWindowBounds(key: WindowBoundsKey): WindowBounds | null {
      this.askedBounds.push(key)
      if (key === 'main')
        return this.mainBounds
      else if (key === 'debug')
        return null
      else if (key !== null && typeof key === 'object')
        return this.extraWindows[key.extraWindowId]?.bounds ?? null
      else
        throw new Error(`Unknown bounds key: ${JSON.stringify(key)}`)
    }

    saveWindowBounds(key: WindowBoundsKey): boolean {
      this.savedBounds.push(key)
      return true
    }

    markExtraWindowOpen(windowId: string): boolean {
      const current = { ...this.extraWindows[windowId] }
      delete current.closed
      this.extraWindows[windowId] = current
      return true
    }

    markExtraWindowClosed(windowId: string): boolean {
      this.markedClosed.push(windowId)
      const current = this.extraWindows[windowId]
      if (!current)
        return false
      if (current.name !== undefined)
        this.extraWindows[windowId] = { ...current, closed: true }
      else
        delete this.extraWindows[windowId]
      return true
    }

    isNamed(windowId: string): boolean {
      return this.extraWindows[windowId]?.name !== undefined
    }

    listExtraWindows(): Readonly<Record<string, ExtraWindowState>> {
      return this.extraWindows
    }

    loadWindowAppearance(windowId: string): { name: string | null; color: string | null } {
      if (windowId === 'main')
        return this.mainAppearance
      const state = this.extraWindows[windowId]
      return { name: state?.name ?? null, color: state?.color ?? null }
    }
  }

  const placement = WorkspaceWindow as unknown as Placement

  function harness(): Harness {
    const store = new StateStore()
    const created: string[] = []
    const visibility: { windowId: string; visible: boolean }[] = []
    const rendererGone: string[] = []
    const closed: string[] = []
    const close = new CloseControl()
    let registry: WorkspaceWindows
    registry = new WorkspaceWindows(
      contextConst,
      store as unknown as ClientStateStore,
      {
        onCreated: (windowId) => created.push(windowId),
        onVisibilityChanged: (windowId, visible) => visibility.push({ windowId, visible }),
        onRendererGone: (windowId) => rendererGone.push(windowId),
        onClosed: (windowId) => closed.push(windowId),
        confirmMainWindowClose: async (parent, holderCount) => {
          close.confirmations.push({ parent, holderCount })
          return close.confirmationResult
        },
        plainSessionIds: (windowId) => close.plainByWindow.get(windowId) ?? [],
        closePlainSessions: async (sessionIds) => {
          close.plainCalls.push([...sessionIds])
          return close.plainResult
        },
        requestQuit: () => { close.quitRequests += 1 },
        explicitlyClosing: (windowId) => {
          close.explicitClose.push(windowId)
          const sender = registry.window(windowId)?.windowHandle()?.webContents
          close.acceptingDuringExplicit.push(sender ? registry.acceptsRenderer(sender) : false)
        },
        report: (message) => close.reports.push(message),
      },
    )
    return { registry, store, created, visibility, rendererGone, closed, close }
  }

  /** What the fake answers to, for the one place a handle is read back through Electron's type. */
  interface FakeWindowShape {
    title: string
    icon: unknown
  }

  function senderOf(index: number): WebContents {
    return FakeWindow.created[index].webContents as unknown as WebContents
  }

  beforeEach(() => {
    FakeWindow.created = []
    FakeWindow.loadFailure = null
    screenMock.workAreas = [{ x: 0, y: 0, width: 1920, height: 1040 }]
  })

  afterEach(() => {
    // A fake renderer never says it loaded and a fake window is rarely closed, so every test used to
    // leave its load and readiness waiters alive in the worker. Settled here rather than through the
    // close gate, which is behaviour under test rather than cleanup.
    for (const window of FakeWindow.created) {
      window.emit('did-finish-load')
      if (window.destroyed) continue
      window.destroyed = true
      window.emitWindow('closed')
    }
    vi.restoreAllMocks()
  })

  it('places a stored rectangle that is on a display', () => {
    expect(placement.restoreBounds(storedBoundsConst, screenMock.workAreas)).toEqual({
      rectangle: { x: 120, y: 80, width: 1280, height: 800 },
      maximized: false,
    })
  })

  it('routes mouse Back only to the workspace window that received it', () => {
    const { registry } = harness()
    registry.createMain()
    registry.createHolder('holder-back')
    const main = FakeWindow.created[0]
    const holder = FakeWindow.created[1]
    const event = { preventDefault: vi.fn() }

    holder.emitWindow('app-command', event, 'browser-backward')

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(holder.sent).toEqual([['menu:command', 'view.fileBack']])
    expect(main.sent).toEqual([])
    holder.emitWindow('app-command', event, 'browser-forward')
    holder.emitWindow('app-command', event, 'volume-up')
    expect(holder.sent).toHaveLength(1)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('grows a stored rectangle that is under the minimum size', () => {
    const placed = placement.restoreBounds(
      { ...storedBoundsConst, width: 200, height: 100 },
      screenMock.workAreas,
    )
    expect(placed.rectangle).toEqual({ x: 120, y: 80, width: 820, height: 560 })
  })

  it('skips publish after WebContents is destroyed but before BrowserWindow closes', () => {
    const { registry } = harness()
    registry.createMain()
    const window = FakeWindow.created[0]

    registry.publishTo('main', 'sessions:changed')
    window.webContentsDestroyed = true

    expect(() => registry.publishTo('main', 'sessions:changed')).not.toThrow()
    expect(window.sent).toEqual([['sessions:changed']])
    expect(window.destroyed).toBe(false)
  })

  it('drops an off-screen rectangle and preserves its maximized state', () => {
    expect(placement.restoreBounds(
      { x: -4000, y: -3000, width: 1280, height: 800, maximized: true },
      screenMock.workAreas,
    )).toEqual({ rectangle: null, maximized: true })
  })

  it('has no placement with no stored rectangle or attached display', () => {
    expect(placement.restoreBounds(null, screenMock.workAreas))
      .toEqual({ rectangle: null, maximized: false })
    expect(placement.restoreBounds(storedBoundsConst, []).rectangle).toBeNull()
  })

  it('creates the main window on its stored rectangle', () => {
    const context = harness()
    context.store.mainBounds = storedBoundsConst

    context.registry.createMain()

    expect(FakeWindow.created[0].options)
      .toMatchObject({ x: 120, y: 80, width: 1280, height: 800 })
  })

  it('reads and writes bounds under the id-specific key', () => {
    const context = harness()
    context.registry.createMain()
    context.registry.createHolder('holder')

    expect(context.store.askedBounds).toEqual(['main', { extraWindowId: 'holder' }])

    FakeWindow.created[0].close()
    FakeWindow.created[1].close()
    expect(context.store.savedBounds).toEqual(['main', { extraWindowId: 'holder' }])
  })

  it('resolves when loading finishes and rejects a main-frame failure', async () => {
    const first = harness().registry.createMain()
    FakeWindow.created[0].emit('did-finish-load')
    await expect(first.whenLoaded()).resolves.toBeUndefined()

    const second = harness().registry.createMain()
    FakeWindow.created[1].emit('did-fail-load', -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true)
    await expect(second.whenLoaded()).rejects.toThrow(/ERR_FILE_NOT_FOUND \(-6\)/)
  })

  it('ignores a sub-frame load failure', async () => {
    const workspaceWindow = harness().registry.createMain()
    FakeWindow.created[0].emit('did-fail-load', -6, 'ERR_ABORTED', 'file:///frame', false)
    FakeWindow.created[0].emit('did-finish-load')

    await expect(workspaceWindow.whenLoaded()).resolves.toBeUndefined()
  })

  it('reports a rejected load instead of leaving an unhandled rejection', async () => {
    FakeWindow.loadFailure = new Error('ERR_ABORTED (-3) loading index.html')
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})

    harness().registry.createMain()

    await vi.waitFor(() => expect(reported).toHaveBeenCalledTimes(1))
    expect(reported.mock.calls[0][0]).toContain('ERR_ABORTED')
  })

  it('rejects a load wait before the window was created', async () => {
    const context = harness()
    const workspaceWindow = new WorkspaceWindow(
      contextConst,
      'main',
      {
        store: context.store as unknown as ClientStateStore,
        onWindowCreated: () => {},
        onCloseRequested: () => {},
      },
    )

    await expect(workspaceWindow.whenLoaded()).rejects.toThrow(/No window to load/)
  })

  it('reports visibility transitions and a close', () => {
    const context = harness()
    context.registry.createMain()
    const window = FakeWindow.created[0]

    window.minimized = true
    window.emitWindow('minimize')
    window.minimized = false
    window.emitWindow('restore')
    window.visible = false
    window.emitWindow('hide')
    window.visible = true
    window.emitWindow('show')
    context.registry.beginQuit()
    window.close()

    expect(context.visibility).toEqual([
      // The state the window is already in, reported once at creation: Electron shows it inside
      // the BrowserWindow constructor, so the first `show` fires before any listener exists.
      { windowId: 'main', visible: true },
      { windowId: 'main', visible: false },
      { windowId: 'main', visible: true },
      { windowId: 'main', visible: false },
      { windowId: 'main', visible: true },
      { windowId: 'main', visible: false },
    ])
    expect(context.closed).toEqual(['main'])
  })

  // `send` throws for a handle that is still alive while its render frame has already gone - an
  // ordinary moment during a crash or a reload. One window in that state used to end the loop,
  // so every window after it missed the event, and the throw travelled back out through whatever
  // library callback had started the broadcast.
  it('keeps broadcasting when one window refuses the send', () => {
    const context = harness()
    context.registry.createMain()
    context.registry.createHolder('holder')
    const [main, holder] = FakeWindow.created
    main!.webContents.send = () => { throw new Error('Render frame was disposed') }

    context.registry.broadcast('sessions:changed')

    expect(holder!.sent).toContainEqual(['sessions:changed'])
  })

  it('maps each sender to its window id and role', () => {
    const context = harness()
    context.registry.createMain()
    context.registry.createHolder('holder')

    expect(context.registry.windowIdOf(senderOf(0))).toBe('main')
    expect(context.registry.roleOf(senderOf(0))).toBe('main')
    expect(context.registry.windowIdOf(senderOf(1))).toBe('holder')
    expect(context.registry.roleOf(senderOf(1))).toBe('holder')
    expect(context.registry.windowIdOf({} as WebContents)).toBeNull()
  })

  it('announces a new workspace window as visible during creation', () => {
    const context = harness()

    context.registry.createMain()
    context.registry.createHolder('holder')

    expect(context.created).toEqual(['main', 'holder'])
  })

  it('does not become ready until the renderer marks the current navigation', async () => {
    const context = harness()
    context.registry.createMain()
    const sender = senderOf(0)
    let ready = false
    const waiting = context.registry.whenRendererReady('main').then(() => { ready = true })

    await Promise.resolve()
    expect(ready).toBe(false)

    context.registry.markRendererReady(sender)
    await waiting
    expect(ready).toBe(true)

    FakeWindow.created[0].emit('did-start-navigation', 'file:///index.html', false, true)
    expect(context.rendererGone).toEqual(['main'])
    ready = false
    const reloaded = context.registry.whenRendererReady('main').then(() => { ready = true })
    await Promise.resolve()
    expect(ready).toBe(false)

    context.registry.markRendererReady(sender)
    await reloaded
    expect(ready).toBe(true)
  })

  it('keeps renderer ownership during a same-document navigation', () => {
    const context = harness()
    context.registry.createMain()

    FakeWindow.created[0]!.emit('did-start-navigation', 'file:///index.html#section', true, true)

    expect(context.rendererGone).toEqual([])
  })

  it('keeps renderer ownership during subframe navigation', () => {
    const context = harness()
    context.registry.createMain()

    FakeWindow.created[0].emit('did-start-navigation', 'file:///frame.html', false, false)

    expect(context.rendererGone).toEqual([])
  })

  // A main frame that says it will not load used to change nothing here: the window stayed
  // `loading`, and everything waiting on it - a tab being moved in, a control command addressed
  // to it - waited until the process ended. Nothing else moves that window out of `loading`.
  it('fails the waiters when the main frame says it will not load', async () => {
    const context = harness()
    context.registry.createMain()
    const waiting = context.registry.whenRendererReady('main')

    FakeWindow.created[0]!.emit('did-fail-load', -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true)

    await expect(waiting).rejects.toThrow('Workspace window could not load: main')
    expect(context.close.reports.some((message) => message.includes('ERR_FILE_NOT_FOUND'))).toBe(true)
  })

  it('leaves a waiter alone when a subframe fails, and lets a reload become ready', async () => {
    const context = harness()
    context.registry.createMain()
    const sender = senderOf(0)
    let settled = false
    const waiting = context.registry.whenRendererReady('main').then(() => { settled = true })

    FakeWindow.created[0]!.emit('did-fail-load', -6, 'ERR_ABORTED', 'file:///frame', false)
    await Promise.resolve()
    expect(settled).toBe(false)

    context.registry.markRendererReady(sender)
    await waiting
    expect(settled).toBe(true)
  })

  it('moves a waiter onto a new readiness generation after navigation', async () => {
    const context = harness()
    context.registry.createMain()
    const sender = senderOf(0)
    const waiting = context.registry.whenRendererReady('main')

    FakeWindow.created[0].emit('did-start-navigation', 'file:///index.html', false, true)
    context.registry.markRendererReady(sender)

    await expect(waiting).resolves.toBeUndefined()
  })

  it('gates renderers through closing, cancellation and quit', () => {
    const context = harness()
    context.registry.createMain()
    const sender = senderOf(0)

    expect(context.registry.acceptsRenderer(sender)).toBe(true)
    expect(context.registry.beginClosing('main')).toBe(true)
    expect(context.registry.beginClosing('main')).toBe(false)
    expect(context.registry.acceptsRenderer(sender)).toBe(false)

    context.registry.cancelClosing('main')
    expect(context.registry.acceptsRenderer(sender)).toBe(true)

    context.registry.beginQuit()
    expect(context.registry.acceptsRenderer(sender)).toBe(false)
    expect(context.registry.beginClosing('main')).toBe(false)
  })

  it('focuses the existing main window instead of creating another one', () => {
    const context = harness()
    context.registry.createMain()

    context.registry.createMain()

    expect(FakeWindow.created).toHaveLength(1)
    expect(FakeWindow.created[0].focuses).toBe(1)
  })

  it('focuses a live holder without recreating it', () => {
    const context = harness()
    context.registry.createHolder('holder')

    context.registry.focusOrRecreate('holder')

    expect(FakeWindow.created).toHaveLength(1)
    expect(FakeWindow.created[0].focuses).toBe(1)
  })

  it('recreates a closed named holder under the same id with its layout intact', () => {
    const context = harness()
    context.store.extraWindows.holder = { name: 'Review', layout: '{"review":1}' }
    context.registry.createHolder('holder')
    FakeWindow.created[0].close()
    expect(context.store.extraWindows.holder.closed).toBe(true)

    context.registry.focusOrRecreate('holder')

    expect(FakeWindow.created).toHaveLength(2)
    expect(context.registry.windowIdOf(senderOf(1))).toBe('holder')
    expect(context.store.extraWindows.holder).toEqual({
      name: 'Review',
      layout: '{"review":1}',
    })
  })

  it('restores main and only extra windows that were open', () => {
    const context = harness()
    context.store.extraWindows.open = { name: 'Open' }
    context.store.extraWindows.closed = { name: 'Closed', closed: true }

    context.registry.restoreAtStart()

    expect(context.created).toEqual(['main', 'open'])
    expect(context.registry.holderCount()).toBe(1)
    expect(context.registry.namedWindows()).toEqual([
      { windowId: 'open', name: 'Open' },
      { windowId: 'closed', name: 'Closed' },
    ])
  })

  it('lists a named main window and both live and closed named holders', () => {
    const context = harness()
    context.store.mainAppearance = { name: 'Primary', color: null }
    context.store.extraWindows.live = { name: 'Logs' }
    context.store.extraWindows.closed = { name: 'Review', closed: true }

    expect(context.registry.namedWindows()).toEqual([
      { windowId: 'main', name: 'Primary' },
      { windowId: 'live', name: 'Logs' },
      { windowId: 'closed', name: 'Review' },
    ])
  })

  it('creates a bare holder and registers its durable identity immediately', () => {
    const context = harness()

    context.registry.createHolder('holder')

    expect(context.store.extraWindows.holder).toEqual({})
    expect(context.created).toEqual(['holder'])
    expect(FakeWindow.created).toHaveLength(1)
  })

  /**
   * The assertions read the window `createHolder` HANDED BACK, never an index into the array every
   * fake window pushes itself onto. The stray below is what makes that a rule rather than a
   * preference: with an index, a window this test did not create answers for the one it did, and the
   * failure lands on a bystander instead of on whoever leaked it.
   */
  it('applies stored title and icon before a restored holder is handed back', () => {
    const context = harness()
    context.store.extraWindows.holder = { name: 'Review', color: '#123456' }
    new FakeWindow({})

    const holder = context.registry.createHolder('holder')

    const handle = holder.windowHandle() as unknown as FakeWindowShape | null
    expect(handle).not.toBeNull()
    expect(handle?.title).toBe('Jamat V3 - Review')
    expect(handle?.icon).not.toBeNull()
  })

  it('closes a named holder through the gate and keeps its durable layout', () => {
    const context = harness()
    context.store.extraWindows.named = { name: 'Logs', layout: '{"logs":1}' }
    context.registry.createHolder('named')

    FakeWindow.created[0].close()

    expect(context.close.explicitClose).toEqual(['named'])
    expect(context.close.acceptingDuringExplicit).toEqual([false])
    expect(context.close.plainCalls).toEqual([])
    expect(context.store.extraWindows.named).toEqual({
      name: 'Logs',
      layout: '{"logs":1}',
      closed: true,
    })
    expect(FakeWindow.created[0].destroyed).toBe(true)
    expect(FakeWindow.created[0].closeAttempts).toBe(2)
  })

  it('closes plain sessions before garbage-collecting an unnamed holder', async () => {
    const context = harness()
    context.close.plainByWindow.set('holder', ['plain-1', 'plain-2'])
    context.registry.createHolder('holder')
    const sender = senderOf(0)

    FakeWindow.created[0].close()

    expect(context.registry.acceptsRenderer(sender)).toBe(false)
    expect(context.close.plainCalls).toEqual([['plain-1', 'plain-2']])
    // Announced when the close is TAKEN - after the cleanup answered - and not before it. The
    // window has stopped accepting its renderer by then, which is what this asserts.
    await vi.waitFor(() => expect(FakeWindow.created[0].destroyed).toBe(true))
    expect(context.close.explicitClose).toEqual(['holder'])
    expect(context.close.acceptingDuringExplicit).toEqual([false])
    expect(context.store.extraWindows.holder).toBeUndefined()
  })

  /*
   * The announcement clears every transfer token whose source or target is this window, and a
   * cancelled close restores the window while nothing restores the tokens: drag a tab out of main,
   * press main's X, answer Cancel, and the drop then silently does nothing.
   */
  /*
   * Every holder gets a fresh `randomUUID`, so three registries grew by one entry per window ever
   * opened and `broadcast` walked the dead ones on every event. `main` stays: it is recreated under
   * the same id, and its lifecycle is read while it is gone.
   */
  it('drops a closed holder from its registries, and keeps main', async () => {
    const context = harness()
    context.registry.createHolder('holder')
    expect(context.registry.window('holder')).not.toBeNull()

    FakeWindow.created[0].close()
    await vi.waitFor(() => expect(FakeWindow.created[0].destroyed).toBe(true))

    expect(context.registry.window('holder')).toBeNull()
    // And a second holder does not inherit anything from the first.
    context.registry.createHolder('holder-2')
    expect(context.registry.window('holder-2')).not.toBeNull()
  })

  it('announces nothing for a close the cleanup refused', async () => {
    const context = harness()
    context.close.plainByWindow.set('holder', ['plain-1'])
    context.close.plainResult = Promise.resolve(false)
    context.registry.createHolder('holder')
    const sender = senderOf(0)

    FakeWindow.created[0].close()

    // The window comes back, and nothing was ever announced about it: the announcement is what
    // throws away the transfer tokens this window is part of.
    await vi.waitFor(() => expect(context.registry.acceptsRenderer(sender)).toBe(true))
    expect(context.close.explicitClose).toEqual([])
    expect(FakeWindow.created[0].destroyed).toBe(false)
  })

  it('cancels an unnamed holder close when plain cleanup is refused', async () => {
    const context = harness()
    context.close.plainByWindow.set('holder', ['plain-1'])
    context.close.plainResult = Promise.resolve(false)
    context.registry.createHolder('holder')
    const sender = senderOf(0)

    FakeWindow.created[0].close()

    expect(context.registry.acceptsRenderer(sender)).toBe(false)
    await vi.waitFor(() => expect(context.registry.acceptsRenderer(sender)).toBe(true))
    expect(FakeWindow.created[0].destroyed).toBe(false)
    expect(context.store.extraWindows.holder).toEqual({})
  })

  it('reports a failed plain cleanup and returns the holder gate to ready', async () => {
    const context = harness()
    context.close.plainResult = Promise.reject(new Error('Host unavailable'))
    context.registry.createHolder('holder')
    const sender = senderOf(0)

    FakeWindow.created[0].close()

    await vi.waitFor(() => expect(context.close.reports).toEqual(['Host unavailable']))
    expect(context.registry.acceptsRenderer(sender)).toBe(true)
    expect(FakeWindow.created[0].destroyed).toBe(false)
  })

  it('asks before closing main with holders and restores the gate on Cancel', async () => {
    const context = harness()
    context.close.confirmationResult = Promise.resolve(false)
    context.registry.createMain()
    context.registry.createHolder('holder')
    const mainSender = senderOf(0)

    FakeWindow.created[0].close()

    expect(context.registry.acceptsRenderer(mainSender)).toBe(false)
    expect(context.close.confirmations).toEqual([{
      parent: FakeWindow.created[0],
      holderCount: 1,
    }])
    await vi.waitFor(() => expect(context.registry.acceptsRenderer(mainSender)).toBe(true))
    expect(context.close.quitRequests).toBe(0)
    expect(FakeWindow.created[0].destroyed).toBe(false)
    expect(context.store.savedBounds).toContain('main')
  })

  it('requests quit directly when main is the only workspace window', () => {
    const context = harness()
    context.registry.createMain()

    FakeWindow.created[0].close()

    expect(context.close.confirmations).toEqual([])
    expect(context.close.quitRequests).toBe(1)
    expect(FakeWindow.created[0].destroyed).toBe(false)
  })

  it('keeps every holder record when confirmed main close enters the quit cascade', async () => {
    const context = harness()
    context.store.extraWindows.named = { name: 'Logs', layout: '{"named":1}' }
    context.registry.createMain()
    context.registry.createHolder('named')
    context.registry.createHolder('plain')

    FakeWindow.created[0].close()
    await vi.waitFor(() => expect(context.close.quitRequests).toBe(1))

    context.registry.beginQuit()
    for (const window of FakeWindow.created)
      window.close()

    expect(context.store.markedClosed).toEqual([])
    expect(context.store.extraWindows.named).toEqual({ name: 'Logs', layout: '{"named":1}' })
    expect(context.store.extraWindows.plain).toEqual({})
    expect(context.close.plainCalls).toEqual([])
    expect(FakeWindow.created.every((window) => window.destroyed)).toBe(true)
  })

  it('lets before-quit close every window without dialog, cleanup or state mutation', () => {
    const context = harness()
    context.registry.createMain()
    context.registry.createHolder('holder')

    context.registry.beginQuit()
    for (const window of FakeWindow.created)
      window.close()

    expect(context.close.confirmations).toEqual([])
    expect(context.close.plainCalls).toEqual([])
    expect(context.close.explicitClose).toEqual([])
    expect(context.store.extraWindows.holder).toEqual({})
  })
})
