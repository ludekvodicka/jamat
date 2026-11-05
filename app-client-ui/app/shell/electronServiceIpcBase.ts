import type { WebContents } from 'electron'
import { ServiceIpcBase, type IpcChannelSet } from '../shared/serviceIpcBase'
import type { ServiceCaller } from '../shared/serviceTransport.types'

export interface ElectronCallerAccess {
  sender(caller: ServiceCaller): WebContents
}

export abstract class ElectronServiceIpcBase<TChannels extends IpcChannelSet> extends ServiceIpcBase<TChannels> {
  private callerAccess: ElectronCallerAccess | undefined

  constructor() {
    super()
    this.callerAccess = undefined
  }

  setCallerAccess(access: ElectronCallerAccess): this {
    this.callerAccess = access
    return this
  }

  protected sender(caller: ServiceCaller): WebContents {
    if (!this.callerAccess) throw new Error('Native caller access is not configured')
    return this.callerAccess.sender(caller)
  }

}
