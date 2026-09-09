import { AppIdentity } from '../../shared/appIdentity'
import type { BrowserWindow, Event as ElectronEvent, NativeImage } from 'electron'

import type { WindowInfo, WindowRole } from '../../shared/windowInfo'
import type { AppContext } from '../appContext'
import type { WindowBoundsKey } from '../clientState/clientStateStore'
import { ShellWindowBase, type ShellWindowDeps, type ShellWindowEntry } from './shellWindowBase'
import { WindowIcon } from './windowIcon'

export interface WorkspaceWindowDeps extends ShellWindowDeps {
  onWindowCreated(window: BrowserWindow): void
  onCloseRequested(event: ElectronEvent): void
}

/** One renderer window that can hold workspace panels. Its process identity is its window id. */
export class WorkspaceWindow extends ShellWindowBase {
  private static readonly defaultSizeConst = { width: 1440, height: 900 }
  private loadOutcome: Promise<void> | null = null

  constructor(
    private readonly context: AppContext,
    readonly windowId: string,
    private readonly workspaceDeps: WorkspaceWindowDeps,
  ) {
    super(workspaceDeps)
  }

  role(): WindowRole {
    return this.windowId === 'main' ? 'main' : 'holder'
  }

  create(): void {
    const appearance = this.workspaceDeps.store.loadWindowAppearance(this.windowId)
    const icon = WindowIcon.of(appearance.color)
    this.createWindow()
    this.setAppearance({ windowId: this.windowId, role: this.role(), ...appearance }, icon)
  }

  whenLoaded(): Promise<void> {
    if (!this.loadOutcome)
      return Promise.reject(new Error('No window to load'))
    return this.loadOutcome
  }

  windowHandle(): BrowserWindow | null {
    return this.liveWindow()
  }

  setAppearance(info: WindowInfo, icon: NativeImage): void {
    if (info.windowId !== this.windowId || info.role !== this.role())
      throw new Error(`Window appearance belongs to another window: ${JSON.stringify(info)}`)
    const window = this.liveWindow()
    if (window === null)
      throw new Error(`Cannot apply appearance to a closed window: ${this.windowId}`)
    window.setTitle(AppIdentity.titleOf(info.name))
    window.setIcon(icon)
  }

  protected boundsKey(): WindowBoundsKey {
    return this.windowId === 'main' ? 'main' : { extraWindowId: this.windowId }
  }

  protected windowTitle(): string {
    return AppIdentity.nameConst
  }

  protected entry(): ShellWindowEntry {
    return {
      preloadPath: this.context.preloadPath,
      devUrl: this.context.rendererDevUrl,
      filePath: this.context.rendererPath,
    }
  }

  protected defaultSize(): { width: number; height: number } {
    return WorkspaceWindow.defaultSizeConst
  }

  protected onCreated(window: BrowserWindow): void {
    this.loadOutcome = WorkspaceWindow.loadOutcomeOf(window)
    window.on('close', (event) => this.workspaceDeps.onCloseRequested(event))
    window.on('app-command', (event, command) => {
      if (command !== 'browser-backward')
        return
      event.preventDefault()
      this.publish('menu:command', 'view.fileBack')
    })
    this.workspaceDeps.onWindowCreated(window)
  }

  /** The outcome is subscribed before loading starts, including failures that still finish a page. */
  private static loadOutcomeOf(window: BrowserWindow): Promise<void> {
    const outcome = new Promise<void>((resolve, reject) => {
      window.webContents.once('did-finish-load', () => resolve())
      window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame)
          reject(new Error(`Renderer failed to load: ${description} (${code})`))
      })
      window.webContents.on('preload-error', (_event, preloadPath, error) => {
        reject(new Error(`Preload failed at ${preloadPath}: ${error.message}`))
      })
      window.webContents.on('render-process-gone', (_event, details) => {
        reject(new Error(`Renderer process gone: ${details.reason}`))
      })
    })
    void outcome.catch(() => {})
    return outcome
  }
}
