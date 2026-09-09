import { join } from 'node:path'

import type { RuntimeChannel } from '../shared/configIdentity.types'
import { OrchestratorPaths } from '../shared/orchestratorPaths'

/**
 * Mirror of app-host's `HostStatePaths.descriptor()`. It lives here and not in
 * `shared/orchestratorPaths.ts` because knowing the layout of the Host's state is this subsystem's
 * job, while `shared/` holds what every subsystem imports.
 */
export class HostDescriptorPaths {
  private static readonly scopeNameConst = 'host'
  private static readonly descriptorFileNameConst = 'descriptor.json'

  static descriptorFile(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      HostDescriptorPaths.scopeRoot(),
      configIdentity,
      channel,
      HostDescriptorPaths.descriptorFileNameConst,
    )
  }

  // The override names the scope ROOT, never one channel's directory: consuming it verbatim
  // collapses both channels onto one descriptor, and a client then reads the other channel's Host.
  // Public because `scripts/dev/capture-workstate.ts` walks every identity and channel under it: it
  // is looking for the Host a person happens to be using, so it cannot name one descriptor.
  static scopeRoot(): string {
    return process.env.JAMAT_V3_HOST_STATE_DIR
      ?? join(OrchestratorPaths.machineRoot(), HostDescriptorPaths.scopeNameConst)
  }
}
