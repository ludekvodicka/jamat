import type { WebContents } from 'electron'

import { ServiceIpcBase } from '../shared/serviceIpcBase'
import type { AutolauncherManager } from './autolauncherManager'

export class ServiceAutolauncherIpc extends ServiceIpcBase<typeof ServiceAutolauncherIpc.channelsConst> {
  static readonly channelsConst = {
    'autolauncher:get': true, 'autolauncher:enable': true, 'autolauncher:disable': true,
  } as const
  private readonly manager: AutolauncherManager
  private readonly acceptsRenderer: (sender: WebContents) => boolean

  constructor(manager: AutolauncherManager, acceptsRenderer: (sender: WebContents) => boolean) {
    super()
    this.manager = manager
    this.acceptsRenderer = acceptsRenderer
  }

  initialize(): void {
    this.register('autolauncher:get', event => {
      this.assertSender(event.sender)
      return this.manager.get()
    })
    this.register('autolauncher:enable', (event, invitation) => {
      this.assertSender(event.sender)
      return this.manager.enable(invitation)
    })
    this.register('autolauncher:disable', event => {
      this.assertSender(event.sender)
      return this.manager.disable()
    })
    this.assertComplete(ServiceAutolauncherIpc.channelsConst)
  }

  private assertSender(sender: WebContents): void {
    if (!this.acceptsRenderer(sender)) throw new Error('Only a Jamat settings window can configure the launcher.')
  }
}
