import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type {
  RemoteControlMachineIdentity,
  RemoteControlPeerIdentity,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { RuntimeChannel } from '../../../lib-orchestrator/shared/configIdentity.types'
import { AtomicJsonFile } from '../../../lib-orchestrator/shared/atomicJsonFile'

interface RemoteEndpointIdentityDocument {
  schemaVersion: 1
  remoteComputerId: string
  remoteEndpointId: string
  configIdentity: string
  runtimeChannel: RuntimeChannel
}

export class RemoteEndpointIdentityStore {
  private constructor(private readonly document: RemoteEndpointIdentityDocument) {}

  static loadOrCreate(
    file: string,
    machine: RemoteControlMachineIdentity,
    configIdentity: string,
    runtimeChannel: RuntimeChannel,
    endpointId: () => string = randomUUID,
  ): RemoteEndpointIdentityStore {
    let document: RemoteEndpointIdentityDocument
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!RemoteEndpointIdentityStore.valid(parsed))
        throw new Error(`Remote endpoint identity at ${file} is invalid`)
      document = parsed
      if (document.remoteComputerId !== machine.remoteComputerId
        || document.configIdentity !== configIdentity
        || document.runtimeChannel !== runtimeChannel)
        throw new Error(`Remote endpoint identity at ${file} belongs to another AppClientUI`)
    } else {
      document = {
        schemaVersion: 1,
        remoteComputerId: machine.remoteComputerId,
        remoteEndpointId: endpointId(),
        configIdentity,
        runtimeChannel,
      }
      if (!RemoteEndpointIdentityStore.valid(document))
        throw new Error('Generated remote endpoint identity is invalid')
      AtomicJsonFile.ensureDirectory(dirname(file))
      AtomicJsonFile.write(file, document)
    }
    return new RemoteEndpointIdentityStore(document)
  }

  identity(machine: RemoteControlMachineIdentity): RemoteControlPeerIdentity {
    if (machine.remoteComputerId !== this.document.remoteComputerId)
      throw new Error('Remote endpoint and machine identities disagree')
    return {
      ...machine,
      remoteEndpointId: this.document.remoteEndpointId,
      configIdentity: this.document.configIdentity,
      runtimeChannel: this.document.runtimeChannel,
      signing: { ...machine.signing },
    }
  }

  private static valid(value: unknown): value is RemoteEndpointIdentityDocument {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const document = value as Partial<RemoteEndpointIdentityDocument>
    return document.schemaVersion === 1
      && RemoteEndpointIdentityStore.text(document.remoteComputerId)
      && RemoteEndpointIdentityStore.text(document.remoteEndpointId)
      && RemoteEndpointIdentityStore.text(document.configIdentity)
      && (document.runtimeChannel === 'development' || document.runtimeChannel === 'production')
  }

  private static text(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 512
  }
}
