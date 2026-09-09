import { AppIdentity } from '../../shared/appIdentity'
import type { AppContext } from '../appContext'
import type { WindowBoundsKey } from '../clientState/clientStateStore'
import { ShellWindowBase, type ShellWindowDeps, type ShellWindowEntry } from './shellWindowBase'

/**
 * The Debug window: a second document of the same renderer build, in a window of its own.
 *
 * A window rather than an overlay or a panel because what it shows is read WHILE working - beside the
 * workspace, on a second monitor, and outliving a renderer of the main window that has stopped
 * answering. It is not a child of the main window either: on Windows that would pin it above the
 * workspace forever. What ties the two together is that closing the workspace closes this one, which
 * the hub does, and not the window manager.
 */
export class DebugWindow extends ShellWindowBase {
  private static readonly defaultSizeConst = { width: 1100, height: 760 }

  constructor(private readonly context: AppContext, deps: ShellWindowDeps) {
    super(deps)
  }

  /** Create or focus. A second open shows the window that is already there, never a second one. */
  open(): void {
    if (this.liveWindow() !== null) {
      this.focus()
      return
    }
    this.createWindow()
  }

  protected boundsKey(): WindowBoundsKey {
    return 'debug'
  }

  protected windowTitle(): string {
    return AppIdentity.debugNameConst
  }

  protected entry(): ShellWindowEntry {
    return {
      // One preload serves both document entries; the bridge is a superset and each uses its part.
      preloadPath: this.context.preloadPath,
      devUrl: this.context.debugRendererDevUrl,
      filePath: this.context.debugRendererPath,
    }
  }

  protected defaultSize(): { width: number; height: number } {
    return DebugWindow.defaultSizeConst
  }
}
