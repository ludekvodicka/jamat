import { lstatSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import {
  RemoteControlInstanceRegistration,
  type RemoteControlInstanceRegistration as RemoteControlInstanceRegistrationValue,
  RemoteControlInstanceRegistry,
} from '../../../lib-orchestrator/remoteControl/remoteControlInstanceRegistry'
import { AtomicJsonFile } from '../../../lib-orchestrator/shared/atomicJsonFile'
import { ErrnoCode } from '../../../lib-orchestrator/shared/errnoCode'

export class RemoteControlInstanceStore {
  private readonly file: string

  constructor(file: string) { this.file = file }

  write(value: RemoteControlInstanceRegistrationValue): void {
    const validated = RemoteControlInstanceRegistration.validate(value)
    if (validated === null)
      throw new Error('Remote control instance registration is invalid')
    AtomicJsonFile.ensureDirectory(dirname(this.file))
    this.removeDead()
    AtomicJsonFile.write(this.file, validated)
  }

  removeIfOwned(instanceId: string): void {
    const current = RemoteControlInstanceStore.read(this.file)
    if (current?.instanceId !== instanceId) return
    try { unlinkSync(this.file) } catch {}
  }

  private removeDead(): void {
    for (const entry of readdirSync(dirname(this.file), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const file = join(dirname(this.file), entry.name)
      const registration = RemoteControlInstanceStore.read(file)
      if (registration === null || basename(RemoteControlInstanceRegistry.fileOf(registration.configIdentity,
        registration.runtimeChannel, registration.instanceId, registration.startedAt)) !== entry.name) continue
      try { process.kill(registration.pid, 0) }
      catch (error) {
        // Only ESRCH proves death. Permission failures and reused live PIDs retain their entry.
        if (ErrnoCode.of(error) === 'ESRCH') new RemoteControlInstanceStore(file).removeIfOwned(registration.instanceId)
      }
    }
  }

  private static read(file: string): RemoteControlInstanceRegistrationValue | null {
    try {
      const stats = lstatSync(file)
      if (!stats.isFile()
        || stats.isSymbolicLink()
        || stats.size > RemoteControlInstanceRegistry.entryBytesMaximumConst)
        return null
      return RemoteControlInstanceRegistration.validate(JSON.parse(readFileSync(file, 'utf8')))
    } catch { return null }
  }
}
