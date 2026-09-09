import type {
  HostDebugStatus,
  HostPingResult,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { DebugSectionId } from '../../shared/debugSections.types'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

export interface ServiceDebugIpcDeps {
  debugStatusOf: () => HostDebugStatus
  pingHost: () => Promise<HostPingResult>
  sectionActive: (section: DebugSectionId | null) => void
}

/**
 * The Debug window's share of the named allowlist: two reads and one report of what is on screen.
 * Three channels with three names, which is the whole design - V1's generic debug dispatcher handed
 * the renderer thirty-three of them, `file:write` included.
 *
 * Every handler is one delegation. Nothing is composed here, because what the subsystem holds is the
 * subsystem's to say.
 */
export class ServiceDebugIpc extends ServiceIpcBase<typeof ServiceDebugIpc.channelsConst> {
  static readonly channelsConst = {
    'debug:host-status': true,
    'debug:host-ping': true,
    'debug:section-active': true,
  } as const

  constructor(private readonly deps: ServiceDebugIpcDeps) {
    super()
  }

  initialize(): void {
    this.register('debug:host-status', () => this.deps.debugStatusOf())
    this.register('debug:host-ping', () => this.deps.pingHost())
    this.register('debug:section-active', (_event, section) => this.deps.sectionActive(section))
    this.assertComplete(ServiceDebugIpc.channelsConst)
  }
}
