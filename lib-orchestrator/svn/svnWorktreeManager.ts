import { XMLParser } from 'fast-xml-parser'
import { SvnSetupDirectory } from './svnSetupDirectory'
import { SvnNodeContent } from './svnNodeContent'
import { JsonShape } from '../shared/jsonShape'
import { createHash } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { constants, existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import type { CommandOutcome, CommandRunner } from '../shared/commandInvoker.types'
import { ErrnoCode } from '../shared/errnoCode'
import { ErrorText } from '../shared/errorText'
import { PathCompare } from '../shared/pathCompare'
import { PathPresence } from '../shared/pathPresence'
import { ProductGroup } from '../shared/productGroup'
import { Slug } from '../shared/slug'
import { type TreeRemovalListener, type TreeRemove, TreeRemoval } from '../shared/treeRemoval'
import type {
  SvnBehindRoot,
  SvnBounds,
  SvnCheckout,
  SvnConflictFact,
  SvnConflictRead,
  SvnContentFacts,
  SvnErrorCode,
  SvnInfoEntry,
  SvnLogEntry,
  SvnCommitHistory,
  SvnLoggedRow,
  SvnLandingPath,
  SvnLandingLocal,
  SvnLandingProof,
  SvnLandingReceipt,
  SvnLocalItem,
  SvnOwnCommitInput,
  SvnResult,
  SvnRemovalRow,
  SvnReviewRoot,
  SvnRoot,
  SvnRootBounds,
  SvnStatusRow,
  SvnVerboseItem,
  SvnWcItem,
  SvnWorktreeLocation,
  SvnWorktreeStatus,
} from './svn.types'
import { type SvnConflictedRow, SvnConflictFacts, type SvnInfoConflicts } from './svnConflictFacts'
import { SvnCommitManager, type SvnCommitTarget } from './svnCommitManager'
import { SvnFailures } from './svnFailures'
import { SvnWorktreeEvidence } from './svnWorktreeEvidence'
import { SvnUpdateTargets } from './svnUpdateTargets'
import { SvnAssemblyReader, type SvnAssembly } from './svnAssembly'
import { SvnWcStamp } from './svnWcStamp'

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
  readonly updateTargets: Pick<SvnUpdateTargets, 'owner' | 'snapshot' | 'verify'>
  /** Files a folder's content hash reads; past it the folder hashes what it read. */
  private static readonly folderFilesMaxConst = 2_000
  static readonly worktreesDirConst = '.worktrees'
  private static readonly asideSuffixConst = '.deleting'
  private static readonly renameAttemptsConst = 6
  private static readonly renameDelayMillisecondsConst = 500
  /** svn holds a working-copy lock (E155004) while another client works in the same working copy. */
  static readonly lockRetryDelaysConst: readonly number[] = [1000, 2000, 2000]
  /** Paths per `svn resolve`, so a long conflict list stays below the Windows command-line limit. */
  private static readonly resolveBatchConst = 50
  /** Leave room for SVN flags and Windows argument quoting below the 32,767-character limit. */
  private static readonly landingReadCharactersConst = 24_000
  private readonly svn: CommandRunner
  private readonly removeTree: TreeRemove
  /** Creates under way per owner: `.worktrees` stays while one runs, or its reservation loses its parent. */
  private readonly creating = new Map<string, number>()
  /** The removal of an empty `.worktrees` per owner, which a create waits out before it makes the directory. */
  private readonly removing = new Map<string, Promise<void>>()
  /** Per main copy, its roots and their `svn info` as a landing proof read them, with the stamp they were read under. */
  private readonly landingRoots = new Map<string, { stamp: string | null; roots: { root: string; info: SvnInfoEntry }[] }>()
  /** `svn log -v` of one revision, which never changes. */
  private readonly landingLogs = new Map<string, string>()

  constructor(svn: CommandRunner, removeTree: TreeRemove = TreeRemoval.node) {
    this.svn = svn
    this.updateTargets = new SvnUpdateTargets(svn)
    this.removeTree = removeTree
  }

  async assembly(root: string, freshness = false, progress?: (mount: string, files: number) => void): Promise<SvnResult<SvnAssembly>> {
    return this.attempt(() => new SvnAssemblyReader(this.svn).read(root, freshness, progress))
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

  async urlOf(dir: string): Promise<SvnResult<string>> {
    const info = await this.run(dir, ['info', '--xml', '--', '.'])
    if (!info.ok) return info
    return this.attempt(async () => {
      const entry = SvnWorktreeEvidence.infoEntries(info.value.stdout)[0]
      if (!entry) throw new Error(`svn info names no URL for ${dir}`)
      return entry.url
    })
  }

  async listAtHead(url: string): Promise<SvnResult<string[]>> {
    const read = await this.run(process.cwd(), ['list', '--xml', '-r', 'HEAD', '--', `${url}@HEAD`])
    if (!read.ok) return read
    return this.attempt(async () => {
      const parsed = JsonShape.record(new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(read.value.stdout))
      const list = JsonShape.record(JsonShape.record(parsed?.lists)?.list)
      if (!list) throw new Error('svn list returned no list document')
      const entries = list.entry === undefined ? [] : Array.isArray(list.entry) ? list.entry : [list.entry]
      return entries.map((value) => {
        const name = JsonShape.record(value)?.name
        if (typeof name !== 'string') throw new Error('svn list returned an entry without a name')
        return name
      })
    })
  }

  async changedNames(dir: string): Promise<SvnResult<string[]>> {
    const status = await this.status(dir)
    if (!status.ok) return status
    return { ok: true, value: status.value.changed }
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

  async reservedCheck(location: { worktreePath: string; directoryId?: string; url: string }): Promise<SvnResult<{ workingCopy: boolean }>> {
    if (location.directoryId === undefined || await SvnWorktreeManager.directoryIdOf(location.worktreePath) !== location.directoryId)
      return { ok: false, code: 'refused', detail: 'The reserved checkout directory identity cannot be verified' }
    if (!existsSync(join(location.worktreePath, '.svn'))) return { ok: true, value: { workingCopy: false } }
    const info = await this.infoOf(location.worktreePath, '.')
    if (!info.ok) return info
    if (info.value.url !== location.url) return { ok: false, code: 'refused', detail: 'The partial checkout belongs to another repository URL' }
    return { ok: true, value: { workingCopy: true } }
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

  async removalStatus(worktreePath: string): Promise<SvnResult<SvnRemovalRow[]>> {
    return this.attempt(async () => {
      if (!await SvnWorktreeManager.removalPathExists(worktreePath)) return []
      if (!await SvnWorktreeManager.removalPathExists(join(worktreePath, '.svn')))
        return (await readdir(worktreePath)).map((path) => ({ path, kind: 'item' as const, conflict: false, ignored: false, unversioned: true as const }))
      const status = SvnWorktreeManager.must(await this.run(worktreePath, ['status', '--no-ignore', '--xml', '--', '.']))
      const rows = SvnWorktreeEvidence.statusRows(status.stdout, worktreePath)
      const verbose = SvnWorktreeEvidence.statusVerboseRows(status.stdout, worktreePath)
      return rows.map((row, index) => ({ ...row, ignored: verbose[index].item === 'ignored' }))
    })
  }

  /** Every local change, externals included: content, add, delete, unversioned, missing, properties. Ignored entries are excluded. */
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
      // An external below the worktree is its own working copy, updated to its own revision; a root above it is not read.
      const rootRevisions = new Map([[PathCompare.comparable(worktreePath), revision]])
      for (const [parent, members] of byParent) {
        const cwd = parent === '.' ? worktreePath : join(worktreePath, ...parent.split('/'))
        const depth = members.every((row) => row.path === '.') ? 'empty' : 'immediates'
        const entries = SvnConflictFacts.infoConflicts(SvnWorktreeManager.must(await this.run(cwd, ['info', '--xml', '--depth', depth, '--', '.'])).stdout)
        const values = members.some((row) => row.property) ? await this.propertyValues(cwd, entries, depth, baseRevision) : null
        for (const row of members) {
          const entry = entries.find((candidate) => candidate.name === SvnWorktreeManager.nameOf(row.path))
          if (entry === undefined) throw new Error(`svn info in ${parent} gave no entry for ${row.path}`)
          const wcRoot = entry.wcRoot !== null && PathCompare.isInside(worktreePath, entry.wcRoot) ? resolve(entry.wcRoot) : worktreePath
          const key = PathCompare.comparable(wcRoot)
          const rootRevision = rootRevisions.get(key) ?? SvnWorktreeManager.must(await this.revisionOf(wcRoot))
          rootRevisions.set(key, rootRevision)
          const kinds = row.tree ? ['tree' as const] : row.text && row.property ? ['text' as const, 'property' as const] : [row.text ? 'text' as const : 'property' as const]
          for (const kind of kinds) facts.push({ ...await this.factOf(worktreePath, cwd, row, entry, values, kind), rootRevision })
        }
      }
      return { revision, facts: await this.incomingMoves(worktreePath, baseRevision, revision, facts), rows,
        lockedPaths: SvnWorktreeEvidence.lockedPaths(status, worktreePath) }
    })
  }

  /**
   * svn calls an incoming move a delete on update. The other commits' log names the new place, which
   * keep-both carries the session's edit to; one that is not on disk after the update is no place.
   * A log svn cannot give leaves the facts as svn wrote them.
   */
  private async incomingMoves(worktreePath: string, baseRevision: number, revision: number, facts: SvnConflictFact[]): Promise<SvnConflictFact[]> {
    const candidates = facts.filter((fact) => fact.tree?.reason === 'edited' && fact.tree.action === 'deleted' && fact.tree.operation !== 'merge')
    const oldest = Math.min(...candidates.map((fact) => fact.tree?.baseRevision ?? baseRevision))
    if (revision <= oldest) return facts
    const info = await this.infoOf(worktreePath, '.')
    if (!info.ok || !SvnWorktreeEvidence.takesArgument(info.value.url)) return facts
    const log = await this.run(worktreePath, ['log', '-v', '--xml', '-r', `${oldest + 1}:${revision}`, '--', info.value.url])
    if (!log.ok) return facts
    return facts.map((fact) => {
      if (fact.tree === null || !candidates.includes(fact)) return fact
      const movedTo = SvnConflictFacts.incomingMoveOf(log.value.stdout, info.value.base, fact.path, fact.tree.baseRevision ?? baseRevision)
      return movedTo === null || !existsSync(join(worktreePath, ...movedTo.split('/'))) ? fact : { ...fact, tree: { ...fact.tree, movedTo } }
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
  async hashes(worktreePath: string, paths: readonly string[], complete = false): Promise<SvnResult<Record<string, string>>> {
    return this.attempt(async () => {
      const hashes: Record<string, string> = {}
      for (const path of paths) hashes[path] = await SvnWorktreeManager.contentHashOf(join(worktreePath, ...path.split('/')), complete, path === '.')
      return hashes
    })
  }

  async commitHashes(worktreePath: string, paths: readonly string[], depth: 'tree' | 'node' = 'tree'): Promise<SvnResult<Record<string, string>>> {
    if (depth === 'node') return this.nodeHashes(worktreePath, paths)
    if (depth !== 'tree') throw new Error(`Unknown hash depth: ${JSON.stringify(depth satisfies never)}`)
    return this.attempt(async () => {
      let mounts: string[] | undefined
      const proved = new Set<string>()
      const excluded = new Map<string, string[]>()
      const content: Record<string, string> = {}
      for (const path of paths) {
        const boundaries: string[] = []
        excluded.set(path, boundaries)
        const target = join(worktreePath, ...path.split('/'))
        content[path] = await SvnWorktreeManager.contentHashOf(target, true, path === '.', async (folder) => {
          mounts ??= SvnWorktreeManager.must(await this.mountRootsOf(worktreePath))
          const mount = mounts.find((candidate) => PathCompare.normalized(candidate) === PathCompare.normalized(folder))
          if (mount === undefined) return false
          if (!proved.has(mount)) {
            const actual = SvnWorktreeManager.must(await this.workingCopyRootOf(mount))
            if (PathCompare.comparable(actual) !== PathCompare.comparable(mount)) return false
            proved.add(mount)
          }
          if (PathCompare.normalized(mount) !== PathCompare.normalized(target))
            boundaries.push(relative(worktreePath, mount).replace(/\\/g, '/'))
          return true
        })
      }
      const properties = new Map<string, Map<string, string>>()
      for (const targets of SvnWorktreeManager.landingBatches(worktreePath, paths)) {
        const read = await this.svn.run(worktreePath, ['proplist', '--non-interactive', '--xml', '--verbose', '--depth', 'infinity', '--', ...targets])
        // Mixed versioned/unversioned targets return valid XML together with missing-target warnings.
        // Keep the successful targets; other failures must never turn reviewed properties into empty ones.
        const codes = read.stderr.match(/[EW]\d{6}/g) ?? []
        if (read.failure !== null || read.code !== 0 && (codes.length === 0 || codes.some((code) => !['W200005', 'W155010', 'E200009'].includes(code))))
          throw new SvnRunFailure(SvnFailures.failureOf(read).code, SvnFailures.failureOf(read).detail)
        for (const [name, values] of SvnConflictFacts.propertiesOf(read.stdout))
          if (values.size > 0) properties.set(SvnWorktreeEvidence.relativeTo(worktreePath, name), values)
      }
      for (const path of paths) {
        const missing = content[path] === 'missing'
        const values = [...properties].filter(([name]) => name === path || path === '.' || name.startsWith(`${path}/`))
          .filter(([name]) => !excluded.get(path)!.some((mount) => name === mount || name.startsWith(`${mount}/`)))
          .map(([name, props]) => [name === path ? '.' : path === '.' ? name : name.slice(path.length + 1), [...props].sort()]).sort()
        content[path] = createHash('sha256').update(content[path]).update(JSON.stringify(values)).digest('hex')
        if (missing) {
          const deleted = SvnWorktreeManager.must(await this.deletedDirectory(worktreePath, path))
          if (deleted !== null) content[path] = createHash('sha256').update(content[path]).update(JSON.stringify(deleted)).digest('hex')
        }
      }
      return content
    })
  }

  async publicationHashes(root: string, paths: readonly string[], revision: number): Promise<SvnResult<Record<string, string>>> {
    return this.nodeHashes(root, paths, revision)
  }

  private async nodeHashes(root: string, paths: readonly string[], revision?: number): Promise<SvnResult<Record<string, string>>> {
    return this.attempt(async () => {
      const result: Record<string, string> = {}
      const locations = revision === undefined ? undefined : await this.landingInfo(root, paths)
      const urls = new Map([...locations?.entries() ?? []].map(([path, info]) => [info.url, path]))
      const targetOf = (path: string): string => {
        if (revision === undefined) return `${path}@`
        const entry = locations?.get(path)
        if (entry === undefined) throw new Error(`No publication URL for ${path}`)
        return `${entry.url}@${revision}`
      }
      const properties = new Map<string, Map<string, string>>()
      const kinds = new Map<string, string>()
      for (const targets of SvnWorktreeManager.landingBatches(root, paths, targetOf)) {
        const props = await this.svn.run(root, ['proplist', '--non-interactive', '--xml', '--verbose', '--depth', 'empty',
          ...(revision === undefined ? [] : ['-r', String(revision)]), '--', ...targets])
        const codes = props.stderr.match(/[EW]\d{6}/g) ?? []
        if (props.failure !== null || props.code !== 0 && (revision !== undefined || codes.length === 0
          || codes.some((code) => !['W200005', 'W155010', 'E200009'].includes(code)))) throw new Error(props.stderr || 'Properties unavailable')
        for (const [name, values] of SvnConflictFacts.propertiesOf(props.stdout)) {
          const path = revision === undefined ? SvnWorktreeEvidence.relativeTo(root, name) : urls.get(name)
          if (path === undefined) throw new Error(`Unexpected publication properties: ${name}`)
          properties.set(path, values)
        }
        if (revision !== undefined) {
          const info = SvnWorktreeManager.must(await this.run(root, ['info', '--xml', '--depth', 'empty', '-r', String(revision), '--', ...targets]))
          for (const entry of SvnWorktreeEvidence.infoEntries(info.stdout)) {
            const path = urls.get(entry.url)
            if (path === undefined) throw new Error(`Unexpected publication URL: ${entry.url}`)
            kinds.set(path, entry.kind)
          }
        }
      }
      const published = revision === undefined ? undefined : await SvnNodeContent.exportedFiles(this.svn, root,
        paths.filter((path) => kinds.get(path) === 'file').map((path) => ({ path, url: locations!.get(path)!.url })), revision)
      for (const path of paths) {
        const file = resolve(root, path)
        if (!PathCompare.isInside(root, file) || !SvnWorktreeEvidence.takesArgument(path)) throw new Error(`Invalid publication path: ${path}`)
        let kind: string
        if (revision === undefined) {
          const disk = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
          if (disk?.isSymbolicLink()) throw new Error(`Cannot prove linked content: ${path}`)
          kind = disk === null ? 'missing' : disk.isDirectory() ? 'dir' : 'file'
        } else {
          const recorded = kinds.get(path)
          if (recorded === undefined) throw new Error(`No publication node for ${path}`)
          kind = recorded
        }
        const values = properties.get(path) ?? new Map<string, string>()
        const content = kind !== 'file' ? kind : published !== undefined ? published.get(path)
          : values.has('svn:keywords') || values.has('svn:eol-style')
            ? await SvnNodeContent.exported(this.svn, root, targetOf(path)) : await SvnNodeContent.hash(file)
        if (content === undefined) throw new Error(`No publication content for ${path}`)
        result[path] = `node:${createHash('sha256').update(JSON.stringify([content, [...values].sort()])).digest('hex')}`
      }
      return result
    })
  }

  private async deletedDirectory(root: string, path: string): Promise<SvnResult<SvnVerboseItem[] | null>> {
    return this.attempt(async () => {
      const info = await this.infoOf(root, `${path}@`)
      if (!info.ok) {
        if (/W155010|E155010|E200009/.test(info.detail)) return null
        throw new SvnRunFailure(info.code, info.detail)
      }
      if (info.value.kind !== 'dir') return null
      const read = SvnWorktreeManager.must(await this.run(root, ['status', '--xml', '--verbose', '--depth', 'infinity', '--', `${path}@`]))
      const rows = SvnWorktreeEvidence.statusVerboseRows(read.stdout, root).sort((a, b) => a.path.localeCompare(b.path))
      if (rows.length === 0 || rows.some((row) => row.item !== 'deleted' || (row.props !== 'none' && row.props !== 'normal'))
        || SvnWorktreeEvidence.statusRows(read.stdout, root).some((row) => row.conflict))
        throw new SvnRunFailure('refused', `Deleted setup directory has unproved descendant state: ${path}`)
      return rows
    })
  }

  async publicationRows(root: string, paths: readonly string[], revision: number): Promise<SvnResult<{ items: SvnVerboseItem[]; changed: SvnLoggedRow[] }>> {
    return this.attempt(async () => {
      const { items } = await this.landingStatus(root, paths)
      const location = SvnWorktreeManager.must(await this.infoOf(root, '.'))
      return { items, changed: await this.revisionLog({ path: root, own: '', changed: [] }, location, revision) }
    })
  }

  /**
   * Gives the selected nodes of a published commit the revision its client would have given them had
   * it not died first (UA1-J09-2). The caller passes only nodes whose bytes and properties equal that
   * revision, so svn changes metadata, not content: an edit merges as already there, a local addition
   * becomes the published node (svn takes the unversioned bytes as they are) and a deletion keeps any
   * bytes left on disk unversioned. Replaced or conflicted nodes, and an added directory holding added
   * nodes outside `paths`, whose scheduling a revert would drop, stay as they are for verification to name.
   */
  async advancePublished(root: string, paths: readonly string[], revision: number): Promise<SvnResult<void>> {
    return this.attempt(async () => {
      const { items, conflicts } = await this.landingStatus(root, paths)
      const behind = items.filter((row) => row.base < revision && !conflicts.has(row.path))
      const edited = behind.filter((row) => (row.item === 'modified' || row.item === 'normal') && row.base > 0).map((row) => row.path)
      const deleted = behind.filter((row) => row.item === 'deleted').map((row) => row.path)
      const selected = new Set(paths)
      const directories: string[] = []
      const held: string[] = []
      for (const row of behind.filter((row) => row.item === 'added')) {
        if (!await SvnWorktreeManager.isDirectory(resolve(root, row.path))) continue
        const read = SvnWorktreeManager.must(await this.run(root, ['status', '--xml', '--verbose', '--depth', 'infinity', '--', `${row.path}@`]))
        if (SvnWorktreeEvidence.statusVerboseRows(read.stdout, root).some((other) => other.item === 'added' && !selected.has(other.path))) held.push(row.path)
        else directories.push(row.path)
      }
      const depthOf = (path: string) => path.split('/').length
      const added = behind.filter((row) => row.item === 'added' && !held.some((path) => row.path === path || row.path.startsWith(`${path}/`)))
        .map((row) => row.path).sort((a, b) => depthOf(b) - depthOf(a))
      const at = ['-r', String(revision), '--accept', 'postpone']
      for (const batch of SvnWorktreeManager.landingBatches(root, edited))
        SvnWorktreeManager.must(await this.run(root, ['update', ...at, '--depth', 'empty', '--', ...batch]))
      for (const batch of SvnWorktreeManager.landingBatches(root, deleted)) {
        SvnWorktreeManager.must(await this.run(root, ['update', ...at, '--depth', 'empty', '--', ...batch]))
        // Deleted here and in the revision: the tree conflict svn reports is the deletion already done.
        SvnWorktreeManager.must(await this.run(root, ['resolve', '--accept', 'working', '--depth', 'empty', '--', ...batch]))
      }
      // Deepest first: a directory reverts only once nothing scheduled below it remains.
      for (const batch of SvnWorktreeManager.landingBatches(root, added))
        SvnWorktreeManager.must(await this.run(root, ['revert', '--depth', 'empty', '--', ...batch]))
      // Shallowest first, each directory at full depth, as the finished commit would have left it.
      const shallowest = [...added].reverse()
      for (const batch of SvnWorktreeManager.landingBatches(root, shallowest.filter((path) => directories.includes(path))))
        SvnWorktreeManager.must(await this.run(root, ['update', ...at, '--set-depth', 'infinity', '--force', '--', ...batch]))
      for (const batch of SvnWorktreeManager.landingBatches(root, shallowest.filter((path) => !directories.includes(path))))
        SvnWorktreeManager.must(await this.run(root, ['update', ...at, '--depth', 'empty', '--force', '--', ...batch]))
      const touched = [...edited, ...deleted, ...added]
      const left = touched.length === 0 ? [] : [...(await this.landingStatus(root, touched)).conflicts]
      if (left.length > 0) throw new SvnRunFailure('svn-failed', `Moving the published nodes to r${revision} left conflicts: ${left.join(', ')}`)
    })
  }

  /**
   * The stamp of the working copies a landing proof of `main` reads: the one that holds `main` and
   * each external mount the last proof found. Null before a proof found them, and outside a working copy.
   */
  async landingStamp(main: string): Promise<string | null> {
    const known = this.landingRoots.get(PathCompare.comparable(main))
    if (known === undefined) return null
    const root = await SvnWcStamp.rootOf(main)
    return root === null ? null : SvnWcStamp.of([root, ...known.roots.slice(1).map((entry) => entry.root)])
  }

  async landingPaths(main: string, landed: readonly SvnLandingReceipt[]): Promise<SvnResult<SvnLandingPath[]>> {
    return this.attempt(async () => {
      const roots = await this.landingRootsOf(main)
      const paths: SvnLandingPath[] = []
      for (const receipt of landed) {
        const rows = SvnWorktreeEvidence.loggedRows(await this.landingLogOf(main, receipt), '', '').map((row) => ({ ...row, repositoryPath: row.path === '.' ? '' : `/${row.path}` }))
        const receiptPaths = receipt.paths?.map((path) => path === '/' ? '' : path)
        const required = receiptPaths === undefined ? rows : rows.filter((row) => receiptPaths.some((path) => row.repositoryPath === path || row.repositoryPath.startsWith(path + '/')))
        if (required.length === 0 || receiptPaths?.some((path) => !required.some((row) => row.repositoryPath === path || row.repositoryPath.startsWith(path + '/'))))
          throw new SvnRunFailure('refused', `r${receipt.revision} does not prove every landed path`)
        for (const row of required) {
          const mapped = roots.filter(({ info }) => info.repository === receipt.repository
            && (row.repositoryPath === info.base || row.repositoryPath.startsWith(`${info.base}/`)))
            .map(({ root, info }) => ({ root, path: row.repositoryPath === info.base ? '.' : row.repositoryPath.slice(info.base.length + 1) }))
            .filter(({ root, path }) => !roots.some((other) => other.root !== root && PathCompare.isInside(root, other.root)
              && PathCompare.isInside(other.root, resolve(root, path))))
          if (mapped.length === 0) paths.push({ ...row, path: row.repositoryPath, repository: receipt.repository, root: null })
          else paths.push(...mapped.map((location) => ({ ...row, ...location, repository: receipt.repository })))
        }
      }
      return paths
    })
  }

  async landingProof(main: string, landed: readonly SvnLandingReceipt[]): Promise<SvnResult<SvnLandingProof>> {
    return this.attempt(async () => {
      const paths = SvnWorktreeManager.must(await this.landingPaths(main, landed))
      const statuses = new Map<string, { items: SvnVerboseItem[]; conflicts: Set<string>; missing: Set<string> }>()
      const locations = new Map<string, Map<string, SvnInfoEntry>>()
      for (const path of paths) {
        if (path.root === null) return { holds: false, reason: `${path.repositoryPath} has no matching working-copy URL` }
        const absolute = resolve(path.root, path.path)
        if (!PathCompare.isInside(path.root, absolute) || !SvnWorktreeEvidence.takesArgument(path.path))
          throw new SvnRunFailure('refused', `Cannot prove landed path ${path.path}`)
        let status = statuses.get(path.root)
        if (status === undefined) {
          const targets = paths.filter((entry) => entry.root === path.root).map((entry) => entry.path)
          status = { ...await this.landingStatus(path.root, targets), missing: await PathPresence.missing(path.root, targets) }
          statuses.set(path.root, status)
        }
        const { items, conflicts, missing } = status
        const row = items.find((item) => item.path === path.path)
        const shown = relative(main, absolute).replace(/\\/g, '/')
        if (conflicts.has(path.path)) return { holds: false, reason: `${path.path} still at r${row?.base ?? 0} (conflict)`, local: { path: shown, item: 'conflicted' } }
        if (!missing.has(path.path)) {
          if (row === undefined || !['normal', 'modified'].includes(row.item) || !['none', 'normal', 'modified'].includes(row.props) || row.base < path.revision)
            return { holds: false, reason: `${path.path} still at r${row?.base ?? 0} (${row?.item ?? 'unproved'})`, ...SvnWorktreeManager.localOf(shown, row?.item) }
          let entries = locations.get(path.root)
          if (entries === undefined) {
            entries = await this.landingInfo(path.root, items.filter((item) =>
              ['normal', 'modified'].includes(item.item) && ['none', 'normal', 'modified'].includes(item.props)
              && !conflicts.has(item.path)).map((item) => item.path))
            locations.set(path.root, entries)
          }
          const info = entries.get(path.path)
          if (info === undefined) throw new SvnRunFailure('svn-failed', `svn info gave no entry for ${path.path}`)
          if (info.repository !== path.repository || info.base !== path.repositoryPath)
            return { holds: false, reason: `${path.path} checks out a different repository path` }
          continue
        }
        if (row !== undefined && row.item !== 'none') return { holds: false, reason: `${path.path} is locally ${row.item}`, ...SvnWorktreeManager.localOf(shown, row.item) }
        let parent = dirname(absolute)
        let info: SvnInfoEntry | null = null
        while (PathCompare.isInside(path.root, parent)) {
          const read = await this.infoOf(path.root, relative(path.root, parent) || '.')
          if (read.ok) { info = read.value; break }
          if (!/E155010|W155010|E200009/.test(read.detail)) throw new SvnRunFailure(read.code, read.detail)
          if (parent === path.root) break
          parent = dirname(parent)
        }
        if (info === null || info.repository !== path.repository || info.revision < path.revision)
          return { holds: false, reason: `${path.path} has no current parent deletion proof` }
        const expected = `${info.base}/${relative(parent, absolute).replace(/\\/g, '/')}`
        if (expected !== path.repositoryPath) return { holds: false, reason: `${path.path} has a different parent URL` }
        const history = SvnWorktreeManager.must(await this.run(path.root, ['log', '-v', '--xml', '-r', `${path.revision}:${info.revision}`, '--', path.repository]))
        const last = SvnWorktreeEvidence.loggedRows(history.stdout, '', '').filter((entry) => `/${entry.path}` === path.repositoryPath
          || entry.action === 'D' && path.repositoryPath.startsWith(`/${entry.path}/`)).sort((left, right) => right.revision - left.revision)[0]
        if (last?.action !== 'D') return { holds: false, reason: `${path.path} is absent without a repository deletion proof` }
      }
      return { holds: true }
    })
  }

  /** The person's state of a landed path that an update leaves as it is; an update restores a missing or incomplete node. */
  private static localOf(path: string, item: SvnWcItem | undefined): { local?: SvnLandingLocal } {
    switch (item) {
      case undefined: case 'normal': case 'modified': case 'none': case 'missing': case 'incomplete': return {}
      case 'added': case 'conflicted': case 'deleted': case 'external': case 'ignored': case 'merged':
      case 'obstructed': case 'replaced': case 'unversioned': return { local: { path, item: item satisfies SvnLocalItem } }
      default: throw new Error(`Unknown working-copy item: ${JSON.stringify(item satisfies never)}`)
    }
  }

  private static landingBatches(root: string, paths: readonly string[], targetOf = (path: string) => `${path}@`): string[][] {
    const batches: string[][] = []
    let batch: string[] = []
    let characters = 0
    for (const path of new Set(paths)) {
      if (!PathCompare.isInside(root, resolve(root, path)) || !SvnWorktreeEvidence.takesArgument(path))
        throw new SvnRunFailure('refused', `Cannot prove landed path ${path}`)
      const target = targetOf(path)
      const size = 2 * target.length + 4
      if (size > SvnWorktreeManager.landingReadCharactersConst)
        throw new SvnRunFailure('refused', `Cannot prove landed path ${path}`)
      if (characters + size > SvnWorktreeManager.landingReadCharactersConst) {
        batches.push(batch)
        batch = []
        characters = 0
      }
      batch.push(target)
      characters += size
    }
    if (batch.length > 0) batches.push(batch)
    return batches
  }

  private async landingStatus(root: string, paths: readonly string[]): Promise<{ items: SvnVerboseItem[]; conflicts: Set<string> }> {
    const items: SvnVerboseItem[] = []
    const conflicts = new Set<string>()
    for (const targets of SvnWorktreeManager.landingBatches(root, paths)) {
      const status = SvnWorktreeManager.must(await this.run(root, ['status', '--xml', '--verbose', '--depth', 'empty', '--', ...targets]))
      items.push(...SvnWorktreeEvidence.statusVerboseRows(status.stdout, root))
      for (const row of SvnWorktreeEvidence.statusRows(status.stdout, root))
        if (row.conflict) conflicts.add(row.path)
    }
    return { items, conflicts }
  }

  /**
   * The main copy and its external mounts with their `svn info`, read again only when the stamp
   * moved: every result of one main copy and every later read share them. One `svn info` names all
   * roots; a root whose name svn cannot take as an argument is read from inside itself.
   */
  private async landingRootsOf(main: string): Promise<{ root: string; info: SvnInfoEntry }[]> {
    const key = PathCompare.comparable(main)
    // Taken before the reads, so a write while they run leaves the next stamp different.
    const stamp = await this.landingStamp(main)
    const known = this.landingRoots.get(key)
    if (known !== undefined && stamp !== null && known.stamp === stamp) return known.roots
    const all = [main, ...SvnWorktreeManager.must(await this.mountRootsOf(main))]
    const named = all.map((root) => SvnWorktreeEvidence.relativeTo(main, root)).filter((path) => SvnWorktreeEvidence.takesArgument(path))
    const entries = await this.landingInfo(main, named, [])
    const roots = await Promise.all(all.map(async (root) =>
      ({ root, info: entries.get(SvnWorktreeEvidence.relativeTo(main, root)) ?? SvnWorktreeManager.must(await this.infoOf(root, '.')) })))
    this.landingRoots.set(key, { stamp, roots })
    return roots
  }

  private async landingLogOf(main: string, receipt: SvnLandingReceipt): Promise<string> {
    const key = `${receipt.repository}\t${receipt.revision}`
    const known = this.landingLogs.get(key)
    if (known !== undefined) return known
    const log = SvnWorktreeManager.must(await this.run(main, ['log', '-v', '--xml', '-r', String(receipt.revision), '--', receipt.repository])).stdout
    this.landingLogs.set(key, log)
    return log
  }

  private async landingInfo(root: string, paths: readonly string[], depth: readonly string[] = ['--depth', 'empty']): Promise<Map<string, SvnInfoEntry>> {
    const entries = new Map<string, SvnInfoEntry>()
    for (const targets of SvnWorktreeManager.landingBatches(root, paths)) {
      const info = SvnWorktreeManager.must(await this.run(root, ['info', '--xml', ...depth, '--', ...targets]))
      for (const entry of SvnWorktreeEvidence.infoEntries(info.stdout))
        entries.set(SvnWorktreeEvidence.relativeTo(root, entry.path), entry)
    }
    return entries
  }

  async saveLocalPaths(root: string, paths: readonly string[], savedDirectory: string): Promise<SvnResult<string>> {
    return this.attempt(async () => {
      await mkdir(savedDirectory, { recursive: true })
      const folder = await mkdtemp(join(savedDirectory, 'overlap-'))
      for (const path of [...new Set(paths)]) {
        const file = resolve(root, path)
        if (!PathCompare.isInside(root, file) || !SvnWorktreeEvidence.takesArgument(path)) throw new SvnRunFailure('refused', `Cannot save ${path}`)
        for (let parent = dirname(file); PathCompare.isInside(root, parent); parent = dirname(parent)) {
          if ((await lstat(parent)).isSymbolicLink()) throw new SvnRunFailure('refused', `Overlap crosses a link: ${path}`)
          if (PathCompare.comparable(parent) === PathCompare.comparable(root)) break
        }
        const info = await lstat(file).catch((error: unknown) => { if (ErrnoCode.of(error) === 'ENOENT') return null; throw error })
        const saved = await mkdtemp(join(folder, 'path-'))
        const properties = await this.run(root, ['proplist', '--xml', '--verbose', '--depth', 'empty', '--', `${path}@`])
        if (!properties.ok && !/W200005|W155010|E200009/.test(properties.detail)) throw new SvnRunFailure(properties.code, properties.detail)
        const status = SvnWorktreeManager.must(await this.run(root, ['status', '--xml', '--verbose', '--depth', 'empty', '--', `${path}@`]))
        const link = info?.isSymbolicLink() ? await readlink(file) : undefined
        const row = SvnWorktreeEvidence.statusVerboseRows(status.stdout, root).find((entry) => entry.path === path)
        if (info?.isDirectory() && (row?.item === 'added' || row?.item === 'replaced' || row?.item === 'unversioned')) await SvnSetupDirectory.save(file, saved)
        else if (info?.isFile() && link === undefined) await copyFile(file, join(saved, 'working'), constants.COPYFILE_EXCL)
        await writeFile(join(saved, 'state.json'), JSON.stringify({ root, path, missing: info === null, link,
          properties: properties.ok ? properties.value.stdout : null, status: status.stdout }), { flag: 'wx' })
      }
      return folder
    })
  }

  async revertSetup(worktreePath: string, paths: readonly string[], baseline: Readonly<Record<string, string>>, savedDirectory: string): Promise<SvnResult<void>> {
    return this.attempt(async () => {
      const propertyValues = (xml: string) => JSON.stringify([...SvnConflictFacts.propertiesOf(xml)].map(([name, props]) => [name, [...props].sort()]).sort())
      const directories: Array<{ path: string; file: string; item: string; properties: string; saved: string }> = []
      for (const path of [...paths].sort((a, b) => a.split('/').length - b.split('/').length)) {
        const file = resolve(worktreePath, ...path.split('/'))
        if (!PathCompare.isInside(worktreePath, file) || !SvnWorktreeEvidence.takesArgument(path))
          throw new SvnRunFailure('refused', `Setup path cannot be safely addressed: ${path}`)
        for (let ancestor = dirname(file); PathCompare.isInside(worktreePath, ancestor); ancestor = dirname(ancestor)) {
          if ((await lstat(ancestor)).isSymbolicLink()) throw new SvnRunFailure('refused', `Setup path crosses a link: ${path}`)
          if (PathCompare.comparable(ancestor) === PathCompare.comparable(worktreePath)) break
        }
        const info = await lstat(file).catch((error: unknown) => {
          if (ErrnoCode.of(error) === 'ENOENT') return null
          throw error
        })
        if (info?.isSymbolicLink()) continue
        const missingKind = info === null ? SvnWorktreeManager.must(await this.infoOf(worktreePath, `${path}@`)).kind : undefined
        const deleted = missingKind === 'dir' ? SvnWorktreeManager.must(await this.deletedDirectory(worktreePath, path)) : null
        const depth = baseline[path]?.startsWith('node:') ? 'node' : 'tree'
        const current = SvnWorktreeManager.must(await this.commitHashes(worktreePath, [path], depth))
        if (current[path] !== baseline[path]) continue
        const status = SvnWorktreeManager.must(await this.run(worktreePath, ['status', '--xml', '--depth', 'empty', '--', `${path}@`]))
        if (SvnWorktreeEvidence.statusRows(status.stdout, worktreePath).some((row) => row.conflict))
          throw new SvnRunFailure('refused', `Setup path is conflicted: ${path}`)
        const row = SvnWorktreeEvidence.statusVerboseRows(status.stdout, worktreePath).find((entry) => entry.path === path)
        if (row === undefined) continue
        const properties = await this.run(worktreePath, ['proplist', '--xml', '--verbose', '--depth', 'empty', '--', `${path}@`])
        if (!properties.ok && !/W200005|W155010|E200009/.test(properties.detail)) throw new SvnRunFailure(properties.code, properties.detail)
        await mkdir(savedDirectory, { recursive: true })
        const saved = await mkdtemp(join(savedDirectory, 'path-'))
        if (info?.isDirectory()) {
          await writeFile(join(saved, 'state.json'), JSON.stringify({ path, item: row.item, properties: properties.ok ? properties.value.stdout : null }), { flag: 'wx' })
          directories.push({ path, file, item: row.item, properties: propertyValues(properties.ok ? properties.value.stdout : '<properties/>'), saved })
          continue
        }
        if (info !== null) await copyFile(file, join(saved, 'working'), constants.COPYFILE_EXCL)
        await writeFile(join(saved, 'state.json'), JSON.stringify({ path, item: row.item, missing: info === null,
          missingKind, deleted, properties: properties.ok ? properties.value.stdout : null }, null, 2), { flag: 'wx' })
        const checked = SvnWorktreeManager.must(await this.commitHashes(worktreePath, [path], depth))
        if (checked[path] !== baseline[path]) continue
        if (info !== null && await SvnWorktreeManager.contentHashOf(join(saved, 'working')) !== await SvnWorktreeManager.contentHashOf(file)) continue
        if (deleted !== null) {
          const preserved: string[] = []
          for (const entry of [...deleted].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
            const target = resolve(worktreePath, entry.path)
            if (!PathCompare.isInside(file, target)) throw new SvnRunFailure('refused', `Deleted setup entry escapes its directory: ${entry.path}`)
            if (preserved.some((parent) => PathCompare.isInside(parent, target))) continue
            const present = await lstat(target).catch((error: unknown) => { if (ErrnoCode.of(error) === 'ENOENT') return null; throw error })
            if (present !== null) { preserved.push(target); continue }
            const fresh = SvnWorktreeManager.must(await this.run(worktreePath, ['status', '--xml', '--verbose', '--depth', 'empty', '--', `${entry.path}@`]))
            const latest = SvnWorktreeEvidence.statusVerboseRows(fresh.stdout, worktreePath).find((row) => row.path === entry.path)
            if (JSON.stringify(latest) !== JSON.stringify(entry)) { preserved.push(target); continue }
            SvnWorktreeManager.must(await this.run(worktreePath, ['revert', '--depth', 'empty', '--', `${entry.path}@`]))
          }
          continue
        }
        if (row.item !== 'unversioned')
          SvnWorktreeManager.must(await this.run(worktreePath, ['revert', '--depth', 'empty', '--', `${path}@`]))
        if (row.item === 'unversioned' || row.item === 'added') {
          if (await SvnWorktreeManager.contentHashOf(file) !== await SvnWorktreeManager.contentHashOf(join(saved, 'working')))
            throw new SvnRunFailure('refused', `Setup path changed during its revert and was kept: ${path}`)
          await unlink(file)
        }
      }
      for (const directory of directories.sort((a, b) => b.path.length - a.path.length)) {
        const { path, file, item, saved } = directory
        const properties = await this.run(worktreePath, ['proplist', '--xml', '--verbose', '--depth', 'empty', '--', `${path}@`])
        if (!properties.ok && !/W200005|W155010|E200009/.test(properties.detail)) throw new SvnRunFailure(properties.code, properties.detail)
        if (propertyValues(properties.ok ? properties.value.stdout : '<properties/>') !== directory.properties) continue
        if (item === 'unversioned') {
          if (baseline[path]?.startsWith('node:')) continue
          const current = SvnWorktreeManager.must(await this.commitHashes(worktreePath, [path]))
          if (current[path] !== baseline[path]) continue
          const copied = await SvnSetupDirectory.save(file, saved)
          const checked = SvnWorktreeManager.must(await this.commitHashes(worktreePath, [path]))
          if (checked[path] !== baseline[path]) continue
          await SvnSetupDirectory.remove(file, copied)
        }
        else if (item === 'added') {
          if ((await readdir(file)).length !== 0) continue
          SvnWorktreeManager.must(await this.run(worktreePath, ['revert', '--depth', 'empty', '--', `${path}@`]))
          await rmdir(file)
        }
        else if (item === 'normal' || item === 'modified')
          SvnWorktreeManager.must(await this.run(worktreePath, ['revert', '--depth', 'empty', '--', `${path}@`]))
        else continue
      }
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

  private static async contentHashOf(path: string, complete = false, rootMetadata = false,
    external?: (folder: string) => Promise<boolean>): Promise<string> {
    const info = await lstat(path).catch((error: unknown) => { if (!complete || ErrnoCode.of(error) === 'ENOENT') return null; throw error })
    if (info === null) return 'missing'
    if (complete && info.isSymbolicLink()) throw new Error(`Cannot prove a setup link: ${path}`)
    if (!info.isDirectory()) return createHash('sha256').update(await readFile(path)).digest('hex')
    const hash = createHash('sha256')
    let files = 0
    let bytes = 0
    const walk = async (folder: string, prefix: string): Promise<void> => {
      const entries = await readdir(folder, { withFileTypes: true })
      if (complete && entries.some((entry) => entry.name === '.svn') && !(rootMetadata && prefix === '')) {
        if (await external?.(folder)) {
          if (prefix !== '') {
            hash.update(`external:${prefix}\n`)
            return
          }
        }
        else throw new Error(`Cannot prove a directory containing nested SVN metadata: ${path}`)
      }
      for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (entry.name === '.svn') continue
        if (files >= SvnWorktreeManager.folderFilesMaxConst) {
          if (complete) throw new Error(`Cannot prove the complete directory hash of ${path}: more than ${SvnWorktreeManager.folderFilesMaxConst} files`)
          continue
        }
        const full = join(folder, entry.name)
        if (complete && entry.isSymbolicLink()) throw new Error(`Cannot prove a directory containing a link: ${full}`)
        if (complete && entry.isDirectory()) hash.update(`directory:${prefix}${entry.name}\n`)
        if (entry.isDirectory()) await walk(full, `${prefix}${entry.name}/`)
        else {
          files += 1
          if (complete) {
            bytes += (await lstat(full)).size
            if (bytes > SvnSetupDirectory.maximumBytes) throw new Error('Setup preservation exceeds 500 MB')
          }
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

  async logSince(root: string, revision: number): Promise<SvnResult<SvnCommitHistory[]>> {
    const head = await this.headRevisionOf(root)
    if (!head.ok) return head
    if (head.value <= revision) return { ok: true, value: [] }
    const read = await this.run(root, ['log', '--xml', '-v', '-r', `${revision + 1}:${head.value}`, '--', '.'])
    if (!read.ok) return read
    return this.attempt(async () => {
      const parsed = JsonShape.record(new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false }).parse(read.value.stdout))
      if (parsed?.log === undefined) throw new Error('svn log returned no log document')
      const entries = JsonShape.record(parsed.log)?.logentry
      return (entries === undefined ? [] : Array.isArray(entries) ? entries : [entries]).map((value): SvnCommitHistory => {
        const entry = JsonShape.record(value)
        const revision = Number(entry?.['@_revision'])
        const date = Date.parse(String(entry?.date ?? ''))
        if (!Number.isSafeInteger(revision) || revision <= 0 || !Number.isFinite(date)) throw new Error('svn log returned invalid commit evidence')
        const paths = JsonShape.record(entry?.paths)?.path
        return { revision, date, author: typeof entry?.author === 'string' ? entry.author : null,
          message: String(entry?.msg ?? ''), paths: (paths === undefined ? [] : Array.isArray(paths) ? paths : [paths])
            .map((path) => String(JsonShape.record(path)?.['#text'] ?? path)) }
      })
    })
  }

  /** Whether an svn process holds the working copy, or one that died left it for `svn cleanup`. */
  async locked(worktreePath: string): Promise<boolean> {
    const status = await this.run(worktreePath, ['status', '--xml', '--', '.'])
    if (!status.ok) return status.code === 'locked'
    try { return SvnWorktreeEvidence.lockedPaths(status.value.stdout, worktreePath).length > 0 }
    catch { return false }
  }

  async unprepareCommit(scope: string, added: readonly string[]): Promise<SvnResult<void>> {
    for (const path of [...added].sort((left, right) => right.length - left.length)) {
      if (!PathCompare.isInside(scope, path)) return { ok: false, code: 'refused', detail: 'Prepared paths must stay in their commit scope' }
      const name = relative(scope, path).replace(/\\/g, '/') || '.'
      if (!SvnWorktreeEvidence.takesArgument(name)) return { ok: false, code: 'refused', detail: `SVN cannot safely address ${name}` }
      const status = await this.run(scope, ['status', '--xml', '--depth', 'empty', '--', `${name}@`])
      if (!status.ok) return status
      if (!SvnWorktreeEvidence.statusVerboseRows(status.value.stdout, scope).some((row) => row.path === name && row.item === 'added')) continue
      const reverted = await this.run(scope, ['revert', '--depth', 'empty', '--', `${name}@`])
      if (!reverted.ok) return reverted
    }
    return { ok: true, value: undefined }
  }

  async prepareCommit(scope: string, selection: readonly string[], beforeAdd?: (paths: string[]) => Promise<void>, normalizeText = false): Promise<SvnResult<{ targets: string[]; added: string[] }>> {
    const targets: SvnCommitTarget[] = []
    const names = selection.map((path) => relative(scope, path).replace(/\\/g, '/') || '.')
    const snapshot = await this.attempt(() => this.landingStatus(scope, names))
    if (!snapshot.ok) return snapshot
    const rows = new Map(snapshot.value.items.map((row) => [row.path, row]))
    for (const path of selection) {
      if (!PathCompare.isInside(scope, path) || /[\r\n\0]/.test(path))
        return { ok: false, code: 'refused', detail: 'Select paths inside the commit scope' }
      const name = relative(scope, path).replace(/\\/g, '/') || '.'
      if (!SvnWorktreeEvidence.takesArgument(name))
        return { ok: false, code: 'refused', detail: `SVN cannot safely address ${name}` }
      const row = rows.get(name)
      const conflict = snapshot.value.conflicts.has(name)
      const item = row?.item ?? 'unversioned'
      let status: SvnCommitTarget['status']
      if (conflict || row?.props === 'conflicted') status = 'conflicted'
      else switch (item) {
        case 'added': case 'deleted': case 'missing': case 'modified': case 'replaced': case 'conflicted': case 'obstructed': status = item; break
        case 'unversioned': status = 'untracked'; break
        case 'normal': case 'none': case 'merged':
          if (row?.props !== 'modified') continue
          status = 'modified'
          break
        case 'external': case 'ignored': case 'incomplete':
          return { ok: false, code: 'refused', detail: `Cannot commit ${item} path ${name}` }
        default: throw new Error(`Unknown SVN status: ${JSON.stringify(item satisfies never)}`)
      }
      const info = await lstat(path).catch((error: unknown) => {
        if (ErrnoCode.of(error) === 'ENOENT') return null
        throw error
      })
      const nodeKind: SvnCommitTarget['nodeKind'] = info?.isDirectory() ? 'directory' : 'file'
      targets.push({ absolutePath: resolve(path), status, nodeKind })
    }
    const prepared = await new SvnCommitManager(this.svn).prepare(scope, targets, undefined, beforeAdd)
    if (!prepared.ok || !normalizeText) return prepared
    return this.attempt(async () => {
      // SVN rewrites working-file EOLs at commit. Materialize that translation before tests.
      const existing = targets.filter((target) => target.status !== 'deleted' && target.status !== 'missing')
        .map((target) => relative(scope, target.absolutePath).replace(/\\/g, '/') || '.')
      for (const batch of SvnWorktreeManager.landingBatches(scope, existing)) {
        const read = SvnWorktreeManager.must(await this.run(scope, ['proplist', '--xml', '--verbose', '--depth', 'empty', '--', ...batch]))
        for (const [name, props] of SvnConflictFacts.propertiesOf(read.stdout)) {
          const style = props.get('svn:eol-style')
          if (style === undefined) continue
          const path = resolve(scope, name)
          if (!PathCompare.isInside(scope, path)) throw new Error(`SVN property target leaves the worktree: ${name}`)
          const disk = await lstat(path)
          if (!disk.isFile() || disk.isSymbolicLink()) throw new Error(`Cannot normalize linked or non-file source: ${name}`)
          let newline: string
          switch (style) {
            case 'native': newline = process.platform === 'win32' ? '\r\n' : '\n'; break
            case 'LF': newline = '\n'; break
            case 'CRLF': newline = '\r\n'; break
            case 'CR': newline = '\r'; break
            default: throw new Error(`Unsupported svn:eol-style on ${name}: ${style}`)
          }
          const bytes = await readFile(path)
          if (bytes.includes(0)) throw new Error(`Binary source has svn:eol-style: ${name}`)
          const normalized = Buffer.from(bytes.toString('latin1').replace(/\r\n|\r|\n/g, newline), 'latin1')
          if (!bytes.equals(normalized)) await writeFile(path, normalized)
        }
      }
      return prepared.value
    })
  }

  async headRevisionOf(path: string): Promise<SvnResult<number>> {
    const info = await this.run(path, ['info', '--xml', '-r', 'HEAD', '--', '.'])
    if (!info.ok) return info
    const revision = SvnFailures.infoRevisionOf(info.value.stdout)
    return revision === null ? { ok: false, code: 'svn-failed', detail: 'svn info returned no HEAD revision' } : { ok: true, value: revision }
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
   * How many revisions of its own repository changed each root of the main copy `path` after that
   * root's revision: the main copy first, then every external mount by path. A pinned mount is left
   * out, because an update never moves it.
   */
  async behind(path: string): Promise<SvnResult<SvnBehindRoot[]>> {
    const roots = await this.reviewRoots(path)
    if (!roots.ok) return roots
    const behind: SvnBehindRoot[] = []
    for (const root of roots.value.filter((root) => !root.pinned).sort((a, b) => a.own.localeCompare(b.own))) {
      const count = await this.behindOf(root.path)
      if (!count.ok) return count
      behind.push({ own: root.own, behind: count.value })
    }
    return { ok: true, value: behind }
  }

  /**
   * Whether an update of the worktree would take nothing in: every root, the worktree and each
   * unpinned mount, sits wholly at one BASE, and `svn log` names no commit below it after that BASE.
   * False when anything cannot be proven so (a mixed BASE, a file external, a property change, a
   * mount missing on disk); the caller then updates as before. A pinned mount never moves, and a
   * change of its definition is a commit below its carrier, so its own history is not read.
   */
  async unmoved(worktreePath: string): Promise<SvnResult<boolean>> {
    return this.attempt(async () => {
      const rows = SvnWorktreeManager.must(await this.statusOf(worktreePath))
      for (const row of rows.filter((entry) => entry.kind === 'external'))
        if (!await SvnWorktreeManager.isDirectory(join(worktreePath, ...row.path.split('/')))) return false
      const roots = SvnWorktreeManager.must(await this.reviewRootsOf(worktreePath, rows))
      // The worktree first: a commit below it is the likeliest, and the first one found ends the read.
      for (const root of [...roots].sort((a, b) => (a.own === '' ? 0 : 1) - (b.own === '' ? 0 : 1))) {
        const base = SvnWorktreeManager.must(await this.infoOf(root.path, '.')).revision
        const status = SvnWorktreeManager.must(await this.run(root.path, ['status', '-v', '--xml', '--ignore-externals', '--', '.'])).stdout
        if (SvnWorktreeEvidence.updateProblems(status, root.path, base).length > 0 || SvnWorktreeEvidence.fileExternals(status)
          || SvnWorktreeEvidence.statusVerboseRows(status, root.path).some((item) => item.props === 'modified' || item.props === 'conflicted')) return false
        if (root.pinned) continue
        const behind = SvnWorktreeManager.must(await this.behindOf(root.path))
        if (behind > 0) return false
      }
      return true
    })
  }

  /** From `svn log -q`; svn answers E160006 when the root revision is HEAD already, which is none behind. */
  private async behindOf(path: string): Promise<SvnResult<number>> {
    const root = await this.infoOf(path, '.')
    if (!root.ok) return root
    const log = await this.run(path, ['log', '-q', '--xml', '-r', `${root.value.revision + 1}:HEAD`, '--', '.'])
    if (!log.ok) return /E160006/.test(log.detail) ? { ok: true, value: 0 } : log
    return { ok: true, value: (log.value.stdout.match(/<logentry\b/g) ?? []).length }
  }

  /** Every root with its changes, mounts first, and whether a mount is pinned to a revision. */
  async reviewRoots(worktreePath: string): Promise<SvnResult<SvnReviewRoot[]>> {
    const rows = await this.statusOf(worktreePath)
    return rows.ok ? this.reviewRootsOf(worktreePath, rows.value) : rows
  }

  private async reviewRootsOf(worktreePath: string, rows: readonly SvnStatusRow[]): Promise<SvnResult<SvnReviewRoot[]>> {
    const roots = await SvnWorktreeManager.rootsOf(worktreePath, rows)
    if (roots.length === 1) return { ok: true, value: roots.map((root) => ({ ...root, pinned: false })) }
    try {
      const pinned = new Set<string>()
      for (const carrier of roots.filter((root) => roots.some((other) => other.path !== root.path && PathCompare.isInside(root.path, other.path)))) {
        const properties = await this.run(carrier.path, ['propget', 'svn:externals', '-R', '--xml', '--', '.'])
        if (!properties.ok) return properties
        for (const path of SvnWorktreeEvidence.pinnedExternals(properties.value.stdout, carrier.path))
          pinned.add(relative(worktreePath, resolve(carrier.path, path)).replace(/\\/g, '/'))
      }
      return { ok: true, value: roots.map((root) => ({ ...root, pinned: root.own !== '' && pinned.has(root.own) })) }
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

  async removalSource(location: SvnWorktreeLocation): Promise<SvnResult<{ path: string; aside: boolean; present: boolean; directoryId?: string }>> {
    const aside = `${location.worktreePath}${SvnWorktreeManager.asideSuffixConst}`
    if (await SvnWorktreeManager.removalPathExists(aside)) {
      if (await SvnWorktreeManager.removalPathExists(location.worktreePath)) return { ok: false, code: 'refused', detail: 'Both the worktree and its removal remainder exist; keep both for inspection' }
      if (location.directoryId === undefined || await SvnWorktreeManager.directoryIdOf(aside) !== location.directoryId)
        return { ok: false, code: 'refused', detail: `${aside} cannot be proved to be this worktree; it is kept` }
      return { ok: true, value: { path: aside, aside: true, present: true } }
    }
    const present = await SvnWorktreeManager.removalPathExists(location.worktreePath)
    const problem = present ? await this.identityProblem(location) : null
    return problem === null ? { ok: true, value: { path: location.worktreePath, aside: false, present,
      ...present ? { directoryId: await SvnWorktreeManager.directoryIdOf(location.worktreePath) ?? undefined } : {} } }
      : { ok: false, code: 'refused', detail: problem }
  }

  private static async removalPathExists(path: string): Promise<boolean> {
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`Removal cannot follow a linked directory: ${path}`)
      return true
    } catch (error) {
      if (ErrnoCode.of(error) === 'ENOENT') return false
      throw error
    }
  }

  /**
   * Renames the worktree to `<name>.deleting` before anything is deleted: Windows refuses that rename
   * while a process has its working directory or an open file inside, so a session still running
   * there keeps a whole worktree instead of losing half of it. The directory must be the one the
   * session created (its file ID, else its URL); a reused name never lets one owner delete another's.
   */
  async renameAside(location: SvnWorktreeLocation): Promise<SvnResult<'renamed' | 'in-use' | 'absent' | { blocked: 'EPERM' | 'EBUSY' | 'EACCES'; path: string; detail: string }>> {
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
    // A worker stopped a moment ago still holds the folder while its process tree exits (Mirabia 117,
    // 2026-10-30: EPERM right after the stop, the same rename passed seconds later).
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(worktreePath, aside)
        return { ok: true, value: 'renamed' }
      }
      catch (error) {
        const code = ErrnoCode.of(error)
        if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
          if (attempt < SvnWorktreeManager.renameAttemptsConst) { await setTimeout(SvnWorktreeManager.renameDelayMillisecondsConst); continue }
          return { ok: true, value: { blocked: code, path: worktreePath, detail: ErrorText.of(error) } }
        }
        if (code === 'ENOENT') return { ok: true, value: 'absent' }
        return { ok: false, code: 'io-failed', detail: `Cannot rename ${worktreePath} aside: ${ErrorText.of(error)}` }
      }
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

  /** One kind svn marks on the row: a text fact names the text sidecars, a property fact the `.prej` and the conflicted properties. */
  private async factOf(worktreePath: string, cwd: string, row: SvnConflictedRow, entry: SvnInfoConflicts,
    values: SvnPropertyValues | null, kind: SvnConflictFact['kind']): Promise<SvnConflictFact> {
    const name = SvnWorktreeManager.nameOf(row.path)
    const takesArgument = SvnWorktreeEvidence.takesArgument(row.path)
    const text = kind === 'property' ? [] : [entry.sidecars.older, entry.sidecars.mine, entry.sidecars.theirs]
    const prej = kind === 'text' ? [] : SvnConflictFacts.prejOf(entry, cwd, entry.sidecars.prej === null && entry.property ? await readdir(cwd) : [])
    const sidecars = [...text, ...prej].flatMap((path) => path === null ? [] : [SvnWorktreeEvidence.relativeTo(worktreePath, path)])
    const properties = values === null || !row.property || kind === 'text' ? []
      : SvnConflictFacts.conflictedProperties(values.older.get(name) ?? new Map(), values.mine.get(name) ?? new Map(), values.theirs.get(name) ?? new Map())
    const local = join(cwd, name)
    let content: SvnContentFacts | null = null
    if (kind === 'text')
      content = SvnConflictFacts.contentOf(await SvnWorktreeManager.bytesOf(entry.sidecars.mine ?? local), await SvnWorktreeManager.bytesOf(entry.sidecars.theirs),
        await SvnWorktreeManager.bytesOf(entry.sidecars.older))
    else if (kind === 'tree' && entry.tree?.action === 'added' && entry.tree.operation !== 'merge' && takesArgument)
      content = entry.tree.incomingKind === 'dir' ? await this.directoryContent(cwd, name)
        : await SvnWorktreeManager.fileContent(local, entry.checksum)
    return { path: row.path, kind, takesArgument, tree: entry.tree, sidecars, properties, content }
  }

  /** The properties of the conflicted parent and its children before the update, in the working copy and in the new BASE. */
  private async propertyValues(cwd: string, entries: readonly SvnInfoConflicts[], depth: string, baseRevision: number): Promise<SvnPropertyValues> {
    const merged = entries.filter((entry) => entry.propertySources !== null)
    if (merged.length > 0) {
      const mine = SvnConflictFacts.propertiesOf(SvnWorktreeManager.must(await this.run(cwd, ['proplist', '-v', '--xml', '--depth', depth, '--', '.'])).stdout)
      const older = new Map<string, Map<string, string>>()
      const theirs = new Map<string, Map<string, string>>()
      for (const entry of entries.filter((candidate) => candidate.property)) {
        if (entry.propertySources === null) throw new Error('Mixed update and merge property conflicts need separate resolution')
        for (const [side, values] of [['older', older], ['theirs', theirs]] as const) {
          const source = entry.propertySources[side]
          if (source === null) { values.set(entry.name, new Map()); continue }
          if (!SvnWorktreeEvidence.takesArgument(source.url)) throw new Error(`Cannot read conflict source ${source.url}`)
          const read = SvnWorktreeManager.must(await this.run(cwd, ['proplist', '-v', '--xml', '--depth', 'empty', '-r', String(source.revision), '--', `${source.url}@${source.revision}`]))
          values.set(entry.name, SvnConflictFacts.propertiesOf(read.stdout, source.url).get('.') ?? new Map())
        }
      }
      return { older, mine, theirs }
    }
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
    return { ok: false, ...SvnFailures.failureOf(outcome) }
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
