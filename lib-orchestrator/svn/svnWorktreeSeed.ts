import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { CommandInvoker } from '../shared/commandInvoker'
import type { CommandRunner } from '../shared/commandInvoker.types'
import { ErrnoCode } from '../shared/errnoCode'
import { ErrorText } from '../shared/errorText'
import { PathCompare } from '../shared/pathCompare'
import { type TreeRemove, TreeRemoval } from '../shared/treeRemoval'
import type { SvnInfoEntry, SvnResult } from './svn.types'
import { SvnFailures } from './svnFailures'
import { SvnUpdateTargets } from './svnUpdateTargets'
import { SvnWorktreeEvidence } from './svnWorktreeEvidence'

/** Copies the directory tree `from` into the existing directory `to`, `.svn` directories and file times included. */
export type SvnSeedCopy = (from: string, to: string) => Promise<void>

/**
 * The seed of an owner: a hidden clean working copy `<owner>/.worktrees/.seed` of the owner's URL.
 * `svn checkout` of a large tree is bound by the svn client's per-file work, and a copy of the seed's
 * files and `.svn` plus an `svn update` makes the same working copy in a fraction of that time
 * (`docs/architecture/svn-worktrees.md`, **Seed copy**).
 *
 * The seed is never a worktree and nothing here decides a create: every method reports what it found
 * and the checkout step falls back to a plain checkout on any doubt. Every svn command of the seed
 * runs on the plain runner, outside the worktree leases, and only the seed's own update takes
 * `exclusive-locking`. One lock per owner, in this process and across processes, keeps a refresh and
 * a copy of one seed apart.
 */
export class SvnWorktreeSeed {
  static readonly folderConst = '.seed'
  /** Written into a directory before a copy into it and deleted after: a directory that holds it is half copied. */
  static readonly markerConst = '.jamat-seeding'
  /** A checkout this fast gains nothing from a copy, so it builds no seed. */
  static readonly adoptMillisecondsConst = 2_000
  private static readonly lockConst = '.seed.lock'
  /** A lock older than this outlived any seed command of its owner, whose process id may since have been reused. */
  private static readonly lockStaleMillisecondsConst = 30 * 60_000
  /** A create waits for a refresh under way, so a refresh that hangs on the server may not hold it long. */
  private static readonly refreshTimeoutMillisecondsConst = 2 * 60_000
  private static readonly exclusiveLockingConst = ['--config-option', 'config:working-copy:exclusive-locking=true']
  private readonly svn: CommandRunner
  private readonly copyTree: SvnSeedCopy
  private readonly removeTree: TreeRemove
  private readonly now: () => number
  /** Per owner, the end of the last seed operation of this process, which the next one waits for. */
  private readonly queues = new Map<string, Promise<void>>()
  /** Owners whose refresh is queued and not yet started, so a burst of creates queues one. */
  private readonly refreshQueued = new Set<string>()
  private readonly background = new Set<Promise<void>>()

  constructor(svn: CommandRunner, copyTree: SvnSeedCopy = SvnWorktreeSeed.copyTreeOf, removeTree: TreeRemove = TreeRemoval.node,
    now: () => number = Date.now) {
    this.svn = svn
    this.copyTree = copyTree
    this.removeTree = removeTree
    this.now = now
  }

  static pathOf(ownerDir: string): string {
    return join(ownerDir, '.worktrees', SvnWorktreeSeed.folderConst)
  }

  /** Whether `dir` holds the marker of a copy that never finished. */
  async interrupted(dir: string): Promise<boolean> {
    return (await stat(join(dir, SvnWorktreeSeed.markerConst)).catch(() => null)) !== null
  }

  /**
   * Copies the owner's seed into the empty reserved folder `worktreePath`. The result names the
   * seed's revision, or why the seed was not used. A failure during the copy leaves files in the
   * folder, with the marker; the caller empties the folder by its identity.
   */
  async copyInto(target: { ownerDir: string; worktreePath: string; url: string }): Promise<SvnResult<{ seed: string; revision: number; milliseconds: number }>> {
    const seed = SvnWorktreeSeed.pathOf(target.ownerDir)
    return this.locked(target.ownerDir, async () => {
      if ((await stat(join(seed, '.svn')).catch(() => null))?.isDirectory() !== true) return SvnWorktreeSeed.refused(`there is no seed at ${seed}`)
      if (await this.interrupted(seed)) return SvnWorktreeSeed.refused(`the seed ${seed} was left half copied`)
      const entries = await readdir(target.worktreePath).catch((error: unknown) => ErrorText.of(error))
      if (typeof entries === 'string') return SvnWorktreeSeed.refused(`${target.worktreePath} cannot be read: ${entries}`)
      if (entries.length > 0) return SvnWorktreeSeed.refused(`${target.worktreePath} is not empty`)
      const problem = await this.identityProblem(seed, target.ownerDir, target.url)
      if (typeof problem === 'string') return SvnWorktreeSeed.refused(problem)
      const started = this.now()
      try {
        await writeFile(join(target.worktreePath, SvnWorktreeSeed.markerConst), seed, { flag: 'wx' })
        await this.copyTree(seed, target.worktreePath)
        await unlink(join(target.worktreePath, SvnWorktreeSeed.markerConst))
      } catch (error) {
        return { ok: false, code: 'io-failed', detail: `The copy of the seed ${seed} into ${target.worktreePath} failed: ${ErrorText.of(error)}` }
      }
      return { ok: true, value: { seed, revision: problem.revision, milliseconds: this.now() - started } }
    }, (holder) => SvnWorktreeSeed.refused(`the seed ${seed} is in use by ${holder}`))
  }

  /**
   * Why the working copy `root` is not what a plain checkout of its URL at `revision` gives, or null:
   * `svn status --no-ignore` names nothing but externals, its root is at `revision`, and every
   * external its definitions name is on disk with the URL they name.
   */
  async proof(root: string, revision: number): Promise<string | null> {
    try {
      const status = await this.read(root, ['status', '--xml', '--no-ignore', '--', '.'])
      const dirty = SvnWorktreeSeed.problemsOf(status, root, revision)
      if (dirty.length > 0) return `svn status names ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ` and ${dirty.length - 5} more` : ''}`
      const info = SvnWorktreeEvidence.infoEntries(await this.read(root, ['info', '--xml', '--', '.']))[0]
      if (info === undefined) return 'svn info names no root entry'
      if (info.revision !== revision) return `the root is at r${info.revision}, not r${revision}`
      const externals = await new SvnUpdateTargets(this.svn).snapshot({ path: root, url: info.url, repository: info.repository, revision, kind: info.kind, pinned: false })
      if (externals.missing.length > 0) return `externals are missing: ${externals.missing.join(', ')}`
      if (externals.mismatched.length > 0) return `externals check out other URLs than defined: ${externals.mismatched.join(', ')}`
      return null
    } catch (error) { return ErrorText.of(error) }
  }

  /**
   * Makes the clean checkout `worktreePath`, which the caller just proved at its reserved revision,
   * the owner's seed, in place of any seed there was: the seed was not used for this create, so it is
   * not trusted. Nothing may write into `worktreePath` while this runs. A seed that does not come out
   * clean is deleted again.
   */
  async adopt(source: { ownerDir: string; worktreePath: string; revision: number }): Promise<SvnResult<void>> {
    const seed = SvnWorktreeSeed.pathOf(source.ownerDir)
    return this.locked(source.ownerDir, async () => {
      try {
        await this.removeTree(seed)
        await mkdir(seed)
        await writeFile(join(seed, SvnWorktreeSeed.markerConst), source.worktreePath, { flag: 'wx' })
        await this.copyTree(source.worktreePath, seed)
        await unlink(join(seed, SvnWorktreeSeed.markerConst))
      } catch (error) {
        await this.removeTree(seed).catch(() => undefined)
        return { ok: false, code: 'io-failed', detail: `The seed ${seed} could not be copied from ${source.worktreePath}: ${ErrorText.of(error)}` }
      }
      const problem = await this.proof(seed, source.revision)
      if (problem === null) return { ok: true, value: undefined }
      await this.removeTree(seed).catch(() => undefined)
      return SvnWorktreeSeed.refused(`the seed copied from ${source.worktreePath} is not clean, so it was deleted: ${problem}`)
    }, (holder) => SvnWorktreeSeed.refused(`the seed ${seed} is in use by ${holder}`))
  }

  /**
   * Updates the owner's seed to HEAD after this create, in the background, so the next copy has
   * less to update. A seed the update leaves unclean is deleted; the next slow checkout makes a new one.
   */
  refreshLater(ownerDir: string): void {
    const key = PathCompare.comparable(ownerDir)
    if (this.refreshQueued.has(key)) return
    this.refreshQueued.add(key)
    const work = this.locked(ownerDir, async () => {
      this.refreshQueued.delete(key)
      const seed = SvnWorktreeSeed.pathOf(ownerDir)
      if ((await stat(join(seed, '.svn')).catch(() => null)) === null) return
      const update = await this.svn.run(seed, ['update', '--non-interactive', ...SvnWorktreeSeed.exclusiveLockingConst, '-q', '--accept', 'postpone', '--', '.'],
        { timeoutMs: SvnWorktreeSeed.refreshTimeoutMillisecondsConst })
      let revision: number | undefined
      try {
        if (update.failure === null && update.code === 0) revision = SvnWorktreeEvidence.infoEntries(await this.read(seed, ['info', '--xml', '--', '.']))[0]?.revision
      } catch { revision = undefined }
      if (revision === undefined || await this.proof(seed, revision) !== null) await this.removeTree(seed).catch(() => undefined)
    }, () => { this.refreshQueued.delete(key) }).catch(() => { this.refreshQueued.delete(key) })
    this.background.add(work)
    void work.finally(() => this.background.delete(work))
  }

  /** Resolves once no background refresh of this instance runs. */
  async settled(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background])
  }

  /**
   * The paths of a `svn status --xml --no-ignore` that a fresh checkout at `revision` never shows:
   * anything but an external definition and an untouched node, a conflict, a working-copy lock, a
   * switched or skipped node, and an ignored or unversioned file.
   */
  static problemsOf(xml: string, root: string, revision: number): string[] {
    const problems = new Set<string>([
      ...SvnWorktreeEvidence.lockedPaths(xml, root),
      ...SvnWorktreeEvidence.conflicts(xml, root).map((row) => row.path),
      ...SvnWorktreeEvidence.updateProblems(xml, root, revision),
    ])
    for (const row of SvnWorktreeEvidence.statusVerboseRows(xml, root)) {
      const props = row.props === 'modified' || row.props === 'conflicted'
      switch (row.item) {
        case 'external': case 'normal': case 'none':
          if (props) problems.add(row.path)
          break
        case 'added': case 'conflicted': case 'deleted': case 'ignored': case 'incomplete': case 'merged': case 'missing':
        case 'modified': case 'obstructed': case 'replaced': case 'unversioned':
          problems.add(row.path)
          break
        default: throw new Error(`Unknown svn status item ${String(row.item satisfies never)}`)
      }
    }
    return [...problems].sort()
  }

  /**
   * robocopy with 16 threads on Windows, measured at 3 s for 13,000 files where a checkout took 20 s;
   * Node's copy elsewhere. File times are copied, so svn finds every file unchanged without reading
   * it. Directory times are not: the target's creation time is part of its `directoryId`, the
   * identity removal checks.
   */
  static async copyTreeOf(from: string, to: string): Promise<void> {
    if (process.platform !== 'win32') {
      await cp(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false })
      return
    }
    const outcome = await new CommandInvoker({ spawnImpl: spawn }).run({ command: 'robocopy', cwd: dirname(to), env: process.env,
      args: [from, to, '/E', '/COPY:DAT', '/DCOPY:DA', '/MT:16', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'] })
    // robocopy reports success below 8; the low bits say what it copied and what it found extra.
    if (outcome.failure !== null || outcome.code >= 8)
      throw new Error(`robocopy ended with ${outcome.failure ?? outcome.code}: ${(outcome.stdout + outcome.stderr).trim().slice(-2000)}`)
  }

  /** The seed's revision, or why it cannot stand for a checkout of `url` in the owner's repository. */
  private async identityProblem(seed: string, ownerDir: string, url: string): Promise<string | { revision: number }> {
    try {
      const [seedXml, ownerXml] = [await this.read(seed, ['info', '--xml', '--', '.']), await this.read(ownerDir, ['info', '--xml', '--', '.'])]
      const own: SvnInfoEntry | undefined = SvnWorktreeEvidence.infoEntries(seedXml)[0]
      const owner: SvnInfoEntry | undefined = SvnWorktreeEvidence.infoEntries(ownerXml)[0]
      if (own === undefined || owner === undefined) return 'svn info names no entry for the seed or its owner'
      if (own.url !== url) return `the seed checks out ${own.url}, not ${url}`
      if (own.repository !== owner.repository || SvnWorktreeSeed.uuidOf(seedXml) !== SvnWorktreeSeed.uuidOf(ownerXml))
        return `the seed belongs to the repository ${own.repository}, not to the owner's ${owner.repository}`
      if (PathCompare.comparable(SvnWorktreeSeed.wcRootOf(seedXml) ?? '') !== PathCompare.comparable(seed)) return `the seed ${seed} is no working-copy root`
      return { revision: own.revision }
    } catch (error) { return ErrorText.of(error) }
  }

  /**
   * Runs `work` alone among the seed operations of `ownerDir`: after every earlier one of this
   * process, and while it holds `<owner>/.worktrees/.seed.lock`. Another live process holding that
   * file gives `busy` at once, so a create never waits for another program.
   */
  private async locked<T>(ownerDir: string, work: () => Promise<T>, busy: (holder: string) => T): Promise<T> {
    const key = PathCompare.comparable(ownerDir)
    const previous = this.queues.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = previous.then(() => new Promise<void>((done) => { release = done }))
    this.queues.set(key, current)
    try {
      await previous
      const file = join(ownerDir, '.worktrees', SvnWorktreeSeed.lockConst)
      const holder = await this.take(file)
      if (holder !== null) return busy(holder)
      try { return await work() }
      finally { await unlink(file).catch(() => undefined) }
    } finally {
      release()
      if (this.queues.get(key) === current) this.queues.delete(key)
    }
  }

  /** Null once this process holds `file`; else who holds it. A lock of a gone or old holder is taken over. */
  private async take(file: string): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(file, JSON.stringify({ pid: process.pid, at: this.now() }), { flag: 'wx' })
        return null
      } catch (error) {
        if (ErrnoCode.of(error) !== 'EEXIST') return `nobody: the lock ${file} cannot be written (${ErrorText.of(error)})`
      }
      let held: { pid?: unknown; at?: unknown } = {}
      try { held = JSON.parse(await readFile(file, 'utf8')) } catch { /* A lock without its content is a holder that died while writing it. */ }
      const pid = typeof held.pid === 'number' && Number.isSafeInteger(held.pid) ? held.pid : null
      const at = typeof held.at === 'number' ? held.at : 0
      if (pid !== null && pid !== process.pid && SvnWorktreeSeed.alive(pid) && this.now() - at < SvnWorktreeSeed.lockStaleMillisecondsConst)
        return `process ${pid}`
      await unlink(file).catch(() => undefined)
    }
    return `another process that took ${file} first`
  }

  private async read(cwd: string, args: string[]): Promise<string> {
    const outcome = await this.svn.run(cwd, [args[0]!, '--non-interactive', ...args.slice(1)])
    if (outcome.failure !== null || outcome.code !== 0) throw new Error(SvnFailures.failureOf(outcome).detail)
    return outcome.stdout
  }

  private static uuidOf(infoXml: string): string | null {
    return /<uuid>([^<]*)<\/uuid>/.exec(infoXml)?.[1] ?? null
  }

  private static wcRootOf(infoXml: string): string | null {
    return /<wcroot-abspath>([^<]*)<\/wcroot-abspath>/.exec(infoXml)?.[1]
      ?.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name] ?? '') ?? null
  }

  private static alive(pid: number): boolean {
    try { process.kill(pid, 0); return true }
    catch (error) { return ErrnoCode.of(error) !== 'ESRCH' }
  }

  private static refused(why: string): { ok: false; code: 'refused'; detail: string } {
    return { ok: false, code: 'refused', detail: why }
  }
}
