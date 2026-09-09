import { BrowserWindow, screen, type Rectangle } from 'electron'

import type { AppClientUiEventArgs, AppClientUiIpcEventMap } from '../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import { ErrorText } from '../../shared/errorText'
import type {
  ClientStateStore,
  WindowBounds,
  WindowBoundsKey,
} from '../clientState/clientStateStore'

interface RestoredBounds {
  /** null = no usable stored rectangle; Electron places a default-sized window itself. */
  rectangle: Rectangle | null
  maximized: boolean
}

/** What this window loads: the document, the dev server's copy of it, and the one bridge. */
export interface ShellWindowEntry {
  preloadPath: string
  devUrl: string | undefined
  filePath: string
}

export interface ShellWindowDeps {
  store: ClientStateStore
  /** Wired at init: what polls behind the window slows down while nobody is looking at it. */
  onVisibilityChanged?: (visible: boolean) => void
  onClosed?: () => void
}

/**
 * A window of this shell: secure by construction, remembering where it was, saying whether it can be
 * seen. One concern, and the reason it is a base rather than a copy is that every rule in here has to
 * hold for every window - a second window with its own copy of the sandbox flags, the navigation
 * guard or the placement arithmetic is a second window where a fix lands in one of the two.
 *
 * What a subclass adds is what differs between windows: which document it loads, what it is called,
 * how big it opens and under which key its bounds are stored.
 */
export abstract class ShellWindowBase {
  /** Held equal to the background token: a different value flashes through until the first paint. */
  protected static readonly backgroundColorConst = '#101318'
  private static readonly minimumSizeConst = { width: 820, height: 560 }
  private static readonly boundsDebounceMillisecondsConst = 400
  private window: BrowserWindow | null = null
  private boundsTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: ShellWindowDeps) {}

  /** The second instance's answer: this process owns the state, so it shows the window it already has. */
  focus(): void {
    const window = this.window
    if (!window || window.isDestroyed())
      return
    if (window.isMinimized())
      window.restore()
    window.show()
    window.focus()
  }

  /** Closing is a window going away, not a client detaching: nothing else is stopped by it. */
  close(): void {
    if (this.window && !this.window.isDestroyed())
      this.window.close()
  }

  /** Whether this is the window the user is in, which is what a reload is asked about. */
  focused(): boolean {
    return this.liveWindow()?.isFocused() ?? false
  }

  /** Debug → Reload. Deliberately not Electron's reload role, which would take Ctrl+R from the shell. */
  reload(): void {
    this.liveWindow()?.webContents.reload()
  }

  /**
   * The two `isDestroyed` checks are not the whole of it: `send` also throws for a handle that is
   * still alive while its render frame has already gone, which is an ordinary moment during a
   * crash or a reload. One window in that moment must not stop a broadcast reaching the others,
   * and must not travel back out through the library callback that started it - `AppHub.report`
   * broadcasts, so a throw here can arrive inside the error path of the thing being reported.
   */
  publish<K extends keyof AppClientUiIpcEventMap>(
    channel: K,
    ...args: AppClientUiEventArgs<K>
  ): void {
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed())
      return
    try {
      this.window.webContents.send(channel, ...args)
    } catch (error) {
      AppClientUiReport.error(`${channel} did not reach a window: ${ErrorText.of(error)}`)
    }
  }

  protected abstract boundsKey(): WindowBoundsKey
  protected abstract windowTitle(): string
  protected abstract entry(): ShellWindowEntry
  protected abstract defaultSize(): { width: number; height: number }

  /** Hook for what a subclass has to subscribe before the load starts, and nothing else. */
  protected onCreated(_window: BrowserWindow): void {}

  /**
   * The whole of it: stored placement, the security flags, the two navigation guards, the debounced
   * bounds save with its flush on close, and the visibility reporting. A subclass calls this and
   * gets a window every rule above already applies to.
   */
  protected createWindow(): BrowserWindow {
    const restored = ShellWindowBase.restoreBounds(
      this.deps.store.loadWindowBounds(this.boundsKey()),
      screen.getAllDisplays().map((display) => display.workArea),
    )
    const entry = this.entry()
    const window = new BrowserWindow({
      ...(restored.rectangle ?? this.defaultSize()),
      minWidth: ShellWindowBase.minimumSizeConst.width,
      minHeight: ShellWindowBase.minimumSizeConst.height,
      title: this.windowTitle(),
      backgroundColor: ShellWindowBase.backgroundColorConst,
      webPreferences: {
        preload: entry.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    this.window = window
    if (restored.maximized)
      window.maximize()
    window.webContents.on('render-process-gone', (_event, details) =>
      AppClientUiReport.error(
        `renderer gone: ${details.reason} (exitCode ${details.exitCode})`,
      ))
    window.webContents.on('preload-error', (_event, path, error) =>
      AppClientUiReport.error(`preload failed: ${path}: ${error.message}`))
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => {
      if (!ShellWindowBase.sameOrigin(url, entry.devUrl))
        event.preventDefault()
    })
    window.on('resize', () => this.scheduleBoundsSave())
    window.on('move', () => this.scheduleBoundsSave())
    window.on('maximize', () => this.scheduleBoundsSave())
    window.on('unmaximize', () => this.scheduleBoundsSave())
    // Only the four events that change whether anything of the window is on screen. Focus is not
    // among them: a window behind another one is still being looked at, and treating an alt-tab as
    // hidden would stall every reading the user came back to read.
    window.on('show', () => this.reportVisibility())
    window.on('hide', () => this.reportVisibility())
    window.on('minimize', () => this.reportVisibility())
    window.on('restore', () => this.reportVisibility())
    // Once for the state the window is already in. Electron shows it inside the constructor
    // above, so the first `show` fired before any of these listeners existed - and the Debug
    // window has no second path to say it is on screen, which left its own ping loop shut.
    this.reportVisibility()
    // The last drag before the window closes would otherwise die with the pending timer.
    window.on('close', () => this.flushBoundsSave())
    window.on('closed', () => {
      if (this.window !== window)
        return
      this.window = null
      // A window that is gone can be seen by nobody, and whoever throttles on that has to hear it
      // here: `hide` does not fire on a close.
      this.deps.onVisibilityChanged?.(false)
      this.deps.onClosed?.()
    })
    // Before the load, so an outcome that arrives early is not missed by a subclass waiting for it.
    this.onCreated(window)
    const started = entry.devUrl
      ? window.loadURL(entry.devUrl)
      : window.loadFile(entry.filePath)
    // Both reject on the same failures a subclass may be listening for, and on an ERR_ABORTED when a
    // second load supersedes this one. Unclaimed, that rejection is an unhandled rejection in the
    // main process.
    void started.catch((error: unknown) =>
      AppClientUiReport.error(`renderer load failed: ${ErrorText.of(error)}`))
    return window
  }

  /** Null once the window is gone, which is the only state a caller must handle. */
  protected liveWindow(): BrowserWindow | null {
    if (!this.window || this.window.isDestroyed())
      return null
    return this.window
  }

  /** The work areas are a parameter, not a `screen` read, so the placement rules are pure. */
  private static restoreBounds(
    stored: WindowBounds | null,
    workAreas: readonly Rectangle[],
  ): RestoredBounds {
    if (!stored) return { rectangle: null, maximized: false }
    const rectangle: Rectangle = {
      x: stored.x,
      y: stored.y,
      width: Math.max(stored.width, ShellWindowBase.minimumSizeConst.width),
      height: Math.max(stored.height, ShellWindowBase.minimumSizeConst.height),
    }
    // A window restored onto a monitor that is no longer attached is invisible and unreachable, so
    // an off-screen rectangle falls back to the default placement.
    if (!ShellWindowBase.intersectsAny(rectangle, workAreas))
      return { rectangle: null, maximized: stored.maximized }
    return { rectangle, maximized: stored.maximized }
  }

  private static intersectsAny(
    rectangle: Rectangle,
    workAreas: readonly Rectangle[],
  ): boolean {
    return workAreas.some((workArea) =>
      rectangle.x < workArea.x + workArea.width
      && workArea.x < rectangle.x + rectangle.width
      && rectangle.y < workArea.y + workArea.height
      && workArea.y < rectangle.y + rectangle.height)
  }

  /** Minimized is asked separately: Windows reports a minimized window as visible. */
  private reportVisibility(): void {
    const window = this.window
    if (!window || window.isDestroyed())
      return
    this.deps.onVisibilityChanged?.(window.isVisible() && !window.isMinimized())
  }

  private scheduleBoundsSave(): void {
    if (this.boundsTimer)
      clearTimeout(this.boundsTimer)
    this.boundsTimer = setTimeout(() => {
      this.boundsTimer = null
      this.saveBounds()
    }, ShellWindowBase.boundsDebounceMillisecondsConst)
  }

  private flushBoundsSave(): void {
    if (this.boundsTimer) {
      clearTimeout(this.boundsTimer)
      this.boundsTimer = null
    }
    this.saveBounds()
  }

  private saveBounds(): void {
    const window = this.window
    if (!window || window.isDestroyed())
      return
    const maximized = window.isMaximized()
    // A maximized window reports the screen rectangle; storing it would lose the restored size.
    const bounds = maximized ? window.getNormalBounds() : window.getBounds()
    try {
      this.deps.store.saveWindowBounds(this.boundsKey(), { ...bounds, maximized })
    } catch (error) {
      AppClientUiReport.error(`window bounds not stored: ${ErrorText.of(error)}`)
    }
  }

  private static sameOrigin(url: string, allowed: string | undefined): boolean {
    if (!allowed)
      return false
    try {
      return new URL(url).origin === new URL(allowed).origin
    } catch {
      return false
    }
  }
}
