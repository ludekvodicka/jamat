/**
 * Renderer-relevant Codex metadata. Placeholder values until the Codex
 * adapter ships — shared by `CodexAdapter` and the renderer registry so
 * the never-match pattern set and null rename slash live in one place.
 *
 * Pure — types only. Safe for the Vite renderer bundle.
 */

import type { AgentTtyPatterns } from '../types.js'

/** Never-match set — real Codex TUI markers unknown until the adapter is implemented. */
export const CODEX_TTY_PATTERNS: AgentTtyPatterns = {
  toolUse: /(?!.*)/,
  blocked: [],
}

/** Codex has no documented `/rename` equivalent → skip the pipe. */
export const codexRenameSlash = (_name: string): string | null => null
