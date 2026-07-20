/**
 * Renderer-relevant Codex metadata shared by `CodexAdapter` and the renderer registry.
 *
 * Pure — types only. Safe for the Vite renderer bundle.
 */

import type { AgentCapabilities } from '../types.js'

export const CODEX_PROMPT_NEWLINE_SEQUENCES = {
  standard: '\n',
  win32InputMode: '\x1b[74;36;10;1;8;1_',
} as const

/**
 * Codex's feature set. Live context comes from paired `turn_context` + `token_count`
 * rollout records; live-pid tracking remains unavailable. `execModels` is filled in
 * U8 from verified model ids. Fork IS supported (`codex fork <id>`), made
 * restart-safe by the launched-session resolver (activePids stays false — id is resolved
 * by cwd+mtime, not process ancestry).
 */
export const CODEX_CAPABILITIES: AgentCapabilities = {
  fork: true,
  liveRename: true,
  contextPercent: true,
  usageSource: 'codex-app-server',
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

export const codexRenameSlash = (name: string): string => `/rename ${name}`
