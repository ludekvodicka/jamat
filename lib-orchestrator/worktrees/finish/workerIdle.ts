import type { SessionActivity } from '../../sessionManager/sessionManagerApi.types'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { WorktreeSvnCommands } from '../worktreeSvnCommands'
import { SvnCommitGate } from '../../svn/svnCommitGate'

export class WorkerIdle {
  static of(activity: SessionActivity | null, polledAt: number | null, pendingDeliveries: number, now = Date.now()): boolean {
    return WorkerIdle.busyOf(activity, polledAt, pendingDeliveries, now) === null
  }

  /** Why the worker does not count as idle, as a person reads it; null when it does. */
  static busyOf(activity: SessionActivity | null, polledAt: number | null, pendingDeliveries: number, now = Date.now()): string | null {
    if (pendingDeliveries !== 0) return 'input typed for the worker has not reached it yet'
    if (polledAt === null || now < polledAt || now - polledAt >= 10_000) return 'the activity of the worker was not read in the last 10 seconds'
    switch (activity) {
      case 'idle': case 'waiting': return null
      case 'working': return 'the worker is working'
      case 'unknown': case null: return 'the activity of the worker is unknown'
      default: throw new Error(`Unknown worker activity: ${JSON.stringify(activity satisfies never)}`)
    }
  }
}

export class WorkerReady {
  private readonly records: SessionRecordsStore
  private readonly svn: Pick<SvnWorktreeManager, 'changes' | 'commitHashes'>
  private readonly commands: Pick<WorktreeSvnCommands, 'accept' | 'lease'>

  constructor(records: SessionRecordsStore, svn: WorkerReady['svn'], commands: WorkerReady['commands']) {
    this.records = records
    this.svn = svn
    this.commands = commands
  }

  async propose(sessionId: string): Promise<void> {
    const record = this.records.get(sessionId)
    if (record?.worktree?.kind !== 'svn') return
    const root = record.worktree.worktreePath
    await this.commands.lease.within(root, 'finish', async () => {
      const record = this.records.get(sessionId)
      if (record?.worktree?.worktreePath !== root || record.worktreeLifecycle === undefined) return
      const version = record.worktreeLifecycle.version
      const hashes = await this.hashes(root)
      if (this.records.get(sessionId)?.worktreeLifecycle?.version !== version) return
      // A proposal into an open review of the same content changes only its message, which the review draft
      // carries; a ready mark would prepare the review again and close it (UA1-J12-5).
      const review = record.worktreeLifecycle.review
      if (record.worktreeLifecycle.step === 'reviewing' && review !== undefined && WorkerReady.same(
        Object.fromEntries(Object.entries(hashes).filter(([path]) => !SvnCommitGate.sidecarPattern.test(path))), review.hashes)) return
      // An existing review is a protected boundary; another proposal cannot bless outside SVN writes.
      if (record.svnAction === undefined && record.worktreeLifecycle.review === undefined
        && record.worktreeLifecycle.wait?.kind !== 'changed-outside') await this.commands.accept(root)
      if (!await this.records.update(sessionId, (latest) => latest.worktreeLifecycle === undefined || latest.worktreeLifecycle.version !== version ? null : {
        ...latest, worktreeLifecycle: { ...latest.worktreeLifecycle, version: latest.worktreeLifecycle.version + 1,
          facts: { ...latest.worktreeLifecycle.facts, worker: { ...latest.worktreeLifecycle.facts.worker, ready: { at: Date.now(), hashes } } } },
      })) throw new Error('The worker ready snapshot could not be saved')
    })
  }

  async current(sessionId: string): Promise<boolean> {
    const record = this.records.get(sessionId)
    const ready = record?.worktreeLifecycle?.facts.worker.ready
    if (ready === undefined || record?.worktree?.kind !== 'svn') return false
    const hashes = await this.hashes(record.worktree.worktreePath)
    if (this.records.get(sessionId)?.worktreeLifecycle?.facts.worker.ready !== ready) return false
    if (WorkerReady.same(hashes, ready.hashes)) return true
    if (!await this.records.update(sessionId, (latest) => latest.worktreeLifecycle === undefined || latest.worktreeLifecycle.facts.worker.ready !== ready ? latest : {
      ...latest, worktreeLifecycle: { ...latest.worktreeLifecycle, version: latest.worktreeLifecycle.version + 1,
        facts: { ...latest.worktreeLifecycle.facts, worker: { ...latest.worktreeLifecycle.facts.worker, ready: undefined } } },
    })) throw new Error('The stale worker ready snapshot could not be cleared')
    return false
  }

  private static same(hashes: Record<string, string>, other: Record<string, string>): boolean {
    return JSON.stringify(Object.entries(hashes).sort()) === JSON.stringify(Object.entries(other).sort())
  }

  private async hashes(root: string): Promise<Record<string, string>> {
    const changes = await this.svn.changes(root)
    if (!changes.ok) throw new Error(changes.detail)
    const hashes = await this.svn.commitHashes(root, changes.value.map((row) => row.path), 'node')
    if (!hashes.ok) throw new Error(hashes.detail)
    return hashes.value
  }
}
