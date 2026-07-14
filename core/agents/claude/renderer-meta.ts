/**
 * Renderer-relevant Claude metadata — the bits the renderer needs
 * (TUI pattern set, rename slash) without dragging in the fs-touching
 * adapter modules. Shared by `ClaudeAdapter` (full, main-process) and
 * the renderer registry (`core/agents/renderer.ts`) so the values live
 * in exactly one place.
 *
 * Pure — imports only regex constants and types. Safe for the Vite
 * renderer bundle.
 */

import type { AgentCapabilities, AgentTtyPatterns } from '../types.js'
import { CLAUDE_TOOL_USE_PATTERN, CLAUDE_BLOCKED_PATTERNS, CLAUDE_BUSY_PATTERN, CLAUDE_BUSY_WIDE_PATTERN, CLAUDE_BUSY_SPACED_PATTERN, CLAUDE_QUESTION_MENU_PATTERN, CLAUDE_BG_SHELL_PATTERN } from './patterns.js'

export const CLAUDE_PROMPT_NEWLINE_SEQUENCES = {
  standard: '\x1b[13;2u',
  win32InputMode: '\x1b[13;2u',
} as const

export const CLAUDE_TTY_PATTERNS: AgentTtyPatterns = {
  toolUse: CLAUDE_TOOL_USE_PATTERN,
  blocked: CLAUDE_BLOCKED_PATTERNS,
  busy: CLAUDE_BUSY_PATTERN,
  busyWide: CLAUDE_BUSY_WIDE_PATTERN,
  busySpaced: CLAUDE_BUSY_SPACED_PATTERN,
  questionMenu: CLAUDE_QUESTION_MENU_PATTERN,
  bgShell: CLAUDE_BG_SHELL_PATTERN,
}

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

export const claudeRenameSlash = (name: string): string => `/rename ${name}\r`
