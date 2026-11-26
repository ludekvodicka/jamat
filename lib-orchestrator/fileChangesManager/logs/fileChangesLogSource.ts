import { resolve } from 'node:path'

import type {
  ProviderSubagentFileRef,
  ProviderTranscriptRef,
} from '../../projectManager/providerTranscriptView'
import { FileTail } from '../../shared/fileTail'
import { PathCompare } from '../../shared/pathCompare'
import type { FileChangesAgentId } from '../fileChangesManagerApi.types'
import { SessionMutationRules, type SessionMutationEvents } from '../sessionMutationsView'
import type {
  FileChangesLogGroup,
  FileChangesLogMutation,
  FileChangesShellRun,
  RawFileChangesLogGroup,
  RawFileChangesLogMutation,
} from './fileChangesLogSource.types'

/** A session's own transcript: every message group, empty ones too, and where each sub-agent was spawned. */
export interface ParsedFileChangesLog {
  groups: readonly RawFileChangesLogGroup[]
  /** Spawn key (Claude `Agent` tool_use id, Codex child thread id) to its index in `groups`. */
  spawns: ReadonlyMap<string, number>
  shellRuns: readonly FileChangesShellRun[]
}

/** A sub-agent's own file: its confirmed mutations and the time of its first record. */
export interface ParsedSubagentLog {
  startedAt: number | null
  mutations: readonly RawFileChangesLogMutation[]
  shellRuns: readonly FileChangesShellRun[]
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
  subagentsSince(ref: ProviderTranscriptRef): number | null {
    return SessionMutationRules.subagentsSince(ref)
  }

  async load(
    ref: ProviderTranscriptRef,
    cwd: string,
    subagents: readonly ProviderSubagentFileRef[],
  ): Promise<readonly FileChangesLogGroup[]> {
    const parent = await this.parent(ref)
    const added = parent.groups.map((): RawFileChangesLogMutation[] => [])
    for await (const log of this.subagentLogs(subagents)) {
      if (log.mutations.length === 0) continue
      const index = (log.spawnKey === null ? undefined : parent.spawns.get(log.spawnKey))
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

  /** The shell commands of the session and its sub-agents, read from the same cached parses as `load`. */
  async shellRuns(
    ref: ProviderTranscriptRef,
    subagents: readonly ProviderSubagentFileRef[],
  ): Promise<readonly FileChangesShellRun[]> {
    const runs = [...(await this.parent(ref)).shellRuns]
    for await (const log of this.subagentLogs(subagents))
      runs.push(...log.shellRuns)
    return runs
  }

  /** Through the rules of `sessionMutationsView.ts`, which the incremental cursor of the uncommitted mark reads with too. */
  protected parse(content: string): ParsedFileChangesLog {
    const groups: (RawFileChangesLogGroup & { mutations: RawFileChangesLogMutation[] })[] = []
    const spawns = new Map<string, number>()
    const shellRuns: FileChangesShellRun[] = []
    const rules = SessionMutationRules.of(this.agentId, 'session')
    const events: SessionMutationEvents = {
      group: (group) => { groups.push({ ...group, mutations: [] }) },
      spawn: (key, group) => { spawns.set(key, group) },
      mutation: (mutation, group) => { groups[group].mutations.push(mutation) },
      shellRun: (run) => { shellRuns.push(run) },
    }
    for (const raw of FileChangesLogSource.records(content))
      rules.record(raw, events)
    return { groups, spawns, shellRuns }
  }

  /** A sub-agent's file opens no group: its prompt is the parent's spawn call, not a user message. */
  protected parseSubagent(content: string): ParsedSubagentLog {
    const mutations: RawFileChangesLogMutation[] = []
    const shellRuns: FileChangesShellRun[] = []
    const rules = SessionMutationRules.of(this.agentId, 'subagent')
    const events: SessionMutationEvents = {
      group: () => {},
      spawn: () => {},
      mutation: (mutation) => { mutations.push(mutation) },
      shellRun: (run) => { shellRuns.push(run) },
    }
    for (const raw of FileChangesLogSource.records(content))
      rules.record(raw, events)
    return { startedAt: rules.startedAt, mutations, shellRuns }
  }

  protected static records(content: string): unknown[] {
    return content.split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return []
      try { return [JSON.parse(line) as unknown] }
      catch { return [] }
    })
  }

  private parent(ref: ProviderTranscriptRef): Promise<ParsedFileChangesLog> {
    if (ref.agentId !== this.agentId)
      throw new Error(`Transcript ${ref.agentId} was handed to ${this.agentId}`)
    return FileChangesLogSource.cached(
      this.cache,
      FileChangesLogSource.maxCacheEntriesConst,
      ref,
      (content) => this.parse(content),
    )
  }

  private async *subagentLogs(
    subagents: readonly ProviderSubagentFileRef[],
  ): AsyncGenerator<ParsedSubagentLog & { spawnKey: string | null }> {
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
      yield { ...log, spawnKey: subagent.spawnKey }
    }
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
      shellRuns: log.shellRuns,
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
