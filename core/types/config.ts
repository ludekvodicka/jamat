import type { VirtualFolderDef } from '../menu-core/pure.js'
import type { AgentId, AgentPreLaunch } from './contracts.js'
export type { VirtualFolderDef } from '../menu-core/pure.js'
export type { AgentPreLaunch } from './contracts.js'

export interface CategoryJson {
  label: string
  path: string
  hiddenFolders?: string[]
  virtualFolders?: VirtualFolderDef[]
  flattenFolders?: string[]
}

export interface Category {
  label: string
  path: string
  hiddenFolders: Set<string>
  virtualFolders: VirtualFolderDef[]
  flattenFolders: Set<string>
}

/**
 * Built-in update config — KNOBS ONLY. The config cannot choose an update channel: the channel is
 * derived from the RUNTIME (`core/update/update-channel.ts`) — an installed build updates from the
 * GitHub Releases feed, a build running over its sources compares itself to the sources on disk, and
 * an installed macOS build has no channel (unsigned). Letting the config pick was a footgun: the old
 * Settings tab defaulted to `provider:'vcs'` and, once saved, silently disabled GitHub updates.
 */
export interface SelfUpdateConfig {
  /**
   * Background checking (Electron only). Default true. `false` disables only the background
   * watcher — the manual menu action / "Check now" still works.
   */
  autoCheck?: boolean
  /** Check cadence in minutes. Default 120 (installed/GitHub) or 15 (source-checkout disk poll). */
  checkIntervalMinutes?: number
  /** @deprecated Ignored — the channel follows the runtime. Present only so old configs still load. */
  provider?: string
  /** @deprecated Ignored — the app runs no VCS command; update the sources yourself. */
  vcs?: string
  /** @deprecated Ignored. */
  repoPath?: string
}

/**
 * One quick-prompt button in the "session finished" popup (Electron). On click the
 * `prompt` text is typed into the active session and submitted (Enter), so a finished
 * turn can be followed up with one click — "what's next", `/commit-svn`, etc.
 */
export interface SessionDonePrompt {
  /** Short button caption. */
  label: string
  /** Text typed into the session + Enter on click (a plain message or a slash command). */
  prompt: string
}

/**
 * A shell command a custom-menu leaf runs against the selected project. Placeholders
 * `{dir}` (absolute project path) and `{name}` (folder name) are substituted at dispatch.
 */
export interface CustomRun {
  command: string
  args?: string[]
  /** Working dir; absolute or `{dir}`. Default = the selected project dir. */
  cwd?: string
  /** CLI host only: wait for a keypress after it finishes (default true). */
  pause?: boolean
}

/**
 * One node of the config-driven project-action menu (F3 on a non-isolated project).
 * BRANCH (has `items`) opens a sub-menu; LEAF (has `run`) executes — exactly one of the
 * two. Recursive, so groups nest arbitrarily. Absent/empty `customMenus` → nothing shows.
 */
export interface CustomMenuNode {
  id?: string
  label: string
  /** Optional explicit key ("f1".."f12"); otherwise auto-assigned by position. */
  key?: string
  items?: CustomMenuNode[]
  run?: CustomRun
}

/**
 * Per-agent settings block. Currently only an optional pre-launch hook (`AgentPreLaunch`, defined
 * in `contracts.ts` beside `LaunchConfig`; re-exported above for convenience). The motivating case
 * is Codex's AGENTS.md packer — flattening our CLAUDE.md cascade into a Codex-native `AGENTS.md`
 * before the `codex` process starts.
 */
export interface AgentSettings {
  preLaunch?: AgentPreLaunch
}

/**
 * Per-agent configuration keyed by `AgentId` (`claude` / `codex`). Absent/empty → no hooks, the
 * public default: a clone runs Codex without the packer unless the user opts in here. Our private
 * (SVN-only) config sets `agents.codex.preLaunch` to the packer; the committed public config does not.
 */
export type AgentsConfig = Partial<Record<AgentId, AgentSettings>>

/**
 * One of the 4 fixed context-fullness warning levels (Electron status bar / overlay). The count is
 * fixed at 4 — only these values are user-editable (Settings → Context warnings). `pct` is the
 * context-window fill (0–100) at which the level activates; `popup` raises the centered
 * compact-suggest overlay on an idle session; `statusBar` lights the passive status-bar + per-tab
 * colour signal. The colour/glyph itself is derived in the renderer by severity rank, not stored.
 */
export interface ContextWarnLevel {
  pct: number
  popup: boolean
  statusBar: boolean
}

export interface AppConfig {
  name: string
  categories: Category[]
  /** Config-driven project-action menus (F3 on a non-isolated project): recursive
   *  groups → commands. Absent/empty → no custom actions are offered (public default). */
  customMenus?: CustomMenuNode[]
  /**
   * Quick prompts offered by the bottom-right popup that appears when a Claude
   * session finishes a (non-trivial) turn on the active tab. Absent → a small
   * built-in default list is used. The popup itself is toggled in app Settings.
   */
  sessionDonePrompts?: SessionDonePrompt[]
  /** Built-in "Update & Restart" config (menu action). Absent → action no-ops with a notice. */
  selfUpdate?: SelfUpdateConfig
  /**
   * The 4 fixed context-fullness warning levels (Electron). Absent → DEFAULT_CONTEXT_LEVELS
   * (35 % silent overlay; 45/75/85 % also colour the status bar). Count is always 4.
   */
  contextLevels?: ContextWarnLevel[]
  claudeUsage?: {
    orgId: string
    sessionKey: string
  }
  screenOptions?: {
    antiFlickerScrollSpeed?: string
  }
  configPath: string
  /**
   * Whether the start menu OFFERS Docker isolation. Absent/true → the
   * "Isolated (Docker)?" prompt on project-create and the 🐳 isolation marker
   * are shown (current behavior). false → isolation is not offered (no create
   * prompt, no 🐳 marker) — for machines without Docker. Offer-only: an existing
   * project flagged `isolated` still launches in Docker.
   */
  dockerIsolation?: boolean
  /**
   * Which agent to default to when the start menu / tab picker doesn't
   * have an explicit user pick. Absent → 'claude' (the only fully
   * implemented backend today).
   */
  defaultAgent?: AgentId
  /**
   * Per-agent settings (currently a pre-launch hook per agent — e.g. the Codex AGENTS.md packer).
   * Absent → no hooks (public default). Edited under Settings → Agents; persisted to the committed
   * config, so our machines opt in via the SVN-only private config while public clones stay opt-out.
   */
  agents?: AgentsConfig
  /**
   * Categories whose path was missing/inaccessible at load and therefore
   * skipped (instead of failing the whole config). Present so the app can
   * surface the silent drop (e.g. in the Error Log) rather than the user
   * wondering where a project category went. Absent when nothing was skipped.
   */
  skippedCategories?: { label: string; path: string }[]
}

/**
 * The closed set of config fields editable from the UI (Settings panel). A `Partial` patch —
 * only the present keys are written. Shapes are the ON-DISK forms (`CategoryJson` arrays, not the
 * runtime `Category` Sets), so the renderer edits plain JSON-shaped values. Secrets (`claudeUsage`)
 * are NOT here — they route through their own `.local.json` overlay writer. Persisted by the
 * `config:update` IPC op via `writeConfigPatch`; each present key is validated by `validateConfigPatch`.
 */
export interface ConfigPatch {
  name?: string
  categories?: CategoryJson[]
  defaultAgent?: AgentId
  dockerIsolation?: boolean
  customMenus?: CustomMenuNode[]
  selfUpdate?: SelfUpdateConfig
  sessionDonePrompts?: SessionDonePrompt[]
  contextLevels?: ContextWarnLevel[]
  agents?: AgentsConfig
}

export interface FolderStats {
  count: number
  lastUsed: string
}

export type StatsMap = Record<string, FolderStats>
