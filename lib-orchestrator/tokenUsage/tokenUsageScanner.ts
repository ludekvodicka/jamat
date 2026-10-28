import { mkdir, open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { AtomicJsonFile } from '../shared/atomicJsonFile'
import type { TokenAgentId, TokenBucket, TokenScanProgress } from './tokenUsageApi.types'
import type { TokenUsageSource, UsageParserState, UsageRecord } from './tokenUsageSource'

interface FileCursor {
  file: string
  agentId: TokenAgentId
  size: number
  mtimeMs: number
  identity: string
  offset: number
  carry: string
  parser: UsageParserState
  records: UsageRecord[]
}
interface ScanCache { schema: 2; files: Record<string, FileCursor>; buckets: TokenBucket[] }
const count = z.number().finite().nonnegative()
const parserSchema = z.object({ nativeId: z.string(), cwd: z.string(), model: z.string(), rolloutAccount: z.string().nullable(),
  cumulative: z.object({ input: count, output: count, cached: count }).nullable() })
const countsSchema = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count })
const cacheSchema = z.object({ schema: z.union([z.literal(1), z.literal(2)]), files: z.record(z.string(), z.object({
  file: z.string(), agentId: z.enum(['claude', 'codex']), size: count.int(), mtimeMs: z.number().finite(), identity: z.string(),
  offset: count.int(), carry: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), parser: parserSchema,
  records: z.array(countsSchema.extend({ at: z.number().finite(), nativeId: z.string(), cwd: z.string(), model: z.string(),
    rolloutAccount: z.string().nullable(), dedupe: z.string().nullable() })),
}).refine(cursor => cursor.offset <= cursor.size && Buffer.from(cursor.carry, 'base64').length <= cursor.offset)),
  buckets: z.array(countsSchema.extend({ day: z.string(), hour: count.int().max(23), projectKey: z.string(),
    agentId: z.enum(['claude', 'codex']), accountId: z.string(), model: z.string() })) })
export interface TokenUsageScannerOptions {
  sources: readonly TokenUsageSource[]
  cacheFile: string
  resolveAccount(agentId: TokenAgentId, nativeId: string, at: number, rolloutAccount: string | null): string
  resolveProject(cwd: string, nativeId: string, agentId: TokenAgentId): string
  progress?(progress: TokenScanProgress): void
}

export class TokenUsageScanner {
  private readonly options: TokenUsageScannerOptions
  private cache: ScanCache = { schema: 2, files: {}, buckets: [] }
  private loaded = false

  constructor(options: TokenUsageScannerOptions) { this.options = options }

  async scan(rescan = false): Promise<TokenBucket[]> {
    if (!this.loaded) {
      try {
        const value = cacheSchema.safeParse(JSON.parse(await readFile(this.options.cacheFile, 'utf8')))
        if (value.success)
          switch (value.data.schema) {
            // Schema 1 offsets may already pass Codex last-only events the old parser discarded.
            case 1: break
            case 2: this.cache = { ...value.data, schema: 2 }; break
            default: throw new Error(`Unknown token cache schema: ${JSON.stringify(value.data)}`)
          }
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      this.loaded = true
    }
    if (rescan) this.cache = { schema: 2, files: {}, buckets: [] }
    const discovered: { file: string; source: TokenUsageSource; identity: string }[] = []
    const seen = new Set<string>()
    for (const source of this.options.sources)
      for (const file of await this.enumerate(source.root, source.accepts)) {
        const metadata = await stat(file), resolved = await realpath(file)
        const identity = metadata.ino ? `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}` : resolved
        if (seen.has(identity)) continue
        seen.add(identity)
        discovered.push({ file: resolved, source, identity })
      }
    discovered.sort((a, b) => a.file.localeCompare(b.file))
    const next: Record<string, FileCursor> = {}
    let completed = 0
    for (const { file, source, identity } of discovered) {
      this.options.progress?.({ running: true, completed, total: discovered.length, error: null, scannedAt: null })
      const metadata = await stat(file)
      let cursor = this.cache.files[file]
      if (!cursor || cursor.identity !== identity || metadata.size < cursor.size || metadata.mtimeMs < cursor.mtimeMs)
        cursor = { file, agentId: source.agentId, size: 0, mtimeMs: 0, identity, offset: 0, carry: '', parser: source.initial(file), records: [] }
      else cursor = { ...cursor, file, agentId: source.agentId, parser: structuredClone(cursor.parser), records: [...cursor.records] }
      await this.append(cursor, source, metadata.size)
      cursor.size = metadata.size
      cursor.mtimeMs = metadata.mtimeMs
      next[file] = cursor
      completed++
    }
    const cache: ScanCache = { schema: 2, files: next, buckets: this.aggregate(Object.values(next)) }
    await mkdir(dirname(this.options.cacheFile), { recursive: true })
    await AtomicJsonFile.writeAsync(this.options.cacheFile, cache)
    this.cache = cache
    this.options.progress?.({ running: false, completed, total: discovered.length, error: null, scannedAt: Date.now() })
    return this.cache.buckets
  }

  private async append(cursor: FileCursor, source: TokenUsageSource, end: number): Promise<void> {
    if (cursor.offset === end) return
    const file = await open(cursor.file, 'r')
    let carry = Buffer.from(cursor.carry, 'base64')
    try {
      while (cursor.offset < end) {
        const buffer = Buffer.alloc(Math.min(65_536, end - cursor.offset))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor.offset)
        if (bytesRead === 0) break
        cursor.offset += bytesRead
        const content = Buffer.concat([carry, buffer.subarray(0, bytesRead)])
        let start = 0, newline: number
        while ((newline = content.indexOf(10, start)) >= 0) {
          const record = source.parse(content.subarray(start, newline).toString('utf8'), cursor.parser)
          if (record) cursor.records.push(record)
          start = newline + 1
        }
        carry = content.subarray(start)
      }
      cursor.carry = carry.toString('base64')
    } finally { await file.close() }
  }

  private aggregate(files: readonly FileCursor[]): TokenBucket[] {
    const records = files.flatMap(file => file.records.map((record, line) => ({ record, line, file })))
      .sort((a, b) => a.record.at - b.record.at || a.file.file.localeCompare(b.file.file) || a.line - b.line)
    const seen = new Set<string>(), buckets = new Map<string, TokenBucket>()
    for (const { record, file } of records) {
      const dedupe = record.dedupe === null ? null : `${file.agentId}:${record.dedupe}`
      if (dedupe !== null && seen.has(dedupe)) continue
      if (dedupe !== null) seen.add(dedupe)
      const date = new Date(record.at)
      const key = { day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
        hour: date.getHours(), projectKey: this.options.resolveProject(record.cwd, record.nativeId, file.agentId),
        agentId: file.agentId, accountId: this.options.resolveAccount(file.agentId, record.nativeId, record.at, record.rolloutAccount), model: record.model }
      const id = JSON.stringify(key), bucket = buckets.get(id) ?? { ...key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      bucket.input += record.input
      bucket.output += record.output
      bucket.cacheRead += record.cacheRead
      bucket.cacheWrite += record.cacheWrite
      buckets.set(id, bucket)
    }
    return [...buckets.values()]
  }

  private async enumerate(root: string, accepts: (name: string) => boolean, seen = new Set<string>()): Promise<string[]> {
    let resolved: string
    try { resolved = await realpath(root) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    if (seen.has(resolved)) return []
    seen.add(resolved)
    const files: string[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const file = join(root, entry.name)
      const metadata = entry.isSymbolicLink() ? await stat(file) : entry
      if (metadata.isDirectory()) files.push(...await this.enumerate(file, accepts, seen))
      else if (metadata.isFile() && accepts(entry.name)) files.push(file)
    }
    return files
  }
}
