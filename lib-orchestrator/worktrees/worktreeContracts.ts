import type { SvnUpdateTarget } from '../svn/svnUpdateTargets'
import type { SvnConflictJournal, SvnConflictKind, SvnConflictOption, SvnConflictShape, SvnContentFacts, SvnNodeKind, SvnTreeAction, SvnTreeReason } from '../svn/svn.types'

export type SvnFinishPhase = 'updating' | 'reviewing' | 'main-updating' | 'removing'

export type SvnFinishWorktreeResult = 'removed' | 'kept' | 'in-use' | 'undeleted'

/**
 * How a revision of an SVN action is known to be this worktree's: a commit receipt the log confirmed,
 * the worktree's own BASE, or the log of the paths the action saw changed. No label decides a removal.
 */
export type SvnRevisionLabel = 'receipt' | 'base-proof' | 'inferred'

export interface SvnLabelledRevision {
  paths?: string[]
  /** Repository root URL. */
  repository: string
  revision: number
  label: SvnRevisionLabel
}

/**
 * Where an SVN action is. Run stages wait on a script run of the session; client stages are short
 * writes this client makes (`SvnActionStages`).
 */
export type SvnActionStage =
  | 'changes' | 'committing' | 'stopping' | 'evidence' | 'checks' | 'updating' | 'cleaning' | 'resolving' | 'merging' | 'verifying' | 'fixing'
  | 'diffing' | 'reviewing' | 'removing' | 'recording' | 'main-update'

/** `update-main` runs in a main copy, on the session that started it, which may hold no worktree. */
export type SvnActionKind = 'finish' | 'discard' | 'update-main'

/** Why an SVN action waits for the person; Finish again, Keep and Discard are the ways on. */
export type SvnActionNeed =
  | 'check-failed' | 'conflict' | 'resolver-failed' | 'incoming' | 'out-of-date' | 'review-cancelled'
  | 'review-interrupted' | 'partial' | 'pinned-external' | 'locked' | 'svn-failed' | 'removal-blocked' | 'not-stopped'
  | 'worker-busy'

/** Who works on a conflicted path now; a surface draws `rule` and `settled` as one group. */
export type SvnConflictState = 'rule' | 'agent' | 'person' | 'settled'

/**
 * Who settled a conflicted path: Jamat's rule, the session's own agent (the worker, also a CLI call
 * without a run), the merger run of the action, or the person in the window. Records written before
 * `merger` existed name the merger `agent` as well.
 */
export type SvnConflictActor = 'jamat' | 'agent' | 'merger' | 'person'

/** The actor on the wire: an older peer validates three values, so the merger travels as `agent` and `settled` names it. */
export type SvnConflictWireActor = Exclude<SvnConflictActor, 'merger'>

/**
 * `branch` and `baseCommit` stay mandatory non-empty strings for an SVN worktree as well, because an
 * older peer validates them that way and accepts unknown keys: SVN fills them with the checked-out
 * URL and `r<rev>`.
 */
export interface SessionRecordConflictMemory {
  actionId: string
  readAt: number
  paths: Array<{ path: string; saved: string; sidecars: string[]; kind?: 'text' | 'property' | 'tree'; occurrenceId?: string; source?: string }>
}

/** One working copy an SVN action reviews: an external mount, or the worktree itself. */
export interface SvnActionRoot {
  pinned?: boolean
  selection?: string[]
  /** Absolute directory. */
  path: string
  /** Its place in the worktree: `''` for the worktree itself, else the mount path. */
  own: string
  /** Its changed paths, worktree-relative with `/`. */
  changed: string[]
  /** What a proof of its review needs, read when its review run is launched. */
  bounds?: { repository: string; base: string; rootBase: number; since: number }
}

/** What the SVN conflict resolver of an action was started on; paths are worktree-relative with `/`. */
export interface SvnActionConflicts {
  paths: string[]
  before: string[]
  at: number
}

/** One stage the action left, written with the move; the workflow reads its steps and rounds from these. */
export interface SvnActionPass {
  stage: SvnActionStage
  /** The run the stage waited on. */
  runId?: string
  startedAt: number
  endedAt: number
  /** `waited`: the action waited for the person at this stage, and a press moved it on. */
  result: 'done' | 'failed' | 'waited'
  /**
   * What its words need: the newest revision a review committed; the conflicts an update left; for
   * `fixing`, the conflicts of the set, how many Jamat's rules settled and how many were left open.
   * A commit and its verification name their root: its mount (`''` for the worktree) and repository URL.
   */
  facts?: { revision?: number; conflicts?: number; fixed?: number; left?: number; mount?: string; repository?: string }
}

/** One conflicted path of a conflict set: svn's facts and the classifier's plan, never words. */
export interface SvnActionConflictEntry {
  occurrenceId?: string
  /** Worktree-relative with '/'. */
  path: string
  kind: SvnConflictKind
  shape: SvnConflictShape
  state: SvnConflictState
  options: SvnConflictOption[]
  /** The lossless option the facts prove. */
  rule?: SvnConflictOption
  /** The svn facts the words are composed from at snapshot time. */
  facts: {
    reason?: SvnTreeReason
    action?: SvnTreeAction
    localKind?: SvnNodeKind
    incomingKind?: SvnNodeKind
    /** The revision the update brought. */
    incomingRevision?: number
    /** Worktree-relative: where the moved node lives now (`SvnTreeFacts.movedTo`). */
    movedTo?: string
    files?: SvnContentFacts['files']
    /** The conflicted property names. */
    properties?: string[]
    /** svn cannot take the name as an argument. */
    unsafe?: true
    /** The files below a settled path a guard found scheduled for deletion or missing. */
    dropped?: number
  }
  by?: SvnConflictActor
  /** The option a settled entry was settled with; absent when svn stopped marking it by other hands. */
  settledWith?: SvnConflictOption
  /** The step an option reached on this path; a restart or a second call resumes after it. */
  journal?: SvnConflictJournal
  /** Absolute path of the saved copy. */
  saved?: string
  /** Keep mine of incoming work, confirmed by the person in the window. */
  confirmedLoss?: true
}

/** Every conflict one update left, read together; the next update reads it again. */
export interface SvnActionConflictSet {
  readAt: number
  /** BASE before the update. */
  baseRevision: number
  /** BASE after it. */
  revision: number
  /** At most 200 (`SvnConflictFlow.entriesMaxConst`); the next read takes the rest from svn. */
  entries: SvnActionConflictEntry[]
  more: number
  /** The action waited on this set for the person, so Check again reads what they changed; a fresh read has none. */
  waited?: true
}

/** The caller's line of one wait, typed once by the notifier; see `SessionRecordSvnAction.notice`. */
export interface SvnActionNotice {
  id: string
  at: number
  /** Deliveries tried and refused (a draft, a dialog, a session that does not run). */
  attempts: number
  state: 'pending' | 'delivered' | 'expired'
  settledAt?: number
}

/** The merger of an SVN action; see `SessionRecordSvnAction.merger`. */
export interface SvnActionMerger {
  runId: string
  setAt: number
  startedAt: number
  endedAt?: number
  checkedAt?: number
}

/** A path Jamat's rules settled during an action, for the FIXED lines of its result. */
export interface SvnActionFixed {
  path: string
  option: SvnConflictOption
}

/** How the run a run stage waited on ended, written by the gate verdict and judged by the next client step. */
export type SvnActionVerdict =
  | { kind: 'succeeded'; exitCode?: number }
  | { kind: 'failed'; reason: string; exitCode?: number }

export interface WorkerHandoff {
  id: string
  key: string
  text: string
  at: number
  attempts: number
  state: 'pending' | 'delivered' | 'expired'
  settledAt?: number
}



export interface WorktreeUpdateUnit {
  target: SvnUpdateTarget
  phase: 'pending' | 'updated' | 'reconciling' | 'reconciled' | 'done'
  before?: Record<string, string>
  protectedMounts?: Array<{ path: string; url: string; repository: string }>
  definitions?: Record<string, string>
  parent?: number
  mappingChanged?: boolean
  runId?: string
}


export interface WorktreeUpdateState {
  actionId: string
  generation: string
  root: string
  revision: number
  cursor: number
  units: WorktreeUpdateUnit[]
  completed: boolean
}
