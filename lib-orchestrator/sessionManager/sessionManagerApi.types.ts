/**
 * The wire surface of the sessions subsystem, mirroring `projectManagerApi.types.ts`: it imports
 * nothing but its sibling wire-type file and the Host's own wire types, and never runtime code,
 * because the renderer's TypeScript program compiles it. A `node:` import or a sibling module here
 * stops the web build. The Host's types are safe to name for the same reason: `import type` is
 * erased, and `hostWire.ts` has no imports of its own to drag in behind it. The same argument admits
 * `agentWorkInspector.types.ts`, the data-only vocabulary of the work-state classifier, and
 * `svn/svn.types.ts`, whose conflict kinds, options and losses the conflict list names: no runtime
 * code, no imports of their own.
 */
import type { SvnConflictKind, SvnConflictLoss, SvnConflictOption } from '../svn/svn.types'
import type { AgentWorkHint } from './workState/agentWorkInspector.types'
import type {
  HostWsServerMsg,
  RuntimeChannel,
  RuntimeRef,
  RuntimeSessionInfo,
  WireVersion,
} from '../../app-host/app/wire/hostWire.js'
import type { FileChangesVcsId } from '../fileChangesManager/fileChangesManagerApi.types'
import type { ProjectBinding } from '../projectManager/projectManagerApi.types'

/**
 * Which agent a session runs. Named here rather than written out at each of its fifteen uses, the
 * way `RateAgentId`, `SessionModelAgentId`, `TerminalDetectorAgentId` and their siblings are named
 * in their own subsystems: a wire type of one subsystem never imports another's.
 */
export type SessionAgentId = 'claude' | 'codex'

/** Who started a session, as its creator states it. Display only: nothing waits, wakes or stops by it. */
export type SessionParentKind = 'worktree' | 'ticket' | 'worker'

export interface SessionCreateSpec {
  kind: 'shell' | 'agent'
  directory:
    | { mode: 'project'; categoryId: string; projectPath: string }
    | { mode: 'adHoc'; path: string }
    | { mode: 'default' }
  agent?: {
    agentId: SessionAgentId
    /** V1's cc / ccc / resume / resume-fork, named for what they do. */
    mode: 'new' | 'continue' | 'resume' | 'fork'
    /**
     * The conversation this launch is to run under. `resume` needs it, for either agent. Claude also
     * takes it on `new` and `fork`, both of which start a conversation that does not exist yet and
     * can be told its id in advance.
     *
     * **A Codex `new` or `fork` carrying it is refused as `invalid-spec`**: Codex names its own
     * conversations and reports the name afterwards, so an id supplied here would be stored unproven
     * and then trusted by every reopen and every transcript reader.
     */
    nativeSessionId?: string
    forkParentId?: string
    /**
     * What the agent is asked first, handed to it as a positional argument. It travels in the record
     * because a replayed create has to repeat the same command line, and the first PTY write cannot:
     * it would need an attach that does not exist, timed against a boot nobody is watching.
     */
    initialPrompt?: string
    /**
     * The model this session is to be FOUNDED on, overriding whatever the machine that runs it has
     * configured. Remote-only in practice: the local path never sets it, because a person choosing
     * on their own computer changes the setting instead.
     *
     * It travels only to a target that offered `agents.describe`. An older one validates this body
     * with exact keys and refuses the whole request over a key it does not know, so the capability
     * is the version marker of the feature rather than a hint. Absent means the target composes the
     * model from its own settings, exactly as it did before this field existed.
     */
    model?: string
  }
  /**
   * The worktree of the session's directory: in `checkpoints` mode inside an SVN working copy any
   * directory, which checks out its product group, else its catalog project, else itself, and the
   * session starts at its place below (`WorktreeOwner`); otherwise a catalog project only.
   *
   * `owner` (dormant, pp 7.3 only) names the directory an SVN worktree checks out instead: the
   * project or a directory below it, where the session starts. `removeWhenEnded` (dormant, pp 7.3
   * only) has an SVN worktree removed once the session's process ended and nothing is left in it; a
   * Git worktree ignores it and keeps its Finish. Register: `lib-orchestrator.md`, dormant code.
   *
   * `tag` is the caller's opaque word (`SessionLimits.worktreeTagShape`), echoed on every result of
   * the worktree. `notify` names a local session that gets `text` typed once into its empty composer
   * when a result is written. A build before 3.11 refuses both by name (exact keys).
   */
  worktree?: {
    slug: string
    baseRef?: string
    owner?: string
    removeWhenEnded?: true
    tag?: string
    notify?: { sessionId: string; text: string }
  }
  /** Local only; wakes the target on end or a move into a named group. Version marker: sessions.notifies. */
  notify?: { sessionId: string; text: string; onGroups: string[] }
  /**
   * The session that started this one, set at create and never changed. Local only; version marker
   * sessions.children. A build before 3.13 refuses the key (exact keys).
   */
  parent?: { sessionId: string; kind: SessionParentKind }
  title?: string
  /**
   * The number this session is to carry INSTEAD of one from the project's counter: `i34` for issue
   * 34. `SessionTitle.customNumberConst` is the shape, one to three letters then up to six digits,
   * and the letters are the whole of the mechanism - they make the token unreadable as a count, so
   * nothing the project counts moves and no session is numbered twice because of one.
   *
   * **Digits alone are refused here.** An allocated number is the answering computer's to hand out,
   * and a title claiming one is still judged against what that project has already issued; this
   * field is for the token the counter will never produce.
   *
   * It is the caller for whom the number MEANS something that wants this - a skill opening a
   * session per ticket - so unlike the counter's number it applies to a plain tab and to an ad-hoc
   * directory too: neither of those has a count for it to disturb.
   *
   * The create body is validated with exact keys, so a target that predates this field refuses the
   * whole request as `invalid-request` rather than dropping the number. A caller that may be
   * talking to an older computer therefore omits it, exactly as it does for `color`.
   */
  number?: string
  /**
   * The colour this session is BORN with, as a name from the closed set `SessionColors` keeps.
   *
   * Here rather than through a second call, because the caller that wants one is a scheduler: it
   * creates a wave of sessions beside the person's own, and a colour set afterwards means every
   * worker appears uncoloured first and costs a second round trip to repaint. What the colour is
   * FOR is exactly that - telling automatic work from a person's at a glance in the tree - so a
   * session that flashes uncoloured has already failed at it once.
   *
   * The create body is validated with exact keys, so a target that predates this field refuses the
   * whole request as `invalid-request` rather than ignoring the colour. A caller that may be talking
   * to an older computer therefore omits it, exactly as it does for `agent.model`.
   */
  color?: SessionColorName
  /**
   * Which flow composed this session, if one did. Opaque here on purpose: the library stores it and
   * never branches on it, so a new flow is a change to the renderer's catalog and to nothing else.
   */
  flowId?: string
  /**
   * The hash of the commands the person was shown and agreed to run. It covers every command the
   * project's `.worktree.json` authors - `setup` and both `scripts` phases - not only the setup the
   * name says. Present only on the second attempt, after a create came back `setup-not-acknowledged`
   * carrying that hash: the first attempt is what asks the question, this is the answer travelling
   * back with it.
   */
  acknowledgeSetup?: string
}

/** Facts of the control request that created a session, never of its spec, so a caller cannot write them. */
export interface SessionCreateOrigin {
  callerOperationId: string
}

export interface SessionHistoryOpenSpec {
  directory: Extract<SessionCreateSpec['directory'], { mode: 'project' }>
  agentId: SessionAgentId
  nativeSessionId: string
  /** The provider's own display name, used only when no V3 record exists yet. */
  providerName: string
  /** Claude's provider can prove a live process; Codex activity is recovered from V3 records. */
  providerActive: boolean
  /** Absent keeps the launcher's automatic resume/fork choice. */
  action?: 'rerun' | 'fork'
}

/** The local half of one provider-history row, joined by agent and native conversation id. */
export interface SessionHistoryReference {
  sessionId: string
  agentId: SessionAgentId
  nativeSessionId: string
  title: string
  titleParts: SessionTitleParts
  life: SessionInfo['life']
  /** When this record's runtime ended, null while it runs or where no ending was ever recorded. */
  endedAt: number | null
}

/** `starting` is hostControl's overlay while a launch is in flight, not a transport fact. */
export type HostPresence = 'running' | 'starting' | 'unreachable'

export interface HostStatusInfo {
  presence: HostPresence
  hostVersion: string | null
  hostInstanceId: string | null
  liveCount: number
  lastStartError: string | null
  /**
   * The Host's memory as the Host item's tooltip says it. Absent from an older peer, null before the
   * first reading of the current Host. It moves only when a new reading arrives, never per poll.
   */
  memory?: HostMemoryReading | null
}

/** Every word is composed by `HostMemoryReadings`; a surface draws the lines and marks the warning. */
export interface HostMemoryReading {
  lines: string[]
  /** Null, or the short reason the growth looks like a leak. */
  warning: string | null
  /** What the item's own text gains while `warning` is set, so the warning is visible without hovering. */
  suffix: string | null
}

export type SessionActivity = 'working' | 'waiting' | 'idle' | 'unknown'

/**
 * A more precise shape of an activity without widening the mandatory activity wire. An older peer
 * ignores this optional field and still reads background work as `working`; a current surface can
 * distinguish it without making yesterday's strict activity validator reject the whole snapshot.
 */
export type SessionActivityDetail = 'background'

/**
 * What colour a session was given, as a NAME. The values behind these names are the renderer's and
 * live in its tokens file alone, which is what lets a surface theme them and what keeps this library
 * out of the business of knowing what `red` looks like. The twelve are the names the window palette
 * already uses, so this tree has one colour vocabulary rather than two.
 *
 * Absent means None. There is no `'none'` member on purpose: a session without a colour has no
 * colour, and a name for that would be a second way to say the same thing.
 */
export type SessionColorName =
  | 'red' | 'orange' | 'amber' | 'green' | 'teal' | 'cyan'
  | 'sky' | 'blue' | 'indigo' | 'violet' | 'magenta' | 'rose'

/**
 * Which section of the sessions tree a session was put in BY HAND, as the id of one of the groups
 * that computer has.
 *
 * It was a union of six names until 2026-09-22, when the sections became something a person adds to,
 * renames and reorders in the settings window. A union cannot survive that: the list is now a value
 * in the client's config, and a type that only the six seeded names satisfied would refuse the
 * section the tree beside it is drawing. So what travels is an id, and what an id may LOOK like is
 * `SessionGroups`, which every package can answer alike; whether one EXISTS is a question only the
 * client holding the list can answer, and it answers it by refusing the write.
 *
 * Two ids are structural and always present. `'none'` is the absence of a group, which is itself a
 * choice - a session put back into Sessions on purpose outranks what its project says - and
 * `'pinned'` is what the older pin-only surfaces write. Both can be MOVED, which is how a person
 * decides where the other sections sit around Sessions; neither can be removed or renamed.
 *
 * The ORDER is not here either. That is what a person sees and now edits, and it belongs with the
 * list itself, in the config section the client owns.
 */
export type SessionGroup = string

/**
 * What may sensibly be done to a session right now, decided here rather than by whoever draws the
 * button. The rules are all in the record - whether the conversation has an id, what the life is,
 * what other flow is holding it - and a surface that re-derived them would be a second copy of this
 * library's refusals, drifting from the first the day one of them changes.
 *
 * `compact` is in the list although this library does not perform it: typing a slash command into a
 * terminal is keystrokes, and the client owns those. What is asked here is only whether the session
 * is one where compacting means anything, which is a question about the record.
 *
 * The last four are the sessions tree's own row actions, and they are HERE since 2026-08-24. The
 * row decided them itself until then, from four fields of `SessionInfo`, and had already drifted
 * twice: it drew Rerun for sessions that answered `cannot be reopened`, and it drew Discard
 * worktree while a resolver was still standing in that directory - a second session whose life the
 * primary record says nothing about. A button whose only answer is a refusal is worse than no
 * button, which is the rule the row's own comment states and could not keep.
 */
/**
 * What a rename left for the caller to do, answered by the library rather than re-derived by
 * whoever drew the field.
 *
 * One behaviour - the agent behind a session should learn its new name - was split down the
 * middle by agent: Claude's half wrote the transcript here, and Codex's half was a condition and
 * a command string in the details overlay. A third agent, or a change to when Codex will take
 * the command, had to be made in both, and nothing joined them - the two files are never
 * compiled as one statement.
 *
 * `notifyAgent` is the same shape as `compact` in `SessionOperation`: typing into a terminal is
 * keystrokes and the client owns those, but WHETHER there is anything to type, and what, is a
 * question about the record.
 */
export interface SessionDetailsSaved {
  /** True only where the update carried a name and that name moved the title. */
  titleChanged: boolean
  /** Text to type into this session's terminal, or null where there is nothing to tell. */
  notifyAgent: { text: string } | null
}

export type SessionOperation =
  | 'fork'
  | 'newBeside'
  | 'restart'
  | 'compact'
  | 'finalize'
  | 'remove'
  | 'discardWorktree'
  | 'retrySetup'
  /** A landed row: update the main copy that lacks the revisions its worktree committed. */
  | 'updateMain'

export interface SessionMergeInfo {
  phase: 'base-merging' | 'resolving' | 'main-merging' | 'tearing-down'
  /** The session resolving the conflicts, which the tree nests under the one being merged. */
  resolveSessionId?: string
  /** The last failure, if there was one. The phase stays: Merge again continues from the disk. */
  failure?: string
  startedAt: number
}

/**
 * What the working copy under a session's directory looks like right now.
 *
 * It is keyed by that directory rather than by the session, because sessions of one project share
 * one: the fact is measured once per root and worn by every session standing in it. Absent means
 * unmeasured or governed by no VCS at all, and absence is deliberately not a measurement - a row
 * with nothing to say draws nothing rather than claiming to be clean.
 *
 * Up to thirty seconds (git) or sixty (svn) old. It is a preview for what a row draws and what the
 * Finish label promises; the operations themselves read the disk when they run.
 */
export interface SessionVcsInfo {
  vcsId: FileChangesVcsId
  dirty: boolean
}

export type SessionWorktreeKind = 'svn' | 'git'

/** What Finish offers for a worktree, composed by the library; a surface never derives it from the kind. */
export type SessionFinishChoice = 'commit' | 'merge' | 'keep' | 'discard'

/** One press of Finish on a worktree: the choice, what the person agreed to, and where it came from. */
export interface SessionFinishPress {
  choice: SessionFinishChoice
  /** The hash of the command agreement the press answers. */
  acknowledgeSetup?: string
  /** The person finishes a session that is still working. */
  confirmWorking?: true
  /** Commit on a conflict wait only: start the merger for what is left (Resolve with agent). */
  agent?: true
  requestedBy: 'window' | 'cli' | 'peer'
}

export type SvnFinishPhase = 'updating' | 'reviewing' | 'main-updating' | 'removing'

export type SvnFinishResult = 'committed' | 'partial' | 'not-committed' | 'out-of-date'
  | 'updated' | 'conflict' | 'nothing' | 'failed' | 'interrupted'

export type SvnFinishMainResult = 'none' | 'updated' | `merged:${number}` | `conflict:${number}` | 'failed'

export type SvnFinishWorktreeResult = 'removed' | 'kept' | 'in-use' | 'undeleted'

/**
 * How a revision of an SVN action is known to be this worktree's: a commit receipt the log confirmed,
 * the worktree's own BASE, or the log of the paths the action saw changed. No label decides a removal.
 */
export type SvnRevisionLabel = 'receipt' | 'base-proof' | 'inferred'

export interface SvnLabelledRevision {
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
  | 'stopping' | 'evidence' | 'checks' | 'updating' | 'cleaning' | 'resolving' | 'merging' | 'verifying' | 'fixing'
  | 'diffing' | 'reviewing' | 'removing' | 'recording'

/** `update-main` runs in a main copy, on the session that started it, which may hold no worktree. */
export type SvnActionKind = 'finish' | 'discard' | 'update-main'

/** Why an SVN action waits for the person; Finish again, Keep and Discard are the ways on. */
export type SvnActionNeed =
  | 'check-failed' | 'conflict' | 'resolver-failed' | 'incoming' | 'out-of-date' | 'review-cancelled'
  | 'review-interrupted' | 'partial' | 'pinned-external' | 'locked' | 'svn-failed' | 'not-stopped'

/** A count of one step's work; `total` is null while it is not known yet (a count still running). */
export interface SessionStepProgress {
  done: number
  total: number | null
}

/**
 * What this client does for a session now, in the library's words: a client step of an SVN action,
 * the removal after the session's end, or the last output line of a running scripted run. Present
 * only while that work runs, so an idle snapshot never moves for it.
 */
export interface SessionStepInfo {
  /** "Reading what the update brought in", "Removing the worktree", or a run's last output line. */
  text: string
  /** The exact work: "svn log -v --xml -r4513:HEAD", "12,000 of 48,000 files"; null when `text` says it all. */
  detail: string | null
  progress: SessionStepProgress | null
  /** When this text began, for the seconds the row counts; null where elapsed time means nothing. */
  startedAt: number | null
}

/** The full stage of an SVN action; `SessionWorktreeInfo.finish.phase` keeps the four legacy words for older peers. */
export interface SessionSvnActionInfo {
  kind: SvnActionKind
  stage: SvnActionStage
  /** The reason a person must act, or null while it runs. */
  needs: string | null
  needsKind: SvnActionNeed | null
  /** The review open now: its place among the roots to review, from 1. */
  review: { index: number; count: number; scopeRoot: string } | null
  /** "3 conflicts need you"; moves only when the set is read again or an entry settles. Absent from older peers. */
  summary?: string | null
  /** At most 50 entries of the conflict set; `sessions conflicts` answers them all. */
  conflicts?: { entries: SessionSvnConflictInfo[]; more: number } | null
  /** The merger's brief of the set, an absolute path, while the set is open and a brief was written. */
  mergeBrief?: string | null
  /** The merger run while the action is `merging`; its tab is where the person talks to it. */
  mergerRunId?: string | null
}

/** The full conflict list of an SVN action, as `sessions.conflicts` answers it. */
export interface SessionConflictList {
  /** The session whose action it is: a run's parent when a run asked. */
  sessionId: string
  actionId: string
  stage: SvnActionStage
  summary: string
  /** Every entry the record keeps, at most 200; `more` counts what the next read takes from svn. */
  entries: SessionSvnConflictInfo[]
  more: number
}

/** Who works on a conflicted path now; a surface draws `rule` and `settled` as one group. */
export type SvnConflictState = 'rule' | 'agent' | 'person' | 'settled'
export type SvnConflictActor = 'jamat' | 'agent' | 'person'

/**
 * One option on one conflicted path of a waiting Finish. `confirm` is the person's confirmation of a
 * loss of incoming work, which only a window press carries.
 */
export interface SvnConflictResolveRequest {
  path: string
  option: SvnConflictOption
  confirm: boolean
  requestedBy: 'window' | 'cli' | 'peer'
}

/** How a path ended up after `sessions.resolveConflict`, and how many paths are still open. */
export interface SessionConflictResolved {
  /** The session whose action it is: a run's parent when a run asked. */
  sessionId: string
  path: string
  state: SvnConflictState
  left: number
}

export interface SessionSvnConflictOptionInfo {
  id: SvnConflictOption
  /** "Keep both", composed by the library. */
  label: string
  /** "restores the files r421 added and keeps the session's files beside them" */
  note: string
  loses: SvnConflictLoss
}

export interface SessionSvnConflictInfo {
  /** Worktree-relative with '/'. */
  path: string
  kind: SvnConflictKind
  state: SvnConflictState
  /** "Your session added this folder with 2 files; r421 added it with 3 files." */
  description: string
  by: SvnConflictActor | null
  saved: string | null
  options: SessionSvnConflictOptionInfo[]
}

/** Which chain of a session a workflow shows. */
export type SessionWorkflowKind = 'before' | 'finish' | 'discard' | 'update-main' | 'git-finish'

export type SessionWorkflowStepState = 'pending' | 'running' | 'done' | 'failed' | 'waits' | 'skipped'

/** What a click on a step opens. */
export type SessionWorkflowTarget =
  /** The run's live output while it runs, else its saved log. */
  | { kind: 'run'; runId: string }
  /** An agent run's own tab. */
  | { kind: 'agent'; runId: string }
  /** The review run's tab, which holds the commit split. */
  | { kind: 'commit'; runId: string }
  /** The conflict list the pane draws inside this step. */
  | { kind: 'conflicts' }
  | { kind: 'none' }

/** A press a workflow admits now; each surface maps it onto an operation. */
export type SessionWorkflowActionId = 'finish-again' | 'keep' | 'discard' | 'retry-setup' | 'stop-agent' | 'open-in-vscode'
  | 'resolve-with-agent' | 'open-merger'

export interface SessionWorkflowStep {
  /** Stable within the workflow: `1:updating`, `1:check:lint`, `2:review:lib`. */
  key: string
  /** "svn update", "Check lint", "Review (lib)" */
  title: string
  /** One line: "svn update t1", "the check failed", "committed r4". Empty where the title says it all. */
  detail: string
  state: SessionWorkflowStepState
  startedAt: number | null
  endedAt: number | null
  target: SessionWorkflowTarget
}

export interface SessionWorkflowRound {
  /** "Finish", then "Update 2", "Update 3" for each update after one that ran through. */
  title: string
  steps: SessionWorkflowStep[]
}

export interface SessionWorkflowAction {
  id: SessionWorkflowActionId
  label: string
  primary: boolean
  /** `stop-agent` and `open-merger` only: the agent run the press stops or opens. */
  runId?: string
}

/**
 * One chain of a session as steps, composed by the library from the record and its runs; every
 * surface draws it and composes no word of it. It moves only with a stage, a pass or a run's state,
 * never with a poll; durations come from the timestamps, and a running step's live text is the
 * session's or the run's own `step`.
 */
export interface SessionWorkflowInfo {
  kind: SessionWorkflowKind
  /**
   * The action id, `setup:<sessionId>` for the before chain, `git-finish:<sessionId>:<startedAt>` for
   * a Git Finish, or `ended:<at>` for the ended view: a new press is a new workflow.
   */
  workflowId: string
  /** "Finish of 006-wallet-catalog-paging" */
  title: string
  /** The row mark: "updating", "conflicts need you", "committed". */
  badge: string
  /** The pane header: "Running svn update", "Waits for you: the check lint failed". */
  summary: string
  /** Runs or waits: a surface keeps it in view. False on the ended view. */
  open: boolean
  /** At most 10 rounds of at most 20 steps, the newest kept. */
  rounds: SessionWorkflowRound[]
  actions: SessionWorkflowAction[]
}

/** The result of the last SVN finish of a session, the twin of the bash helper's RESULT line. */
export interface SessionWorktreeOutcome {
  result: SvnFinishResult
  /** `<repository URL>:r<N>`, ordered by repository URL, then revision. */
  revisions: readonly string[]
  /** Always `none` since 3.11: landing is the commit, and nothing writes the main copy after it. */
  main: SvnFinishMainResult
  worktree: SvnFinishWorktreeResult
  /** The lines of the ending, verbatim. */
  lines: readonly string[]
  at: number
  /** The revisions of an SVN action with how each is known; absent before 3.11. */
  labelled?: readonly SvnLabelledRevision[]
}

export interface SessionWorktreeInfo {
  worktreePath: string
  /**
   * svn: where the session runs below the worktree, '/'-separated; absent at the worktree itself and
   * from peers before 3.11.
   */
  cwdSubpath?: string
  /** git: the branch; svn: the checked-out URL. */
  branch: string
  /** git: the commit; svn: `r<rev>`. */
  baseCommit: string
  /** A snapshot from an older peer carries none; `SessionsSnapshotValidation` reads that as git. */
  kind: SessionWorktreeKind
  /** A snapshot from an older peer carries none; `SessionsSnapshotValidation` composes them by kind. */
  choices: readonly SessionFinishChoice[]
  diff: { added: number; removed: number; changedFiles: number; capturedAt: number } | null
  /** Always false for svn: an SVN worktree takes everyone else's commits when it finishes. */
  baseMoved: boolean
  /** Present only while an SVN action of this worktree runs, its stage in the four legacy words. */
  finish?: { phase: SvnFinishPhase; scopeRoot?: string }
  outcome?: SessionWorktreeOutcome
  /** A live SVN worktree: Finish opens its dialog at once, and the action stops the session first. */
  liveFinish?: true
  /**
   * Present while the worktree waits to be removed after the session's end, or was kept by that
   * removal. `summary` is the sentence a surface shows; `reason` is the record's own word.
   */
  cleanup?: SessionWorktreeCleanupInfo
}

export type SessionWorktreeCleanupPhase = 'pending' | 'kept'

export interface SessionWorktreeCleanupInfo {
  phase: SessionWorktreeCleanupPhase
  reason?: string
  summary: string
}

/** Where a removed worktree's work went. Such a session is never reopened, restarted or forked. */
export interface SessionRetiredWorktreeInfo {
  worktreePath: string
  revisions: readonly string[]
  /**
   * A landed row: the Finish committed, and the main copy does not hold the newest revision of each
   * repository yet. The row goes once it does; `behind` is null while the server was not read or
   * could not be reached. Absent on every other tombstone and from peers before 3.11.
   */
  landing?: SessionLandingInfo
}

export interface SessionLandingInfo {
  mainCopy: string
  /** Revisions of the main copy's path between its root revision and HEAD; null: unknown. */
  behind: number | null
  /** `<repository URL>:r<N>`, the newest landed revision of each repository. */
  newest: readonly string[]
}

/** A live session that works in a main copy an UPDATE would change under it. */
export interface SessionLiveBrief {
  sessionId: string
  title: string
  number: string | null
}

/** The directory a session's worktree occupies, as a script reads it: git names no URL and no revision. */
export interface SessionWorktreePlace {
  kind: SessionWorktreeKind
  worktreePath: string
  url: string | null
  baseRevision: number | null
}

/** What a create answers. A session in a catalog project carries its number, a worktree session its place. */
export interface SessionCreated {
  sessionId: string
  tabTitle: string
  number?: string
  worktree?: SessionWorktreePlace
}

/**
 * Everything a script may ask about one session's worktree, from its record: the worktree while it
 * stands, the tombstone once it was removed, an SVN finish while one runs, the last outcome and the
 * removal after the session's end: `pending` waits for the process to end or for its reason to go
 * (`in use`, `unlanded r<N>: <paths>`), `kept` is final until a new trigger (`<N> changes`).
 */
export interface SessionWorktreeState {
  sessionId: string
  worktree: SessionWorktreePlace | null
  retired: { worktreePath: string; revisions: readonly string[]; removedAt: number } | null
  finish: { phase: SvnFinishPhase; scopeRoot: string | null } | null
  /** The SVN action running or waiting for the person; a build before 3.11 leaves the field out. */
  action: SessionSvnActionInfo | null
  outcome: SessionWorktreeOutcome | null
  cleanup: { phase: SessionWorktreeCleanupPhase; reason: string | null } | null
  /**
   * The SVN commits made from this session's commit split, or into its worktree, oldest first.
   * Answered for any session, with or without a worktree. A build before 3.11 leaves the field out.
   */
  receipts: readonly SessionCommitReceiptInfo[]
  /** The step running now, or null. A build before 3.13 leaves the field out. */
  step: SessionStepInfo | null
  /** The session's workflow, as `SessionInfo.workflow`, or null. A build before 3.13 leaves the field out. */
  workflow: SessionWorkflowInfo | null
}

/** How an SVN worktree ended, as its durable result says it. */
export type WorktreeResultKind = 'committed' | 'nothing' | 'partial' | 'not-committed' | 'discarded' | 'kept' | 'failed'

/** `pending`: the worktree is still on disk and the cleanup removes it once nothing holds it. */
export type WorktreeResultRemoval = 'removed' | 'pending' | 'kept'

/**
 * The durable result of a Finish, a Discard, a Keep or a cleanup of an SVN worktree. It outlives the
 * session: `sessions worktree-results` answers it after the session was removed, for 30 days, or 1
 * day after it was acknowledged. `logs` are copies of the action's run logs beside the result.
 */
export interface WorktreeResultDto {
  actionId: string
  action: 'finish' | 'discard' | 'cleanup'
  result: WorktreeResultKind
  sessionId: string
  title: string
  tag: string | null
  worktreePath: string
  mainCopy: string
  directoryId: string | null
  removal: WorktreeResultRemoval
  revisions: readonly SvnLabelledRevision[]
  lines: readonly string[]
  logs: readonly { runId: string; title: string; path: string }[]
  notify: { sessionId: string; state: 'pending' | 'delivered' | 'expired'; at: number | null } | null
  /** Whether the main copy holds every committed revision; null until the landed check reads it. */
  holdsLanded: boolean | null
  at: number
  acknowledgedAt: number | null
}

export type SessionNotifyCause = 'ended' | `group:${string}`

export interface SessionNotifyEventDto {
  cause: SessionNotifyCause
  at: number
  state: 'pending' | 'delivered' | 'expired'
  attempts: number
  settledAt: number | null
}

export interface SessionNotifyDto {
  sessionId: string
  target: string
  text: string
  onGroups: string[]
  events: SessionNotifyEventDto[]
}

/** What `sessions worktree-results` filters on; every field narrows, none is required. */
export interface WorktreeResultsFilter {
  tag?: string
  sessionId?: string
  unacknowledged?: true
}

/** One receipt as `sessions worktree` answers it; revision null: TortoiseSVN closed, which proves nothing. */
export interface SessionCommitReceiptInfo {
  scopeRoot: string
  revision: number | null
  at: number
}

/**
 * What the commit dialog reports once an SVN review settles (`SessionManager.noteCommitted`): every
 * scope it committed with its own revision, in commit order, and the committed paths.
 */
export interface SessionCommitReceipt {
  /** The session of the split; a script run's receipt goes to the session it runs for. */
  sessionId: string
  scopes: readonly { scopeRoot: string; revision: number | null }[]
  /** Absolute committed paths of every scope. */
  paths: readonly string[]
}

/**
 * How a session ended, as the library reads it. Derived from the record every time it is asked for,
 * never stored: a stored verdict would be a fourth written state with writers of its own, and the
 * facts it is derived from - `stopRequested`, `exitReason`, `exitCode`, `life` - are already there.
 *
 * It exists because an exit code alone cannot answer the question. A session somebody finished is
 * killed to end it, and a killed process reports whatever its platform reports, so the number says
 * nothing about whether the ending was wanted. The only portable meaning a code carries is that zero
 * is a process that finished on its own.
 */
export type SessionOutcome = 'finished' | 'failed' | 'interrupted'

/**
 * What a session has to say about the install that had to happen before it could start. Only a
 * session created with a worktree ever carries one; everything else has nothing to report.
 *
 * Three shapes, discriminated, because there are three things that can be true and the fields differ
 * per shape: `setupSessionId` names the session doing the installing, so a client can show it or
 * attach to its terminal, and it exists only where there IS one.
 *
 * `commands` is what that install is running, verbatim. It is on the wire so a running install can be
 * read rather than guessed at - a repository-authored setup is agreed to before it starts, and this
 * is what makes it auditable afterwards.
 */
export type SessionSetupInfo =
  | { state: 'running'; setupSessionId: string; commands: readonly string[] }
  | { state: 'failed'; setupSessionId: string; commands: readonly string[] }
  /** Nothing ran, and this says why. */
  | { state: 'skipped'; reason: string }

/** When a script run runs for its parent: before the parent starts, after its work, or inside it on request. */
export type SessionScriptPhase = 'before' | 'after' | 'inner'

/**
 * Which kind of script a run is. Each kind belongs to one phase and is owned by one flow. `svn`,
 * `checks`, `svn-resolve`, `svn-merge` and `review` are the runs of an SVN action; an older peer
 * drops them and nests them by `setupFor`.
 */
export type SessionScriptId = 'setup' | 'declared' | 'merge-resolve' | 'requested' | 'svn' | 'checks' | 'svn-resolve' | 'svn-merge' | 'review'

/** On a script run: the session it runs for, and which script it is. The tree nests the run under it. */
export interface SessionScriptLinkInfo {
  parentId: string
  phase: SessionScriptPhase
  scriptId: SessionScriptId
}

export type SessionScriptRunState = 'running' | 'succeeded' | 'failed' | 'stopped' | 'lost'

/** One run of a parent, still a row or already history, as the `Scripts` menu lists it. */
export interface SessionScriptRunInfo {
  runId: string
  phase: SessionScriptPhase
  scriptId: SessionScriptId
  name: string
  title: string
  state: SessionScriptRunState
  /**
   * The menu line, composed by the library: "Setup i12-x · failed · exit 1 · 24 s". A running run
   * carries no elapsed time, because a field that moves on every poll mints a revision on every poll.
   */
  summary: string
  startedAt: number
  endedAt?: number
  durationText?: string
  exitCode?: number
  /**
   * Empty for a requested run in `SessionInfo.scripts`, which reaches paired peers: an agent's command
   * may carry a token. The local-only `sessions.scripts` reading and the log header keep it.
   */
  commands: readonly string[]
  /** The run's own record still exists, so the tree draws it as a child row with a terminal. */
  row: boolean
  /** `none`: the run has not been settled yet, so nothing was saved or found missing. */
  log: 'saved' | 'unavailable' | 'none'
  /** Why the log is unavailable. */
  logDetail?: string
}

/** The one badge a parent row carries about its before or after scripts, in the library's words. */
export interface SessionScriptsBadge {
  phase: 'before' | 'after'
  state: 'running' | 'failed' | 'skipped' | 'succeeded'
  /** `installing dependencies`, `setup: codegen`, `setup failed`, `setup ✓ 23.6 s`, `checks: tests`. */
  text: string
  title: string
  /** Running or failed: the run row. Succeeded: the history entry that holds the log. */
  runId?: string
}

/** On a parent only, and only where it has anything: runs, a badge, or a launch waiting on a run. */
export interface SessionScriptsInfo {
  /** Rows and history together, newest first. */
  runs: readonly SessionScriptRunInfo[]
  badge?: SessionScriptsBadge
  /** The run the parent's own launch waits for; a click on the parent opens its terminal. */
  waitingOn?: string
}

/**
 * A shell run a live session asks for, judged by its exit code and drawn as its child. `cwd` is
 * relative to the session's own directory, or absolute inside it; absent is that directory.
 * `title` names the run; absent, the command does.
 */
export interface SessionScriptRequest {
  command: string
  cwd?: string
  title?: string
}

/** A session's runs, newest first, and the saved log of the one run asked for. */
export interface SessionScriptsReading {
  sessionId: string
  runs: readonly SessionScriptRunInfo[]
  /** The tail of the saved log, at most the 256 KiB a log keeps; null when no run was named or it has none. */
  log: { runId: string; text: string; truncated: boolean } | null
  /** Why the run that was named has no log text. */
  logDetail?: string
}

export interface SessionScriptOutput {
  state: SessionScriptRunState
  source: 'live' | 'log'
  /** The latest output rows, at most 256 KiB in UTF-8 including line separators. */
  lines: readonly string[]
  logReason?: string
  terminal: RuntimeRef | null
  endedAt?: number
}

/** The library's split of a session's title; `SessionTitle` is the one thing that computes it. */
export interface SessionTitleParts {
  /** `'014'` or `'014-015'` out of the corresponding title; null without a prefix. */
  number: string | null
  name: string
}

/**
 * The fields of a details save that actually moved, merged into the record in one mutation. A
 * field that is absent is left exactly as it was - which is what keeps a name-only save from
 * silently reverting a colour another surface set moments earlier - while `null` clears (the
 * colour, the note). The name is what follows the number, never the number itself.
 */
export interface SessionDetailsUpdate {
  name?: string
  note?: string | null
  color?: SessionColorName | null
}

export interface SessionLocalHistoryEntry {
  category: SessionsSnapshot['categories'][number]
  project: Extract<ProjectBinding, { kind: 'project' }>
  agentId: SessionAgentId
  nativeSessionId: string
  title: string
  model: string | null
  createdAt: number
  lastActivity: number | null
  /** When the session ended, null while it runs or where no ending was ever recorded. */
  endedAt: number | null
  active: boolean
}

export interface SessionInfo {
  sessionId: string
  kind: 'shell' | 'agent'
  title: string
  /** The split of `title`, composed by the library; the renderer never re-parses the prefix. */
  titleParts: SessionTitleParts
  /**
   * What a tab holding this session is called: the place it runs in, and then the title. Composed
   * by the library rather than by whoever opens the tab, because four surfaces open one and the
   * title alone - `001` - says nothing about which project it belongs to.
   */
  tabTitle: string
  directory: SessionCreateSpec['directory']
  project: ProjectBinding
  agent?: { agentId: SessionAgentId; nativeSessionId?: string }
  worktree?: SessionWorktreeInfo
  retiredWorktree?: SessionRetiredWorktreeInfo
  /** Absent = unmeasured, or no VCS governs the directory. Absence is not a measurement. */
  vcs?: SessionVcsInfo
  /** Absent = None. A name only; what it looks like is the renderer's to decide. */
  color?: SessionColorName
  /** The person's note about this session. Absent = none. */
  note?: string
  /** The control operation id of the sessions.create that made this session. Absent = none. */
  callerOperationId?: string
  life: 'starting' | 'live' | 'ended' | 'lost'
  /** The person's verdict, independent of `life`: what the daily view and the restart chain read. */
  completed?: true
  /** How it ended, for a session that has. Absent while one is starting or live. */
  outcome?: SessionOutcome
  /** Null for a shell: nothing classifies a plain terminal. */
  activity: SessionActivity | null
  /** Absent unless `activity` is `working` specifically because work remains in the background. */
  activityDetail?: SessionActivityDetail
  /** Separate optional field: older peers strictly validate the existing activityDetail values. */
  compacting?: true
  /** Mandatory, and empty where nothing applies: "no operations" is an answer, absence is not. */
  admits: readonly SessionOperation[]
  /*
   * `outputSeq` and `lastOutputAt` were HERE until 2026-08-24, and are deliberately not any
   * more. They were what remained of the `unread` half of the attention model: the tree drew a
   * dot from `outputSeq` moving past what the user had been shown, and nothing has drawn either
   * since that was deleted.
   *
   * `outputSeq` counts bytes a PTY has written, so a working agent moved it on every poll - and
   * `recompose` decides "did anything change" by stringifying the whole composition. One live
   * session with nobody touching anything therefore minted a revision per poll, pushed the
   * snapshot to every window, and rebuilt and re-rendered the whole tree over a screen nobody
   * was looking at. Excluding them from the identity was tried and is worse: the fields then
   * hold a value from an arbitrary earlier poll.
   *
   * `HostDebugRuntimeRow` keeps the same pair. That surface is a diagnostic and really draws
   * them, and it is read on demand rather than composed into a poll.
   */
  endedAt?: number
  exitCode?: number
  /** Why a session ended with no runtime behind it: the Host's own words when it refused the launch. */
  endedReason?: string
  /**
   * Present only while a launch is stuck: the Host has refused it enough times running that calling
   * the session `starting` would be a lie, and the refusal is one a retry can still lift. `reason`
   * is the Host's own words, the way `endedReason` is; `attempts` is how many refusals stand behind
   * it, so a surface can say how long this has been going on rather than only that it is.
   *
   * Absent covers both ordinary cases: a launch going through normally, and one refused once or
   * twice, which is what a Host restarting looks like and is not worth a word.
   */
  launchWait?: { reason: string; attempts: number }
  /** Still composed for older peers, which draw it; `scripts.badge` says the same and more. */
  setup?: SessionSetupInfo
  /** For older peers: on every script run except the resolver, the session it runs for. */
  setupFor?: string
  /** Present only while this session's worktree is being merged back. */
  merge?: SessionMergeInfo
  /** For older peers: on a resolve session only, whose merge it is settling. */
  resolveFor?: string
  /** On a script run only. */
  script?: SessionScriptLinkInfo
  /** On a parent only. */
  scripts?: SessionScriptsInfo
  /** An SVN action of this session, running or waiting for the person. */
  svnAction?: SessionSvnActionInfo
  /** Absent while this client does nothing for the session; older peers ignore it. */
  step?: SessionStepInfo
  /**
   * The chain running or waiting for the person, or the ended view of the last SVN action until the
   * next press. Absent: no chain and no ended view; an older build leaves it out.
   */
  workflow?: SessionWorkflowInfo
  /** Composed by the library. `sameProject` is the generic nesting rule; the tree applies only display settings. */
  parent?: { sessionId: string; kind: SessionParentKind; sameProject: boolean }
}

/** One session another one started, as `sessions.children` answers it. */
export interface SessionChildInfo {
  sessionId: string
  number: string | null
  title: string
  agentId: SessionAgentId | null
  life: SessionInfo['life']
  kind: SessionParentKind
  sameProject: boolean
}

export interface OrphanInfo {
  runtimeSessionId: string
  alive: boolean
  startedAt: number
}

export interface SessionsSnapshot {
  revision: number
  /**
   * Whether a reconcile the Host actually answered has run yet. It is the difference between
   * "nothing is running" and "nobody has looked yet", which a surface acting on what is lost has to
   * be able to tell apart.
   *
   * A flag rather than the time it happened, deliberately: the revision is the identity of the
   * content, so a timestamp here would move it on every poll and wake every reader twice a second.
   * This changes once, and the answer is the whole of what anybody needs.
   */
  reconciled: boolean
  host: HostStatusInfo
  categories: { id: string; label: string; path: string }[]
  sessions: SessionInfo[]
  orphans: OrphanInfo[]
}

/**
 * What a client must show and hand back to agree to a project's own commands. `commands` is the
 * display list: setup commands verbatim, then `before <name>: <command>` and `after <name>: <command>`,
 * so an older client that shows the list shows everything it agrees to.
 *
 * Named rather than left inline on the refusal arm, which is where it was: a renderer that wanted to
 * carry it through its own model had nothing to import and wrote the shape out, seven times over five
 * files. The next field on it is now one import instead of an eight-file edit.
 *
 * It is on the wire because a `detail` string cannot carry it: a client has to SHOW the commands to
 * ask about them, and hand the hash back verbatim to answer.
 */
export interface SessionSetupAgreement {
  commands: readonly string[]
  hash: string
}

export type SessionsOpErrorCode =
  | 'host-unreachable'
  | 'no-lease'
  /** The Host was reached, answered, and refused the operation; its own words travel in the detail. */
  | 'op-rejected'
  | 'not-found'
  | 'live-refused'
  /** A launch for this session is already waiting for the Host; the reconcile pass owns it. */
  | 'launch-pending'
  | 'invalid-spec'
  | 'records-latched'
  | 'git-missing'
  | 'not-a-repo'
  | 'dirty'
  | 'locked'
  | 'missing-base'
  | 'worktree-exists'
  | 'git-failed'
  /** svn could not run or refused an SVN worktree operation; its own words travel in the detail. */
  | 'svn-failed'
  | 'already-running'
  | 'spawn-failed'
  | 'boot-timeout'
  /**
   * The project declares its own commands in a `.worktree.json` (`setup` or `scripts`), and nobody on
   * this machine has agreed to run them. That file arrives with a clone, so its commands are the one
   * input this library would execute that nobody here wrote.
   */
  | 'setup-not-acknowledged'
  /**
   * The session numbers file could not be read, or the new count could not be written. It is never
   * fatal: a session is created without a number rather than not created at all.
   */
  | 'numbers-unavailable'
  /**
   * The merge stopped on conflicts. Not a failure: the worktree now holds a half-finished merge,
   * and running Merge again continues from whatever state it has been left in.
   */
  | 'merge-conflict'
  /**
   * Another merge is already running against this repository, or the main copy is mid-merge:
   * one somebody left unfinished, or one this merge itself stopped on conflicts. A foreign
   * merge is never aborted, so the answer says where it is and stops. Also the answer while an
   * SVN finish holds the session.
   */
  | 'merge-pending'
  /**
   * The session's worktree was removed or is gone. It is never started again in the project
   * directory instead; the detail names the revisions its work went to.
   */
  | 'worktree-removed'
  /**
   * An SVN finish took other commits into the worktree that touch the project of its change set, so
   * nothing was committed: the tests ran without them. Finish again commits as it is.
   */
  | 'worktree-updated'
  /** Updating the SVN worktree left conflicts; the detail names them and nothing was committed. */
  | 'worktree-conflict'
  /** Committing an SVN worktree needs this client's commit dialog, and there is none to open. */
  | 'review-unavailable'
  /** The session still works; the press is repeated with `confirmWorking` to finish it anyway. */
  | 'session-working'
  /** Other live sessions work in the main copy; the UPDATE is repeated with `confirmLive` naming them. */
  | 'live-sessions'
  /** A person already wrote the commit message of that scope; a proposal never replaces it. */
  | 'message-edited'
  /** The option loses incoming work: only the person may choose it, in the window, with a confirmation. */
  | 'person-only'

export type SessionsOpResult<T = void> =
  | { ok: true; value: T }
  | {
      ok: false
      code: SessionsOpErrorCode
      detail: string
      /** Only on `setup-not-acknowledged`; see `SessionSetupAgreement` for why it is not a string. */
      setup?: SessionSetupAgreement
      /** Only on `live-sessions`: the sessions a confirmation has to name. */
      liveSessions?: readonly SessionLiveBrief[]
      /** Only on a create whose record stays `starting` for a replay: the session that may still appear. */
      recordedSessionId?: string
    }

/**
 * What a terminal surface is handed, frame by frame.
 *
 * Six of them are the Host's own, carried through untouched, and the seventh is this library's:
 * everything a panel needs to know that is not on the wire because it is not the Host's to say.
 * What is deliberately NOT here is every frame the gateway answers itself - a truncated delta and a
 * `terminal.stream-truncated` both mean "your cursor is worthless", and the answer to both is a
 * fresh attach, so a surface only ever sees the snapshot that comes back.
 */
export type TerminalFrame =
  | Extract<
      HostWsServerMsg,
      | { type: 'terminal.attached' }
      | { type: 'terminal.snapshot' }
      | { type: 'terminal.data' }
      | { type: 'terminal.delta' }
      | { type: 'terminal.resize' }
      | { type: 'terminal.exit' }
    >
  | {
      type: 'terminal.status'
      /** `connecting` covers both the first attempt and every reconnect; nothing distinguishes them. */
      status: 'connecting' | 'read-only' | 'lost'
      detail: string | null
      /**
       * Why, on a `lost` that came from a refused resolution. A surface reads this instead of the
       * sentence; absent means the loss came from the Host itself and has no code to give.
       */
      code?: 'not-live' | 'unknown-session'
    }

export interface TerminalAttachSpec {
  sessionId: string
  /**
   * Null when the surface has no size to ask for: a panel mounted in a hidden tab measures 0x0, and
   * fitting a terminal to that shrinks the PTY to about two columns. The attach then carries no
   * geometry at all and the PTY keeps whatever size it had.
   */
  size: { cols: number; rows: number } | null
}

export type TerminalAttachResult =
  | { ok: true }
  | {
      ok: false
      /** `not-live` is the ordinary one: an ended session has a record and no runtime to attach to. */
      code: 'not-live' | 'host-unreachable' | 'unknown-session'
      detail: string
    }

/**
 * What this subsystem is holding about the Host, for the one surface built to look at it.
 *
 * **Deliberately unstable, and shaped by the inside.** This is not a `Dto` and it is not kept
 * backward compatible: it changes whenever the subsystem's internals change, because a single
 * section of a single window in this same repository is what reads it. The day something outside
 * this tree wants these facts, it gets a contract of its own rather than this one being frozen.
 *
 * Two fields are absent by construction and must stay absent: the descriptor's `token`, which is
 * main-only, and the launch environment, which carries the whole of `process.env`.
 */
export interface HostDebugStatus {
  capturedAt: number
  presence: HostPresence
  /** Picked field by field out of `HostDescriptor`. `token` is not among them and never will be. */
  descriptor: {
    pid: number
    port: number
    protocol: WireVersion
    capabilities: string[]
    hostVersion: string
    payloadHash: string
    configIdentity: string
    runtimeChannel: RuntimeChannel
    hostInstanceId: string
    hostGeneration: string
    startedAt: number
    processStartedAt: number
  } | null
  /** The protocol THIS client speaks, so a mismatch is readable instead of merely fatal. */
  clientProtocol: WireVersion
  /** What the Host in this tree would report; null is never read as a match. */
  expectedHostVersion: string | null
  controller: { launching: boolean; autoStartAttempted: boolean; lastStartError: string | null }
  watcher: {
    descriptorFile: string
    pollMilliseconds: number
    /** `hostInstanceId:port` - which Host process on which port, WITHOUT the token. */
    identity: string | null
  }
  eventsSocket: {
    connected: boolean
    cursor: number | null
    resyncOwed: boolean
    reconnectAttempt: number
    lastSubscribed:
      | { at: number; throughRevision: number; replayed: number; truncated: boolean }
      | null
  }
  lease: { controllerId: string; leaseId: string | null; expiresAt: number | null }
  reconcile: {
    lastAt: number | null
    lastReason: 'poll' | 'event' | 'resync' | 'operation' | null
    lastListingOk: boolean | null
    refreshPending: boolean
  }
  poll: { windowVisible: boolean; cadenceMilliseconds: number; lastTickAt: number | null }
  /** What this client would spawn. `env` is not here: it carries the whole of `process.env`. */
  launch: {
    ok: boolean
    command: string | null
    args: string[]
    cwd: string | null
    refusal: string | null
  }
  runtimes: HostDebugRuntimeRow[]
  counts: { live: number; dead: number; orphans: number }
}

/**
 * One runtime the Host is holding, joined to the record this client has for it. Dead runtimes are
 * in: the whole point of the table is the difference between what the client believes and what the
 * Host actually holds.
 */
export interface HostDebugRuntimeRow {
  runtimeSessionId: string
  /** Null for a runtime this client has no record of, which is typically an orphan. */
  sessionTitle: string | null
  orphan: boolean
  alive: boolean
  pid: number | null
  generation: number
  startedAt: number
  exitedAt: number | null
  exitCode: number | null
  exitReason: RuntimeSessionInfo['exitReason'] | null
  outputSeq: number
  lastOutputAt: number | null
  /**
   * What the work-state classifier last made of this runtime's screen, and the signals it rested on
   * (`source:signal`). Null for a shell, an orphan, and a runtime never inspected. It is here so a
   * verdict can be read back without a probe: the classifier missing a prompt is invisible until
   * somebody can see WHY it answered what it did.
   */
  work: { hint: AgentWorkHint; signals: string[] } | null
}

export type HostPingResult =
  | {
      at: number
      ok: true
      latencyMilliseconds: number
      /** Picked field by field out of `HostHello`, which carries no token to begin with. */
      hello: {
        protocol: WireVersion
        buildVersion: string
        sourceRevision: string
        platform: string
        arch: string
        hostGeneration: string
        pid: number
        runtimesLive: number
        runtimesDead: number
        eventRevision: number
      }
    }
  | { at: number; ok: false; detail: string }

/**
 * What an agent's input box holds, read off the Host's screen projection. `absent` is no input box
 * at all: the agent is still booting, or a dialog has replaced it. `empty` is the marker with
 * nothing after it or only the agent's dimmed placeholder. `text` is a draft, ANSI stripped, its
 * wrapped continuation rows joined with `\n`.
 */
export type TerminalComposerState =
  | { state: 'absent' }
  | { state: 'empty' }
  | { state: 'text'; text: string }

export interface TerminalComposerReading {
  agentId: SessionAgentId
  alive: boolean
  hint: AgentWorkHint
  composer: TerminalComposerState
  /** A fixture-proven "queued" row is on screen: a busy agent took an Enter and holds the message. */
  queuedRow: boolean
  /**
   * Claude: `normalizeTty` of the first row of the newest user message echoed above the input box,
   * marker removed. A prefix of the message when the echo wraps. Null for Codex and without a box.
   */
  echoHead: string | null
  /** How many collapsed-paste placeholders the draft shows (`[Pasted text #1 +14 lines]`). */
  pastePlaceholders: number
  /** The draft holds placeholders and nothing else once they are removed. */
  onlyPlaceholders: boolean
}

export type TerminalComposerResult =
  | { ok: true; reading: TerminalComposerReading }
  | { ok: false; code: 'unknown-session' | 'not-live' | 'not-agent' | 'no-projection' }

/**
 * The whole draft or nothing: `text` only for a box whose start and end are both recognized, because
 * an erase runs backwards from the cursor and would remove any row this reading missed. `clipped` is
 * a box touching the viewport's top edge, `placeholder` a collapsed paste or an image. `eraseBound`
 * is an upper bound of the characters the draft holds, never an exact count.
 */
export type TerminalComposerContent =
  | { kind: 'absent' }
  | { kind: 'empty' }
  | { kind: 'clipped' }
  | { kind: 'placeholder' }
  | { kind: 'text'; text: string; eraseBound: number }

export interface TerminalComposerContentReading {
  agentId: SessionAgentId
  alive: boolean
  hint: AgentWorkHint
  content: TerminalComposerContent
}

export type TerminalComposerContentResult =
  | { ok: true; reading: TerminalComposerContentReading }
  | { ok: false; code: 'unknown-session' | 'not-live' | 'not-agent' | 'no-projection' | 'no-viewport' }
