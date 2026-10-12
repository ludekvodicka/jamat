import type { DebugSectionId } from '../../shared/debugSections.types'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

export interface ServiceDebugIpcDeps {
  sectionActive: (section: DebugSectionId | null) => void
}

/**
 * The Debug window's report of what is on screen. Its two reads of the Host are the control API's
 * `host.status` and `host.ping`; this one stays a channel because it describes the window itself.
 */
export class ServiceDebugIpc extends ServiceIpcBase<typeof ServiceDebugIpc.channelsConst> {
  static readonly channelsConst = {
    'debug:section-active': true,
  } as const

  constructor(private readonly deps: ServiceDebugIpcDeps) {
    super()
  }

  initialize(): void {
    this.register('debug:section-active', (_event, section) => this.deps.sectionActive(section))
    this.assertComplete(ServiceDebugIpc.channelsConst)
  }
}
