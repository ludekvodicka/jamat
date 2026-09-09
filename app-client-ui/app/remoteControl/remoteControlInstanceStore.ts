import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  RemoteControlInstanceRegistration,
  type RemoteControlInstanceRegistration as RemoteControlInstanceRegistrationValue,
  RemoteControlInstanceRegistry,
} from '../../../lib-orchestrator/remoteControl/remoteControlInstanceRegistry'
import { AtomicJsonFile } from '../../../lib-orchestrator/shared/atomicJsonFile'

export class RemoteControlInstanceStore {
  constructor(private readonly file: string) {}

  write(value: RemoteControlInstanceRegistrationValue): void {
    const validated = RemoteControlInstanceRegistration.validate(value)
    if (validated === null)
      throw new Error('Remote control instance registration is invalid')
    AtomicJsonFile.ensureDirectory(dirname(this.file))
    AtomicJsonFile.write(this.file, validated)
  }

  removeIfOwned(instanceId: string): void {
    try {
      const stats = lstatSync(this.file)
      if (!stats.isFile()
        || stats.isSymbolicLink()
        || stats.size > RemoteControlInstanceRegistry.entryBytesMaximumConst)
        return
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      const current = RemoteControlInstanceRegistration.validate(parsed)
      if (current?.instanceId !== instanceId) return
      unlinkSync(this.file)
    } catch {}
  }
}
