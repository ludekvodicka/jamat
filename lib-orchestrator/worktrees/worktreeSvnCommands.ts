import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CommandOutcome, CommandRunner, CommandRunOptions } from '../shared/commandInvoker.types'
import { ErrnoCode } from '../shared/errnoCode'
import { PathCompare } from '../shared/pathCompare'
import { SvnCommand } from '../svn/svnCommand'
import { WorktreeFingerprint, WorktreeLease, type WorktreeSvnState } from './worktreeLease'

/** The composition root shares this runner with every SVN writer, including commit reviews. */
export class WorktreeSvnCommands implements CommandRunner {
  private static readonly listedConst = 20
  private readonly svn: CommandRunner
  readonly lease: WorktreeLease
  /** `accept`: nothing is reviewed yet, so the change is the worker's work and becomes the new baseline. */
  private readonly changedOutside: (root: string, reason: string) => Promise<'accept' | 'stop'>

  constructor(svn: CommandRunner, lease: WorktreeLease, changedOutside: WorktreeSvnCommands['changedOutside']) {
    this.svn = svn
    this.lease = lease
    this.changedOutside = changedOutside
  }

  async run(cwd: string, args: string[], options?: CommandRunOptions): Promise<CommandOutcome> {
    const root = WorktreeLease.rootOf(cwd)
    const roots = root === null ? this.lease.heldRootsFor(cwd) : [root]
    const command = SvnCommand.of(args)
    if (roots.length === 0 || (command !== null && SvnCommand.reads.has(command))) return this.svn.run(cwd, args, options)
    let run = async (): Promise<CommandOutcome> => {
      for (const root of roots)
        if (WorktreeLease.rootOf(root) !== null && command !== 'checkout' && command !== 'co') await this.check(root)
      const closed: (() => void)[] = [], spawned: ((pid: number) => void)[] = []
      let write = async () => {
        const result = await this.svn.run(cwd, args, { ...options, trackClose: true,
          onSpawn: (pid) => { for (const mark of spawned) mark(pid); options?.onSpawn?.(pid) } })
        if (result.closed === true || result.closed === undefined && (result.failure === null || result.failure === 'command-missing' || result.failure === 'spawn-failed' || result.failure === 'cwd-missing'))
          for (const close of closed) close()
        return result
      }
      for (const root of [...roots].reverse()) {
        const next = write
        write = () => this.lease.writer(root, (close, spawn) => { closed.push(close); spawned.push(spawn); return next() })
      }
      const result = await write()
      for (const root of roots) if (WorktreeLease.rootOf(root) !== null) await this.save(root)
      return result
    }
    for (const root of [...roots].reverse()) {
      const next = run
      run = () => this.lease.within(root, 'finish', next)
    }
    return run()
  }

  async accept(root: string): Promise<void> {
    const worktree = WorktreeLease.rootOf(root)
    if (worktree !== null) await this.lease.within(worktree, 'finish', () => this.save(worktree))
  }

  async verify(root: string): Promise<void> {
    const worktree = WorktreeLease.rootOf(root)
    if (worktree !== null) await this.check(worktree)
  }

  /**
   * An own write that died, such as a commit killed with its client, may have changed `paths` before
   * it ended: those changes become the baseline, so its recovery can run. A change to any other path
   * still stops as made outside Jamat.
   */
  async acceptInterrupted(cwd: string, paths: readonly string[]): Promise<void> {
    const worktree = WorktreeLease.rootOf(cwd)
    if (worktree !== null) await this.lease.within(worktree, 'finish', () => this.check(worktree, paths))
  }

  private async check(root: string, interrupted: readonly string[] = []): Promise<void> {
    let previous: string | null
    try { previous = await readFile(`${WorktreeLease.fileOf(root)}.fingerprint`, 'utf8') }
    catch (error) { if (ErrnoCode.of(error) !== 'ENOENT') throw error; previous = null }
    if (previous === null) return
    const current = await WorktreeFingerprint.state(this.svn, root)
    if (previous === current.hash) return
    const before = await this.entries(root, previous)
    const changed = before === null ? null : WorktreeFingerprint.changed(before, current.entries)
    const own = (path: string) => interrupted.some((other) => PathCompare.comparable(resolve(root, path)) === PathCompare.comparable(other))
    const outside = changed?.filter((path) => !own(path)) ?? null
    if (changed !== null && changed.length > 0 && outside!.length === 0) { await this.save(root, current); return }
    const lines = outside === null || outside.length === 0 ? await this.statusLines(root)
      : outside.map((path) => WorktreeFingerprint.describe(path, before![path], current.entries[path]))
    const locks = current.locked.length === 0 ? [] : [`locked by an svn command that runs or was interrupted: ${current.locked.join(', ')}`]
    const listed = [...lines, ...locks]
    const shown = listed.length > WorktreeSvnCommands.listedConst
      ? [...listed.slice(0, WorktreeSvnCommands.listedConst), `+${listed.length - WorktreeSvnCommands.listedConst} more`] : listed
    const reason = `The svn state changed outside Jamat at ${new Date().toLocaleTimeString()}${shown.length === 0 ? `: ${root}` : `:\n${shown.join('\n')}`}`
    const decision = await this.changedOutside(root, reason)
    if (decision === 'accept') { await this.save(root); return }
    if (decision !== 'stop') throw new Error(`Unknown outside-change decision: ${JSON.stringify(decision satisfies never)}`)
    throw new Error(reason)
  }

  /** Without the entries of the stored fingerprint, the changed paths are unknown: the whole status, externals included. */
  private async statusLines(root: string): Promise<string[]> {
    const status = await this.svn.run(root, ['status', '--', '.'])
    return status.stdout.split(/\r?\n/).filter((line) => line.trim() !== '' && !/^X\s/.test(line) && !line.startsWith('Performing status on external item'))
  }

  /** The entries saved with the fingerprint `hash`; null for a fingerprint an older build saved alone. */
  private async entries(root: string, hash: string): Promise<Record<string, string> | null> {
    let text: string
    try { text = await readFile(`${WorktreeLease.fileOf(root)}.fingerprint-entries.json`, 'utf8') }
    catch (error) { if (ErrnoCode.of(error) === 'ENOENT') return null; throw error }
    try {
      const saved = JSON.parse(text) as { hash?: unknown; entries?: unknown }
      return saved.hash === hash && saved.entries !== null && typeof saved.entries === 'object' ? saved.entries as Record<string, string> : null
    } catch { return null }
  }

  private async save(root: string, state?: WorktreeSvnState): Promise<void> {
    const current = state ?? await WorktreeFingerprint.state(this.svn, root)
    // The entries go first: a fingerprint whose entries name another hash reads as saved alone.
    await writeFile(`${WorktreeLease.fileOf(root)}.fingerprint-entries.json`, JSON.stringify({ hash: current.hash, entries: current.entries }), 'utf8')
    await writeFile(`${WorktreeLease.fileOf(root)}.fingerprint`, current.hash, 'utf8')
  }
}
