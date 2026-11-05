import type { WebContents } from 'electron'

import { ElectronServiceIpcBase } from '../shell/electronServiceIpcBase'
import type { AutolauncherPort } from '../../../lib-orchestrator/clientApi/autolauncher'

export class ServiceAutolauncherIpc extends ElectronServiceIpcBase<typeof ServiceAutolauncherIpc.channelsConst> {
  static readonly channelsConst = {
    'autolauncher:get': true, 'autolauncher:enable': true, 'autolauncher:disable': true,
    'autolauncher:inspect': true,
  } as const
  private readonly manager: AutolauncherPort
  private readonly acceptsRenderer: (sender: WebContents) => boolean

  constructor(manager: AutolauncherPort, acceptsRenderer: (sender: WebContents) => boolean) {
    super()
    this.manager = manager
    this.acceptsRenderer = acceptsRenderer
  }

  initialize(): void {
    this.register('autolauncher:get', event => {
      this.assertSender(this.sender(event))
      return this.manager.get()
    })
    this.register('autolauncher:inspect', (event, recipe) => {
      this.assertSender(this.sender(event))
      return this.manager.inspect(recipe)
    })
    this.register('autolauncher:enable', (event, invitation, selection) => {
      this.assertSender(this.sender(event))
      return this.manager.enable(invitation, selection)
    })
    this.register('autolauncher:disable', event => {
      this.assertSender(this.sender(event))
      return this.manager.disable()
    })
    this.assertComplete(ServiceAutolauncherIpc.channelsConst)
  }

  private assertSender(sender: WebContents): void {
    if (!this.acceptsRenderer(sender)) throw new Error('Only a Jamat settings window can configure the launcher.')
  }
}
