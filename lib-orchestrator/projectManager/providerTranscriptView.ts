import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { ClaudeConfigHome } from '../shared/claudeConfigHome'
import type { ProviderAgentId } from './providers/providerContract.types'
import { ClaudeProjectsLocator } from './providers/claude/claudeProjectsLocator'
import { CodexRolloutIndex } from './providers/codex/codexRolloutIndex'
import { CodexSessionSource } from './providers/codex/codexSessionSource'

export interface ProviderTranscriptRef {
  agentId: ProviderAgentId
  nativeSessionId: string
  file: string
  mtimeMs: number
  size: number
}

export interface ProviderTranscriptViewOptions {
  claudeHome?: string
  codexHome?: string
  claudeLocator?: ClaudeProjectsLocator
  codexIndex?: CodexRolloutIndex
  report?: (message: string) => void
}

export class ProviderTranscriptView {
  private static readonly sessionIdPatternConst = /^[A-Za-z0-9_-]+$/

  private readonly claudeLocator: ClaudeProjectsLocator
  private readonly codexIndex: CodexRolloutIndex

  constructor(options?: ProviderTranscriptViewOptions) {
    const claudeHome = ClaudeConfigHome.resolve(options?.claudeHome)
    const codexHome = options?.codexHome ?? CodexSessionSource.defaultHome()
    this.claudeLocator = options?.claudeLocator ?? new ClaudeProjectsLocator(claudeHome)
    this.codexIndex = options?.codexIndex ?? new CodexRolloutIndex(codexHome, options?.report)
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
