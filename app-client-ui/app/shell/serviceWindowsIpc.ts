import type { WebContents } from 'electron'

import type { WindowAppearance, WindowInfo } from '../../shared/windowInfo'
import type { ClientStateStore } from '../clientState/clientStateStore'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import { WindowAppearanceRules } from './windowAppearance'
import { WindowIcon } from './windowIcon'
import type { WorkspaceWindows } from './workspaceWindows'

/** Renderer identity and the appearance mutation authorized to that renderer's own window. */
export class ServiceWindowsIpc extends ServiceIpcBase<typeof ServiceWindowsIpc.channelsConst> {
  static readonly channelsConst = {
    'shell:window-info': true,
    'window:save-appearance': true,
  } as const

  constructor(
    private readonly windows: WorkspaceWindows,
    private readonly store: ClientStateStore,
    private readonly onAppearanceChanged: () => void = () => undefined,
  ) {
    super()
  }

  initialize(): void {
    this.register('shell:window-info', (event) => this.infoOf(event.sender))
    this.register('window:save-appearance', (event, appearance) =>
      this.saveAppearance(event.sender, appearance))
    this.assertComplete(ServiceWindowsIpc.channelsConst)
  }

  private infoOf(sender: WebContents): WindowInfo {
    const windowId = this.windows.windowIdOf(sender)
    const role = this.windows.roleOf(sender)
    if (windowId === null || role === null)
      throw new Error('Window info was requested by an unknown workspace renderer')
    return { windowId, role, ...this.store.loadWindowAppearance(windowId) }
  }

  private saveAppearance(sender: WebContents, raw: WindowAppearance): WindowInfo {
    const windowId = this.windows.windowIdOf(sender)
    if (windowId === null || !this.windows.acceptsRenderer(sender))
      throw new Error('Window appearance was sent by a renderer that is not accepting work')
    const role = this.windows.roleOf(sender)
    if (role === null)
      throw new Error('Window appearance was sent by an unknown workspace renderer')
    const appearance = WindowAppearanceRules.normalize(raw)
    const icon = WindowIcon.of(appearance.color)
    if (!this.store.saveWindowAppearance(windowId, appearance))
      throw new Error('The client state refused window appearance')
    const info = { windowId, role, ...appearance }
    const window = this.windows.window(windowId)
    if (window === null)
      throw new Error(`Workspace window disappeared while saving appearance: ${windowId}`)
    window.setAppearance(info, icon)
    this.windows.publishTo(windowId, 'window:changed')
    this.onAppearanceChanged()
    return info
  }
}
