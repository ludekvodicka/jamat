import type { CustomRun } from './config.js'

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Agent id literal. Lives next to MenuSelection to avoid a cycle with core/agents/. */
export type AgentId = 'claude' | 'codex'

/**
 * Hard fallback used at every site that needs an agent but doesn't know
 * which one to commit to (e.g. a restored tab whose meta predates the
 * agent field). Single source of truth so changing the fallback is a
 * one-line edit.
 */
export const DEFAULT_AGENT_ID: AgentId = 'claude'

/** Runtime guard for unsafe inputs (IPC payloads, JSON config). */
const VALID_AGENT_IDS = ['claude', 'codex'] as const satisfies readonly AgentId[]
export function isAgentId(s: unknown): s is AgentId {
  return typeof s === 'string' && (VALID_AGENT_IDS as readonly string[]).includes(s)
}

export interface MenuSelection {
  dir: string
  cmd: 'cc' | 'ccc' | 'resume' | 'resume-fork'
  folderName: string
  isolated: boolean
  antiFlicker: boolean
  sessionId?: string
  /** For a forked session: the PARENT id it was forked from. When set on a `resume`, the
   *  launcher resumes `sessionId` but RE-FORKS this parent if that id is gone (a fork that never
   *  wrote a turn has no transcript yet, so plain `claude -r <fork>` would fail after a restart). */
  forkParentId?: string
  action?: 'open-in-screen' | 'launch-window' | 'docker-shell' | 'docker-rebuild' | 'docker-auth' | 'custom-run'
  /** Present iff `action === 'custom-run'`: the placeholder-resolved command the host spawns. */
  run?: CustomRun
  /**
   * Which agent the spawned PTY hosts. Required — every spawn path must
   * commit. Resolution order at the picker: explicit user pick → for
   * resume, the session file's owning adapter → config.defaultAgent →
   * 'claude' hard fallback.
   */
  agent: AgentId
}

export type LaunchMode = 'terminal' | 'pty' | 'detached'

export interface LaunchConfig {
  selection: MenuSelection
  mode: LaunchMode
  dockerContextDir?: string
  skipPermissions?: boolean
}

export interface LaunchCommand {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  fallback?: LaunchCommand
}
