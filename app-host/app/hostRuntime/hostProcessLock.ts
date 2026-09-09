import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

import { AtomicJsonFile } from '../shared/atomicJsonFile.js'
import { ProcessStartIdentity } from '../shared/processStartIdentity.js'
import type { RuntimeChannel } from '../wire/hostWire.js'
import { HostStatePaths } from './hostStatePaths.js'

interface HostLockDocument {
  pid: number
  processStartedAt: number
  hostInstanceId: string
}

export type HostProcessLockResult =
  | { ok: true }
  | { ok: false; holder: HostLockDocument | null }

export class HostProcessLock {
  private readonly file: string

  constructor(
    configIdentity: string,
    channel: RuntimeChannel,
    private readonly own: HostLockDocument,
  ) {
    this.file = HostStatePaths.lock(configIdentity, channel)
  }

  acquire(): HostProcessLockResult {
    AtomicJsonFile.ensureDirectory(
      this.file.slice(0, Math.max(this.file.lastIndexOf('\\'), this.file.lastIndexOf('/'))),
    )
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const descriptor = openSync(this.file, 'wx', AtomicJsonFile.ownerOnlyFileMode())
        try { writeFileSync(descriptor, JSON.stringify(this.own), 'utf8') }
        finally { closeSync(descriptor) }
        return { ok: true }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const holder = this.read()
        if (!holder)
          return { ok: false, holder: null }
        const identity = ProcessStartIdentity.compare(
          holder.pid,
          holder.processStartedAt,
        )
        if (identity.state === 'same' || identity.state === 'unknown')
          return { ok: false, holder }
        else if (identity.state !== 'different' && identity.state !== 'dead')
          throw new Error(`Unknown process identity comparison: ${JSON.stringify(identity)}`)
        try { unlinkSync(this.file) } catch {}
      }
    }
    return { ok: false, holder: this.read() }
  }

  release(): void {
    const holder = this.read()
    if (holder?.hostInstanceId !== this.own.hostInstanceId) return
    try { unlinkSync(this.file) } catch {}
  }

  private read(): HostLockDocument | null {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<HostLockDocument>
      return Number.isInteger(parsed.pid)
        && typeof parsed.processStartedAt === 'number'
        && typeof parsed.hostInstanceId === 'string'
        ? parsed as HostLockDocument
        : null
    } catch {
      return null
    }
  }
}
