import { join } from 'node:path'

import type { RuntimeChannel } from '../../../lib-orchestrator/shared/configIdentity.types'
import { RemoteControlDescriptorDiscovery } from '../../../lib-orchestrator/remoteControl/remoteControlDescriptorDiscovery'
import { OrchestratorPaths } from '../../../lib-orchestrator/shared/orchestratorPaths'

/** Machine-local paths for one client UI, in its own scope beside the Host's and the library's. */
export class ClientStatePaths {
  private static readonly scopeNameConst = 'client-ui'
  private static readonly stateFileNameConst = 'client-state.json'
  private static readonly snapshotsNameConst = 'snapshots'
  private static readonly toolsScopeNameConst = 'tools'
  private static readonly remarkableScopeNameConst = 'remarkable'
  private static readonly remarkableCredentialFileNameConst = 'credential.json'
  private static readonly remarkableRunsNameConst = 'runs'
  private static readonly remarkableImportsNameConst = 'imports'
  private static readonly controlAuditFileNameConst = 'remote-control-audit.jsonl'
  private static readonly remoteControlScopeNameConst = 'remote-control'
  private static readonly remoteMachineIdentityFileNameConst = 'machine-identity.json'
  private static readonly remotePeerCredentialsFileNameConst = 'peer-credentials.json'
  private static readonly remoteEndpointIdentityFileNameConst = 'remote-endpoint.json'
  private static readonly remotePairingBundleFileNameConst = 'remote-pairing.json'

  static machineRoot(): string {
    return OrchestratorPaths.machineRoot()
  }

  /** Disjoint from the Host's `host/` subtree under the same machine root. */
  static directory(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      ClientStatePaths.machineRoot(),
      ClientStatePaths.scopeNameConst,
      configIdentity,
      channel,
    )
  }

  static stateFile(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      ClientStatePaths.directory(configIdentity, channel),
      ClientStatePaths.stateFileNameConst,
    )
  }

  static snapshotsDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      ClientStatePaths.directory(configIdentity, channel),
      ClientStatePaths.snapshotsNameConst,
    )
  }

  static toolsDirectory(): string {
    return join(ClientStatePaths.machineRoot(), ClientStatePaths.toolsScopeNameConst)
  }

  static remarkableToolsDirectory(): string {
    return join(ClientStatePaths.toolsDirectory(), ClientStatePaths.remarkableScopeNameConst)
  }

  static remarkableDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      ClientStatePaths.directory(configIdentity, channel),
      ClientStatePaths.remarkableScopeNameConst,
    )
  }

  static remarkableCredentialFile(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      ClientStatePaths.remarkableDirectory(configIdentity, channel),
      ClientStatePaths.remarkableCredentialFileNameConst,
    )
  }

  static remarkableRunsDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      ClientStatePaths.remarkableDirectory(configIdentity, channel),
      ClientStatePaths.remarkableRunsNameConst,
    )
  }

  static remarkableImportsDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      ClientStatePaths.remarkableDirectory(configIdentity, channel),
      ClientStatePaths.remarkableImportsNameConst,
    )
  }

  /**
   * Asked of the READER rather than computed again here. This path is a rendezvous between two
   * processes - AppClientUI writes it, app-client-cli goes looking for it - and two copies of a
   * rendezvous only have to disagree once for the CLI to report that nothing is running.
   */
  static controlDescriptorFile(configIdentity: string, channel: RuntimeChannel): string {
    return RemoteControlDescriptorDiscovery.descriptorFile(configIdentity, channel)
  }

  static controlInstanceDescriptorFile(
    configIdentity: string,
    channel: RuntimeChannel,
    instanceId: string,
    startedAt: number,
  ): string {
    return RemoteControlDescriptorDiscovery.instanceDescriptorFile(
      configIdentity,
      channel,
      instanceId,
      startedAt,
    )
  }

  static controlAuditFile(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      ClientStatePaths.directory(configIdentity, channel),
      ClientStatePaths.controlAuditFileNameConst,
    )
  }

  static remoteControlMachineDirectory(): string {
    return join(ClientStatePaths.machineRoot(), ClientStatePaths.remoteControlScopeNameConst)
  }

  static remoteMachineIdentityFile(): string {
    return join(
      ClientStatePaths.remoteControlMachineDirectory(),
      ClientStatePaths.remoteMachineIdentityFileNameConst,
    )
  }

  static remotePeerCredentialsFile(): string {
    return join(
      ClientStatePaths.remoteControlMachineDirectory(),
      ClientStatePaths.remotePeerCredentialsFileNameConst,
    )
  }

  static remoteEndpointIdentityFile(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      ClientStatePaths.directory(configIdentity, channel),
      ClientStatePaths.remoteEndpointIdentityFileNameConst,
    )
  }

  static remotePairingBundleFile(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      ClientStatePaths.directory(configIdentity, channel),
      ClientStatePaths.remotePairingBundleFileNameConst,
    )
  }
}
