import type { TreeRemovalProgress } from '../../shared/treeRemoval'
import type { SvnWorktreeLocation } from '../../svn/svn.types'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionRecord, SessionRecordWorktree } from '../records/sessionRecord.types'
import type { SessionRecordsStore } from '../records/sessionRecordsStore'
import type { SvnFinishWorktreeResult } from '../sessionManagerApi.types'
import type { SessionSteps } from './sessionSteps'
import type { SessionStepRemovalPhase } from './sessionStepWords'

/** The disk writes a removal makes, named so a test can hand them a scripted set. */
export type SvnRemovalPort = Pick<SvnWorktreeManager, 'renameAside' | 'purgeAside' | 'removeEmptyWorktreesDir'>

export interface SvnWorktreeRemovalDeps {
  records: SessionRecordsStore
  svn: SvnRemovalPort
  /** Lets go of what this client itself holds below a path, so the rename probe meets only others. */
  releaseBelow: (path: string) => Promise<void>
  /** The queue reopen and restart run on, so a removal never races one. */
  onQueue: <T>(work: () => Promise<T>) => Promise<T>
  /** The record moved outside an operation, so the snapshot is composed again. */
  changed: () => void
  /** Each phase of the removal is the session's step; its caller clears the step where its work ends. */
  steps: Pick<SessionSteps, 'at'>
  now?: () => number
}

export interface SvnWorktreeRemoved {
  state: SvnFinishWorktreeResult
  lines: string[]
}

/**
 * The removal of an SVN worktree by identity, shared by an SVN action and the cleanup after the
 * session's end. This client's own handles are released, the worktree is renamed aside (a holder
 * makes that fail, and then the worktree stays whole), the rest is purged, and the record keeps a
 * tombstone. The rename runs on the operation queue after a re-read, so a reopen that won the race
 * keeps its directory.
 */
export class SvnWorktreeRemoval {
  private readonly records: SessionRecordsStore
  private readonly svn: SvnRemovalPort
  private readonly releaseBelow: (path: string) => Promise<void>
  private readonly onQueue: <T>(work: () => Promise<T>) => Promise<T>
  private readonly changed: () => void
  private readonly steps: Pick<SessionSteps, 'at'>
  private readonly now: () => number

  constructor(deps: SvnWorktreeRemovalDeps) {
    this.records = deps.records
    this.svn = deps.svn
    this.releaseBelow = deps.releaseBelow
    this.onQueue = deps.onQueue
    this.changed = deps.changed
    this.steps = deps.steps
    this.now = deps.now ?? (() => Date.now())
  }

  /** `revisions` (`<repository URL>:r<N>`) join those of the last outcome in the tombstone. */
  async remove(sessionId: string, location: SvnWorktreeLocation, revisions: readonly string[]): Promise<SvnWorktreeRemoved> {
    const path = location.worktreePath
    this.steps.at(sessionId, { kind: 'removal', phase: 'queue', path })
    const renamed = await this.onQueue(async () => {
      const now = this.records.get(sessionId)
      if (!now || now.life === 'live' || now.life === 'starting' || now.pendingOperationId !== undefined) return null
      this.steps.at(sessionId, { kind: 'removal', phase: 'release', path })
      await this.releaseBelow(path)
      this.steps.at(sessionId, { kind: 'removal', phase: 'rename', path })
      return this.svn.renameAside(location)
    })
    if (renamed === null) return { state: 'kept', lines: [`KEPT: session ${sessionId} runs again, so ${path} stays`] }
    if (!renamed.ok) return { state: 'kept', lines: [`ERROR: ${renamed.detail}; the worktree is kept`] }
    if (renamed.value === 'in-use')
      return { state: 'in-use', lines: [`IN USE: ${path} (a process has its working directory or an open file there; the worktree is kept)`] }
    else if (renamed.value !== 'renamed' && renamed.value !== 'absent')
      throw new Error(`Unknown rename result: ${JSON.stringify(renamed.value satisfies never)}`)
    const purged = await this.svn.purgeAside(location, (progress) => this.steps.at(sessionId,
      { kind: 'removal', phase: SvnWorktreeRemoval.phaseOf(progress.phase), path },
      { done: progress.done, total: progress.total }))
    if (!purged.ok || purged.value === 'undeleted')
      return {
        state: 'undeleted',
        lines: [`ERROR: ${path}.deleting is left half deleted${purged.ok ? '' : ` (${purged.detail})`}; Discard finishes it`],
      }
    this.steps.at(sessionId, { kind: 'removal', phase: 'tombstone', path })
    await this.svn.removeEmptyWorktreesDir(location.ownerDir)
    await this.onQueue(async () => {
      const current = this.records.get(sessionId)
      if (!current) return
      const caller = current.worktree?.caller ?? current.retiredWorktree?.caller
      const directoryId = location.directoryId ?? current.retiredWorktree?.directoryId
      const next: SessionRecord = {
        ...current,
        retiredWorktree: {
          worktreePath: path,
          kind: 'svn',
          revisions: SvnWorktreeRemoval.joined(current.worktreeOutcome?.revisions ?? [], revisions),
          removedAt: this.now(),
          ownerDir: location.ownerDir,
          ...directoryId === undefined ? {} : { directoryId },
          ...caller === undefined ? {} : { caller },
        },
        completed: true,
      }
      delete next.worktree
      delete next.worktreeCleanup
      await this.records.put(next)
    })
    this.changed()
    return { state: 'removed', lines: ['   worktree removed'] }
  }

  private static phaseOf(phase: TreeRemovalProgress['phase']): SessionStepRemovalPhase {
    if (phase === 'counting') return 'count'
    else if (phase === 'deleting') return 'delete'
    else throw new Error(`Unknown tree removal phase: ${JSON.stringify(phase satisfies never)}`)
  }

  static locationOf(worktree: SessionRecordWorktree): SvnWorktreeLocation {
    return {
      worktreePath: worktree.worktreePath,
      ownerDir: worktree.repositoryRoot,
      url: worktree.branch,
      ...worktree.directoryId === undefined ? {} : { directoryId: worktree.directoryId },
    }
  }

  /** Two lists of `<repository>:r<N>`, once each, by repository and number; a hand-edited entry sorts by its text. */
  static joined(earlier: readonly string[], later: readonly string[]): string[] {
    const keyOf = (entry: string): [string, number] => {
      const match = /^(.*):r(\d+)$/.exec(entry)
      return match === null ? [entry, 0] : [match[1], Number(match[2])]
    }
    return [...new Set([...earlier, ...later])].sort((a, b) => {
      const [left, right] = [keyOf(a), keyOf(b)]
      return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] - right[1]
    })
  }
}
