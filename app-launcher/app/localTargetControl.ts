import { randomUUID } from 'node:crypto'
import { RemoteControlDescriptorDiscovery } from '../../lib-orchestrator/remoteControl/remoteControlDescriptorDiscovery'
import { RemoteControlClient } from '../../lib-orchestrator/remoteControl/remoteControlClient'
import { RemoteControlConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore'
import type { ConfigIdentityDocument } from '../../lib-orchestrator/shared/configIdentity.types'

export class LocalTargetControl {
  private readonly configDir: string
  private readonly identity: ConfigIdentityDocument
  private pending: Promise<boolean> | null = null

  constructor(configDir: string, identity: ConfigIdentityDocument) {
    this.configDir = configDir
    this.identity = identity
  }

  ready(): Promise<boolean> {
    if (this.pending) return this.pending
    this.pending = this.probe().finally(() => { this.pending = null })
    return this.pending
  }

  private async probe(): Promise<boolean> {
    const stored = ConfigIdentityStore.readExisting(this.configDir)
    if (stored?.configIdentity !== this.identity.configIdentity || stored.runtimeChannel !== this.identity.runtimeChannel)
      throw new Error('Registered profile identity changed')
    const candidates = RemoteControlDescriptorDiscovery.registeredAndDefaultRootCandidates()
      .filter(({ descriptor }) => descriptor.configIdentity === this.identity.configIdentity
        && descriptor.runtimeChannel === this.identity.runtimeChannel)
    const live = await Promise.all(candidates.map(async ({ descriptor }) => {
      const answer = await new RemoteControlClient(descriptor, { timeoutMilliseconds: 1500 }).execute({
        protocol: RemoteControlConst.protocol, requestId: randomUUID(), operation: 'system.hello', body: {},
      })
      return answer.ok && answer.value.protocol === descriptor.protocol
        && answer.value.configIdentity === descriptor.configIdentity
        && answer.value.runtimeChannel === descriptor.runtimeChannel
        && answer.value.instanceId === descriptor.instanceId
        && answer.value.startedAt === descriptor.startedAt
        && answer.value.applicationVersion === descriptor.applicationVersion
    }))
    const count = live.filter(Boolean).length
    if (count > 1) throw new Error('Multiple matching AppClientUI instances')
    return count === 1
  }
}
