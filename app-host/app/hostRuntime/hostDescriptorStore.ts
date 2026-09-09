import { unlinkSync } from 'node:fs'

import { AtomicJsonFile } from '../shared/atomicJsonFile.js'
import type { HostDescriptor, RuntimeChannel } from '../wire/hostWire.js'
import { HostStatePaths } from './hostStatePaths.js'

export class HostDescriptorStore {
  constructor(
    private readonly configIdentity: string,
    private readonly channel: RuntimeChannel,
  ) {}

  write(descriptor: HostDescriptor): void {
    AtomicJsonFile.ensureDirectory(HostStatePaths.directory(this.configIdentity, this.channel))
    AtomicJsonFile.write(
      HostStatePaths.descriptor(this.configIdentity, this.channel),
      descriptor,
    )
  }

  remove(): void {
    try {
      unlinkSync(HostStatePaths.descriptor(this.configIdentity, this.channel))
    } catch {}
  }
}
