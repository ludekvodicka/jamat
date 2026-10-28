import type { CommitMessageSource, CommitMessageFinding } from '../svn/svnCommitMessageCheck'
import type { SessionRecordScriptStep } from '../sessionManager/sessionScriptTypes'
import type { SvnActionVerdict, SvnActionConflicts, SvnActionFixed, SvnActionMerger, SvnActionNotice, SvnActionRoot, SvnLabelledRevision, SvnFinishWorktreeResult, SvnActionPass } from './worktreeContracts'

/** A press that has to stop the run of the current step before it goes on. */
export type WorktreeStopPress = 'back-to-work' | 'keep' | 'discard' | 'commit'

export interface WorktreeExecution {
  /** The ended or lost run whose stop Jamat cannot prove; only that run can be confirmed stopped by hand. */
  stopRefusedRunId?: string
  /** The press the refused stop interrupted; the manual confirmation goes on with it. */
  stopRefusedPress?: WorktreeStopPress
  updateProtection?: { before: string[]; overlaps: string[]; saved: string[] }
  neverStartedReason?: string
  removalLines?: string[]
  flowVersion?: 1
  commit?: { selection: string[]; message: string; messageSource?: CommitMessageSource; acknowledgedFindings?: CommitMessageFinding[]; hashes: Record<string, string>; preparedAdds?: string[]; files?: { targetsFile: string; messageFile: string } }
  marked?: string[]
  /** The run a run stage waits on, or the last run of a stage that moved on. */
  runId?: string
  /** Absent while the run is judged; then the next client step reads the disk. */
  verdict?: SvnActionVerdict
  /** The worktree the action works in; the main copy for `update-main`. */
  root: string
  /** `scripts.after` frozen at the press, scriptId `checks`. */
  checks: SessionRecordScriptStep[]
  checkCursor: number
  /** The worktree the checks passed on, so Finish again reviews without running them. */
  checksPassed?: { fingerprint: string; at: number }
  /** BASE of `root` before the last update. */
  baseRevision?: number
  /**
   * The text conflicts the resolver was started on, the changed paths before it started (its edits
   * outside the conflicts are measured against them) and when it was started (its time limit).
   */
  conflicts?: SvnActionConflicts
  /** No resolver may start before the next press: the one of this press ran, or nobody pressed (an UPDATE a Finish started). */
  resolverSpent?: true
  /** What Jamat's rules settled in this action, oldest first, at most 200; it outlives the set an update clears. */
  fixed?: SvnActionFixed[]
  /** The merger's brief of the set, absolute (`ScriptLogStore.mergeBriefPathOf`), once it was written. */
  mergeBrief?: string
  /**
   * The last merger of this action: its run, the set it was started on (`conflictSet.readAt`; one
   * merger starts by itself per set), when it started and ended, and when the check after it ran.
   */
  merger?: SvnActionMerger
  /** The caller's wake-up line for this wait (`worktree.notify`); the next wait writes a new id. */
  notice?: SvnActionNotice
  /** The review plan, mounts first. */
  roots?: SvnActionRoot[]
  /**
   * The repository of every working copy of the worktree by its mount (`''` for the worktree itself),
   * read with the review, unchanged roots too: a label names the mount whenever two of them share a
   * name, also when only one of them published (UA1-J13-5).
   */
  mounts?: { own: string; repository: string }[]
  rootCursor: number
  /** A locked working copy relaunches the update then. */
  retryAt?: number
  /** This worktree's commits, labelled. */
  evidence: SvnLabelledRevision[]
  removal?: SvnFinishWorktreeResult
  /** When the last removal attempt began: the step of a retried removal counts from it, never from the first. */
  removalAt?: number
  requestedBy: 'window' | 'cli' | 'peer'
  /** When this press started; the stop limit and the receipts of its reviews are counted from it. */
  startedAt: number
  /** The stages this action left, oldest first, at most 40 (`SvnActionStages.passesMaxConst`). */
  passes?: SvnActionPass[]
  /** When the current stage, or the current run of a run stage, began. */
  stageAt?: number
  preparationRound?: number
  /**
   * The install a Finish runs again by itself when only the dependency inputs changed since the last setup:
   * its steps, the step it is at, the inputs it answers, and when it ended. An ended refresh is spent for
   * this sync; inputs that change again wait for the person.
   */
  refresh?: { steps: SessionRecordScriptStep[]; cursor: number; paths: string[]; endedAt?: number }
  checkStartedAt?: number
  checkLogPath?: string
  checkBefore?: Record<string, string>
  confirmBusy?: boolean
  reviewWaitAt?: number
  pendingLog?: { runId: string; title: string }
}
