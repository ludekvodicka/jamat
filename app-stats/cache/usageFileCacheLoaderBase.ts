import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export interface UsageFileCacheProgress {
  kind: 'check' | 'parse'
  current: number
  total: number
  cacheHits: number
  changedFiles: number
}

export interface UsageFileCacheLoadResult<TRecord> {
  records: TRecord[]
  recordsByFile: Record<string, TRecord[]>
  filesScanned: number
  filesParsed: number
  cacheHits: number
  changedFiles: number
}

export interface UsageFileParseResult<TRecord> {
  records: TRecord[]
  parsed: boolean
}

interface CachedFile<TRecord> {
  size: number
  mtimeMs: number
  records: TRecord[]
}

interface FileCache<TRecord> {
  version: number
  files: Record<string, CachedFile<TRecord>>
}

interface ChangedFile {
  file: string
  size: number
  mtimeMs: number
}

export abstract class UsageFileCacheLoaderBase<TRecord> {
  private lastProgressAt = 0

  protected constructor(
    private readonly cacheFile: string,
    private readonly cacheVersion: number,
    private readonly onProgress?: (progress: UsageFileCacheProgress) => void,
  ) {}

  protected abstract parseFile(file: string): Promise<UsageFileParseResult<TRecord>>

  protected async loadCachedFiles(sourceFiles: string[]): Promise<UsageFileCacheLoadResult<TRecord>> {
    const files = [...new Set(sourceFiles)].sort()
    const previous = this.loadCache()
    const nextFiles: Record<string, CachedFile<TRecord>> = {}
    const changed: ChangedFile[] = []
    let cacheHits = 0

    this.emit({ kind: 'check', current: 0, total: files.length, cacheHits, changedFiles: 0 }, true)
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const stat = UsageFileCacheLoaderBase.safeStat(file)
      if (stat) {
        const cached = previous?.files[file]
        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
          nextFiles[file] = cached
          cacheHits++
        } else {
          changed.push({ file, ...stat })
        }
      }
      this.emit({ kind: 'check', current: i + 1, total: files.length, cacheHits, changedFiles: changed.length })
    }

    let filesParsed = 0
    this.emit({ kind: 'parse', current: 0, total: changed.length, cacheHits, changedFiles: changed.length }, true)
    for (let i = 0; i < changed.length; i++) {
      const item = changed[i]
      const parsed = await this.parseFile(item.file)
      nextFiles[item.file] = { size: item.size, mtimeMs: item.mtimeMs, records: parsed.records }
      if (parsed.parsed) filesParsed++
      this.emit({ kind: 'parse', current: i + 1, total: changed.length, cacheHits, changedFiles: changed.length })
    }

    const removed = previous ? Object.keys(previous.files).some((file) => !Object.hasOwn(nextFiles, file)) : false
    if (previous === null || changed.length > 0 || removed)
      this.saveCache({ version: this.cacheVersion, files: nextFiles })

    const records: TRecord[] = []
    const recordsByFile: Record<string, TRecord[]> = {}
    for (const [file, cached] of Object.entries(nextFiles)) {
      recordsByFile[file] = cached.records
      for (const record of cached.records) records.push(record)
    }

    return { records, recordsByFile, filesScanned: files.length, filesParsed, cacheHits, changedFiles: changed.length }
  }

  private loadCache(): FileCache<TRecord> | null {
    try {
      if (!existsSync(this.cacheFile)) return null
      const cache = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as FileCache<TRecord>
      if (cache.version !== this.cacheVersion || !cache.files || typeof cache.files !== 'object') return null
      for (const entry of Object.values(cache.files))
        if (!entry || typeof entry.size !== 'number' || typeof entry.mtimeMs !== 'number' || !Array.isArray(entry.records)) return null
      return cache
    } catch {
      return null
    }
  }

  private saveCache(cache: FileCache<TRecord>): void {
    mkdirSync(dirname(this.cacheFile), { recursive: true })
    const temp = `${this.cacheFile}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(cache))
      renameSync(temp, this.cacheFile)
    } finally {
      rmSync(temp, { force: true })
    }
  }

  private emit(progress: UsageFileCacheProgress, force = false): void {
    if (!this.onProgress) return
    const now = Date.now()
    if (!force && progress.current !== progress.total && progress.current % 100 !== 0 && now - this.lastProgressAt < 250) return
    this.lastProgressAt = now
    this.onProgress(progress)
  }

  private static safeStat(file: string): { size: number; mtimeMs: number } | null {
    try {
      const stat = statSync(file)
      return { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      return null
    }
  }
}
