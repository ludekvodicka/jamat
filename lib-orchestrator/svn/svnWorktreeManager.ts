import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { CommandOutcome, CommandRunner } from '../shared/commandInvoker.types'
import { ErrnoCode } from '../shared/errnoCode'
import { ErrorText } from '../shared/errorText'
import { PathCompare } from '../shared/pathCompare'
import { ProductGroup } from '../shared/productGroup'
import { Slug } from '../shared/slug'
import type {
  SvnBounds,
  SvnCheckout,
  SvnErrorCode,
  SvnInfoEntry,
  SvnLoggedRow,
  SvnMainUpdate,
  SvnResult,
  SvnRoot,
  SvnRootBounds,
  SvnStatusRow,
  SvnUnlanded,
  SvnVerboseItem,
  SvnWorktreeFacts,
  SvnWorktreeLocation,
  SvnWorktreeUpdate,
} from './svn.types'
import { SvnWorktreeEvidence } from './svnWorktreeEvidence'

/** A failed svn run thrown out of an evidence callback, so its code survives the evidence function. */
class SvnRunFailure extends Error {
  readonly code: SvnErrorCode

  constructor(code: SvnErrorCode, detail: string) {
    super(detail)
    this.code = code
  }
}

/**
 * Every SVN and disk write of an SVN worktree, and the reads a finish proves its work with: the
 * TypeScript twin of the `worktree-*` commands of the agent_extensions bash helper, which shares no
 * code with it (`docs/architecture/svn-worktrees.md`).
 *
 * svn.exe reads its arguments in the ANSI code page and maps a character outside it to a look-alike,
 * which names another file without an error. Every command therefore runs with its working directory
 * at the working copy and takes only relative names `SvnWorktreeEvidence.takesArgument` accepts; a
 * name it refuses is reported, never passed.
 */
export class SvnWorktreeManager {
  static readonly worktreesDirConst = '.worktrees'
  private static readonly asideSuffixConst = '.deleting'
  /** svn holds a working-copy lock (E155004) while another client, a pp helper say, updates the same main copy. */
  private static readonly lockRetryDelaysConst: readonly number[] = [1000, 2000, 2000]
  /** Windows refuses a command line beyond 32767 characters; the rest is headroom for the fixed arguments. */
  private static readonly argumentBudgetConst = 8000
  private readonly svn: CommandRunner
  /** Creates under way per owner: `.worktrees` stays while one runs, or its reservation loses its parent. */
  private readonly creating = new Map<string, number>()
  /** The removal of an empty `.worktrees` per owner, which a create waits out before it makes the directory. */
  private readonly removing = new Map<string, Promise<void>>()

  constructor(svn: CommandRunner) {
    this.svn = svn
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
    const info = await this.run(ownerDir, ['info', '--xml', '--', '.'])
    if (!info.ok) {
      if (info.code === 'svn-missing') return `svn is not installed: ${info.detail}`
      if (info.code === 'not-a-working-copy') return `checkpoints mode makes SVN worktrees and ${ownerDir} is in no SVN working copy`
      return `${ownerDir} is not a versioned SVN directory: ${info.detail}`
    }
    const wcRoot = /<wcroot-abspath>([^<]*)<\/wcroot-abspath>/.exec(info.value.stdout)?.[1]
      ?.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name] ?? '')
    if (wcRoot !== undefined && PathCompare.comparable(wcRoot) === PathCompare.comparable(ownerDir) && input.holdsOtherProject(ownerDir))
      return `${ownerDir} is a working-copy root that holds other projects, not a project`
    return null
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
   * A fresh checkout of the owner's URL at HEAD in `<owner>/.worktrees/<folder>`, or the first free
   * `<folder>-2`, `<folder>-3`; a name with a `.deleting` rest counts as taken. The `.worktrees`
   * directory must be ignored by SVN, because the commit review stages every unversioned file of its
   * scope and would publish the whole worktree with the owner's next change. A failure leaves nothing
   * this call made, or names the folder it could not delete.
   */
  async create(input: { ownerDir: string; folder: string }): Promise<SvnResult<SvnCheckout>> {
    const { ownerDir, folder } = input
    if (folder === '' || Slug.of(folder) !== folder)
      return { ok: false, code: 'refused', detail: `${JSON.stringify(folder)} is no worktree folder name` }
    const key = PathCompare.comparable(ownerDir)
    this.creating.set(key, (this.creating.get(key) ?? 0) + 1)
    try {
      await this.removing.get(key)
      return await this.createNow(ownerDir, folder)
    } finally {
      const left = (this.creating.get(key) ?? 1) - 1
      if (left === 0) this.creating.delete(key)
      else this.creating.set(key, left)
    }
  }

  private async createNow(ownerDir: string, folder: string): Promise<SvnResult<SvnCheckout>> {
    const info = await this.infoOf(ownerDir, '.')
    if (!info.ok) return info
    const url = info.value.url
    if (!SvnWorktreeEvidence.takesArgument(url))
      return { ok: false, code: 'refused', detail: `svn cannot take the URL ${url} as an argument` }
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
    const reserved = await SvnWorktreeManager.reserve(worktreesDir, folder)
    if (!reserved.ok) {
      await dropWorktreesDir()
      return reserved
    }
    const worktreePath = join(worktreesDir, reserved.value)
    const fail = async (detail: string, code: SvnErrorCode): Promise<SvnResult<SvnCheckout>> => {
      const purge = await rm(worktreePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
        .then(() => null, (error: unknown) => ErrorText.of(error))
      if (purge !== null || existsSync(worktreePath))
        return { ok: false, code, detail: `Checkout of ${url} into ${worktreePath} failed, and ${worktreePath} is left behind`
          + `${purge === null ? '' : ` (${purge})`}; delete it by hand: ${detail}` }
      await dropWorktreesDir()
      return { ok: false, code, detail: `Checkout of ${url} into ${worktreePath} failed; nothing was left behind: ${detail}` }
    }
    const checkout = await this.run(worktreesDir, ['checkout', '-q', '--', `${url}@HEAD`, reserved.value])
    if (!checkout.ok) return fail(checkout.detail, checkout.code)
    const checkedOut = await this.infoOf(worktreePath, '.')
    if (!checkedOut.ok) return fail(checkedOut.detail, checkedOut.code)
    return { ok: true, value: { worktreePath, url, baseRevision: checkedOut.value.revision, directoryId: await SvnWorktreeManager.directoryIdOf(worktreePath) } }
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
    return rows.ok ? { ok: true, value: SvnWorktreeManager.rootsOf(worktreePath, rows.value) } : rows
  }

  /**
   * Step 1 of a finish: everyone else's commits, inside the worktree. A file deleted from disk is
   * scheduled for deletion first, because `svn update` would restore it. Conflicts come from the status
   * after the update, never from its text, which svn prints in the ANSI code page.
   */
  async updateWorktree(worktreePath: string): Promise<SvnResult<SvnWorktreeUpdate>> {
    const before = await this.statusOf(worktreePath)
    if (!before.ok) return before
    let top: string | null = null
    for (const row of before.value.filter((entry) => entry.kind === 'missing').sort((a, b) => a.path.localeCompare(b.path))) {
      if (top !== null && row.path.startsWith(`${top}/`)) continue
      top = row.path
      if (!SvnWorktreeEvidence.takesArgument(row.path))
        return { ok: false, code: 'refused', detail: `svn cannot take the name of ${row.path}, which was deleted from disk; schedule its deletion in an SVN client, then finish again` }
      const deleted = await this.run(worktreePath, ['delete', '-q', '--force', '--', `${row.path}@`])
      if (!deleted.ok) return { ...deleted, detail: `Cannot schedule the deletion of ${row.path}: ${deleted.detail}` }
    }
    const updated = await this.run(worktreePath, ['update', '--accept', 'postpone', '--', '.'])
    if (!updated.ok) return { ...updated, detail: `svn update of ${worktreePath} failed; nothing was committed: ${updated.detail}` }
    const after = await this.statusOf(worktreePath)
    if (!after.ok) return after
    const conflicts = after.value.filter((row) => row.conflict).map((row) => row.path)
    if (conflicts.length > 0) return { ok: true, value: { kind: 'conflict', paths: conflicts } }
    const changed = SvnWorktreeEvidence.changed(after.value)
    const members = existsSync(join(worktreePath, ProductGroup.markerConst)) ? 'first-segment' : 'whole'
    const incoming = SvnWorktreeEvidence.incoming(changed.map((row) => row.path),
      SvnWorktreeEvidence.updateRows(updated.value.stdout, worktreePath), members)
    if (incoming.length > 0) {
      const info = await this.infoOf(worktreePath, '.')
      if (!info.ok) return info
      return { ok: true, value: { kind: 'updated', toRevision: info.value.revision, paths: incoming } }
    }
    const roots = SvnWorktreeManager.rootsOf(worktreePath, after.value).filter((root) => root.changed.length > 0)
    return { ok: true, value: { kind: 'current', changed, roots } }
  }

  /** Step 0 of a finish for one root: its own commits the main copy lacks. Reads `svn log -v -r N`. */
  async recoverable(root: SvnRoot, mainCopy: string): Promise<SvnResult<SvnLoggedRow[]>> {
    return this.attempt(async () => {
      const items = await this.mustVerbose(root)
      const location = SvnWorktreeManager.must(await this.infoOf(root.path, '.'))
      return SvnWorktreeEvidence.recoverableRows({
        items,
        revisionLog: (revision) => this.revisionLog(root, location, revision),
        mainBaseOf: (path) => this.mainBaseOf(mainCopy, path),
      })
    })
  }

  /**
   * The local half of `recoverable` over every root: clean items committed here that the main copy
   * holds at an older BASE. No server call, so a cleanup may run it at any time.
   */
  async unlanded(worktreePath: string, mainCopy: string): Promise<SvnResult<SvnUnlanded[]>> {
    const roots = await this.roots(worktreePath)
    if (!roots.ok) return roots
    return this.attempt(async () => {
      const unlanded: SvnUnlanded[] = []
      for (const root of roots.value)
        unlanded.push(...await SvnWorktreeEvidence.unlandedCandidates(await this.mustVerbose(root), (path) => this.mainBaseOf(mainCopy, path)))
      return unlanded
    })
  }

  /** Step 2 of a finish: per root its repository and BASE, per repository its youngest revision. */
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

  /**
   * Brings the landed paths, and only them, into the main copy, so files another session edits there
   * take only this change. A path the log modified takes its own content or properties (`--depth
   * empty`); an added, replaced or deleted one arrives whole (`--parents`). A locally edited file is
   * merged, never skipped or reverted. The result of each path is read from the status afterwards.
   */
  async updateMain(mainCopy: string, landed: readonly SvnLoggedRow[]): Promise<SvnResult<SvnMainUpdate>> {
    const newest = new Map<string, SvnLoggedRow>()
    for (const row of landed) {
      const known = newest.get(row.path)
      if (known === undefined || known.revision < row.revision) newest.set(row.path, row)
    }
    if (newest.size === 0) return { ok: true, value: { main: 'none', lines: [] } }
    const lines: string[] = []
    let conflicts = 0
    let merged = 0
    const rows = [...newest.values()].filter((row) => {
      if (SvnWorktreeEvidence.takesArgument(row.path)) return true
      lines.push(`MAIN SKIPPED ${row.path}: svn cannot take this name`)
      conflicts += 1
      return false
    })
    const flat = rows.filter((row) => !SvnWorktreeManager.arrivesWhole(row)).map((row) => row.path)
    const deepAll = rows.filter((row) => SvnWorktreeManager.arrivesWhole(row)).map((row) => row.path)
    // A path below another deep target arrives with it; listing it again makes svn skip it.
    const deep = deepAll.filter((path) => !deepAll.some((other) => path.startsWith(`${other}/`)))
    const updated = await this.updateTargets(mainCopy, ['update', '--parents', '--accept', 'postpone'], deep)
    const flatUpdated = updated.ok ? await this.updateTargets(mainCopy, ['update', '--depth', 'empty', '--accept', 'postpone'], flat) : updated
    if (!flatUpdated.ok) {
      lines.push(`MAIN UPDATE FAILED: svn update in ${mainCopy} failed; the commit stands. Update these paths by hand:`,
        ...[...deep, ...flat].map((path) => `  ${path}`),
        ...flatUpdated.detail.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-5).map((line) => `  svn: ${line}`))
      return { ok: true, value: { main: 'failed', lines } }
    }
    const states = await this.pathStates(mainCopy, rows.map((row) => row.path))
    if (!states.ok) {
      lines.push(`MAIN UPDATE FAILED: svn cannot report the main copy ${mainCopy} after the update; check these paths by hand:`,
        ...rows.map((row) => `  ${row.path}`), `  svn: ${states.detail}`)
      return { ok: true, value: { main: 'failed', lines } }
    }
    for (const row of rows) {
      const verdict = SvnWorktreeManager.mainVerdictOf(row, states.value.get(row.path))
      if (verdict === null) continue
      lines.push(verdict.line)
      if (verdict.merged) merged += 1
      else conflicts += 1
    }
    const main = conflicts > 0 ? `conflict:${conflicts}` as const : merged > 0 ? `merged:${merged}` as const : 'updated'
    return { ok: true, value: { main, lines } }
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
   * shared package store survive, and it reaches paths beyond 260 characters; Windows keeps a
   * just-closed file locked for a moment, which is what the retries are for.
   */
  async purgeAside(location: SvnWorktreeLocation): Promise<SvnResult<'removed' | 'undeleted'>> {
    const aside = `${location.worktreePath}${SvnWorktreeManager.asideSuffixConst}`
    if (!existsSync(aside)) return { ok: true, value: 'removed' }
    const asideId = await SvnWorktreeManager.directoryIdOf(aside)
    if (location.directoryId !== undefined && asideId !== null && asideId !== location.directoryId)
      return { ok: false, code: 'refused', detail: `${aside} is another directory than the worktree this session created` }
    try { await rm(aside, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) }
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
    for (const root of SvnWorktreeManager.rootsOf(worktreePath, rows)) {
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

  private static rootsOf(worktreePath: string, rows: readonly SvnStatusRow[]): SvnRoot[] {
    const mounts = rows.filter((row) => row.kind === 'external').map((row) => row.path)
      .sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b))
    const changed = SvnWorktreeEvidence.changed(rows)
    const innermost = (path: string): string => mounts.find((mount) => path === mount || path.startsWith(`${mount}/`)) ?? ''
    return [...mounts, ''].map((own) => ({
      path: own === '' ? worktreePath : join(worktreePath, ...own.split('/')),
      own,
      changed: changed.filter((row) => innermost(row.path) === own),
    }))
  }

  /** A modified path takes only its own content or properties; the root is never updated whole. */
  private static arrivesWhole(row: SvnLoggedRow): boolean {
    if (row.path === '.') return false
    switch (row.action) {
      case 'A':
      case 'D':
      case 'R':
        return true
      case 'M':
        return false
      default: throw new Error(`Unknown svn log action ${String(row.action satisfies never)}`)
    }
  }

  /** What the main copy shows of one landed path after the update; null when it simply took it. */
  private static mainVerdictOf(row: SvnLoggedRow, state: { item: SvnVerboseItem; conflict: boolean } | undefined): { line: string; merged: boolean } | null {
    if (state?.conflict === true) return { line: `MAIN CONFLICT ${row.path}`, merged: false }
    const versioned = state !== undefined && state.item.item !== 'unversioned' && state.item.item !== 'none'
    switch (row.action) {
      case 'D':
        return versioned && state.item.item !== 'deleted' ? { line: `MAIN SKIPPED ${row.path}: the main copy still holds it`, merged: false } : null
      case 'A':
      case 'M':
      case 'R':
        if (!versioned || state.item.base < row.revision)
          return { line: `MAIN SKIPPED ${row.path}: the main copy did not take r${row.revision}`, merged: false }
        return state.item.item === 'modified' || state.item.props === 'modified' ? { line: `MAIN MERGED ${row.path}`, merged: true } : null
      default: throw new Error(`Unknown svn log action ${String(row.action satisfies never)}`)
    }
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
  private static async reserve(worktreesDir: string, folder: string): Promise<SvnResult<string>> {
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

  /** The main copy's BASE of a worktree-relative path, 0 when it does not hold it. */
  private async mainBaseOf(mainCopy: string, path: string): Promise<number> {
    const target = path === '.' ? mainCopy : join(mainCopy, ...path.split('/'))
    if (!existsSync(target)) return 0
    // A name svn cannot take is found in the info of its nearest ancestor that it can.
    let anchor = path
    while (anchor !== '.' && !SvnWorktreeEvidence.takesArgument(anchor))
      anchor = anchor.includes('/') ? anchor.slice(0, anchor.lastIndexOf('/')) : '.'
    const depth = anchor === path ? [] : ['--depth', 'infinity']
    const outcome = await this.svn.run(mainCopy, ['info', '--xml', '--non-interactive', ...depth, '--', anchor === '.' ? '.' : `${anchor}@`])
    // W155010 and E200009: the main copy holds the path unversioned.
    const notVersioned = outcome.failure === null && outcome.stderr.split(/\r?\n/).filter((line) => line.trim() !== '')
      .every((line) => /^svn: (warning: W155010|E200009):/.test(line))
    if (outcome.failure !== null || (outcome.code !== 0 && !notVersioned))
      throw new SvnRunFailure(SvnWorktreeManager.failureOf(outcome).code, SvnWorktreeManager.failureOf(outcome).detail)
    const entry = SvnWorktreeEvidence.infoEntries(outcome.stdout)
      .find((candidate) => SvnWorktreeEvidence.relativeTo(mainCopy, candidate.path) === path)
    return entry?.revision ?? 0
  }

  /** Each path's state after an update, read as XML, so a non-ASCII name below a target keeps its own name. */
  private async pathStates(mainCopy: string, paths: readonly string[]): Promise<SvnResult<Map<string, { item: SvnVerboseItem; conflict: boolean }>>> {
    const states = new Map<string, { item: SvnVerboseItem; conflict: boolean }>()
    for (const chunk of SvnWorktreeManager.chunks(paths)) {
      const status = await this.run(mainCopy, ['status', '-v', '--xml', '--depth', 'empty', '--', ...chunk.map(SvnWorktreeManager.argOf)])
      if (!status.ok) return status
      try {
        const rows = SvnWorktreeEvidence.statusRows(status.value.stdout, mainCopy)
        const items = SvnWorktreeEvidence.statusVerboseRows(status.value.stdout, mainCopy)
        for (const [index, item] of items.entries()) states.set(item.path, { item, conflict: rows[index].conflict })
      }
      catch (error) { return { ok: false, code: 'svn-failed', detail: ErrorText.of(error) } }
    }
    return { ok: true, value: states }
  }

  /** An update of `targets` in chunks; a working-copy lock is waited out about five seconds. */
  private async updateTargets(mainCopy: string, command: readonly string[], targets: readonly string[]): Promise<SvnResult<void>> {
    for (const chunk of SvnWorktreeManager.chunks(targets)) {
      const args = [...command, '--', ...chunk.map(SvnWorktreeManager.argOf)]
      let updated = await this.run(mainCopy, args)
      for (const delay of SvnWorktreeManager.lockRetryDelaysConst) {
        if (updated.ok || updated.code !== 'locked') break
        await new Promise((resolve) => setTimeout(resolve, delay))
        updated = await this.run(mainCopy, args)
      }
      if (!updated.ok) return updated
    }
    return { ok: true, value: undefined }
  }

  private static chunks(paths: readonly string[]): string[][] {
    const chunks: string[][] = []
    let current: string[] = []
    let length = 0
    for (const path of paths) {
      if (current.length > 0 && length + path.length + 2 > SvnWorktreeManager.argumentBudgetConst) {
        chunks.push(current)
        current = []
        length = 0
      }
      current.push(path)
      length += path.length + 2
    }
    if (current.length > 0) chunks.push(current)
    return chunks
  }

  private static argOf(path: string): string {
    return path === '.' ? '.' : `${path}@`
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
      : /E155004|locked/i.test(detail) ? 'locked'
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
