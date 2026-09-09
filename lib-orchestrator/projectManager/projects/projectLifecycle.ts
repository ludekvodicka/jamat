import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { RuntimeCategory } from '../catalog/catalog.types'
import { ClaudeProjectsLocator } from '../providers/claude/claudeProjectsLocator'
import type { RewriterIo } from '../providers/core/transcriptRewriter'
import { TranscriptRewriter } from '../providers/core/transcriptRewriter'
import type {
  LeftoverEntry,
  ProviderAgentId,
  ProviderHistoryMigrator,
  RelocationJournalDocument,
} from '../providers/providerContract.types'
import { ChildEnvironment } from '../../shared/childEnvironment'
import { ErrorText } from '../../shared/errorText'
import { DisplayGrouping } from './displayGrouping'
import type {
  AfterCreateHook,
  ProjectEntry,
  ProjectsOpErrorCode,
  ProjectsOpResult,
  ProviderOutcome,
  RelocationReport,
} from '../projectManagerApi.types'
import { ProjectNameRules } from './projectNameRules'
import { ProjectOperationGuard } from './projectOperationGuard'
import { RelocationJournal } from './relocationJournal'
import type { RelocationLeftovers } from './relocationLeftovers'

export type RelocationKind = RelocationJournalDocument['kind']

/**
 * The rewriter's file operations plus the one removal this class needs. Injectable because the
 * failure this whole design is built around - a directory or a transcript another process holds open
 * - cannot be produced from Node on Windows, so it is the only way the classification is ever run.
 */
export interface LifecycleIo extends RewriterIo {
  /** Takes back a file or a whole directory: a delete leftover can be either. */
  remove(path: string): Promise<void>
}

export interface ProjectLifecycleDeps {
  journalsDirectory: string
  leftovers: RelocationLeftovers
  migrators: readonly ProviderHistoryMigrator[]
  /** Shared with the deletion: the two must exclude each other, not only themselves. */
  guard: ProjectOperationGuard
  /** Every listing cached anywhere in the module; called after each operation that changed the disk. */
  invalidateAll: () => void
  /**
   * One history file whose recorded paths this class has just replaced. The migrators announce their
   * own rewrites to whatever indexes them; the sweep is the other writer of the same files, at a
   * later start and one file at a time, and it has no migrator to announce through.
   */
  forgetRewritten: (provider: ProviderAgentId, file: string) => void
  report: (message: string) => void
  io?: LifecycleIo
}

/**
 * Creating, renaming, moving and archiving a project directory - the only place in this library that
 * changes a directory the user owns.
 *
 * Every one of those is the same operation underneath: rename the folder, then move the provider
 * histories after it. What makes it survivable is the order, and the order is the design. See
 * `relocate`.
 */
export class ProjectLifecycle {
  private static readonly archivedFolderNameConst = 'Archived'
  private static readonly hookTimeoutMillisecondsConst = 30_000
  private static readonly directoryPlaceholderConst = '{dir}'
  private static readonly namePlaceholderConst = '{name}'
  private static readonly nodeIoConst: LifecycleIo = {
    readFile: (file) => readFile(file, 'utf8'),
    writeFile: (file, content) => writeFile(file, content, 'utf8'),
    rename: (oldPath, newPath) => rename(oldPath, newPath),
    unlink: (file) => unlink(file),
    remove: (path) => rm(path, { recursive: true, force: true }),
  }

  private readonly journalsDirectory: string
  private readonly leftovers: RelocationLeftovers
  private readonly migrators: readonly ProviderHistoryMigrator[]
  private readonly invalidateAll: () => void
  private readonly forgetRewritten: (provider: ProviderAgentId, file: string) => void
  private readonly report: (message: string) => void
  private readonly io: LifecycleIo
  private readonly guard: ProjectOperationGuard

  constructor(deps: ProjectLifecycleDeps) {
    this.journalsDirectory = deps.journalsDirectory
    this.leftovers = deps.leftovers
    this.migrators = deps.migrators
    this.invalidateAll = deps.invalidateAll
    this.forgetRewritten = deps.forgetRewritten
    this.report = deps.report
    this.guard = deps.guard
    this.io = deps.io ?? ProjectLifecycle.nodeIoConst
  }

  /**
   * A directory and, if the category asks for one, a hook run inside it. No session is started and no
   * history is touched: a new project has none.
   */
  async createProject(
    category: RuntimeCategory,
    name: string,
    options?: { virtualFolderPrefix?: string },
  ): Promise<ProjectsOpResult<ProjectEntry>> {
    const prefix = options?.virtualFolderPrefix
    let finalName = name
    if (prefix !== undefined) {
      const unknown = ProjectLifecycle.unknownFolder(category, prefix)
      if (unknown) return unknown
      finalName = DisplayGrouping.applyPrefix(name, category.virtualFolders, prefix)
    }
    // Validated on every path into this class, including this one: V1 validated the menu and left the
    // command line free to create a directory anywhere it liked.
    const check = ProjectNameRules.validate(finalName, category)
    if (!check.ok) return { ok: false, code: 'invalid-name', detail: check.detail }
    const path = join(category.path, finalName)
    const empty = await ProjectLifecycle.isEmptyDirectory(path)
    await mkdir(path, { recursive: true })
    // A hook that adds the directory to version control or lays down a template must not run over a
    // directory that already holds work.
    if (category.afterCreate && empty)
      await this.runAfterCreate(category.afterCreate, path, finalName)
    this.invalidateAll()
    return { ok: true, value: { name: finalName, path, lastActivity: null } }
  }

  /**
   * The order below is the whole of the crash safety, and each step is where it is for a reason:
   *
   * 0. one operation per project at a time, so two of them cannot interleave over the same directory;
   * 1. the name is validated before anything is resolved from it;
   * 2. every refusal that can be seen in advance is made here, while the disk is still untouched;
   * 3. the journal reaches the disk BEFORE the first effect, so a crash after it leaves a record;
   * 4. the folder rename is the single user-visible step, and the only one that cannot be replayed;
   * 5. the journal records that it happened, which is what tells a later sweep there is work left;
   * 6. the provider histories follow, checkpointing per file and classifying what is locked;
   * 7. caches drop, because the disk no longer matches them;
   * 8. the journal is removed only when both providers finished; otherwise the sweep resumes it.
   *
   * There is no rollback. Undoing a half-migrated history means rewriting the same files again with
   * the opposite replacements, which is the same risk taken twice for a worse result.
   */
  async relocate(
    category: RuntimeCategory,
    oldName: string,
    newName: string,
    kind: RelocationKind,
  ): Promise<ProjectsOpResult<RelocationReport>> {
    const targetRoot = ProjectLifecycle.targetRootOf(category, kind)
    const oldPath = join(category.path, oldName)
    const newPath = join(targetRoot, newName)
    const keys = [
      ProjectOperationGuard.keyOf(category.id, oldPath),
      ProjectOperationGuard.keyOf(category.id, newPath),
    ]
    if (!this.guard.claim(keys))
      return {
        ok: false,
        code: 'relocation-in-progress',
        detail: `Another operation on ${oldPath} is still running`,
      }
    try {
      return await this.runRelocation(category, oldPath, newPath, newName, kind)
    } finally {
      this.guard.release(keys)
    }
  }

  /**
   * Into `<category>/Archived/<name>`, with the history migrated after it. V1 moved the folder and
   * left the encoded Claude directory naming a path that no longer existed, which orphaned the whole
   * project's history the moment it was archived.
   */
  async archiveProject(
    category: RuntimeCategory,
    name: string,
  ): Promise<ProjectsOpResult<RelocationReport>> {
    return this.relocate(category, name, name, 'archive')
  }

  /**
   * In, out, or between virtual folders: a rename to the name the grouping rules compute.
   *
   * The first two refusals are about `applyPrefix` being willing to compute a name for anything it is
   * handed. The UI offers only the folders the category defines, but the channel behind it takes
   * whatever a caller sends, and a prefix that is in no config would name a folder that cannot be
   * entered or left again. A flattened `container/child` has no name in the root to carry a prefix at
   * all.
   */
  async moveProjectPrefix(
    category: RuntimeCategory,
    name: string,
    targetPrefix: string | null,
  ): Promise<ProjectsOpResult<RelocationReport>> {
    if (targetPrefix !== null) {
      const unknown = ProjectLifecycle.unknownFolder(category, targetPrefix)
      if (unknown) return unknown
    }
    if (ProjectNameRules.isFlattenedChild(name))
      return {
        ok: false,
        code: 'invalid-name',
        detail: `${name} sits inside a flattened container and cannot move between virtual folders`,
      }
    const newName = DisplayGrouping.applyPrefix(name, category.virtualFolders, targetPrefix)
    // Choosing the folder a project is already in is the one move that computes its own name back,
    // and `relocate` would then find the project's own directory sitting at the target and refuse it
    // as `target-exists`. V1 answered this with "Already in target group"; the report says the same
    // thing by having renamed nothing. The existence check is repeated here because this answer never
    // reaches `relocate`, where every other refusal is made: without it a name that is on no disk is
    // told it is already where it was sent. The operation id is null because no operation was opened:
    // nothing was journalled, so there is no id a sweep could ever find.
    if (newName === name) {
      const path = join(category.path, name)
      if (!await ProjectLifecycle.isDirectory(path))
        return { ok: false, code: 'project-not-found', detail: `${path} is not a directory` }
      return {
        ok: true,
        value: {
          operationId: null,
          directoryRenamed: false,
          providers: { claude: 'done', codex: 'done' },
          leftoverCount: 0,
        },
      }
    }
    return this.relocate(category, name, newName, 'move-prefix')
  }

  /**
   * What the last run did not finish: operations interrupted mid-migration, and files that were
   * locked when it walked past them. Nothing here throws - it runs at startup, before the user has
   * asked for anything, and a sweep that fails must not be the reason the application does not start.
   */
  async sweep(): Promise<void> {
    try {
      await this.resumePending()
    } catch (error) {
      this.report(`Relocation journals could not be swept: ${ErrorText.of(error)}`)
    }
    try {
      await this.retryLeftovers()
    } catch (error) {
      this.report(`Relocation leftovers could not be swept: ${ErrorText.of(error)}`)
    }
  }

  /**
   * Both entry points that hand a prefix to `applyPrefix` ask this first, and for one reason: the
   * channel behind the UI takes whatever a caller sends, and a prefix in no config names a folder
   * that can be neither entered nor left - by a move, and equally by a create landing there.
   */
  private static unknownFolder(
    category: RuntimeCategory,
    prefix: string,
  ): Extract<ProjectsOpResult, { ok: false }> | null {
    if (category.virtualFolders.some((folder) => folder.prefix === prefix)) return null
    return {
      ok: false,
      code: 'unknown-virtual-folder',
      detail: `Category ${category.id} defines no virtual folder with prefix ${prefix}`,
    }
  }

  private static targetRootOf(category: RuntimeCategory, kind: RelocationKind): string {
    if (kind === 'rename') return category.path
    else if (kind === 'move-prefix') return category.path
    else if (kind === 'archive') return join(category.path, ProjectLifecycle.archivedFolderNameConst)
    else throw new Error(`Unknown relocation kind: ${JSON.stringify(kind)}`)
  }

  private async runRelocation(
    category: RuntimeCategory,
    oldPath: string,
    newPath: string,
    newName: string,
    kind: RelocationKind,
  ): Promise<ProjectsOpResult<RelocationReport>> {
    const check = ProjectNameRules.validate(newName, category)
    if (!check.ok) return { ok: false, code: 'invalid-name', detail: check.detail }
    if (!await ProjectLifecycle.isDirectory(oldPath))
      return { ok: false, code: 'project-not-found', detail: `${oldPath} is not a directory` }
    if (await ProjectLifecycle.exists(newPath))
      return { ok: false, code: 'target-exists', detail: `${newPath} already exists` }
    for (const migrator of this.migrators) {
      const preflight = await migrator.preflight(oldPath, newPath)
      if (!preflight.ok)
        return {
          ok: false,
          code: ProjectLifecycle.conflictCodeOf(migrator.agentId),
          detail: preflight.conflict ?? `${migrator.agentId} refused to move this project's history`,
        }
    }
    const operationId = randomUUID()
    const journal = await RelocationJournal.open(this.journalsDirectory, {
      schemaVersion: 1,
      operationId,
      kind,
      oldPath,
      newPath,
      directoryRenamed: false,
      steps: [],
    })
    const renamed = await this.renameProjectDirectory(oldPath, newPath, operationId)
    if (!renamed.ok) return renamed
    journal.markDirectoryRenamed()
    // A provider without a migrator has nothing left to finish, which is what 'done' says here.
    const providers: Record<ProviderAgentId, ProviderOutcome> = { claude: 'done', codex: 'done' }
    for (const migrator of this.migrators)
      providers[migrator.agentId] = await migrator.relocate(oldPath, newPath, journal, this.leftovers)
    this.invalidateAll()
    if (ProjectLifecycle.finished(providers.claude) && ProjectLifecycle.finished(providers.codex))
      await RelocationJournal.discard(this.journalsDirectory, operationId)
    return {
      ok: true,
      value: {
        operationId,
        directoryRenamed: true,
        providers,
        leftoverCount: this.leftovers.entries()
          .filter((entry) => entry.operationId === operationId).length,
      },
    }
  }

  /**
   * The one visible effect, and the one that is refused rather than worked around: a project
   * directory is a working copy, and copying it to duplicate it is worse than telling the user to
   * close whatever is holding it. Nothing moved, so the journal describing the move goes away too.
   */
  private async renameProjectDirectory(
    oldPath: string,
    newPath: string,
    operationId: string,
  ): Promise<ProjectsOpResult> {
    try {
      await mkdir(dirname(newPath), { recursive: true })
      await this.io.rename(oldPath, newPath)
      return { ok: true, value: undefined }
    } catch (error) {
      await RelocationJournal.discard(this.journalsDirectory, operationId)
      if (TranscriptRewriter.isLockedError(error))
        return {
          ok: false,
          code: 'locked',
          detail: `${oldPath} is held open by another program - close the editor or the agent running`
            + ` in it and try again (${ErrorText.of(error)})`,
        }
      throw error
    }
  }

  /** Whose store refused the move; hard-coding one provider's code made the other one lie. */
  private static conflictCodeOf(provider: ProviderAgentId): ProjectsOpErrorCode {
    if (provider === 'claude') return 'claude-store-conflict'
    else if (provider === 'codex') return 'codex-store-conflict'
    else throw new Error(`Unknown provider: ${JSON.stringify(provider)}`)
  }

  private static finished(outcome: ProviderOutcome): boolean {
    if (outcome === 'done') return true
    else if (outcome === 'done-with-leftovers') return true
    else if (outcome === 'failed') return false
    else throw new Error(`Unknown provider outcome: ${JSON.stringify(outcome)}`)
  }

  private async resumePending(): Promise<void> {
    for (const document of await RelocationJournal.pending(this.journalsDirectory, this.report)) {
      if (!document.directoryRenamed && !await ProjectLifecycle.movedWithoutRecord(document)) {
        // The interruption came before the one visible step, so nothing on disk moved and there is
        // nothing to finish - only the record of an operation that never happened.
        await RelocationJournal.discard(this.journalsDirectory, document.operationId)
        continue
      }
      const journal = new RelocationJournal(this.journalsDirectory, document)
      let finished = true
      for (const migrator of this.migrators) {
        // Replaying a step that already ran writes nothing: the old shapes are gone from the file, so
        // the rewrite reports it unchanged. That idempotence is what makes a resume safe.
        const outcome = await migrator.relocate(
          document.oldPath,
          document.newPath,
          journal,
          this.leftovers,
        )
        if (!ProjectLifecycle.finished(outcome)) finished = false
      }
      this.invalidateAll()
      if (finished) await RelocationJournal.discard(this.journalsDirectory, document.operationId)
    }
  }

  /**
   * The flag is written after the rename it describes, so a crash between the two leaves a journal
   * that says nothing happened over a directory that already moved. The disk decides: the source
   * gone and the target a directory is that exact state, and dropping the journal there would leave
   * both histories naming the old path for good.
   */
  private static async movedWithoutRecord(document: RelocationJournalDocument): Promise<boolean> {
    if (await ProjectLifecycle.exists(document.oldPath)) return false
    return ProjectLifecycle.isDirectory(document.newPath)
  }

  private async retryLeftovers(): Promise<void> {
    for (const entry of this.leftovers.entries()) {
      if (entry.kind === 'delete') await this.retryDelete(entry)
      else if (entry.kind === 'rewrite') await this.retryRewrite(entry)
      else throw new Error(`Unknown leftover kind: ${JSON.stringify(entry)}`)
    }
  }

  private async retryDelete(entry: Extract<LeftoverEntry, { kind: 'delete' }>): Promise<void> {
    try {
      await this.io.remove(entry.path)
      this.leftovers.remove(entry)
    } catch (error) {
      // Still held open: it stays on the list and the next start tries again.
      if (TranscriptRewriter.isLockedError(error)) return
      this.report(`Leftover copy ${entry.path} could not be removed: ${ErrorText.of(error)}`)
    }
  }

  private async retryRewrite(entry: Extract<LeftoverEntry, { kind: 'rewrite' }>): Promise<void> {
    const replacements = TranscriptRewriter.replacementsOf(
      entry.oldPath,
      entry.newPath,
      ProjectLifecycle.encoderOf(entry.provider),
    )
    try {
      const outcome = await TranscriptRewriter.rewriteInPlace(entry.path, replacements, this.io)
      // Only the rewrite is announced: `unchanged` wrote nothing, so anything that remembers this
      // file is still remembering the bytes that are there.
      if (outcome === 'rewritten') {
        this.forgetRewritten(entry.provider, entry.path)
        this.leftovers.remove(entry)
      }
      else if (outcome === 'unchanged') this.leftovers.remove(entry)
      else if (outcome === 'left-locked') return
      else throw new Error(`Unknown rewrite outcome: ${JSON.stringify(outcome)}`)
    } catch (error) {
      // The transcript is gone - deleted by its own application, or by a delete of this project. The
      // record is what would otherwise be retried forever.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.leftovers.remove(entry)
        return
      }
      this.report(`Leftover transcript ${entry.path} could not be rewritten: ${ErrorText.of(error)}`)
    }
  }

  private static encoderOf(provider: ProviderAgentId): ((path: string) => string) | undefined {
    if (provider === 'claude') return ClaudeProjectsLocator.encodeProjectDir
    // Codex derives no name from the path; adding that shape here would edit text its format never
    // holds.
    else if (provider === 'codex') return undefined
    else throw new Error(`Unknown leftover provider: ${JSON.stringify(provider)}`)
  }

  private async runAfterCreate(
    hook: AfterCreateHook,
    directory: string,
    name: string,
  ): Promise<void> {
    const command = ProjectLifecycle.substituted(hook.command, directory, name)
    const args = (hook.args ?? []).map((argument) =>
      ProjectLifecycle.substituted(argument, directory, name))
    try {
      await ProjectLifecycle.spawnHook(command, args, dirname(directory))
    } catch (error) {
      // The directory the user asked for exists. A hook that failed is reported and nothing more:
      // undoing the creation over it would throw away the thing that did work.
      this.report(`afterCreate hook "${command}" failed for ${directory}: ${ErrorText.of(error)}`)
    }
  }

  private static substituted(value: string, directory: string, name: string): string {
    return value
      .split(ProjectLifecycle.directoryPlaceholderConst).join(directory)
      .split(ProjectLifecycle.namePlaceholderConst).join(name)
  }

  /** Runs in the parent: the hook is usually a version-control command about a directory that is not
   *  under version control yet. */
  private static spawnHook(command: string, args: string[], cwd: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
        // A hook is a foreign command, so it gets what a foreign command gets: no Jamat variable
        // and none of this process's own dev runtime.
        env: ChildEnvironment.withoutJamat(process.env),
      })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`it did not finish within ${ProjectLifecycle.hookTimeoutMillisecondsConst}ms`))
      }, ProjectLifecycle.hookTimeoutMillisecondsConst)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`it exited with code ${JSON.stringify(code)}`))
      })
    })
  }

  private static async isDirectory(path: string): Promise<boolean> {
    try { return (await stat(path)).isDirectory() }
    catch { return false }
  }

  private static async exists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch { return false }
  }

  /** A directory that is not there is empty: nothing in it can be overwritten by a hook. */
  private static async isEmptyDirectory(path: string): Promise<boolean> {
    try { return (await readdir(path)).length === 0 }
    catch { return true }
  }
}
