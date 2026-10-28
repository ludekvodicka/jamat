import type { WorktreeExecution } from '../../worktrees/worktreeExecution'
import type { AccountSegment, SessionAccountRef } from '../sessionAccounts'
import type { SessionRecordConflictMemory, SvnActionConflictSet } from '../../worktrees/worktreeContracts'
export type { SessionRecordConflictMemory, SvnActionRoot, SvnActionConflicts, SvnActionPass, SvnActionConflictEntry, SvnActionConflictSet, SvnActionNotice, SvnActionMerger, SvnActionFixed, SvnActionVerdict } from '../../worktrees/worktreeContracts'
import type { SessionRecordSetupCommand, SessionRecordProcess, SessionRecordScriptStep } from '../sessionScriptTypes'
export type { SessionRecordSetupCommand, SessionRecordProcess, SessionRecordScriptStep } from '../sessionScriptTypes'
import type { WorktreeLifecycle } from '../../worktrees/worktreeState'
import type {
  SessionAgentId,
  SessionColorName,
  SessionParentKind,
  SessionScriptId,
  SessionScriptPhase,
  SessionSetupAgreement,
  SessionWorktreeKind,
  SessionWorktreeOutcome,
  SvnActionKind,
  SvnActionNeed,
  SvnActionStage,
  SvnFinishPhase,
  SvnLabelledRevision,
} from '../sessionManagerApi.types'

/**
 * What the client remembers about a session, and the only evidence one ever existed: AppHost keeps
 * no registry across restarts, so a record with no runtime behind it is a session to reopen, not a
 * session that is gone.
 */
export type SessionLife = 'starting' | 'live' | 'ended' | 'lost'

/**
 * The Host's own words for how a runtime ended. It mirrors `RuntimeSessionInfo['exitReason']` by
 * hand rather than importing it: records are the client's. Both halves of the check live in
 * `Reconciler.exitReasonOf` - an assignment the build catches a drifted wire on, and a comparison
 * the run catches a newer Host on.
 */
export type SessionExitReason = 'process-exit' | 'stopped' | 'host-lost' | 'spawn-failed'

export type SessionDirectoryRef =
  | { mode: 'project'; categoryId: string; projectPath: string }
  | { mode: 'adHoc'; path: string }
  | { mode: 'default' }

export interface SessionRecordAgent {
  accountId?: string
  /** The latest launch keeps its profile while a switch selects the next account. Absent means accountId. */
  launchAccountId?: string
  agentId: SessionAgentId
  /**
   * The command line this session was asked to start with, so a replayed create can repeat exactly
   * that one. It says nothing about whether the session has ever run - a create that never happened
   * and a session that has been running for an hour both keep the mode their caller chose. What
   * separates those two is `SessionRecord.pendingOperationKind`, which names the operation in flight.
   */
  launchMode: 'new' | 'continue' | 'resume' | 'fork'
  /**
   * The conversation this session is holding, however it came to be known: minted by the client
   * before launch, equal to the Jamat session id, for a Claude `new` or `fork`, until the running
   * Claude reports another through the status line relay; confirmed by the launch bridge for a
   * Codex `new` or `fork`, and handed in by the caller for a `resume`. Absent means the record can
   * name no conversation, which is what every reopen and every fork is refused for.
   */
  nativeSessionId?: string
  /**
   * Who named `nativeSessionId`: `provided` by the caller of a resume, or confirmed by the running
   * agent for this launch generation (`identityLaunchId`): the Codex app-server bridge, or the Claude
   * status line relay, which reports the conversation Claude Code actually writes (UA1-J14-1).
   * Absent: minted before launch and never confirmed.
   */
  nativeSessionIdSource?: 'provided' | 'codex-app-server' | 'claude-statusline'
  unverifiedNativeSessionId?: string
  identityLaunchId?: string
  identitySequence?: number
  forkParentId?: string
  /** Part of the command line, so it is kept for the same reason `launchMode` is: replay. */
  initialPrompt?: string
  /**
   * The model this session was founded on: the one its caller named, or - where it named none - what
   * this machine's own setting resolved to at create. Part of the command line and kept for exactly
   * the reason `initialPrompt` is: a replayed create has to repeat the same one, and the live
   * setting it would otherwise fall back to may have moved since.
   *
   * It is also the ONLY place a Claude session's context TIER is written down, and that is why the
   * local setting is resolved into it rather than left for the launch to read. A Claude transcript
   * records the bare id the API answered with, `claude-opus-5`, and never the `[1m]` the launch
   * asked for, so a session read without this field draws a fifth of the window it is running on.
   *
   * A reopen still names no model at all - that rule belongs to the launch, not to this field.
   */
  model?: string
  /**
   * Print mode: the agent answers its one turn and the process exits, so the run can be judged by
   * how it ended. Internal - it is never accepted from the wire, because a session a person started
   * is not one anybody is waiting on the exit code of.
   */
  oneShot?: true
  /**
   * Internal like `oneShot`, and never YOLO whatever the setting says: the SVN conflict resolver
   * (`accept-edits`) edits files and runs no command; the interactive SVN merger (`merger`) edits
   * files, runs the two Jamat commands that read and settle conflicts, never `svn`, and asks the
   * person for anything else.
   */
  permission?: 'accept-edits' | 'merger'
}

/**
 * How far a merge got. It is write-ahead evidence rather than a program counter: every call reads
 * the disk and continues from what is actually there, so this exists to be shown in the tree and to
 * be found again after a crash, not to be resumed from.
 */
export type SessionMergePhase = 'base-merging' | 'resolving' | 'main-merging' | 'tearing-down'

export interface SessionRecordMerge {
  phase: SessionMergePhase
  revisions?: string[]
  mergedRevision?: string
  discard?: true
  changes?: true
  approval?: { selection: string[]; message: string; hashes?: Record<string, string> }
  runs?: { phase: 'commit' | SessionMergePhase; runId: string; startedAt: number; endedAt?: number; failed?: true }[]
  endedAt?: number
  /** The session resolving the conflicts, once one was launched. */
  resolveSessionId?: string
  startedAt: number
  /** The last failure. The phase stays, because Merge run again continues from the disk. */
  failure?: string
}

export interface SessionRecordSetupBaseline {
  at: number
  hashes: Record<string, string>
  inputs?: string
  /** Each dependency input's content hash at setup (`SetupInputs.of`); absent on records before 3.15. */
  inputHashes?: Record<string, string>
  commands?: string
}

export interface SessionRecordWorktree {
  worktreePath: string
  /** git: the branch; svn: the checked-out URL. */
  branch: string
  /** git: the commit; svn: `r<rev>`. */
  baseCommit: string
  /** git: the repository root; svn: the owner directory, which is the main copy. */
  repositoryRoot: string
  /** Absent means git: every record and every peer older than SVN worktrees. */
  kind?: SessionWorktreeKind
  /** svn: `dev:ino:birthtimeNs` of the checkout, so a removal never deletes a reused name. */
  directoryId?: string
  /** Preservation belongs to this directory, including retries under a different cleanup action. */
  preservationActionId?: string
  /**
   * svn: where the session's directory lies below the owner, '/'-separated; absent at the owner
   * itself and on every record older than 3.11. The session starts in `worktreePath` joined with it.
   */
  cwdSubpath?: string
  /** Frozen at creation; absent on legacy worktrees, whose recorded owner keeps the old setup. */
  setupScope?: 'project' | 'members'
  /** What the create's caller asked of the results: its tag and its wake-up line. */
  caller?: SessionRecordWorktreeCaller
  conflictMemory?: SessionRecordConflictMemory
  setupBaseline?: SessionRecordSetupBaseline
  agentStartedAt?: number
}

/** The create's `worktree.tag` and `worktree.notify`, kept for every result the worktree writes. */
export interface SessionRecordWorktreeCaller {
  tag?: string
  notify?: { sessionId: string; text: string }
}

/**
 * How far an SVN finish of a build before 3.11 got. Nothing writes it any more: a record loaded with
 * one reads as an `interrupted` outcome, and the next Finish starts an SVN action.
 */
export interface SessionRecordWorktreeFinish {
  phase: SvnFinishPhase
  scopeRoot?: string
  commitSessionId?: string
  startedAt: number
}

/**
 * The tombstone of a removed worktree: where the work went. A record carrying it is never reopened,
 * restarted or forked, because its directory is gone and the project directory is not a substitute.
 */
export interface SessionRecordRetiredWorktree {
  worktreePath: string
  kind: SessionWorktreeKind
  revisions: readonly string[]
  removedAt: number
  /** svn: the identity the checkout had, so a result written after the removal still names it. */
  directoryId?: string
  /** The caller of the removed worktree, so a later result still carries its tag. */
  caller?: SessionRecordWorktreeCaller
  /** svn: the main copy the worktree was cut from; absent on records older than 3.11. */
  ownerDir?: string
  /**
   * A landed row: what the worktree committed, which the main copy must hold before the session goes
   * by itself. Written with `ownerDir` by the ending of a committed Finish or cleanup; such a record
   * is not `completed`, so the daily view shows it.
   */
  landed?: SvnLabelledRevision[]
}

/** What asked for the removal of an SVN worktree after its session's process ended. */
export type SessionWorktreeCleanupTrigger =
  | 'committed' | 'removal-unfinished' | 'discard-unfinished' | 'remove-when-ended' | 'requested'

/**
 * The removal of an SVN worktree once its session's process ended, judged by the reconciler and
 * applied off its loop. `pending` is judged again, paced by `attempts` and `lastAttemptAt`; `kept`
 * found changes and is never judged again until a new trigger writes `pending`.
 */
export interface SessionRecordWorktreeCleanup {
  phase: 'pending' | 'kept'
  trigger: SessionWorktreeCleanupTrigger
  /** Why the worktree is still there: `unlanded r<N>: <paths>`, `in use`, `<N> changes`, `svn status failed: ...`. */
  reason?: string
  requestedAt: number
  attempts: number
  lastAttemptAt?: number
}

/**
 * The link from a script run to the session it runs for. A run is a runtime judged by its exit code
 * on behalf of its parent; this one field is how every reader tells a run from an ordinary session.
 */
export interface SessionRecordScriptLink {
  /** The parent. */
  sessionId: string
  phase: SessionScriptPhase
  scriptId: SessionScriptId
  /** 'setup' for the worktree setup, the entry name of a declared script, 'resolver' for either resolver. */
  name: string
  /** Chain steps only: the `SessionRecordScriptStep.key` this run attempts. */
  stepKey?: string
  /** The parent reopened; this run may still need stopping, but cannot enter its new history. */
  historyExpired?: boolean
}

/** The session that started this one, as its creator stated it; see `SessionCreateSpec.parent`. */
export interface SessionRecordParentLink {
  sessionId: string
  kind: SessionParentKind
}

/** A commit made from a session's commit split or into its worktree, written when the commit dialog settles. */
export interface SessionRecordCommitReceipt {
  scopeRoot: string
  /** Null: TortoiseSVN closed, which proves nothing. */
  revision: number | null
  /** Relative to `scopeRoot`, '/'-separated, at most 200 (`SessionLifecycle.receiptPathsMaxConst`). */
  paths: string[]
  at: number
}

/**
 * Finish (Commit) or Discard of an SVN worktree, or the UPDATE of a main copy, as a chain of stages
 * (`SvnActionFlow`). Run stages
 * wait on `runId` through the `action` gate; client stages are driven by this client and resumed
 * from the disk after a restart.
 */
export interface SessionRecordSvnAction extends WorktreeExecution {
  kind: SvnActionKind
  /** Also the name of its result. */
  actionId: string
  stage: SvnActionStage
  /** Every conflict the last update left, all kinds; an update that leaves none clears it. */
  conflictSet?: SvnActionConflictSet
  /** The review the current review run opened. */
  rounds: { incoming: number; outOfDate: number; lock: number }
  needs?: { kind: SvnActionNeed; reason: string; at: number }
}

/** The before gate on a parent; see `SessionRecord.pendingSetup`. `steps` and `cursor` come together. */
export interface SessionRecordPendingSetup {
  local?: true
  setupSessionId: string
  agreement?: SessionSetupAgreement
  steps?: SessionRecordScriptStep[]
  cursor?: number
}

/** How an after chain of a Finish ended: every step passed, or the step at the cursor failed. */
export type SessionRecordFinishChecksResult =
  | { kind: 'passed'; at: number }
  | { kind: 'failed'; reason: string; at: number }

/** The after chain of a Finish press on a parent; see `SessionRecord.finishChecks`. */
export interface SessionRecordFinishChecks {
  /** The run judged now, or the last run of an ended chain. */
  runId: string
  steps: SessionRecordScriptStep[]
  cursor: number
  startedAt: number
  /** Absent while the chain runs. */
  result?: SessionRecordFinishChecksResult
}

/** Where a run's output went: a saved log file, or why there is none. */
export type SessionRecordScriptLog =
  | { state: 'saved'; bytes: number; truncated: boolean }
  | { state: 'unavailable'; reason: string }

/**
 * A history entry on the parent: one run attempt, written when the run settles. It outlives the run's
 * own record, which goes once nothing waits on it, so it is what says afterwards how the run went.
 */
export interface SessionRecordScriptRun {
  runId: string
  phase: SessionScriptPhase
  scriptId: SessionScriptId
  name: string
  title: string
  /** Chain steps only. */
  stepKey?: string
  /** A display copy, at most 8 of at most 300 characters each; the log header keeps them in full. */
  commands: string[]
  startedAt: number
  endedAt: number
  exitCode?: number
  outcome: 'succeeded' | 'failed' | 'stopped' | 'lost'
  reason?: string
  log: SessionRecordScriptLog
}

/**
 * A pending launch the Host keeps refusing without deciding, and how long that has been going on.
 *
 * It exists so a refusal that stands can be paced and said out loud. `OperationOutcomes.decided`
 * leaves such a launch pending on purpose - the ceiling lifts, the lease comes back, the restarted
 * Host publishes its descriptor - but a record carrying nothing about the refusal is replayed on
 * every reconcile pass for ever, silently. `LaunchBackoff` reads both halves: `attempts` and
 * `lastAttemptAt` decide when the next replay is due, and `reason` is what the row shows meanwhile.
 *
 * Written and cleared with the pending pair: a launch that lands, ends or is lost has nothing left
 * to wait for.
 */
export interface SessionRecordLaunchWait {
  attempts: number
  lastAttemptAt: number
  /** The Host's own words for the last refusal, carried verbatim the way `endedReason` is. */
  reason: string
}

export interface SessionRecordActionHistory {
  key: string
  startedAt: number
  endedAt: number
  source: Pick<SessionRecord, 'svnAction' | 'worktreeMerge' | 'finishChecks' | 'worktree' | 'worktreeOutcome'>
  outcome?: SessionWorktreeOutcome
  /** The Finish ended by Back to work; `checks-stopped` where its checks were running then. Absent: any other ending. */
  ending?: 'checks-stopped' | 'back-to-work'
}

export interface SessionRecord {
  account?: SessionAccountRef
  accountSegments?: AccountSegment[]
  lastUserInputAt?: number
  /** Equals `runtimeSessionId` on the Host, forever. The Host separates instances by binding. */
  sessionId: string
  kind: 'shell' | 'agent'
  title: string
  directory: SessionDirectoryRef
  agent?: SessionRecordAgent
  /** The effective cwd at the first agent launch. Immutable transcript provenance. */
  transcriptCwd?: string
  /** Which flow composed this session. Stored and never read by this library; see the spec's field. */
  flowId?: string
  /**
   * The control operation id of the sessions.create that made this record, so a caller whose create answer was lost
   * finds its session by exact identity. Absent for fork, history open, internal runs, adopted orphans and older
   * records. Unlike pendingOperationId (the Host's launch id), it is never cleared.
   */
  callerOperationId?: string
  /**
   * The colour somebody gave this session. It rides on the record rather than in the client's own
   * state because it follows the session: a tab closed and reopened, a session drawn in the tree and
   * on a tab at once, and a second window all have to show the same one, and the snapshot is what
   * already carries a session's facts to every one of those places.
   */
  color?: SessionColorName
  /**
   * The person's note about this session. Beside `color` and on the record for the same reason:
   * it follows the session through tabs, the tree and a second window via the snapshot.
   */
  note?: string
  worktree?: SessionRecordWorktree
  /** Present only while this session's worktree is being merged back. Cleared by the teardown. */
  worktreeMerge?: SessionRecordMerge
  /** Written by builds before 3.11 only; see `SessionRecordWorktreeFinish`. */
  worktreeFinish?: SessionRecordWorktreeFinish
  /** An SVN action of this session's worktree, running or waiting for the person. */
  svnAction?: SessionRecordSvnAction
  /** The result of the last finish of this record; a later finish replaces it. */
  worktreeLifecycle?: WorktreeLifecycle
  worktreeOutcome?: SessionWorktreeOutcome
  /** Closed action sources, oldest first; cleared after the session and its open actions end. */
  actionHistory?: SessionRecordActionHistory[]
  /** Cleared sections still derivable from operational state must not reappear after a write or restart. */
  clearedWorkflowIds?: string[]
  /** Set once the worktree was removed, together with `worktree` going. */
  retiredWorktree?: SessionRecordRetiredWorktree
  /** SVN only: the worktree goes once the process ended; the removal clears it with `worktree`. */
  worktreeCleanup?: SessionRecordWorktreeCleanup
  /** On a script run only: the session it runs for, and which script it is. */
  scriptOf?: SessionRecordScriptLink
  /** Set at create, never changed. Absent = no parent, so no migration. Removing the parent leaves it. */
  parent?: SessionRecordParentLink
  /**
   * On a parent only: its settled runs, oldest first; cleared after the session and its open actions end.
   */
  scriptRuns?: SessionRecordScriptRun[]
  /** Oldest first, at most 50 (`SessionLifecycle.commitReceiptsMaxConst`). */
  commitReceipts?: SessionRecordCommitReceipt[]
  binding: { hostInstanceId: string; generation: number } | null
  life: SessionLife
  /**
   * The person's own verdict that this session is done with, which is a different question from
   * whether anything is running: `life` is what the Host says, this is what the person says. It is
   * what the daily view filters on and what keeps the restart chain's set small.
   */
  completed?: true
  /** Written before the wire call, so a crash between the write and the answer replays the same id. */
  pendingOperationId?: string
  /**
   * Which operation that id belongs to. A create replays the create's command line and a reopen
   * replays the resume it had already chosen, and nothing else in the record can tell them apart.
   * The two fields are written and cleared together; a record carrying only the id is replayed as
   * nothing at all, because what it was asking for is no longer knowable.
   */
  pendingOperationKind?: 'create' | 'reopen'
  /**
   * The pending reopen restores a session that lived until its Host stopped (a Host restart, or a
   * worker's liveness resume), so its history and runs go on. Only a person's Reopen starts empty.
   */
  pendingKeepsHistory?: true
  /**
   * Set only while a pending launch is being refused by a Host that decided nothing. Absent means
   * either that no launch is pending or that the one that is has not been refused yet.
   */
  launchWait?: SessionRecordLaunchWait
  createdAt: number
  endedAt?: number
  exitCode?: number
  /**
   * How the Host says the runtime ended. The second witness beside `stopRequested`, and the one that
   * covers a stop this record never asked for, so a client that died between the stop and its own
   * write still reads the ending correctly. Written by `mark-ended`.
   */
  exitReason?: SessionExitReason
  /** Why this record ended without the Host ever running it. Set only where no runtime existed. */
  endedReason?: string
  /**
   * Primary record only: this session's own launch is waiting for a setup session to finish. A
   * starting record carrying it is never replayed - its setup is judged instead. Success clears it;
   * failure leaves it on the ended record, where it is both the link to the setup session and the
   * only marker `retrySetup` has to work from, and where the reconciler never looks at it again.
   *
   * `steps` is the before chain resolved when it started (the setup, then the declared before
   * scripts) and `cursor` the step `setupSessionId` attempts. A wait written before chains existed
   * has neither and is one setup step.
   */
  pendingSetup?: SessionRecordPendingSetup
  /**
   * Primary record only: the project's `scripts.after` that a Git Finish press runs before the finisher.
   * Without `result` the chain runs and the Finish waits; a pass counts only until the session runs
   * again, so every bind and a reopen clear it.
   */
  finishChecks?: SessionRecordFinishChecks
  /** Primary record only: a worktree create that ran no setup - a marker, rather than silence. */
  setupSkipped?: { reason: string }
  /** Shell record only: run these instead of an interactive shell, each in its own directory. */
  commands?: SessionRecordSetupCommand[]
  /** Shell record only, never together with `commands`: spawn this tool directly in the record's directory. */
  process?: SessionRecordProcess
  /**
   * Somebody asked for this runtime to stop, so its exit code is not a verdict on what it was doing.
   * Written for every session, because that is the one fact a killed process cannot carry itself:
   * node-pty answers a kill with whatever the platform gives it, on Windows `0xC000013A` and on
   * POSIX a signalled 0 - one of which reads as a crash and the other as a clean finish. The two
   * judgements over a session somebody else is waiting on, the install gate and the merge resolver,
   * read it for exactly that reason, and so does the outcome.
   *
   * **Written for a resolver as well as for an install**, which it once was not: `stop()` marked
   * only setup runs, so a resolver somebody stopped was judged on the exit code
   * the platform gives a killed process - 0 on POSIX - and read as a clean resolution.
   */
  stopRequested?: true
  manuallyStoppedAt?: number
}

export interface SessionRecordsDocument {
  schemaVersion: 1
  savedAt: number
  records: SessionRecord[]
}
