import { randomUUID } from 'node:crypto'

import type { BrowserWindow, Event as ElectronEvent, WebContents } from 'electron'

import type { AppClientUiEventArgs, AppClientUiIpcEventMap } from '../../shared/appClientUiIpc'
import { ErrorText } from '../../shared/errorText'
import type { WindowRole } from '../../shared/windowInfo'
import type { AppContext } from '../appContext'
import type { ClientStateStore } from '../clientState/clientStateStore'
import { WorkspaceWindow } from './workspaceWindow'

type WorkspaceWindowLifecycle = 'loading' | 'ready' | 'closing' | 'closed'

interface ReadinessSignal {
  promise: Promise<void>
  release(): void
  /**
   * A load that will not finish. Without it a window whose document never arrives stays `loading`
   * for ever, and everything that waits for it - a tab being moved into it, a remote control command
   * addressed to it - waits with it until the process ends.
   */
  fail(reason: string): void
}

export interface WorkspaceWindowsDeps {
  onCreated(windowId: string): void
  onVisibilityChanged(windowId: string, visible: boolean): void
  onRendererGone(windowId: string): void
  onClosed(windowId: string): void
  confirmMainWindowClose(parent: BrowserWindow | null, holderCount: number): Promise<boolean>
  plainSessionIds(windowId: string): readonly string[]
  closePlainSessions(sessionIds: readonly string[]): Promise<boolean>
  requestQuit(): void
  /**
   * This window is closing for good, so what it was part of can be given up.
   *
   * Called where the close is DECIDED - after a confirmation, not before one - because the wiring
   * behind it throws transfer tokens away and a cancelled close restores the window and not those.
   */
  explicitlyClosing(windowId: string): void
  report(message: string): void
}

/** Registry, renderer identity and readiness for every workspace window in this process. */
export class WorkspaceWindows {
  private readonly windows = new Map<string, WorkspaceWindow>()
  private readonly senders = new Map<WebContents, string>()
  private readonly readyByWindow = new Map<string, ReadinessSignal>()
  private readonly lifecycle = new Map<string, WorkspaceWindowLifecycle>()
  private readonly allowNextClose = new Set<string>()
  private quitting = false

  constructor(
    private readonly context: AppContext,
    private readonly store: ClientStateStore,
    private readonly deps: WorkspaceWindowsDeps,
  ) {}

  createMain(): WorkspaceWindow {
    const existing = this.windows.get('main')
    if (existing && existing.windowHandle() !== null) {
      existing.focus()
      return existing
    }
    return this.createWindow('main')
  }

  createHolder(windowId: string = randomUUID()): WorkspaceWindow {
    const existing = this.windows.get(windowId)
    if (existing && existing.windowHandle() !== null) {
      existing.focus()
      return existing
    }
    if (!this.store.markExtraWindowOpen(windowId))
      throw new Error(`Client state refused extra window ${JSON.stringify(windowId)}`)
    return this.createWindow(windowId)
  }

  restoreAtStart(): void {
    this.createMain()
    for (const [windowId, state] of Object.entries(this.store.listExtraWindows()))
      if (state.closed !== true)
        this.createWindow(windowId)
  }

  focusOrRecreate(windowId: string): void {
    const existing = this.windows.get(windowId)
    if (existing && existing.windowHandle() !== null) {
      existing.focus()
      return
    }
    if (windowId === 'main')
      this.createMain()
    else if (this.store.listExtraWindows()[windowId] !== undefined)
      this.createHolder(windowId)
    else
      throw new Error(`Unknown workspace window: ${JSON.stringify(windowId)}`)
  }

  windowIdOf(sender: WebContents): string | null {
    return this.senders.get(sender) ?? null
  }

  roleOf(sender: WebContents): WindowRole | null {
    const windowId = this.windowIdOf(sender)
    if (windowId === null)
      return null
    return windowId === 'main' ? 'main' : 'holder'
  }

  main(): WorkspaceWindow {
    const main = this.windows.get('main')
    if (!main)
      throw new Error('The main workspace window does not exist')
    return main
  }

  window(windowId: string): WorkspaceWindow | null {
    return this.windows.get(windowId) ?? null
  }

  focusedWorkspace(): WorkspaceWindow | null {
    for (const window of this.windows.values())
      if (window.focused())
        return window
    return null
  }

  publishTo<K extends keyof AppClientUiIpcEventMap>(
    windowId: string,
    channel: K,
    ...args: AppClientUiEventArgs<K>
  ): void {
    const window = this.windows.get(windowId)
    if (!window)
      throw new Error(`Unknown workspace window: ${JSON.stringify(windowId)}`)
    window.publish(channel, ...args)
  }

  publishToIfLive<K extends keyof AppClientUiIpcEventMap>(
    windowId: string,
    channel: K,
    ...args: AppClientUiEventArgs<K>
  ): void {
    try {
      this.windows.get(windowId)?.publish(channel, ...args)
    } catch (error) {
      try {
        this.deps.report(`Workspace event could not be published: ${ErrorText.of(error)}`)
      } catch {}
    }
  }

  broadcast<K extends keyof AppClientUiIpcEventMap>(
    channel: K,
    ...args: AppClientUiEventArgs<K>
  ): void {
    for (const window of this.windows.values())
      window.publish(channel, ...args)
  }

  webContentsId(windowId: string): number | null {
    return this.windows.get(windowId)?.windowHandle()?.webContents.id ?? null
  }

  markRendererReady(sender: WebContents): void {
    const windowId = this.windowIdOf(sender)
    if (windowId === null)
      throw new Error('Renderer readiness came from an unknown workspace window')
    if (this.quitting)
      throw new Error(`Workspace window is not accepting readiness: ${windowId}`)
    const state = this.lifecycle.get(windowId)
    if (state === 'loading') {
      this.lifecycle.set(windowId, 'ready')
      this.readyByWindow.get(windowId)?.release()
    } else if (state === 'ready')
      return
    else if (state === 'closing')
      throw new Error(`Workspace window is not accepting readiness: ${windowId}`)
    else if (state === 'closed')
      throw new Error(`Workspace window is not accepting readiness: ${windowId}`)
    else if (state === undefined)
      throw new Error(`Workspace window has no lifecycle: ${windowId}`)
    else
      throw new Error(`Unknown workspace lifecycle: ${JSON.stringify(state)}`)
  }

  async whenRendererReady(windowId: string): Promise<void> {
    while (true) {
      const state = this.lifecycle.get(windowId)
      if (state === 'ready' && !this.quitting)
        return
      else if (state === 'loading' && !this.quitting) {
        const signal = this.readyByWindow.get(windowId)
        if (!signal)
          throw new Error(`Workspace window has no readiness generation: ${windowId}`)
        await signal.promise
      } else if (state === 'closing')
        throw new Error(`Workspace window cannot become ready: ${windowId}`)
      else if (state === 'closed')
        throw new Error(`Workspace window cannot become ready: ${windowId}`)
      else if (state === undefined)
        throw new Error(`Workspace window cannot become ready: ${windowId}`)
      else if (state === 'ready' || state === 'loading')
        throw new Error(`Workspace window cannot become ready: ${windowId}`)
      else
        throw new Error(`Unknown workspace lifecycle: ${JSON.stringify(state)}`)
    }
  }

  beginClosing(windowId: string): boolean {
    if (this.quitting)
      return false
    const state = this.lifecycle.get(windowId)
    if (state === 'loading' || state === 'ready') {
      this.lifecycle.set(windowId, 'closing')
      this.readyByWindow.get(windowId)?.release()
      return true
    } else if (state === 'closing')
      return false
    else if (state === 'closed')
      return false
    else if (state === undefined)
      return false
    else
      throw new Error(`Unknown workspace lifecycle: ${JSON.stringify(state)}`)
  }

  cancelClosing(windowId: string): void {
    if (this.quitting)
      return
    const state = this.lifecycle.get(windowId)
    if (state === 'closing') {
      this.lifecycle.set(windowId, 'ready')
      this.readyByWindow.get(windowId)?.release()
    } else if (state === 'loading')
      return
    else if (state === 'ready')
      return
    else if (state === 'closed')
      return
    else if (state === undefined)
      return
    else
      throw new Error(`Unknown workspace lifecycle: ${JSON.stringify(state)}`)
  }

  acceptsRenderer(sender: WebContents): boolean {
    const windowId = this.windowIdOf(sender)
    if (windowId === null)
      return false
    return this.acceptsWindow(windowId)
  }

  acceptsWindow(windowId: string): boolean {
    if (this.quitting)
      return false
    const state = this.lifecycle.get(windowId)
    if (state === 'loading')
      return true
    else if (state === 'ready')
      return true
    else if (state === 'closing')
      return false
    else if (state === 'closed')
      return false
    else if (state === undefined)
      return false
    else
      throw new Error(`Unknown workspace lifecycle: ${JSON.stringify(state)}`)
  }

  beginQuit(): void {
    this.quitting = true
    for (const signal of this.readyByWindow.values())
      signal.release()
  }

  holderCount(): number {
    return [...this.lifecycle]
      .filter(([windowId, state]) => windowId !== 'main' && state !== 'closed')
      .length
  }

  namedWindows(): readonly { windowId: string; name: string }[] {
    const named: { windowId: string; name: string }[] = []
    const mainName = this.store.loadWindowAppearance('main').name
    if (mainName !== null)
      named.push({ windowId: 'main', name: mainName })
    for (const [windowId, state] of Object.entries(this.store.listExtraWindows()))
      if (state.name !== undefined)
        named.push({ windowId, name: state.name })
    return named
  }

  private createWindow(windowId: string): WorkspaceWindow {
    let workspaceWindow = this.windows.get(windowId)
    if (!workspaceWindow) {
      workspaceWindow = new WorkspaceWindow(this.context, windowId, {
        store: this.store,
        onWindowCreated: (window) => this.windowCreated(windowId, window.webContents),
        onCloseRequested: (event) => this.windowCloseRequested(windowId, event),
        onVisibilityChanged: (visible) => this.deps.onVisibilityChanged(windowId, visible),
        onClosed: () => this.windowClosed(windowId),
      })
      this.windows.set(windowId, workspaceWindow)
    }
    workspaceWindow.create()
    this.deps.onCreated(windowId)
    return workspaceWindow
  }

  private windowCreated(windowId: string, sender: WebContents): void {
    this.senders.set(sender, windowId)
    this.lifecycle.set(windowId, 'loading')
    this.resetReadiness(windowId)
    // `isInPlace` is a same-document navigation - a fragment change, a `pushState`. Dropping a
    // window's panel ownership, its transfers and its file grants on one of those is not a
    // cleanup, and the document never comes back to `ready`, because the renderer announces
    // itself once at mount.
    sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame !== false && isInPlace !== true)
        this.rendererNavigated(windowId)
    })
    sender.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame !== false)
        this.rendererFailed(windowId, `${description} (${code})`)
    })
    sender.on('preload-error', (_event, preloadPath, error) =>
      this.rendererFailed(windowId, `preload failed at ${preloadPath}: ${error.message}`))
    sender.on('render-process-gone', () => this.rendererNavigated(windowId))
    sender.on('destroyed', () => this.deps.onRendererGone(windowId))
  }

  private windowCloseRequested(windowId: string, event: ElectronEvent): void {
    if (windowId === 'main')
      this.mainCloseRequested(event)
    else
      this.holderCloseRequested(windowId, event)
  }

  private mainCloseRequested(event: ElectronEvent): void {
    if (this.quitting)
      return
    event.preventDefault()
    if (!this.beginClosing('main'))
      return
    const holderCount = this.holderCount()
    if (holderCount === 0) {
      this.deps.explicitlyClosing('main')
      this.deps.requestQuit()
      return
    }
    void this.deps.confirmMainWindowClose(this.main().windowHandle(), holderCount)
      .then((confirmed) => {
        if (confirmed) {
          this.deps.explicitlyClosing('main')
          this.deps.requestQuit()
        }
        else
          this.cancelClosing('main')
      })
      .catch((error: unknown) => {
        this.cancelClosing('main')
        this.deps.report(ErrorText.of(error))
      })
  }

  private holderCloseRequested(windowId: string, event: ElectronEvent): void {
    if (this.quitting || this.allowNextClose.delete(windowId))
      return
    event.preventDefault()
    if (!this.beginClosing(windowId))
      return
    if (this.store.isNamed(windowId)) {
      this.closeAllowedHolder(windowId)
      return
    }
    void this.deps.closePlainSessions(this.deps.plainSessionIds(windowId))
      .then((closed) => {
        if (closed)
          this.closeAllowedHolder(windowId)
        else
          this.cancelClosing(windowId)
      })
      .catch((error: unknown) => {
        this.cancelClosing(windowId)
        this.deps.report(ErrorText.of(error))
      })
  }

  /**
   * The one place a holder's close is TAKEN, which is where its transfers are given up.
   *
   * Both close paths used to announce the close before their asynchronous confirmation - and that
   * announcement clears every transfer token whose source or target is this window. Answer Cancel,
   * or have the plain-session cleanup refused, and `cancelClosing` puts the window back while
   * nothing puts the tokens back: drag a tab out of main, press main's X, answer Cancel, and the
   * drop silently does nothing.
   */
  private closeAllowedHolder(windowId: string): void {
    this.deps.explicitlyClosing(windowId)
    this.allowNextClose.add(windowId)
    this.windows.get(windowId)?.close()
  }

  private rendererNavigated(windowId: string): void {
    this.deps.onRendererGone(windowId)
    const state = this.lifecycle.get(windowId)
    if (state === 'loading' || state === 'ready') {
      this.lifecycle.set(windowId, 'loading')
      this.resetReadiness(windowId)
    } else if (state === 'closing')
      return
    else if (state === 'closed')
      return
    else if (state === undefined)
      return
    else
      throw new Error(`Unknown workspace lifecycle: ${JSON.stringify(state)}`)
  }

  private resetReadiness(windowId: string): void {
    this.readyByWindow.get(windowId)?.release()
    let release = (): void => undefined
    let reject = (_reason: string): void => undefined
    const promise = new Promise<void>((resolve, refuse) => {
      release = resolve
      reject = (reason) => refuse(new Error(reason))
    })
    // Nobody has to be waiting when a load fails, and an unobserved rejection in the main process
    // ends it. The waiters get their own copy of the rejection; this one only keeps the peace.
    void promise.catch(() => undefined)
    this.readyByWindow.set(windowId, { promise, release, fail: reject })
  }

  /**
   * The main frame said it will not load. Failing the readiness signal is what turns "this window is
   * still loading" into an answer: the wait rejects rather than standing there. A reload afterwards
   * goes through `did-start-navigation` and mints a fresh signal, so this is not a terminal state.
   */
  private rendererFailed(windowId: string, detail: string): void {
    this.deps.report(`The window ${windowId} could not load its document: ${detail}`)
    this.readyByWindow.get(windowId)?.fail(`Workspace window could not load: ${windowId}`)
  }

  private windowClosed(windowId: string): void {
    for (const [sender, registeredWindowId] of this.senders)
      if (registeredWindowId === windowId)
        this.senders.delete(sender)
    this.lifecycle.set(windowId, 'closed')
    this.readyByWindow.get(windowId)?.release()
    // And then dropped. Three registries kept an entry for every window ever opened - every holder
    // gets a fresh `randomUUID`, so `broadcast` walked the dead ones on every event. `main` stays,
    // because it is recreated under the same id and its lifecycle is read while it is gone.
    this.readyByWindow.delete(windowId)
    if (windowId !== 'main') {
      this.windows.delete(windowId)
      this.lifecycle.delete(windowId)
    }
    if (windowId !== 'main' && !this.quitting)
      // Guarded, because everything after it is the teardown: the panel index still naming this
    // window as owner means its sessions can never be claimed again, and the grants it held are
    // never revoked. A locked or full state file is a report, not a reason to strand all that.
    try {
      this.store.markExtraWindowClosed(windowId)
    } catch (error) {
      this.deps.report(`The closed window ${windowId} could not be recorded: ${ErrorText.of(error)}`)
    }
    this.deps.onClosed(windowId)
  }
}
