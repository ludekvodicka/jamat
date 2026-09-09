import type { WebContents } from 'electron'

import type { AppInfo } from '../../shared/appClientUiIpc'
import type { ClientStateStore } from '../clientState/clientStateStore'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

/** The shell's share of the named allowlist: the window, its state, and nothing else. */
export class ServiceShellIpc extends ServiceIpcBase<typeof ServiceShellIpc.channelsConst> {
  /**
   * The contract as data, and only this service's part of it. AppHub proves the parts add up to the
   * whole map, so a channel added to the contract with no service to own it still stops the boot.
   */
  static readonly channelsConst = {
    'app:info': true,
    'app:renderer-ready': true,
    'state:load-layout': true,
    'state:save-layout': true,
    'state:clear-layout': true,
    'state:load-sidebars': true,
    'state:save-sidebars': true,
    'state:load-sessions-view': true,
    'state:save-sessions-view': true,
    'state:load-session-filters': true,
    'state:save-session-filters': true,
    'state:load-new-session-agent': true,
    'state:save-new-session-agent': true,
  } as const

  constructor(
    private readonly appInfo: AppInfo,
    private readonly store: ClientStateStore,
    private readonly windowIdOf: (sender: WebContents) => string | null,
    private readonly onRendererReady: (sender: WebContents) => void,
  ) {
    super()
  }

  /** An unregistered sender is refused here, the way the two services beside this one refuse one. */
  private requireWindowId(sender: WebContents): string {
    const windowId = this.windowIdOf(sender)
    if (windowId === null)
      throw new Error('Layout state was requested by an unknown workspace renderer')
    return windowId
  }

  initialize(): void {
    this.register('app:info', () => this.appInfo)
    this.register('app:renderer-ready', (event) => void this.onRendererReady(event.sender))
    // These three are per WINDOW, so an unregistered sender is refused rather than taken for
    // main - the two services beside this one both refuse one. One preload serves the Debug
    // window too, and its renderer is in no window registry, so the fallback made every layout
    // it ever wrote or cleared the MAIN window's.
    this.register('state:load-layout', (event) =>
      this.store.loadLayout(this.requireWindowId(event.sender)))
    this.register('state:save-layout', (event, layout) =>
      this.store.saveLayout(this.requireWindowId(event.sender), layout))
    this.register('state:clear-layout', (event) =>
      this.store.clearLayout(this.requireWindowId(event.sender)))
    this.register('state:load-sidebars', () => this.store.loadSidebars())
    this.register('state:save-sidebars', (_event, sidebars) => this.store.saveSidebars(sidebars))
    this.register('state:load-sessions-view', () => this.store.loadSessionsView())
    this.register('state:save-sessions-view', (_event, view) => this.store.saveSessionsView(view))
    this.register('state:load-session-filters', (event) => {
      this.requireWindowId(event.sender)
      return this.store.loadSessionFilters()
    })
    this.register('state:save-session-filters', (event, filters) => {
      if (this.requireWindowId(event.sender) !== 'main')
        throw new Error('Only the main window can save session filters')
      return this.store.saveSessionFilters(filters)
    })
    this.register('state:load-new-session-agent', () => this.store.loadNewSessionAgent())
    this.register('state:save-new-session-agent', (_event, agentId) =>
      this.store.saveNewSessionAgent(agentId))
    this.assertComplete(ServiceShellIpc.channelsConst)
  }
}
