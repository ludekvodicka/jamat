import type { Category, StatsMap, CustomMenuNode } from './config.js'
import type { AgentId } from './contracts.js'
import type { SessionInfo, LatestSessionMeta } from './session.js'
import type { SortMode, DisplayEntry } from '../menu-core/pure.js'

export type SubmenuType = null | 'docker' | 'custom' | 'manage' | 'sort' | 'session-picker' | 'move-prefix'

/** A visual divider between the current category's matches and cross-category
 *  matches in search mode. Rendered as a dim `-----` rule; not selectable. */
export type SeparatorItem = { kind: 'separator' }
/** A search match found in a DIFFERENT category than the active one. Carries
 *  its owning category's index/label so selecting it can switch context and
 *  open the session picker against the correct path + stats. */
export type CrossFolderItem = {
  kind: 'crossFolder'
  name: string
  displayName: string
  catIndex: number
  catLabel: string
}

export type MenuItem = { kind: 'search' } | SeparatorItem | CrossFolderItem | DisplayEntry
export const SEARCH_ITEM: MenuItem = { kind: 'search' }
export const SEPARATOR_ITEM: MenuItem = { kind: 'separator' }

/** Below this many in-category matches, search also spans the other categories. */
export const CROSS_FOLDER_THRESHOLD = 10

export type MenuEntry = DisplayEntry

export type SessionPickerItem =
  | { kind: 'new-session' }
  | { kind: 'last-session'; session: SessionInfo }
  | { kind: 'session'; session: SessionInfo }

export interface RenderLayout {
  maxNameW: number
  maxActivityW: number
  projectConfigs: Map<string, { isolated: boolean }>
}

export interface MenuState {
  categories: Category[]
  catIndex: number
  cat: Category
  stats: StatsMap
  scrollOffset: number
  submenu: SubmenuType
  /** Root custom-menu groups (config `customMenus`); [] = feature off. */
  customMenus: CustomMenuNode[]
  /** Ancestor branch nodes navigated into within the `custom` submenu; [] = at root. */
  customPath: CustomMenuNode[]
  /** Absolute path of the project the custom menu was opened on (F3 selection). */
  customTargetDir: string | null
  searchMode: boolean
  searchQuery: string
  sortMode: SortMode
  virtualFoldersEnabled: boolean
  currentVirtualFolder: string | null
  allEntries: MenuEntry[]
  items: MenuItem[]
  selected: number
  tabMemory: Map<number, { selected: number; scrollOffset: number }>
  jumpChar: string
  jumpLastIndex: number
  visibleRows: number

  spItems: SessionPickerItem[]
  spSessions: SessionInfo[]
  spSelected: number
  spScrollOffset: number
  spFolderName: string
  spPreviewCache: Map<string, string[]>
  spProjectDir: string | null

  mpTargets: Array<{ prefix: string; title: string }>
  mpSelected: number
  mpFolderName: string

  cachedFolderNames: string[]
  /** Per-category folder-name cache for cross-category search, keyed by category
   *  index. Populated lazily on the first cross-category search and reused so we
   *  don't re-walk every category's directory on each keystroke. */
  crossFolderCache: Map<number, string[]>
  sessionMetaCache: Map<string, LatestSessionMeta>
  layout: RenderLayout
  antiFlicker: boolean
  /** Whether the menu OFFERS Docker isolation (config `dockerIsolation`, default
   *  true). False → no "Isolated (Docker)?" create prompt and no 🐳 marker. */
  dockerIsolationEnabled: boolean

  /**
   * Which agent the next spawn will use. Cycled by Tab in the menu when
   * more than one agent is available on PATH; otherwise pinned to the
   * single available agent. Resume rows can override this via
   * `resolveAgentForSessionId` when the session's owner is known.
   */
  selectedAgent: AgentId
  /** Agent IDs the user could realistically pick (binary on PATH). */
  availableAgents: AgentId[]
}
