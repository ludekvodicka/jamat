import { createReadStream } from 'fs'
import { relative, sep } from 'path'
import { createInterface } from 'readline'
import { getClaudePaths, globUsageFiles, type GlobResult } from 'ccusage/data-loader'
import { costForTokens } from '../core/pricing.js'
import type { DailyUsage, ModelBreakdown, SessionUsage } from '../core/types/stats.js'
import type { NormalizedUsageRecord } from './stats-view.js'
import {
  UsageFileCacheLoaderBase,
  type UsageFileCacheProgress,
  type UsageFileParseResult,
} from './cache/usageFileCacheLoaderBase.js'

interface ClaudeCachedUsageRecord {
  timestamp: string
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  speed: 'standard' | 'fast' | null
  dedupeKey: string | null
  requestKey: string | null
  lineNumber: number
}

interface ClaudeUsageRecord extends ClaudeCachedUsageRecord {
  requestKey: string
  sourceFile: string
  sourceTimestamp: number
  project: string
  projectPath: string
  sessionId: string
  aggregateProjectPath: string
  aggregateSessionId: string
}

interface UsageBucket {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalCost: number
  models: Map<string, ModelBreakdown>
  modelsUsed: string[]
  modelsSeen: Set<string>
}

interface SessionBucket extends UsageBucket {
  sessionId: string
  projectPath: string
  lastTimestamp: string
}

export interface ClaudeUsageLoaderProgress {
  kind: 'discover' | UsageFileCacheProgress['kind']
  current: number
  total: number
  cacheHits: number
  changedFiles: number
}

export interface ClaudeUsageLoadOptions {
  cacheFile: string
  claudePaths?: string[]
  onProgress?: (progress: ClaudeUsageLoaderProgress) => void
}

export interface ClaudeUsageLoadResult {
  daily: DailyUsage[]
  sessions: SessionUsage[]
  rollingRecords: NormalizedUsageRecord[]
  filesScanned: number
  filesParsed: number
  cacheHits: number
  changedFiles: number
}

export class ClaudeUsageLoader extends UsageFileCacheLoaderBase<ClaudeCachedUsageRecord> {
  private static readonly CACHE_VERSION = 5
  private static readonly FAST_COST_MULTIPLIER = 2
  private static readonly FALLBACK_RATE = 3 / 1e6
  private readonly fileInfo = new Map<string, GlobResult>()
  private readonly sourceOrder = new Map<string, number>()

  private constructor(cacheFile: string, onProgress?: (progress: ClaudeUsageLoaderProgress) => void) {
    super(cacheFile, ClaudeUsageLoader.CACHE_VERSION, onProgress)
  }

  static async load(options: ClaudeUsageLoadOptions): Promise<ClaudeUsageLoadResult> {
    options.onProgress?.({ kind: 'discover', current: 0, total: 0, cacheHits: 0, changedFiles: 0 })
    const paths = options.claudePaths ?? await getClaudePaths()
    const files = await globUsageFiles(paths)
    options.onProgress?.({ kind: 'discover', current: files.length, total: files.length, cacheHits: 0, changedFiles: 0 })

    const loader = new ClaudeUsageLoader(options.cacheFile, options.onProgress)
    files.forEach((item, index) => {
      loader.fileInfo.set(item.file, item)
      loader.sourceOrder.set(item.file, index)
    })
    const loaded = await loader.loadCachedFiles(files.map((item) => item.file))
    const records: ClaudeUsageRecord[] = []
    for (const [file, cachedRecords] of Object.entries(loaded.recordsByFile)) {
      const info = loader.fileInfo.get(file)
      if (!info) continue
      const identity = ClaudeUsageLoader.fileIdentity(info)
      const sourceTimestamp = cachedRecords.reduce((earliest, record) => Math.min(earliest, new Date(record.timestamp).getTime()), Number.MAX_SAFE_INTEGER)
      for (const record of cachedRecords)
        records.push({ ...record, requestKey: record.requestKey ?? `${file}:${record.lineNumber}`, sourceFile: file, sourceTimestamp, ...identity })
    }
    const ordered = records.sort((left, right) =>
      left.sourceTimestamp - right.sourceTimestamp
      || (loader.sourceOrder.get(left.sourceFile) ?? Number.MAX_SAFE_INTEGER) - (loader.sourceOrder.get(right.sourceFile) ?? Number.MAX_SAFE_INTEGER)
      || left.lineNumber - right.lineNumber)
    const deduped = ClaudeUsageLoader.dedupeForAggregates(ordered)
    const rollingRecords = ClaudeUsageLoader.toRollingRecords(ordered)
    return {
      daily: ClaudeUsageLoader.buildDaily(deduped),
      sessions: ClaudeUsageLoader.buildSessions(deduped),
      rollingRecords,
      filesScanned: loaded.filesScanned,
      filesParsed: loaded.filesParsed,
      cacheHits: loaded.cacheHits,
      changedFiles: loaded.changedFiles,
    }
  }

  protected async parseFile(file: string): Promise<UsageFileParseResult<ClaudeCachedUsageRecord>> {
    const info = this.fileInfo.get(file)
    if (!info) throw new Error(`Missing Claude source metadata: ${file}`)
    const records: ClaudeCachedUsageRecord[] = []
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
    let lineNumber = 0
    try {
      for await (const line of lines) {
        lineNumber++
        const record = ClaudeUsageLoader.parseLine(line, lineNumber)
        if (record) records.push(record)
      }
    } finally {
      lines.close()
    }
    return { records, parsed: true }
  }

  private static parseLine(
    line: string,
    lineNumber: number,
  ): ClaudeCachedUsageRecord | null {
    let row: any
    try { row = JSON.parse(line) } catch { return null }
    const usage = row?.message?.usage
    if (!usage || !ClaudeUsageLoader.validTimestamp(row.timestamp)) return null
    const inputTokens = ClaudeUsageLoader.number(usage.input_tokens)
    const outputTokens = ClaudeUsageLoader.number(usage.output_tokens)
    if (inputTokens === null || outputTokens === null) return null
    const cacheCreationTokens = ClaudeUsageLoader.number(usage.cache_creation_input_tokens) ?? 0
    const cacheReadTokens = ClaudeUsageLoader.number(usage.cache_read_input_tokens) ?? 0
    const model = typeof row.message.model === 'string' && row.message.model.length > 0 ? row.message.model : null
    const speed = usage.speed === 'standard' || usage.speed === 'fast' ? usage.speed : null
    const messageId = typeof row.message.id === 'string' && row.message.id.length > 0 ? row.message.id : null
    const requestId = typeof row.requestId === 'string' && row.requestId.length > 0 ? row.requestId : null
    const uuid = typeof row.uuid === 'string' && row.uuid.length > 0 ? row.uuid : null
    return {
      timestamp: new Date(row.timestamp).toISOString(),
      model,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      speed,
      dedupeKey: messageId && requestId ? `${messageId}:${requestId}` : null,
      requestKey: requestId ?? uuid,
      lineNumber,
    }
  }

  private static fileIdentity(item: GlobResult): {
    project: string
    projectPath: string
    sessionId: string
    aggregateProjectPath: string
    aggregateSessionId: string
  } {
    const normalized = item.file.replace(/\\/g, '/')
    const match = normalized.match(/\/projects\/([^/]+)\/([^/]+)/)
    const encodedProject = match?.[1] ?? 'unknown'
    const sessionId = match?.[2]?.replace(/\.jsonl$/, '') ?? 'unknown'
    const project = encodedProject.replace(/^[A-Za-z]--/, '').split('-').pop() || encodedProject
    const parts = relative(item.baseDir, item.file).split(sep)
    const aggregateSessionId = parts[parts.length - 2] ?? 'unknown'
    const aggregatePath = parts.slice(0, -2).join(sep)
    return {
      project,
      projectPath: encodedProject,
      sessionId,
      aggregateProjectPath: aggregatePath.length > 0 ? aggregatePath : 'Unknown Project',
      aggregateSessionId,
    }
  }

  private static dedupeForAggregates(records: ClaudeUsageRecord[]): ClaudeUsageRecord[] {
    const seen = new Set<string>()
    return records.filter((record) => {
      if (record.dedupeKey === null) return true
      if (seen.has(record.dedupeKey)) return false
      seen.add(record.dedupeKey)
      return true
    })
  }

  private static toRollingRecords(records: ClaudeUsageRecord[]): NormalizedUsageRecord[] {
    const selected = new Map<string, ClaudeUsageRecord>()
    const ranges = new Map<string, { first: number; last: number }>()
    for (const record of records) {
      if (record.inputTokens === 0 && record.outputTokens === 0) continue
      const timestamp = new Date(record.timestamp).getTime()
      const range = ranges.get(record.requestKey)
      if (range) {
        range.first = Math.min(range.first, timestamp)
        range.last = Math.max(range.last, timestamp)
      } else {
        ranges.set(record.requestKey, { first: timestamp, last: timestamp })
      }
      selected.set(record.requestKey, record)
    }
    return [...selected.values()].map((record) => {
      const range = ranges.get(record.requestKey)
      const fallbackCost = (record.inputTokens + record.outputTokens + record.cacheCreationTokens + record.cacheReadTokens) * ClaudeUsageLoader.FALLBACK_RATE
      return {
        agent: 'claude',
        timestamp: record.timestamp,
        model: record.model ?? 'unknown',
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheCreationTokens: record.cacheCreationTokens,
        cacheReadTokens: record.cacheReadTokens,
        reasoningTokens: 0,
        cost: record.model === null ? fallbackCost : costForTokens(record.model, {
          input: record.inputTokens,
          output: record.outputTokens,
          cacheCreate: record.cacheCreationTokens,
          cacheRead: record.cacheReadTokens,
        }) ?? fallbackCost,
        durationMs: range ? range.last - range.first : 0,
        project: record.project,
        projectPath: record.projectPath,
        sessionId: record.sessionId,
      }
    })
  }

  private static buildDaily(records: ClaudeUsageRecord[]): DailyUsage[] {
    const buckets = new Map<string, UsageBucket>()
    for (const record of records) {
      const date = ClaudeUsageLoader.localDate(record.timestamp)
      const bucket = buckets.get(date) ?? ClaudeUsageLoader.emptyBucket()
      ClaudeUsageLoader.add(bucket, record)
      buckets.set(date, bucket)
    }
    return [...buckets.entries()].map(([date, bucket]) => ({
      date,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheCreationTokens: bucket.cacheCreationTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      reasoningTokens: 0,
      totalCost: bucket.totalCost,
      modelsUsed: bucket.modelsUsed,
      modelBreakdowns: [...bucket.models.values()].sort((left, right) => right.cost - left.cost),
    })).sort((left, right) => left.date.localeCompare(right.date))
  }

  private static buildSessions(records: ClaudeUsageRecord[]): SessionUsage[] {
    const buckets = new Map<string, SessionBucket>()
    for (const record of records) {
      const key = `${record.aggregateProjectPath}/${record.aggregateSessionId}`
      const bucket = buckets.get(key) ?? {
        ...ClaudeUsageLoader.emptyBucket(),
        sessionId: record.aggregateSessionId,
        projectPath: record.aggregateProjectPath,
        lastTimestamp: record.timestamp,
      }
      ClaudeUsageLoader.add(bucket, record)
      if (record.timestamp > bucket.lastTimestamp) bucket.lastTimestamp = record.timestamp
      buckets.set(key, bucket)
    }
    return [...buckets.values()].map((bucket) => ({
      agent: 'claude' as const,
      sessionId: bucket.sessionId,
      projectPath: bucket.projectPath,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheCreationTokens: bucket.cacheCreationTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      reasoningTokens: 0,
      totalCost: bucket.totalCost,
      lastActivity: ClaudeUsageLoader.localDate(bucket.lastTimestamp),
      modelsUsed: bucket.modelsUsed,
      modelBreakdowns: [...bucket.models.values()].sort((left, right) => right.cost - left.cost),
    })).sort((left, right) => right.lastActivity.localeCompare(left.lastActivity))
  }

  private static emptyBucket(): UsageBucket {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0,
      models: new Map(),
      modelsUsed: [],
      modelsSeen: new Set(),
    }
  }

  private static add(bucket: UsageBucket, record: ClaudeUsageRecord): void {
    bucket.inputTokens += record.inputTokens
    bucket.outputTokens += record.outputTokens
    bucket.cacheCreationTokens += record.cacheCreationTokens
    bucket.cacheReadTokens += record.cacheReadTokens
    const cost = ClaudeUsageLoader.aggregateCost(record)
    bucket.totalCost += cost
    const displayModel = record.model === null ? null : record.speed === 'fast' ? `${record.model}-fast` : record.model
    if (displayModel === null || displayModel === '<synthetic>') return
    if (!bucket.modelsSeen.has(displayModel)) {
      bucket.modelsSeen.add(displayModel)
      bucket.modelsUsed.push(displayModel)
    }
    const model = bucket.models.get(displayModel) ?? {
      modelName: displayModel,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      cost: 0,
    }
    model.inputTokens += record.inputTokens
    model.outputTokens += record.outputTokens
    model.cacheCreationTokens += record.cacheCreationTokens
    model.cacheReadTokens += record.cacheReadTokens
    model.cost += cost
    bucket.models.set(displayModel, model)
  }

  private static localDate(timestamp: string): string {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp))
  }

  private static aggregateCost(record: ClaudeUsageRecord): number {
    if (record.model === null) return 0
    const cost = costForTokens(record.model, {
      input: record.inputTokens,
      output: record.outputTokens,
      cacheCreate: record.cacheCreationTokens,
      cacheRead: record.cacheReadTokens,
    }) ?? 0
    return cost * (record.speed === 'fast' ? ClaudeUsageLoader.FAST_COST_MULTIPLIER : 1)
  }

  private static number(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  private static validTimestamp(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(new Date(value).getTime())
  }
}
