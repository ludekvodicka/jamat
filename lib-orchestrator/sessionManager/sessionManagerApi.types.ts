/**
 * The wire surface of the sessions subsystem, mirroring `projectManagerApi.types.ts`: it imports
 * nothing but its sibling wire-type file and the Host's own wire types, and never runtime code,
 * because the renderer's TypeScript program compiles it. A `node:` import or a sibling module here
 * stops the web build. The Host's types are safe to name for the same reason: `import type` is
 * erased, and `hostWire.ts` has no imports of its own to drag in behind it. The same argument admits
 * `agentWorkInspector.types.ts`, the data-only vocabulary of the work-state classifier: no runtime
 * code, no imports of its own, and the Debug window needs the hint by name.
 */
import type { AgentWorkHint } from './workState/agentWorkInspector.types'
import type {
  HostWsServerMsg,
  RuntimeChannel,
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
  worktree?: { slug: string; baseRef?: string }
  title?: string
  /**
   * Which flow composed this session, if one did. Opaque here on purpose: the library stores it and
   * never branches on it, so a new flow is a change to the renderer's catalog and to nothing else.
   */
  flowId?: string
  /**
   * Ask for a plain tab: a session the tree does not draw, which its tab alone presents. It runs
   * without isolation and outside any flow, so those two are refused alongside it. There is no
   * `completed` here on purpose - a session is not born finished.
   */
  presentation?: 'tab'
  /**
   * The hash of the setup commands the person was shown and agreed to run. Present only on the second
   * attempt, after a create came back `setup-not-acknowledged` carrying that hash: the first attempt
   * is what asks the question, this is the answer travelling back with it.
   */
  acknowledgeSetup?: string
}

export interface SessionHistoryOpenSpec {
  directory: Extract<SessionCreateSpec['directory'], { mode: 'project' }>
  agentId: SessionAgentId
  nativeSessionId: string
  /** The provider's own display name, used only when no V3 record exists yet. */
  providerName: string
  /** Claude's provider can prove a live process; Codex activity is recovered from V3 records. */
  providerActive: boolean
}

/** The local half of one provider-history row, joined by agent and native conversation id. */
export interface SessionHistoryReference {
  sessionId: string
  agentId: SessionAgentId
  nativeSessionId: string
  title: string
  titleParts: SessionTitleParts
  life: SessionInfo['life']
}

/** `starting` is hostControl's overlay while a launch is in flight, not a transport fact. */
export type HostPresence = 'running' | 'starting' | 'unreachable'

export interface HostStatusInfo {
  presence: HostPresence
  hostVersion: string | null
  hostInstanceId: string | null
  liveCount: number
  lastStartError: string | null
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

export interface SessionWorktreeInfo {
  worktreePath: string
  branch: string
  baseCommit: string
  diff: { added: number; removed: number; changedFiles: number; capturedAt: number } | null
  baseMoved: boolean
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
  /** Absent = unmeasured, or no VCS governs the directory. Absence is not a measurement. */
  vcs?: SessionVcsInfo
  /** Absent = a session of the tree. See the record's field. */
  presentation?: 'tab'
  /** Absent = None. A name only; what it looks like is the renderer's to decide. */
  color?: SessionColorName
  /** The person's note about this session. Absent = none. */
  note?: string
  life: 'starting' | 'live' | 'ended' | 'lost'
  /** The person's verdict, independent of `life`: what the daily view and the restart chain read. */
  completed?: true
  /** How it ended, for a session that has. Absent while one is starting or live. */
  outcome?: SessionOutcome
  /** Null for a shell: nothing classifies a plain terminal. */
  activity: SessionActivity | null
  /** Absent unless `activity` is `working` specifically because work remains in the background. */
  activityDetail?: SessionActivityDetail
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
  setup?: SessionSetupInfo
  /** On the installing session only: the session it is installing for. */
  setupFor?: string
  /** Present only while this session's worktree is being merged back. */
  merge?: SessionMergeInfo
  /** On a resolve session only: whose merge it is settling. The tree nests it under that one. */
  resolveFor?: string
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
 * What a client must show and hand back to agree to a project's setup commands.
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
  | 'already-running'
  | 'spawn-failed'
  | 'boot-timeout'
  /**
   * The project declares its own `setup` in a `.worktree.json`, and nobody on this machine has agreed
   * to run it. That file arrives with a clone, so its commands are the one input this library would
   * execute that nobody here wrote.
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
   * merge is never aborted, so the answer says where it is and stops.
   */
  | 'merge-pending'

export type SessionsOpResult<T = void> =
  | { ok: true; value: T }
  | {
      ok: false
      code: SessionsOpErrorCode
      detail: string
      /** Only on `setup-not-acknowledged`; see `SessionSetupAgreement` for why it is not a string. */
      setup?: SessionSetupAgreement
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
