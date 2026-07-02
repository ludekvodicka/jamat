import type { VirtualFolderDef } from '../menu-core/pure.js'
import type { AgentId } from './contracts.js'
export type { VirtualFolderDef } from '../menu-core/pure.js'

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
 * Built-in update config. Two channels, chosen by `provider`:
 *  - `'vcs'` (default): the app runs over a checked-out repo and updates via a VCS
 *    pull + relaunch — the OWNER/dev path (`self-update.ts` / `update-checker.ts`).
 *    `vcs` names which to pull from (explicit, not auto-detected: a checkout can have
 *    BOTH a local-only git and a parent SVN — auto-detect would pick git and no-op).
 *  - `'github'`: a PACKAGED public installer has no repo to pull — it auto-updates from
 *    the GitHub Releases feed baked into `app-update.yml` by electron-builder's `publish`
 *    config (`auto-updater.ts`). `vcs`/`repoPath` are unused in this mode.
 * `repoPath` absent → the monorepo root.
 */
export interface SelfUpdateConfig {
  /** Update channel. Absent → `'vcs'` (the owner/source-checkout path). */
  provider?: 'vcs' | 'github'
  /** VCS to pull (provider `'vcs'` only). Absent in that mode → treated as `'git'`. */
  vcs?: 'svn' | 'git'
  repoPath?: string
  /**
   * Background update checker (Electron only). When `selfUpdate` is present it runs
   * by default; set `autoCheck: false` to disable just the checker (the manual
   * "Update & Restart" menu action stays available). The checker polls the repo HEAD
   * for a newer `package.json` version, waits until every tab in every window is idle
   * (no `running`/`tool-use`/`blocked` Claude turn), then prompts to update or postpone.
   */
  autoCheck?: boolean
  /** Repo poll cadence in minutes (default 120). */
  checkIntervalMinutes?: number
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
}

export interface FolderStats {
  count: number
  lastUsed: string
}

export type StatsMap = Record<string, FolderStats>
