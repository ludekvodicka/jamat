/**
 * Renderer-safe agent registry. The full `AgentAdapter` registry in
 * `./index.ts` instantiates adapter classes that transitively import
 * `fs`, `path`, `os` — fine in the main process / CLI, but Vite
 * externalizes those for the renderer bundle and the resulting
 * undefined symbols break the build.
 *
 * This file is a thin slice of the adapter surface that the renderer
 * actually needs:
 * - TUI pattern set for `useTerminal.ts`'s indicator state machine.
 * - Prompt-newline input encoding for `useTerminal.ts`'s Shift+Enter handler.
 * - `renameSlashCommand` for `CustomTab.tsx`'s rename pipe.
 *
 * Everything that touches the filesystem (session discovery, JSONL
 * parsing, CLI launcher) goes through IPC instead. No `fs` import here.
 */

import type { AgentId } from '../types/contracts.js'
import type { AgentCapabilities, AgentTtyPatterns } from './types.js'
import { CLAUDE_TTY_PATTERNS, CLAUDE_CAPABILITIES, CLAUDE_PROMPT_NEWLINE_SEQUENCES, claudeRenameSlash } from './claude/renderer-meta.js'
import { CODEX_TTY_PATTERNS, CODEX_CAPABILITIES, CODEX_PROMPT_NEWLINE_SEQUENCES, codexRenameSlash } from './codex/renderer-meta.js'

export interface PromptNewlineSequences {
  readonly standard: string
  readonly win32InputMode: string
}

export interface RendererAgent {
  readonly id: AgentId
  readonly ttyPatterns: AgentTtyPatterns
  /** Same declarative flags as the main-process adapter (fs-free pure data). */
  readonly capabilities: AgentCapabilities
  /** PTY bytes that insert a newline without submitting under each xterm input mode. */
  readonly promptNewlineSequences: PromptNewlineSequences
  /** Slash command to update the live session title. Null when not supported. */
  renameSlashCommand(name: string): string | null
}

const CLAUDE_RENDERER: RendererAgent = {
  id: 'claude',
  ttyPatterns: CLAUDE_TTY_PATTERNS,
  capabilities: CLAUDE_CAPABILITIES,
  promptNewlineSequences: CLAUDE_PROMPT_NEWLINE_SEQUENCES,
  renameSlashCommand: claudeRenameSlash,
}

const CODEX_RENDERER: RendererAgent = {
  id: 'codex',
  ttyPatterns: CODEX_TTY_PATTERNS,
  capabilities: CODEX_CAPABILITIES,
  promptNewlineSequences: CODEX_PROMPT_NEWLINE_SEQUENCES,
  renameSlashCommand: codexRenameSlash,
}

const RENDERER_REGISTRY: ReadonlyMap<AgentId, RendererAgent> = new Map([
  ['claude', CLAUDE_RENDERER],
  ['codex', CODEX_RENDERER],
])

export function getRendererAgent(id: AgentId): RendererAgent {
  const a = RENDERER_REGISTRY.get(id)
  if (!a) throw new Error(`unknown agent id: ${id}`)
  return a
}
