import { hostname } from 'node:os'
import { basename, join, resolve } from 'node:path'

import type {
  HostWireConst,
  RuntimeListResult,
  RuntimeSessionInfo,
} from '../../app-host/app/wire/hostWire.js'
import type { FileChangesVcsId } from '../fileChangesManager/fileChangesManagerApi.types'
import type { VcsStatusView } from '../fileChangesManager/vcsStatusView'
import { GitInvoker } from '../git/gitInvoker'
import { GitMergeManager } from '../git/gitMergeManager'
import { GitWorktreeManager } from '../git/gitWorktreeManager'
import { StoreCutWorktrees } from '../git/storeCutWorktrees'
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
import { CodexSessionFiles } from './launch/codexSessionFiles'
import { RunTools } from './launch/runTools'
import type { ProjectBinding } from '../projectManager/projectManagerApi.types'
import type { ProviderTranscriptView } from '../projectManager/providerTranscriptView'
import type { PlatformSettingsValue } from '../projectSetup/projectSetup.types'
import { ProjectSetupManager } from '../projectSetup/projectSetupManager'
import { SetupFamilies } from '../projectSetup/setupFamilies'
import type { RuntimeChannel } from '../shared/configIdentity.types'
import { ErrorText } from '../shared/errorText'
import { OrchestratorPaths } from '../shared/orchestratorPaths'
import { PathCompare } from '../shared/pathCompare'
import { ProductGroup } from '../shared/productGroup'
import type { TreeRemove } from '../shared/treeRemoval'
import { SvnInvoker } from '../svn/svnInvoker'
import { SvnWorktreeManager } from '../svn/svnWorktreeManager'
import { AgentPresets } from './launch/agentPresets'
import { FinalizeSteps } from './lifecycle/finalizeSteps'
import { LandedRows } from './lifecycle/landedRows'
import { LaunchBackoff } from './lifecycle/launchBackoff'
import type { ReconcileChange } from './lifecycle/reconciler'
import { SessionLifecycle, type SessionWorktreePort } from './lifecycle/sessionLifecycle'
import { SvnActionFlow } from './lifecycle/svnActionFlow'
import { SvnActionStages } from './lifecycle/svnActionStages'
import { SvnResolverLauncher } from './lifecycle/svnResolverLauncher'
import { SvnRevisionLabels } from './lifecycle/svnRevisionLabels'
import { SvnWorktreeFinishFlow } from './lifecycle/svnWorktreeFinishFlow'
import { SvnWorktreeRemoval } from './lifecycle/svnWorktreeRemoval'
import type {
  WorktreeChoicesInput,
  WorktreeFinishFacts,
  WorktreeFinisher,
} from './lifecycle/worktreeFinish.types'
import { WorktreeCleanupPacing } from './lifecycle/worktreeCleanupPacing'
import { WorktreeMergeFlow } from './lifecycle/worktreeMergeFlow'
import { WorktreeOwner, type WorktreeOwnerDeps } from './lifecycle/worktreeOwner'
import {
  CheckpointsWorktreeProvisioner,
  GitWorktreeProvisioner,
  SvnWorktreeProvisioner,
} from './lifecycle/worktreeProvisioners'
import { SessionColors } from './sessionColors'
import { SessionNumberStore } from './records/sessionNumberStore'
import { SessionOutcomes } from './records/sessionOutcomes'
import type {
  SessionRecord,
  SessionRecordAgent,
  SessionRecordScriptLink,
  SessionRecordWorktree,
} from './records/sessionRecord.types'
import { SessionRecordsStore } from './records/sessionRecordsStore'
import { SessionTitle } from './records/sessionTitle'
import { CommandAgreement } from './scripts/commandAgreement'
import { CommandTrustStore } from './scripts/commandTrustStore'
import { WorktreeResultsStore } from './results/worktreeResultsStore'
import { SessionNotifyStore } from './notifies/sessionNotifyStore'
import type { SessionNotifyDto } from './sessionManagerApi.types'
import { ScriptLogStore } from './scripts/scriptLogStore'
import { type ScriptCollapsed, SessionScriptsManager } from './scripts/sessionScriptsManager'
import { SessionScriptDefinitions } from './scripts/sessionScriptDefinitions'
import type {
  HostDebugRuntimeRow,
  HostDebugStatus,
  HostPingResult,
  OrphanInfo,
  SessionActivity,
  SessionAgentId,
  SessionColorName,
  SessionCommitReceipt,
  SessionCreated,
  SessionCreateSpec,
  SessionDetailsSaved,
  SessionDetailsUpdate,
  SessionFinishChoice,
  SessionFinishPress,
  SessionHistoryOpenSpec,
  SessionHistoryReference,
  SessionInfo,
  SessionLiveBrief,
  SessionLocalHistoryEntry,
  SessionOperation,
  SessionScriptRequest,
  SessionScriptsReading,
  SessionSetupInfo,
  SessionsOpErrorCode,
  SessionsOpResult,
  SessionsSnapshot,
  SessionWorktreeInfo,
  SessionWorktreeKind,
  SessionWorktreePlace,
  SessionWorktreeState,
  SvnLabelledRevision,
  TerminalAttachResult,
  TerminalAttachSpec,
  TerminalComposerContentResult,
  TerminalComposerResult,
  WorktreeResultDto,
  WorktreeResultsFilter,
} from './sessionManagerApi.types'
import type { SessionEditorPort, SessionReviewPort } from './sessionReviewPort.types'
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
import { AgentComposerReader } from './workState/agentComposerReader'
import { ScreenTail } from './workState/screenTail'
import { WorkStateMonitor } from './workState/workStateMonitor'

export { SessionNotifier, type SessionNotifyPort } from './notifies/sessionNotifier'

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
   * A session this manager removed on its own, after its worktree ended as asked. No surface asked
   * for that Remove, so closing its tabs is the composer's. Optional: the tests and smokes have none.
   */
  onRemovedItself?: (sessionId: string) => void
  /**
   * A script run went into its parent's history. Its tab is the composer's: `parent-tab` gives it to
   * the parent, `close` closes it. Optional for the same reason as the one above.
   */
  onScriptCollapsed?: (event: ScriptCollapsed) => void
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
  /**
   * How a worktree directory goes after its session. Optional: Node's own `rm` when absent
   * (`TreeRemoval`), which is wrong only inside Electron, so the client passes its own.
   */
  removeTree?: TreeRemove
  /** @deprecated Identity is confirmed by app-server. Retained for existing library callers. */
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
        kind: SessionWorktreeKind
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

interface WorktreeFactsView extends WorktreeFinishFacts {
  capturedAt: number
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
  /** How many times `stop` re-reads the work still in flight before it gives up on it out loud. */
  private static readonly settleRoundsConst = 8
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
  private readonly versioningModeOf: () => VersioningMode
  private readonly worktrees: GitWorktreeManager
  private readonly svnWorktrees: SvnWorktreeManager
  /** Where `svn` and the Jamat CLI are on this machine, for runs and for the refusal of an SVN Commit. */
  private readonly tools: RunTools
  /** Reads the mode once per create and hands the create to that mode's provisioner. */
  private readonly worktreePort: SessionWorktreePort
  /** What the owner rule of an SVN worktree and of an UPDATE reads: groups, the catalog and svn. */
  private readonly ownerDeps: WorktreeOwnerDeps
  /** Shared with the merge flow: two instances would ask the same repositories the same questions. */
  private readonly merge: GitMergeManager
  private readonly catalog: CatalogView
  private readonly projectSetup: ProjectSetupManager
  private readonly agreement: CommandAgreement
  private readonly monitor: WorkStateMonitor
  private readonly terminals: TerminalGateway
  private readonly worktreeFacts = new Map<string, WorktreeFactsView>()
  private readonly vcsFacts: VcsFactsCache | null
  private readonly scriptLogs: ScriptLogStore
  /** Outlives the sessions it reports; loaded and swept at start. */
  private readonly results: WorktreeResultsStore
  private readonly notifyStore: SessionNotifyStore
  /** What the landed rows wait for and how far their main copies are behind; memory only, fed by the poll. */
  private readonly landedRows: LandedRows
  private landedPass: Promise<void> | null = null
  /** An ending asked for another round while one was running. */
  private landedAgain = false
  /** Previous activity per session, read only to spot the settle that nudges a re-probe. */
  private readonly lastVcsActivity = new Map<string, SessionActivity | null>()
  private records: SessionRecordsStore | null = null
  /** Built with the records, which it writes. */
  private scripts: SessionScriptsManager | null = null
  private lifecycleLoad: Promise<SessionLifecycle> | null = null
  private numbersLoad: Promise<SessionNumberStore> | null = null
  /** False until a reconcile the Host answered has run; an unreachable Host never sets it. */
  private reconciled = false
  private mergeFlowValue: WorktreeMergeFlow | null = null
  private svnFinishFlowValue: SvnWorktreeFinishFlow | null = null
  /** Built with the records, which it writes; an SVN action and the cleanup share it. */
  private svnRemoval: SvnWorktreeRemoval | null = null
  /** One open per review run in flight, so a second call of the same run joins the first. */
  private readonly reviewOpening = new Map<string, Promise<SessionsOpResult<{ commitSessionId: string; scopeRoot: string }>>>()
  /** Bound late: the client builds its commit dialog after the sessions. */
  private reviewPort: SessionReviewPort | null = null
  /** Bound late like the review port; without one a Finish started from the window opens no editor. */
  private editor: SessionEditorPort | null = null
  private readonly finishers = new Map<SessionWorktreeKind, () => Promise<WorktreeFinisher>>([
    ['git', () => this.mergeFlow()],
    ['svn', () => this.svnFinishFlow()],
  ])
  /**
   * Sessions whose Finish or Discard this client has begun, from before its first await until it
   * answers: a reopen must not slip in before the first phase write lands on the record.
   */
  private readonly finishing = new Set<string>()
  /** Ended while `finishing` still held them; the Finish or Discard that holds them removes them as it lets go. */
  private readonly endedWhileFinishing = new Set<string>()
  /** The facts passes in flight; each runs svn or git with its working directory in a session's worktree. */
  private readonly probes = new Set<Promise<void>>()
  private runtimes = new Map<string, RuntimeSessionInfo>()
  private orphans: OrphanInfo[] = []
  private snapshotValue: SessionsSnapshot | null = null
  private serializedValue = ''
  private queue: Promise<unknown> = Promise.resolve()
  private pendingRefresh: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private worktreeFactsInFlight = false
  /** Every pass started without a caller, held until it settles so `stop` can wait for it. */
  private readonly detached = new Set<Promise<void>>()
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
      stopHost: (expectedHostInstanceId) => this.client.stopHost(expectedHostInstanceId),
      onError: deps.onError,
      spawnImpl: deps.spawnImpl,
    })
    this.treeVersion = new HostTreeVersion(deps.applicationRoot)
    this.versioningModeOf = deps.versioningModeOf ?? (() => 'checkpoints')
    this.worktrees = new GitWorktreeManager(new GitInvoker())
    this.svnWorktrees = new SvnWorktreeManager(new SvnInvoker(), deps.removeTree)
    this.landedRows = new LandedRows({ svn: this.svnWorktrees, now: () => Date.now() })
    this.tools = new RunTools({
      applicationRoot: deps.applicationRoot,
      resourcesRoot: deps.resourcesRoot,
      environment: process.env,
    })
    this.merge = new GitMergeManager(new GitInvoker())
    // Read-only by construction: with no snapshots directory every save is refused. The catalog has
    // one writer, the ProjectManager, and this is its second reader.
    this.catalog = CatalogView.load(deps.configDir, { report: deps.onError })
    this.ownerDeps = {
      groupRootOf: (dir) => ProductGroup.rootOf(dir),
      catalogProjectOf: (dir) => SessionManager.projectPathOf(this.catalog.read().bind(dir)),
      holdsCatalogProject: (dir) => this.holdsCategory(dir),
      workingCopyRootOf: (dir) => this.svnWorktrees.workingCopyRootOf(dir),
    }
    const gitWorktrees = new GitWorktreeProvisioner(this.worktrees)
    const svnWorktrees = new SvnWorktreeProvisioner(this.svnWorktrees, this.ownerDeps)
    const placers: Record<VersioningMode, Pick<SessionWorktreePort, 'place'>> = {
      checkpoints: new CheckpointsWorktreeProvisioner({ svn: this.svnWorktrees, git: this.worktrees, svnWorktrees, gitWorktrees }),
      git: gitWorktrees,
    }
    const kinds: Record<SessionWorktreeKind, Pick<SessionWorktreePort, 'create'>> = { git: gitWorktrees, svn: svnWorktrees }
    // The mode decides the place once per create; the kind it placed decides the create, so a mode
    // switched between the two cannot cut a worktree of the other kind.
    this.worktreePort = {
      place: (request) => {
        const mode = this.versioningModeOf()
        const placer = Object.hasOwn(placers, mode) ? placers[mode] : undefined
        if (placer === undefined) throw new Error(`Unknown versioning mode: ${JSON.stringify(mode)}`)
        return placer.place(request)
      },
      create: (request) => kinds[request.placement.kind].create(request),
      purgeReserved: (worktree) => svnWorktrees.purgeReserved(worktree),
    }
    // Built here the way the worktree manager is, and narrowed to `SessionSetupPort` where the
    // lifecycle takes it: this class owns the member, the lifecycle sees one method of it.
    this.projectSetup = new ProjectSetupManager({
      platformSettingsOf: deps.platformSettingsOf
        ?? (() => SetupFamilies.defaultPlatformSettings()),
    })
    // Machine state, not configuration: what a person answered here does not travel with a config
    // directory copied to another machine. The file keeps its name, so no agreement is lost.
    this.agreement = new CommandAgreement({
      trust: CommandTrustStore.load(OrchestratorPaths.setupTrustFile(deps.configIdentity, deps.channel), deps.onError),
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
      onUserInput: (sessionId) => this.records?.noteUserInput(sessionId, Date.now()),
      socketFactory: deps.terminalSocketFactory
        ?? ((socketDeps) => new TerminalAttachSocket(socketDeps)),
    })
    this.vcsFacts = deps.vcsStatusView === undefined
      ? null
      : new VcsFactsCache({
        view: deps.vcsStatusView,
        preferredVcsOf: deps.preferredVcsOf ?? (() => 'git'),
      })
    this.scriptLogs = new ScriptLogStore(OrchestratorPaths.scriptLogsDirectory(deps.configIdentity, deps.channel))
    this.results = new WorktreeResultsStore(OrchestratorPaths.worktreeResultsDirectory(deps.configIdentity, deps.channel), {
      now: () => Date.now(),
      logs: this.scriptLogs,
      report: deps.onError,
    })
    this.notifyStore = new SessionNotifyStore(OrchestratorPaths.sessionNotifiesDirectory(deps.configIdentity, deps.channel), {
      now: () => Date.now(), report: deps.onError,
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
      // Only folders: the runs an older build left are settled by the ordinary planning.
      await this.scripts?.sweep()
      await this.results.load()
      await this.notifyStore.load()
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
    await this.records?.flushUserInput()
    await this.client.stop()
    await this.settleWork()
    await this.records?.settled()
  }

  /**
   * Everything this manager started and nobody is waiting for: a git probe holding a session's
   * directory, a worktree diff, a merge the reconciler resumed, a record write on its way out.
   * "Stopped" has to mean that none of them is still running, or a caller that tears the workspace
   * down next is racing this client's own children.
   *
   * ROUNDS rather than one wait, because a pass can start a pass: a reconcile ends by handing its
   * listing to the work-state monitor, so the set is not empty when a wait over one copy of it
   * settles. The operation queue is drained with them - a create already on it spawns git of its
   * own - and its tail is re-read each round for the same reason.
   *
   * Bounded, and the bound is the point: git work here is allowed to run for minutes, so a queue
   * that will not drain must not hold a quit open for ever. Past the rounds this returns with work
   * still running and says so, which is the caller's cue that the directories are not theirs yet.
   */
  private async settleWork(): Promise<void> {
    for (let round = 0; round < SessionManager.settleRoundsConst; round += 1) {
      const queue = this.queue
      await Promise.all([queue.catch(() => undefined), ...this.detached])
      if (queue === this.queue && this.detached.size === 0) return
    }
    this.deps.onError(
      'The session manager stopped with work still running: a queued operation or a detached pass '
      + 'did not finish in time, so something of this client may still be reading its directories',
    )
  }

  snapshot(): SessionsSnapshot {
    return this.snapshotValue ?? this.recompose()
  }

  async localHistory(): Promise<SessionLocalHistoryEntry[]> {
    await this.lifecycle()
    const catalog = this.catalog.read()
    const entries: SessionLocalHistoryEntry[] = []
    for (const record of this.records?.list() ?? []) {
      switch (record.kind) {
        case 'shell': continue
        case 'agent': break
        default: throw new Error(`Unknown session kind: ${JSON.stringify(record.kind)}`)
      }
      if (!record.agent?.nativeSessionId) continue
      const project = catalog.bind(SessionWorkingDirectory.ofRecord(record), SessionManager.bindRootOf(record))
      switch (project.kind) {
        case 'adHoc':
        case 'none': continue
        case 'project': break
        default: throw new Error(`Unknown project binding: ${JSON.stringify(project)}`)
      }
      const category = catalog.categories.find((root) => root.id === project.categoryId)
      if (!category) continue
      switch (record.directory.mode) {
        case 'project':
          project.projectPath = record.directory.projectPath
          project.projectName = PathCompare.normalized(record.directory.projectPath).slice(PathCompare.normalized(category.path).length + 1)
          break
        case 'adHoc':
        case 'default': break
        default: throw new Error(`Unknown session directory: ${JSON.stringify(record.directory)}`)
      }
      entries.push({
        category: { id: category.id, label: category.label, path: category.path },
        project,
        agentId: record.agent.agentId,
        nativeSessionId: record.agent.nativeSessionId,
        title: record.title,
        model: record.agent.model ?? null,
        createdAt: record.createdAt,
        lastActivity: this.records?.lastUserInputAt(record.sessionId) ?? null,
        endedAt: record.endedAt ?? null,
        active: record.life === 'live' || record.life === 'starting',
      })
    }
    return entries
  }

  /** The saved log of a run in its parent's history, proved by the manager that wrote it; for FileViewer. */
  async scriptLogOf(parentId: string, runId: string): Promise<SessionsOpResult<{ path: string }>> {
    await this.lifecycle()
    if (this.scripts === null) return { ok: false, code: 'not-found', detail: `No session ${parentId}` }
    return this.scripts.scriptLogOf(parentId, runId)
  }

  /** A session's runs and, with `runId`, one run's saved log text; for the control API. */
  async scriptsOf(parentId: string, runId?: string): Promise<SessionsOpResult<SessionScriptsReading>> {
    await this.lifecycle()
    if (this.scripts === null) return { ok: false, code: 'not-found', detail: `No session ${parentId}` }
    return this.scripts.scriptsOf(parentId, runId)
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
            kind: record.worktree.kind ?? 'git',
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

  /**
   * A script that asked for a worktree learns from the answer where the session runs, so it never
   * has to find the folder by listing `.worktrees`.
   */
  async createSession(spec: SessionCreateSpec): Promise<SessionsOpResult<SessionCreated>> {
    const created = await this.tabTitled(this.operate((lifecycle) => lifecycle.create(spec)))
    if (!created.ok) return created
    if (spec.notify !== undefined) await this.notifyStore.watch(created.value.sessionId, spec.notify)
    const record = this.records?.get(created.value.sessionId) ?? null
    const number = record === null ? null : SessionTitle.partsOf(record.title).number
    return {
      ok: true,
      value: {
        ...created.value,
        ...number === null ? {} : { number },
        ...record?.worktree === undefined ? {} : { worktree: SessionManager.worktreePlaceOf(record.worktree) },
      },
    }
  }

  /** The durable results of SVN worktrees, also of sessions that were removed since. */
  async worktreeResults(filter: WorktreeResultsFilter): Promise<SessionsOpResult<{ results: WorktreeResultDto[] }>> {
    await this.results.load()
    const results: WorktreeResultDto[] = []
    const held = new Map<string, boolean | null>()
    for (const record of this.results.list(filter)) {
      const dto = WorktreeResultsStore.dtoOf(record)
      if (record.result === 'committed' && record.revisions.length > 0) {
        // Read when answered, once per main copy and newest revisions: the main copy moves on its own.
        const key = `${PathCompare.comparable(record.mainCopy)}\t${LandedRows.newestOf(record.revisions).map(SvnRevisionLabels.textOf).join(',')}`
        if (!held.has(key)) held.set(key, await this.landedRows.holds(record.mainCopy, record.revisions))
        dto.holdsLanded = held.get(key) ?? null
      }
      results.push(dto)
    }
    return { ok: true, value: { results } }
  }

  /** The caller read the result and acted on it; it goes a day later instead of after 30. */
  async acknowledgeWorktreeResult(actionId: string): Promise<SessionsOpResult<{ actionId: string }>> {
    await this.results.load()
    return this.results.acknowledge(actionId)
  }

  /** The store the client's notifier reads its wake-up lines from. */
  worktreeResultsStore(): WorktreeResultsStore {
    return this.results
  }

  sessionNotifyStore(): SessionNotifyStore {
    return this.notifyStore
  }

  async notifies(filter: { sessionId?: string }): Promise<SessionsOpResult<{ notifies: SessionNotifyDto[] }>> {
    await this.notifyStore.load()
    return { ok: true, value: { notifies: this.notifyStore.list(filter) } }
  }

  /** The worktree facts of one session, read from its record. */
  async worktreeOf(sessionId: string): Promise<SessionsOpResult<SessionWorktreeState>> {
    await this.lifecycle()
    const record = this.records?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    const retired = record.retiredWorktree
    const finish = SessionManager.legacyFinishOf(record)
    return {
      ok: true,
      value: {
        sessionId,
        worktree: record.worktree === undefined ? null : SessionManager.worktreePlaceOf(record.worktree),
        retired: retired === undefined
          ? null
          : { worktreePath: retired.worktreePath, revisions: retired.revisions, removedAt: retired.removedAt },
        finish: finish === undefined ? null : { phase: finish.phase, scopeRoot: finish.scopeRoot ?? null },
        action: record.svnAction === undefined ? null : SvnActionStages.infoOf(record.svnAction),
        outcome: record.worktreeOutcome ?? null,
        cleanup: record.worktreeCleanup === undefined
          ? null
          : { phase: record.worktreeCleanup.phase, reason: record.worktreeCleanup.reason ?? null },
        receipts: (record.commitReceipts ?? []).map(({ scopeRoot, revision, at }) => ({ scopeRoot, revision, at })),
      },
    }
  }

  /**
   * A Jamat review committed, or went to TortoiseSVN and closed: the session of the split and the
   * session whose SVN worktree holds a scope each keep a receipt, and that worktree is removed once its
   * process ended. Detached: the commit that reports it waits for nobody.
   */
  noteCommitted(receipt: SessionCommitReceipt): void {
    const scopes = receipt.scopes.map((scope) => scope.scopeRoot).join(', ')
    const noted = this.operate((lifecycle) => lifecycle.noteCommitted(receipt)).then((result) => {
      if (!result.ok)
        this.deps.onError(`The commit from ${scopes} could not be noted on its sessions: ${result.detail}`)
    })
    this.detach(noted, `Noting the commit from ${scopes}`)
  }

  /**
   * A worker's commit message, stored for its worktree root, or for the working copy of its directory
   * when it has no worktree. Nothing opens and nothing is committed: the review uses it later.
   */
  async proposeCommit(sessionId: string, message: string): Promise<SessionsOpResult<{ scopeRoot: string }>> {
    await this.lifecycle()
    const record = this.records?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    if (this.reviewPort === null)
      return { ok: false, code: 'review-unavailable', detail: 'This client has no commit dialog to keep a proposal for' }
    const directory = record.worktree?.worktreePath ?? SessionWorkingDirectory.ofRecord(record)
    return this.reviewPort.propose({ sessionId, directory, message })
  }

  /** SVN keeps its URL in `branch` and `r<rev>` in `baseCommit`, because older peers require both. */
  private static worktreePlaceOf(worktree: SessionRecordWorktree): SessionWorktreePlace {
    const kind = worktree.kind ?? 'git'
    if (kind === 'git') return { kind, worktreePath: worktree.worktreePath, url: null, baseRevision: null }
    else if (kind === 'svn') {
      const revision = /^r(\d+)$/.exec(worktree.baseCommit)?.[1]
      return {
        kind,
        worktreePath: worktree.worktreePath,
        url: worktree.branch,
        baseRevision: revision === undefined ? null : Number(revision),
      }
    }
    else throw new Error(`Unknown worktree kind: ${JSON.stringify(kind satisfies never)}`)
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
        SessionManager.bindRootOf(record),
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
   *
   * `expect: 'stop'` is for a script that means to stop a session and nothing more: a session that
   * ended meanwhile would otherwise start its Finish Commit on that press.
   *
   * A worktree whose project declares `scripts.after` runs them first: the press that starts them
   * answers at once, and the Finish continues by itself once they pass. `acknowledgeSetup` is the
   * hash a person agreed to when the press was refused `setup-not-acknowledged`.
   */
  async finalizeSession(
    sessionId: string,
    options?: { expect?: 'stop'; acknowledgeSetup?: string },
  ): Promise<SessionsOpResult> {
    await this.lifecycle()
    const record = this.records?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    const step = FinalizeSteps.planOf(record)
    if (options?.expect === 'stop' && step !== 'stop')
      return {
        ok: false,
        code: 'live-refused',
        detail: `Session ${sessionId}: the next Finish step is ${step}, not a stop; nothing was done`,
      }
    if (step === 'stop') {
      const stopped = await this.stopSession(sessionId)
      // The label on the next press is composed from these, and the agent's last writes landed
      // seconds ago; a reading up to thirty seconds old would promise the wrong thing at exactly the
      // moment somebody is about to press it again.
      if (stopped.ok) this.worktreeFacts.delete(sessionId)
      return stopped
    }
    else if (step === 'finish-worktree') return this.finishWorktree(record, options?.acknowledgeSetup)
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
   * A finisher that owns its checks takes the press at once (SVN: an action that answers once it is
   * written). Otherwise the after checks first, on the operation queue because they launch runs, and
   * the finisher once they passed.
   */
  private async finishWorktree(record: SessionRecord, acknowledgeSetup: string | undefined): Promise<SessionsOpResult> {
    const sessionId = record.sessionId
    const finisher = await this.finisherOf(record)
    if (finisher.ownsChecks) {
      const pressed = await finisher.finish(sessionId, {
        choice: 'commit',
        ...acknowledgeSetup === undefined ? {} : { acknowledgeSetup },
        requestedBy: 'cli',
      })
      this.changed()
      return pressed.ok ? { ok: true, value: undefined } : pressed
    }
    const gated = await this.operate(async (lifecycle) => ({
      ok: true as const,
      value: await lifecycle.finishChecks(sessionId, acknowledgeSetup, finisher.finishRefusal()),
    }))
    if (!gated.ok) return gated
    const checks = gated.value
    if (checks.kind === 'refused') return checks.result
    else if (checks.kind === 'started' || checks.kind === 'running') return { ok: true, value: undefined }
    else if (checks.kind === 'none' || checks.kind === 'passed')
      return this.whileFinishing(sessionId, async () => {
        const finished = await finisher.finish(sessionId, { choice: 'merge', requestedBy: 'cli' })
        return finished.ok ? { ok: true, value: undefined } : finished
      })
    else throw new Error(`Unknown Finish checks gate: ${JSON.stringify(checks satisfies never)}`)
  }

  /**
   * A chain that passed in this process presses Finish once more. Only while the next step is still
   * that Finish: a reopen or a removal that came first is the newer word.
   */
  private async continueFinish(sessionId: string): Promise<void> {
    await this.lifecycle()
    const record = this.records?.get(sessionId)
    if (!record || FinalizeSteps.planOf(record) !== 'finish-worktree') return
    const result = await this.finishWorktree(record, undefined)
    if (!result.ok)
      this.deps.onError(`Session ${sessionId}: its Finish checks passed and the Finish could not continue: ${result.detail}`)
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

  /**
   * A shell run the live session `parentId` asks for, drawn as its child and judged by its exit code.
   * On the operation queue because it writes a record and launches a runtime.
   */
  async runScript(parentId: string, request: SessionScriptRequest): Promise<SessionsOpResult<{ runId: string }>> {
    return this.operate((lifecycle) => lifecycle.runScript(parentId, request))
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

  /** The other ending: the worktree goes away and nothing is brought home. */
  async discardWorktree(sessionId: string): Promise<SessionsOpResult> {
    await this.lifecycle()
    const record = this.records?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    // The checks run in the worktree a Discard would take away under them.
    if (SessionScriptDefinitions.judging('finish', record))
      return {
        ok: false,
        code: 'merge-pending',
        detail: `Session ${sessionId}: its Finish checks are running; wait for them to end, or stop the check`,
      }
    return this.whileFinishing(sessionId, () => this.finisherOf(record).then((finisher) => finisher.discard(sessionId)))
  }

  /**
   * One press of the Finish dialog or of `sessions finish-worktree` on an SVN worktree: Commit, Keep
   * or Discard, answered once the action is written. A Git worktree takes Discard here and finishes
   * through `finalizeSession`, which runs its checks first.
   */
  async finishWorktreeSession(sessionId: string, press: SessionFinishPress): Promise<SessionsOpResult<{ sessionId: string; actionId: string | null }>> {
    await this.lifecycle()
    const record = this.records?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    const worktree = record.worktree
    if (worktree === undefined) return { ok: false, code: 'invalid-spec', detail: `Session ${sessionId} has no worktree` }
    const kind = worktree.kind ?? 'git'
    if (kind === 'git') {
      if (press.choice !== 'discard')
        return { ok: false, code: 'invalid-spec', detail: `${worktree.worktreePath} is a Git worktree; finish it with sessions finalize` }
      const discarded = await this.discardWorktree(sessionId)
      return discarded.ok ? { ok: true, value: { sessionId, actionId: null } } : discarded
    }
    else if (kind !== 'svn') throw new Error(`Unknown worktree kind: ${JSON.stringify(kind satisfies never)}`)
    const pressed = await (await this.finisherOf(record)).finish(sessionId, press)
    this.changed()
    return pressed.ok ? { ok: true, value: { sessionId, actionId: pressed.value.actionId } } : pressed
  }

  /**
   * UPDATE of a main copy, as an action of this session: a landed row updates the main copy its
   * worktree was cut from, any other session the main copy it works in. Live sessions in that main
   * copy (no worktree sessions, no runs, not this one) refuse it with `live-sessions` until
   * `confirmLive` names exactly them; a third one started meanwhile refuses it again.
   */
  async updateMain(sessionId: string, confirmLive: readonly string[] | undefined, requestedBy: SessionFinishPress['requestedBy'])
    : Promise<SessionsOpResult<{ sessionId: string; actionId: string }>> {
    await this.lifecycle()
    const record = this.records?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    const mainCopy = await this.mainCopyOf(record)
    if (!mainCopy.ok) return mainCopy
    const live = this.liveIn(mainCopy.value, sessionId)
    if (live.length > 0 && !SessionManager.sameIds(live.map((other) => other.sessionId), confirmLive ?? []))
      return {
        ok: false,
        code: 'live-sessions',
        detail: `${live.length} live session${live.length === 1 ? '' : 's'} work in ${mainCopy.value} `
          + `(${live.map((other) => other.title || other.sessionId).join(', ')}); confirm them to update it under them`,
        liveSessions: live,
      }
    const running = (this.records?.list() ?? []).find((other) => other.svnAction?.kind === 'update-main'
      && SvnActionFlow.running(other) && PathCompare.comparable(other.svnAction.root) === PathCompare.comparable(mainCopy.value))
    if (running !== undefined)
      return { ok: false, code: 'merge-pending', detail: `An UPDATE of ${mainCopy.value} runs for session ${running.sessionId}; wait for it to end` }
    const started = await this.operate((lifecycle) => lifecycle.svnActions.startUpdate(sessionId, mainCopy.value, requestedBy))
    return started.ok ? { ok: true, value: { sessionId, actionId: started.value.actionId } } : started
  }

  /**
   * The main copy an UPDATE of this session updates: the one a landed row's worktree was cut from;
   * for any other session the main copy of a landed row that holds its directory, else the owner a
   * worktree of its directory would check out (`WorktreeOwner`). A worktree session stands in none.
   */
  private async mainCopyOf(record: SessionRecord): Promise<SessionsOpResult<string>> {
    const landing = LandedRows.landingOf(record)
    if (landing !== null) return { ok: true, value: landing.mainCopy }
    if (record.worktree !== undefined || record.retiredWorktree !== undefined)
      return { ok: false, code: 'invalid-spec', detail: `Session ${record.sessionId} works in a worktree, not in a main copy` }
    if (record.directory.mode === 'default')
      return { ok: false, code: 'invalid-spec', detail: `Session ${record.sessionId} has no directory of its own` }
    const cwd = SessionWorkingDirectory.ofRecord(record)
    const landed = (this.records?.list() ?? []).flatMap((other) => {
      const owner = LandedRows.landingOf(other)?.mainCopy
      return owner !== undefined && PathCompare.isInside(owner, cwd) ? [owner] : []
    }).sort((a, b) => PathCompare.normalized(b).length - PathCompare.normalized(a).length)
    // A landed row's main copy is the owner its worktree was cut from, which the rule below may not
    // give again: pp 7.3 cut member worktrees inside a group.
    if (landed[0] !== undefined) {
      const versioned = await this.svnWorktrees.inWorkingCopy(landed[0])
      if (!versioned.ok) return { ok: false, code: 'svn-failed', detail: versioned.detail }
      if (!versioned.value) return { ok: false, code: 'invalid-spec', detail: `${landed[0]} is in no SVN working copy` }
      return { ok: true, value: landed[0] }
    }
    const owner = await WorktreeOwner.of(cwd, this.ownerDeps)
    return owner.ok ? { ok: true, value: owner.ownerDir } : owner
  }

  /**
   * Where a worktree session belongs in the catalog: its owner, or its place below the owner, never
   * the `.worktrees` folder its directory lies in.
   */
  private static bindRootOf(record: SessionRecord): string | undefined {
    const worktree = record.worktree
    if (worktree === undefined) return undefined
    return worktree.cwdSubpath === undefined ? worktree.repositoryRoot : join(worktree.repositoryRoot, ...worktree.cwdSubpath.split('/'))
  }

  /** The catalog project a binding names, or null for every binding that names none. */
  private static projectPathOf(binding: ProjectBinding): string | null {
    switch (binding.kind) {
      case 'project': return binding.projectPath
      case 'adHoc': case 'none': return null
      default: throw new Error(`Unknown project binding: ${JSON.stringify(binding satisfies never)}`)
    }
  }

  /** The live sessions an update of the main copy would change files under: no worktree sessions, no runs, not `exceptId`. */
  private liveIn(mainCopy: string, exceptId: string): SessionLiveBrief[] {
    return (this.records?.list() ?? [])
      .filter((other) => other.sessionId !== exceptId && (other.life === 'live' || other.life === 'starting')
        && other.scriptOf === undefined && other.worktree === undefined
        && PathCompare.isInside(mainCopy, SessionWorkingDirectory.ofRecord(other)))
      .map((other) => ({ sessionId: other.sessionId, title: other.title, number: SessionTitle.partsOf(other.title).number }))
  }

  private static sameIds(left: readonly string[], right: readonly string[]): boolean {
    const wanted = new Set(right)
    return left.length === wanted.size && left.every((id) => wanted.has(id))
  }

  /** An ending moved a main copy: its landed rows are judged and its distance read again at once. */
  private landedDue(mainCopy: string): void {
    this.landedRows.markStale(mainCopy)
    this.detach(this.refreshLanded(), `Reading the landed rows of ${mainCopy}`)
  }

  /** One pass at a time; a request while one runs asks it for another round. */
  private refreshLanded(): Promise<void> {
    if (this.landedPass !== null) {
      this.landedAgain = true
      return this.landedPass
    }
    this.landedPass = this.landedRounds().finally(() => { this.landedPass = null })
    return this.landedPass
  }

  private async landedRounds(): Promise<void> {
    do {
      this.landedAgain = false
      await this.landedOnce()
    } while (this.landedAgain)
  }

  /**
   * A landed row whose main copy holds what it waits for goes the way a Remove takes it, whoever
   * updated the main copy. Local reads at most every 10 s per main copy; the server distance every
   * 10 minutes, and at once after an ending moved the main copy.
   */
  private async landedOnce(): Promise<void> {
    const byMainCopy = new Map<string, { mainCopy: string; rows: { record: SessionRecord; landed: readonly SvnLabelledRevision[] }[] }>()
    for (const record of this.records?.list() ?? []) {
      const landing = LandedRows.landingOf(record)
      if (landing === null) continue
      const key = PathCompare.comparable(landing.mainCopy)
      const group = byMainCopy.get(key) ?? { mainCopy: landing.mainCopy, rows: [] }
      group.rows.push({ record, landed: landing.landed })
      byMainCopy.set(key, group)
    }
    this.landedRows.retain([...byMainCopy.values()].map((group) => group.mainCopy))
    let moved = false
    for (const { mainCopy, rows } of byMainCopy.values()) {
      if (this.landedRows.claimHolds(mainCopy))
        for (const row of rows) {
          // An UPDATE of this row judges the main copy itself once it ends.
          if (SvnActionFlow.running(row.record)) continue
          if (await this.landedRows.holds(mainCopy, row.landed) === true) await this.removeEnded(row.record.sessionId)
        }
      if (this.landedRows.behindDue(mainCopy)) moved = await this.landedRows.refreshBehind(mainCopy) || moved
    }
    if (moved) this.changed()
  }

  /**
   * What a review run of an SVN action asks for once: the commit split on its own tab, for the root
   * its action reviews now. A second call of the same run opens nothing and answers the same review,
   * or that the review is gone with the client that opened it.
   */
  async openActionReview(runId: string): Promise<SessionsOpResult<{ commitSessionId: string; scopeRoot: string }>> {
    await this.lifecycle()
    const opening = this.reviewOpening.get(runId)
    if (opening !== undefined) return opening
    const work = this.openReviewOnce(runId).finally(() => { this.reviewOpening.delete(runId) })
    this.reviewOpening.set(runId, work)
    return work
  }

  private async openReviewOnce(runId: string): Promise<SessionsOpResult<{ commitSessionId: string; scopeRoot: string }>> {
    const run = this.records?.get(runId)
    const parent = run?.scriptOf === undefined ? undefined : this.records?.get(run.scriptOf.sessionId) ?? undefined
    const action = parent?.svnAction
    const root = action?.roots?.[action.rootCursor]
    if (!parent || action?.stage !== 'reviewing' || action.runId !== runId || root === undefined)
      return { ok: false, code: 'not-found', detail: `Run ${runId} reviews nothing now` }
    if (action.reviewCommitId !== undefined)
      return this.reviewPort?.known(action.reviewCommitId) === true
        ? { ok: true, value: { commitSessionId: action.reviewCommitId, scopeRoot: root.path } }
        : { ok: false, code: 'review-unavailable', detail: 'The review of this run was lost with the client that opened it' }
    const review = this.reviewPort
    if (review === null)
      return { ok: false, code: 'review-unavailable', detail: 'This client has no commit dialog to review in' }
    // A mount reviews alone, and the worker proposed for the worktree root.
    const proposal = review.proposalOf(parent.sessionId, root.path)
      ?? review.proposalOf(parent.sessionId, action.root)
      ?? (SessionTitle.partsOf(parent.title).name.trim() || parent.title)
    const opened = await review.open({ sessionId: runId, scopeRoot: root.path, proposal })
    if (!opened.ok) return opened
    const commitSessionId = opened.value.commitSessionId
    await this.records?.update(parent.sessionId, (latest) => latest.svnAction?.runId === runId
      ? { ...latest, svnAction: { ...latest.svnAction, reviewCommitId: commitSessionId } }
      : null)
    this.changed()
    if (action.requestedBy === 'window' && action.rootCursor === 0 && parent.worktree !== undefined)
      this.editor?.openWorktree(action.root, basename(parent.worktree.repositoryRoot))
    return { ok: true, value: { commitSessionId, scopeRoot: root.path } }
  }

  /** A caller's request to remove an SVN worktree once its session ended, judged at the next pass. */
  async requestWorktreeCleanup(sessionId: string): Promise<SessionsOpResult> {
    return this.operate((lifecycle) => lifecycle.requestWorktreeCleanup(sessionId))
  }

  /** Where Commit opens its reviews. Without one, an SVN Commit is refused by name. */
  setReviewPort(port: SessionReviewPort): void {
    this.reviewPort = port
  }

  /** Where a Finish started from the window shows the worktree, once, when its first review opens. */
  setEditor(port: SessionEditorPort): void {
    this.editor = port
  }

  private finisherOf(record: SessionRecord): Promise<WorktreeFinisher> {
    const kind = record.worktree?.kind ?? 'git'
    const make = this.finishers.get(kind)
    if (make === undefined) throw new Error(`No finisher for worktree kind ${JSON.stringify(kind)}`)
    return make()
  }

  /**
   * Marks the session before the first await; an earlier mark belongs to the finish that set it. The
   * Remove of a session that ended meanwhile waits for the mark to go, because the Remove refuses a
   * session that is still finishing, and the answer waits for the Remove, so a caller that asks about
   * the session next finds it gone.
   */
  private async whileFinishing(sessionId: string, work: () => Promise<SessionsOpResult>): Promise<SessionsOpResult> {
    const marked = !this.finishing.has(sessionId)
    this.finishing.add(sessionId)
    try {
      return await this.afterMerge(work)
    } finally {
      if (marked) {
        this.finishing.delete(sessionId)
        if (this.endedWhileFinishing.delete(sessionId)) await this.removeEnded(sessionId)
      }
    }
  }

  /**
   * Held in `finishing` like a Finish: the reconciler writes no second attempt, and no reopen slips in
   * while it judges. A removal it completes removes the session as it lets go.
   */
  private async cleanWorktree(sessionId: string): Promise<void> {
    await this.whileFinishing(sessionId, async () => {
      await (await this.svnFinishFlow()).cleanUp(sessionId)
      return { ok: true, value: undefined }
    })
  }

  /** A finisher's ending did all it promised, so the session goes the way a Remove takes it. */
  private worktreeEnded(sessionId: string): void {
    // A session whose last attempt never started keeps its row, its reason and its runs' history after
    // the cleanup took its worktree; Retry setup then answers worktree-removed and Remove takes the row away.
    const record = this.records?.get(sessionId)
    if (record?.life === 'ended' && record.endedReason !== undefined) return this.changed()
    if (this.finishing.has(sessionId)) this.endedWhileFinishing.add(sessionId)
    else this.detach(this.removeEnded(sessionId), `Removing session ${sessionId} after its worktree ended`)
  }

  /** A refused Remove keeps the session with its outcome on the row; the report says why it stayed. */
  private async removeEnded(sessionId: string): Promise<void> {
    const refusal = await this.removeSession(sessionId).then(
      (removed) => removed.ok ? null : removed.detail,
      (error: unknown) => ErrorText.of(error),
    )
    if (refusal === null) this.deps.onRemovedItself?.(sessionId)
    else
      this.deps.onError(`Session ${sessionId}: its worktree ended as asked, and the session stays because it could not be removed: ${refusal}`)
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
      measure: this.worktrees,
      storeCut: new StoreCutWorktrees(new GitInvoker(), this.deps.removeTree),
      report: this.deps.onError,
      ended: (sessionId) => this.worktreeEnded(sessionId),
      launchResolve: async (spec, marks) => {
        const lifecycle = await this.lifecycle()
        return this.operate(() => lifecycle.createInternal(spec, marks))
      },
    })
    return this.mergeFlowValue
  }

  private async svnFinishFlow(): Promise<SvnWorktreeFinishFlow> {
    const lifecycle = await this.lifecycle()
    const records = this.records
    const removal = this.svnRemoval
    if (!records || !removal) throw new Error('The records store was not loaded before a finish')
    this.svnFinishFlowValue ??= new SvnWorktreeFinishFlow({
      records,
      svn: this.svnWorktrees,
      removal,
      landedDue: (mainCopy) => this.landedDue(mainCopy),
      actions: {
        start: (sessionId, press) => this.operate((current) => current.svnActions.start(sessionId, press)),
        // Off the queue: the removal it drives takes its own turn of it.
        settled: (sessionId) => lifecycle.svnActions.settled(sessionId),
      },
      labels: new SvnRevisionLabels(this.svnWorktrees),
      results: this.results,
      finishRefusal: () => this.svnFinishRefusal(),
      changed: () => this.changed(),
      ended: (sessionId) => this.worktreeEnded(sessionId),
      report: this.deps.onError,
    })
    return this.svnFinishFlowValue
  }

  /** Commit opens its reviews in the commit dialog, hosted by the Jamat CLI; Keep and Discard need neither. */
  private svnFinishRefusal(): SessionsOpResult<never> | null {
    if (this.reviewPort === null)
      return {
        ok: false,
        code: 'review-unavailable',
        detail: 'Commit needs the AppJamatV3 commit dialog, and this client has none; Keep and Discard still work',
      }
    const cli = this.tools.resolve('jamat-cli')
    if (!cli.ok)
      return {
        ok: false,
        code: 'review-unavailable',
        detail: `Commit reviews through the Jamat CLI, which this client cannot start (${cli.detail}); Keep and Discard still work`,
      }
    return null
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

  /** The manual start attempt. Client shutdown never calls a Host lifecycle operation. */
  async startHost(): Promise<SessionsOpResult> {
    const started = await this.controller.start()
    this.changed()
    if (started.ok) return { ok: true, value: undefined }
    return { ok: false, code: SessionManager.startCodeOf(started.code), detail: started.detail }
  }

  /**
   * The manual stop. Live sessions end with the Host and are not reopened by a later start; the
   * reconcile in `operate` finds them gone once a Host answers again.
   */
  stopHost(expectedHostInstanceId: string): Promise<SessionsOpResult> {
    return this.operate(async () => {
      const listed = await this.client.runtimeList()
      if (!listed.ok) return listed
      if (listed.value.hostInstanceId !== expectedHostInstanceId)
        return { ok: false, code: 'host-unreachable', detail: 'The Host changed before the stop. Try again.' }
      return this.controller.stop(expectedHostInstanceId)
    })
  }

  restartHost(expectedHostInstanceId: string): Promise<SessionsOpResult> {
    return this.operate(async (lifecycle) => {
      const listed = await this.client.runtimeList()
      if (!listed.ok) return listed
      if (listed.value.hostInstanceId !== expectedHostInstanceId)
        return { ok: false, code: 'host-unreachable', detail: 'The Host changed before the restart. Try again.' }
      const prepared = await lifecycle.prepareHostRestart(listed.value)
      if (!prepared.ok) return prepared
      const restarted = await this.controller.restart(expectedHostInstanceId)
      if (!restarted.ok) return restarted
      // The event socket can be ready before controller authority on the replacement Host.
      const clock = this.deps.exitClock ?? SessionManager.realExitClockConst
      const until = clock.now() + SessionManager.exitBudgetMillisecondsConst
      while (this.client.controllerLeaseId() === null && clock.now() < until)
        await clock.wait(SessionManager.exitPollMillisecondsConst)
      await this.reconcileNow(lifecycle, 'operation')
      const failures: string[] = []
      for (const sessionId of prepared.value) {
        try {
          const reopened = await lifecycle.reopen(sessionId)
          if (!reopened.ok && reopened.code !== 'live-refused')
            failures.push(`${sessionId}: ${reopened.detail}`)
        } catch (error) {
          failures.push(`${sessionId}: ${ErrorText.of(error)}`)
        }
      }
      return failures.length === 0
        ? { ok: true, value: undefined }
        : { ok: false, code: 'op-rejected', detail: `The Host restarted, but some sessions could not be restored: ${failures.join('; ')}` }
    })
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
   * What one agent session's input box holds right now, with the work hint beside it, read from the
   * same `runtime.inspect` projection the work-state monitor classifies. One Host call, no attach.
   * Not on the operation queue, for the reason `terminalAttach` is not: it reads nothing the queue
   * protects, and a delivery polling it must not wait behind a worktree install.
   */
  async terminalComposer(sessionId: string): Promise<TerminalComposerResult> {
    const resolution = this.terminalRefOf(sessionId)
    if (!resolution.ok) return { ok: false, code: resolution.code }
    const agentId = this.agentOf(sessionId)
    if (agentId === null) return { ok: false, code: 'not-agent' }
    const inspected = await this.client.runtimeInspect(resolution.ref, ScreenTail.viewConst)
    if (!inspected.ok || inspected.value.projection === null) return { ok: false, code: 'no-projection' }
    const frame = ScreenTail.frameOf(inspected.value.projection)
    return {
      ok: true,
      reading: {
        agentId,
        alive: inspected.value.session.alive,
        hint: WorkStateMonitor.inspect(agentId, frame).hint,
        ...AgentComposerReader.read(agentId, frame),
      },
    }
  }

  /**
   * The whole draft for an erase, read like `terminalComposer`: one Host call, no attach, not on the
   * operation queue. The view has no scrollback, so the viewport's top edge is row 0, and the hint
   * comes from the same snapshot as the rows.
   */
  async terminalComposerContent(sessionId: string): Promise<TerminalComposerContentResult> {
    const resolution = this.terminalRefOf(sessionId)
    if (!resolution.ok) return { ok: false, code: resolution.code }
    const agentId = this.agentOf(sessionId)
    if (agentId === null) return { ok: false, code: 'not-agent' }
    const inspected = await this.client.runtimeInspect(resolution.ref, ScreenTail.viewportViewConst)
    if (!inspected.ok || inspected.value.projection === null) return { ok: false, code: 'no-projection' }
    const viewport = ScreenTail.viewportOf(inspected.value.projection)
    if (viewport === null) return { ok: false, code: 'no-viewport' }
    return {
      ok: true,
      reading: {
        agentId,
        alive: inspected.value.session.alive,
        hint: WorkStateMonitor.inspect(agentId, ScreenTail.frameOf(inspected.value.projection)).hint,
        content: AgentComposerReader.content(agentId, viewport),
      },
    }
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
    const logs = this.scriptLogs
    const scripts = new SessionScriptsManager({
      records,
      host: this.client,
      logs,
      onCollapsed: (event) => this.deps.onScriptCollapsed?.(event),
      report: this.deps.onError,
      now: () => Date.now(),
    })
    this.scripts = scripts
    const removal = new SvnWorktreeRemoval({
      records,
      svn: this.svnWorktrees,
      // The passes that run svn inside a worktree are this client's only holders below one; the
      // inventory found no watcher or open handle elsewhere in the client.
      releaseBelow: () => this.settleProbes(),
      onQueue: (work) => this.serialize(work),
      changed: () => this.changed(),
    })
    this.svnRemoval = removal
    const lifecycle = new SessionLifecycle({
      controller: { configIdentity: this.deps.configIdentity, channel: this.deps.channel },
      records,
      host: this.client,
      worktrees: this.worktreePort,
      setup: this.projectSetup,
      agreement: this.agreement,
      // Deferred rather than the store itself: the numbers file is read on first use, and only a
      // create, a promotion, a history resume or a fork ever asks it anything.
      numbers: {
        allocate: async (projectPath, list) => (await this.numbers()).allocate(projectPath, list),
        highestIssued: async (projectPath, list) =>
          (await this.numbers()).highestIssued(projectPath, list),
      },
      codexSessions: new CodexSessionFiles({
        directory: join(OrchestratorPaths.directory(this.deps.configIdentity, this.deps.channel), 'codex-sessions'),
        applicationRoot: this.deps.applicationRoot,
        resourcesRoot: this.deps.resourcesRoot,
        report: this.deps.onError,
      }),
      tools: this.tools,
      claudeTitles: ClaudeTitleWriter.load({
        claudeHome: this.deps.claudeHome,
        report: this.deps.onError,
      }),
      scripts,
      svnActions: {
        svn: this.svnWorktrees,
        labels: new SvnRevisionLabels(this.svnWorktrees),
        removal,
        resolver: {
          unavailable: () => SvnResolverLauncher.claudeProblem(process.platform, process.env),
          briefs: logs,
          withMarkers: (root, paths) => SvnResolverLauncher.markersIn(root, paths),
        },
        results: this.results,
        finishRefusal: () => this.svnFinishRefusal(),
        activityOf: (sessionId) => {
          const record = records.get(sessionId)
          return record === null ? null : this.activityOf(record)
        },
        ended: (sessionId) => this.worktreeEnded(sessionId),
        landedDue: (mainCopy) => this.landedDue(mainCopy),
        proposalsSpent: (sessionId, scopeRoots) => {
          for (const scopeRoot of scopeRoots) this.reviewPort?.forgetProposal(sessionId, scopeRoot)
        },
        detach: (work, what) => this.detach(work, what),
        changed: () => this.changed(),
      },
      report: this.deps.onError,
      yoloFor: this.deps.yoloFor,
      modelFor: this.deps.modelFor,
      effortFor: this.deps.effortFor,
      finishing: (sessionId) => this.finishing.has(sessionId),
    })
    // Fired rather than awaited: the reconcile loop that produces it holds the one queue every
    // operation shares, and a merge does git work. The merge's own idempotence is what makes that
    // safe - it reads the disk, so a second run does whatever is still missing and nothing twice.
    // Through `detach` rather than a bare `void`: it is the longest-running git pass there is, and
    // `stop` has to be able to wait for it like every other pass nobody awaits.
    lifecycle.setResumeMerge((sessionId) => {
      this.detach(this.mergeSession(sessionId), `Continuing the merge of ${sessionId}`)
    })
    lifecycle.setCleanWorktree((sessionId) => {
      this.detach(this.cleanWorktree(sessionId), `Removing the worktree of ${sessionId}`)
    })
    // Fired rather than awaited for the reason a resumed merge is, and the Finish queues its own turn.
    lifecycle.setContinueFinish((sessionId) => {
      this.detach(this.continueFinish(sessionId), `Finishing session ${sessionId} after its checks passed`)
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
      await this.records?.flushUserInput()
      this.detach(this.probe(this.refreshWorktreeFacts()), 'The worktree facts')
      this.detach(this.probe(this.refreshVcsFacts()), 'The VCS facts')
      this.detach(this.refreshLanded(), 'The landed rows')
      await this.refresh('poll')
    } finally {
      this.armPoll()
    }
  }

  /**
   * The end of every promise nobody is waiting for. `start()` is the one path with a caller to
   * report to; a timer, an event and a detached pass have none, and an unhandled rejection out of
   * one of them takes down the client's main process. A store write throws on EPERM, ENOSPC or a
   * locked file, so this is not a hypothetical.
   *
   * Detached is not unowned. Each pass is held until it settles so that `stop` can wait for it: the
   * VCS and worktree passes SPAWN git in a session's directory, and a stop that left one running
   * left a child of this process reading a tree its caller believes nothing is touching any more.
   */
  private detach(work: Promise<unknown>, what: string): void {
    const tracked: Promise<void> = work
      .then(() => undefined)
      .catch((error: unknown) => this.deps.onError(`${what} failed: ${ErrorText.of(error)}`))
      .finally(() => { this.detached.delete(tracked) })
    this.detached.add(tracked)
  }

  private probe(work: Promise<void>): Promise<void> {
    this.probes.add(work)
    void work.catch(() => undefined).finally(() => { this.probes.delete(work) })
    return work
  }

  private async settleProbes(): Promise<void> {
    await Promise.all([...this.probes].map((work) => work.catch(() => undefined)))
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
        // An action is working in it and may be about to remove it; the last reading stands meanwhile.
        if (SvnActionFlow.running(record)) continue
        const captured = this.worktreeFacts.get(record.sessionId)
        if (captured && now - captured.capturedAt < SessionManager.worktreeFactsMillisecondsConst)
          continue
        // A repository that moved, went away or was never one leaves the diff UNKNOWN rather than
        // reported: a session whose worktree cannot be measured still runs perfectly well, and a
        // line on the client's error channel every 30 s would say nothing new.
        this.worktreeFacts.set(record.sessionId, await this.measureWorktree(record, worktree))
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

  /** Each kind measures its own: an SVN worktree against its BASE, never a Git repository above it. */
  private async measureWorktree(record: SessionRecord, worktree: SessionRecordWorktree): Promise<WorktreeFactsView> {
    const capturedAt = Date.now()
    const facts = await (await this.finisherOf(record)).facts(worktree)
    return { capturedAt, ...facts }
  }

  /** A category root at or below `dir`: such a directory holds catalog projects and is none itself. */
  private holdsCategory(dir: string): boolean {
    return this.catalog.read().categories.some((category) => PathCompare.isInside(dir, category.path))
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
      if (SessionManager.measuredLife(record.life) || (record.worktree && !SvnActionFlow.running(record))) cwds.add(cwd)
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
      SessionManager.bindRootOf(record),
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
    if (this.monitor.compacting(record.sessionId)) info.compacting = true
    if (record.agent)
      info.agent = {
        agentId: record.agent.agentId,
        nativeSessionId: record.agent.nativeSessionId,
      }
    if (record.worktree) info.worktree = this.worktreeInfoOf(record, record.worktree)
    if (record.svnAction) info.svnAction = SvnActionStages.infoOf(record.svnAction)
    if (record.retiredWorktree) {
      info.retiredWorktree = {
        worktreePath: record.retiredWorktree.worktreePath,
        revisions: record.retiredWorktree.revisions,
      }
      const landing = LandedRows.landingOf(record)
      if (landing !== null) info.retiredWorktree.landing = this.landedRows.infoOf(landing.mainCopy, landing.landed)
    }
    const vcs = this.vcsFacts?.factOf(SessionManager.vcsKeyOf(record))
    if (vcs) info.vcs = vcs
    const setup = this.setupInfoOf(record)
    if (setup) info.setup = setup
    if (record.scriptOf !== undefined) SessionManager.legacyLinkInto(info, record.scriptOf)
    const scripts = this.scripts?.infoOf(record)
    if (scripts?.script !== undefined) info.script = scripts.script
    if (scripts?.scripts !== undefined) info.scripts = scripts.scripts
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
    // A running action owns the record and the worktree under it; starting another session beside
    // it touches neither.
    if (SvnActionFlow.running(record)) {
      if (record.kind === 'agent') admits.push('newBeside')
      return admits
    }
    // A tombstone names a directory that is gone, and the project directory is not a substitute.
    const retired = record.retiredWorktree !== undefined
    if (record.kind === 'agent') {
      // Still a question this library answers, and no longer a method of it: "can another session be
      // started in this one's place" is what a menu asks before it offers the row, and the row now
      // opens the create card rather than calling a create of its own.
      admits.push('newBeside')
      // No id, nothing to fork from. A Claude session is told its id at launch, a Codex one earns
      // this the moment its id is found, and a fork of either now has one of its own. Not a run:
      // a resolver's worktree goes when the merge it is settling is done.
      if (record.agent?.nativeSessionId !== undefined && record.scriptOf === undefined && !retired)
        admits.push('fork')
      if (record.life === 'live') admits.push('compact')
    }
    // Another flow is holding this record, and restarting under it would race whoever owns it:
    // `starting` belongs to the reconciler, the others to setup and to the merge.
    const held = record.life === 'starting'
      || record.pendingSetup !== undefined
      || record.worktreeMerge !== undefined
      || record.scriptOf !== undefined
      || SessionScriptDefinitions.judging('finish', record)
    // The same gate the reopen itself applies, asked before the item is drawn rather than after it
    // is clicked. A shell has no conversation to name, so nothing can be wrong with resuming it.
    const reopenable = record.kind === 'shell'
      || (record.agent !== undefined && AgentPresets.reopenProblem(record.agent) === null)
    // `restartSession` stops a live runtime before it reopens it, so live and ended records share
    // this capability. A lost screen is different: the terminal panel branches on `life` first and
    // reconnects its attach without invoking the restart operation.
    if (!held && reopenable && !retired) admits.push('restart')

    // The row's four, each mirroring the refusal the operation itself would give. They are read
    // off the record like the rest; the one that needs a SECOND record says so where it does.
    if (FinalizeSteps.offers(record)) admits.push('finalize')
    // A landed row's main copy lacks what its worktree committed until somebody updates it.
    if (LandedRows.landingOf(record) !== null) admits.push('updateMain')
    // What `remove` refuses: a live session, and a `starting` one the Host has a runtime for.
    // A `starting` record with no binding names nothing on the Host and is removable.
    // A run row needs its parent too: `dismiss` refuses a run its gate still waits on.
    if (record.life !== 'live' && !(record.life === 'starting' && record.binding !== null)
      && !this.awaitedRun(record))
      admits.push('remove')
    if (this.discardable(record)) admits.push('discardWorktree')
    // The one way out of a failed install: the wait is still on the record and the session it
    // was preparing has ended, which is what `setupInfoOf` reads as `failed`. A retired worktree
    // leaves nothing to install into, so the retry would only refuse.
    if (record.pendingSetup !== undefined && (record.life === 'ended' || record.life === 'lost')
      && record.worktree !== undefined)
      admits.push('retrySetup')
    return admits
  }

  /**
   * Whether a discard would be taken rather than refused, which is the one row action that needs
   * more than this record: a run of this session - the resolver, or an install - may be standing in
   * that same directory, and the parent's own life says nothing about it. A conflicted merge is
   * `ended` by then and the agent resolving it is very much not.
   */
  private awaitedRun(record: SessionRecord): boolean {
    if (record.scriptOf === undefined) return false
    const parent = this.records?.get(record.scriptOf.sessionId) ?? null
    return parent !== null && SessionScriptDefinitions.awaitsVerdictOf(record.sessionId, record.scriptOf, parent)
  }

  private discardable(record: SessionRecord): boolean {
    if (record.worktree === undefined) return false
    if (record.life === 'live' || record.life === 'starting') return false
    if (SessionScriptDefinitions.judging('finish', record)) return false
    return !(this.records?.list() ?? []).some((run) => run.scriptOf?.sessionId === record.sessionId
      && (run.life === 'live' || run.life === 'starting'))
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
    record: SessionRecord,
    worktree: SessionRecordWorktree,
  ): SessionWorktreeInfo {
    const facts = this.worktreeFacts.get(record.sessionId)
    const info: SessionWorktreeInfo = {
      worktreePath: worktree.worktreePath,
      ...worktree.cwdSubpath === undefined ? {} : { cwdSubpath: worktree.cwdSubpath },
      branch: worktree.branch,
      baseCommit: worktree.baseCommit,
      kind: worktree.kind ?? 'git',
      choices: this.choicesOf({ record, worktree, diff: facts?.diff ?? null }),
      diff: facts?.diff ?? null,
      baseMoved: facts?.baseMoved ?? false,
    }
    const finish = SessionManager.legacyFinishOf(record)
    if (finish !== undefined) info.finish = finish
    if (record.worktreeOutcome) info.outcome = record.worktreeOutcome
    // The dialog opens on a running SVN session, and the action stops it first.
    if (info.kind === 'svn' && record.life === 'live') info.liveFinish = true
    if (record.worktreeCleanup)
      info.cleanup = {
        phase: record.worktreeCleanup.phase,
        ...record.worktreeCleanup.reason === undefined ? {} : { reason: record.worktreeCleanup.reason },
        summary: this.svnFinishFlowValue?.cleaningNow(record.sessionId) === true
          ? WorktreeCleanupPacing.runningSummaryConst
          : WorktreeCleanupPacing.summaryOf(record.worktreeCleanup, WorktreeCleanupPacing.endUnconfirmed(record)),
      }
    return info
  }

  /**
   * A running SVN action in the four legacy finish words, which a peer before 3.11 accepts; the full
   * stage travels in `SessionInfo.svnAction`.
   */
  private static legacyFinishOf(record: SessionRecord): SessionWorktreeInfo['finish'] {
    const action = record.svnAction
    if (action === undefined || action.needs !== undefined) return undefined
    const scopeRoot = SvnActionStages.scopeRootOf(action)
    return { phase: SvnActionStages.legacyPhaseOf(action.stage), ...scopeRoot === undefined ? {} : { scopeRoot } }
  }

  /**
   * Read on the snapshot path, which must not wait. Until the first facts pass has built a finisher,
   * Git offers its usual three and SVN its own.
   */
  private choicesOf(input: WorktreeChoicesInput): readonly SessionFinishChoice[] {
    const kind = input.worktree.kind ?? 'git'
    if (kind === 'git') return this.mergeFlowValue?.choicesOf(input) ?? ['merge', 'keep', 'discard']
    else if (kind === 'svn')
      return this.svnFinishFlowValue?.choicesOf(input) ?? SvnWorktreeFinishFlow.choicesFor(input.record, input.diff, false)
    else throw new Error(`Unknown worktree kind: ${JSON.stringify(kind satisfies never)}`)
  }

  /**
   * The wire keeps naming the two runs it always named, with their old meaning: an older peer nests
   * every run but the resolver by `setupFor`, so a new kind of run joins the `setupFor` branch.
   */
  private static legacyLinkInto(info: SessionInfo, link: SessionRecordScriptLink): void {
    if (link.scriptId === 'setup' || link.scriptId === 'declared' || link.scriptId === 'requested'
      || link.scriptId === 'svn' || link.scriptId === 'checks' || link.scriptId === 'svn-resolve' || link.scriptId === 'review')
      info.setupFor = link.sessionId
    else if (link.scriptId === 'merge-resolve') info.resolveFor = link.sessionId
    else throw new Error(`Unknown script ${JSON.stringify(link.scriptId satisfies never)}`)
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
