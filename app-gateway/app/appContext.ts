import { join } from 'node:path'
import { HostDescriptorPaths } from '../../lib-orchestrator/hostClient/hostDescriptorPaths'
import { ControllerLeaseKeeper } from '../../lib-orchestrator/hostClient/controllerLeaseKeeper'
import type { ProcessIdentity } from '../../lib-orchestrator/shared/processWire.types'

export class GatewayAppContext {
  readonly lockFile: string
  readonly perfDirectory: string
  readonly profilesDirectory: string
  readonly hostDescriptorFile: string
  readonly controllerId: string

  constructor(identity: ProcessIdentity) {
    this.lockFile = join(identity.stateDirectory, 'gateway.lock')
    this.perfDirectory = join(identity.stateDirectory, 'perf')
    this.profilesDirectory = join(this.perfDirectory, 'profiles')
    this.hostDescriptorFile = HostDescriptorPaths.descriptorFile(identity.configIdentity, identity.channel)
    this.controllerId = ControllerLeaseKeeper.controllerId(identity.configIdentity, identity.channel)
  }
}
