import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { RemoteControlMachineIdentity } from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { RemoteControlPeerIdentityValidation } from '../../../lib-orchestrator/remoteControl/remoteControlPeerIdentityValidation'
import { AtomicJsonFile } from '../../../lib-orchestrator/shared/atomicJsonFile'
import { JsonShape } from '../../../lib-orchestrator/shared/jsonShape'

interface RemoteMachineIdentityDocument extends RemoteControlMachineIdentity {
  schemaVersion: 1
}

export class RemoteMachineIdentityStore {
  constructor(private readonly file: string) {}

  read(): RemoteControlMachineIdentity | null {
    if (!existsSync(this.file)) return null
    const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
    if (!RemoteMachineIdentityStore.valid(parsed))
      throw new Error(`Remote machine identity at ${this.file} is invalid`)
    return RemoteMachineIdentityStore.identityOf(parsed)
  }

  write(identity: RemoteControlMachineIdentity): void {
    // One object, validated and then written. It used to be built twice, in two key orders, so what
    // was checked and what was stored were only the same thing by coincidence.
    const document: RemoteMachineIdentityDocument = { ...identity, schemaVersion: 1 }
    if (!RemoteMachineIdentityStore.valid(document))
      throw new Error('Remote machine identity is invalid')
    AtomicJsonFile.ensureDirectory(dirname(this.file))
    AtomicJsonFile.write(this.file, document)
  }

  private static valid(value: unknown): value is RemoteMachineIdentityDocument {
    return JsonShape.isRecord(value)
      && value.schemaVersion === 1
      && RemoteControlPeerIdentityValidation.isMachine({
        remoteComputerId: value.remoteComputerId,
        displayName: value.displayName,
        signing: value.signing,
      })
  }

  private static identityOf(value: RemoteMachineIdentityDocument): RemoteControlMachineIdentity {
    return {
      remoteComputerId: value.remoteComputerId,
      displayName: value.displayName,
      signing: { ...value.signing },
    }
  }



}
