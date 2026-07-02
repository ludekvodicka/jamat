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

import type { AgentTtyPatterns } from '../types.js'
import { CLAUDE_TOOL_USE_PATTERN, CLAUDE_BLOCKED_PATTERNS, CLAUDE_BUSY_PATTERN, CLAUDE_BUSY_SPACED_PATTERN, CLAUDE_QUESTION_MENU_PATTERN } from './patterns.js'

export const CLAUDE_TTY_PATTERNS: AgentTtyPatterns = {
  toolUse: CLAUDE_TOOL_USE_PATTERN,
  blocked: CLAUDE_BLOCKED_PATTERNS,
  busy: CLAUDE_BUSY_PATTERN,
  busySpaced: CLAUDE_BUSY_SPACED_PATTERN,
  questionMenu: CLAUDE_QUESTION_MENU_PATTERN,
}

export const claudeRenameSlash = (name: string): string => `/rename ${name}\r`
