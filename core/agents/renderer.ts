/**
 * Renderer-safe agent registry. The full `AgentAdapter` registry in
 * `./index.ts` instantiates adapter classes that transitively import
 * `fs`, `path`, `os` — fine in the main process / CLI, but Vite
 * externalizes those for the renderer bundle and the resulting
 * undefined symbols break the build.
 *
 * This file is a thin slice of the adapter surface that the renderer
 * actually needs:
 * - Per-agent work-detector factory for `useTerminal.ts`.
 * - Prompt-newline input encoding for `useTerminal.ts`'s Shift+Enter handler.
 * - `renameSlashCommand` for `CustomTab.tsx`'s rename pipe.
 *
 * Everything that touches the filesystem (session discovery, JSONL
 * parsing, CLI launcher) goes through IPC instead. No `fs` import here.
 */

import type { AgentId } from '../types/contracts.js'
import type { AgentCapabilities } from './types.js'
import { AgentWorkDetectorBase } from './workDetection/agentWorkDetectorBase.js'
import type { AgentWorkDetectorCallbacks, AgentWorkDetectorScheduler } from './workDetection/agentWorkDetector.types.js'
import { AgentWorkDetectorClaude } from './claude/agentWorkDetectorClaude.js'
import { CLAUDE_CAPABILITIES, CLAUDE_PROMPT_NEWLINE_SEQUENCES, claudeRenameSlash } from './claude/renderer-meta.js'
import { AgentWorkDetectorCodex } from './codex/agentWorkDetectorCodex.js'
import { CODEX_CAPABILITIES, CODEX_PROMPT_NEWLINE_SEQUENCES, codexRenameSlash } from './codex/renderer-meta.js'

export interface PromptNewlineSequences {
  readonly standard: string
  readonly win32InputMode: string
}

export interface RendererAgent {
  readonly id: AgentId
  readonly displayName: string
  /** Same declarative flags as the main-process adapter (fs-free pure data). */
  readonly capabilities: AgentCapabilities
  /** PTY bytes that insert a newline without submitting under each xterm input mode. */
  readonly promptNewlineSequences: PromptNewlineSequences
  createWorkDetector(callbacks: AgentWorkDetectorCallbacks, scheduler?: AgentWorkDetectorScheduler): AgentWorkDetectorBase
  /** Slash command text to update the live session title. Null when not supported. */
  renameSlashCommand(name: string): string | null
}

const CLAUDE_RENDERER: RendererAgent = {
  id: 'claude',
  displayName: 'Claude',
  capabilities: CLAUDE_CAPABILITIES,
  promptNewlineSequences: CLAUDE_PROMPT_NEWLINE_SEQUENCES,
  createWorkDetector: (callbacks, scheduler) => new AgentWorkDetectorClaude(callbacks, scheduler),
  renameSlashCommand: claudeRenameSlash,
}

const CODEX_RENDERER: RendererAgent = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: CODEX_CAPABILITIES,
  promptNewlineSequences: CODEX_PROMPT_NEWLINE_SEQUENCES,
  createWorkDetector: (callbacks, scheduler) => new AgentWorkDetectorCodex(callbacks, scheduler),
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
