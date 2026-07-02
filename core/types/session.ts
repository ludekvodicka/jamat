export interface SessionInfo {
  sessionId: string
  slug: string | null
  firstUserMessage: string | null
  // Date when produced in main; serializes to ISO string across the Electron
  // IPC boundary. Renderer-side code must coerce via `new Date(value)`.
  createdAt: Date | string
  lastActivity: Date | string
  active: boolean
}

/**
 * One conversation message extracted from a JSONL transcript, returned by
 * the `sessions:load` IPC. Shared between main (producer) and renderer
 * (consumer) so the shape can't drift.
 */
export interface SessionMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

/**
 * One snippet hit returned by the `sessions:search*` IPCs. `projectDir` is
 * present on cross-project search results (search-all) and absent on a
 * project-scoped search.
 */
export interface SessionSearchMatch {
  sessionId: string
  sessionLabel: string | null
  sessionDate: string
  timestamp: string
  role: 'user' | 'assistant'
  snippet: string
  projectDir?: string
}

export interface LatestSessionMeta {
  createdAt: Date
  lastActivity: Date
  label: string | null
}

export interface SessionModelInfo {
  /** Raw model id from the transcript, e.g. "claude-opus-4-7" */
  model: string
  /** Human label, e.g. "Opus 4.7" */
  modelLabel: string
  /** Tokens currently occupying the context window (last assistant turn). */
  contextTokens: number
  /** Max context window for the model, e.g. 1_000_000. */
  contextWindow: number
  /**
   * Effort level resolved from Claude Code's settings.json files
   * (project settings.local.json > project settings.json > user-global).
   * Common values: "low" | "medium" | "high" | "xhigh". `null` when not set.
   */
  effortLevel: string | null
}

export interface UsageCache {
  fetchedAt: number
  data: {
    five_hour: { utilization: number; resets_at: string }
    seven_day: { utilization: number; resets_at: string }
    seven_day_sonnet?: { utilization: number; resets_at: string }
    seven_day_omelette?: { utilization: number; resets_at: string }
  } | null
  error?: string
}

/**
 * One tool_use Edit/Write/NotebookEdit captured from a JSONL transcript.
 * Edit has oldString+newString; Write has content (oldString is null).
 */
export interface EditStep {
  tool: 'Edit' | 'Write' | 'NotebookEdit'
  oldString: string | null
  newString: string | null
  content: string | null
  replaceAll: boolean
}

/**
 * Aggregated edits for one file within one turn. `beforeText`/`afterText`
 * is a synthetic composition over all steps in the turn — for Edit chains
 * it covers the affected region only (not the whole file); for Write it
 * covers the full new content.
 */
export interface FileTurnEdit {
  filePath: string
  editCount: number
  isNewFile: boolean
  isOverwritten: boolean
  beforeText: string
  afterText: string
  steps: EditStep[]
  /**
   * True when `beforeText`/`afterText` glue together disjoint file regions
   * (see `ComposeResult.disjoint`). Real line-number anchoring is suppressed
   * for such edits.
   */
  disjoint: boolean
  /**
   * Best-effort 1-based line number where `afterText` begins in the file on
   * disk. `null` when the region could not be located unambiguously (file
   * changed, region duplicated, content too short, or `disjoint`). Attached
   * fresh by the `session-changes:get` IPC handler — not part of the parser
   * cache.
   */
  afterStartLine?: number | null
}

/**
 * One conversation turn: a user message followed by the assistant's
 * response with any tool calls. `files` lists files that this turn
 * modified via Edit/Write/NotebookEdit.
 */
export interface TurnInfo {
  turnIndex: number
  timestampISO: string | null
  userPromptText: string
  userPromptTextShort: string
  files: FileTurnEdit[]
}
