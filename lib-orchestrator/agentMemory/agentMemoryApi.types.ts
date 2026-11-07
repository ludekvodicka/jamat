export type AgentMemoryAgentId = 'claude' | 'codex'

/** Whose memory: an agent and the project directory it ran in, and optionally one conversation of it. */
export interface AgentMemoryQuery {
  scope?: 'project'
  agentId: AgentMemoryAgentId
  projectPath: string
  /** Marks the files this conversation wrote, read from its transcript. */
  nativeSessionId?: string
}

/**
 * What an agent keeps for its person across every project: Claude's `CLAUDE.md` and `rules/` in its
 * home, Codex's `AGENTS.md`, `AGENTS.override.md` and `memories/`.
 */
export interface AgentUserMemoryQuery {
  scope: 'user'
  agentId: AgentMemoryAgentId
}

export type AgentMemoryLocation = AgentMemoryQuery | AgentUserMemoryQuery

export interface AgentMemoryFile {
  /** Relative to the memory folder, with `/` between folders. */
  name: string
  size: number
  modifiedAt: number
  /** The conversation of the query wrote it, as its transcript shows. */
  writtenByConversation: boolean
}

export interface AgentMemoryListing {
  agentId: AgentMemoryAgentId
  directory: string
  /**
   * `project`: Claude's memory of one project. `global`: Codex's one memory for every project.
   * `user`: the agent's user-level files.
   */
  scope: 'project' | 'global' | 'user'
  files: AgentMemoryFile[]
  /** More files exist than a listing returns. */
  truncated: boolean
}

export interface AgentMemoryText {
  name: string
  text: string
  modifiedAt: number
}

export type AgentMemoryErrorCode = 'not-found' | 'invalid' | 'conflict' | 'too-large' | 'failed'

export type AgentMemoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AgentMemoryErrorCode; detail: string }
