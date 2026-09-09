import { resolve } from 'node:path'

import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import { FileTail } from '../../shared/fileTail'
import { PathCompare } from '../../shared/pathCompare'
import type { FileChangesAgentId } from '../fileChangesManagerApi.types'
import type {
  FileChangesLogGroup,
  RawFileChangesLogGroup,
} from './fileChangesLogSource.types'

interface CacheEntry {
  key: string
  groups: readonly RawFileChangesLogGroup[]
}

export abstract class FileChangesLogSource {
  private static readonly maxCacheEntriesConst = 16
  private static readonly maxReadBytesConst = 32 * 1_048_576

  abstract readonly agentId: FileChangesAgentId
  private readonly cache = new Map<string, CacheEntry>()

  async load(ref: ProviderTranscriptRef, cwd: string): Promise<readonly FileChangesLogGroup[]> {
    if (ref.agentId !== this.agentId)
      throw new Error(`Transcript ${ref.agentId} was handed to ${this.agentId}`)
    const key = `${ref.file}\0${ref.mtimeMs}\0${ref.size}`
    let raw = this.cache.get(ref.file)
    if (!raw || raw.key !== key) {
      const content = await FileTail.read(ref.file, ref.size, FileChangesLogSource.maxReadBytesConst)
      raw = { key, groups: this.parse(content) }
      this.cache.delete(ref.file)
      this.cache.set(ref.file, raw)
      while (this.cache.size > FileChangesLogSource.maxCacheEntriesConst)
        this.cache.delete(this.cache.keys().next().value!)
    }
    return raw.groups.map((group) => ({
      ...group,
      mutations: group.mutations.map((mutation) => {
        const path = resolve(cwd, mutation.path)
        const previousPath = mutation.previousPath === null
          ? null
          : resolve(cwd, mutation.previousPath)
        return {
          ...mutation,
          path,
          previousPath,
          location: PathCompare.isInside(cwd, path) ? 'workspace' : 'external',
        }
      }),
    }))
  }

  protected abstract parse(content: string): readonly RawFileChangesLogGroup[]

  protected static records(content: string): unknown[] {
    return content.split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return []
      try { return [JSON.parse(line) as unknown] }
      catch { return [] }
    })
  }

  /**
   * The fallback is a TIME, and both callers used to pass the record's position in the file - so a
   * record with no readable timestamp became `createdAt: 7`, drew as a date in 1970, and sorted to
   * the very end of the history where it fell off the first page altogether. The previous record's
   * time is the honest guess: these files are written in order.
   */
  protected static timestamp(value: unknown, fallback: number): number {
    if (typeof value !== 'string') return fallback
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? fallback : parsed
  }

  protected static shortMessage(value: string): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, 240)
  }
}
