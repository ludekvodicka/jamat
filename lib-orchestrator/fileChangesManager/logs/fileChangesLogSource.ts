import { resolve } from 'node:path'

import type {
  ProviderSubagentFileRef,
  ProviderTranscriptRef,
} from '../../projectManager/providerTranscriptView'
import { FileTail } from '../../shared/fileTail'
import { PathCompare } from '../../shared/pathCompare'
import type { FileChangesAgentId } from '../fileChangesManagerApi.types'
import type {
  FileChangesLogGroup,
  FileChangesLogMutation,
  RawFileChangesLogGroup,
  RawFileChangesLogMutation,
} from './fileChangesLogSource.types'

/** A session's own transcript: every message group, empty ones too, and where each sub-agent was spawned. */
export interface ParsedFileChangesLog {
  groups: readonly RawFileChangesLogGroup[]
  /** Spawn key (Claude `Agent` tool_use id, Codex child thread id) to its index in `groups`. */
  spawns: ReadonlyMap<string, number>
}

/** A sub-agent's own file: its confirmed mutations and the time of its first record. */
export interface ParsedSubagentLog {
  startedAt: number | null
  mutations: readonly RawFileChangesLogMutation[]
}

interface CacheEntry<T> {
  key: string
  value: T
}

interface StatedFile {
  file: string
  mtimeMs: number
  size: number
}

export abstract class FileChangesLogSource {
  private static readonly maxCacheEntriesConst = 16
  private static readonly maxReadBytesConst = 32 * 1_048_576
  static readonly maxSubagentFilesConst = 200
  /** Above one load's sub-agent bound, so a second load of the same session reads only what moved. */
  private static readonly maxSubagentCacheEntriesConst = 512

  abstract readonly agentId: FileChangesAgentId
  private readonly cache = new Map<string, CacheEntry<ParsedFileChangesLog>>()
  private readonly subagentCache = new Map<string, CacheEntry<ParsedSubagentLog>>()

  /** Where the sub-agent listing of this transcript starts; null lists none. */
  abstract subagentsSince(ref: ProviderTranscriptRef): number | null

  async load(
    ref: ProviderTranscriptRef,
    cwd: string,
    subagents: readonly ProviderSubagentFileRef[],
  ): Promise<readonly FileChangesLogGroup[]> {
    if (ref.agentId !== this.agentId)
      throw new Error(`Transcript ${ref.agentId} was handed to ${this.agentId}`)
    const parent = await FileChangesLogSource.cached(
      this.cache,
      FileChangesLogSource.maxCacheEntriesConst,
      ref,
      (content) => this.parse(content),
    )
    const added = parent.groups.map((): RawFileChangesLogMutation[] => [])
    for (const subagent of FileChangesLogSource.newest(subagents)) {
      if (subagent.agentId !== this.agentId)
        throw new Error(`Sub-agent ${subagent.agentId} was handed to ${this.agentId}`)
      let log: ParsedSubagentLog
      // One sub-agent file that vanished or cannot be read must not cost the session its history.
      try {
        log = await FileChangesLogSource.cached(
          this.subagentCache,
          FileChangesLogSource.maxSubagentCacheEntriesConst,
          subagent,
          (content) => FileChangesLogSource.prefixed(this.parseSubagent(content), subagent.subagentId),
        )
      }
      catch { continue }
      if (log.mutations.length === 0) continue
      const index = (subagent.spawnKey === null ? undefined : parent.spawns.get(subagent.spawnKey))
        ?? FileChangesLogSource.groupAt(parent.groups, log.startedAt)
      if (index !== undefined) added[index].push(...log.mutations)
    }
    return parent.groups.flatMap((group, index) => {
      const mutations = added[index].length === 0
        ? group.mutations
        : [...group.mutations, ...added[index]].sort((left, right) => left.createdAt - right.createdAt)
      if (mutations.length === 0) return []
      return [{ ...group, mutations: mutations.map((mutation) => FileChangesLogSource.located(mutation, cwd)) }]
    })
  }

  protected abstract parse(content: string): ParsedFileChangesLog

  protected abstract parseSubagent(content: string): ParsedSubagentLog

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

  private static async cached<T>(
    cache: Map<string, CacheEntry<T>>,
    maxEntries: number,
    stated: StatedFile,
    parse: (content: string) => T,
  ): Promise<T> {
    const key = `${stated.file}\0${stated.mtimeMs}\0${stated.size}`
    const found = cache.get(stated.file)
    const entry = found !== undefined && found.key === key
      ? found
      : { key, value: parse(await FileTail.read(stated.file, stated.size, FileChangesLogSource.maxReadBytesConst)) }
    cache.delete(stated.file)
    cache.set(stated.file, entry)
    while (cache.size > maxEntries)
      cache.delete(cache.keys().next().value!)
    return entry.value
  }

  private static newest(subagents: readonly ProviderSubagentFileRef[]): ProviderSubagentFileRef[] {
    return [...subagents]
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, FileChangesLogSource.maxSubagentFilesConst)
  }

  /** The group open at `at`: the last one that started no later. */
  private static groupAt(groups: readonly RawFileChangesLogGroup[], at: number | null): number | undefined {
    if (at === null) return undefined
    for (let index = groups.length - 1; index >= 0; index -= 1)
      if (groups[index].createdAt <= at) return index
    return undefined
  }

  /** Two sub-agents may both number a mutation from their own records; their ids must not meet. */
  private static prefixed(log: ParsedSubagentLog, subagentId: string): ParsedSubagentLog {
    return {
      startedAt: log.startedAt,
      mutations: log.mutations.map((mutation) => ({
        ...mutation,
        mutationId: `${subagentId}:${mutation.mutationId}`,
      })),
    }
  }

  private static located(mutation: RawFileChangesLogMutation, cwd: string): FileChangesLogMutation {
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
  }
}
