/**
 * Claude terminal file-path extraction. Claude's TUI elides long paths with an ellipsis
 * (`2026-07-10-001-…-plan.md`). The ONLY thing Claude changes is the buffer-scan character class:
 * keep U+2026 inside the token so the whole truncated name survives the scan. The universal
 * `resolve()` already emits a project-tree search candidate for it, and `file:find-by-suffix` treats
 * the `…` as a wildcard (see `TerminalFilePathExtractor.segTester`).
 */

import type { AgentId } from '../types/contracts.js'
import { TerminalFilePathExtractor } from './terminalFilePathExtractor.js'

export class ClaudeFilePathExtractor extends TerminalFilePathExtractor {
  readonly agent: AgentId = 'claude'
  readonly pathChars: RegExp = /[a-zA-Z0-9._\-\\/:~…]/
}
