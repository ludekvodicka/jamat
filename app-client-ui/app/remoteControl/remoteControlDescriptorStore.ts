import { unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

import type { RemoteControlDescriptor } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { AtomicJsonFile } from '../../../lib-orchestrator/shared/atomicJsonFile'

export class RemoteControlDescriptorStore {
  constructor(private readonly file: string) {}

  write(descriptor: RemoteControlDescriptor): void {
    AtomicJsonFile.ensureDirectory(dirname(this.file))
    AtomicJsonFile.write(this.file, descriptor)
  }

  remove(): void {
    try { unlinkSync(this.file) } catch {}
  }
}
