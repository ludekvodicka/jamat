/**
 * Types shared by the FileViewer inline-diff feature. The IPC payload uses
 * a discriminated `DiffMode` union so the renderer can construct/parse the
 * selector state without string-typing it.
 */

// ────────────────────────────────────────────────────────────────────────────
// VCS detection / baseline
// ────────────────────────────────────────────────────────────────────────────

export type BaselineSource = 'git' | 'svn'

export interface VcsRepoInfo {
  source: BaselineSource
  /**
   * Topmost ancestor dir holding the VCS marker (`.git/` for git, the
   * outermost `.svn/`-holding dir for svn). Stable cache key.
   */
  repoRoot: string
}

export interface VcsDetection {
  git: VcsRepoInfo | null
  svn: VcsRepoInfo | null
}

/**
 * Result of fetching one baseline content blob from a VCS.
 *
 * `exists=false` means the file is not tracked at this ref (added later in
 * git history, or never under svn) — content is `''`, the UI renders the
 * diff as all-`+`. `error` set means the subprocess itself failed (binary
 * missing, repo corrupted) — the UI renders no diff and surfaces the error.
 */
export interface BaselineFetch {
  content: string
  exists: boolean
  /** Commit/revision timestamp at this ref, unix epoch ms; null when unknown. */
  timestamp: number | null
  error?: string
}

// ────────────────────────────────────────────────────────────────────────────
// IPC: selector options + baseline payload
// ────────────────────────────────────────────────────────────────────────────

export type DiffMode =
  | { kind: 'git-head' }
  | { kind: 'git-head-back'; n: number }
  | { kind: 'svn-base' }
  | { kind: 'session-start' }
  | { kind: 'session-last-turn' }
  | { kind: 'session-turn-back'; n: number }
  | { kind: 'off' }

export type DiffGroup = 'working-copy' | 'claude-session' | 'off'

export interface DiffOption {
  mode: DiffMode
  label: string
  enabled: boolean
  /** Tooltip text when disabled (e.g. "svn not in PATH"). */
  reason?: string
  group: DiffGroup
  meta?: {
    /** Unix epoch ms for git/svn commit; ISO/HH:MM for session turns. */
    commitDate?: number
    shortSha?: string
    sessionId?: string
    turnIndex?: number
    promptPreview?: string
  }
}

export interface DiffOptions {
  options: DiffOption[]
  defaultMode: DiffMode
  /**
   * Session that the panel resolved for diff purposes — either the caller-
   * supplied sessionId, the project's active session, or the most recent
   * past session that has edits to this file (cross-session fallback for
   * files developed across multiple sessions). The renderer must echo this
   * back when calling `file-diff:get-baseline` so the baseline matches the
   * dropdown options.
   */
  effectiveSessionId?: string | null
}

export interface DiffBaseline {
  beforeText: string
  afterText: string
  /** Selector-friendly label, e.g. "Since last commit (HEAD: feat)". */
  label: string
  addedLines: number
  removedLines: number
  /**
   * True when the session compose path could not reconstruct a whole-file
   * before — the diff is region-scoped only (no full surrounding context).
   */
  isRegionOnly: boolean
  regionOnlyReason?: string
  /** Subprocess or parse error — UI shows status text, no DiffView. */
  error?: string
  /**
   * Region-scoped before/after, present for session-* modes. Lets the renderer
   * offer a Region ↔ Full file toggle without re-querying the backend: full
   * file lives in beforeText/afterText (after substitution), the raw JSONL
   * region lives here. Absent for VCS modes where no "region" notion exists.
   */
  regionBefore?: string
  regionAfter?: string
  /** True when the region was glued from non-adjacent hunks — disables Full file toggle. */
  disjoint?: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Session compose helper
// ────────────────────────────────────────────────────────────────────────────

export type SessionPoint =
  | { kind: 'session-start' }
  | { kind: 'last-turn' }
  | { kind: 'turn-back'; n: number }

export interface SessionBaselineResult {
  beforeText: string
  afterText: string
  isRegionOnly: boolean
  regionOnlyReason?: string
  /** Raw JSONL region anchors — bubbled up so the renderer can offer a Region toggle. */
  regionBefore?: string
  regionAfter?: string
  disjoint?: boolean
}
