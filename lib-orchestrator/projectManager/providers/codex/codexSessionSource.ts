import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ProviderSessionSummary } from '../../projectManagerApi.types'
import { ProviderTranscriptMessages } from '../../providerTranscriptMessages'
import type { ProviderAgentId, ProviderSessionSource } from '../providerContract.types'
import type { CodexRolloutRef } from './codexRolloutIndex'
import { CodexRolloutIndex } from './codexRolloutIndex'
import { CodexThreadNames } from './codexThreadNames'

export interface CodexSessionSourceDeps {
  codexHome?: string
  index?: CodexRolloutIndex
  threadNames?: CodexThreadNames
}

/**
 * Codex history for one project: the index says which files, the file names say who and when, a
 * stat says how recent, and only the rows that survive the limit are opened at all.
 */
export class CodexSessionSource implements ProviderSessionSource {
  /**
   * Larger than the index's header window: the first real prompt sits behind the injected context
   * blocks, which carry the whole environment and AGENTS.md.
   */
  private static readonly previewReadBytesConst = 128 * 1024
  private static readonly messageLengthConst = 120

  readonly agentId: ProviderAgentId = 'codex'
  private readonly index: CodexRolloutIndex
  private readonly threadNames: CodexThreadNames

  constructor(deps: CodexSessionSourceDeps) {
    const codexHome = deps.codexHome ?? CodexSessionSource.defaultHome()
    this.index = deps.index ?? new CodexRolloutIndex(codexHome)
    this.threadNames = deps.threadNames ?? new CodexThreadNames(codexHome)
  }

  /** `CODEX_HOME` is Codex's own variable; nothing here introduces a `JAMAT_V3_*` name for it. */
  static defaultHome(): string {
    return process.env.CODEX_HOME ?? join(homedir(), '.codex')
  }

  async listProjectSessions(
    projectDir: string,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<ProviderSessionSummary[]> {
    const dated: { ref: CodexRolloutRef; lastActivity: number }[] = []
    for (const ref of await this.index.filesForProject(projectDir)) {
      // Nobody is waiting for an aborted listing, so what was already read is handed back as it is -
      // the contract both drivers keep, because they are awaited together and a rejection here would
      // throw away the Claude listing beside it.
      if (options.signal?.aborted) break
      const mtimeMilliseconds = await CodexSessionSource.mtimeOf(ref.file)
      if (mtimeMilliseconds === null) continue
      dated.push({ ref, lastActivity: mtimeMilliseconds })
    }
    dated.sort((left, right) => right.lastActivity - left.lastActivity)
    const summaries: ProviderSessionSummary[] = []
    // Sorted and cut first, read second: a project with hundreds of rollouts opens `limit` of them.
    for (const { ref, lastActivity } of dated.slice(0, options.limit)) {
      if (options.signal?.aborted) break
      summaries.push({
        agentId: this.agentId,
        nativeSessionId: ref.sessionId,
        title: await this.threadNames.titleOf(ref.sessionId),
        firstUserMessage: await CodexSessionSource.firstUserMessage(ref.file),
        createdAt: ref.createdAt,
        lastActivity,
        // Codex tracks no pid, so a rollout on disk says nothing about a running session.
        active: false,
      })
    }
    return summaries
  }

  async latestActivity(projectDir: string): Promise<number | null> {
    let latest: number | null = null
    for (const ref of await this.index.filesForProject(projectDir)) {
      const mtimeMilliseconds = await CodexSessionSource.mtimeOf(ref.file)
      if (mtimeMilliseconds !== null && (latest === null || mtimeMilliseconds > latest))
        latest = mtimeMilliseconds
    }
    return latest
  }

  invalidate(): void {
    this.index.invalidate()
  }

  private static async mtimeOf(file: string): Promise<number | null> {
    try { return (await stat(file)).mtimeMs }
    catch { return null }
  }

  private static async firstUserMessage(file: string): Promise<string | null> {
    let head: string
    try { head = await CodexRolloutIndex.readPrefix(file, CodexSessionSource.previewReadBytesConst) }
    catch {
      // A rollout that vanished or got locked between the index and here costs its own preview, not
      // the whole listing.
      return null
    }
    let fallback: string | null = null
    for (const line of head.split('\n')) {
      const record = CodexSessionSource.parseRecord(line)
      if (!record) continue
      const message = ProviderTranscriptMessages.codex(record)
      if (message?.kind === 'explicit')
        return CodexSessionSource.sanitize(message.text)
      if (message?.kind === 'fallback') fallback ??= message.text
      if (fallback && ProviderTranscriptMessages.isCodexPromptBoundary(record))
        return CodexSessionSource.sanitize(fallback)
    }
    return fallback === null ? null : CodexSessionSource.sanitize(fallback)
  }

  /**
   * The same shape the Claude source produces. The two providers' summaries are shown in one merged
   * list, so a Codex row wrapping over ten lines next to a one-line Claude row is a defect of the
   * merge, not of either driver.
   */
  private static sanitize(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, CodexSessionSource.messageLengthConst)
  }

  /** The last line of a bounded read is half a record, and a rollout tolerates schema churn. */
  private static parseRecord(line: string): unknown {
    if (!line.trim()) return null
    try { return JSON.parse(line) as unknown }
    catch { return null }
  }

}
