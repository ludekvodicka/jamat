import { randomUUID } from 'node:crypto'
import { readdir, realpath, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { RuntimeCategory } from '../catalog/catalog.types'
import type { ClaudeProjectsLocator } from '../providers/claude/claudeProjectsLocator'
import { TranscriptRewriter } from '../providers/core/transcriptRewriter'
import type {
  ProviderHistoryMigrator,
  RelocationLeftoversWriter,
} from '../providers/providerContract.types'
import { ErrorText } from '../../shared/errorText'
import { PathCompare } from '../../shared/pathCompare'
import type { DeletePreview, DeleteReport, ProjectsOpResult } from '../projectManagerApi.types'
import { ProjectOperationGuard } from './projectOperationGuard'

export interface DeletionIo {
  /** A file or a whole directory; the same call takes back either. */
  remove(path: string): Promise<void>
}

/** Everything one delete would remove, in the order it would remove it. */
interface DeleteTargets {
  projectPath: string
  projectFileCount: number
  encodedDirectory: string | null
  claudeFiles: string[]
  codexFiles: string[]
}

interface PendingDelete {
  category: RuntimeCategory
  name: string
  preview: DeletePreview
  /** The set of paths the user was shown; a delete that would touch a different set is refused. */
  fingerprint: string
}

export interface ProjectDeletionDeps {
  claudeHome: string
  codexHome: string
  locator: ClaudeProjectsLocator
  migrators: readonly ProviderHistoryMigrator[]
  leftovers: RelocationLeftoversWriter
  /** Shared with the lifecycle: a delete must not run while a relocation moves the same project. */
  guard: ProjectOperationGuard
  invalidateAll: () => void
  report: (message: string) => void
  io?: DeletionIo
}

/**
 * Deleting a project: the directory and the two provider histories together, in two phases.
 *
 * Nothing here can be undone, so nothing here happens on one call. The first call enumerates and
 * hands back a token bound to exactly the paths it listed; the second re-enumerates and refuses if
 * that set moved. A boolean "yes I am sure" flag would be a confirmation of a question the caller
 * could no longer see the answer to.
 */
export class ProjectDeletion {
  private static readonly tokenTtlMillisecondsConst = 5 * 60_000
  private static readonly projectsDirectoryNameConst = 'projects'
  private static readonly sessionsDirectoryNameConst = 'sessions'
  private static readonly nodeIoConst: DeletionIo = {
    remove: (path) => rm(path, { recursive: true, force: true }),
  }

  private readonly claudeHome: string
  private readonly codexHome: string
  private readonly locator: ClaudeProjectsLocator
  private readonly migrators: readonly ProviderHistoryMigrator[]
  private readonly leftovers: RelocationLeftoversWriter
  private readonly guard: ProjectOperationGuard
  private readonly invalidateAll: () => void
  private readonly report: (message: string) => void
  private readonly io: DeletionIo
  private readonly pending = new Map<string, PendingDelete>()

  constructor(deps: ProjectDeletionDeps) {
    this.claudeHome = deps.claudeHome
    this.codexHome = deps.codexHome
    this.locator = deps.locator
    this.migrators = deps.migrators
    this.leftovers = deps.leftovers
    this.guard = deps.guard
    this.invalidateAll = deps.invalidateAll
    this.report = deps.report
    this.io = deps.io ?? ProjectDeletion.nodeIoConst
  }

  /** Enumerates before it promises anything, and promises nothing it did not enumerate. */
  async preview(
    category: RuntimeCategory,
    name: string,
  ): Promise<ProjectsOpResult<DeletePreview>> {
    this.evictExpired()
    const targets = await this.enumerate(category, name)
    if (!targets.ok) return targets
    const preview: DeletePreview = {
      token: randomUUID(),
      expiresAt: Date.now() + ProjectDeletion.tokenTtlMillisecondsConst,
      projectPath: targets.value.projectPath,
      projectFileCount: targets.value.projectFileCount,
      claude: {
        encodedDirectory: targets.value.encodedDirectory,
        transcriptFiles: targets.value.claudeFiles,
      },
      codex: { rolloutFiles: targets.value.codexFiles },
    }
    this.pending.set(preview.token, {
      category,
      name,
      preview,
      fingerprint: ProjectDeletion.fingerprintOf(targets.value),
    })
    return { ok: true, value: preview }
  }

  async execute(token: string): Promise<ProjectsOpResult<DeleteReport>> {
    const pending = this.pending.get(token)
    if (!pending)
      return { ok: false, code: 'preview-expired', detail: 'This delete was never previewed' }
    if (Date.now() > pending.preview.expiresAt) {
      this.pending.delete(token)
      return { ok: false, code: 'preview-expired', detail: 'The preview of this delete has expired' }
    }
    // Claimed before anything is enumerated: a relocation running right now is about to move the very
    // directory this token names, and re-enumerating first would only describe a state that is moving.
    const keys = [ProjectOperationGuard.keyOf(pending.category.id, pending.preview.projectPath)]
    if (!this.guard.claim(keys))
      return {
        ok: false,
        code: 'relocation-in-progress',
        detail: `Another operation on ${pending.preview.projectPath} is still running`,
      }
    try {
      return await this.runDelete(token, pending)
    } finally {
      this.guard.release(keys)
    }
  }

  private async runDelete(
    token: string,
    pending: PendingDelete,
  ): Promise<ProjectsOpResult<DeleteReport>> {
    const targets = await this.enumerate(pending.category, pending.name)
    if (!targets.ok) {
      this.pending.delete(token)
      return targets
    }
    if (ProjectDeletion.fingerprintOf(targets.value) !== pending.fingerprint) {
      // Sessions were started or ended since the preview, so what would be deleted is no longer what
      // the user agreed to. A fresh preview is the only way through.
      this.pending.delete(token)
      return {
        ok: false,
        code: 'stale-preview',
        detail: `What would be deleted for ${targets.value.projectPath} changed since the preview`,
      }
    }
    const report = await this.removeAll(targets.value)
    this.pending.delete(token)
    this.invalidateAll()
    return { ok: true, value: report }
  }

  /**
   * A preview the user walked away from is never presented again, so the expiry in `execute` never
   * gets to read it: the entry, and the whole file list it enumerated, would be held until the
   * process ends. Cancelling is the ordinary outcome of that dialog, so the next preview is where
   * the ones before it are collected.
   */
  private evictExpired(): void {
    const now = Date.now()
    for (const [token, pending] of this.pending)
      if (now > pending.preview.expiresAt)
        this.pending.delete(token)
  }

  /**
   * Containment first: a project path is only ever `<category root>/<name>`, a Claude store directory
   * only ever sits under `<claudeHome>/projects`, and a Codex rollout only ever under
   * `<codexHome>/sessions`. Anything that resolves outside those three roots ends the operation with
   * nothing enumerated and nothing removed - this is the guard that stands between a bad name and a
   * recursive delete somewhere else on the machine.
   *
   * The name is checked twice: once as it is written, and once as the file system really resolves
   * it. A lexical answer is only as true as the assumption that no directory along the way is a link,
   * and a project directory that is a junction to somewhere else passes the first check and fails the
   * second. Everywhere else in this library the lexical form is the right one; delete is the operation
   * that cannot be taken back, so it pays for the two extra calls - on a path that exists, which is
   * the only kind that can be a link.
   */
  private async enumerate(
    category: RuntimeCategory,
    name: string,
  ): Promise<ProjectsOpResult<DeleteTargets>> {
    const projectPath = join(category.path, name)
    if (!PathCompare.isInside(category.path, projectPath)
      || PathCompare.comparable(projectPath) === category.comparablePath)
      return {
        ok: false,
        code: 'not-contained',
        detail: `${projectPath} is not a project inside ${category.path}`,
      }
    if (!await ProjectDeletion.isDirectory(projectPath))
      return { ok: false, code: 'project-not-found', detail: `${projectPath} is not a directory` }
    const root = await ProjectDeletion.resolved(category.path)
    const resolved = await ProjectDeletion.resolved(projectPath)
    if (!PathCompare.isInside(root, resolved)
      || PathCompare.comparable(resolved) === PathCompare.comparable(root))
      return {
        ok: false,
        code: 'not-contained',
        detail: `${projectPath} resolves to ${resolved}, which is outside ${category.path}`,
      }
    const files = await this.providerFiles(projectPath)
    const encodedDirectory = await this.locator.resolveProjectDir(projectPath)
    const claudeRoot = join(this.claudeHome, ProjectDeletion.projectsDirectoryNameConst)
    const codexRoot = join(this.codexHome, ProjectDeletion.sessionsDirectoryNameConst)
    // The provider paths are enumerated by the providers themselves, so this checks their answers
    // rather than trusting them: a store that moved or a link that points elsewhere stops the delete.
    const strayed = [encodedDirectory, ...files.claude]
      .find((path) => path !== null && !PathCompare.isInside(claudeRoot, path))
      ?? files.codex.find((path) => !PathCompare.isInside(codexRoot, path))
    if (strayed !== undefined && strayed !== null)
      return {
        ok: false,
        code: 'not-contained',
        detail: `${strayed} is outside the provider stores this module may delete from`,
      }
    return {
      ok: true,
      value: {
        projectPath,
        projectFileCount: await this.countFiles(projectPath),
        encodedDirectory,
        claudeFiles: [...files.claude].sort(),
        codexFiles: [...files.codex].sort(),
      },
    }
  }

  private async providerFiles(projectPath: string): Promise<{ claude: string[]; codex: string[] }> {
    const files: { claude: string[]; codex: string[] } = { claude: [], codex: [] }
    for (const migrator of this.migrators) {
      const enumerated = await migrator.enumerateProjectFiles(projectPath)
      if (migrator.agentId === 'claude') files.claude = enumerated
      else if (migrator.agentId === 'codex') files.codex = enumerated
      else throw new Error(`Unknown provider: ${JSON.stringify(migrator.agentId)}`)
    }
    return files
  }

  /**
   * The paths only. The file count is deliberately left out: a working copy writes build output while
   * the user reads the preview, and a count that moved does not mean the delete would touch anything
   * the preview did not name.
   */
  private static fingerprintOf(targets: DeleteTargets): string {
    return JSON.stringify([
      PathCompare.comparable(targets.projectPath),
      targets.encodedDirectory === null ? null : PathCompare.comparable(targets.encodedDirectory),
      targets.claudeFiles.map(PathCompare.comparable),
      targets.codexFiles.map(PathCompare.comparable),
    ])
  }

  /**
   * The project, then the Claude store directory, then the Codex rollouts one by one - and never
   * `session_index.jsonl`, which belongs to every session of that store and not to this project.
   */
  private async removeAll(targets: DeleteTargets): Promise<DeleteReport> {
    const report: DeleteReport = { deletedPaths: 0, leftoverCount: 0 }
    const operationId = randomUUID()
    for (const target of ProjectDeletion.removalOrderOf(targets)) {
      try {
        await this.io.remove(target)
        report.deletedPaths += 1
      } catch (error) {
        if (!TranscriptRewriter.isLockedError(error)) {
          // Not a lock, so retrying it at every start would never succeed either; it is reported and
          // the rest of the delete goes on.
          this.report(`${target} could not be deleted: ${ErrorText.of(error)}`)
          continue
        }
        this.leftovers.record({
          kind: 'delete',
          path: target,
          operationId,
          recordedAt: Date.now(),
        })
        report.leftoverCount += 1
      }
    }
    return report
  }

  /**
   * The project's own directory first, because it is the one the user asked about; then every path
   * the preview named, one by one.
   *
   * The transcripts are removed before the store directory that holds them rather than with it: the
   * preview names them individually, and a set that is enumerated for the confirmation but removed
   * only as a side effect of removing something else is a set that stops matching the moment one of
   * them lies somewhere the directory does not cover.
   */
  private static removalOrderOf(targets: DeleteTargets): string[] {
    const order = [targets.projectPath, ...targets.claudeFiles]
    if (targets.encodedDirectory !== null)
      order.push(targets.encodedDirectory)
    order.push(...targets.codexFiles)
    return order
  }

  private async countFiles(directory: string): Promise<number> {
    try {
      const entries = await readdir(directory, { recursive: true, withFileTypes: true })
      return entries.filter((entry) => !entry.isDirectory()).length
    } catch (error) {
      // A number for the user to read, not a reason to refuse the delete - but never a silent zero.
      this.report(`${directory} could not be counted for the delete preview: ${ErrorText.of(error)}`)
      return 0
    }
  }

  private static async isDirectory(path: string): Promise<boolean> {
    try { return (await stat(path)).isDirectory() }
    catch { return false }
  }

  /** A path that is not there resolves to itself: there is no link to see through yet. */
  private static async resolved(path: string): Promise<string> {
    try { return await realpath(path) }
    catch { return path }
  }
}
