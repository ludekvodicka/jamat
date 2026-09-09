import { mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ProviderOutcome } from '../../projectManagerApi.types'
import { ErrorText } from '../../../shared/errorText'
import type { RewriterIo } from '../core/transcriptRewriter'
import { TranscriptRewriter } from '../core/transcriptRewriter'
import type {
  LeftoverEntry,
  MigrationPreflight,
  ProviderAgentId,
  ProviderHistoryMigrator,
  RelocationJournalWriter,
  RelocationLeftoversWriter,
} from '../providerContract.types'
import { ClaudeProjectsLocator } from './claudeProjectsLocator'

/**
 * The rewriter's file operations plus the three directory ones this migrator adds. Injectable for the
 * same reason: on Windows the failures that matter here - a store directory or a transcript another
 * process holds open - cannot be produced from Node, and code that is never exercised against them is
 * code that has never been tested where it counts.
 */
export interface ClaudeStoreIo extends RewriterIo {
  readdir(directory: string): Promise<string[]>
  mkdir(directory: string): Promise<void>
  /** Empty directories only, never recursive: one that still holds transcripts must survive. */
  removeDirectory(directory: string): Promise<void>
}

/** What one migration run carries through the steps below. */
interface MigrationRun {
  oldDir: string
  newDir: string
  replacements: readonly [string, string][]
  journal: RelocationJournalWriter
  leftovers: RelocationLeftoversWriter
  recorded: number
}

export interface ClaudeHistoryMigratorDeps {
  claudeHome: string
  locator: ClaudeProjectsLocator
  report: (message: string) => void
  io?: ClaudeStoreIo
}

/**
 * Moves a project's Claude history to where the project went.
 *
 * Claude keeps the transcripts in a directory named after the project path, so a project that moves
 * needs both: the directory renamed, and every path inside the transcripts rewritten. Neither can be
 * reproduced if it goes wrong - these are the user's conversations, in someone else's application.
 */
export class ClaudeHistoryMigrator implements ProviderHistoryMigrator {
  private static readonly projectsDirectoryNameConst = 'projects'
  private static readonly transcriptSuffixConst = '.jsonl'
  private static readonly nodeIoConst: ClaudeStoreIo = {
    readFile: (file) => readFile(file, 'utf8'),
    writeFile: (file, content) => writeFile(file, content, 'utf8'),
    rename: (oldPath, newPath) => rename(oldPath, newPath),
    unlink: (file) => unlink(file),
    readdir: (directory) => readdir(directory),
    mkdir: async (directory) => { await mkdir(directory, { recursive: true }) },
    removeDirectory: (directory) => rmdir(directory),
  }

  readonly agentId: ProviderAgentId = 'claude'
  private readonly claudeHome: string
  private readonly locator: ClaudeProjectsLocator
  private readonly report: (message: string) => void
  private readonly io: ClaudeStoreIo

  constructor(deps: ClaudeHistoryMigratorDeps) {
    this.claudeHome = deps.claudeHome
    this.locator = deps.locator
    this.report = deps.report
    this.io = deps.io ?? ClaudeHistoryMigrator.nodeIoConst
  }

  /**
   * The one thing this migrator cannot do: merge. If both the old and the new path already have a
   * store directory, moving one into the other interleaves two histories that nothing could tell
   * apart afterwards, so the whole relocation is refused before anything is touched.
   */
  async preflight(oldDir: string, newDir: string): Promise<MigrationPreflight> {
    const source = await this.locator.resolveProjectDir(oldDir)
    if (!source) return { ok: true }
    const target = await this.locator.resolveProjectDir(newDir)
    if (!target) return { ok: true }
    return {
      ok: false,
      conflict: `Claude already stores history for both ${oldDir} (${source}) and ${newDir} (${target});`
        + ' merging the two could not be undone',
    }
  }

  async relocate(
    oldDir: string,
    newDir: string,
    journal: RelocationJournalWriter,
    leftovers: RelocationLeftoversWriter,
  ): Promise<ProviderOutcome> {
    const run: MigrationRun = {
      oldDir,
      newDir,
      // The encoder comes from the locator, never from a second copy of that rule: two spellings of
      // it is how a whole category's history goes missing.
      replacements: TranscriptRewriter.replacementsOf(
        oldDir,
        newDir,
        ClaudeProjectsLocator.encodeProjectDir,
      ),
      journal,
      leftovers,
      recorded: 0,
    }
    try {
      const source = await this.locator.resolveProjectDir(oldDir)
      const target = this.storeDirectoryOf(newDir)
      // Nothing was ever stored for this project, which is the normal state of a folder that never
      // ran an agent - not a failure to report.
      if (source) await this.moveStore(source, target, run)
      await this.rewriteStore(target, run)
      this.locator.invalidate()
      return run.recorded === 0 ? 'done' : 'done-with-leftovers'
    } catch (error) {
      // Reported and turned into an outcome, never swallowed: the caller keeps the journal on 'failed'
      // and the next startup sweep resumes from the checkpoints this run already wrote.
      this.report(
        `Claude history migration ${oldDir} -> ${newDir} failed: ${ErrorText.of(error)}`,
      )
      return 'failed'
    }
  }

  async enumerateProjectFiles(projectDir: string): Promise<string[]> {
    const directory = await this.locator.resolveProjectDir(projectDir)
    if (!directory) return []
    return (await this.transcriptNames(directory)).map((name) => join(directory, name))
  }

  private storeDirectoryOf(projectDir: string): string {
    return join(
      this.claudeHome,
      ClaudeHistoryMigrator.projectsDirectoryNameConst,
      ClaudeProjectsLocator.encodeProjectDir(projectDir),
    )
  }

  /**
   * One rename carries the whole store when nothing holds it open. When something does, the
   * transcripts go over one at a time instead - each written to its new home before the old copy is
   * removed - and the empty shell is taken away afterwards if it can be.
   *
   * The one-at-a-time path may find files already at the target, and that is not a merge: it means a
   * previous run of THIS operation was interrupted part way through it, and the two directories hold
   * the two halves of one project's history. What keeps a different project's history out of them is
   * `preflight`, which the caller runs before the first effect and which refuses the whole move.
   */
  private async moveStore(source: string, target: string, run: MigrationRun): Promise<void> {
    // A resume finds both directories, which is what an interrupted one-at-a-time pass leaves, and a
    // rename onto them fails as EPERM on Windows but as ENOTEMPTY everywhere else. Only the first of
    // those looks like a lock, so asking whether the target is there is what keeps a resume from
    // depending on which operating system it is being resumed on.
    if (!await this.storeExists(target)) {
      try {
        await this.io.rename(source, target)
        return
      } catch (error) {
        if (!TranscriptRewriter.isLockedError(error)) throw error
      }
    }
    await this.io.mkdir(target)
    for (const name of await this.transcriptNames(source)) {
      const oldFile = join(source, name)
      const outcome = await TranscriptRewriter.moveWithRewrite(
        oldFile,
        join(target, name),
        run.replacements,
        this.io,
      )
      // A moved file is checkpointed by the rewrite pass below, under its new path; only the copy
      // left behind needs a record of its own, because nothing else will name it again.
      if (outcome === 'moved') continue
      else if (outcome === 'copied-pending-delete') {
        this.recordLeftover(run, {
          kind: 'delete',
          path: oldFile,
          operationId: run.journal.operationId,
          recordedAt: Date.now(),
        })
        run.journal.checkpoint({ provider: this.agentId, file: oldFile, state: 'copied-pending-delete' })
      }
      else
        throw new Error(`Unknown move outcome: ${JSON.stringify(outcome)}`)
    }
    try {
      await this.io.removeDirectory(source)
    } catch (error) {
      // The transcripts are already at their new home; an empty directory left behind is untidy, not
      // a reason to fail an operation that succeeded.
      this.report(
        `Claude store directory ${source} could not be removed (${ErrorText.of(error)});`
        + ' its transcripts were moved and it is now empty',
      )
    }
  }

  /**
   * The paths inside the transcripts, which the move did not touch. Replaying this over a file that
   * was already rewritten finds nothing left to replace and writes nothing, which is what lets the
   * startup sweep resume an interrupted run without a rollback.
   */
  private async rewriteStore(target: string, run: MigrationRun): Promise<void> {
    for (const name of await this.transcriptNames(target)) {
      const file = join(target, name)
      const outcome = await TranscriptRewriter.rewriteInPlace(file, run.replacements, this.io)
      if (outcome === 'rewritten' || outcome === 'unchanged')
        run.journal.checkpoint({ provider: this.agentId, file, state: 'done' })
      else if (outcome === 'left-locked')
        this.recordLeftover(run, {
          kind: 'rewrite',
          provider: this.agentId,
          path: file,
          operationId: run.journal.operationId,
          oldPath: run.oldDir,
          newPath: run.newDir,
          recordedAt: Date.now(),
        })
      else
        throw new Error(`Unknown rewrite outcome: ${JSON.stringify(outcome)}`)
    }
  }

  /**
   * The two records are built at their two call sites, each with its `kind` spelled out: a literal is
   * what makes the compiler check the fields, and a `kind` read out of a variable let a delete record
   * carry a provider and two paths the type says it never holds.
   */
  private recordLeftover(run: MigrationRun, entry: LeftoverEntry): void {
    // A refused record is the one case nothing else will ever name this file again, so the path goes
    // into the log instead of into a count the user cannot act on.
    if (!run.leftovers.record(entry))
      this.report(
        `${entry.path} was left behind by the move of ${run.oldDir} and could not be registered for`
        + ' the cleanup sweep; remove or rewrite it by hand',
      )
    run.recorded += 1
  }

  /** Whether the store directory is already there, told apart from an empty one that is not. */
  private async storeExists(directory: string): Promise<boolean> {
    try {
      await this.io.readdir(directory)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async transcriptNames(directory: string): Promise<string[]> {
    try {
      return (await this.io.readdir(directory))
        .filter((name) => name.endsWith(ClaudeHistoryMigrator.transcriptSuffixConst))
        .sort()
    } catch (error) {
      // A store directory that is not there holds no transcripts. Anything else is a real failure and
      // is thrown, because "no files" and "the files could not be listed" must not read alike.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}
