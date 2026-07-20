/**
 * Agent registry. Singleton instances per agent id; the registry is
 * populated at module load. Pattern mirrors the IpcInvokeMap registry
 * in `core/types/ipc-contracts.ts` — single source of truth for "which
 * agents exist".
 *
 * To add a third agent: create `core/agents/<id>/` implementing
 * `AgentAdapter`, import it here, and add it to the registry map.
 */

import { existsSync } from 'fs'
import { delimiter, join } from 'path'
import type { AgentAdapter, AgentId } from './types.js'
import { ClaudeAdapter } from './claude/index.js'
import { CodexAdapter } from './codex/index.js'

const registry = new Map<AgentId, AgentAdapter>([
  ['claude', new ClaudeAdapter()],
  ['codex', new CodexAdapter()],
])

/**
 * sessionId → owning agent memo. A session never changes owner, so a positive
 * hit is cached forever. Misses are NOT cached — the session may be created
 * after the miss. This keeps `resolveAgentForSessionId` (called per session
 * row + at every resume) cheap once Codex's `findSessionFileById` becomes a
 * real date-tree walk (gap #16).
 */
const ownerMemo = new Map<string, AgentId>()

export function getAgent(id: AgentId): AgentAdapter {
  const adapter = registry.get(id)
  if (!adapter) throw new Error(`unknown agent id: ${id}`)
  return adapter
}

/** All registered agents (whether usable or not). */
export function listAgents(): AgentAdapter[] {
  return [...registry.values()]
}

/**
 * Agents whose binary is on PATH. Used by the start-menu picker so we
 * don't offer agents the user hasn't installed.
 *
 * Synchronous PATH check — same approach as Windows `where`. Cheap
 * (existsSync per PATH dir × N binaries).
 */
export function listAvailableAgents(): AgentAdapter[] {
  return listAgents().filter((a) => isBinaryOnPath(a.binary))
}

function isBinaryOnPath(binary: string): boolean {
  const pathEnv = process.env['PATH'] ?? process.env['Path'] ?? ''
  const exts = process.platform === 'win32'
    ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      if (existsSync(join(dir, binary + ext.toLowerCase()))) return true
      if (existsSync(join(dir, binary + ext))) return true
    }
  }
  return false
}

/**
 * Find which agent owns a given sessionId by asking every registered
 * adapter whether the file lives under its sessions root. Returns null
 * when no adapter recognizes the id.
 *
 * Walks `listAgents()` (all registered), not `listAvailableAgents()` —
 * PATH presence shouldn't influence whether we recognize a session file
 * that exists on disk. Stub adapters MUST return null from
 * `findSessionFileById` until the adapter is real.
 *
 * Used at resume time: the user picks a sessionId from a list; we
 * derive the agent without making them re-pick.
 */
export function resolveAgentForSessionId(sessionId: string, homeDir: string): AgentId | null {
  const memoized = ownerMemo.get(sessionId)
  if (memoized) return memoized
  for (const adapter of listAgents()) {
    if (adapter.findSessionFileById(sessionId, homeDir)) {
      ownerMemo.set(sessionId, adapter.id)
      return adapter.id
    }
  }
  return null
}

export type { AgentAdapter, AgentId, AgentSession, AgentTurnInfo, ExecCommand, ExecOptions } from './types.js'
