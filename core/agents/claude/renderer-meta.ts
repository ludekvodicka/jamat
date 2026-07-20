/**
 * Renderer-relevant Claude metadata — the bits the renderer needs
 * (capabilities, prompt input, rename slash) without dragging in the fs-touching
 * adapter modules. Shared by `ClaudeAdapter` (full, main-process) and
 * the renderer registry (`core/agents/renderer.ts`) so the values live
 * in exactly one place.
 *
 * Pure data, safe for the Vite renderer bundle.
 */

import type { AgentCapabilities } from '../types.js'

export const CLAUDE_PROMPT_NEWLINE_SEQUENCES = {
  standard: '\x1b[13;2u',
  win32InputMode: '\x1b[13;2u',
} as const

/** Claude's feature set — the fully-featured reference backend. */
export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  fork: true,
  liveRename: true,
  contextPercent: true,
  usageSource: 'claude-web',
  activePids: true,
  docker: {
    image: 'jamat-isolated',
    contextDirName: 'dockerized-claude',
    configDirName: '.claude',
    credentialFile: '.credentials.json',
    containerUser: 'claude',
  },
  execModels: [
    { id: 'haiku', label: 'Haiku' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'opus', label: 'Opus' },
  ],
}

export const claudeRenameSlash = (name: string): string => `/rename ${name}`
