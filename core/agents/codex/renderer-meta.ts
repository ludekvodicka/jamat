/**
 * Renderer-relevant Codex metadata. Placeholder values until the Codex
 * adapter ships — shared by `CodexAdapter` and the renderer registry.
 *
 * Pure — types only. Safe for the Vite renderer bundle.
 */

import type { AgentCapabilities, AgentTtyPatterns } from '../types.js'

export const CODEX_PROMPT_NEWLINE_SEQUENCES = {
  standard: '\n',
  win32InputMode: '\x1b[74;36;10;1;8;1_',
} as const

/** Never-match set — real Codex TUI markers get filled in by U3 from the U2 fixture. */
export const CODEX_TTY_PATTERNS: AgentTtyPatterns = {
  toolUse: /(?!.*)/,
  blocked: [],
}

/**
 * Codex's feature set. Several capabilities are intentionally off vs Claude:
 * no live-pid tracking. `contextPercent` stays false until the
 * U2 spike confirms the rollout carries usable token data; `execModels` is filled in
 * U8 from the spike's verified model ids. Fork IS supported (`codex fork <id>`), made
 * restart-safe by the launched-session resolver (activePids stays false — id is resolved
 * by cwd+mtime, not process ancestry).
 */
export const CODEX_CAPABILITIES: AgentCapabilities = {
  fork: true,
  liveRename: true,
  contextPercent: false,
  usageSource: 'openai',
  activePids: false,
  docker: {
    image: 'jamat-isolated-codex',
    contextDirName: 'dockerized-codex',
    configDirName: '.codex',
    credentialFile: 'auth.json',
    containerUser: 'codex',
  },
  execModels: [],
}

export const codexRenameSlash = (name: string): string => `/rename ${name}\r`
