import { mkdir, open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { AtomicJsonFile } from '../shared/atomicJsonFile'
import type { TokenAgentId, TokenBucket, TokenScanProgress } from './tokenUsageApi.types'
import type { TokenUsageSource, UsageParserState, UsageRecord } from './tokenUsageSource'

/**
 * One usage record as the cache holds it, in memory and on disk. The four strings repeat on almost
 * every record of a file, so they are indexes into the file's `strings`; `rolloutAccount` is -1 for
 * none. Schema 2 spelled each record out as an object, which made the file several hundred megabytes.
 */
type CompactRecord = [at: number, input: number, output: number, cacheRead: number, cacheWrite: number,
  nativeId: number, cwd: number, model: number, rolloutAccount: number, dedupe: string | null]
interface FileCursor {
  file: string
  agentId: TokenAgentId
  size: number
  mtimeMs: number
  identity: string
  offset: number
  carry: string
  parser: UsageParserState
  strings: string[]
  records: CompactRecord[]
}
interface ScanCache { schema: 3; files: Record<string, FileCursor>; buckets: TokenBucket[] }
const count = z.number().finite().nonnegative()
const index = count.int()
const parserSchema = z.object({ nativeId: z.string(), cwd: z.string(), model: z.string(), rolloutAccount: z.string().nullable(),
  cumulative: z.object({ input: count, output: count, cached: count }).nullable() })
const countsSchema = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count })
const cursorFields = { file: z.string(), agentId: z.enum(['claude', 'codex']), size: count.int(), mtimeMs: z.number().finite(),
  identity: z.string(), offset: count.int(), carry: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  parser: parserSchema }
const cursorBounds = (cursor: { offset: number; size: number; carry: string }) =>
  cursor.offset <= cursor.size && Buffer.from(cursor.carry, 'base64').length <= cursor.offset
const bucketsSchema = z.array(countsSchema.extend({ day: z.string(), hour: count.int().max(23), projectKey: z.string(),
  agentId: z.enum(['claude', 'codex']), accountId: z.string(), model: z.string() }))
const cacheSchemaV2 = z.object({ schema: z.literal(2), files: z.record(z.string(), z.object({ ...cursorFields,
  records: z.array(countsSchema.extend({ at: z.number().finite(), nativeId: z.string(), cwd: z.string(), model: z.string(),
    rolloutAccount: z.string().nullable(), dedupe: z.string().nullable() })),
}).refine(cursorBounds)), buckets: bucketsSchema })
const cacheSchemaV3 = z.object({ schema: z.literal(3), files: z.record(z.string(), z.object({ ...cursorFields,
  strings: z.array(z.string()),
  records: z.array(z.tuple([z.number().finite(), count, count, count, count, index, index, index, z.number().int().min(-1),
    z.string().nullable()])),
}).refine(cursor => cursorBounds(cursor) && cursor.records.every(record => record[5] < cursor.strings.length
  && record[6] < cursor.strings.length && record[7] < cursor.strings.length && record[8] < cursor.strings.length))), buckets: bucketsSchema })
export interface TokenUsageScannerOptions {
  sources: readonly TokenUsageSource[]
  cacheFile: string
  resolveAccount(agentId: TokenAgentId, nativeId: string, at: number, rolloutAccount: string | null): string
  resolveProject(cwd: string, nativeId: string, agentId: TokenAgentId): string
  progress?(progress: TokenScanProgress): void
}

export class TokenUsageScanner {
  private readonly options: TokenUsageScannerOptions
  private cache: ScanCache = { schema: 3, files: {}, buckets: [] }
  private loaded = false
  /** The cache came off the disk in an older schema and is written again even if no transcript moved. */
  private migrated = false

  constructor(options: TokenUsageScannerOptions) { this.options = options }

  async scan(rescan = false): Promise<TokenBucket[]> {
    if (!this.loaded) {
      await this.load()
      this.loaded = true
    }
    if (rescan) this.cache = { schema: 3, files: {}, buckets: [] }
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
    let changed = rescan || this.migrated
    let completed = 0
    for (const { file, source, identity } of discovered) {
      this.options.progress?.({ running: true, completed, total: discovered.length, error: null, scannedAt: null })
      const metadata = await stat(file)
      const previous = this.cache.files[file]
      // An unchanged file keeps its cursor object: nothing below mutates one that is reused.
      if (previous && previous.identity === identity && previous.agentId === source.agentId && previous.size === metadata.size
        && previous.mtimeMs === metadata.mtimeMs && previous.offset === metadata.size) {
        next[file] = previous
        completed++
        continue
      }
      changed = true
      let cursor: FileCursor
      if (!previous || previous.identity !== identity || metadata.size < previous.size || metadata.mtimeMs < previous.mtimeMs)
        cursor = { file, agentId: source.agentId, size: 0, mtimeMs: 0, identity, offset: 0, carry: '', parser: source.initial(file),
          strings: [], records: [] }
      else cursor = { ...previous, file, agentId: source.agentId, parser: structuredClone(previous.parser),
        strings: [...previous.strings], records: [...previous.records] }
      await this.append(cursor, source, metadata.size)
      cursor.size = metadata.size
      cursor.mtimeMs = metadata.mtimeMs
      next[file] = cursor
      completed++
    }
    changed ||= Object.keys(this.cache.files).some(file => next[file] === undefined)
    const buckets = this.aggregate(Object.values(next))
    const cache: ScanCache = { schema: 3, files: next, buckets }
    if (changed || JSON.stringify(buckets) !== JSON.stringify(this.cache.buckets)) {
      await mkdir(dirname(this.options.cacheFile), { recursive: true })
      await AtomicJsonFile.writeAsync(this.options.cacheFile, cache, { compact: true })
    }
    this.cache = cache
    this.migrated = false
    this.options.progress?.({ running: false, completed, total: discovered.length, error: null, scannedAt: Date.now() })
    return this.cache.buckets
  }

  /**
   * Schema 2 converts in memory without reading a transcript again and is written as schema 3 by the
   * next scan. Schema 1 offsets may already pass Codex last-only events the old parser discarded, so
   * it rebuilds, as does anything malformed: the cache is disposable and the transcripts are the source.
   */
  private async load(): Promise<void> {
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(this.options.cacheFile, 'utf8')) }
    catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const schema = typeof parsed === 'object' && parsed !== null ? (parsed as { schema?: unknown }).schema : undefined
    if (schema === 3) {
      const value = cacheSchemaV3.safeParse(parsed)
      if (value.success) this.cache = value.data as ScanCache
    } else if (schema === 2) {
      const value = cacheSchemaV2.safeParse(parsed)
      if (!value.success) return
      this.cache = { schema: 3, buckets: value.data.buckets, files: Object.fromEntries(Object.entries(value.data.files).map(([key, cursor]) => {
        const { records, ...rest } = cursor
        const compact: FileCursor = { ...rest, strings: [], records: [] }
        const strings = new Map<string, number>()
        for (const record of records) compact.records.push(TokenUsageScanner.pack(record, compact.strings, strings))
        return [key, compact]
      })) }
      this.migrated = true
    }
  }

  private async append(cursor: FileCursor, source: TokenUsageSource, end: number): Promise<void> {
    if (cursor.offset === end) return
    const file = await open(cursor.file, 'r')
    let carry = Buffer.from(cursor.carry, 'base64')
    const strings = new Map(cursor.strings.map((value, position) => [value, position]))
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
          if (record) cursor.records.push(TokenUsageScanner.pack(record, cursor.strings, strings))
          start = newline + 1
        }
        carry = content.subarray(start)
      }
      cursor.carry = carry.toString('base64')
    } finally { await file.close() }
  }

  private static pack(record: UsageRecord, table: string[], positions: Map<string, number>): CompactRecord {
    const intern = (value: string): number => {
      let position = positions.get(value)
      if (position === undefined) {
        position = table.push(value) - 1
        positions.set(value, position)
      }
      return position
    }
    return [record.at, record.input, record.output, record.cacheRead, record.cacheWrite, intern(record.nativeId), intern(record.cwd),
      intern(record.model), record.rolloutAccount === null ? -1 : intern(record.rolloutAccount), record.dedupe]
  }

  private aggregate(files: readonly FileCursor[]): TokenBucket[] {
    const records = files.flatMap(file => file.records.map((record, line) => ({ record, line, file })))
      .sort((a, b) => a.record[0] - b.record[0] || a.file.file.localeCompare(b.file.file) || a.line - b.line)
    const seen = new Set<string>(), buckets = new Map<string, TokenBucket>()
    for (const { record, file } of records) {
      const [at, input, output, cacheRead, cacheWrite, nativeIdAt, cwdAt, modelAt, rolloutAccountAt, deduplicated] = record
      const dedupe = deduplicated === null ? null : `${file.agentId}:${deduplicated}`
      if (dedupe !== null && seen.has(dedupe)) continue
      if (dedupe !== null) seen.add(dedupe)
      const nativeId = file.strings[nativeIdAt]!, rolloutAccount = rolloutAccountAt === -1 ? null : file.strings[rolloutAccountAt]!
      const date = new Date(at)
      const key = { day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
        hour: date.getHours(), projectKey: this.options.resolveProject(file.strings[cwdAt]!, nativeId, file.agentId),
        agentId: file.agentId, accountId: this.options.resolveAccount(file.agentId, nativeId, at, rolloutAccount), model: file.strings[modelAt]! }
      const id = JSON.stringify(key), bucket = buckets.get(id) ?? { ...key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      bucket.input += input
      bucket.output += output
      bucket.cacheRead += cacheRead
      bucket.cacheWrite += cacheWrite
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
