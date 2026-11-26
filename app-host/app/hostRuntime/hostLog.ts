import { appendFileSync, renameSync, statSync } from 'node:fs'

import { AtomicJsonFile } from '../shared/atomicJsonFile.js'
import type { RuntimeChannel } from '../wire/hostWire.js'
import { HostStatePaths } from './hostStatePaths.js'

/**
 * One JSONL file, moved to `<file>.1` (replacing an older one) once it passes `rotateBytesConst`. It
 * had no limit and reached 68 MB, nearly all of it lease renewals.
 */
export class HostLog {
  static readonly rotateBytesConst = 16 * 1024 * 1024
  private readonly file: string
  private size: number

  constructor(configIdentity: string, channel: RuntimeChannel) {
    const directory = HostStatePaths.directory(configIdentity, channel)
    AtomicJsonFile.ensureDirectory(directory)
    this.file = HostStatePaths.log(configIdentity, channel)
    this.size = HostLog.sizeOf(this.file)
  }

  // takes an already redacted message: AppContext.log redacts once for this sink and stdout together
  write(level: 'info' | 'warn' | 'error', message: string): void {
    if (this.size >= HostLog.rotateBytesConst) this.rotate()
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
    })}\n`
    appendFileSync(this.file, line, {
      encoding: 'utf8',
      mode: AtomicJsonFile.ownerOnlyFileMode(),
    })
    this.size += Buffer.byteLength(line)
  }

  private rotate(): void {
    try { renameSync(this.file, `${this.file}.1`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.size = 0
  }

  private static sizeOf(file: string): number {
    try { return statSync(file).size }
    catch { return 0 }
  }

  static redact(value: string): string {
    return value
      .replace(/\b[0-9a-f]{64}\b/gi, '[redacted-token]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  }
}
