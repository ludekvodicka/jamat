import { existsSync } from 'node:fs'

import { ErrorText } from '../../shared/errorText'
import { PathCompare } from '../../shared/pathCompare'
import { SessionWorkingDirectory } from '../../sessionManager/sessionWorkingDirectory'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { SvnWorktreeLocation } from '../../svn/svn.types'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { WorktreeResultRecord, WorktreeResultsStore } from '../results/worktreeResultsStore'
import { SvnWorktreeRemoval } from './svnWorktreeRemoval'

export type ResultRemovalsSvnPort = Pick<SvnWorktreeManager, 'removalSource' | 'removalHoldsFiles' | 'removalStatus' | 'renameAside' | 'purgeAside' | 'removeEmptyWorktreesDir'>

export interface ResultRemovalsDeps {
  results: Pick<WorktreeResultsStore, 'list' | 'removalDone'>
  records: Pick<SessionRecordsStore, 'listAll' | 'latched' | 'loadedFromFile' | 'archiveRead'>
  svn: ResultRemovalsSvnPort
  report: (message: string) => void
  now: () => number
}

/**
 * The removal a durable result still calls `pending` after no session holds its worktree any more.
 * A person may remove the session while Windows refuses the removal, and nothing then retried it: run
 * 098 (result committed, removal pending) left its folder from 2026-11-02 on (I67, Jamat#50).
 *
 * The result names the folder and its directory identity. Only that directory goes, never another one
 * at the same path, and only when it holds no work: a tree of empty directories, or a fresh `svn
 * status` a clean permit accepts. The result does not say whose permit its Finish had, so a person's
 * Discard of changed work is never assumed. A remainder `<name>.deleting` of the same identity passed
 * its permit before it was moved and is purged. A folder still held stays pending for the next pass.
 */
export class ResultRemovals {
  /** The first pass after a client start runs at once; a lock often goes only with a restart. */
  private static readonly intervalMillisecondsConst = 10 * 60_000
  private readonly results: ResultRemovalsDeps['results']
  private readonly records: ResultRemovalsDeps['records']
  private readonly svn: ResultRemovalsSvnPort
  private readonly report: (message: string) => void
  private readonly now: () => number
  private lastAt: number | null = null
  private running: Promise<void> | null = null

  constructor(deps: ResultRemovalsDeps) {
    this.results = deps.results
    this.records = deps.records
    this.svn = deps.svn
    this.report = deps.report
    this.now = deps.now
  }

  /** A pass when none runs and the last one lies `intervalMillisecondsConst` back; the first one always. */
  due(): Promise<void> {
    if (this.running !== null) return this.running
    const now = this.now()
    if (this.lastAt !== null && now - this.lastAt >= 0 && now - this.lastAt < ResultRemovals.intervalMillisecondsConst) return Promise.resolve()
    this.lastAt = now
    this.running = this.run().finally(() => { this.running = null })
    return this.running
  }

  async run(): Promise<void> {
    // A records file that could not be read, is not there, or an unread archive names no session, so every
    // folder would look unowned; nothing is removed then (as `SessionScriptsManager.sweep`).
    if (this.records.latched || !this.records.loadedFromFile || !this.records.archiveRead) return
    for (const result of this.results.list({}).filter((row) => row.removal === 'pending'))
      try { await this.finish(result) }
      catch (error) { this.report(`The pending removal of ${result.worktreePath} (result ${result.actionId}) failed: ${ErrorText.of(error)}`) }
  }

  private async finish(result: WorktreeResultRecord): Promise<void> {
    if (result.directoryId === null || this.held(result.worktreePath)) return
    const location: SvnWorktreeLocation = { worktreePath: result.worktreePath, ownerDir: result.mainCopy, url: '', directoryId: result.directoryId }
    const source = await this.svn.removalSource(location)
    // Another directory at the path, or both the worktree and a remainder: neither is this result's to delete.
    if (!source.ok) return
    if (!source.value.present) {
      // A main copy that is not there (a drive not mapped) proves nothing about the folder below it.
      if (existsSync(result.mainCopy)) await this.results.removalDone(result.actionId)
      return
    }
    if (!source.value.aside && await this.svn.removalHoldsFiles(source.value.path)) {
      const status = await this.svn.removalStatus(source.value.path)
      if (!status.ok || SvnWorktreeRemoval.leftOf(status.value).length > 0) return
    }
    const renamed = await this.svn.renameAside(location)
    if (!renamed.ok || (renamed.value !== 'renamed' && renamed.value !== 'absent')) return
    const purged = await this.svn.purgeAside(location)
    if (!purged.ok || purged.value !== 'removed') return
    await this.svn.removeEmptyWorktreesDir(result.mainCopy)
    await this.results.removalDone(result.actionId)
  }

  /** A session record that still names the folder removes it itself; a live session inside holds it. */
  private held(worktreePath: string): boolean {
    return this.records.listAll().some((record) => record.worktree !== undefined && PathCompare.comparable(record.worktree.worktreePath) === PathCompare.comparable(worktreePath)
      || (record.life === 'live' || record.life === 'starting') && PathCompare.isInside(worktreePath, SessionWorkingDirectory.ofRecord(record)))
  }
}
