import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { Session } from 'node:inspector/promises'
import { join } from 'node:path'
import type { PerfProcess } from './perfRecord.types'

export interface PerfProfilerPort {
  record(seconds: number): Promise<string>
}

export class PerfProfiler implements PerfProfilerPort {
  private readonly directory: string
  private readonly process: PerfProcess

  constructor(directory: string, process: PerfProcess) {
    this.directory = directory
    this.process = process
  }

  async record(seconds: number): Promise<string> {
    const session = new Session()
    try {
      session.connect()
      await session.post('Profiler.enable')
      await session.post('Profiler.start')
      await new Promise<void>(resolve => setTimeout(resolve, seconds * 1_000))
      const { profile } = await session.post('Profiler.stop')
      const profileId = `${this.process.replace(':', '-')}-${Date.now()}-${randomUUID()}.cpuprofile`
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const file = join(this.directory, profileId)
      try { await writeFile(file, JSON.stringify(profile), { flag: 'wx', mode: 0o600 }) }
      catch (error) { await unlink(file).catch(() => {}); throw error }
      return profileId
    } finally { session.disconnect() }
  }
}
