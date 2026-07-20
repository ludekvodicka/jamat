/**
 * Universal agent adapter interface implemented by the Claude and Codex
 * backends. New agents slot in without changing consumer contracts.
 *
 * Filesystem, session, launcher, capability, and slash-command differences live here. Stateful TUI
 * classification is renderer-only and uses the separate `AgentWorkDetectorBase` hierarchy.
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
  /**
   * Payload piped to the exec's stdin (e.g. a git diff for the AI commit summary).
   * The ADAPTER decides placement — Claude appends it after the prompt on stdin;
   * Codex passes the prompt as a `codex exec` arg and the payload alone on stdin.
   */
  stdinPayload?: string
}

// ────────────────────────────────────────────────────────────────────────────
// Per-agent capabilities — declarative feature flags read instead of
// `agent === 'claude'` literal checks scattered across the UI / main process.
// Pure data (no fs), so the same object is exposed by both the main-process
// registry and the renderer-safe registry (see renderer-meta.ts / renderer.ts).
// ────────────────────────────────────────────────────────────────────────────

/** How an agent's isolated (Docker) launch is parameterized. `null` capability = no isolation. */
export interface AgentDockerSpec {
  /** Image tag built/run for this agent (e.g. 'jamat-isolated' / 'jamat-isolated-codex'). */
  image: string
  /** Build-context dir under the monorepo root (e.g. 'dockerized-claude' / 'dockerized-codex'). */
  contextDirName: string
  /** Host config dir name (e.g. '.claude' / '.codex'); per-project home = `<projectDir>-home`. */
  configDirName: string
  /** Credential file inside the config dir synced into the container ('.credentials.json' / 'auth.json'). */
  credentialFile: string
  /** In-container user; mount target is `/home/<containerUser>/<configDirName>`. */
  containerUser: string
}

export interface AgentCapabilities {
  /** Session forking (`--fork-session`). false → Fork UI hidden, 'resume-fork' rejected. */
  fork: boolean
  /** Live in-TUI rename slash command. false → rename degrades to on-disk (or not at all). */
  liveRename: boolean
  /** Per-tab context-fullness % is derivable from this agent's transcript. */
  contextPercent: boolean
  /** Which backend feeds the usage panel for this agent. */
  usageSource: 'claude-web' | 'codex-app-server' | 'none'
  /** Agent tracks live pids (sessionId resolution by process ancestry). */
  activePids: boolean
  /** Docker isolation spec; null = unsupported → loud refusal at launch. */
  docker: AgentDockerSpec | null
  /** One-shot exec models offered for the AI-commit summary. First entry = default. */
  execModels: readonly { id: string; label: string }[]
}

export interface SessionTitleWatchTarget {
  dir: string
  base: string
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
  /** Declarative feature flags — read instead of `id === 'claude'` checks. */
  readonly capabilities: AgentCapabilities

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
   * The session's custom title from the agent's native rename store. Null
   * when the session was never renamed (or the agent has no such concept).
   */
  getSessionTitle(sessionFile: string): string | null

  /** File whose changes can alter `getSessionTitle()` for this session. */
  getSessionTitleWatchTarget(projectDir: string, sessionId: string, homeDir: string): SessionTitleWatchTarget | null

  /**
   * Currently-running sessions with the OS pid that owns each. Lets a caller
   * map a terminal to its session by process ancestry (the agent process is a
   * descendant of the terminal's pty) — the only reliable link when a session
   * was launched via "continue latest" with no sessionId known up front.
   * Empty when the agent doesn't track live pids.
   */
  listActivePids(homeDir: string): { pid: number; sessionId: string }[]

  /**
   * Resolve the session id a JUST-LAUNCHED terminal landed on, for agents that do NOT
   * track live pids (`capabilities.activePids === false`) — Codex keys sessions by cwd+date,
   * not by process, so pid ancestry can't link a terminal to its session. Returns the newest
   * session for `projectDir` whose transcript was created/touched at or after `sinceMs` (the
   * launch time), i.e. the one this launch created (a new `cc` session, or a fork's new id —
   * NOT the fork parent). Null until it exists, so the caller keeps polling. Base default is
   * null (pid-tracking agents use `listActivePids` instead).
   */
  resolveLaunchedSession(projectDir: string, homeDir: string, sinceMs: number): { sessionId: string } | null

  /** Complete effective model, effort, and context snapshot for one exact session. */
  readSessionModelInfo(sessionFile: string, projectDir: string, homeDir: string): SessionModelInfo | null

  // --- 4. CLI invocation ---

  /** Build the launch command for a MenuSelection (resume / new / continue). */
  buildLaunchCommand(sel: MenuSelection, mode: LaunchMode, opts?: { dockerContextDir?: string; skipPermissions?: boolean }): LaunchCommand

  /** Build the exec / one-shot command for non-interactive prompts (AI commit summary). */
  buildExecCommand(prompt: string, model: string, opts?: ExecOptions): ExecCommand

  /**
   * Reduce the exec's raw stdout to the final assistant text ('' when none found).
   * Claude prints plain text (trimmed identity); Codex streams NDJSON events that
   * must be reduced to the last assistant message.
   */
  parseExecOutput(raw: string): string

  // --- 6. Slash commands we pipe to the running TUI ---

  /** Slash command text that updates the live session title. The renderer owns submission encoding. */
  renameSlashCommand(name: string): string | null

  // --- 7. Permission / settings detection ---

  /** Files this agent reads for permission config, in priority order (highest first). */
  permissionConfigPaths(projectDir: string, homeDir: string): string[]
}
