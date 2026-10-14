import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rename, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { CommandOutcome, CommandRunner } from '../shared/commandInvoker.types'
import { ErrnoCode } from '../shared/errnoCode'
import { ErrorText } from '../shared/errorText'
import { PathCompare } from '../shared/pathCompare'
import { ProductGroup } from '../shared/productGroup'
import { Slug } from '../shared/slug'
import { type TreeRemovalListener, type TreeRemove, TreeRemoval } from '../shared/treeRemoval'
import type {
  SvnBounds,
  SvnCheckout,
  SvnConflictFact,
  SvnConflictRead,
  SvnContentFacts,
  SvnErrorCode,
  SvnInfoEntry,
  SvnLogEntry,
  SvnLoggedRow,
  SvnOwnCommitInput,
  SvnResult,
  SvnReviewRoot,
  SvnRoot,
  SvnRootBounds,
  SvnStatusRow,
  SvnVerboseItem,
  SvnWorktreeFacts,
  SvnWorktreeLocation,
  SvnWorktreeStatus,
} from './svn.types'
import { type SvnConflictedRow, SvnConflictFacts, type SvnInfoConflicts } from './svnConflictFacts'
import { SvnWorktreeEvidence } from './svnWorktreeEvidence'

/** The properties of one conflicted parent and its children, by name; each value by property name. */
interface SvnPropertyValues {
  older: Map<string, Map<string, string>>
  mine: Map<string, Map<string, string>>
  theirs: Map<string, Map<string, string>>
}

/** A failed svn run thrown out of an evidence callback, so its code survives the evidence function. */
class SvnRunFailure extends Error {
  readonly code: SvnErrorCode

  constructor(code: SvnErrorCode, detail: string) {
    super(detail)
    this.code = code
  }
}

/**
 * Every SVN and disk write of an SVN worktree, and the reads an SVN action decides its next stage
 * and proves its work with (`docs/architecture/svn-worktrees.md`). The update, the cleanup and the
 * checks are runs of the action; this class only reads around them.
 *
 * svn.exe reads its arguments in the ANSI code page and maps a character outside it to a look-alike,
 * which names another file without an error. Every command therefore runs with its working directory
 * at the working copy and takes only relative names `SvnWorktreeEvidence.takesArgument` accepts; a
 * name it refuses is reported, never passed.
 */
export class SvnWorktreeManager {
  /** Files a folder's content hash reads; past it the folder hashes what it read. */
  private static readonly folderFilesMaxConst = 2_000
  static readonly worktreesDirConst = '.worktrees'
  private static readonly asideSuffixConst = '.deleting'
  /** svn holds a working-copy lock (E155004) while another client works in the same working copy. */
  static readonly lockRetryDelaysConst: readonly number[] = [1000, 2000, 2000]
  /** Paths per `svn resolve`, so a long conflict list stays below the Windows command-line limit. */
  private static readonly resolveBatchConst = 50
  private readonly svn: CommandRunner
  private readonly removeTree: TreeRemove
  /** Creates under way per owner: `.worktrees` stays while one runs, or its reservation loses its parent. */
  private readonly creating = new Map<string, number>()
  /** The removal of an empty `.worktrees` per owner, which a create waits out before it makes the directory. */
  private readonly removing = new Map<string, Promise<void>>()

  constructor(svn: CommandRunner, removeTree: TreeRemove = TreeRemoval.node) {
    this.svn = svn
    this.removeTree = removeTree
  }

  /**
   * Why `ownerDir` may not own a worktree, or null. It lies at or below the project, outside any
   * `.worktrees`, in an SVN working copy, and it is no working-copy root that holds another catalog
   * project below it (a zone root; a product group and a standalone repository pass).
   */
  async ownerProblem(input: { ownerDir: string; projectPath: string; holdsOtherProject: (dir: string) => boolean }): Promise<string | null> {
    const { ownerDir, projectPath } = input
    if (!PathCompare.isInside(projectPath, ownerDir)) return `${ownerDir} lies outside the project ${projectPath}`
    if (PathCompare.normalized(ownerDir).split('/').includes(SvnWorktreeManager.worktreesDirConst))
      return `${ownerDir} lies inside a worktree; cut worktrees from the project itself`
    if (!await SvnWorktreeManager.isDirectory(ownerDir)) return `${ownerDir} is no directory`
    const wcRoot = await this.workingCopyRootOf(ownerDir)
    if (!wcRoot.ok) {
      if (wcRoot.code === 'svn-missing') return `svn is not installed: ${wcRoot.detail}`
      if (wcRoot.code === 'not-a-working-copy') return `checkpoints mode makes SVN worktrees and ${ownerDir} is in no SVN working copy`
      return `${ownerDir} is not a versioned SVN directory: ${wcRoot.detail}`
    }
    if (PathCompare.comparable(wcRoot.value) === PathCompare.comparable(ownerDir) && input.holdsOtherProject(ownerDir))
      return `${ownerDir} is a working-copy root that holds other projects, not a project`
    return null
  }

  /**
   * The root of the working copy that holds the versioned directory `dir`, read from `svn info --xml`,
   * which keeps a non-ASCII name intact. An unversioned directory inside a working copy fails with
   * svn's own words.
   */
  async workingCopyRootOf(dir: string): Promise<SvnResult<string>> {
    if (!await SvnWorktreeManager.isDirectory(dir)) return { ok: false, code: 'refused', detail: `${dir} is no directory` }
    const info = await this.run(dir, ['info', '--xml', '--', '.'])
    if (!info.ok) return info
    const wcRoot = /<wcroot-abspath>([^<]*)<\/wcroot-abspath>/.exec(info.value.stdout)?.[1]
      ?.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name] ?? '')
    if (wcRoot === undefined) return { ok: false, code: 'svn-failed', detail: `svn info names no working-copy root for ${dir}` }
    return { ok: true, value: wcRoot }
  }

  /**
   * Whether `dir` lies in an SVN working copy. An unversioned or missing directory inside one does
   * too: `ownerProblem` then names what is wrong with it. Without svn there is no answer.
   */
  async inWorkingCopy(dir: string): Promise<SvnResult<boolean>> {
    const info = await this.run(dir, ['info', '--show-item', 'wc-root', '--', '.'])
    if (info.ok) return { ok: true, value: true }
    switch (info.code) {
      case 'not-a-working-copy': return { ok: true, value: false }
      case 'svn-missing': return info
      case 'out-of-date':
      case 'locked':
      case 'external-target':
      case 'svn-failed':
      case 'refused':
      case 'io-failed':
        return { ok: true, value: true }
      default: throw new Error(`Unknown svn failure ${String(info.code satisfies never)}`)
    }
  }

  /**
   * The local half of a create: the empty folder `<owner>/.worktrees/<folder>`, or the first free
   * `<folder>-2`, `<folder>-3` (a name with a `.deleting` rest counts as taken), the owner's URL, the
   * HEAD revision the checkout is to take and the folder's identity. The `.worktrees` directory must
   * be ignored by SVN, because the commit review stages every unversioned file of its scope and would
   * publish the whole worktree with the owner's next change. The checkout itself is the first run of
   * the session's before chain (`checkoutArgsOf`). A failure leaves nothing this call made.
   */
  async reserve(input: { ownerDir: string; folder: string }): Promise<SvnResult<SvnCheckout>> {
    return this.underCreate(input.ownerDir, () => this.reserveNow(input.ownerDir, input.folder))
  }

  /**
   * A reservation and its checkout in this process, for a caller that wants the worktree at once.
   * A failed checkout deletes the folder it reserved, or names it when it cannot.
   */
  async create(input: { ownerDir: string; folder: string }): Promise<SvnResult<SvnCheckout>> {
    return this.underCreate(input.ownerDir, async () => {
      const reserved = await this.reserveNow(input.ownerDir, input.folder)
      if (!reserved.ok) return reserved
      const { worktreePath, url, baseRevision } = reserved.value
      const checkout = await this.run(worktreePath, SvnWorktreeManager.checkoutArgsOf(url, baseRevision, 'quiet'))
      if (checkout.ok) return reserved
      const purge = await this.removeTree(worktreePath).then(() => null, (error: unknown) => ErrorText.of(error))
      if (purge !== null || existsSync(worktreePath))
        return { ok: false, code: checkout.code, detail: `Checkout of ${url} into ${worktreePath} failed, and ${worktreePath} is left behind`
          + `${purge === null ? '' : ` (${purge})`}; delete it by hand: ${checkout.detail}` }
      await rmdir(join(input.ownerDir, SvnWorktreeManager.worktreesDirConst)).catch(() => undefined)
      return { ok: false, code: checkout.code, detail: `Checkout of ${url} into ${worktreePath} failed; nothing was left behind: ${checkout.detail}` }
    })
  }

  /**
   * The svn arguments that check `url` out at `revision` into the current directory, the reserved
   * folder. A run passes them after `--non-interactive`; `run` here inserts that itself. The run of
   * the before chain is `listed`: svn prints each file it adds, so the run's live line and its log say
   * how far the checkout is. `create` is `quiet`: its output is captured, and one line per file of a
   * large tree would pass the command invoker's output cap and fail the checkout.
   */
  static checkoutArgsOf(url: string, revision: number, output: 'listed' | 'quiet'): string[] {
    const target = ['--', `${url}@${revision}`, '.']
    switch (output) {
      case 'listed': return ['checkout', ...target]
      case 'quiet': return ['checkout', '-q', ...target]
      default: throw new Error(`Unknown checkout output ${String(output satisfies never)}`)
    }
  }

  /**
   * Empties a reserved folder whose checkout failed, so the checkout can run there again. The folder
   * itself stays, so its identity does too. Only the folder this create reserved: without its file
   * ID, or with another one, nothing is deleted.
   */
  async purgeReserved(location: { worktreePath: string; directoryId?: string }): Promise<SvnResult<void>> {
    const { worktreePath, directoryId } = location
    if (directoryId === undefined)
      return { ok: false, code: 'refused', detail: `${worktreePath} carries no file ID, so nothing proves it is the folder this session reserved; nothing was deleted` }
    const current = await SvnWorktreeManager.directoryIdOf(worktreePath)
    if (current === null) return { ok: false, code: 'refused', detail: `The reserved folder ${worktreePath} is gone` }
    if (current !== directoryId)
      return { ok: false, code: 'refused', detail: `${worktreePath} is another directory than the folder this session reserved; nothing was deleted` }
    for (const entry of await readdir(worktreePath)) {
      try { await this.removeTree(join(worktreePath, entry)) }
      catch (error) { return { ok: false, code: 'io-failed', detail: `Cannot empty ${worktreePath} for the checkout: ${ErrorText.of(error)}` } }
    }
    return { ok: true, value: undefined }
  }

  /** A create under way keeps `.worktrees`, or its reservation loses its parent; it waits out a removal already under way. */
  private async underCreate<T>(ownerDir: string, work: () => Promise<T>): Promise<T> {
    const key = PathCompare.comparable(ownerDir)
    this.creating.set(key, (this.creating.get(key) ?? 0) + 1)
    try {
      await this.removing.get(key)
      return await work()
    } finally {
      const left = (this.creating.get(key) ?? 1) - 1
      if (left === 0) this.creating.delete(key)
      else this.creating.set(key, left)
    }
  }

  private async reserveNow(ownerDir: string, folder: string): Promise<SvnResult<SvnCheckout>> {
    if (folder === '' || Slug.of(folder) !== folder)
      return { ok: false, code: 'refused', detail: `${JSON.stringify(folder)} is no worktree folder name` }
    const info = await this.infoOf(ownerDir, '.')
    if (!info.ok) return info
    const url = info.value.url
    if (!SvnWorktreeEvidence.takesArgument(url))
      return { ok: false, code: 'refused', detail: `svn cannot take the URL ${url} as an argument` }
    const head = await this.infoOf(ownerDir, url)
    if (!head.ok) return { ...head, detail: `Cannot read the HEAD revision of ${url}: ${head.detail}` }
    const worktreesDir = join(ownerDir, SvnWorktreeManager.worktreesDirConst)
    let madeWorktreesDir: boolean
    try {
      await mkdir(worktreesDir)
      madeWorktreesDir = true
    }
    catch (error) {
      if (ErrnoCode.of(error) !== 'EEXIST' || !await SvnWorktreeManager.isDirectory(worktreesDir))
        return { ok: false, code: 'io-failed', detail: `Cannot create ${worktreesDir}: ${ErrorText.of(error)}` }
      madeWorktreesDir = false
    }
    const dropWorktreesDir = async (): Promise<void> => {
      if (madeWorktreesDir) await rmdir(worktreesDir).catch(() => undefined)
    }
    const ignored = await this.isIgnored(ownerDir, SvnWorktreeManager.worktreesDirConst)
    if (!ignored.ok || !ignored.value) {
      await dropWorktreesDir()
      return ignored.ok
        ? { ok: false, code: 'refused', detail: `SVN does not ignore ${worktreesDir}; add ${SvnWorktreeManager.worktreesDirConst} to global-ignores in the Subversion config` }
        : ignored
    }
    const reserved = await SvnWorktreeManager.reserveFolder(worktreesDir, folder)
    if (!reserved.ok) {
      await dropWorktreesDir()
      return reserved
    }
    const worktreePath = join(worktreesDir, reserved.value)
    return { ok: true, value: { worktreePath, url, baseRevision: head.value.revision, directoryId: await SvnWorktreeManager.directoryIdOf(worktreePath) } }
  }

  /** The owner still checks out the worktree's URL, and the worktree is the checkout made for it. */
  async ownerCheck(location: SvnWorktreeLocation): Promise<SvnResult<void>> {
    const { worktreePath, ownerDir, url } = location
    if (!await SvnWorktreeManager.isDirectory(ownerDir))
      return { ok: false, code: 'refused', detail: `The owner ${ownerDir} is gone` }
    const owner = await this.infoOf(ownerDir, '.')
    if (!owner.ok) return owner
    if (owner.value.url !== url)
      return { ok: false, code: 'refused', detail: `The owner ${ownerDir} checks out ${owner.value.url}, not ${url}` }
    if (!existsSync(join(worktreePath, '.svn')))
      return { ok: false, code: 'refused', detail: `${worktreePath} is no SVN checkout` }
    const identity = await this.identityProblem(location)
    if (identity !== null) return { ok: false, code: 'refused', detail: identity }
    return { ok: true, value: undefined }
  }

  /** Every local change, externals included: content, add, delete, unversioned, missing, properties. Ignored files are scrap. */
  async changes(worktreePath: string): Promise<SvnResult<SvnStatusRow[]>> {
    const rows = await this.statusOf(worktreePath)
    return rows.ok ? { ok: true, value: SvnWorktreeEvidence.changed(rows.value) } : rows
  }

  /** Every working copy of the worktree, nested mounts first and the worktree last, with its changed rows. */
  async roots(worktreePath: string): Promise<SvnResult<SvnRoot[]>> {
    const rows = await this.statusOf(worktreePath)
    return rows.ok ? { ok: true, value: await SvnWorktreeManager.rootsOf(worktreePath, rows.value) } : rows
  }

  /**
   * Schedules the deletion of every file deleted from disk, because the update run would restore it.
   * A name svn cannot take is refused rather than passed. Nothing at or below a recorded conflict
   * victim is touched: a file missing there may be what another commit brought in, and the update
   * restores it rather than the Finish deleting it.
   */
  async scheduleMissing(worktreePath: string, victims: readonly string[] = []): Promise<SvnResult<void>> {
    const before = await this.statusOf(worktreePath)
    if (!before.ok) return before
    const belowVictim = (path: string): boolean => victims.some((victim) => victim === '.' || path === victim || path.startsWith(`${victim}/`))
    let top: string | null = null
    for (const row of before.value.filter((entry) => entry.kind === 'missing' && !belowVictim(entry.path)).sort((a, b) => a.path.localeCompare(b.path))) {
      if (top !== null && row.path.startsWith(`${top}/`)) continue
      top = row.path
      if (!SvnWorktreeEvidence.takesArgument(row.path))
        return { ok: false, code: 'refused', detail: `svn cannot take the name of ${row.path}, which was deleted from disk; schedule its deletion in an SVN client, then finish again` }
      const deleted = await this.run(worktreePath, ['delete', '-q', '--force', '--', `${row.path}@`])
      if (!deleted.ok) return { ...deleted, detail: `Cannot schedule the deletion of ${row.path}: ${deleted.detail}` }
    }
    return { ok: true, value: undefined }
  }

  /** The conflicts and the changes after an update, from status XML, never from the update's text. */
  async status(worktreePath: string): Promise<SvnResult<SvnWorktreeStatus>> {
    const status = await this.run(worktreePath, ['status', '--xml', '--', '.'])
    if (!status.ok) return status
    try {
      const conflicts = SvnWorktreeEvidence.conflicts(status.value.stdout, worktreePath)
      return {
        ok: true,
        value: {
          textConflicts: conflicts.filter((row) => row.text && !row.other).map((row) => row.path),
          otherConflicts: conflicts.filter((row) => row.other).map((row) => row.path),
          changed: SvnWorktreeEvidence.changed(SvnWorktreeEvidence.statusRows(status.value.stdout, worktreePath)).map((row) => row.path),
        },
      }
    }
    catch (error) { return { ok: false, code: 'svn-failed', detail: ErrorText.of(error) } }
  }

  /**
   * Every conflict of a working copy as one set, with svn's facts per path: `svn status --xml` once,
   * then `svn info --xml --depth immediates -- .` with the working directory in each conflicted
   * path's parent, so a victim whose name svn cannot take as an argument is still read and listed.
   * Content facts come from svn's sidecars and the BASE checksums; property facts compare the values
   * at `baseRevision`, in the working copy and in the new BASE. Reads that pass a name run only
   * for names svn can take.
   */
  async conflictSet(worktreePath: string, baseRevision: number): Promise<SvnResult<SvnConflictRead>> {
    return this.attempt(async () => {
      const status = SvnWorktreeManager.must(await this.run(worktreePath, ['status', '--xml', '--', '.'])).stdout
      const rows = SvnConflictFacts.itemRows(status, worktreePath)
      const revision = SvnWorktreeManager.must(await this.revisionOf(worktreePath))
      const byParent = new Map<string, SvnConflictedRow[]>()
      for (const row of SvnConflictFacts.conflictedRows(status, worktreePath)) {
        const parent = SvnWorktreeManager.parentOf(row.path)
        byParent.set(parent, [...byParent.get(parent) ?? [], row])
      }
      const facts: SvnConflictFact[] = []
      for (const [parent, members] of byParent) {
        const cwd = parent === '.' ? worktreePath : join(worktreePath, ...parent.split('/'))
        const depth = members.every((row) => row.path === '.') ? 'empty' : 'immediates'
        const entries = SvnConflictFacts.infoConflicts(SvnWorktreeManager.must(await this.run(cwd, ['info', '--xml', '--depth', depth, '--', '.'])).stdout)
        const values = members.some((row) => row.property) ? await this.propertyValues(cwd, entries, depth, baseRevision) : null
        for (const row of members) {
          const entry = entries.find((candidate) => candidate.name === SvnWorktreeManager.nameOf(row.path))
          if (entry === undefined) throw new Error(`svn info in ${parent} gave no entry for ${row.path}`)
          facts.push(await this.factOf(worktreePath, cwd, row, entry, values))
        }
      }
      return { revision, facts, rows }
    })
  }

  /**
   * Marks text conflicts resolved as the files now stand, in the worktree root. A name svn cannot
   * take is refused before any path is passed, so no other file is marked by a best-fit mapping.
   */
  async resolveWorking(worktreePath: string, paths: readonly string[]): Promise<SvnResult<void>> {
    const unsafe = paths.filter((path) => !SvnWorktreeEvidence.takesArgument(path))
    if (unsafe.length > 0) return { ok: false, code: 'refused', detail: `svn cannot take the names ${unsafe.join(', ')}` }
    for (let start = 0; start < paths.length; start += SvnWorktreeManager.resolveBatchConst) {
      const batch = paths.slice(start, start + SvnWorktreeManager.resolveBatchConst).map((path) => `${path}@`)
      const resolved = await this.run(worktreePath, ['resolve', '--accept', 'working', '--', ...batch])
      if (!resolved.ok) return resolved
    }
    return { ok: true, value: undefined }
  }

  /**
   * The paths other commits between `baseRevision` and the worktree's revision now changed in a
   * project of `changed`, from `svn log -v --xml`. `own` are this worktree's commits, which never
   * count. In a product group only a member the change set touches counts.
   */
  async incoming(worktreePath: string, baseRevision: number, changed: readonly string[], own: readonly number[]): Promise<SvnResult<string[]>> {
    return this.attempt(async () => {
      const info = SvnWorktreeManager.must(await this.infoOf(worktreePath, '.'))
      if (info.revision <= baseRevision) return []
      if (!SvnWorktreeEvidence.takesArgument(info.url))
        throw new SvnRunFailure('refused', `svn cannot take the URL ${info.url} as an argument`)
      const log = SvnWorktreeManager.must(await this.run(worktreePath,
        ['log', '-v', '--xml', '-r', `${baseRevision + 1}:${info.revision}`, '--', info.url]))
      const rows = SvnWorktreeEvidence.loggedRows(log.stdout, info.base, '').filter((row) => !own.includes(row.revision))
      const members = existsSync(join(worktreePath, ProductGroup.markerConst)) ? 'first-segment' : 'whole'
      return SvnWorktreeEvidence.incoming(changed, rows, members)
    })
  }

  /**
   * The content of each path, by hash, read from the files only: a file's SHA-256, a folder's digest
   * over the names and contents below it (at most `folderFilesMaxConst` files), `missing` when absent.
   * A change of content shows even when a path was already changed before.
   */
  async hashes(worktreePath: string, paths: readonly string[]): Promise<SvnResult<Record<string, string>>> {
    return this.attempt(async () => {
      const hashes: Record<string, string> = {}
      for (const path of paths) hashes[path] = await SvnWorktreeManager.contentHashOf(join(worktreePath, ...path.split('/')))
      return hashes
    })
  }

  /** The highest BASE in the working copy above `revision`, externals left out, or null: a commit made from it. */
  async baseAbove(worktreePath: string, revision: number): Promise<SvnResult<number | null>> {
    const status = await this.run(worktreePath, ['status', '-v', '--xml', '--ignore-externals', '--', '.'])
    if (!status.ok) return status
    try {
      const highest = Math.max(0, ...SvnWorktreeEvidence.statusVerboseRows(status.value.stdout, worktreePath).map((item) => item.base))
      return { ok: true, value: highest > revision ? highest : null }
    }
    catch (error) { return { ok: false, code: 'svn-failed', detail: ErrorText.of(error) } }
  }

  private static async contentHashOf(path: string): Promise<string> {
    const info = await lstat(path).catch(() => null)
    if (info === null) return 'missing'
    if (!info.isDirectory()) return createHash('sha256').update(await readFile(path)).digest('hex')
    const hash = createHash('sha256')
    let files = 0
    const walk = async (folder: string, prefix: string): Promise<void> => {
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (entry.name === '.svn' || files >= SvnWorktreeManager.folderFilesMaxConst) continue
        const full = join(folder, entry.name)
        if (entry.isDirectory()) await walk(full, `${prefix}${entry.name}/`)
        else {
          files += 1
          hash.update(`${prefix}${entry.name}\n`).update(await readFile(full)).update('\n')
        }
      }
    }
    await walk(path, '')
    return `dir:${hash.digest('hex')}`
  }

  /** The commits from `from` to `to` of the working copy's own path, oldest first; none when `to` is below `from`. */
  async logOf(worktreePath: string, from: number, to: number): Promise<SvnResult<SvnLogEntry[]>> {
    if (to < from) return { ok: true, value: [] }
    return this.attempt(async () => {
      const log = SvnWorktreeManager.must(await this.run(worktreePath, ['log', '--xml', '-r', `${from}:${to}`, '--', '.']))
      return SvnWorktreeEvidence.logEntries(log.stdout)
    })
  }

  /** Whether an svn process holds the working copy, or one that died left it for `svn cleanup`. */
  async locked(worktreePath: string): Promise<boolean> {
    const status = await this.run(worktreePath, ['status', '--xml', '--', '.'])
    if (!status.ok) return status.code === 'locked'
    try { return SvnWorktreeEvidence.lockedPaths(status.value.stdout, worktreePath).length > 0 }
    catch { return false }
  }

  /** The BASE revision of a working copy's root. */
  async revisionOf(path: string): Promise<SvnResult<number>> {
    const info = await this.infoOf(path, '.')
    return info.ok ? { ok: true, value: info.value.revision } : info
  }

  /** The repository root and the revision of a working copy's root directory; local, no server call. */
  async rootRevisionOf(path: string): Promise<SvnResult<{ repository: string; revision: number }>> {
    const info = await this.infoOf(path, '.')
    return info.ok ? { ok: true, value: { repository: info.value.repository, revision: info.value.revision } } : info
  }

  /** The working copies of the external mounts below `path`, absolute, nested ones first. */
  async mountRootsOf(path: string): Promise<SvnResult<string[]>> {
    const rows = await this.statusOf(path)
    if (!rows.ok) return rows
    return { ok: true, value: (await SvnWorktreeManager.rootsOf(path, rows.value)).filter((root) => root.own !== '').map((root) => root.path) }
  }

  /**
   * How many revisions of the server changed `path` after its root revision, from `svn log -q`. svn
   * answers E160006 when the root revision is HEAD already, which is none behind.
   */
  async behind(path: string): Promise<SvnResult<number>> {
    const root = await this.infoOf(path, '.')
    if (!root.ok) return root
    const log = await this.run(path, ['log', '-q', '--xml', '-r', `${root.value.revision + 1}:HEAD`, '--', '.'])
    if (!log.ok) return /E160006/.test(log.detail) ? { ok: true, value: 0 } : log
    return { ok: true, value: (log.value.stdout.match(/<logentry\b/g) ?? []).length }
  }

  /** Every root with its changes, mounts first, and whether a mount is pinned to a revision. */
  async reviewRoots(worktreePath: string): Promise<SvnResult<SvnReviewRoot[]>> {
    const rows = await this.statusOf(worktreePath)
    if (!rows.ok) return rows
    const roots = await SvnWorktreeManager.rootsOf(worktreePath, rows.value)
    if (roots.length === 1) return { ok: true, value: roots.map((root) => ({ ...root, pinned: false })) }
    const properties = await this.run(worktreePath, ['propget', 'svn:externals', '-R', '--xml', '--', '.'])
    if (!properties.ok) return properties
    try {
      const pinned = SvnWorktreeEvidence.pinnedExternals(properties.value.stdout, worktreePath)
      return { ok: true, value: roots.map((root) => ({ ...root, pinned: root.own !== '' && pinned.includes(root.own) })) }
    }
    catch (error) { return { ok: false, code: 'svn-failed', detail: ErrorText.of(error) } }
  }

  /**
   * What the worktree holds now, as one hash: `status -v` of every root and the size and time of
   * every changed file. Two equal fingerprints mean the checks that ran on the first one still hold.
   */
  async fingerprint(worktreePath: string): Promise<SvnResult<string>> {
    const rows = await this.statusOf(worktreePath)
    if (!rows.ok) return rows
    const hash = createHash('sha256')
    for (const root of await SvnWorktreeManager.rootsOf(worktreePath, rows.value)) {
      const status = await this.run(root.path, ['status', '-v', '--xml', '--ignore-externals', '--', '.'])
      if (!status.ok) return status
      hash.update(`${root.own}\n${status.value.stdout}\n`)
    }
    for (const row of SvnWorktreeEvidence.changed(rows.value)) {
      const info = await lstat(join(worktreePath, ...row.path.split('/'))).catch(() => null)
      hash.update(`${row.path}:${info === null ? '-' : `${info.size}:${info.mtimeMs}`}\n`)
    }
    return { ok: true, value: hash.digest('hex') }
  }

  /** This root's own commits since its checkout, from `status -v` confirmed by `svn log -v -r N`. */
  async ownCommits(root: SvnRoot, onRevision?: SvnOwnCommitInput['onRevision']): Promise<SvnResult<{ repository: string; rows: SvnLoggedRow[] }>> {
    return this.attempt(async () => {
      const items = await this.mustVerbose(root)
      const location = SvnWorktreeManager.must(await this.infoOf(root.path, '.'))
      const rows = await SvnWorktreeEvidence.ownCommitRows({
        items,
        revisionLog: (revision) => this.revisionLog(root, location, revision),
        onRevision,
      })
      return { repository: location.repository, rows }
    })
  }

  /** Paths changed below the root's URL after `bound.since`, placed in the worktree. */
  async changedSince(root: SvnRoot, bound: SvnRootBounds): Promise<SvnResult<SvnLoggedRow[]>> {
    return this.attempt(() => this.historyAfter(root, bound))
  }

  /** Per root its repository and BASE, per repository its youngest revision. */
  async lowerBounds(roots: readonly SvnRoot[]): Promise<SvnResult<SvnBounds>> {
    const youngest = new Map<string, number>()
    const bounds: Record<string, SvnRootBounds> = {}
    for (const root of roots) {
      const info = await this.infoOf(root.path, '.')
      if (!info.ok) return info
      const { repository, base, revision } = info.value
      let since = youngest.get(repository)
      if (since === undefined) {
        const head = await this.headOf(root.path, repository)
        if (!head.ok) return head
        since = head.value
        youngest.set(repository, since)
      }
      bounds[root.own] = { repository, base, rootBase: revision, since }
    }
    return { ok: true, value: bounds }
  }

  /** Without a review receipt, what this root's changed paths committed, proven by the worktree's BASE. */
  async proven(root: SvnRoot, bounds: SvnBounds): Promise<SvnResult<SvnLoggedRow[]>> {
    const bound = SvnWorktreeManager.boundOf(root, bounds)
    return this.attempt(async () => SvnWorktreeEvidence.provenRows({
      items: await this.mustVerbose(root),
      own: root.own,
      rootBase: bound.rootBase,
      since: bound.since,
      claimed: root.changed.map((row) => row.path),
      history: () => this.historyAfter(root, bound),
      revisionLog: (revision) => this.revisionLog(root, bound, revision),
    }))
  }

  /** The rows of the one revision a review receipt names, confirmed by `svn log -v` below this root. */
  async reviewed(root: SvnRoot, bounds: SvnBounds, revision: number): Promise<SvnResult<SvnLoggedRow[]>> {
    const bound = SvnWorktreeManager.boundOf(root, bounds)
    return this.attempt(() => SvnWorktreeEvidence.reviewedRows({
      revision,
      since: bound.since,
      base: bound.base,
      revisionLog: (logged) => this.revisionLog(root, bound, logged),
    }))
  }

  /** Whether the worktree directory is still there; a removal cut short leaves only `<name>.deleting`. */
  async present(worktreePath: string): Promise<boolean> {
    return SvnWorktreeManager.isDirectory(worktreePath)
  }

  /**
   * Renames the worktree to `<name>.deleting` before anything is deleted: Windows refuses that rename
   * while a process has its working directory or an open file inside, so a session still running
   * there keeps a whole worktree instead of losing half of it. The directory must be the one the
   * session created (its file ID, else its URL); a reused name never lets one owner delete another's.
   */
  async renameAside(location: SvnWorktreeLocation): Promise<SvnResult<'renamed' | 'in-use' | 'absent'>> {
    const { worktreePath, directoryId } = location
    const aside = `${worktreePath}${SvnWorktreeManager.asideSuffixConst}`
    const present = existsSync(worktreePath)
    if (existsSync(aside)) {
      const asideId = await SvnWorktreeManager.directoryIdOf(aside)
      // Create never picks a name whose rest lies there, so with the worktree gone the rest is this one's.
      if ((directoryId !== undefined && asideId === directoryId) || (directoryId === undefined && !present))
        return { ok: true, value: 'renamed' }
      return { ok: false, code: 'refused', detail: `${aside} is the rest of another removal; the worktree is kept` }
    }
    if (!present) return { ok: true, value: 'absent' }
    const identity = await this.identityProblem(location)
    if (identity !== null) return { ok: false, code: 'refused', detail: identity }
    try {
      await rename(worktreePath, aside)
      return { ok: true, value: 'renamed' }
    }
    catch (error) {
      const code = ErrnoCode.of(error)
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') return { ok: true, value: 'in-use' }
      if (code === 'ENOENT') return { ok: true, value: 'absent' }
      return { ok: false, code: 'io-failed', detail: `Cannot rename ${worktreePath} aside: ${ErrorText.of(error)}` }
    }
  }

  /**
   * Deletes `<name>.deleting`. Node unlinks a junction instead of descending into it, so links into a
   * shared package store survive, and it reaches paths beyond 260 characters. A listener gets the
   * count of the files and then how many of them are gone (`TreeRemoval`).
   */
  async purgeAside(location: SvnWorktreeLocation, onProgress?: TreeRemovalListener): Promise<SvnResult<'removed' | 'undeleted'>> {
    const aside = `${location.worktreePath}${SvnWorktreeManager.asideSuffixConst}`
    if (!existsSync(aside)) return { ok: true, value: 'removed' }
    const asideId = await SvnWorktreeManager.directoryIdOf(aside)
    if (location.directoryId !== undefined && asideId !== null && asideId !== location.directoryId)
      return { ok: false, code: 'refused', detail: `${aside} is another directory than the worktree this session created` }
    try { await this.removeTree(aside, onProgress) }
    catch { return { ok: true, value: 'undeleted' } }
    return { ok: true, value: existsSync(aside) ? 'undeleted' : 'removed' }
  }

  /**
   * Removes `<owner>/.worktrees` once its last worktree went; a directory still holding one stays, and
   * so does one a create of this manager is about to reserve a folder in.
   */
  async removeEmptyWorktreesDir(ownerDir: string): Promise<void> {
    const key = PathCompare.comparable(ownerDir)
    if (this.creating.has(key)) return
    const removal = rmdir(join(ownerDir, SvnWorktreeManager.worktreesDirConst)).catch(() => undefined)
    this.removing.set(key, removal)
    try {
      await removal
    } finally {
      if (this.removing.get(key) === removal) this.removing.delete(key)
    }
  }

  /**
   * Lines added and removed against BASE (no server call; `svn diff` skips externals, so each mount is
   * read on its own), and the changed files, where each file of an unversioned directory counts.
   */
  async facts(worktreePath: string): Promise<SvnResult<SvnWorktreeFacts>> {
    const status = await this.run(worktreePath, ['status', '--xml', '--', '.'])
    if (!status.ok) return status
    let rows: SvnStatusRow[]
    let items: SvnVerboseItem[]
    try {
      rows = SvnWorktreeEvidence.statusRows(status.value.stdout, worktreePath)
      items = SvnWorktreeEvidence.statusVerboseRows(status.value.stdout, worktreePath)
    }
    catch (error) { return { ok: false, code: 'svn-failed', detail: ErrorText.of(error) } }
    let added = 0
    let removed = 0
    for (const root of await SvnWorktreeManager.rootsOf(worktreePath, rows)) {
      const diff = await this.run(root.path, ['diff', '--internal-diff', '--', '.'])
      if (!diff.ok) return diff
      const counted = SvnWorktreeManager.diffLines(diff.value.stdout)
      added += counted.added
      removed += counted.removed
    }
    let changedFiles = 0
    for (const [index, row] of rows.entries()) {
      if (SvnWorktreeEvidence.changed([row]).length === 0) continue
      changedFiles += await SvnWorktreeManager.filesOf(join(worktreePath, ...row.path.split('/')), row, items[index].item)
    }
    return { ok: true, value: { added, removed, changedFiles } }
  }

  private static async rootsOf(worktreePath: string, rows: readonly SvnStatusRow[]): Promise<SvnRoot[]> {
    const mounts = (await SvnWorktreeManager.mountsOf(worktreePath, rows))
      .sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b))
    const changed = SvnWorktreeEvidence.changed(rows)
    const innermost = (path: string): string => mounts.find((mount) => path === mount || path.startsWith(`${mount}/`)) ?? ''
    return [...mounts, ''].map((own) => ({
      path: own === '' ? worktreePath : join(worktreePath, ...own.split('/')),
      own,
      changed: changed.filter((row) => innermost(row.path) === own),
    }))
  }

  /**
   * The working copies the `external` rows stand for. svn marks the first directory of a target it
   * created, so `clients/coinGecko` defined on `shared` gives the row `shared/clients`: a plain
   * directory svn holds no node of, with the mounts below it. A directory with its own `.svn` is a
   * mount; one without is searched for the mounts below it, and a row with no directory gives none.
   */
  private static async mountsOf(worktreePath: string, rows: readonly SvnStatusRow[]): Promise<string[]> {
    const mounts = new Set<string>()
    const visit = async (path: string): Promise<void> => {
      const directory = join(worktreePath, ...path.split('/'))
      if (await SvnWorktreeManager.isDirectory(join(directory, '.svn'))) {
        mounts.add(path)
        return
      }
      // A junction is no Dirent directory, so the search never leaves the worktree.
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => []))
        if (entry.isDirectory()) await visit(`${path}/${entry.name}`)
    }
    for (const row of rows)
      if (row.kind === 'external') await visit(row.path)
    return [...mounts]
  }

  private static diffLines(text: string): { added: number; removed: number } {
    let added = 0
    let removed = 0
    let inHunk = false
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('Index: ') || line.startsWith('Property changes on: ')) inHunk = false
      else if (line.startsWith('@@ ')) inHunk = true
      else if (inHunk && line.startsWith('+')) added += 1
      else if (inHunk && line.startsWith('-')) removed += 1
    }
    return { added, removed }
  }

  /** One for a changed file or a directory whose properties changed; the files of an unversioned directory. */
  private static async filesOf(path: string, row: SvnStatusRow, item: string): Promise<number> {
    const info = await lstat(path).catch(() => null)
    if (info === null || !info.isDirectory()) return 1
    if (item === 'unversioned')
      return (await readdir(path, { recursive: true, withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile()).length
    return row.kind === 'props' ? 1 : 0
  }

  private static boundOf(root: SvnRoot, bounds: SvnBounds): SvnRootBounds {
    const bound = bounds[root.own]
    if (bound === undefined) throw new Error(`No lower bounds were read for the root ${JSON.stringify(root.own)}`)
    return bound
  }

  /** The recorded file ID decides; without one, the URL the worktree checks out. */
  private async identityProblem(location: SvnWorktreeLocation): Promise<string | null> {
    const { worktreePath, directoryId, url } = location
    const current = await SvnWorktreeManager.directoryIdOf(worktreePath)
    if (directoryId !== undefined && current !== null)
      return current === directoryId ? null : `${worktreePath} is another directory than the worktree this session created`
    if (!existsSync(join(worktreePath, '.svn'))) return `${worktreePath} is no SVN checkout`
    const info = await this.infoOf(worktreePath, '.')
    if (!info.ok) return `svn cannot tell what ${worktreePath} checks out: ${info.detail}`
    return info.value.url === url ? null : `${worktreePath} checks out ${info.value.url}, not ${url}`
  }

  private async isIgnored(ownerDir: string, name: string): Promise<SvnResult<boolean>> {
    const status = await this.run(ownerDir, ['status', '--xml', '--no-ignore', '--depth', 'immediates', '--', '.'])
    if (!status.ok) return status
    try {
      const entry = SvnWorktreeEvidence.statusVerboseRows(status.value.stdout, ownerDir).find((item) => item.path === name)
      return { ok: true, value: entry?.item === 'ignored' }
    }
    catch (error) { return { ok: false, code: 'svn-failed', detail: ErrorText.of(error) } }
  }

  /** Makes the first free folder of `folder`, `folder-2`, ...; the directory itself is the reservation. */
  private static async reserveFolder(worktreesDir: string, folder: string): Promise<SvnResult<string>> {
    for (let index = 1; index <= 99; index += 1) {
      const name = index === 1 ? folder : `${folder}-${index}`
      if (existsSync(join(worktreesDir, `${name}${SvnWorktreeManager.asideSuffixConst}`))) continue
      try {
        await mkdir(join(worktreesDir, name))
        return { ok: true, value: name }
      }
      catch (error) {
        if (ErrnoCode.of(error) !== 'EEXIST')
          return { ok: false, code: 'io-failed', detail: `Cannot create ${join(worktreesDir, name)}: ${ErrorText.of(error)}` }
      }
    }
    return { ok: false, code: 'refused', detail: `${worktreesDir} holds ${folder} and 98 numbered variants of it already` }
  }

  private async factOf(worktreePath: string, cwd: string, row: SvnConflictedRow, entry: SvnInfoConflicts,
    values: SvnPropertyValues | null): Promise<SvnConflictFact> {
    const name = SvnWorktreeManager.nameOf(row.path)
    const takesArgument = SvnWorktreeEvidence.takesArgument(row.path)
    const kind = row.tree ? 'tree' : row.text ? 'text' : 'property'
    const sidecars = [entry.sidecars.older, entry.sidecars.mine, entry.sidecars.theirs, entry.sidecars.prej]
      .flatMap((path) => path === null ? [] : [SvnWorktreeEvidence.relativeTo(worktreePath, path)])
    const properties = values === null || !row.property ? []
      : SvnConflictFacts.conflictedProperties(values.older.get(name) ?? new Map(), values.mine.get(name) ?? new Map(), values.theirs.get(name) ?? new Map())
    const local = join(cwd, name)
    let content: SvnContentFacts | null = null
    if (kind === 'text')
      content = SvnConflictFacts.contentOf(await SvnWorktreeManager.bytesOf(entry.sidecars.mine ?? local), await SvnWorktreeManager.bytesOf(entry.sidecars.theirs))
    else if (kind === 'tree' && entry.tree?.action === 'added' && takesArgument)
      content = entry.tree.incomingKind === 'dir' ? await this.directoryContent(cwd, name)
        : await SvnWorktreeManager.fileContent(local, entry.checksum)
    return { path: row.path, kind, takesArgument, tree: entry.tree, sidecars, properties, content }
  }

  /** The properties of the conflicted parent and its children before the update, in the working copy and in the new BASE. */
  private async propertyValues(cwd: string, entries: readonly SvnInfoConflicts[], depth: string, baseRevision: number): Promise<SvnPropertyValues> {
    const url = entries.find((entry) => entry.name === '.')?.url ?? ''
    if (!SvnWorktreeEvidence.takesArgument(url)) throw new SvnRunFailure('refused', `svn cannot take the URL ${url} as an argument`)
    const before = await this.run(cwd, ['proplist', '-v', '--xml', '--depth', depth, '-r', String(baseRevision), '--', `${url}@${baseRevision}`])
    // The parent did not exist before the update: no property had a value.
    const absent = !before.ok && /E160013|E170000|path not found/i.test(before.detail)
    const older = absent ? new Map<string, Map<string, string>>() : SvnConflictFacts.propertiesOf(SvnWorktreeManager.must(before).stdout, url)
    const mine = SvnConflictFacts.propertiesOf(SvnWorktreeManager.must(await this.run(cwd, ['proplist', '-v', '--xml', '--depth', depth, '--', '.'])).stdout)
    const theirs = SvnConflictFacts.propertiesOf(SvnWorktreeManager.must(await this.run(cwd, ['proplist', '-v', '--xml', '--depth', depth, '-r', 'BASE', '--', '.'])).stdout)
    return { older, mine, theirs }
  }

  /** A directory obstruction: the files on disk below it against the incoming files of BASE, same-name ones by checksum. */
  private async directoryContent(cwd: string, name: string): Promise<SvnContentFacts> {
    const incoming = SvnConflictFacts.infoConflicts(SvnWorktreeManager.must(await this.run(cwd, ['info', '--xml', '--depth', 'infinity', '--', `${name}@`])).stdout)
      .filter((entry) => entry.kind === 'file')
    const checksums = new Map(incoming.map((entry) => [entry.name, entry.checksum]))
    const root = join(cwd, name)
    const local = (await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map((entry) => SvnWorktreeEvidence.relativeTo(cwd, join(entry.parentPath, entry.name)))
    let same = 0
    let differing = 0
    for (const path of local) {
      if (!checksums.has(path)) continue
      const bytes = await SvnWorktreeManager.bytesOf(join(cwd, ...path.split('/')))
      if (bytes !== null && SvnWorktreeManager.sha1(bytes) === checksums.get(path)) same += 1
      else differing += 1
    }
    return { binary: false, unreadable: false, equal: null, files: { local: local.length, incoming: incoming.length, same, differing } }
  }

  /** A file on disk against the BASE checksum svn keeps for the incoming file. */
  private static async fileContent(path: string, checksum: string | null): Promise<SvnContentFacts> {
    const bytes = await SvnWorktreeManager.bytesOf(path)
    const facts = SvnConflictFacts.contentOf(bytes, null)
    return { ...facts, equal: bytes === null || checksum === null ? null : SvnWorktreeManager.sha1(bytes) === checksum ? 'bytes' : 'differs' }
  }

  private static async bytesOf(path: string | null): Promise<Uint8Array | null> {
    if (path === null) return null
    return readFile(path).catch(() => null)
  }

  private static sha1(bytes: Uint8Array): string {
    return createHash('sha1').update(bytes).digest('hex')
  }

  /** The parent of a root-relative path; the root is its own parent. */
  private static parentOf(path: string): string {
    const slash = path.lastIndexOf('/')
    return path === '.' || slash < 0 ? '.' : path.slice(0, slash)
  }

  private static nameOf(path: string): string {
    return path === '.' ? '.' : path.slice(path.lastIndexOf('/') + 1)
  }

  private async statusOf(worktreePath: string): Promise<SvnResult<SvnStatusRow[]>> {
    const status = await this.run(worktreePath, ['status', '--xml', '--', '.'])
    if (!status.ok) return status
    try { return { ok: true, value: SvnWorktreeEvidence.statusRows(status.value.stdout, worktreePath) } }
    catch (error) { return { ok: false, code: 'svn-failed', detail: ErrorText.of(error) } }
  }

  /** `status -v` of one root without its mounts, placed in the worktree. */
  private async mustVerbose(root: SvnRoot): Promise<SvnVerboseItem[]> {
    const status = SvnWorktreeManager.must(await this.run(root.path, ['status', '-v', '--xml', '--ignore-externals', '--', '.']))
    return SvnWorktreeEvidence.statusVerboseRows(status.stdout, root.path, root.own)
  }

  private async infoOf(cwd: string, target: string): Promise<SvnResult<SvnInfoEntry>> {
    const info = await this.run(cwd, ['info', '--xml', '--', target])
    if (!info.ok) return info
    try {
      const entry = SvnWorktreeEvidence.infoEntries(info.value.stdout)[0]
      if (entry === undefined) return { ok: false, code: 'svn-failed', detail: `svn info gave no entry for ${target}` }
      return { ok: true, value: entry }
    }
    catch (error) { return { ok: false, code: 'svn-failed', detail: ErrorText.of(error) } }
  }

  private async headOf(cwd: string, repository: string): Promise<SvnResult<number>> {
    if (!SvnWorktreeEvidence.takesArgument(repository))
      return { ok: false, code: 'refused', detail: `svn cannot take the URL ${repository} as an argument` }
    const info = await this.infoOf(cwd, repository)
    return info.ok ? { ok: true, value: info.value.revision } : info
  }

  private async revisionLog(root: SvnRoot, location: { repository: string; base: string }, revision: number): Promise<SvnLoggedRow[]> {
    if (!SvnWorktreeEvidence.takesArgument(location.repository))
      throw new SvnRunFailure('refused', `svn cannot take the URL ${location.repository} as an argument`)
    const log = SvnWorktreeManager.must(await this.run(root.path, ['log', '-v', '--xml', '-r', `${revision}:${revision}`, '--', location.repository]))
    return SvnWorktreeEvidence.loggedRows(log.stdout, location.base, root.own)
  }

  /** Paths changed after `since` below the root's URL. */
  private async historyAfter(root: SvnRoot, bound: SvnRootBounds): Promise<SvnLoggedRow[]> {
    const head = SvnWorktreeManager.must(await this.headOf(root.path, bound.repository))
    if (head <= bound.since) return []
    const log = SvnWorktreeManager.must(await this.run(root.path, ['log', '-v', '--xml', '-r', `${bound.since + 1}:HEAD`, '--', bound.repository]))
    return SvnWorktreeEvidence.loggedRows(log.stdout, bound.base, root.own)
  }

  private async attempt<T>(read: () => Promise<T>): Promise<SvnResult<T>> {
    try { return { ok: true, value: await read() } }
    catch (error) {
      return error instanceof SvnRunFailure ? { ok: false, code: error.code, detail: error.message }
        : { ok: false, code: 'svn-failed', detail: ErrorText.of(error) }
    }
  }

  private static must<T>(result: SvnResult<T>): T {
    if (!result.ok) throw new SvnRunFailure(result.code, result.detail)
    return result.value
  }

  private async run(cwd: string, args: string[]): Promise<SvnResult<CommandOutcome>> {
    const outcome = await this.svn.run(cwd, [args[0], '--non-interactive', ...args.slice(1)])
    if (outcome.failure === null && outcome.code === 0) return { ok: true, value: outcome }
    return { ok: false, ...SvnWorktreeManager.failureOf(outcome) }
  }

  /** The error mapping of `SvnCommitManager`. */
  private static failureOf(outcome: CommandOutcome): { code: SvnErrorCode; detail: string } {
    const detail = [outcome.stdout.trim(), outcome.stderr.trim()].filter(Boolean).join('\n') || `svn could not run (${outcome.failure ?? outcome.code})`
    const code = outcome.failure === 'command-missing' ? 'svn-missing'
      : /E155011|E160028|E170004|out.of.date/i.test(detail) ? 'out-of-date'
      : /E155004|E155037|locked/i.test(detail) ? 'locked'
      : /E155007|not a working copy/i.test(detail) ? 'not-a-working-copy'
      : 'svn-failed'
    return { code, detail }
  }

  private static async isDirectory(path: string): Promise<boolean> {
    return (await stat(path).catch(() => null))?.isDirectory() === true
  }

  /** `dev:ino:birthtimeNs`, the spelling of pp `lib/path-identity.mjs`; null without a directory or a file ID. */
  static async directoryIdOf(path: string): Promise<string | null> {
    const info = await stat(path, { bigint: true }).catch(() => null)
    if (info === null || !info.isDirectory() || info.ino === 0n) return null
    return `${info.dev}:${info.ino}:${info.birthtimeNs}`
  }
}
