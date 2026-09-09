import type { TerminalDetectorAgentId } from '../terminalDetectorApi.types'
import { CodexPathExtractor } from './codexPathExtractor'
import { TerminalPathExtractor } from './terminalPathExtractor'

export class PathExtractors {
  private static readonly baseConst = new TerminalPathExtractor()
  private static readonly codexConst = new CodexPathExtractor()

  /**
   * A shell session has no agent and gets the base. Claude gets it too: its only difference from
   * the base was keeping `…` inside the token, and that character class now belongs to the
   * renderer's buffer scan, which is unified across agents. A third agent gets its own class here.
   */
  static of(agentId: TerminalDetectorAgentId | null): TerminalPathExtractor {
    if (agentId === null) return PathExtractors.baseConst
    if (agentId === 'claude') return PathExtractors.baseConst
    if (agentId === 'codex') return PathExtractors.codexConst
    throw new Error(`Unknown agent id: ${JSON.stringify(agentId)}`)
  }
}
