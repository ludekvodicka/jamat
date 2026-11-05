import { readFileSync } from 'node:fs'
import { AtomicJsonFile } from '../../../lib-orchestrator/shared/atomicJsonFile'
import { ErrnoCode } from '../../../lib-orchestrator/shared/errnoCode'
import { JsonShape } from '../../../lib-orchestrator/shared/jsonShape'
import { JsonNumber } from '../../../lib-orchestrator/shared/jsonNumber'

export class RelaunchMarker {
  private readonly file: string

  constructor(file: string) { this.file = file }

  canRelaunch(at: number): boolean {
    let value: unknown
    try { value = JSON.parse(readFileSync(this.file, 'utf8')) }
    catch (error) {
      if (ErrnoCode.of(error) === 'ENOENT') return true
      throw error
    }
    const previous = JsonNumber.wholeCount(JsonShape.record(value)?.at)
    if (previous === null) throw new Error('Invalid child relaunch marker')
    // A backwards clock must not turn a recent crash into an unlimited restart loop.
    return at - previous >= 60_000
  }

  record(at: number): void { AtomicJsonFile.write(this.file, { at }) }
}
