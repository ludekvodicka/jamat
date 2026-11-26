import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonShape } from '../../shared/jsonShape'
import { AntigravityQuotaMapper } from '../antigravity/antigravityQuotaMapper'
import type { RateExternalReading } from '../rateMonitor'
import type { RateAccountKey, RateWindow } from '../rateMonitorApi.types'

type ParsedRateEntry =
  | {
    kind: 'antigravity'
    at: number
    launchId: string
    windows: readonly RateWindow[]
    extras: NonNullable<RateExternalReading['extras']>
    raw: unknown
  }
  | {
    kind: 'claude'
    at: number
    launchId: string
    windows: readonly RateWindow[]
  }

export interface StatusLineRateReaderOptions {
  sessionExists?: (sessionId: string) => boolean
  now?: () => number
  maxAgeMilliseconds?: number
}

export class StatusLineRateReader {
  static readonly maxAgeMillisecondsConst = 7 * 24 * 60 * 60 * 1000
  private static readonly maxFileBytesConst = 16_384

  private readonly directory: string
  private readonly accountFor: (sessionId: string, launchId: string, at: number) => RateAccountKey | null
  private readonly sessionExists: ((sessionId: string) => boolean) | undefined
  private readonly now: () => number
  private readonly maxAgeMilliseconds: number
  private readonly cache = new Map<string, { key: string; entry: ParsedRateEntry | null }>()

  constructor(
    directory: string,
    accountFor: (sessionId: string, launchId: string, at: number) => RateAccountKey | null,
    options: StatusLineRateReaderOptions = {},
  ) {
    this.directory = directory
    this.accountFor = accountFor
    this.sessionExists = options.sessionExists
    this.now = options.now ?? Date.now
    this.maxAgeMilliseconds = options.maxAgeMilliseconds ?? StatusLineRateReader.maxAgeMillisecondsConst
  }

  async read(): Promise<readonly RateExternalReading[]> {
    let files: string[]
    try { files = await readdir(this.directory) } catch { return [] }
    const now = this.now()
    const present = new Set<string>()
    const readings: RateExternalReading[] = []
    for (const file of files) {
      if (!/^[0-9A-Za-z-]{1,64}\.json$/.test(file)) continue
      present.add(file)
      const sessionId = file.slice(0, -5)
      const path = join(this.directory, file)
      try {
        if (this.sessionExists !== undefined && !this.sessionExists(sessionId)) {
          await unlink(path).catch(() => undefined)
          this.cache.delete(file)
          continue
        }
        const info = await stat(path)
        if (now - info.mtimeMs >= this.maxAgeMilliseconds) {
          await unlink(path).catch(() => undefined)
          this.cache.delete(file)
          continue
        }
        const statKey = `${info.mtimeMs}:${info.size}`
        let cached = this.cache.get(file)
        if (cached === undefined || cached.key !== statKey) {
          const entry = info.size > StatusLineRateReader.maxFileBytesConst
            ? null
            : StatusLineRateReader.parse(await readFile(path, 'utf8'))
          cached = { key: statKey, entry }
          this.cache.set(file, cached)
        }
        const parsed = cached.entry
        if (parsed === null) continue
        const key = this.accountFor(sessionId, parsed.launchId, parsed.at)
        if (key === null) continue
        if (parsed.kind === 'antigravity')
          readings.push({ key, at: parsed.at, windows: parsed.windows, extras: parsed.extras, raw: parsed.raw, source: 'statusline' })
        else if (parsed.kind === 'claude')
          readings.push({ key, at: parsed.at, windows: parsed.windows, source: 'statusline' })
        else
          throw new Error(`Unknown parsed rate entry kind: ${JSON.stringify(parsed satisfies never)}`)
      } catch { /* A relay can disappear between enumeration and read. */ }
    }
    for (const cachedFile of [...this.cache.keys()])
      if (!present.has(cachedFile)) this.cache.delete(cachedFile)
    return readings
  }

  private static parse(rawText: string): ParsedRateEntry | null {
    const value = JsonShape.record(JSON.parse(rawText))
    if (!value || value.schemaVersion !== 1 || typeof value.at !== 'number' || !Number.isFinite(value.at)
      || typeof value.launchId !== 'string') return null
    if (value.antigravityQuota !== undefined) {
      const planTier = typeof value.planTier === 'string' ? value.planTier : null
      const mapped = AntigravityQuotaMapper.map(value.antigravityQuota, value.at, planTier)
      if (mapped.windows.length === 0) return null
      return { kind: 'antigravity', at: value.at, launchId: value.launchId, windows: mapped.windows, extras: mapped.extras, raw: value.antigravityQuota }
    }
    const windows = StatusLineRateReader.windowsOf(value.rateLimits)
    if (windows.length === 0) return null
    return { kind: 'claude', at: value.at, launchId: value.launchId, windows }
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
