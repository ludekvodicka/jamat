import type { AppContext } from '../appContext'
import type { WindowBoundsKey } from '../clientState/clientStateStore'
import { ShellWindowBase, type ShellWindowDeps, type ShellWindowEntry } from './shellWindowBase'

export class UsageWindow extends ShellWindowBase {
  private readonly context: AppContext

  constructor(context: AppContext, deps: ShellWindowDeps) {
    super(deps)
    this.context = context
  }

  open(): void {
    if (this.liveWindow() !== null) this.focus()
    else this.createWindow()
  }

  protected boundsKey(): WindowBoundsKey { return 'usage' }
  protected windowTitle(): string { return 'Jamat Usage' }
  protected defaultSize(): { width: number; height: number } { return { width: 1100, height: 800 } }
  protected entry(): ShellWindowEntry {
    return { preloadPath: this.context.preloadPath, devUrl: this.context.usageRendererDevUrl,
      filePath: this.context.usageRendererPath }
  }
}
