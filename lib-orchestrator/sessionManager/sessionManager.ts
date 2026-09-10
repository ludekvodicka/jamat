import { hostname } from 'node:os'
import { basename, resolve } from 'node:path'

import type {
  HostWireConst,
  RuntimeListResult,
  RuntimeSessionInfo,
} from '../../app-host/app/wire/hostWire.js'
import type { FileChangesVcsId } from '../fileChangesManager/fileChangesManagerApi.types'
import type { VcsStatusView } from '../fileChangesManager/vcsStatusView'
import type { WorktreeDiff } from '../git/git.types'
import { GitCheckpointStore } from '../git/gitCheckpointStore'
import { GitInvoker } from '../git/gitInvoker'
import { GitMergeManager } from '../git/gitMergeManager'
import { GitWorktreeManager } from '../git/gitWorktreeManager'
import type { VersioningMode } from '../git/git.types'
import { HostClient } from '../hostClient/hostClient'
import { HostDescriptorPaths } from '../hostClient/hostDescriptorPaths'
import { TerminalAttachSocket } from '../hostClient/terminalAttachSocket'
import {
  HostController,
  type HostControllerDeps,
  type HostStartErrorCode,
} from '../hostControl/hostController'
import { HostLaunchLocator, type HostLaunchResult } from '../hostControl/hostLaunchLocator'
import { HostTreeVersion } from '../hostControl/hostTreeVersion'
import { type CatalogReading, CatalogView } from '../projectManager/catalogView'
import { ClaudeTitleWriter } from '../projectManager/claudeTitleWriter'
import { CodexRolloutView } from '../projectManager/codexRolloutView'
import type { ProjectBinding } from '../projectManager/projectManagerApi.types'
import type { ProviderTranscriptView } from '../projectManager/providerTranscriptView'
import type { PlatformSettingsValue } from '../projectSetup/projectSetup.types'
import { ProjectSetupManager } from '../projectSetup/projectSetupManager'
import { SetupFamilies } from '../projectSetup/setupFamilies'
import type { RuntimeChannel } from '../shared/configIdentity.types'
import { ErrorText } from '../shared/errorText'
import { OrchestratorPaths } from '../shared/orchestratorPaths'
import { AgentPresets } from './launch/agentPresets'
import { FinalizeSteps } from './lifecycle/finalizeSteps'
import { LaunchBackoff } from './lifecycle/launchBackoff'
import type { ReconcileChange } from './lifecycle/reconciler'
import { SessionLifecycle } from './lifecycle/sessionLifecycle'
import { WorktreeMergeFlow } from './lifecycle/worktreeMergeFlow'
import { SessionColors } from './records/sessionColors'
import { SessionNumberStore } from './records/sessionNumberStore'
import { SessionOutcomes } from './records/sessionOutcomes'
import type {
  SessionRecord,
  SessionRecordAgent,
  SessionRecordWorktree,
} from './records/sessionRecord.types'
import { SessionRecordsStore } from './records/sessionRecordsStore'
import { SessionTitle } from './records/sessionTitle'
import type {
  HostDebugRuntimeRow,
  HostDebugStatus,
  HostPingResult,
  OrphanInfo,
  SessionActivity,
  SessionAgentId,
  SessionColorName,
  SessionCreateSpec,
  SessionDetailsSaved,
  SessionDetailsUpdate,
  SessionHistoryOpenSpec,
  SessionHistoryReference,
  SessionInfo,
  SessionOperation,
  SessionSetupInfo,
  SessionsOpErrorCode,
  SessionsOpResult,
  SessionsSnapshot,
  SessionWorktreeInfo,
  TerminalAttachResult,
  TerminalAttachSpec,
} from './sessionManagerApi.types'
import { SessionReference } from './sessionReference'
import { SessionWorkingDirectory } from './sessionWorkingDirectory'
import type { TerminalRefResolution, TerminalSocketFactory } from './terminals/terminalAttachment'
import {
  TerminalGateway,
  type TerminalAttachOwner,
  type TerminalInputResult,
  type TerminalResizeResult,
} from './terminals/terminalGateway'
import { VcsFactsCache } from './vcsFacts/vcsFactsCache'
import { WorkStateMonitor } from './workState/workStateMonitor'

export interface SessionManagerDeps {
  /** Passed straight to `HostController`: the directory `app-host` stands in, named by the client. */
  applicationRoot: string
  /**
   * Passed straight to `HostController` beside it: Electron's `process.resourcesPath` in a packaged
   * client, where the Host ships as a bundle, and `null` in every other composer.
   */
  resourcesRoot: string | null
  configDir: string
  configIdentity: string
  channel: RuntimeChannel
  /** `!context.smoke` in the client: a smoke run must never spawn a detached Host of its own. */
  autoStartHost: boolean
  /** One call per change of anything the snapshot shows; coalescing them is the renderer's job. */
  onChanged: () => void
  onError: (message: string) => void
  /**
   * How a working copy is asked whether it is dirty. Optional: a manager built without it runs
   * exactly as before, minus the facts and minus every process they would cost.
   */
  vcsStatusView?: VcsStatusView
  preferredVcsOf?: () => FileChangesVcsId
  /**
   * The writer identity this client takes at the Host. Random per process by default, because two
   * clients sharing one id would take each other's lease; the smoke names it so that it can put a
   * runtime on the Host under the same authority the manager already holds.
   */
  controllerId?: string
  /** The tests script every Host launch through this; nothing in production passes it. */
  spawnImpl?: HostControllerDeps['spawnImpl']
  /** The tests hand attaches a socket of their own; nothing in production passes it. */
  terminalSocketFactory?: TerminalSocketFactory
  /** Where Codex keeps its rollouts. The tests and the smokes point it at a fixture; production does not. */
  codexHome?: string
  /** Where Claude keeps its config home. The tests and the smokes point it at a fixture; production does not. */
  claudeHome?: string
  /**
   * How a session's transcript file is found, for the reference a person copies. Optional: a manager
   * built without it composes the same block minus the transcript line, which is what the tests and
   * the smokes get - and what a session with no agent would answer anyway.
   */
  transcripts?: Pick<ProviderTranscriptView, 'resolve'>
  /** This machine's name, as the reference block says it. The tests name it so the block is fixed. */
  computerName?: () => string
  /**
   * Whether an agent runs without being asked anything, asked once per launch so the setting stays
   * live. A narrow callback rather than the `ConfigStore` on purpose: this manager owns no config
   * section, and a consumer that passes nothing gets gated agents, which is the safe direction.
   */
  yoloFor?: (agentId: SessionRecordAgent['agentId']) => boolean
  /**
   * Which repository AI work goes into, asked once per operation so a switch in the settings tab
   * takes effect from the next one without a notification of its own - the same shape as
   * `yoloFor`, and for the same reason: this manager owns no config section.
   *
   * Defaults to `checkpoints`, which is what the shared instructions describe and what every
   * machine here runs on. `git` exists for somebody running AppJamatV3 without them.
   */
  versioningModeOf?: () => VersioningMode
  /** This machine's install tier. Absent means the plain install of every family. */
  platformSettingsOf?: () => PlatformSettingsValue
  /**
   * Which model an agent should start on, asked once per founding launch so the setting stays live.
   * A second narrow callback rather than a wider `yoloFor`: one callback, one concern, and a
   * consumer that passes nothing gets today's launch with no flag at all.
   */
  modelFor?: (agentId: SessionRecordAgent['agentId']) => string | undefined
  effortFor?: (agentId: SessionRecordAgent['agentId']) => string | undefined
  /**
   * The clock the restart's exit budget is measured on. The tests hand it a virtual one so the five
   * seconds cost no wall time; nothing in production passes it.
   */
  exitClock?: ExitClock
}

/** Read by `awaitRuntimeExit` and by nothing else: a budget measured, and a poll waited. */
export interface ExitClock {
  now: () => number
  wait: (milliseconds: number) => Promise<void>
}

export type SessionWorkingContextResult =
  | {
    ok: true
    value: {
      sessionId: string
      cwd: string
      agent: { agentId: SessionRecordAgent['agentId']; nativeSessionId: string } | null
      worktree: {
        worktreePath: string
        repositoryRoot: string
        baseCommit: string
      } | null
    }
  }
  | { ok: false; code: 'unknown-session'; detail: string }

export type SessionTranscriptContextResult =
  | {
    ok: true
    value: {
      agentId: SessionAgentId | null
      cwd: string
      nativeSessionId: string | null
      /**
       * What the founding launch asked this agent to run on, `null` where it asked for nothing. It
       * travels beside the transcript's whereabouts because it is the one thing the transcript
       * cannot say: Claude records the bare model id the API answered with and never the `[1m]`
       * tier, so the reader that draws the context window learns it here or nowhere.
       */
      launchModel: string | null
    }
  }
  | { ok: false; code: 'unknown-session'; detail: string }

interface WorktreeFactsView {
  capturedAt: number
  diff: WorktreeDiff | null
  baseMoved: boolean
}

/** What set a reconcile pass off. Diagnostic only: nothing branches on it. */
type ReconcileReason = NonNullable<HostDebugStatus['reconcile']['lastReason']>

/**
 * The sessions subsystem seen from outside it: one object that owns the records, the Host client, the
 * Host's own lifecycle and the work-state monitor, and answers with one snapshot and typed results.
 *
 * Composition is nearly all it decides - what a session may be, what a reconcile means and what a
 * screen is doing all live in the subsystem that owns them. Three things are genuinely this class's
 * own, and each exists because it is the only place that can hold them:
 *
 * 1. **One thing at a time.** Every operation and every reconcile passes through one queue. A
 *    reconcile running beside a create would find a `starting` record whose runtime does not exist
 *    yet and replay the very create it is standing next to.
 * 2. **One snapshot, one revision.** The revision is not a clock: it is the identity of the content
 *    handed out with it, so a caller told `sessions:changed` at revision N and asking for the
 *    snapshot gets exactly what that emit was about. Recomposing over unchanged content emits
 *    nothing, which is what keeps a two-second poll from waking the renderer twice a second.
 * 3. **One poll of one Host.** The cadence - 2 s while the window is visible, 15 s while it is not -
 *    lives here and nowhere else, and the `runtime.list` it asks for is the only one in this client:
 *    the reconciler and the work-state monitor are both handed that same answer. A second timer
 *    beside it meant two copies of the cadence and two opinions about what unreachable means.
 *
 * `stop()` detaches and does nothing else. No runtime is stopped and no record is rewritten: a
 * client going away is not a decision about anybody's session.
 */
export class SessionManager {
  private static readonly visiblePollMillisecondsConst = 2_000
  private static readonly hiddenPollMillisecondsConst = 15_000
  /** Two git processes per worktree, so this is measured on its own clock and not on the poll's. */
  private static readonly worktreeFactsMillisecondsConst = 30_000
  /** How long a restart waits for the stopped process to actually be gone, and how often it looks. */
  private static readonly exitBudgetMillisecondsConst = 5_000
  private static readonly exitPollMillisecondsConst = 250
  private static readonly realExitClockConst: ExitClock = {
    now: () => Date.now(),
    wait: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  }
  /** What a tab is named after where nothing names a place: the home directory, or an empty path. */
  private static readonly placelessConst = 'Terminal'
  /**
   * The protocol THIS client speaks, mirrored from `HostWireConst` through the type system instead
   * of imported as a value: every path out of this package into `app-host` is `import type`
   * (`CLAUDE.md` rule 1), and a value import would link the Host's code into every client that
   * bundles this library. The annotation is what keeps the mirror honest - move the Host's protocol
   * and this line stops compiling rather than quietly disagreeing with it.
   */
  private static readonly clientProtocolConst: {
    major: typeof HostWireConst.protocolMajor
    minor: typeof HostWireConst.protocolMinor
  } = { major: 1, minor: 0 }

  private readonly client: HostClient
  private readonly controller: HostController
  private readonly treeVersion: HostTreeVersion
  private readonly checkpoints: GitCheckpointStore
  private readonly versioningModeOf: () => VersioningMode
  private readonly worktrees: GitWorktreeManager
  /** Shared with the merge flow: two instances would ask the same repositories the same questions. */
  private readonly merge: GitMergeManager
  private readonly catalog: CatalogView
  private readonly projectSetup: ProjectSetupManager
  private readonly monitor: WorkStateMonitor
  private readonly terminals: TerminalGateway
  private readonly worktreeFacts = new Map<string, WorktreeFactsView>()
  private readonly vcsFacts: VcsFactsCache | null
  /** Previous activity per session, read only to spot the settle that nudges a re-probe. */
  private readonly lastVcsActivity = new Map<string, SessionActivity | null>()
  private records: SessionRecordsStore | null = null
  private lifecycleLoad: Promise<SessionLifecycle> | null = null
  private numbersLoad: Promise<SessionNumberStore> | null = null
  /** False until a reconcile the Host answered has run; an unreachable Host never sets it. */
  private reconciled = false
  private mergeFlowValue: WorktreeMergeFlow | null = null
  private runtimes = new Map<string, RuntimeSessionInfo>()
  private orphans: OrphanInfo[] = []
  private snapshotValue: SessionsSnapshot | null = null
  private serializedValue = ''
  private queue: Promise<unknown> = Promise.resolve()
  private pendingRefresh: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private worktreeFactsInFlight = false
  private visible = true
  private started = false
  private lastReconcile: Omit<HostDebugStatus['reconcile'], 'refreshPending'> =
    { lastAt: null, lastReason: null, lastListingOk: null }
  private lastTickAt: number | null = null
  private launchViewValue: HostDebugStatus['launch'] | null = null

  constructor(private readonly deps: SessionManagerDeps) {
    this.client = new HostClient({
      descriptorFile: HostDescriptorPaths.descriptorFile(deps.configIdentity, deps.channel),
      // Every runtime event asks the same question - what does the Host have now - and one listing
      // answers it for all of them, so none of them is read for its own contents.
      onEvent: () => this.detach(this.refresh('event'), 'A Host event'),
      // Presence moves the snapshot's host block and nothing else: what the Host has is the
      // listing's business, and the poll is what asks for that.
      onPresence: () => this.changed(),
      onResync: () => this.detach(this.refresh('resync'), 'A Host resync'),
      onError: deps.onError,
      controllerId: deps.controllerId,
    })
    this.controller = new HostController({
      applicationRoot: deps.applicationRoot,
      resourcesRoot: deps.resourcesRoot,
      configDir: deps.configDir,
      channel: deps.channel,
      presenceOf: () => this.client.presence(),
      descriptorOf: () => this.client.descriptor(),
      onError: deps.onError,
      spawnImpl: deps.spawnImpl,
    })
    this.treeVersion = new HostTreeVersion(deps.applicationRoot)
    // Resolved ONCE here and handed to all three, so the worktree that gets cut, the branch that
    // lands and the checkpoint taken in between can never disagree about which repository they
    // are talking about. The callback itself is still read per operation.
    this.versioningModeOf = deps.versioningModeOf ?? (() => 'checkpoints')
    this.checkpoints = new GitCheckpointStore(new GitInvoker())
    const versioning = { modeOf: this.versioningModeOf, store: this.checkpoints }
    this.worktrees = new GitWorktreeManager(new GitInvoker(), versioning)
    this.merge = new GitMergeManager(new GitInvoker(), versioning)
    // Read-only by construction: with no snapshots directory every save is refused. The catalog has
    // one writer, the ProjectManager, and this is its second reader.
    this.catalog = CatalogView.load(deps.configDir, { report: deps.onError })
    // Built here the way the worktree manager is, and narrowed to `SessionSetupPort` where the
    // lifecycle takes it: this class owns the member, the lifecycle sees one method of it.
    this.projectSetup = new ProjectSetupManager({
      trustFile: OrchestratorPaths.setupTrustFile(deps.configIdentity, deps.channel),
      platformSettingsOf: deps.platformSettingsOf
        ?? (() => SetupFamilies.defaultPlatformSettings()),
      report: deps.onError,
    })
    this.monitor = new WorkStateMonitor({
      client: this.client,
      agentOf: (runtimeSessionId) => this.agentOf(runtimeSessionId),
      onChanged: () => this.changed(),
    })
    // The lease is shared rather than taken again: the Host holds one at a time, so a second
    // controller identity here would take this client's own away from every `runtime.*` call.
    this.terminals = new TerminalGateway({
      descriptorOf: () => this.client.descriptor(),
      leaseIdOf: () => this.client.controllerLeaseId(),
      refOf: (sessionId) => this.terminalRefOf(sessionId),
      onError: deps.onError,
      socketFactory: deps.terminalSocketFactory
        ?? ((socketDeps) => new TerminalAttachSocket(socketDeps)),
    })
    this.vcsFacts = deps.vcsStatusView === undefined
      ? null
      : new VcsFactsCache({
        view: deps.vcsStatusView,
        preferredVcsOf: deps.preferredVcsOf ?? (() => 'git'),
      })
  }

  /**
   * Descriptor watch, connect, lease, first reconcile, events, monitor - and, when the client asked
   * for it, the one automatic attempt at starting a Host. The client boots this as `void start()`,
   * so nothing here throws: everything that can go wrong is reported and the manager stays usable
   * with whatever did come up.
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      // The records are read before anything else can run: a reconcile over an unloaded store would
      // find no sessions at all and call every live runtime on the Host an orphan.
      const lifecycle = await this.lifecycle()
      this.client.start()
      this.armPoll()
      this.changed()
      await this.serialize(async () => {
        await this.reconcileNow(lifecycle, 'poll')
        await lifecycle.nameCodexOnStartup()
      })
      this.changed()
      if (this.deps.autoStartHost) await this.controller.ensureRunningOnce()
    } catch (error) {
      this.deps.onError(`The session manager could not start: ${ErrorText.of(error)}`)
    }
  }

  /**
   * Detach only: the socket closes, the lease is released if it can be, and no PTY dies.
   *
   * It is also the end of this manager. Starting it again would leave the descriptor watcher
   * believing it had already reported the descriptor it is still holding, so the socket would never
   * come back; the client builds one manager per process and disposes it when it quits.
   */
  async stop(): Promise<void> {
    this.started = false
    this.clearTimer()
    this.monitor.stop()
    this.terminals.closeAll()
    await this.client.stop()
  }

  snapshot(): SessionsSnapshot {
    return this.snapshotValue ?? this.recompose()
  }

  async workingContext(sessionId: string): Promise<SessionWorkingContextResult> {
    await this.lifecycle()
    const record = this.records?.get(sessionId)
    if (!record)
      return { ok: false, code: 'unknown-session', detail: `Session ${sessionId} does not exist` }
    // Narrowed rather than asserted: the guard below says nothing about `record.agent` to the
    // compiler, so reading the id off the narrowed object is what makes the pair provably one
    // record's. It was the only non-null assertion in this subsystem's production code.
    const agent = record.kind === 'agent' ? record.agent : undefined
    return {
      ok: true,
      value: {
        sessionId,
        cwd: SessionWorkingDirectory.ofRecord(record),
        agent: agent?.nativeSessionId
          ? { agentId: agent.agentId, nativeSessionId: agent.nativeSessionId }
          : null,
        worktree: record.worktree === undefined
          ? null
          : {
            worktreePath: record.worktree.worktreePath,
            repositoryRoot: record.worktree.repositoryRoot,
            baseCommit: record.worktree.baseCommit,
          },
      },
    }
  }

  async transcriptContext(sessionId: string): Promise<SessionTranscriptContextResult> {
    await this.lifecycle()
    const record = this.records?.get(sessionId)
    if (!record)
      return { ok: false, code: 'unknown-session', detail: `Session ${sessionId} does not exist` }
    const agent = record.kind === 'agent' ? record.agent : undefined
    return {
      ok: true,
      value: {
        agentId: agent?.agentId ?? null,
        cwd: record.transcriptCwd ?? SessionWorkingDirectory.ofRecord(record),
        nativeSessionId: agent?.nativeSessionId ?? null,
        launchModel: agent?.model ?? null,
      },
    }
  }

  /**
   * One session written down so that a SECOND agent knows which conversation is meant. The text is
   * composed by `SessionReference` and never here: the row of a paired computer is drawn from the
   * same composer, over a snapshot this manager never sees.
   *
   * The transcript is the one thing a snapshot cannot answer, so it is resolved here - against the
   * launch's own cwd, which is what the agent was actually started in.
   */
  async sessionReference(sessionId: string): Promise<SessionsOpResult<{ text: string }>> {
    await this.lifecycle()
    const record = this.records?.get(sessionId)
    const info = this.snapshot().sessions.find((session) => session.sessionId === sessionId)
    if (!record || info === undefined)
      return { ok: false, code: 'not-found', detail: `Session ${sessionId} does not exist` }
    // The agent pair is read off the snapshot, which composed it from this very record: the cwd is
    // the one thing only the record can answer, because the default directory resolves on the
    // machine that spawns the child.
    const transcript = this.deps.transcripts !== undefined && info.agent?.nativeSessionId
      ? await this.deps.transcripts.resolve({
        agentId: info.agent.agentId,
        cwd: record.transcriptCwd ?? SessionWorkingDirectory.ofRecord(record),
        nativeSessionId: info.agent.nativeSessionId,
      })
      : null
    return {
      ok: true,
      value: {
        text: SessionReference.text(SessionReference.factsOf(
          info,
          (this.deps.computerName ?? hostname)(),
          transcript?.file ?? null,
          {
            kind: 'local',
            controllerConfigIdentity: this.deps.configIdentity,
            controllerChannel: this.deps.channel,
          },
        )),
      },
    }
  }

  async createSession(
    spec: SessionCreateSpec,
  ): Promise<SessionsOpResult<{ sessionId: string; tabTitle: string }>> {
    return this.tabTitled(this.operate((lifecycle) => lifecycle.create(spec)))
  }

  async openHistorySession(
    spec: SessionHistoryOpenSpec,
  ): Promise<SessionsOpResult<{ sessionId: string; tabTitle: string }>> {
    return this.tabTitled(this.operate((lifecycle) => lifecycle.openHistory(spec)))
  }

  async historyReferences(
    directory: SessionHistoryOpenSpec['directory'],
  ): Promise<SessionsOpResult<{ references: SessionHistoryReference[] }>> {
    return this.operate((lifecycle) => lifecycle.historyReferences(directory))
  }

  /**
   * The one create derived from a session rather than described by a caller: forking the
   * conversation it is holding. Everything the fork needs is on the record; `name` is the single
   * thing a caller may say, because it is the one thing the record cannot know in advance.
   *
   * "Another session in the same place" was a second method here until 2026-09-10. It is an
   * ordinary create now: the card that asks for it fills the directory, the name and the agent in
   * from the session it was opened on, and the spec that comes back says everything this library
   * needs. A method whose whole body copied one field off a record was a second create path with
   * rules of its own - it made a plain tab, where the card makes a session of the tree.
   */
  async forkSession(
    sessionId: string,
    options?: { name?: string },
  ): Promise<SessionsOpResult<{ sessionId: string; tabTitle: string }>> {
    return this.tabTitled(this.operate((lifecycle) => lifecycle.forkFrom(sessionId, options)))
  }

  /**
   * Every create answers with the name a tab for it takes, so that no surface has to invent one. The
   * record is read back rather than composed from the spec: the library is what decides a default
   * title, and the place is what the catalog says it is once the session exists.
   */
  private async tabTitled(
    creating: Promise<SessionsOpResult<{ sessionId: string }>>,
  ): Promise<SessionsOpResult<{ sessionId: string; tabTitle: string }>> {
    const created = await creating
    if (!created.ok) return created
    const { sessionId } = created.value
    return { ok: true, value: { sessionId, tabTitle: this.tabTitleFor(sessionId) } }
  }

  private tabTitleFor(sessionId: string): string {
    const record = this.records?.get(sessionId)
    if (!record) throw new Error(`The session ${sessionId} left no record to be named after`)
    return SessionManager.tabTitleOf(
      record,
      this.catalog.read().bind(
        SessionWorkingDirectory.ofRecord(record),
        record.worktree?.repositoryRoot,
      ),
    )
  }

  async reopenSession(sessionId: string): Promise<SessionsOpResult> {
    return this.operate((lifecycle) => lifecycle.reopen(sessionId))
  }

  async stopSession(sessionId: string): Promise<SessionsOpResult> {
    return this.operate((lifecycle) => lifecycle.stop(sessionId))
  }

  /**
   * Being done with a session, as one action that always does the next step.
   *
   * For most sessions that is the stop, and the stop is the whole of it. A session with a worktree
   * has after-steps: the first press stops it, the next commits whatever it left and merges the
   * branch home, and a conflict on the way is a state to press through rather than a failure. Every
   * press plans afresh from the record, so pressing it again after anything went wrong continues
   * from wherever the disk actually is.
   *
   * There is no wait for the exit here, unlike `restartSession`. Nothing follows the stop within one
   * press, so there is nothing racing it: the next press is a new question asked of a new record.
   */
  async finalizeSession(sessionId: string): Promise<SessionsOpResult> {
    await this.lifecycle()
    const record = this.records?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    const step = FinalizeSteps.planOf(record)
    if (step === 'stop') {
      const stopped = await this.stopSession(sessionId)
      // The label on the next press is composed from these, and the agent's last writes landed
      // seconds ago; a reading up to thirty seconds old would promise the wrong thing at exactly the
      // moment somebody is about to press it again.
      if (stopped.ok) this.worktreeFacts.delete(sessionId)
      return stopped
    }
    else if (step === 'commit-and-merge')
      return this.afterMerge(() => this.mergeFlow().then((flow) => flow.commitAndMerge(sessionId)))
    else if (step === 'already-finalized') return { ok: true, value: undefined }
    else if (step === 'never-started')
      return {
        ok: false,
        code: 'launch-pending',
        detail: `Session ${sessionId} has no runtime on the Host, so there is nothing to finish; `
          + 'its launch is still pending and removing the session is what ends it',
      }
    else
      throw new Error(`Unknown finalize step: ${JSON.stringify(step)}`)
  }

  /**
   * Stop what is running and resume the same conversation in a fresh process: one operation, because
   * "restart this" is one thought and neither half of it is any use alone.
   *
   * A session that is not running skips straight to the reopen, which is what Rerun already does.
   *
   * The pair of marks looks alarming and is not: the stop writes `completed`, because stopping IS
   * finishing with something, and the reopen takes it off again, because running a session is the
   * opposite of being done with it. That is the established meaning of both, unchanged here.
   */
  async restartSession(sessionId: string): Promise<SessionsOpResult> {
    await this.lifecycle()
    const record = this.records?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    if (record.life === 'live') {
      const stopped = await this.stopSession(sessionId)
      if (!stopped.ok) return stopped
      // The Host answers a stop before the process is gone, and a reopen against a runtime that is
      // still alive comes back `live-refused`. The wait for the exit is what closes that race.
      if (!await this.awaitRuntimeExit(sessionId))
        return {
          ok: false,
          code: 'live-refused',
          detail: `Session ${sessionId} was asked to stop and was still running ${
            SessionManager.exitBudgetMillisecondsConst / 1_000} s later`,
        }
    }
    return this.reopenSession(sessionId)
  }

  /**
   * True once the Host lists no live runtime under this id.
   *
   * Deliberately OFF the operation queue: 011e measured what a long job on that one queue costs
   * everything behind it, and this one waits on a process exiting. Nothing here writes, so there is
   * nothing for a concurrent operation to trip over; the reopen that follows takes the queue again
   * in the ordinary way.
   *
   * A Host that cannot be reached answers true, and lets the reopen give the real refusal: a timeout
   * invented here would name the wrong problem.
   */
  private async awaitRuntimeExit(sessionId: string): Promise<boolean> {
    const clock = this.deps.exitClock ?? SessionManager.realExitClockConst
    const until = clock.now() + SessionManager.exitBudgetMillisecondsConst
    for (;;) {
      const listed = await this.client.runtimeList()
      if (!listed.ok) return true
      const runtime = listed.value.sessions
        .find((session) => session.runtimeSessionId === sessionId)
      if (runtime === undefined || !runtime.alive) return true
      if (clock.now() >= until) return false
      await clock.wait(SessionManager.exitPollMillisecondsConst)
    }
  }

  async removeSession(sessionId: string): Promise<SessionsOpResult> {
    return this.operate((lifecycle) => lifecycle.remove(sessionId))
  }

  /** Closing a plain tab: the one close that ends what is behind it. */
  async discardPlainSession(sessionId: string): Promise<SessionsOpResult> {
    return this.operate((lifecycle) => lifecycle.discardPlain(sessionId))
  }

  /** Answers with the name the tab takes once it is a session of the tree: the number is new. */
  async promotePlainSession(sessionId: string): Promise<SessionsOpResult<{ tabTitle: string }>> {
    const promoted = await this.operate((lifecycle) => lifecycle.promotePlain(sessionId))
    if (!promoted.ok) return promoted
    return { ok: true, value: { tabTitle: this.tabTitleFor(sessionId) } }
  }

  /**
   * Paint a session, or take its colour away with `null`.
   *
   * Deliberately not on `operate`, for the reason `number()` is not: this touches the records file
   * and nothing else, while that queue ends every turn with a full `runtime.list`. Picking a colour
   * must not cost a round trip to the Host.
   */
  async setSessionColor(
    sessionId: string,
    color: SessionColorName | null,
  ): Promise<SessionsOpResult> {
    return this.serialize(async () => {
      const lifecycle = await this.lifecycle()
      const result = await lifecycle.setColor(sessionId, color)
      this.changed()
      return result
    })
  }

  /**
   * The details dialog's Save: whichever of name, note and colour the update carries, as one
   * mutation. On `serialize` rather than `operate` for the reason `setSessionColor` is: this
   * touches the records file and nothing else, and a rename must not cost a round trip to the Host.
   */
  async setSessionDetails(
    sessionId: string,
    update: SessionDetailsUpdate,
  ): Promise<SessionsOpResult<SessionDetailsSaved>> {
    return this.serialize(async () => {
      const lifecycle = await this.lifecycle()
      const result = await lifecycle.setDetails(sessionId, update)
      this.changed()
      return result
    })
  }

  /** The one way out of a failed setup: the install is resolved again and run again. */
  async retrySetup(sessionId: string, acknowledgeSetup?: string): Promise<SessionsOpResult> {
    return this.operate((lifecycle) => lifecycle.retrySetup(sessionId, acknowledgeSetup))
  }

  /**
   * Bring a worktree session's branch home and take the worktree away with it.
   *
   * Deliberately NOT on `operate`: the git steps can take a while, and 011e measured what a long job
   * on that one queue costs everything queued behind it. What the merge does put through the records
   * store is only its own writes, which are as short as any other. The snapshot is recomposed
   * afterwards so the tree stops showing a worktree that is gone.
   */
  async mergeSession(sessionId: string): Promise<SessionsOpResult> {
    return this.afterMerge(() => this.mergeFlow().then((flow) => flow.mergeSession(sessionId)))
  }

  /** The other ending: the branch and the worktree go away and nothing is brought home. */
  async discardWorktree(sessionId: string): Promise<SessionsOpResult> {
    return this.afterMerge(() => this.mergeFlow().then((flow) => flow.discardWorktree(sessionId)))
  }

  private async afterMerge(work: () => Promise<SessionsOpResult>): Promise<SessionsOpResult> {
    const result = await work()
    this.changed()
    return result
  }

  private async mergeFlow(): Promise<WorktreeMergeFlow> {
    // The lifecycle load is what reads the records, and the flow writes to that same store.
    await this.lifecycle()
    const records = this.records
    if (!records) throw new Error('The records store was not loaded before a merge')
    this.mergeFlowValue ??= new WorktreeMergeFlow({
      records,
      merge: this.merge,
      modeOf: this.versioningModeOf,
      report: this.deps.onError,
      launchResolve: async (spec, marks) => {
        const lifecycle = await this.lifecycle()
        return this.operate(() => lifecycle.createInternal(spec, marks))
      },
    })
    return this.mergeFlowValue
  }

  async adoptOrphan(runtimeSessionId: string): Promise<SessionsOpResult> {
    return this.operate((lifecycle) => lifecycle.adoptOrphan(runtimeSessionId))
  }

  /**
   * What the next session in this project would be numbered, without taking the number. It is what a
   * create card shows while it is being filled in, and Escape must not cost the project a number.
   */
  async nextSessionNumber(projectPath: string): Promise<SessionsOpResult<{ token: string }>> {
    return this.number((numbers, records) => numbers.next(projectPath, records))
  }

  /**
   * Takes the number. Called once, at submit, immediately before the create that carries it - both
   * the title and the worktree slug are built from what this answers, never from what `next` showed.
   */
  async allocateSessionNumber(projectPath: string): Promise<SessionsOpResult<{ token: string }>> {
    return this.number((numbers, records) => numbers.allocate(projectPath, records))
  }

  /**
   * Deliberately not on `operate`: numbering touches neither the Host nor the records file, and that
   * queue ends every turn with a full reconcile. A card asking what the next number is must not cost
   * a `runtime.list`.
   */
  private async number(
    work: (
      numbers: SessionNumberStore,
      records: readonly SessionRecord[],
    ) => Promise<string | null>,
  ): Promise<SessionsOpResult<{ token: string }>> {
    // The lifecycle load is what reads the records, and the records are one of the three seeds.
    await this.lifecycle()
    const numbers = await this.numbers()
    const token = await work(numbers, this.records?.list() ?? [])
    if (token === null)
      return {
        ok: false,
        code: 'numbers-unavailable',
        detail: 'the session numbers for this machine could not be read or written',
      }
    return { ok: true, value: { token } }
  }

  private numbers(): Promise<SessionNumberStore> {
    this.numbersLoad ??= SessionNumberStore.load(
      OrchestratorPaths.sessionNumbersFile(this.deps.configIdentity, this.deps.channel),
      {
        report: this.deps.onError,
        // The same manager that CUTS a worktree says where they go, so the seed counts the
        // directory git actually writes into rather than one under the project.
        worktrees: this.worktrees,
      },
    )
    return this.numbersLoad
  }

  /** The manual attempt. There is no stopHost on purpose: `host.stop` kills every PTY. */
  async startHost(): Promise<SessionsOpResult> {
    const started = await this.controller.start()
    this.changed()
    if (started.ok) return { ok: true, value: undefined }
    return { ok: false, code: SessionManager.startCodeOf(started.code), detail: started.detail }
  }

  /**
   * A surface asks to watch one session and gets one answer now; everything after it arrives as
   * frames under the same id. The id is the surface's own, minted per attempt, so a surface that was
   * torn down and built again never collides with what it used to be.
   *
   * Not on the operation queue, and deliberately: attaching reads nothing the queue protects and
   * changes no record. Queueing it would make opening a terminal wait behind a worktree install.
   */
  terminalAttach(
    attachId: string,
    spec: TerminalAttachSpec,
    owner: TerminalAttachOwner,
  ): TerminalAttachResult {
    return this.terminals.attach(attachId, spec, owner)
  }

  terminalInput(attachId: string, data: string): TerminalInputResult {
    return this.terminals.input(attachId, data)
  }

  terminalResize(attachId: string, cols: number, rows: number): TerminalResizeResult {
    return this.terminals.resize(attachId, cols, rows)
  }

  terminalSetGeometryActive(attachId: string, active: boolean): TerminalResizeResult {
    return this.terminals.setGeometryActive(attachId, active)
  }

  terminalDetach(attachId: string): void {
    this.terminals.detach(attachId)
  }

  /** One client is gone. No runtime dies, exactly as when the whole manager stops. */
  terminalDetachAll(attachIds: readonly string[]): void {
    this.terminals.detachAll(attachIds)
  }

  /**
   * Everything this subsystem is holding about the Host, for the one surface built to look at it.
   * Composed out of state that is already here: no I/O, no timer of its own, so the freshness of
   * these facts is the freshness of the single cadence above - which is itself one of the facts.
   */
  debugStatus(): HostDebugStatus {
    const descriptor = this.client.descriptor()
    const client = this.client.debugView()
    return {
      capturedAt: Date.now(),
      presence: this.controller.presence(),
      // Field by field and never a spread. A spread would carry the token, and every field the Host
      // adds to its descriptor after this line was written.
      descriptor: descriptor === null ? null : {
        pid: descriptor.pid,
        port: descriptor.port,
        protocol: descriptor.protocol,
        capabilities: [...descriptor.capabilities],
        hostVersion: descriptor.hostVersion,
        payloadHash: descriptor.payloadHash,
        configIdentity: descriptor.configIdentity,
        runtimeChannel: descriptor.runtimeChannel,
        hostInstanceId: descriptor.hostInstanceId,
        hostGeneration: descriptor.hostGeneration,
        startedAt: descriptor.startedAt,
        processStartedAt: descriptor.processStartedAt,
      },
      clientProtocol: SessionManager.clientProtocolConst,
      expectedHostVersion: this.treeVersion.current(),
      controller: this.controller.debugView(),
      watcher: client.watcher,
      eventsSocket: client.eventsSocket,
      lease: client.lease,
      reconcile: { ...this.lastReconcile, refreshPending: this.pendingRefresh !== null },
      poll: {
        windowVisible: this.visible,
        cadenceMilliseconds: this.visible
          ? SessionManager.visiblePollMillisecondsConst
          : SessionManager.hiddenPollMillisecondsConst,
        lastTickAt: this.lastTickAt,
      },
      launch: this.launchView(),
      runtimes: this.debugRuntimeRows(),
      counts: {
        live: [...this.runtimes.values()].filter((runtime) => runtime.alive).length,
        dead: [...this.runtimes.values()].filter((runtime) => !runtime.alive).length,
        orphans: this.orphans.length,
      },
    }
  }

  /**
   * The one call this client makes that is not `runtime.list`, and the only I/O the debug surface
   * adds. Asked on demand and from one gated loop in the client above; never from the snapshot path,
   * which stays free of I/O. `GET /hello` is answered from the Host's memory, so it measures whether
   * an answer still comes at all rather than what the Host is doing.
   */
  async pingHost(): Promise<HostPingResult> {
    const at = Date.now()
    const answered = await this.client.hello()
    if (!answered.ok) return { at, ok: false, detail: `${answered.code}: ${answered.detail}` }
    const hello = answered.value.hello
    return {
      at,
      ok: true,
      latencyMilliseconds: answered.value.latencyMilliseconds,
      // Field by field even though `HostHello` carries no token: one discipline in both directions
      // is what keeps the day a field is added from being the day a secret ships.
      hello: {
        protocol: hello.protocol,
        buildVersion: hello.buildInfo.buildVersion,
        sourceRevision: hello.buildInfo.sourceRevision,
        platform: hello.buildInfo.platform,
        arch: hello.buildInfo.arch,
        hostGeneration: hello.hostGeneration,
        pid: hello.process.pid,
        runtimesLive: hello.runtimes.live,
        runtimesDead: hello.runtimes.dead,
        eventRevision: hello.eventRevision,
      },
    }
  }

  /** Nobody is looking: the same questions are worth asking, just far less often. */
  setWindowVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    this.armPoll()
  }

  private async operate<T>(
    work: (lifecycle: SessionLifecycle) => Promise<SessionsOpResult<T>>,
  ): Promise<SessionsOpResult<T>> {
    return this.serialize(async () => {
      const lifecycle = await this.lifecycle()
      const result = await work(lifecycle)
      // What the Host answered is not the whole picture; what it lists afterwards is. Taking that
      // here is what makes the snapshot true by the time the call returns.
      await this.reconcileNow(lifecycle, 'operation')
      this.changed()
      return result
    })
  }

  /**
   * One thing at a time against the records and the Host. The queue never rejects: a failed piece of
   * work is the caller's to see, and it must not stop everything queued behind it.
   */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Coalesced: a burst of events is one listing, not one per event. The flag is cleared as the work
   * starts, so an event that arrived while it ran still earns the next pass. The reason travels with
   * the pass that is actually made, so a burst is named by the first thing that asked for it.
   */
  private refresh(reason: ReconcileReason): Promise<void> {
    this.pendingRefresh ??= this.serialize(async () => {
      this.pendingRefresh = null
      await this.reconcileNow(await this.lifecycle(), reason)
      this.changed()
    })
    return this.pendingRefresh
  }

  private async reconcileNow(
    lifecycle: SessionLifecycle,
    reason: ReconcileReason,
  ): Promise<void> {
    const listed = await this.client.runtimeList()
    this.lastReconcile = { lastAt: Date.now(), lastReason: reason, lastListingOk: listed.ok }
    if (listed.ok) this.reconciled = true
    // A Host that cannot be reached has told this client nothing. The runtimes it last named stand,
    // the reconciler is handed null and relabels nothing: unreachable is not lost.
    const listing = listed.ok ? listed.value : null
    if (listing !== null) this.applyListing(listing)
    const changes = await lifecycle.reconcile(listing)
    if (listing !== null) {
      this.applyOrphans(listing, changes)
      // The monitor reads this same answer instead of asking the Host for a second copy of it, and
      // it reads it OFF the queue: rendering a screen per session is not something an operation may
      // wait behind. It reports its own verdicts through `onChanged`.
      this.detach(this.monitor.observe(listing), 'The work-state monitor')
    }
  }

  private applyListing(listing: RuntimeListResult): void {
    this.runtimes = new Map(listing.sessions.map((session) => [session.runtimeSessionId, session]))
  }

  /** Which runtimes are orphans is the reconciler's verdict; what they are is the listing's. */
  private applyOrphans(listing: RuntimeListResult, changes: readonly ReconcileChange[]): void {
    const orphaned = new Set<string>()
    for (const change of changes)
      if (change.kind === 'orphan') orphaned.add(change.runtimeSessionId)
    this.orphans = listing.sessions
      .filter((session) => orphaned.has(session.runtimeSessionId))
      .map((session) => ({
        runtimeSessionId: session.runtimeSessionId,
        alive: session.alive,
        startedAt: session.startedAt,
      }))
  }

  private lifecycle(): Promise<SessionLifecycle> {
    this.lifecycleLoad ??= this.buildLifecycle()
    return this.lifecycleLoad
  }

  /** Read once and held: the records file is this client's own, and it has no second writer. */
  private async buildLifecycle(): Promise<SessionLifecycle> {
    const records = await SessionRecordsStore.load(
      OrchestratorPaths.sessionRecordsFile(this.deps.configIdentity, this.deps.channel),
      {
        snapshotsDirectory: OrchestratorPaths.sessionSnapshotsDirectory(
          this.deps.configIdentity,
          this.deps.channel,
        ),
        report: this.deps.onError,
      },
    )
    this.records = records
    const lifecycle = new SessionLifecycle({
      controller: { configIdentity: this.deps.configIdentity, channel: this.deps.channel },
      records,
      host: this.client,
      worktrees: this.worktrees,
      setup: this.projectSetup,
      // Deferred rather than the store itself: the numbers file is read on first use, and a
      // promotion is the only thing in the lifecycle that ever asks for one.
      numbers: {
        allocate: async (projectPath, list) => (await this.numbers()).allocate(projectPath, list),
      },
      codexRollouts: CodexRolloutView.load({
        codexHome: this.deps.codexHome,
        report: this.deps.onError,
      }),
      claudeTitles: ClaudeTitleWriter.load({
        claudeHome: this.deps.claudeHome,
        report: this.deps.onError,
      }),
      report: this.deps.onError,
      yoloFor: this.deps.yoloFor,
      modelFor: this.deps.modelFor,
      effortFor: this.deps.effortFor,
    })
    // Fired rather than awaited: the reconcile loop that produces it holds the one queue every
    // operation shares, and a merge does git work. The merge's own idempotence is what makes that
    // safe - it reads the disk, so a second run does whatever is still missing and nothing twice.
    lifecycle.setResumeMerge((sessionId) => {
      void this.mergeSession(sessionId).catch((thrown: unknown) => {
        this.deps.onError(`Continuing the merge of ${sessionId} failed: ${ErrorText.of(thrown)}`)
      })
    })
    return lifecycle
  }

  private armPoll(): void {
    this.clearTimer()
    if (!this.started) return
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.detach(this.tick(), 'The session poll')
      },
      this.visible
        ? SessionManager.visiblePollMillisecondsConst
        : SessionManager.hiddenPollMillisecondsConst,
    )
    this.timer.unref()
  }

  /**
   * `runtime.list` is what answers everything the events do not: output moves without a lifecycle
   * event, and a runtime nobody recorded arrives without one either. It is the only listing this
   * client asks for - the work-state monitor is handed this same answer. The git facts are measured
   * beside it rather than inside it, because a diff of a large repository must never be something an
   * operation queues behind.
   */
  private async tick(): Promise<void> {
    this.lastTickAt = Date.now()
    try {
      this.detach(this.refreshWorktreeFacts(), 'The worktree facts')
      this.detach(this.refreshVcsFacts(), 'The VCS facts')
      await this.refresh('poll')
    } finally {
      this.armPoll()
    }
  }

  /**
   * The end of every promise nobody is waiting for. `start()` is the one path with a caller to
   * report to; a timer, an event and a detached pass have none, and an unhandled rejection out of
   * one of them takes down the client's main process. The store's writes are synchronous `fs` and
   * throw on EPERM, ENOSPC or a locked file, so this is not a hypothetical.
   */
  private detach(work: Promise<unknown>, what: string): void {
    void work.catch((error) => this.deps.onError(`${what} failed: ${ErrorText.of(error)}`))
  }

  private async refreshWorktreeFacts(): Promise<void> {
    if (this.worktreeFactsInFlight) return
    this.worktreeFactsInFlight = true
    try {
      const now = Date.now()
      const known = new Set<string>()
      let moved = false
      for (const record of this.records?.list() ?? []) {
        const worktree = record.worktree
        if (!worktree) continue
        known.add(record.sessionId)
        const captured = this.worktreeFacts.get(record.sessionId)
        if (captured && now - captured.capturedAt < SessionManager.worktreeFactsMillisecondsConst)
          continue
        // A repository that moved, went away or was never one leaves the diff UNKNOWN rather than
        // reported: a session whose worktree cannot be measured still runs perfectly well, and a
        // line on the client's error channel every 30 s would say nothing new.
        const diff = await this.worktrees.refreshDiff(worktree.worktreePath, worktree.baseCommit)
        const base = await this.worktrees.baseMoved(worktree.repositoryRoot, worktree)
        this.worktreeFacts.set(record.sessionId, {
          capturedAt: Date.now(),
          diff: diff.ok ? diff.value : null,
          baseMoved: base.ok ? base.value : false,
        })
        moved = true
      }
      for (const sessionId of [...this.worktreeFacts.keys()]) {
        if (known.has(sessionId)) continue
        this.worktreeFacts.delete(sessionId)
        moved = true
      }
      if (moved) this.changed()
    } finally {
      this.worktreeFactsInFlight = false
    }
  }

  /**
   * What the working copy under each session looks like, measured beside the worktree facts and
   * never inside an operation: a probe is a child process per working copy, and a create must never
   * queue behind one.
   *
   * Stricter than the worktree pass about visibility. With no window on screen there is nobody to
   * draw a mark for, so nothing is measured at all; the staleness windows then catch everything up
   * within a tick of a window coming back.
   */
  settleVcs(cwd: string): void {
    this.vcsFacts?.markStale(cwd)
  }

  private async refreshVcsFacts(): Promise<void> {
    if (this.vcsFacts === null || !this.visible) return
    const cwds = new Set<string>()
    const alive = new Set<string>()
    for (const record of this.records?.list() ?? []) {
      alive.add(record.sessionId)
      const cwd = SessionManager.vcsKeyOf(record)
      // A turn that has just finished is precisely when the mark is out of date, so the directory
      // behind it is re-read on the next pass instead of waiting out its window.
      const activity = this.activityOf(record)
      const before = this.lastVcsActivity.get(record.sessionId)
      if (before === 'working' && (activity === 'waiting' || activity === 'idle'))
        this.vcsFacts.markStale(cwd)
      this.lastVcsActivity.set(record.sessionId, activity)
      // A worktree session stays measured after it ends: what Finish promises is drawn from this.
      if (SessionManager.measuredLife(record.life) || record.worktree) cwds.add(cwd)
    }
    for (const sessionId of [...this.lastVcsActivity.keys()])
      if (!alive.has(sessionId)) this.lastVcsActivity.delete(sessionId)
    if (await this.vcsFacts.refresh(cwds)) this.changed()
  }

  /**
   * The Host's runtimes joined to this client's records, dead ones included. The table exists for
   * the difference between what the client believes and what the Host is actually holding, and a
   * runtime nobody has a record for - the row with no title - is exactly where that shows.
   */
  private debugRuntimeRows(): HostDebugRuntimeRow[] {
    const orphaned = new Set(this.orphans.map((orphan) => orphan.runtimeSessionId))
    return [...this.runtimes.values()].map((runtime) => ({
      runtimeSessionId: runtime.runtimeSessionId,
      sessionTitle: this.records?.get(runtime.runtimeSessionId)?.title ?? null,
      orphan: orphaned.has(runtime.runtimeSessionId),
      alive: runtime.alive,
      pid: runtime.pid ?? null,
      generation: runtime.generation,
      startedAt: runtime.startedAt,
      exitedAt: runtime.exitedAt ?? null,
      exitCode: runtime.exitCode ?? null,
      exitReason: runtime.exitReason ?? null,
      outputSeq: runtime.outputSeq,
      lastOutputAt: runtime.lastOutputAt,
      work: this.workViewOf(runtime.runtimeSessionId),
    }))
  }

  /**
   * The classifier's own answer, formatted for reading and for nothing else. Null wherever the
   * monitor has never classified: a shell, an orphan, a runtime whose screen has not been rendered.
   */
  private workViewOf(runtimeSessionId: string): HostDebugRuntimeRow['work'] {
    const inspection = this.monitor.inspection(runtimeSessionId)
    if (inspection === null) return null
    // Deduplicated: three footer patterns matching in one window are one fact about that window,
    // and a reader wants which signals fired, never how many times.
    return {
      hint: inspection.hint,
      signals: [...new Set(inspection.evidence.map((item) => `${item.source}:${item.signal}`))],
    }
  }

  /**
   * What this client would spawn, measured once: the locator reads the disk to decide, and which
   * tree the client stands in does not change while it runs.
   */
  private launchView(): HostDebugStatus['launch'] {
    this.launchViewValue ??= SessionManager.launchViewOf(HostLaunchLocator.launch(
      { applicationRoot: this.deps.applicationRoot, resourcesRoot: this.deps.resourcesRoot },
      this.deps.configDir,
      this.deps.channel,
    ))
    return this.launchViewValue
  }

  /**
   * `env` is dropped HERE and not on the way out, so there is exactly one place it could ever have
   * been carried from: the locator hands over the whole of `process.env`, and every variable this
   * machine holds is not something a window draws.
   */
  private static launchViewOf(located: HostLaunchResult): HostDebugStatus['launch'] {
    if (located.ok)
      return {
        ok: true,
        command: located.launch.command,
        args: [...located.launch.args],
        cwd: located.launch.cwd,
        refusal: null,
      }
    return { ok: false, command: null, args: [], cwd: null, refusal: located.reason }
  }

  private changed(): void {
    const previous = this.snapshotValue
    if (this.recompose() !== previous) this.deps.onChanged()
  }

  /** The revision moves only where the content did, so the two are one answer and never two. */
  private recompose(): SessionsSnapshot {
    const composed = this.compose()
    const serialized = JSON.stringify(composed)
    const previous = this.snapshotValue
    if (previous !== null && serialized === this.serializedValue) return previous
    this.serializedValue = serialized
    this.snapshotValue = { revision: (previous?.revision ?? 0) + 1, ...composed }
    return this.snapshotValue
  }

  private compose(): Omit<SessionsSnapshot, 'revision'> {
    // One reading for the whole snapshot: the categories block and the bindings beside it have to
    // come from the same document, and the store re-reads whenever the file changes on disk.
    const catalog = this.catalog.read()
    return {
      host: {
        presence: this.controller.presence(),
        hostVersion: this.controller.hostVersion(),
        hostInstanceId: this.controller.hostInstanceId(),
        liveCount: [...this.runtimes.values()].filter((runtime) => runtime.alive).length,
        lastStartError: this.controller.lastStartError(),
      },
      categories: catalog.categories.map((category) => ({
        id: category.id,
        label: category.label,
        path: category.path,
      })),
      sessions: (this.records?.list() ?? [])
        .map((record) => this.sessionInfoOf(record, catalog)),
      orphans: this.orphans,
      reconciled: this.reconciled,
    }
  }

  private sessionInfoOf(record: SessionRecord, catalog: CatalogReading): SessionInfo {
    // The repository root wins over the cwd: a session inside `<project>/.worktrees/<slug>`
    // belongs to the project, not to a project called `.worktrees`.
    const project = catalog.bind(
      SessionWorkingDirectory.ofRecord(record),
      record.worktree?.repositoryRoot,
    )
    const info: SessionInfo = {
      sessionId: record.sessionId,
      kind: record.kind,
      title: record.title,
      titleParts: SessionTitle.partsOf(record.title),
      tabTitle: SessionManager.tabTitleOf(record, project),
      directory: record.directory,
      project,
      life: record.life,
      activity: this.activityOf(record),
      admits: this.admitsOf(record),
    }
    const activityDetail = this.monitor.activityDetail(record.sessionId)
    if (activityDetail !== null) info.activityDetail = activityDetail
    if (record.agent)
      info.agent = {
        agentId: record.agent.agentId,
        nativeSessionId: record.agent.nativeSessionId,
      }
    if (record.worktree) info.worktree = this.worktreeInfoOf(record.sessionId, record.worktree)
    const vcs = this.vcsFacts?.factOf(SessionManager.vcsKeyOf(record))
    if (vcs) info.vcs = vcs
    const setup = this.setupInfoOf(record)
    if (setup) info.setup = setup
    if (record.setupFor !== undefined) info.setupFor = record.setupFor
    if (record.resolveFor !== undefined) info.resolveFor = record.resolveFor
    if (record.worktreeMerge)
      info.merge = {
        phase: record.worktreeMerge.phase,
        resolveSessionId: record.worktreeMerge.resolveSessionId,
        failure: record.worktreeMerge.failure,
        startedAt: record.worktreeMerge.startedAt,
      }
    if (record.endedAt !== undefined) info.endedAt = record.endedAt
    if (record.exitCode !== undefined) info.exitCode = record.exitCode
    if (record.endedReason !== undefined) info.endedReason = record.endedReason
    // Only once the wait is worth saying. `LaunchBackoff` owns that threshold, so the row and the
    // pacing cannot end up disagreeing about when a launch has stopped merely starting.
    if (LaunchBackoff.visible(record.launchWait) && record.launchWait !== undefined)
      info.launchWait = {
        reason: record.launchWait.reason,
        attempts: record.launchWait.attempts,
      }
    if (record.presentation !== undefined) info.presentation = record.presentation
    if (record.completed !== undefined) info.completed = record.completed
    // Derived here rather than drawn from the exit code by whoever shows the row: what a kill code
    // means is this library's to say, and a surface that re-read the number would say it differently.
    const outcome = SessionOutcomes.of(record)
    if (outcome !== null) info.outcome = outcome
    // Filtered rather than copied: a name this build does not know is a record somebody can still
    // work in, so it loses its colour here and keeps everything else.
    if (SessionColors.isName(record.color)) info.color = record.color
    if (record.note !== undefined) info.note = record.note
    return info
  }

  /**
   * What a tab holding this session is called: WHERE it runs, and then what the session is called
   * there. The place comes first because that is what a person picks a tab by - a row of tabs
   * reading `001`, `002`, `001` says nothing about which project each belongs to, and the number is
   * the prefix of the TITLE rather than of the project.
   *
   * It is composed here rather than by the surface that opens the tab: the launcher, the sessions
   * tree, a fork and a promotion all open one, and four composers are four names for one session.
   */
  private static tabTitleOf(record: SessionRecord, project: ProjectBinding): string {
    const place = SessionManager.placeOf(record, project)
    const title = record.title.trim()
    return title.length === 0 ? place : `${place} - ${title}`
  }

  private static placeOf(record: SessionRecord, project: ProjectBinding): string {
    // A session with no directory of its own runs in the home directory, and naming its tab after
    // the account it belongs to would say nothing about the session.
    if (record.directory.mode === 'default') return SessionManager.placelessConst
    if (project.kind === 'project') return project.projectName
    else if (project.kind === 'adHoc') return basename(project.path) || project.path
    else if (project.kind === 'none') return SessionManager.placelessConst
    else throw new Error(`Unknown project binding: ${JSON.stringify(project)}`)
  }

  /**
   * Which operations this session admits, read off the record alone.
   *
   * No I/O and no Host: this runs once per session on every recompose, and the snapshot path is the
   * one place in this class that is allowed to cost nothing. Where an answer needs the world - which
   * terminal is attached, whether the Host is up - the operation refuses at the time it is called,
   * and that refusal is the honest one. This says only what the record already knows.
   */
  private admitsOf(record: SessionRecord): SessionOperation[] {
    const admits: SessionOperation[] = []
    if (record.kind === 'agent') {
      // Still a question this library answers, and no longer a method of it: "can another session be
      // started in this one's place" is what a menu asks before it offers the row, and the row now
      // opens the create card rather than calling a create of its own.
      admits.push('newBeside')
      // No id, nothing to fork from. A Claude session is told its id at launch, a Codex one earns
      // this the moment its id is found, and a fork of either now has one of its own. Not a
      // resolver: its worktree goes when the merge it is settling is done.
      if (record.agent?.nativeSessionId !== undefined && record.resolveFor === undefined)
        admits.push('fork')
      if (record.life === 'live') admits.push('compact')
    }
    // Another flow is holding this record, and restarting under it would race whoever owns it:
    // `starting` belongs to the reconciler, the other four to setup and to the merge.
    const held = record.life === 'starting'
      || record.pendingSetup !== undefined
      || record.worktreeMerge !== undefined
      || record.setupFor !== undefined
      || record.resolveFor !== undefined
    // The same gate the reopen itself applies, asked before the item is drawn rather than after it
    // is clicked. A shell has no conversation to name, so nothing can be wrong with resuming it.
    const reopenable = record.kind === 'shell'
      || (record.agent !== undefined && AgentPresets.reopenProblem(record.agent) === null)
    // `restartSession` stops a live runtime before it reopens it, so live and ended records share
    // this capability. A lost screen is different: the terminal panel branches on `life` first and
    // reconnects its attach without invoking the restart operation.
    if (!held && reopenable) admits.push('restart')

    // The row's four, each mirroring the refusal the operation itself would give. They are read
    // off the record like the rest; the one that needs a SECOND record says so where it does.
    if (FinalizeSteps.offers(record)) admits.push('finalize')
    // What `remove` refuses: a live session, and a `starting` one the Host has a runtime for.
    // A `starting` record with no binding names nothing on the Host and is removable.
    if (record.life !== 'live' && !(record.life === 'starting' && record.binding !== null))
      admits.push('remove')
    if (this.discardable(record)) admits.push('discardWorktree')
    // The one way out of a failed install: the wait is still on the record and the session it
    // was preparing has ended, which is what `setupInfoOf` reads as `failed`.
    if (record.pendingSetup !== undefined && (record.life === 'ended' || record.life === 'lost'))
      admits.push('retrySetup')
    return admits
  }

  /**
   * Whether a discard would be taken rather than refused, which is the one row action that needs
   * more than this record: `WorktreeMergeFlow.refuse` also refuses while the RESOLVER is live - a
   * second session standing in that same directory, whose life the primary record says nothing
   * about. A conflicted merge is `ended` by then and the agent resolving it is very much not.
   */
  private discardable(record: SessionRecord): boolean {
    if (record.worktree === undefined) return false
    if (record.life === 'live' || record.life === 'starting') return false
    const resolver = record.worktreeMerge?.resolveSessionId
    const resolving = resolver === undefined ? undefined : this.records?.get(resolver)
    return resolving?.life !== 'live' && resolving?.life !== 'starting'
  }

  /**
   * A wait that is still on the record is read against the life beside it, because the record says
   * what the session is waiting for and never that the wait is over: the lifecycle clears it, and
   * `failed` is simply the wait outliving the session.
   *
   * A `live` session carrying one is the exception with no marker at all. Binding a runtime clears
   * the wait, so the only way to see that pair is a record written by an older build or edited by
   * hand - and a session the Host is demonstrably running is past its install whatever it still says.
   */
  private setupInfoOf(record: SessionRecord): SessionSetupInfo | null {
    if (record.pendingSetup) {
      const setupSessionId = record.pendingSetup.setupSessionId
      // Read off the install's OWN record, which is where the resolved commands were written: the
      // waiting session knows it is waiting and never what for.
      const commands = (this.records?.get(setupSessionId)?.commands ?? [])
        .map((step) => step.command)
      if (record.life === 'starting') return { state: 'running', setupSessionId, commands }
      else if (record.life === 'ended' || record.life === 'lost')
        return { state: 'failed', setupSessionId, commands }
      else if (record.life === 'live') return null
      else throw new Error(`Unknown session life: ${JSON.stringify(record.life)}`)
    }
    if (record.setupSkipped) return { state: 'skipped', reason: record.setupSkipped.reason }
    return null
  }

  private worktreeInfoOf(
    sessionId: string,
    worktree: SessionRecordWorktree,
  ): SessionWorktreeInfo {
    const facts = this.worktreeFacts.get(sessionId)
    return {
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
      baseCommit: worktree.baseCommit,
      diff: facts?.diff ?? null,
      baseMoved: facts?.baseMoved ?? false,
    }
  }

  /**
   * The key a working-copy fact is remembered and read by. Resolved rather than taken raw: the
   * whole economy rests on two sessions of one project producing ONE string, and a directory
   * spelled differently in two records would quietly buy a second child process every window.
   */
  private static vcsKeyOf(record: SessionRecord): string {
    return resolve(SessionWorkingDirectory.ofRecord(record))
  }

  /**
   * Whether a session is worth measuring for its own sake. A worktree session is measured in every
   * life on top of this, because what Finish promises is drawn from the same fact after the end.
   */
  private static measuredLife(life: SessionInfo['life']): boolean {
    if (life === 'live' || life === 'starting') return true
    else if (life === 'ended' || life === 'lost') return false
    else
      throw new Error(`Unknown session life: ${JSON.stringify(life)}`)
  }

  /** Nothing classifies a plain terminal; an agent nothing has classified yet is `unknown`. */
  private activityOf(record: SessionRecord): SessionActivity | null {
    if (this.agentOf(record.sessionId) === null) return null
    return this.monitor.activity(record.sessionId) ?? 'unknown'
  }

  /**
   * The whole `RuntimeRef` an attach needs, out of what this class already holds: the session id is
   * the runtime id forever, the generation comes from the listing and the Host names itself in the
   * descriptor. It is resolved per attempt rather than handed out once, because a reopened session
   * runs under a new generation and a Host that restarted has none of our runtimes at all.
   */
  private terminalRefOf(sessionId: string): TerminalRefResolution {
    if (!this.records?.get(sessionId)) return { ok: false, code: 'unknown-session' }
    const runtime = this.runtimes.get(sessionId)
    const hostInstanceId = this.client.descriptor()?.hostInstanceId
    // `not-live` is the Host having NO runtime for this record - what a restart of the machine
    // leaves behind. A runtime it still has and no longer runs is a different thing and resolves:
    // its last screen is what says why it stopped, and refusing it threw that away.
    if (runtime === undefined || hostInstanceId === undefined)
      return { ok: false, code: 'not-live' }
    return {
      ok: true,
      ref: { hostInstanceId, runtimeSessionId: sessionId, generation: runtime.generation },
      alive: runtime.alive,
    }
  }

  private agentOf(runtimeSessionId: string): SessionRecordAgent['agentId'] | null {
    const record = this.records?.get(runtimeSessionId)
    if (!record) return null
    if (record.kind === 'shell') return null
    else if (record.kind === 'agent') return record.agent?.agentId ?? null
    else throw new Error(`Unknown session kind: ${JSON.stringify(record.kind)}`)
  }

  /** Carried verbatim, the way the lifecycle carries the Host client's and git's own codes. */
  private static startCodeOf(code: HostStartErrorCode): SessionsOpErrorCode {
    if (code === 'already-running') return 'already-running'
    else if (code === 'spawn-failed') return 'spawn-failed'
    else if (code === 'boot-timeout') return 'boot-timeout'
    else throw new Error(`Unknown Host start failure: ${JSON.stringify(code)}`)
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
