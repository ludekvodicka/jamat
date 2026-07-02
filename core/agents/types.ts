/**
 * Universal agent adapter interface. Today only `ClaudeAdapter` is fully
 * implemented; `CodexAdapter` is a stub that throws "not implemented" so
 * the design is exercised by two consumers (real + stub) and a future
 * Codex implementation slots in without further refactor.
 *
 * The interface mirrors the 8 categories in
 * `docs/architecture/codex-portability-assessment.md` — every Claude
 * dependency listed there has a corresponding method here.
 *
 * Pure types — no electron / no node-pty / no fs imports. Adapter
 * implementations can use Node fs (already done across `core/`).
 */

import type { AgentId, LaunchCommand, LaunchMode, MenuSelection } from '../types/contracts.js'
import type { TurnInfo, SessionInfo, SessionModelInfo, LatestSessionMeta } from '../types/session.js'

export type { AgentId }

// ────────────────────────────────────────────────────────────────────────────
// Session / transcript data shapes (agent-agnostic)
// ────────────────────────────────────────────────────────────────────────────

/**
 * AgentSession aliases the existing `SessionInfo` shape so consumers
 * (SessionsSearchPanel, RecentFilesPanel, etc.) keep working without
 * rewrites. A future normalization pass could narrow this to the bare
 * adapter-required fields.
 */
export type AgentSession = SessionInfo

/** Adapter-level turn — aliases existing `TurnInfo` for the same reason. */
export type AgentTurnInfo = TurnInfo

// ────────────────────────────────────────────────────────────────────────────
// TUI pattern set — drives the turn-indicator state machine in useTerminal
// ────────────────────────────────────────────────────────────────────────────

export interface AgentTtyPatterns {
  /** Tool-call marker regex. Match → indicator goes 'tool-use'. */
  toolUse: RegExp
  /** Blocked-prompt regexes. ANY match → 'blocked'. */
  blocked: readonly RegExp[]
  /** Optional explicit thinking markers (e.g. Claude's "Crunching…"). */
  thinking?: readonly RegExp[]
  /**
   * Optional "actively working" marker (e.g. Claude's "esc to interrupt" hint).
   * The input box is always drawn, so its presence can't mean idle — but the
   * ABSENCE of this busy marker means the turn finished. The state machine uses
   * it for a fast idle edge (~1.2s) instead of waiting out the 15s silence timer.
   * Matched against the whitespace/ANSI-collapsed output (see `normalizeTty`).
   */
  busy?: RegExp
  /**
   * Optional SECOND busy marker matched against the SPACE-PRESERVED output (ANSI-stripped +
   * lowercased, whitespace kept — see `stripAnsiLower`). For markers whose signal is structural
   * (Claude's spinner "<glyph> <one-word>…", which collapsing would make indistinguishable from
   * prose). The classifier treats the turn as working when `busy` OR `busySpaced` matches.
   */
  busySpaced?: RegExp
  /**
   * Optional interactive-menu marker (e.g. Claude's "❯ 1. …" AskUserQuestion /
   * plan-approval list). Match → the turn paused for the user to choose, so the tab
   * goes 'waiting' rather than idle. Also matched against the collapsed output.
   */
  questionMenu?: RegExp
}

// ────────────────────────────────────────────────────────────────────────────
// Exec command — used for one-shot agent runs (AI commit summary)
// ────────────────────────────────────────────────────────────────────────────

export interface ExecCommand {
  command: string
  args: string[]
  /** Optional stdin payload (e.g. a git diff piped to the agent). */
  stdin?: string
}

export interface ExecOptions {
  /** Whitelist of tools the agent may invoke during the exec. Empty = no tools. */
  allowedTools?: string[]
  /** Run in plan mode (no tool execution). */
  permissionMode?: 'plan'
  /** Don't persist this spawn to session history. */
  ephemeral?: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// The adapter itself
// ────────────────────────────────────────────────────────────────────────────

export interface AgentAdapter {
  readonly id: AgentId
  /** User-facing label, e.g. "Claude" / "Codex". */
  readonly displayName: string
  /** Binary name to look up on PATH, e.g. "claude" / "codex". */
  readonly binary: string

  // --- 1. Filesystem ---

  /** Root directory under which this agent stores session transcripts. */
  sessionsRoot(homeDir: string): string

  /** Encode a real project dir into the agent's on-disk path scheme. */
  encodeProjectDir(projectDir: string): string

  // --- 2. Discovery ---

  /** List every project the agent has sessions for. */
  listProjects(homeDir: string): string[]

  /**
   * Resolve a real project dir → the agent's on-disk session storage dir
   * (e.g. the encoded `~/.claude/projects/<encoded>` folder). Null when
   * the project has no sessions yet. Tolerant of stale path encodings.
   */
  findProjectDir(projectDir: string, homeDir: string): string | null

  /** Sessions belonging to a specific project (takes the storage dir from findProjectDir). */
  listSessionsForProject(projectDir: string, homeDir: string): AgentSession[]

  /**
   * Latest-session metadata (created / last-activity / label) per project folder, for
   * the start-menu rows. `catPath` is the category's real dir, `folderNames` its project
   * subfolders. Agent-agnostic shape — the menu never touches agent internals.
   */
  buildSessionMetaCache(catPath: string, folderNames: string[]): Map<string, LatestSessionMeta>

  /** First human-readable lines of a session, for the session-picker preview pane. */
  loadSessionPreview(projectDir: string, sessionId: string): string[]

  /**
   * Drop the agent's internal discovery cache (e.g. the project-dir lookup) — call
   * after an on-disk layout change such as a project rename. No-op for cacheless
   * agents. (Distinct from menu-core's broader `invalidateCaches(state)` orchestration,
   * which also rebuilds the session-meta cache — this is just the adapter primitive.)
   */
  invalidateDiscoveryCache(): void

  /** Locate the JSONL file for a sessionId under this agent's root. Null when not found. */
  resolveSessionFile(projectDir: string, sessionId: string, homeDir: string): string | null

  /**
   * The active (or most-recently-active) session file for a project,
   * optionally pinned to a sessionId. Null when the project has no
   * transcripts.
   */
  resolveActiveSessionFile(projectDir: string, sessionId: string | null, homeDir: string): string | null

  /**
   * Find the JSONL file for a sessionId WITHOUT knowing the projectDir.
   * Used by the agent resolver at resume time to figure out which agent
   * owns a given sessionId.
   */
  findSessionFileById(sessionId: string, homeDir: string): string | null

  // --- 3. JSONL parsing ---

  /** Extract every turn (with edit details) from a session JSONL file. */
  extractTurns(sessionFile: string): AgentTurnInfo[]

  /** Quick check — does the session contain any file-editing tool calls? */
  hasFileEdits(sessionFile: string): boolean

  /** Unique absolute paths the session touched (used by the RecentFiles overlay). */
  extractEditedFiles(sessionFile: string): string[]

  /**
   * Append a "custom title" record so the rename survives restart.
   * Returns false when the agent's JSONL parser is known to reject
   * unknown record types (graceful degradation).
   */
  appendCustomTitle(sessionFile: string, sessionId: string, title: string): boolean

  /**
   * The session's custom (renamed) title, i.e. the name written by the
   * agent's rename mechanism — Claude's `/rename` / our rename modal both
   * append a `custom-title` record. Null when the session was never renamed
   * (or the agent has no such concept). Used to label tabs on launch/reopen
   * and to live-update them when the user renames inside the running TUI.
   */
  getSessionTitle(sessionFile: string): string | null

  /**
   * Currently-running sessions with the OS pid that owns each. Lets a caller
   * map a terminal to its session by process ancestry (the agent process is a
   * descendant of the terminal's pty) — the only reliable link when a session
   * was launched via "continue latest" with no sessionId known up front.
   * Empty when the agent doesn't track live pids.
   */
  listActivePids(homeDir: string): { pid: number; sessionId: string }[]

  /** Model + context info from a transcript's last assistant turn (null when unavailable). */
  readSessionModelInfo(sessionFile: string): SessionModelInfo | null

  /** Reasoning-effort / thinking level for a project (null when not applicable). */
  readEffortLevel(projectDir: string, homeDir: string): string | null

  // --- 4. CLI invocation ---

  /** Build the launch command for a MenuSelection (resume / new / continue). */
  buildLaunchCommand(sel: MenuSelection, mode: LaunchMode, opts?: { dockerContextDir?: string; skipPermissions?: boolean }): LaunchCommand

  /** Build the exec / one-shot command for non-interactive prompts (AI commit summary). */
  buildExecCommand(prompt: string, model: string, opts?: ExecOptions): ExecCommand

  // --- 5. TUI patterns ---

  readonly ttyPatterns: AgentTtyPatterns

  // --- 6. Slash commands we pipe to the running TUI ---

  /** Slash command that updates the live session title. Null when the agent has no such slash command. */
  renameSlashCommand(name: string): string | null

  // --- 7. Permission / settings detection ---

  /** Files this agent reads for permission config, in priority order (highest first). */
  permissionConfigPaths(projectDir: string, homeDir: string): string[]
}
