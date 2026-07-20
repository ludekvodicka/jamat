import { closeSync, createReadStream, openSync, readSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { createInterface } from 'readline'
import { costForTokens, modelRates } from '../core/pricing.js'
import type { MetricCoverage } from '../core/types/stats.js'
import {
  UsageFileCacheLoaderBase,
  type UsageFileCacheProgress,
  type UsageFileParseResult,
} from './cache/usageFileCacheLoaderBase.js'
import type { NormalizedUsageRecord } from './stats-view.js'

interface RawTokenUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

interface RolloutHeader {
  sessionId: string
  cwd: string
  originator: string
}

export interface CodexUsageLoadOptions {
  sessionsRoot?: string
  cacheFile: string
  onProgress?: (progress: CodexUsageLoaderProgress) => void
}

export interface CodexUsageLoaderProgress {
  kind: 'discover' | UsageFileCacheProgress['kind']
  current: number
  total: number
  cacheHits: number
  changedFiles: number
}

export interface CodexUsageLoadResult {
  records: NormalizedUsageRecord[]
  filesScanned: number
  filesParsed: number
  cacheHits: number
  changedFiles: number
  costCoverage: MetricCoverage
}

export class CodexUsageLoader extends UsageFileCacheLoaderBase<NormalizedUsageRecord> {
  private static readonly CACHE_VERSION = 2
  private static readonly HEADER_BYTES = 64 * 1024
  private static readonly ROLLOUT_RE = /^rollout-.*\.jsonl$/i

  private constructor(cacheFile: string, onProgress?: (progress: CodexUsageLoaderProgress) => void) {
    super(cacheFile, CodexUsageLoader.CACHE_VERSION, onProgress)
  }

  static defaultSessionsRoot(): string {
    return join(process.env['CODEX_HOME'] || join(homedir(), '.codex'), 'sessions')
  }

  static async load(options: CodexUsageLoadOptions): Promise<CodexUsageLoadResult> {
    const sessionsRoot = options.sessionsRoot ?? CodexUsageLoader.defaultSessionsRoot()
    options.onProgress?.({ kind: 'discover', current: 0, total: 0, cacheHits: 0, changedFiles: 0 })
    const files = [...CodexUsageLoader.walkRollouts(sessionsRoot)]
    options.onProgress?.({ kind: 'discover', current: files.length, total: files.length, cacheHits: 0, changedFiles: 0 })
    const loader = new CodexUsageLoader(options.cacheFile, options.onProgress)
    const loaded = await loader.loadCachedFiles(files)
    return { ...loaded, costCoverage: CodexUsageLoader.costCoverage(loaded.records) }
  }

  protected async parseFile(file: string): Promise<UsageFileParseResult<NormalizedUsageRecord>> {
    const header = CodexUsageLoader.readHeader(file)
    const shouldParse = header !== null && header.originator !== 'codex_sdk_ts'
    return {
      records: shouldParse ? await CodexUsageLoader.parseRollout(file, header) : [],
      parsed: shouldParse,
    }
  }

  static costCoverage(records: NormalizedUsageRecord[]): MetricCoverage {
    if (records.length === 0) return 'none'
    const priced = records.filter((record) => modelRates(record.model) !== null).length
    if (priced === records.length) return 'full'
    else if (priced === 0) return 'none'
    else if (priced < records.length) return 'partial'
    else
      throw new Error(`Invalid priced record count: ${priced}/${records.length}`)
  }

  private static *walkRollouts(root: string): Generator<string> {
    for (const year of CodexUsageLoader.safeReaddir(root).filter((name) => /^\d{4}$/.test(name))) {
      const yearDir = join(root, year)
      for (const month of CodexUsageLoader.safeReaddir(yearDir).filter((name) => /^\d{2}$/.test(name))) {
        const monthDir = join(yearDir, month)
        for (const day of CodexUsageLoader.safeReaddir(monthDir).filter((name) => /^\d{2}$/.test(name))) {
          const dayDir = join(monthDir, day)
          for (const name of CodexUsageLoader.safeReaddir(dayDir))
            if (CodexUsageLoader.ROLLOUT_RE.test(name)) yield join(dayDir, name)
        }
      }
    }
  }

  private static safeReaddir(dir: string): string[] {
    try { return readdirSync(dir) } catch { return [] }
  }

  private static readHeader(file: string): RolloutHeader | null {
    let fd: number
    try { fd = openSync(file, 'r') } catch { return null }
    try {
      const buffer = Buffer.alloc(CodexUsageLoader.HEADER_BYTES)
      const length = readSync(fd, buffer, 0, buffer.length, 0)
      const text = buffer.toString('utf8', 0, length)
      const sessionId = CodexUsageLoader.readJsonString(text, 'id')
      const cwd = CodexUsageLoader.readJsonString(text, 'cwd')
      const originator = CodexUsageLoader.readJsonString(text, 'originator')
      return sessionId && cwd && originator ? { sessionId, cwd, originator } : null
    } catch {
      return null
    } finally {
      closeSync(fd)
    }
  }

  private static readJsonString(text: string, key: string): string | null {
    const match = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
    if (!match) return null
    try { return JSON.parse(`"${match[1]}"`) as string } catch { return null }
  }

  private static async parseRollout(file: string, header: RolloutHeader): Promise<NormalizedUsageRecord[]> {
    const records: NormalizedUsageRecord[] = []
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
    let model = 'unknown'
    let previousTotal: RawTokenUsage | null = null

    try {
      for await (const line of lines) {
        let row: any
        try { row = JSON.parse(line) } catch { continue }
        if (row?.type === 'turn_context' && typeof row.payload?.model === 'string') {
          model = row.payload.model
          continue
        }
        if (row?.type !== 'event_msg' || row.payload?.type !== 'token_count') continue

        const total = CodexUsageLoader.readUsage(row.payload?.info?.total_token_usage)
        const last = CodexUsageLoader.readUsage(row.payload?.info?.last_token_usage)
        const usage = CodexUsageLoader.resolveDelta(total, last, previousTotal)
        if (total) previousTotal = total
        if (!usage || usage.totalTokens <= 0 || !CodexUsageLoader.validTimestamp(row.timestamp)) continue

        const cachedInput = Math.min(usage.inputTokens, usage.cachedInputTokens)
        const inputTokens = usage.inputTokens - cachedInput
        const outputTokens = usage.outputTokens
        const cost = costForTokens(model, { input: inputTokens, output: outputTokens, cacheCreate: 0, cacheRead: cachedInput }) ?? 0
        records.push({
          agent: 'codex',
          timestamp: new Date(row.timestamp).toISOString(),
          model,
          inputTokens,
          outputTokens,
          cacheCreationTokens: 0,
          cacheReadTokens: cachedInput,
          reasoningTokens: Math.min(usage.outputTokens, usage.reasoningOutputTokens),
          cost,
          durationMs: 0,
          project: basename(header.cwd.replace(/[\\/]+$/, '')) || header.cwd,
          projectPath: header.cwd,
          sessionId: header.sessionId,
        })
      }
    } finally {
      lines.close()
    }
    return records
  }

  private static readUsage(value: unknown): RawTokenUsage | null {
    if (!value || typeof value !== 'object') return null
    const usage = value as Record<string, unknown>
    const inputTokens = CodexUsageLoader.nonNegativeNumber(usage['input_tokens'])
    const cachedInputTokens = CodexUsageLoader.nonNegativeNumber(usage['cached_input_tokens'])
    const outputTokens = CodexUsageLoader.nonNegativeNumber(usage['output_tokens'])
    const reasoningOutputTokens = CodexUsageLoader.nonNegativeNumber(usage['reasoning_output_tokens'])
    const totalTokens = CodexUsageLoader.nonNegativeNumber(usage['total_tokens'])
    if (inputTokens === null || cachedInputTokens === null || outputTokens === null || reasoningOutputTokens === null || totalTokens === null) return null
    return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens }
  }

  private static nonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  }

  private static resolveDelta(total: RawTokenUsage | null, last: RawTokenUsage | null, previous: RawTokenUsage | null): RawTokenUsage | null {
    if (!total) return last
    if (!previous) return last ?? total
    if (total.totalTokens < previous.totalTokens) return last ?? total
    if (total.totalTokens === previous.totalTokens) return null
    return {
      inputTokens: Math.max(0, total.inputTokens - previous.inputTokens),
      cachedInputTokens: Math.max(0, total.cachedInputTokens - previous.cachedInputTokens),
      outputTokens: Math.max(0, total.outputTokens - previous.outputTokens),
      reasoningOutputTokens: Math.max(0, total.reasoningOutputTokens - previous.reasoningOutputTokens),
      totalTokens: Math.max(0, total.totalTokens - previous.totalTokens),
    }
  }

  private static validTimestamp(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(new Date(value).getTime())
  }

}
