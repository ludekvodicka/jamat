/**
 * Registry of terminal file-path extractors, one per agent — mirrors `core/agents/renderer.ts`'s
 * `getRendererAgent`. Consumers select by the terminal's agent (`useTerminal` via `options.agent`,
 * `TerminalContextMenu` via `params.agent`).
 */

import type { AgentId } from '../types/contracts.js'
import { TerminalFilePathExtractor } from './terminalFilePathExtractor.js'
import { ClaudeFilePathExtractor } from './claudeFilePathExtractor.js'
import { CodexFilePathExtractor } from './codexFilePathExtractor.js'

const REGISTRY: ReadonlyMap<AgentId, TerminalFilePathExtractor> = new Map<AgentId, TerminalFilePathExtractor>([
  ['claude', new ClaudeFilePathExtractor()],
  ['codex', new CodexFilePathExtractor()],
])

export function getTerminalFilePathExtractor(id: AgentId): TerminalFilePathExtractor {
  const extractor = REGISTRY.get(id)
  if (!extractor) throw new Error(`unknown agent id: ${id}`)
  return extractor
}
