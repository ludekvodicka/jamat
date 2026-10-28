import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonShape } from '../../shared/jsonShape'
import type { RateExternalReading } from '../rateMonitor'
import type { RateAccountKey, RateWindow } from '../rateMonitorApi.types'

export class StatusLineRateReader {
  private readonly directory: string
  private readonly accountFor: (sessionId: string, launchId: string, at: number) => RateAccountKey | null

  constructor(directory: string, accountFor: (sessionId: string, launchId: string, at: number) => RateAccountKey | null) {
    this.directory = directory
    this.accountFor = accountFor
  }

  async read(): Promise<readonly RateExternalReading[]> {
    let files: string[]
    try { files = await readdir(this.directory) } catch { return [] }
    const readings: RateExternalReading[] = []
    for (const file of files) {
      if (!/^[0-9A-Za-z-]{1,64}\.json$/.test(file)) continue
      try {
        const path = join(this.directory, file)
        if ((await stat(path)).size > 16_384) continue
        const value = JsonShape.record(JSON.parse(await readFile(path, 'utf8')))
        if (!value || value.schemaVersion !== 1 || typeof value.at !== 'number' || !Number.isFinite(value.at)
          || typeof value.launchId !== 'string') continue
        const key = this.accountFor(file.slice(0, -5), value.launchId, value.at)
        if (key === null) continue
        const windows = StatusLineRateReader.windowsOf(value.rateLimits)
        if (windows.length > 0) readings.push({ key, at: value.at, windows, source: 'statusline' })
      } catch { /* A relay can disappear between enumeration and read. */ }
    }
    return readings
  }

  static windowsOf(value: unknown): readonly RateWindow[] {
    const limits = JsonShape.record(value)
    if (limits === null) return []
    const windows: RateWindow[] = []
    for (const [name, durationMinutes] of [['five_hour', 300], ['seven_day', 10_080]] as const) {
      if (limits[name] === undefined) continue
      const window = JsonShape.record(limits[name])
      if (!window || typeof window.used_percentage !== 'number' || !Number.isFinite(window.used_percentage)
        || typeof window.resets_at !== 'number' || !Number.isFinite(window.resets_at)) return []
      const reset = new Date(window.resets_at * 1_000)
      if (!Number.isFinite(reset.getTime())) return []
      windows.push({ durationMinutes, usedPercent: window.used_percentage, resetsAt: reset.toISOString() })
    }
    return windows
  }
}
