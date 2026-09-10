import type { SessionAgentId, SessionColorName } from '../sessionManagerApi.types'

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
   * before launch, equal to the Jamat session id, for a Claude `new` or `fork`; found afterwards from the rollout Codex wrote for a
   * Codex `new` or `fork`, and handed in by the caller for a `resume`. Absent means the record can
   * name no conversation, which is what every reopen and every fork is refused for.
   */
  nativeSessionId?: string
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
}

/**
 * How far a merge got. It is write-ahead evidence rather than a program counter: every call reads
 * the disk and continues from what is actually there, so this exists to be shown in the tree and to
 * be found again after a crash, not to be resumed from.
 */
export type SessionMergePhase = 'base-merging' | 'resolving' | 'main-merging' | 'tearing-down'

export interface SessionRecordMerge {
  phase: SessionMergePhase
  /** The session resolving the conflicts, once one was launched. */
  resolveSessionId?: string
  startedAt: number
  /** The last failure. The phase stays, because Merge run again continues from the disk. */
  failure?: string
}

export interface SessionRecordWorktree {
  worktreePath: string
  branch: string
  baseCommit: string
  repositoryRoot: string
}

/**
 * One step of a scripted shell. Unlike the `SetupStep` a resolution is made of, `cwd` here is
 * absolute and already inside the worktree: the record is what a launch is planned from, and a launch
 * has no repository root to resolve a relative step against.
 */
export interface SessionRecordSetupCommand {
  command: string
  cwd: string
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

export interface SessionRecord {
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
   * `tab` = this session is presented by its tab alone, so the tree draws it only under the tabs
   * scope. Mutable in one direction: promoting a plain tab clears it, and nothing ever sets it on a
   * session that was created for the tree.
   */
  presentation?: 'tab'
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
  /** On a resolve session only: whose merge conflict it was launched to settle. */
  resolveFor?: string
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
   */
  pendingSetup?: { setupSessionId: string }
  /** Primary record only: a worktree create that ran no setup - a marker, rather than silence. */
  setupSkipped?: { reason: string }
  /** Shell record only: run these instead of an interactive shell, each in its own directory. */
  commands?: SessionRecordSetupCommand[]
  /** Shell record only: the session this setup is preparing. */
  setupFor?: string
  /**
   * Somebody asked for this runtime to stop, so its exit code is not a verdict on what it was doing.
   * Written for every session, because that is the one fact a killed process cannot carry itself:
   * node-pty answers a kill with whatever the platform gives it, on Windows `0xC000013A` and on
   * POSIX a signalled 0 - one of which reads as a crash and the other as a clean finish. The two
   * judgements over a session somebody else is waiting on, the install gate and the merge resolver,
   * read it for exactly that reason, and so does the outcome.
   *
   * **Written for a resolver as well as for an install**, which it once was not: `stop()` marked
   * only records carrying `setupFor`, so a resolver somebody stopped was judged on the exit code
   * the platform gives a killed process - 0 on POSIX - and read as a clean resolution.
   */
  stopRequested?: true
}

export interface SessionRecordsDocument {
  schemaVersion: 1
  savedAt: number
  records: SessionRecord[]
}
