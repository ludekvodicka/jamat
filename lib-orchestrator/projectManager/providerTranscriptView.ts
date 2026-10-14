import type { Dirent } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

import { BoundedMap } from '../shared/boundedMap'
import { ClaudeConfigHome } from '../shared/claudeConfigHome'
import type { ProviderAgentId } from './providers/providerContract.types'
import { ClaudeProjectsLocator } from './providers/claude/claudeProjectsLocator'
import { CodexChildRollouts } from './providers/codex/codexChildRollouts'
import { CodexRolloutIndex } from './providers/codex/codexRolloutIndex'
import { CodexSessionSource } from './providers/codex/codexSessionSource'

export interface ProviderTranscriptRef {
  agentId: ProviderAgentId
  nativeSessionId: string
  file: string
  mtimeMs: number
  size: number
}

export interface ProviderSubagentFileRef {
  agentId: ProviderAgentId
  subagentId: string
  file: string
  mtimeMs: number
  size: number
  /** Claude `agent-<id>.meta.json` beside the file, when the listing had one. */
  metaFile: string | null
  /** Claude: the meta's `toolUseId`, the `Agent` tool_use that spawned the sub-agent. Codex: the child thread id. */
  spawnKey: string | null
  /** Claude `subagents/workflows/wf_<id>/`: the `<id>`. */
  workflowId: string | null
  /** Codex: what the child's own rollout header states. Claude: null, the meta beside the file says it. */
  thread: ProviderSubagentThread | null
}

export interface ProviderSubagentThread {
  nickname: string | null
  depth: 1 | 2
  /** The depth-1 child that spawned a depth-2 child; null at depth 1. */
  parentSubagentId: string | null
  /** From the rollout's file name. */
  startedAt: number
}

export interface ProviderTranscriptViewOptions {
  claudeHome?: string
  codexHome?: string
  claudeLocator?: ClaudeProjectsLocator
  codexIndex?: CodexRolloutIndex
  codexChildren?: CodexChildRollouts
  report?: (message: string) => void
}

export class ProviderTranscriptView {
  private static readonly sessionIdPatternConst = /^[A-Za-z0-9_-]+$/
  private static readonly subagentIdPatternConst = /^[A-Za-z0-9_-]{1,64}$/
  private static readonly subagentFilePatternConst = /^agent-([A-Za-z0-9_-]{1,64})\.jsonl$/
  private static readonly workflowDirectoryPatternConst = /^wf_([A-Za-z0-9_-]{1,64})$/
  private static readonly statConcurrencyConst = 16
  /** Claude Code cuts a longer temp directory name and appends a hash of the whole cwd. */
  private static readonly claudeTempSlugMaxConst = 200
  /** One entry per sub-agent ever listed; past this the oldest go first. */
  private static readonly spawnKeysMaxConst = 4_096

  private readonly claudeLocator: ClaudeProjectsLocator
  private readonly codexIndex: CodexRolloutIndex
  private readonly codexChildren: CodexChildRollouts
  /**
   * The meta's spawn tool_use id by meta path, never invalidated: Claude Code writes it once at the
   * spawn, so a poll reads each meta once rather than once per listing. A meta that is missing or
   * half written is not remembered and is read again next time.
   */
  private readonly spawnKeys = new Map<string, string>()

  constructor(options?: ProviderTranscriptViewOptions) {
    const claudeHome = ClaudeConfigHome.resolve(options?.claudeHome)
    const codexHome = options?.codexHome ?? CodexSessionSource.defaultHome()
    this.claudeLocator = options?.claudeLocator ?? new ClaudeProjectsLocator(claudeHome)
    this.codexIndex = options?.codexIndex ?? new CodexRolloutIndex(codexHome, options?.report)
    this.codexChildren = options?.codexChildren ?? new CodexChildRollouts(this.codexIndex)
  }

  async resolve(input: {
    agentId: ProviderAgentId
    cwd: string
    nativeSessionId: string
  }): Promise<ProviderTranscriptRef | null> {
    if (!ProviderTranscriptView.sessionIdPatternConst.test(input.nativeSessionId)) return null
    let file: string | null
    if (input.agentId === 'claude')
      file = await this.claudeFile(input.cwd, input.nativeSessionId)
    else if (input.agentId === 'codex')
      file = await this.codexFile(input.cwd, input.nativeSessionId)
    else
      throw new Error(`Unknown provider agent: ${JSON.stringify(input.agentId)}`)
    if (file === null) return null
    try {
      const stats = await stat(file)
      if (!stats.isFile()) return null
      return {
        agentId: input.agentId,
        nativeSessionId: input.nativeSessionId,
        file,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      }
    }
    catch { return null }
  }

  /**
   * Every sub-agent file of one session: Claude `<projectDir>/<nativeSessionId>/subagents/**`, Codex
   * the child rollouts of the session's thread, from the day directories `since` (the session's
   * start) onwards. Codex never resolves the parent's own rollout for this.
   */
  async subagentFiles(input: {
    agentId: ProviderAgentId
    cwd: string
    nativeSessionId: string
    since: number
  }): Promise<readonly ProviderSubagentFileRef[]> {
    if (!ProviderTranscriptView.subagentIdPatternConst.test(input.nativeSessionId)) return []
    if (input.agentId === 'claude')
      return this.claudeSubagentFiles(input.cwd, input.nativeSessionId)
    else if (input.agentId === 'codex')
      return this.codexSubagentFiles(input.nativeSessionId, input.since)
    else
      throw new Error(`Unknown provider agent: ${JSON.stringify(input.agentId)}`)
  }

  /**
   * The `<shellId>.output` file of one Claude background shell. The path the launch stated is used
   * when it is absolute and ends `<nativeSessionId>/tasks/<shellId>.output`: it is exact even when the
   * agent ran with a `CLAUDE_CODE_TMPDIR` this process does not see. Otherwise the path is computed
   * the way Claude Code 2.1.x does it. A sub-agent's `a<id>.output` is never answered.
   */
  async claudeShellOutputFile(input: {
    cwd: string
    nativeSessionId: string
    shellId: string
    statedPath: string | null
  }): Promise<{ file: string; mtimeMs: number; size: number } | null> {
    if (!ProviderTranscriptView.subagentIdPatternConst.test(input.nativeSessionId)
      || !ProviderTranscriptView.subagentIdPatternConst.test(input.shellId)
      || input.shellId.startsWith('a')) return null
    const file = ProviderTranscriptView.statedShellOutput(input) ?? await ProviderTranscriptView.computedShellOutput(input)
    try {
      const stats = await stat(file)
      return stats.isFile() ? { file, mtimeMs: stats.mtimeMs, size: stats.size } : null
    }
    catch { return null }
  }

  private static statedShellOutput(input: { nativeSessionId: string; shellId: string; statedPath: string | null }): string | null {
    if (input.statedPath === null || !isAbsolute(input.statedPath)) return null
    const file = normalize(input.statedPath)
    const tail = file.split(/[\\/]/).slice(-3)
    return tail.length === 3 && tail[0] === input.nativeSessionId && tail[1] === 'tasks'
      && tail[2] === `${input.shellId}.output`
      ? file
      : null
  }

  private static async computedShellOutput(input: { cwd: string; nativeSessionId: string; shellId: string }): Promise<string> {
    const root = process.env.CLAUDE_CODE_TMPDIR || tmpdir()
    let resolved = root
    try { resolved = await realpath(root) }
    catch { /* Claude Code keeps the unresolved root too */ }
    return join(resolved, 'claude', ProviderTranscriptView.claudeTempSlugOf(input.cwd), input.nativeSessionId, 'tasks',
      `${input.shellId}.output`)
  }

  /** The projects-dir encoding, cut at 200 characters plus a base-36 hash of the cwd past that. */
  static claudeTempSlugOf(cwd: string): string {
    const encoded = ClaudeProjectsLocator.encodeProjectDir(cwd)
    if (encoded.length <= ProviderTranscriptView.claudeTempSlugMaxConst) return encoded
    let hash = 0
    for (let index = 0; index < cwd.length; index += 1)
      hash = (hash << 5) - hash + cwd.charCodeAt(index) | 0
    return `${encoded.slice(0, ProviderTranscriptView.claudeTempSlugMaxConst)}-${Math.abs(hash).toString(36)}`
  }

  private async claudeSubagentFiles(
    cwd: string,
    sessionId: string,
  ): Promise<readonly ProviderSubagentFileRef[]> {
    const projectDirectory = await this.claudeLocator.resolveProjectDir(cwd)
    if (projectDirectory === null) return []
    const root = join(projectDirectory, sessionId, 'subagents')
    const entries = await ProviderTranscriptView.entriesOf(root)
    const found = ProviderTranscriptView.agentFilesIn(root, entries, null)
    if (entries.some((entry) => entry.name === 'workflows' && entry.isDirectory())) {
      const workflowsRoot = join(root, 'workflows')
      for (const entry of await ProviderTranscriptView.entriesOf(workflowsRoot)) {
        const workflowId = ProviderTranscriptView.workflowDirectoryPatternConst.exec(entry.name)?.[1]
        if (workflowId === undefined || !entry.isDirectory()) continue
        const directory = join(workflowsRoot, entry.name)
        found.push(...ProviderTranscriptView.agentFilesIn(
          directory,
          await ProviderTranscriptView.entriesOf(directory),
          workflowId,
        ))
      }
    }
    const refs = await BoundedMap.run(
      found,
      ProviderTranscriptView.statConcurrencyConst,
      async (one): Promise<ProviderSubagentFileRef | null> => {
        try {
          const stats = await stat(one.file)
          if (!stats.isFile()) return null
          return {
            agentId: 'claude',
            subagentId: one.subagentId,
            file: one.file,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            metaFile: one.metaFile,
            spawnKey: one.metaFile === null ? null : await this.spawnKeyOf(one.metaFile),
            workflowId: one.workflowId,
            thread: null,
          }
        }
        catch { return null }
      },
    )
    return refs.filter((ref) => ref !== null)
  }

  private async codexSubagentFiles(
    threadId: string,
    since: number,
  ): Promise<readonly ProviderSubagentFileRef[]> {
    const children = (await this.codexChildren.childrenOf(threadId, since, Date.now()))
      .filter((child) => ProviderTranscriptView.subagentIdPatternConst.test(child.sessionId))
    const refs = await BoundedMap.run(
      children,
      ProviderTranscriptView.statConcurrencyConst,
      async (child): Promise<ProviderSubagentFileRef | null> => {
        try {
          const stats = await stat(child.file)
          if (!stats.isFile()) return null
          return {
            agentId: 'codex',
            subagentId: child.sessionId,
            file: child.file,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            metaFile: null,
            spawnKey: child.sessionId,
            workflowId: null,
            thread: {
              nickname: child.nickname,
              depth: child.depth,
              parentSubagentId: child.depth === 1 ? null : child.parentThreadId,
              startedAt: child.createdAt,
            },
          }
        }
        catch { return null }
      },
    )
    return refs.filter((ref) => ref !== null)
  }

  private async spawnKeyOf(metaFile: string): Promise<string | null> {
    const known = this.spawnKeys.get(metaFile)
    if (known !== undefined) return known
    let key: unknown
    try { key = (JSON.parse(await readFile(metaFile, 'utf8')) as { toolUseId?: unknown } | null)?.toolUseId }
    catch { return null }
    if (typeof key !== 'string' || key === '') return null
    this.spawnKeys.set(metaFile, key)
    while (this.spawnKeys.size > ProviderTranscriptView.spawnKeysMaxConst)
      this.spawnKeys.delete(this.spawnKeys.keys().next().value!)
    return key
  }

  private static agentFilesIn(
    directory: string,
    entries: readonly Dirent[],
    workflowId: string | null,
  ): { subagentId: string; file: string; metaFile: string | null; workflowId: string | null }[] {
    const names = new Set(entries.map((entry) => entry.name))
    return entries.flatMap((entry) => {
      const subagentId = ProviderTranscriptView.subagentFilePatternConst.exec(entry.name)?.[1]
      if (subagentId === undefined || !entry.isFile()) return []
      const meta = `agent-${subagentId}.meta.json`
      return [{
        subagentId,
        file: join(directory, entry.name),
        metaFile: names.has(meta) ? join(directory, meta) : null,
        workflowId,
      }]
    })
  }

  private static async entriesOf(directory: string): Promise<Dirent[]> {
    try { return await readdir(directory, { withFileTypes: true }) }
    catch { return [] }
  }

  private async claudeFile(cwd: string, sessionId: string): Promise<string | null> {
    const directory = await this.claudeLocator.resolveProjectDir(cwd)
    return directory === null ? null : join(directory, `${sessionId}.jsonl`)
  }

  private async codexFile(cwd: string, sessionId: string): Promise<string | null> {
    const recent = await this.codexIndex.filesForProject(cwd)
    const hit = recent.find((ref) => ref.sessionId === sessionId)
      ?? (await this.codexIndex.allFilesForProject(cwd)).find((ref) => ref.sessionId === sessionId)
    return hit?.file ?? null
  }
}
