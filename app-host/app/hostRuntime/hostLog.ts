import { appendFileSync } from 'node:fs'

import { AtomicJsonFile } from '../shared/atomicJsonFile.js'
import type { RuntimeChannel } from '../wire/hostWire.js'
import { HostStatePaths } from './hostStatePaths.js'

export class HostLog {
  private readonly file: string

  constructor(configIdentity: string, channel: RuntimeChannel) {
    const directory = HostStatePaths.directory(configIdentity, channel)
    AtomicJsonFile.ensureDirectory(directory)
    this.file = HostStatePaths.log(configIdentity, channel)
  }

  // takes an already redacted message: AppContext.log redacts once for this sink and stdout together
  write(level: 'info' | 'warn' | 'error', message: string): void {
    appendFileSync(this.file, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
    })}\n`, {
      encoding: 'utf8',
      mode: AtomicJsonFile.ownerOnlyFileMode(),
    })
  }

  static redact(value: string): string {
    return value
      .replace(/\b[0-9a-f]{64}\b/gi, '[redacted-token]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  }
}
