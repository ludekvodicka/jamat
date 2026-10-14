/**
 * What runs inside one agent session besides its own conversation, as the renderer reads it. The
 * renderer compiles this file, so it has no imports at all and never grows one.
 */

export type SessionTaskAgentId = 'claude' | 'codex'

export type SessionSubagentState = 'running' | 'done' | 'failed' | 'stopped' | 'unfinished'

export interface SessionSubagentRow {
  kind: 'subagent'
  /**
   * Claude: the `<id>` of `agent-<id>.jsonl`, the same id a depth-2 meta names as its parent. Codex:
   * the child thread id.
   */
  subagentId: string
  /** `Explore`, `general-purpose`, `workflow` for an agent a workflow started; Codex: the nickname. */
  agentType: string
  description: string
  depth: 1 | 2
  parentSubagentId: string | null
  state: SessionSubagentState
  startedAt: number
  endedAt: number | null
  model: string | null
  /** One line, at most 160 characters: `Bash pnpm test`, `Read docs/x.md`. Null once the state settled. */
  step: string | null
}

export type SessionShellState = 'running' | 'done' | 'failed' | 'killed' | 'unfinished'

/** A background shell the session's own agent started; a sub-agent's own shells are not listed. */
export interface SessionShellRow {
  kind: 'shell'
  /** Claude Code's `b<id>`. */
  shellId: string
  /** The first line of the command, at most 160 characters. */
  command: string
  /** What the agent said the command does, when it said so. */
  description: string | null
  state: SessionShellState
  startedAt: number
  endedAt: number | null
}

export type SessionTaskRow = SessionSubagentRow | SessionShellRow

/** What the session's own snapshot says about it at the time of the listing. */
export interface SessionTaskParentState {
  live: boolean
  busy: boolean
  now: number
}

export type SessionTaskNoneCode =
  | 'not-agent'
  | 'native-session-id-pending'
  | 'transcript-not-found'
  | 'unknown-task'
  | 'unreadable'

export type SessionTaskListing =
  | {
    kind: 'tasks'
    /** Running rows first, then at most 50 settled rows, newest first. */
    rows: readonly SessionTaskRow[]
    /**
     * Settled rows left out: past the newest 50, the sub-agent files past the newest 60 that were
     * never read, and the finished shells the transcript scan no longer keeps.
     */
    olderFinished: number
    /** The transcript scan has not reached the end of the parent transcript yet; ask again soon. */
    catchingUp: boolean
  }
  | { kind: 'none'; code: SessionTaskNoneCode; reason: string }

/**
 * One step of a sub-agent, bounded: text at most 4,000 characters, tool output at most 2,000, an
 * edit's preview at most 20 lines. Every text is the agent's or a tool's own, untrusted.
 */
export type SessionSubagentEntry =
  | { kind: 'prompt'; text: string; truncated: boolean }
  | { kind: 'message'; role: 'assistant' | 'user'; text: string; truncated: boolean; at: number | null }
  | {
    kind: 'tool'
    tool: string
    /** One line, at most 160 characters: the command, path, pattern or description of the call. */
    summary: string
    /** Null until the result arrives, and for a result without text. */
    output: string | null
    outputTruncated: boolean
    failed: boolean
    at: number | null
  }
  | { kind: 'edit'; path: string; added: number; removed: number; preview: string; at: number | null }
  | { kind: 'thinking'; at: number | null }
  | { kind: 'compact'; at: number | null }
  | { kind: 'interrupted'; at: number | null }
  /** A Codex inter-agent message whose payload is encrypted (`gAAAA...`): only that it was sent is known. */
  | { kind: 'encrypted'; at: number | null }
  | { kind: 'error'; text: string; at: number | null }

export interface SessionSubagentHeader {
  agentType: string
  description: string
  model: string | null
  state: SessionSubagentState
  /** Claude: input plus cache read plus cache creation tokens of the last turn. Codex: the last turn's total. */
  contextTokens: number | null
}

export type SessionSubagentTranscript =
  | {
    kind: 'transcript'
    /** `mtimeMs:size` of the file read; sent back as `known`, it answers `unchanged` without a read. */
    revision: string
    header: SessionSubagentHeader
    entries: readonly SessionSubagentEntry[]
    /** The read began past the prompt: steps between the prompt and the tail are left out. */
    earlierStepsOmitted: boolean
  }
  | { kind: 'unchanged'; revision: string }
  | { kind: 'none'; code: SessionTaskNoneCode; reason: string }

/** The end of one background shell's output, as plain text: terminal control sequences removed. */
export type SessionShellOutput =
  | {
    kind: 'output'
    /** `mtimeMs:size:state`; sent back as `known`, it answers `unchanged` without a read. */
    revision: string
    command: string
    state: SessionShellState
    startedAt: number
    endedAt: number | null
    /** At most the last 64 KiB of the output file. */
    text: string
    /** The read began past the start of the file. */
    earlierOutputOmitted: boolean
  }
  | { kind: 'unchanged'; revision: string }
  | { kind: 'none'; code: SessionTaskNoneCode; reason: string }
