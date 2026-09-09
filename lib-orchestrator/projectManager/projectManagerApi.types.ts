/**
 * The wire-visible surface of the ProjectManager, and the only file of this library the renderer's
 * TypeScript program compiles. It imports nothing on purpose: the moment it reaches into node: or a
 * sibling module, the web program stops building.
 */

export interface VirtualFolderDef {
  prefix: string
  title: string
}

export interface AfterCreateHook {
  command: string
  args?: string[]
}

/** Unknown keys survive a load/save round-trip: the file is edited by hand and by future builds. */
export interface CatalogCategoryDto {
  id: string
  label: string
  path: string
  hiddenFolders?: string[]
  flattenFolders?: string[]
  virtualFolders?: VirtualFolderDef[]
  afterCreate?: AfterCreateHook
  [key: string]: unknown
}

export interface CategoryInfo {
  id: string
  label: string
  path: string
  /** False for a root that cannot be read right now; the category stays listed either way. */
  available: boolean
}

export interface ProjectEntry {
  /** `foo`, or `container/foo` when the container is one of the category's flattenFolders. */
  name: string
  path: string
  /** Newest activity across every provider; null when it was not asked for. */
  lastActivity: number | null
}

export type DisplayEntry =
  | { kind: 'project'; project: ProjectEntry }
  | { kind: 'virtualFolder'; prefix: string; title: string; children: ProjectEntry[] }

export interface ProjectListResult {
  /** Grouping already applied; a consumer renders this, it does not re-derive it. */
  entries: DisplayEntry[]
  projects: ProjectEntry[]
  /**
   * Every folder the category defines, in config order, the empty ones included. `entries` holds
   * only the folders that matched something, so a list of move targets built from it can never name
   * a folder that is still empty - which is every folder the moment somebody creates one.
   */
  virtualFolders: VirtualFolderDef[]
  truncated: boolean
  available: boolean
}

export type ProjectsOpErrorCode =
  /** `config.json` itself does not read, so no section of it is written. */
  | 'catalog-latched'
  /**
   * The file reads and its `categories` value does not: everything else in it still saves, and the
   * roots are neither shown nor replaced until that value is repaired. Its own code rather than
   * `catalog-latched`, because the two send the reader to different places - one to a broken
   * document, one to a single key inside a document that is otherwise fine.
   */
  | 'catalog-damaged'
  | 'invalid-config'
  | 'category-not-found'
  | 'category-unavailable'
  | 'project-not-found'
  | 'target-exists'
  | 'invalid-name'
  | 'claude-store-conflict'
  | 'codex-store-conflict'
  | 'relocation-in-progress'
  | 'locked'
  | 'not-contained'
  /** A move named a prefix the category does not define; the new name would have been invented. */
  | 'unknown-virtual-folder'
  | 'stale-preview'
  | 'preview-expired'

export type ProjectsOpResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; code: ProjectsOpErrorCode; detail: string }

export type ProviderOutcome = 'done' | 'done-with-leftovers' | 'failed'

export interface RelocationReport {
  /** Null when no operation was ever opened: nothing was journalled, so no sweep can find one. */
  operationId: string | null
  directoryRenamed: boolean
  providers: { claude: ProviderOutcome; codex: ProviderOutcome }
  leftoverCount: number
}

export interface ProviderSessionSummary {
  agentId: 'claude' | 'codex'
  nativeSessionId: string
  /** Claude: custom title, else slug. Codex: thread name. */
  title: string | null
  firstUserMessage: string | null
  createdAt: number
  lastActivity: number
  /** Claude: the recorded pid is alive. Codex tracks no pid, so it is always false. */
  active: boolean
}

export interface ProjectSessionsResult {
  claude: ProviderSessionSummary[]
  codex: ProviderSessionSummary[]
  merged: ProviderSessionSummary[]
}

export interface DeletePreview {
  token: string
  expiresAt: number
  projectPath: string
  projectFileCount: number
  claude: { encodedDirectory: string | null; transcriptFiles: string[] }
  codex: { rolloutFiles: string[] }
}

export interface DeleteReport {
  deletedPaths: number
  leftoverCount: number
}

export type ProjectBinding =
  | { kind: 'project'; categoryId: string; projectName: string; projectPath: string }
  | { kind: 'adHoc'; path: string }
  | { kind: 'none' }
