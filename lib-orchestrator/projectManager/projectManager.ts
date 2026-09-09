import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { RuntimeCategory } from './catalog/catalog.types'
import { CatalogStore } from './catalog/catalogStore'
import { ClaudeHistoryMigrator } from './providers/claude/claudeHistoryMigrator'
import { ClaudeProjectsLocator } from './providers/claude/claudeProjectsLocator'
import { ClaudeSessionSource } from './providers/claude/claudeSessionSource'
import { CodexHistoryMigrator } from './providers/codex/codexHistoryMigrator'
import { CodexRolloutCwdMemo } from './providers/codex/codexRolloutCwdMemo'
import { CodexRolloutIndex } from './providers/codex/codexRolloutIndex'
import { CodexSessionSource } from './providers/codex/codexSessionSource'
import { ProviderTranscriptView } from './providerTranscriptView'
import type {
  ProviderAgentId,
  ProviderHistoryMigrator,
  ProviderSessionSource,
} from './providers/providerContract.types'
import type { ConfigStore } from '../configStore/configStore'
import { ClaudeConfigHome } from '../shared/claudeConfigHome'
import type { RuntimeChannel } from '../shared/configIdentity.types'
import { ErrorText } from '../shared/errorText'
import { OrchestratorPaths } from '../shared/orchestratorPaths'
import { PathCompare } from '../shared/pathCompare'
import { DisplayGrouping } from './projects/displayGrouping'
import { ProjectDeletion } from './projects/projectDeletion'
import { ProjectLifecycle } from './projects/projectLifecycle'
import type {
  CatalogCategoryDto,
  CategoryInfo,
  DeletePreview,
  DeleteReport,
  ProjectEntry,
  ProjectListResult,
  ProjectSessionsResult,
  ProjectsOpResult,
  ProviderSessionSummary,
  RelocationReport,
} from './projectManagerApi.types'
import { ProjectNameRules } from './projects/projectNameRules'
import { ProjectOperationGuard } from './projects/projectOperationGuard'
import { ProjectScanner } from './projects/projectScanner'
import { RelocationLeftovers } from './projects/relocationLeftovers'

export interface ProjectManagerDeps {
  /** The one writer over `config.json`; the catalog is a section of it and owns no file of its own. */
  configStore: ConfigStore
  configIdentity: string
  channel: RuntimeChannel
  /** Where a latched store, a failed sweep and a failed hook are reported; one line each. */
  onError: (message: string) => void
  claudeHome?: string
  codexHome?: string
}

/**
 * The whole of this library seen from outside it: one object that owns the catalog, the scanner, the
 * two provider drivers and the lifecycle, and hands back typed results instead of exceptions.
 *
 * It composes and it decides nothing else. Every rule that could be wrong on its own - what a project
 * name may be, which shapes of a path a transcript holds, what a delete is allowed to remove - lives
 * in the subsystem that owns it. What is genuinely this class's own is the wiring: one resolved
 * provider home per store, one place that drops every cache, and one sweep at startup that cannot
 * take the process down with it.
 */
export class ProjectManager {
  private static readonly sessionLimitConst = 200

  private readonly onError: (message: string) => void
  private readonly catalog: CatalogStore
  private readonly scanner: ProjectScanner
  private readonly locator: ClaudeProjectsLocator
  private readonly codexIndex: CodexRolloutIndex
  /** The read surface every transcript reader outside this subsystem takes instead of minting one. */
  readonly transcripts: ProviderTranscriptView
  private readonly claudeSource: ProviderSessionSource
  private readonly codexSource: ProviderSessionSource
  private readonly lifecycle: ProjectLifecycle
  private readonly deletion: ProjectDeletion
  /** Only the `recent` listing fills it, so an alphabetical one never pays for a provider read. */
  private readonly activity = new Map<string, number | null>()
  /** Bumped by every invalidation, so a reading that outlived one cannot land in the empty map. */
  private activityGeneration = 0

  constructor(deps: ProjectManagerDeps) {
    const report = deps.onError
    this.onError = report
    // Resolved once and injected everywhere: a driver that resolved its own home could disagree with
    // the migrator deleting from that same store.
    const claudeHome = ClaudeConfigHome.resolve(deps.claudeHome)
    const codexHome = deps.codexHome ?? CodexSessionSource.defaultHome()
    this.catalog = new CatalogStore(deps.configStore)
    this.scanner = new ProjectScanner()
    this.locator = new ClaudeProjectsLocator(claudeHome)
    this.codexIndex = new CodexRolloutIndex(
      codexHome,
      report,
      new CodexRolloutCwdMemo(
        OrchestratorPaths.codexRolloutCwdFile(deps.configIdentity, deps.channel),
        CodexRolloutIndex.sessionsRootOf(codexHome),
        report,
      ),
    )
    // The one transcript view of the process, over the one index that carries a memo. Built here
    // because this is where that index is: a reader minting its own gets `memo = null`, which the
    // index itself defines as "every walk reads every header" - and the three polled readers of a
    // transcript would then each pay a full walk of the rollout store on the client's main thread.
    this.transcripts = new ProviderTranscriptView({
      claudeHome,
      codexHome,
      claudeLocator: this.locator,
      codexIndex: this.codexIndex,
      report,
    })
    this.claudeSource = new ClaudeSessionSource({ claudeHome, locator: this.locator })
    this.codexSource = new CodexSessionSource({ codexHome, index: this.codexIndex })
    const migrators: readonly ProviderHistoryMigrator[] = [
      new ClaudeHistoryMigrator({ claudeHome, locator: this.locator, report }),
      new CodexHistoryMigrator({ index: this.codexIndex, report }),
    ]
    const leftovers = new RelocationLeftovers(
      OrchestratorPaths.relocationLeftoversFile(deps.configIdentity, deps.channel),
      report,
    )
    // One guard for both: they change the same directories, and a guard each would only stop each
    // from racing itself.
    const guard = new ProjectOperationGuard()
    this.lifecycle = new ProjectLifecycle({
      journalsDirectory: OrchestratorPaths.relocationJournalsDirectory(
        deps.configIdentity,
        deps.channel,
      ),
      leftovers,
      migrators,
      guard,
      invalidateAll: () => this.invalidateAll(),
      forgetRewritten: (provider, file) => this.forgetRewritten(provider, file),
      report,
    })
    this.deletion = new ProjectDeletion({
      claudeHome,
      codexHome,
      locator: this.locator,
      migrators,
      leftovers,
      guard,
      invalidateAll: () => this.invalidateAll(),
      report,
    })
  }

  /**
   * What the last run left half finished. The client boots this as `void projectManager.start()`, so
   * a rejection here would be an unhandled one over work nobody has asked for yet: everything is
   * reported and nothing is thrown.
   */
  async start(): Promise<void> {
    try {
      await this.lifecycle.sweep()
    } catch (error) {
      this.onError(`Startup sweep of unfinished project operations failed: ${ErrorText.of(error)}`)
    }
  }

  /** Refused rather than answered empty while the `categories` value on disk cannot be read. */
  async getConfig(): Promise<ProjectsOpResult<CatalogCategoryDto[]>> {
    return this.catalog.getCategories()
  }

  async saveConfig(categories: readonly CatalogCategoryDto[]): Promise<ProjectsOpResult> {
    const saved = await this.catalog.saveCategories(categories)
    // A category root can move under an id that did not, which leaves every cache describing a
    // directory the catalog no longer names.
    if (saved.ok) this.invalidateAll()
    return saved
  }

  /** Every category the catalog holds, including the ones whose root cannot be read right now. */
  async listCategories(): Promise<CategoryInfo[]> {
    return Promise.all(this.catalog.runtimeCategories().map(async (category) => ({
      id: category.id,
      label: category.label,
      path: category.path,
      available: await ProjectManager.rootAvailable(category),
    })))
  }

  async listProjects(
    categoryId: string,
    options?: { sort?: 'alpha' | 'recent'; signal?: AbortSignal },
  ): Promise<ProjectsOpResult<ProjectListResult>> {
    const category = this.catalog.runtimeCategory(categoryId)
    if (!category) return ProjectManager.categoryNotFound(categoryId)
    const scan = await this.scanner.scan(category, { signal: options?.signal })
    const sort = options?.sort ?? 'alpha'
    let projects: ProjectEntry[]
    if (sort === 'alpha') projects = ProjectManager.byName(scan.entries)
    else if (sort === 'recent') projects = await this.byActivity(scan.entries)
    else throw new Error(`Unknown project sort: ${JSON.stringify(sort)}`)
    return {
      ok: true,
      value: {
        entries: DisplayGrouping.buildDisplayEntries(projects, category.virtualFolders),
        projects,
        // The same folders `entries` was grouped by, but all of them: an empty folder is not drawn
        // and is still a place a project can be moved to.
        virtualFolders: [...category.virtualFolders],
        truncated: scan.truncated,
        available: scan.available,
      },
    }
  }

  /** Returns the scanner's spelling only for a project the live catalog still exposes. */
  async authorizeProjectPath(candidate: unknown): Promise<string | null> {
    if (typeof candidate !== 'string' || candidate.length === 0) return null
    const wanted = PathCompare.comparable(candidate)
    for (const category of this.catalog.runtimeCategories()) {
      const listed = await this.listProjects(category.id)
      if (!listed.ok) continue
      const project = listed.value.projects.find(
        (entry) => PathCompare.comparable(entry.path) === wanted,
      )
      if (project !== undefined) {
        try {
          if ((await stat(project.path)).isDirectory()) return project.path
        } catch {}
      }
    }
    return null
  }

  /** Per provider and merged: the two lists are shown side by side and interleaved by the caller. */
  async listProjectSessions(
    categoryId: string,
    projectName: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<ProjectsOpResult<ProjectSessionsResult>> {
    const category = this.catalog.runtimeCategory(categoryId)
    if (!category) return ProjectManager.categoryNotFound(categoryId)
    // Reading a history is still a name turned into a path: without this, a name that walks out of
    // the category root reads another project's conversations, or someone else's directory entirely.
    const check = ProjectNameRules.validate(projectName, category)
    if (!check.ok) return { ok: false, code: 'invalid-name', detail: check.detail }
    const limit = options?.limit ?? ProjectManager.sessionLimitConst
    const projectDir = join(category.path, projectName)
    const [claude, codex] = await Promise.all([
      this.claudeSource.listProjectSessions(projectDir, { limit, signal: options?.signal }),
      this.codexSource.listProjectSessions(projectDir, { limit, signal: options?.signal }),
    ])
    return { ok: true, value: { claude, codex, merged: ProjectManager.merged(claude, codex, limit) } }
  }

  async createProject(
    categoryId: string,
    name: string,
    options?: { virtualFolderPrefix?: string },
  ): Promise<ProjectsOpResult<ProjectEntry>> {
    const category = await this.writableCategory(categoryId)
    if (!category.ok) return category
    return this.lifecycle.createProject(category.value, name, options)
  }

  async renameProject(
    categoryId: string,
    oldName: string,
    newName: string,
  ): Promise<ProjectsOpResult<RelocationReport>> {
    const category = await this.writableCategory(categoryId)
    if (!category.ok) return category
    return this.lifecycle.relocate(category.value, oldName, newName, 'rename')
  }

  async moveProjectPrefix(
    categoryId: string,
    name: string,
    targetPrefix: string | null,
  ): Promise<ProjectsOpResult<RelocationReport>> {
    const category = await this.writableCategory(categoryId)
    if (!category.ok) return category
    return this.lifecycle.moveProjectPrefix(category.value, name, targetPrefix)
  }

  async archiveProject(
    categoryId: string,
    name: string,
  ): Promise<ProjectsOpResult<RelocationReport>> {
    const category = await this.writableCategory(categoryId)
    if (!category.ok) return category
    return this.lifecycle.archiveProject(category.value, name)
  }

  async previewDelete(
    categoryId: string,
    name: string,
  ): Promise<ProjectsOpResult<DeletePreview>> {
    const category = await this.writableCategory(categoryId)
    if (!category.ok) return category
    return this.deletion.preview(category.value, name)
  }

  /** The token carries the category the preview was taken in, so there is nothing to resolve here. */
  async executeDelete(token: string): Promise<ProjectsOpResult<DeleteReport>> {
    return this.deletion.execute(token)
  }

  /**
   * The one place every cache in the module is dropped. The lifecycle and the deletion reach it
   * through the callback they were built with, so a caller never has to remember to call it.
   */
  /**
   * One history file the sweep rewrote, handed to whichever store indexes that provider's files.
   * Claude derives its store from the path and reads no header, so it has nothing to be told; the
   * Codex index remembers each rollout's recorded directory and this is the one it just replaced.
   */
  private forgetRewritten(provider: ProviderAgentId, file: string): void {
    if (provider === 'codex') this.codexIndex.forgetFile(file)
    else if (provider === 'claude') return
    else
      throw new Error(`Unknown rewrite provider: ${JSON.stringify(provider)}`)
  }

  private invalidateAll(): void {
    this.scanner.invalidate()
    this.claudeSource.invalidate()
    this.codexSource.invalidate()
    this.locator.invalidate()
    this.codexIndex.invalidate()
    this.activity.clear()
    this.activityGeneration += 1
  }

  private async writableCategory(categoryId: string): Promise<ProjectsOpResult<RuntimeCategory>> {
    const category = this.catalog.runtimeCategory(categoryId)
    if (!category) return ProjectManager.categoryNotFound(categoryId)
    if (!await ProjectManager.rootAvailable(category))
      return {
        ok: false,
        code: 'category-unavailable',
        detail: `The root of category ${category.id} (${category.path}) cannot be read right now`,
      }
    return { ok: true, value: category }
  }

  /**
   * The same question a listing answers with `available`, asked without walking the root: an offline
   * share refuses the operation outright instead of creating half of it somewhere else.
   */
  private static async rootAvailable(category: RuntimeCategory): Promise<boolean> {
    try { return (await stat(category.path)).isDirectory() }
    catch { return false }
  }

  private static categoryNotFound(categoryId: string): ProjectsOpResult<never> {
    return {
      ok: false,
      code: 'category-not-found',
      detail: `The catalog holds no category ${JSON.stringify(categoryId)}`,
    }
  }

  private static byName(entries: readonly ProjectEntry[]): ProjectEntry[] {
    return [...entries].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: 'accent' }))
  }

  private async byActivity(entries: readonly ProjectEntry[]): Promise<ProjectEntry[]> {
    const dated = await Promise.all(entries.map(async (entry) => ({
      ...entry,
      lastActivity: await this.activityOf(entry.path),
    })))
    return dated.sort((left, right) => (right.lastActivity ?? -1) - (left.lastActivity ?? -1))
  }

  /**
   * The newer of the two providers, cached until something changes the disk. A project's activity
   * costs a directory listing per provider, and this runs once per project in the listing.
   */
  private async activityOf(projectPath: string): Promise<number | null> {
    const key = PathCompare.comparable(projectPath)
    const cached = this.activity.get(key)
    if (cached !== undefined) return cached
    const generation = this.activityGeneration
    const [claude, codex] = await Promise.all([
      this.claudeSource.latestActivity(projectPath),
      this.codexSource.latestActivity(projectPath),
    ])
    const latest = ProjectManager.newer(claude, codex)
    // A listing that started before a rename would otherwise put its pre-rename reading back into the
    // map that rename just emptied, where nothing removes it until the next lifecycle operation. The
    // scanner and both drivers guard their caches the same way.
    if (generation === this.activityGeneration) this.activity.set(key, latest)
    return latest
  }

  private static newer(left: number | null, right: number | null): number | null {
    if (left === null) return right
    if (right === null) return left
    return Math.max(left, right)
  }

  private static merged(
    claude: readonly ProviderSessionSummary[],
    codex: readonly ProviderSessionSummary[],
    limit: number,
  ): ProviderSessionSummary[] {
    return [...claude, ...codex]
      .sort((left, right) => right.lastActivity - left.lastActivity)
      .slice(0, limit)
  }
}
