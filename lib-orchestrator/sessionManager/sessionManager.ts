import { accountWindows } from '../agentAccounts/defaultAccount'
import type { RateAccountState } from '../rateMonitor/rateMonitorApi.types'
import { sessionUsageRecords } from './sessionUsageView'
import { SessionAccounts } from './sessionAccounts'
import { WorktreeOperations } from '../worktrees/worktreeOperations'
import { FinishProjection } from '../worktrees/worktreeFinish'
import { SyncStep } from '../worktrees/worktreeFinish'
import { WorkerHandoffs } from './notifies/workerHandoffs'
import { WorkerLiveness } from '../worktrees/worktreeFinish'
import { WorkerIdle, WorkerReady } from '../worktrees/worktreeFinish'
import type { MainCopyUpdated } from '../worktrees/worktreeFinish'
import { HostGate } from './hostGate'
import { WorktreeLease } from '../worktrees/worktreeLease'
import { WorktreeTransitions } from '../worktrees/worktreeTransitions'
import { WorktreeSvnCommands } from '../worktrees/worktreeSvnCommands'
import { randomUUID } from 'node:crypto'
import { WorktreeRecovery } from '../worktrees/worktreeRecovery'
import { SvnWorktreeSession } from '../worktrees/worktreeRemoval'
import { WorktreeLifecycle } from '../worktrees/worktreeLifecycle'
import { hostname } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'

import type {
  HostWireConst,
  RuntimeListResult,
  RuntimeSessionInfo,
} from '../../app-host/app/wire/hostWire.js'
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
import { CatalogView } from '../projectManager/catalogView'
import { ClaudeTitleWriter } from '../projectManager/claudeTitleWriter'
import { ClaudeStatusLine } from './launch/claudeStatusLine'
import { CodexSessionFiles } from './launch/codexSessionFiles'
import { RunTools } from './launch/runTools'
import type { ProjectBinding } from '../projectManager/projectManagerApi.types'
import type { ProviderTranscriptView } from '../projectManager/providerTranscriptView'
import type { PlatformSettingsValue } from '../projectSetup/projectSetup.types'
import { ProjectSetupManager } from '../projectSetup/projectSetupManager'
import { SetupFamilies } from '../projectSetup/setupFamilies'
import type { RuntimeChannel } from '../shared/configIdentity.types'
import { ClaudeConfigHome } from '../shared/claudeConfigHome'
import { ErrorText } from '../shared/errorText'
import { OrchestratorPaths } from '../shared/orchestratorPaths'
import { PathCompare } from '../shared/pathCompare'
import { ProductGroup } from '../shared/productGroup'
import type { TreeRemove } from '../shared/treeRemoval'
import { SvnInvoker } from '../svn/svnInvoker'
import { SvnWorktreeManager } from '../svn/svnWorktreeManager'
import { HostMemoryWatch } from './hostMemory/hostMemoryWatch'
import { AgentPresets } from './launch/agentPresets'
import { FinalizeSteps } from '../worktrees/worktreeFinish'
import { LandedRows } from '../worktrees/worktreeLanding'
import { LaunchBackoff } from './lifecycle/launchBackoff'
import type { ReconcileChange } from './lifecycle/reconciler'
import { SessionLifecycle } from './lifecycle/sessionLifecycle'
import type { SessionWorktreePort, WorktreeFinisherRegistration } from '../worktrees/worktreeLifecycle.types'
import { SessionSteps } from './lifecycle/sessionSteps'
import { SessionWorkflows } from './lifecycle/sessionWorkflows'
import { SvnActionStages } from '../worktrees/worktreeFinish'
import { SvnResolverLauncher } from '../worktrees/worktreeConflicts'
import { SvnRevisionLabels } from '../worktrees/worktreeFinish'
import { SvnWorktreeFinishFlow } from '../worktrees/worktreeFinish'
import { SvnWorktreeRemoval } from '../worktrees/worktreeRemoval'
import type {
  WorktreeChoicesInput,
} from '../worktrees/worktreeFinish'
import { WorktreeCleanupPacing } from '../worktrees/worktreeRemoval'
import { WorktreeMergeFlow } from '../worktrees/worktreeGit'
import { WorktreeOwner, type WorktreeOwnerDeps } from '../worktrees/worktreeProvision'
import {
  CheckpointsWorktreeProvisioner,
  GitWorktreeProvisioner,
  SvnWorktreeProvisioner,
} from '../worktrees/worktreeProvision'
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
import { WorktreeResultsStore } from '../worktrees/worktreeResults'
import { SessionNotifyStore } from './notifies/sessionNotifyStore'
import { SvnWaitNotices } from '../worktrees/worktreeResults'
import type { SessionChildInfo, SessionNotifyDto, SessionStepInfo } from './sessionManagerApi.types'
import { RunOutputLines } from './scripts/runOutputLines'
import { ScriptLogStore } from './scripts/scriptLogStore'
import { type ScriptCollapsed, SessionScriptsManager } from './scripts/sessionScriptsManager'
import { SessionScriptDefinitions } from './scripts/sessionScriptDefinitions'
import type {
  HostDebugRuntimeRow,
  HostDebugStatus,
  HostPingResult,
  HostStopWarnings,
  OrphanInfo,
  SessionActivity,
  SessionAgentId,
  SessionColorName,
  SessionCommitReceipt,
  SessionCreated,
  SessionCreateOrigin,
  SessionCreateSpec,
  SessionDetailsSaved,
  SessionDetailsUpdate,
  SessionFinishChoice,
  SessionFinishPress,
  SessionHistoryOpenSpec,
  SessionHistoryReference,
  SessionInfo,
  SessionLiveState,
  SessionLocalHistoryEntry,
  SessionOperation,
  SessionScriptOutput,
  SessionScriptRequest,
  SessionScriptsReading,
  SessionSetupInfo,
  SessionsOpErrorCode,
  SessionsOpResult,
  SessionsSnapshot,
  SessionWorktreeInfo,
  SessionWorktreeDirectory,
  SessionWorktreeKind,
  SessionWorktreePlace,
  SessionWorktreePreview,
  SessionWorkflowInfo,
  SessionWorktreeState,
  SessionConflictList,
  SessionConflictResolved,
  SvnConflictResolveRequest,
  SvnLabelledRevision,
  TerminalAttachResult,
  TerminalAttachSpec,
  TerminalComposerContentResult,
  TerminalComposerResult,
  WorktreeResultDto,
  WorktreeResultsFilter,
} from './sessionManagerApi.types'
import type { SessionReviewPort } from './sessionReviewPort.types'
import { SessionReference } from './sessionReference'
import { SessionWorkingDirectory } from './sessionWorkingDirectory'
import type { TerminalRefResolution, TerminalSocketFactory } from './terminals/terminalAttachment'
import {
  TerminalGateway,
  type TerminalAttachOwner,
  type TerminalInputResult,
  type TerminalResizeResult,
} from './terminals/terminalGateway'
import { AgentComposerReader } from './workState/agentComposerReader'
import { ScreenTail } from './workState/screenTail'
import { WorkStateMonitor } from './workState/workStateMonitor'

export { SessionNotifier, type NotifySource, type PendingNotify, type SessionNotifyPort } from './notifies/sessionNotifier'

export interface SessionManagerDeps {
  accounts?: import('./sessionAccounts').SessionAccountsPort
  rates?: () => readonly RateAccountState[]
  skillRoots?: () => readonly string[]
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
   * An UPDATE recorded on a landed row, which goes with its Session actions once the main copy holds
   * it; telling the person is the composer's. Optional for the same reason as the one above.
   */
  onMainCopyUpdated?: (update: MainCopyUpdated) => void
  /**
   * A script run went into its parent's history. Its tab is the composer's: `parent-tab` gives it to
   * the parent, `close` closes it. Optional for the same reason as the one above.
   */
  onScriptCollapsed?: (event: ScriptCollapsed) => void
  /**
   * The writer identity this client takes at the Host. Random per process by default, because two
   * clients sharing one id would take each other's lease; the smoke names it so that it can put a
   * runtime on the Host under the same authority the manager already holds.
   */
  controllerId?: string
  instanceId?: string
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
      /**
       * The record's `createdAt`. A Codex child thread is its own rollout, filed under the day it
       * started, so the session's start bounds the day directories a sub-agent listing reads.
       */
      startedAt: number
    }
  }
  | { ok: false; code: 'unknown-session'; detail: string }

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
  } = { major: 1, minor: 1 }

  private readonly client: HostClient
  private readonly controller: HostController
  private readonly treeVersion: HostTreeVersion
  private readonly versioningModeOf: () => VersioningMode
  private readonly worktrees: GitWorktreeManager
  readonly svnCommands: WorktreeSvnCommands
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
  /** The last output line of each running scripted run, composed into its `step`. */
  private readonly runLines: RunOutputLines
  /** What this client does for each session now; memory only, composed into `step`. */
  private readonly steps: SessionSteps
  private readonly terminals: TerminalGateway
  private readonly scriptLogs: ScriptLogStore
  /** Outlives the sessions it reports; loaded and swept at start. */
  private readonly results: WorktreeResultsStore
  private readonly notifyStore: SessionNotifyStore
  /** The caller's wake-up line of a waiting worktree Finish, a third notify source beside results and observations. */
  private readonly waitNotices: SvnWaitNotices
  private readonly handoffs: WorkerHandoffs
  /** What the landed rows wait for and how far their main copies are behind; memory only, fed by the poll. */
  private readonly landedRows: LandedRows
  /** The Host's memory reading for the status bar; memory only, fed by the poll. */
  private syncStep: SyncStep | null = null
  private ready: WorkerReady | null = null
  private workerLiveness: WorkerLiveness | null = null
  private worktreeRecovery: WorktreeRecovery | null = null
  private finishDriver: Pick<SessionLifecycle['svnActions'], 'workerIdle'> | null = null
  private readonly pendingDeliveries = new Map<string, number>()
  private readonly hostGate: HostGate
  private readonly hostMemory: HostMemoryWatch
  private landedPass: Promise<void> | null = null
  /** An ending asked for another round while one was running. */
  private landedAgain = false
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
  /** Bound late: the client builds its commit dialog after the sessions. */
  private reviewPort: SessionReviewPort | null = null
  private readonly worktreeLifecycle: WorktreeLifecycle

  /**
   * Sessions whose Finish or Discard this client has begun, from before its first await until it
   * answers: a reopen must not slip in before the first phase write lands on the record.
   */
  private readonly finishing = new Set<string>()
  /** Ended while `finishing` still held them; the Finish or Discard that holds them removes them as it lets go. */
  private readonly endedWhileFinishing = new Set<string>()
  /** The cleanups after a session's end running now, each until it let go of `finishing`. */
  private readonly cleanings = new Map<string, Promise<void>>()
  private runtimes = new Map<string, RuntimeSessionInfo>()
  private orphans: OrphanInfo[] = []
  private snapshotValue: SessionsSnapshot | null = null
  private readonly switchingAccounts = new Set<string>()
  private serializedValue = ''
  private queue: Promise<unknown> = Promise.resolve()
  private pendingRefresh: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
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
      onEvent: (event) => {
        if (event.kind === 'host-stopping') this.detach(this.noteHostStopped(), 'Recording the Host stop')
        this.detach(this.refresh('event'), 'A Host event')
      },
      // Presence moves the snapshot's host block and nothing else: what the Host has is the
      // listing's business, and the poll is what asks for that.
      onPresence: () => this.changed(),
      onResync: () => this.detach(this.refresh('resync'), 'A Host resync'),
      onError: (detail) => { this.hostGate?.record(detail); deps.onError(detail) },
      controllerId: deps.controllerId,
      // A restarted client attaches before the dead client's lease lapses; its terminals take the
      // lease that comes later without waiting for a keystroke (UA1-J09-9).
      onLeaseGranted: () => this.terminals.leaseChanged(),
    })
    this.hostGate = new HostGate(() => this.client.descriptor(), () => this.client.presence() === 'running',
      join(OrchestratorPaths.directory(deps.configIdentity, deps.channel), 'host-gate.json'))
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
    this.svnCommands = new WorktreeSvnCommands(new SvnInvoker(), new WorktreeLease(deps.instanceId ?? randomUUID()), async (root, reason) => {
      const record = this.records?.list().find((item) => item.worktree !== undefined
        && PathCompare.comparable(item.worktree.worktreePath) === PathCompare.comparable(root))
      // The worker and its tools write svn while it works (for example, by setting svn:externals); only a
      // reviewed or publishing Finish guards the bytes and the svn state it was shown.
      if (record?.worktreeLifecycle === undefined || !WorktreeTransitions.guardsSvnState(record.worktreeLifecycle)) return 'accept'
      if (record !== undefined && this.records !== null)
        await this.records.update(record.sessionId, (latest) => latest.worktreeLifecycle === undefined ? null : {
          ...latest, worktreeLifecycle: { ...latest.worktreeLifecycle, version: latest.worktreeLifecycle.version + 1,
            phase: 'waiting', wait: { kind: 'changed-outside', reason, at: Date.now() } },
        })
      this.changed()
      return 'stop'
    })
    this.svnWorktrees = new SvnWorktreeManager(this.svnCommands, deps.removeTree)
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
      groupScopeOf: (dir) => ProductGroup.scopeOf(dir),
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
    this.runLines = new RunOutputLines({
      client: this.client,
      liveLineOf: (runtimeSessionId) => this.liveLineOf(runtimeSessionId),
      onChanged: () => this.changed(),
    })
    this.steps = new SessionSteps({ changed: () => this.changed(), now: () => Date.now() })
    this.hostMemory = new HostMemoryWatch({ read: () => this.client.health(), now: () => Date.now() })
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
    this.scriptLogs = new ScriptLogStore(OrchestratorPaths.scriptLogsDirectory(deps.configIdentity, deps.channel))
    this.results = new WorktreeResultsStore(OrchestratorPaths.worktreeResultsDirectory(deps.configIdentity, deps.channel), {
      now: () => Date.now(),
      logs: this.scriptLogs,
      report: deps.onError,
      quarantinedSessionIds: () => this.records?.quarantinedSessionIds() ?? new Set(),
      heldActionIds: () => new Set((this.records?.list() ?? []).flatMap((record) => [
        ...record.worktree?.preservationActionId === undefined ? [] : [record.worktree.preservationActionId],
        ...record.worktreeLifecycle?.publication?.savedActions ?? [],
        ...record.svnAction === undefined ? [] : [record.svnAction.actionId],
        ...record.worktreeLifecycle?.actionId == null ? [] : [record.worktreeLifecycle.actionId],
        ...record.worktree?.conflictMemory === undefined ? [] : [record.worktree.conflictMemory.actionId],
        ...record.worktreeLifecycle?.conflictMemory === undefined ? [] : [record.worktreeLifecycle.conflictMemory.actionId],
      ])),
    })
    this.worktreeLifecycle = new WorktreeLifecycle({
      withControl: (_record, work) => work(),
      dirty: async (record) => {
        if (record.worktree === undefined) return true
        if (!await this.svnWorktrees.present(record.worktree.worktreePath))
          return (record.worktree.conflictMemory?.paths.length ?? record.worktreeLifecycle?.conflictMemory?.paths.length ?? 0) > 0
        const changes = await this.svnWorktrees.changes(record.worktree.worktreePath)
        if (!changes.ok) throw new Error(changes.detail)
        return changes.value.length > 0 || (record.worktree.conflictMemory?.paths.length ?? record.worktreeLifecycle?.conflictMemory?.paths.length ?? 0) > 0
      },
      sync: async (id, trigger, confirmed) => this.records?.get(id)?.worktree?.kind === 'svn'
        ? this.syncStep?.run(id, trigger, confirmed) ?? { ok: false, code: 'svn-failed', detail: 'Sync is not initialized' } : null,
      records: () => this.records,
      finishers: new Map<SessionWorktreeKind, WorktreeFinisherRegistration>([
        ['git', { session: { setupPaths: async () => ({ ok: true, value: [] }), removeWithSession: (record) => this.operate((lifecycle) => lifecycle.remove(record.sessionId)) }, load: () => this.mergeFlow(), choices: () => this.mergeFlowValue?.choicesOf() ?? ['merge', 'keep', 'discard'] }],
        ['svn', { session: new SvnWorktreeSession({ records: () => this.records, commitHashes: (root, paths) => this.svnWorktrees.commitHashes(root, paths), requestCleanup: (id) => this.operate((lifecycle) => lifecycle.requestWorktreeCleanup(id)), clean: (id) => this.cleanWorktree(id), remove: (id) => this.operate((lifecycle) => lifecycle.remove(id)) }), load: () => this.svnFinishFlow(), choices: (input: WorktreeChoicesInput) => this.svnFinishFlowValue?.choicesOf(input) ?? SvnWorktreeFinishFlow.choicesFor(input.record, false) }],
      ]),
      actions: async () => (await this.lifecycle()).svnActions,
      provision: this.worktreePort,
      changed: () => this.changed(),
      create: (spec) => this.createSession(spec),
      stop: (id) => this.stopSession(id),
      awaitExit: (id) => this.awaitRuntimeExit(id),
      refresh: () => this.refresh('operation'),
      activityOf: (record) => this.activityOf(record),
      checks: (id, acknowledge, refusal) => this.operate(async (lifecycle) => ({ ok: true, value: await lifecycle.finishChecks(id, acknowledge, refusal) })),
      whileFinishing: (id, work) => this.whileFinishing(id, work),
      requestCleanup: (id) => this.operate((lifecycle) => lifecycle.requestWorktreeCleanup(id)),
      remove: (id) => this.operate((lifecycle) => lifecycle.remove(id)),
      mainCopyOf: (record) => this.mainCopyOf(record),
      onQueue: (work) => this.operate(work),
      stepOf: (record) => this.steps.infoOf(record),
      workflowOf: (record) => this.workflowOf(record),
      actionsOf: (record) => ({ sections: SessionWorkflows.sectionsOf(record, (runId) => this.records?.get(runId) ?? null, this.workflowLiveOf(record), this.scripts?.infoOf(record).scripts?.runs) }),
    })
    this.waitNotices = new SvnWaitNotices(() => this.records)
    this.handoffs = new WorkerHandoffs(() => this.records, (record, args) => {
      const tool = this.tools.resolve('jamat-cli')
      if (!tool.ok) throw new Error(tool.detail)
      return WorkerHandoffs.lineFor(tool, record, args)
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
        await lifecycle.nameConversationsOnStartup()
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
    this.runLines.stop()
    this.terminals.closeAll()
    await this.records?.flushUserInput()
    await this.client.stop()
    await this.settleWork()
    await this.records?.settled()
  }

  /**
   * Everything this manager started and nobody is waiting for: a landed rows pass reading a main
   * copy, a merge the reconciler resumed, a record write on its way out.
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

  usageRecords() { return sessionUsageRecords(this.records?.list() ?? []) }

  snapshot(): SessionsSnapshot {
    return this.snapshotValue ?? this.recompose()
  }

  accountForLaunch(sessionId: string, launchId: string, at: number): import('./sessionAccounts').SessionAccountRef | null {
    const record = this.records?.get(sessionId)
    if (!record || record.agent?.identityLaunchId !== launchId) return null
    if (SessionAccounts.launchRef(record)?.accountId !== SessionAccounts.ref(record)?.accountId) return null
    const segment = record.accountSegments?.at(-1)
    if (segment && (at < segment.from || segment.to !== null && at > segment.to)) return null
    return SessionAccounts.ref(record)
  }

  hasAccountSession(agentId: SessionAgentId, accountId: string): boolean {
    return (this.records?.list() ?? []).some(record => {
      if (![SessionAccounts.ref(record), SessionAccounts.launchRef(record)]
        .some(account => account?.agentId === agentId && account.accountId === accountId)) return false
      switch (record.life) {
        case 'starting':
        case 'live': return true
        case 'ended':
        case 'lost': return false
        default: throw new Error(`Unknown session life: ${record.life}`)
      }
    })
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

  async scriptOutputOf(parentId: string, runId: string): Promise<SessionsOpResult<SessionScriptOutput>> {
    await this.lifecycle()
    if (this.scripts === null) return { ok: false, code: 'not-found', detail: `No session ${parentId}` }
    return this.scripts.outputOf(parentId, runId)
  }

  /** A session's runs and, with `runId`, one run's saved log text; for the control API. */
  async scriptsOf(parentId: string, runId?: string): Promise<SessionsOpResult<SessionScriptsReading>> {
    await this.lifecycle()
    if (this.scripts === null) return { ok: false, code: 'not-found', detail: `No session ${parentId}` }
    return this.scripts.scriptsOf(parentId, runId)
  }

  async worktreeAt(path: string): Promise<{ sessionId: string; kind: 'svn' | 'git'; path: string } | null> {
    await this.lifecycle()
    const owner = this.records?.list().find((record) => record.worktree !== undefined && PathCompare.isInside(record.worktree.worktreePath, path))
    return owner?.worktree === undefined ? null : { sessionId: owner.sessionId, kind: owner.worktree.kind ?? 'git', path: owner.worktree.worktreePath }
  }

  async withinSvnWrite<T>(scope: string, paths: readonly string[], work: () => Promise<T>): Promise<T> {
    await this.lifecycle()
    const roots = await this.svnWriteRootsOf(scope, paths)
    return roots.reduceRight<() => Promise<T>>((inner, root) => () => this.svnCommands.lease.within(root, 'commit', inner), work)()
  }

  /**
   * The lease roots of an SVN write. A scope with no single owner, a working-copy root or a collection
   * that holds several projects, is the coordinated commit across them: it leases the owner of each
   * path, and the scope itself for a path that lies in no project. One sorted order, so two such
   * writes cannot each hold a lease the other waits for.
   */
  private async svnWriteRootsOf(scope: string, paths: readonly string[]): Promise<string[]> {
    const worktree = WorktreeLease.rootOf(scope)
    if (worktree !== null) return [worktree]
    const landing = (this.records?.list() ?? []).flatMap((record) => {
      const main = LandedRows.landingOf(record)?.mainCopy
      return main !== undefined && PathCompare.isInside(main, scope) ? [main] : []
    }).sort((a, b) => b.length - a.length)[0]
    if (landing !== undefined) return [landing]
    const owner = await WorktreeOwner.of(scope, this.ownerDeps)
    if (owner.ok) return [owner.ownerDir]
    if (paths.length === 0 || paths.some((path) => !PathCompare.isInside(scope, path))) throw new Error(owner.detail)
    const roots = new Map<string, string>()
    for (const path of paths) {
      // The parent, because a deleted or unversioned path is no directory svn or a lease can stand in.
      const dir = dirname(path)
      const group = this.ownerDeps.groupScopeOf(dir)
      const found = (group.ok ? group.ownerDir : null) ?? this.ownerDeps.catalogProjectOf(dir) ?? scope
      const root = PathCompare.isInside(scope, found) ? found : scope
      roots.set(PathCompare.comparable(root), root)
    }
    return [...roots.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, root]) => root)
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

  async setupPaths(sessionId: string, paths: readonly string[]): Promise<SessionsOpResult<string[]>> {
    await this.lifecycle()
    return this.worktreeLifecycle.setupPaths(sessionId, paths)
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
        startedAt: record.createdAt,
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
  async createSession(spec: SessionCreateSpec, origin?: SessionCreateOrigin): Promise<SessionsOpResult<SessionCreated>> {
    const created = await this.tabTitled(this.operate((lifecycle) =>
      lifecycle.create({ ...spec, directory: this.createDirectory(spec.directory) }, origin)))
    if (!created.ok) {
      // The reconciler may still start the left record; that session wakes its target like any other.
      if (created.recordedSessionId !== undefined && spec.notify !== undefined)
        await this.notifyStore.watch(created.recordedSessionId, spec.notify)
      return created
    }
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

  async createCommandSession(spec: Omit<SessionCreateSpec, 'kind' | 'agent'>, command: string,
    prepareAccount?: () => Promise<Record<string, string>>): Promise<SessionsOpResult<{ sessionId: string; tabTitle: string }>> {
    return this.tabTitled(this.operate(lifecycle => lifecycle.createCommandSession(spec, command, prepareAccount)))
  }

  terminalResult(sessionId: string): { ended: false } | { ended: true; exitCode: number | null } {
    const record = this.records?.get(sessionId)
    if (!record) return { ended: true, exitCode: null }
    switch (record.life) {
      case 'starting':
      case 'live': return { ended: false }
      case 'ended': return { ended: true, exitCode: record.exitReason === 'process-exit' ? record.exitCode ?? null : null }
      case 'lost': return { ended: true, exitCode: null }
      default: throw new Error(`Unknown session life: ${record.life}`)
    }
  }

  private createDirectory(directory: SessionCreateSpec['directory']): SessionCreateSpec['directory'] {
    switch (directory.mode) {
      case 'project': case 'default': return directory
      case 'adHoc': {
        const project = this.catalog.read().bind(directory.path)
        switch (project.kind) {
          case 'project':
            // Binding a subdirectory would change the requested working directory to the project root.
            return PathCompare.comparable(project.projectPath) === PathCompare.comparable(directory.path)
              ? { mode: 'project', categoryId: project.categoryId, projectPath: project.projectPath }
              : directory
          case 'adHoc': case 'none': return directory
          default: throw new Error(`Unknown project binding: ${JSON.stringify(project satisfies never)}`)
        }
      }
      default: throw new Error(`Unknown session directory: ${JSON.stringify(directory satisfies never)}`)
    }
  }

  /** The durable results of SVN worktrees, also of sessions that were removed since. */
  async worktreeResults(filter: WorktreeResultsFilter): Promise<SessionsOpResult<{ results: WorktreeResultDto[] }>> {
    await this.lifecycle()
    await this.results.load()
    await this.results.sweepDue()
    const results: WorktreeResultDto[] = []
    const held = new Map<string, boolean | null>()
    for (const record of this.results.list(filter)) {
      const dto = WorktreeResultsStore.dtoOf(record)
      if (filter.includeLandingProof !== false && (record.result === 'committed' || record.result === 'partial') && record.revisions.length > 0) {
        const key = LandedRows.proofKey(record.mainCopy, record.revisions)
        if (record.landedAt !== undefined) held.set(key, true)
        else if (!held.has(key)) held.set(key, await this.landedRows.holds(record.mainCopy, record.revisions))
        dto.holdsLanded = held.get(key) ?? null
        if (dto.holdsLanded === true && record.landedAt === undefined) await this.results.landed(record.actionId)
      }
      results.push(dto)
    }
    return { ok: true, value: { results } }
  }

  /** The caller read the result and acted on it; it goes a day later instead of after 30. */
  async acknowledgeWorktreeResult(actionId: string): Promise<SessionsOpResult<{ actionId: string }>> {
    await this.lifecycle()
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

  svnWaitNotices(): SvnWaitNotices {
    return this.waitNotices
  }

  workerHandoffs(): WorkerHandoffs { return this.handoffs }

  async notifies(filter: { sessionId?: string }): Promise<SessionsOpResult<{ notifies: SessionNotifyDto[] }>> {
    await this.notifyStore.load()
    return { ok: true, value: { notifies: this.notifyStore.list(filter) } }
  }

  /**
   * The sessions whose parent link names this one, composed from the snapshot as the list is. A
   * removed parent still has its children: the link stays on them.
   */
  async children(sessionId: string): Promise<SessionsOpResult<{ children: SessionChildInfo[] }>> {
    await this.lifecycle()
    const children = this.snapshot().sessions.flatMap((session): SessionChildInfo[] =>
      session.parent?.sessionId === sessionId
        ? [{
          sessionId: session.sessionId,
          number: session.titleParts.number,
          title: session.title,
          agentId: session.agent?.agentId ?? null,
          life: session.life,
          kind: session.parent.kind,
          sameProject: session.parent.sameProject,
        }]
        : [])
    return { ok: true, value: { children } }
  }

  /** The worktree facts of one session, read from its record. */
  async worktreeOf(sessionId: string): Promise<SessionsOpResult<SessionWorktreeState>> {
    await this.lifecycle()
    return this.worktreeLifecycle.infoOf(sessionId)
  }

  /**
   * The full conflict list of a session's SVN action, in the words of the snapshot. A run of an SVN
   * action (a review or a resolver run asking with `--self`) answers its parent's list, as
   * `openReviewOnce` maps a run to its parent's action.
   */
  async conflictsOf(sessionId: string): Promise<SessionsOpResult<SessionConflictList>> {
    await this.lifecycle()
    return this.worktreeLifecycle.conflictsOf(sessionId)
  }

  /** The directory the conflict paths of a session's SVN action are relative to: the main copy of its UPDATE, else its worktree. */
  async conflictRootOf(sessionId: string): Promise<SessionsOpResult<{ root: string; place: 'main copy' | 'worktree' }>> {
    await this.lifecycle()
    return this.worktreeLifecycle.conflictRootOf(sessionId)
  }

  /**
   * One option on one conflicted path of a session's waiting Finish or main-copy UPDATE. A run of the action (the merger
   * asking with `--self`) settles its parent's path as `agent`; any other caller as the person.
   */
  async resolveConflict(sessionId: string, request: SvnConflictResolveRequest): Promise<SessionsOpResult<SessionConflictResolved>> {
    await this.lifecycle()
    return this.worktreeLifecycle.resolveConflict(sessionId, request)
  }

  /**
   * Solve with agent: an interactive agent session in the worktree of a waiting SVN action, briefed
   * on why it waits. The action keeps waiting; the person presses on once the agent is done.
   */
  async solveWithAgent(sessionId: string): Promise<SessionsOpResult<SessionCreated>> {
    await this.lifecycle()
    return this.worktreeLifecycle.solveWithAgent(sessionId)
  }

  /** Ends a Finish that has published nothing yet; the worktree and its worker go on as they are. */
  async backToWork(sessionId: string, requestedBy: SessionFinishPress['requestedBy'], confirmStoppedRunId?: string): Promise<SessionsOpResult<{ sessionId: string; actionId: string | null }>> {
    await this.lifecycle()
    return this.worktreeLifecycle.backToWork(sessionId, requestedBy, confirmStoppedRunId)
  }

  /** Moves only with a pass, the stage or a run's state; never with a poll or a live line. */
  private workflowOf(record: SessionRecord): SessionWorkflowInfo | null {
    return SessionWorkflows.of(record, (runId) => this.records?.get(runId) ?? null, this.workflowLiveOf(record))
  }

  private workflowLiveOf(record: SessionRecord): SessionLiveState {
    const action = FinishProjection.action(record)
    if (action?.kind === 'update-main') return this.liveIn(action.root, record.sessionId)
    const owner = record.retiredWorktree?.ownerDir
    return action?.stage === 'main-update' && owner !== undefined ? this.liveIn(owner, record.sessionId) : { kind: 'known', sessions: [] }
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
  async proposeCommit(sessionId: string, message: string, scope?: string): Promise<SessionsOpResult<{ scopeRoot: string }>> {
    await this.lifecycle()
    const record = this.records?.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    if (this.reviewPort === null)
      return { ok: false, code: 'review-unavailable', detail: 'This client has no commit dialog to keep a proposal for' }
    const base = record.worktree?.worktreePath ?? SessionWorkingDirectory.ofRecord(record)
    const directory = scope === undefined ? base : resolve(base, scope)
    if (scope !== undefined && (!PathCompare.isInside(base, directory) || !PathCompare.isInside(await realpath(base), await realpath(directory))))
      return { ok: false, code: 'invalid-spec', detail: 'The proposal directory must belong to this session working copy or one of its external mounts' }
    return this.reviewPort.propose({ sessionId, directory, message })
  }

  /** SVN keeps its URL in `branch` and `r<rev>` in `baseCommit`, because older peers require both. */
  private static worktreePlaceOf(worktree: SessionRecordWorktree): SessionWorktreePlace {
    return WorktreeLifecycle.worktreePlaceOf(worktree)
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

  /** A person's resume, the window's Resume session and the worker-lost wait's Resume worker alike. */
  async reopenSession(sessionId: string): Promise<SessionsOpResult> {
    const result = await this.operate((lifecycle) => lifecycle.reopen(sessionId))
    // The session runs again whatever this write says; a refusal is reported, not answered.
    if (result.ok) await this.workerLiveness?.reopened(sessionId).catch((error: unknown) => this.deps.onError(`Session ${sessionId}: ${ErrorText.of(error)}`))
    return result
  }

  async stopSession(sessionId: string): Promise<SessionsOpResult> {
    return this.operate((lifecycle) => lifecycle.stop(sessionId))
  }

  /**
   * Being done with a session, as one action that always does the next step.
   *
   * For most sessions that is the stop, and the stop is the whole of it. A session with a worktree
   * has after-steps: the first press stops it, and the next opens review if changes remain. A clean
   * worktree can finish directly; a dirty one requires a person's selection in Session actions. Every
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
      return { ok: false, code: 'live-refused', detail: FinalizeSteps.notAStop(record, step) }
    if (step === 'stop') {
      return this.stopSession(sessionId)
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
  private async finishWorktree(record: SessionRecord, acknowledgeSetup: string | undefined,
    press: SessionFinishPress = { choice: 'merge', requestedBy: 'cli' }, continuation = false): Promise<SessionsOpResult> {
    return this.worktreeLifecycle.finish(record, acknowledgeSetup, press, continuation)
  }

  /**
   * A chain that passed in this process presses Finish once more. Only while the next step is still
   * that Finish: a reopen or a removal that came first is the newer word.
   */
  private async continueFinish(sessionId: string): Promise<void> {
    await this.lifecycle()
    const record = this.records?.get(sessionId)
    if (!record || FinalizeSteps.planOf(record) !== 'finish-worktree') return
    const approval = record.worktreeMerge?.approval
    const result = await this.finishWorktree(record, undefined,
      approval === undefined ? { choice: 'merge', requestedBy: 'cli' }
        : { choice: 'commit', requestedBy: 'window', ...approval }, true)
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
  ratesChanged(): void { if (this.records) this.changed() }

  async switchAccount(sessionId: string, accountId: string): Promise<SessionsOpResult> {
    if (this.switchingAccounts.has(sessionId)) return { ok: false, code: 'locked', detail: 'An account switch is already in progress' }
    this.switchingAccounts.add(sessionId)
    try {
      const changed = await this.serialize(async (): Promise<SessionsOpResult> => {
        await this.lifecycle()
        const record = this.records?.get(sessionId)
        if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
        if (!record.agent || !this.admitsOf(record).includes('restart'))
          return { ok: false, code: 'invalid-spec', detail: 'This session cannot resume its conversation' }
        if ((record.agent.accountId ?? 'main') === accountId)
          return { ok: false, code: 'invalid-spec', detail: 'already on this account' }
        if (!await this.deps.accounts?.usable?.(record.agent.agentId, accountId))
          return { ok: false, code: 'invalid-spec', detail: 'account not usable' }
        const at = Date.now()
        const written = await this.records!.update(sessionId, current => {
          if (!current.agent) return null
          const agent = { ...current.agent, accountId,
            launchAccountId: current.agent.launchAccountId ?? current.agent.accountId ?? 'main' }
          return { ...current, agent, accountSegments: [...SessionAccounts.close(current, at), { accountId, from: at, to: null }] }
        })
        if (!written) return { ok: false, code: 'records-latched', detail: 'The account change could not be saved' }
        this.changed()
        return { ok: true, value: undefined }
      })
      if (!changed.ok) return changed
      const result = await this.restartSession(sessionId)
      if (!result.ok) {
        await this.records!.update(sessionId, record => ({ ...record, endedReason: result.detail }))
        this.changed()
      }
      return result
    } finally { this.switchingAccounts.delete(sessionId) }
  }

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
      if (!listed.ok) return false
      const runtime = listed.value.sessions
        .find((session) => session.runtimeSessionId === sessionId)
      if (runtime === undefined || !runtime.alive) return true
      if (clock.now() >= until) return false
      await clock.wait(SessionManager.exitPollMillisecondsConst)
    }
  }

  /**
   * The Remove of an ended SVN worktree session takes its worktree too, through the cleanup's own
   * judgement: the record is the only thing that names the worktree, so a Remove that dropped it
   * left a checkout nobody saw or ended. Changes keep the session (`dirty`), and Finish decides
   * about them; a holder keeps it until the pending cleanup removes both (`locked`). A worktree svn
   * cannot judge falls back to the plain Remove, which names what it leaves, because a session that
   * nothing can take away is worse than a leftover named out loud.
   */
  async removeSession(sessionId: string): Promise<SessionsOpResult> {
    await this.lifecycle()
    return this.worktreeLifecycle.removeWithSession(sessionId)
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

  async clearActions(sessionId: string): Promise<SessionsOpResult> {
    return this.operate((lifecycle) => lifecycle.clearActions(sessionId))
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
    return this.worktreeLifecycle.discardAndWait(sessionId)
  }

  /**
   * A worktree press opens Changes or submits the person's selection. Git runs its checks through
   * this manager; SVN owns its asynchronous checks and command chain in the action.
   */
  async finishWorktreeSession(sessionId: string, press: SessionFinishPress): Promise<SessionsOpResult<{ sessionId: string; actionId: string | null }>> {
    await this.lifecycle()
    return this.worktreeLifecycle.press(sessionId, press)
  }

  /**
   * UPDATE of a main copy, as an action of this session: a landed row updates the main copy its
   * worktree was cut from, any other session the main copy it works in. The window first opens a
   * waiting step. Confirmation must name the live sessions exactly, checked inside the operation
   * queue so sessions created or ended after the displayed list refuse it with `live-sessions`.
   */
  async updateMain(sessionId: string, confirmLive: readonly string[] | undefined, requestedBy: SessionFinishPress['requestedBy'])
    : Promise<SessionsOpResult<{ sessionId: string; actionId: string }>> {
    await this.lifecycle()
    return this.worktreeLifecycle.updateMain(sessionId, confirmLive, requestedBy)
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

  /**
   * The live sessions an update of the main copy would change files under: no worktree sessions, no runs,
   * not `exceptId`. A record's life is the Host's word only while the Host answers its listing.
   */
  private liveIn(mainCopy: string, exceptId: string): SessionLiveState {
    if (!this.hostListed()) return { kind: 'unknown' }
    return { kind: 'known', sessions: (this.records?.list() ?? [])
      .filter((other) => other.sessionId !== exceptId && (other.life === 'live' || other.life === 'starting')
        && other.scriptOf === undefined && other.worktree === undefined
        && PathCompare.isInside(mainCopy, SessionWorkingDirectory.ofRecord(other)))
      .map((other) => ({ sessionId: other.sessionId, title: other.title, number: SessionTitle.partsOf(other.title).number })) }
  }

  /** The Host answers and its last listing came through, so the records' life is its word. */
  private hostListed(): boolean {
    const presence = this.controller.presence()
    switch (presence) {
      case 'running': return this.lastReconcile.lastListingOk === true
      case 'starting': case 'unreachable': return false
      default: throw new Error(`Unknown Host presence: ${JSON.stringify(presence satisfies never)}`)
    }
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
          if (row.record.svnAction !== undefined || row.record.worktree !== undefined || row.record.life === 'live' || row.record.life === 'starting') continue
          if (await this.landedRows.holds(mainCopy, row.landed) === true) await this.removeEnded(row.record.sessionId, true)
        }
      if (this.landedRows.behindDue(mainCopy)) moved = await this.landedRows.refreshBehind(mainCopy) || moved
    }
    if (moved) this.changed()
  }

  /** A caller's request to remove an SVN worktree once its session ended, judged at the next pass. */
  async requestWorktreeCleanup(sessionId: string): Promise<SessionsOpResult> {
    return this.worktreeLifecycle.requestCleanup(sessionId)
  }

  /** Where a worker stores commit message proposals. */
  setReviewPort(port: SessionReviewPort): void {
    this.reviewPort = port
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
   * while it judges. A removal it completes removes the session as it lets go. A second call while one
   * runs waits for that one to let go: the reconcile pass after a Remove's own request starts the
   * cleanup before the Remove applies it, and the Remove answers what that cleanup left (UA1-J11-8).
   */
  private cleanWorktree(sessionId: string): Promise<void> {
    const running = this.cleanings.get(sessionId)
    if (running !== undefined) return running
    const cleaning = this.whileFinishing(sessionId, async () => {
      await (await this.svnFinishFlow()).cleanUp(sessionId)
      return { ok: true, value: undefined }
    }).then(() => undefined).finally(() => this.cleanings.delete(sessionId))
    this.cleanings.set(sessionId, cleaning)
    return cleaning
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
  private async removeEnded(sessionId: string, idleOnly = false): Promise<void> {
    let skipped = false
    const removal = idleOnly ? this.operate(async (lifecycle) => {
      const record = this.records?.get(sessionId)
      if (record?.svnAction !== undefined || record?.worktree !== undefined || record?.life === 'live' || record?.life === 'starting') {
        skipped = true
        return { ok: true, value: undefined }
      }
      return lifecycle.remove(sessionId)
    }) : this.removeSession(sessionId)
    const refusal = await removal.then(
      (removed) => removed.ok ? null : removed.detail,
      (error: unknown) => ErrorText.of(error),
    )
    if (skipped) return
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
      storeCut: new StoreCutWorktrees(new GitInvoker(), this.deps.removeTree),
      report: this.deps.onError,
      ended: (sessionId) => this.worktreeEnded(sessionId),
      scripts: this.scripts ?? undefined,
      changed: () => this.changed(),
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
        start: (sessionId, press) => lifecycle.svnActions.start(sessionId, press),
        // Off the queue: the removal it drives takes its own turn of it.
        settled: (sessionId) => lifecycle.svnActions.settled(sessionId),
      },
      labels: new SvnRevisionLabels(this.svnWorktrees),
      results: this.results,
      changed: () => this.changed(),
      steps: this.steps,
      ended: (sessionId) => this.worktreeEnded(sessionId),
      report: this.deps.onError,
    })
    return this.svnFinishFlowValue
  }

  async adoptOrphan(runtimeSessionId: string): Promise<SessionsOpResult> {
    return this.operate((lifecycle) => lifecycle.adoptOrphan(runtimeSessionId))
  }

  /**
   * Where a worktree of `directory` would stand and the number its session would take, by the rules
   * a create applies, so the create card shows the real folder and owner. Takes nothing, and like the
   * number peek it stays off `operate`.
   */
  async worktreePreview(directory: SessionWorktreeDirectory): Promise<SessionsOpResult<SessionWorktreePreview>> {
    const placed = await (await this.lifecycle()).worktreePlacementOf(directory)
    if (!placed.ok) return placed
    const { countedProject, ...place } = placed.value
    const token = countedProject === null ? null : await (await this.numbers()).next(countedProject, this.records?.list() ?? [])
    return { ok: true, value: { ...place, token } }
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
   * The manual stop. Live sessions end with the Host; the reconcile in `operate` finds them gone once
   * a Host answers again. Only SVN worktree workers come back then, through their liveness.
   */
  private workingAgents(): string[] {
    return (this.records?.list() ?? []).filter((record) => record.kind === 'agent' && record.life === 'live')
      .map((record) => `${record.title} (${record.sessionId})`)
  }

  private async noteHostStopped(): Promise<void> {
    const agents = this.workingAgents()
    for (const record of this.records?.list() ?? []) {
      if (record.kind !== 'agent' || record.life !== 'live' || record.worktreeLifecycle === undefined) continue
      await this.workerLiveness?.died(record.sessionId, 'host-stopped')
    }
    if (agents.length > 0) this.deps.onError(`Host stopped; interrupted agents: ${agents.join(', ')}`)
    this.changed()
  }

  stopHost(expectedHostInstanceId: string): Promise<SessionsOpResult<HostStopWarnings>> {
    return this.operate(async () => {
      const listed = await this.client.runtimeList()
      if (!listed.ok) return listed
      if (listed.value.hostInstanceId !== expectedHostInstanceId)
        return { ok: false, code: 'host-unreachable', detail: 'The Host changed before the stop. Try again.' }
      return this.controller.stop(expectedHostInstanceId)
    })
  }

  /** `warnings` names what the old Host could not stop; those processes may still run. */
  restartHost(expectedHostInstanceId: string): Promise<SessionsOpResult<HostStopWarnings>> {
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
        // A worktree worker came back through its liveness inside that reconcile; asking again would be
        // refused by the Finish that holds its worktree and read as a failure (UA1-J10-6).
        const life = this.records?.get(sessionId)?.life
        if (life === 'live' || life === 'starting') continue
        try {
          const reopened = await lifecycle.reopen(sessionId, 'restore')
          if (!reopened.ok && reopened.code !== 'live-refused')
            failures.push(`${sessionId}: ${reopened.detail}`)
        } catch (error) {
          failures.push(`${sessionId}: ${ErrorText.of(error)}`)
        }
      }
      const { warnings } = restarted.value
      const survived = warnings.length === 0 ? '' : ` The Host could not stop everything: ${warnings.join('; ')}`
      return failures.length === 0
        ? { ok: true, value: { warnings } }
        : { ok: false, code: 'op-rejected', detail: `The Host restarted, but some sessions could not be restored: ${failures.join('; ')}${survived}` }
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
    if (listing !== null) await this.workerLiveness?.observe(this.records?.list() ?? [], (text) => this.deps.onError(text))
    if (listing !== null) {
      this.applyOrphans(listing, changes)
      // The monitor reads this same answer instead of asking the Host for a second copy of it, and
      // it reads it OFF the queue: rendering a screen per session is not something an operation may
      // wait behind. It reports its own verdicts through `onChanged`.
      this.detach(this.monitor.observe(listing).then(() => { this.resumeIdleWorkers(); return this.syncReadyWorkers() }), 'The work-state monitor')
      this.detach(this.runLines.observe(listing), 'The output lines of running scripts')
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
        removeSessionLogs: (sessionId, keepIds) => this.scriptLogs.removeParent(sessionId, keepIds),
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
      skillRoots: this.deps.skillRoots?.() ?? [],
      results: this.results,
      records,
      svn: this.svnWorktrees,
      onQueue: (work) => this.serialize(work),
      changed: () => this.changed(),
      steps: this.steps,
    })
    this.svnRemoval = removal
    const resolver = {
      unavailable: () => SvnResolverLauncher.claudeProblem(process.platform, process.env),
      briefs: logs,
      withMarkers: (root: string, paths: readonly string[]) => SvnResolverLauncher.markersIn(root, paths),
      cli: () => this.tools.agentCli(),
      instance: { configIdentity: this.deps.configIdentity, channel: this.deps.channel },
    }
    const operations = new WorktreeOperations({ records, scripts, svn: this.svnWorktrees, commands: this.svnCommands,
      results: this.results, handoffs: this.handoffs, resolver, now: () => Date.now(), newId: () => randomUUID(),
      busyReason: (id) => this.workerBusy(id), holdInput: (id) => this.terminals.holdInput(id), changed: () => this.changed() })
    this.ready = operations.ready
    this.syncStep = operations.sync
    const lifecycle = new SessionLifecycle({
      localStateDir: OrchestratorPaths.directory(this.deps.configIdentity, this.deps.channel),
      controller: { configIdentity: this.deps.configIdentity, channel: this.deps.channel },
      records,
      host: this.client,
      hostGate: this.hostGate,
      localBefore: operations.checkout,
      worktrees: this.worktreeLifecycle,
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
      claudeStatusLine: new ClaudeStatusLine({
        directory: OrchestratorPaths.claudeStatusLineDirectory(this.deps.configIdentity, this.deps.channel),
        snapshots: OrchestratorPaths.claudeContextSnapshotsDirectory(this.deps.configIdentity, this.deps.channel),
        identities: OrchestratorPaths.claudeIdentitiesDirectory(this.deps.configIdentity, this.deps.channel),
        claudeHome: ClaudeConfigHome.resolve(this.deps.claudeHome),
        tools: this.tools,
        report: this.deps.onError,
      }),
      tools: this.tools,
      claudeTitles: ClaudeTitleWriter.load({
        claudeHome: this.deps.claudeHome,
        report: this.deps.onError,
      }),
      scripts,
      finish: { commands: this.svnCommands, sync: this.syncStep, handoffs: this.handoffs,
        idle: (id) => this.workerIdle(id), busyReason: (id) => this.workerBusy(id), holdInput: (id) => this.terminals.holdInput(id),
        awaitExit: (id) => this.awaitRuntimeExit(id), liveness: (id, step) => this.workerLiveness?.run(id, step) ?? Promise.resolve() },
      activityOf: (sessionId) => { const record = records.get(sessionId); return record === null ? null : this.activityOf(record) },
      svnActions: {
        runner: operations.runner,
        logs,
        svn: this.svnWorktrees,
        labels: new SvnRevisionLabels(this.svnWorktrees),
        removal,
        resolver,
        resolutions: operations.resolutions,
        results: this.results,
        ended: (sessionId) => this.worktreeEnded(sessionId),
        landedDue: (mainCopy) => this.landedDue(mainCopy),
        mainCopyUpdated: (update) => this.deps.onMainCopyUpdated?.(update),
        proposalsSpent: (sessionId, scopeRoots) => {
          for (const scopeRoot of scopeRoots) this.reviewPort?.forgetProposal(sessionId, scopeRoot)
        },
        proposalOf: (sessionId, scopeRoot) => this.reviewPort?.proposalOf?.(sessionId, scopeRoot) ?? null,
        detach: (work, what) => this.detach(work, what),
        changed: () => this.changed(),
        steps: this.steps,
      },
      report: this.deps.onError,
      yoloFor: this.deps.yoloFor,
      accounts: this.deps.accounts,
      modelFor: this.deps.modelFor,
      effortFor: this.deps.effortFor,
      finishing: (sessionId) => this.finishing.has(sessionId),
    })
    this.finishDriver = lifecycle.svnActions
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
    this.worktreeRecovery = new WorktreeRecovery({ records,
      commit: (sessionId, entry) => lifecycle.svnActions.recoverCommit(sessionId, entry),
      step: (sessionId, entry) => lifecycle.svnActions.recoverStep(sessionId, entry),
      before: (sessionId) => lifecycle.recoverLocalBefore(sessionId),
      resume: (sessionId) => lifecycle.svnActions.due(sessionId),
      report: this.deps.onError, now: () => Date.now(),
    })
    await this.worktreeLifecycle.recover(this.worktreeRecovery)
    this.workerLiveness = new WorkerLiveness({ records, resume: (id) => lifecycle.resumeWorker(id), now: () => Date.now(),
      redeliver: (id) => this.handoffs.redeliver(id),
      notify: async (id, text) => {
        this.deps.onError(`${id}: ${text}`)
        await this.handoffs.notifyCaller(id, text)
        this.changed()
      },
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
   * client asks for - the work-state monitor is handed this same answer.
   */
  private async tick(): Promise<void> {
    this.lastTickAt = Date.now()
    try {
      await this.records?.flushUserInput()
      this.detach(this.refreshLanded(), 'The landed rows')
      this.detach(this.observeHostMemory(), 'The Host memory reading')
      await this.refresh('poll')
      if (this.worktreeRecovery !== null) this.detach(this.worktreeRecovery.retry(), 'The interrupted worktree recovery')
    } finally {
      this.armPoll()
    }
  }

  private async observeHostMemory(): Promise<void> {
    if (await this.hostMemory.observe(this.client.descriptor()?.hostInstanceId ?? null)) this.changed()
  }

  /**
   * The end of every promise nobody is waiting for. `start()` is the one path with a caller to
   * report to; a timer, an event and a detached pass have none, and an unhandled rejection out of
   * one of them takes down the client's main process. A store write throws on EPERM, ENOSPC or a
   * locked file, so this is not a hypothetical.
   *
   * Detached is not unowned. Each pass is held until it settles so that `stop` can wait for it: the
   * landed rows pass SPAWNS svn in a main copy, and a stop that left one running left a child of this
   * process reading a tree its caller believes nothing is touching any more.
   */
  private detach(work: Promise<unknown>, what: string): void {
    const tracked: Promise<void> = work
      .then(() => undefined)
      .catch((error: unknown) => this.deps.onError(`${what} failed: ${ErrorText.of(error)}`))
      .finally(() => { this.detached.delete(tracked) })
    this.detached.add(tracked)
  }

  /** A category root at or below `dir`: such a directory holds catalog projects and is none itself. */
  private holdsCategory(dir: string): boolean {
    return this.catalog.read().categories.some((category) => PathCompare.isInside(dir, category.path))
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
    const records = this.records?.list() ?? []
    // Composed once, because a child's `sameProject` reads its parent's binding beside its own. The
    // repository root wins over the cwd: a session inside `<project>/.worktrees/<slug>` belongs to the
    // project, not to a project called `.worktrees`.
    const bindings = new Map(records.map((record) => [record.sessionId,
      catalog.bind(SessionWorkingDirectory.ofRecord(record), SessionManager.bindRootOf(record))]))
    return {
      host: {
        presence: this.controller.presence(),
        hostVersion: this.controller.hostVersion(),
        hostInstanceId: this.controller.hostInstanceId(),
        liveCount: [...this.runtimes.values()].filter((runtime) => runtime.alive).length,
        workingAgents: this.workingAgents(),
        lastStartError: this.controller.lastStartError(),
        memory: this.hostMemory.reading(),
      },
      categories: catalog.categories.map((category) => ({
        id: category.id,
        label: category.label,
        path: category.path,
      })),
      sessions: records.map((record) => this.sessionInfoOf(record, bindings)),
      orphans: this.orphans,
      reconciled: this.reconciled,
    }
  }

  /** `bindings` holds every record's binding by session id, its own included. */
  private sessionInfoOf(record: SessionRecord, bindings: ReadonlyMap<string, ProjectBinding>): SessionInfo {
    const project = bindings.get(record.sessionId)
    if (project === undefined) throw new Error(`Session ${record.sessionId}: no project binding was composed`)
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
    if (record.binding !== null) info.runtime = `${record.binding.hostInstanceId}:${record.binding.generation}`
    const activityDetail = this.monitor.activityDetail(record.sessionId)
    if (activityDetail !== null) info.activityDetail = activityDetail
    if (this.monitor.compacting(record.sessionId)) info.compacting = true
    if (record.agent)
      info.agent = {
        agentId: record.agent.agentId,
        nativeSessionId: record.agent.nativeSessionId,
        accountId: record.agent.accountId ?? 'main',
        ...(accountWindows(this.deps.rates?.().find(rate => rate.key.agentId === record.agent!.agentId
          && rate.key.accountId === (record.agent!.accountId ?? 'main'))).some(window => window.model === undefined
          && (window.durationMinutes === 300 || window.durationMinutes === 10_080) && window.usedPercent >= 100)
          ? { accountExhausted: true } : {}),
        ...(record.agent.accountId && record.agent.accountId !== 'main'
          ? { accountLabel: this.deps.accounts?.labelOf?.(record.agent.agentId, record.agent.accountId) ?? record.agent.accountId } : {}),
      }
    if (record.account) info.account = { ...record.account }
    if (record.worktree) info.worktree = this.worktreeInfoOf(record, record.worktree)
    if (record.worktreeLifecycle) info.worktreeView = WorktreeLifecycle.viewOf(record)
    const action = FinishProjection.action(record)
    if (action) info.svnAction = SvnActionStages.infoOf(action)
    // A run has no client step and a parent no live line, so the two never compete.
    const step = this.steps.infoOf(record) ?? this.liveStepOf(record)
    if (step !== null) info.step = step
    const workflow = this.workflowOf(record)
    if (workflow !== null) info.workflow = workflow
    if (record.retiredWorktree) {
      info.retiredWorktree = {
        worktreePath: record.retiredWorktree.worktreePath,
        revisions: record.retiredWorktree.revisions,
      }
      const landing = LandedRows.landingOf(record)
      if (landing !== null) info.retiredWorktree.landing = this.landedRows.infoOf(landing.mainCopy, landing.landed)
    }
    const setup = this.setupInfoOf(record)
    if (setup) info.setup = setup
    if (record.scriptOf !== undefined) SessionManager.legacyLinkInto(info, record.scriptOf)
    const scripts = this.scripts?.infoOf(record)
    info.actions = { sections: LandedRows.offerOf(SessionWorkflows.sectionsOf(record, (runId) => this.records?.get(runId) ?? null, this.workflowLiveOf(record), scripts?.scripts?.runs),
      info.retiredWorktree?.landing, info.svnAction?.stage) }
    if (scripts?.script !== undefined) info.script = scripts.script
    if (scripts?.scripts !== undefined) info.scripts = scripts.scripts
    if (record.worktreeMerge !== undefined && record.worktreeMerge.endedAt === undefined && record.worktreeMerge.changes !== true)
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
    if (SessionOutcomes.awaitsSetupApproval(record)) info.awaitsSetupApproval = true
    // Filtered rather than copied: a name this build does not know is a record somebody can still
    // work in, so it loses its colour here and keeps everything else.
    if (SessionColors.isName(record.color)) info.color = record.color
    if (record.note !== undefined) info.note = record.note
    if (record.callerOperationId !== undefined) info.callerOperationId = record.callerOperationId
    if (record.parent !== undefined)
      info.parent = { ...record.parent, sameProject: SessionManager.sameProject(project, bindings.get(record.parent.sessionId)) }
    WorktreeLifecycle.decorate(info)
    return info
  }

  /**
   * The generic nesting rule: both in one catalog project, or both in one ad-hoc directory. A
   * worktree session binds to its owner (`bindRootOf`), so a worktree of the parent's project counts.
   */
  private static sameProject(child: ProjectBinding, parent: ProjectBinding | undefined): boolean {
    // A removed parent: the child is drawn as a root.
    if (parent === undefined) return false
    switch (child.kind) {
      case 'project': return parent.kind === 'project' && parent.categoryId === child.categoryId
        && PathCompare.comparable(parent.projectPath) === PathCompare.comparable(child.projectPath)
      case 'adHoc': return parent.kind === 'adHoc' && PathCompare.comparable(parent.path) === PathCompare.comparable(child.path)
      case 'none': return false
      default: throw new Error(`Unknown project binding: ${JSON.stringify(child satisfies never)}`)
    }
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
    if (SvnActionStages.running(record)) {
      if (record.kind === 'agent') admits.push('newBeside')
      // While an agent works for it, the Finish press and Discard stop that agent first.
      if (record.worktreeLifecycle?.step === 'worker-resolving' || record.svnAction !== undefined && SvnActionStages.agentRunOf(record.svnAction) !== null) admits.push('finalize', 'discardWorktree')
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
    const info: SessionWorktreeInfo = {
      worktreePath: worktree.worktreePath,
      ...worktree.cwdSubpath === undefined ? {} : { cwdSubpath: worktree.cwdSubpath },
      branch: worktree.branch,
      baseCommit: worktree.baseCommit,
      kind: worktree.kind ?? 'git',
      choices: this.choicesOf({ record, worktree }),
      diff: null,
      baseMoved: false,
    }
    const finish = SessionManager.legacyFinishOf(record)
    if (finish !== undefined) info.finish = finish
    if (record.worktreeOutcome) info.outcome = record.worktreeOutcome
    // The dialog opens on a running SVN session, and the action stops it first.
    if (record.life === 'live') info.liveFinish = true
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
    return WorktreeLifecycle.legacyFinishOf(record)
  }

  /**
   * Read on the snapshot path, which must not wait. Until the first facts pass has built a finisher,
   * Git offers its usual three and SVN its own.
   */
  private choicesOf(input: WorktreeChoicesInput): readonly SessionFinishChoice[] {
    return this.worktreeLifecycle.choicesOf(input)
  }

  /**
   * The wire keeps naming the two runs it always named, with their old meaning: an older peer nests
   * every run but the resolver by `setupFor`, so a new kind of run joins the `setupFor` branch.
   */
  private static legacyLinkInto(info: SessionInfo, link: SessionRecordScriptLink): void {
    if (link.scriptId === 'setup' || link.scriptId === 'declared' || link.scriptId === 'requested'
      || link.scriptId === 'svn' || link.scriptId === 'checks' || link.scriptId === 'svn-resolve' || link.scriptId === 'svn-merge'
      || link.scriptId === 'review')
      info.setupFor = link.sessionId
    else if (link.scriptId === 'merge-resolve') info.resolveFor = link.sessionId
    else throw new Error(`Unknown script ${JSON.stringify(link.scriptId satisfies never)}`)
  }


  /** Nothing classifies a plain terminal; an agent nothing has classified yet is `unknown`. */
  async proposeWorktreeReady(sessionId: string): Promise<void> {
    await this.lifecycle()
    await this.ready?.propose(sessionId)
    this.detach(this.syncReadyWorkers(), 'Syncing ready worktrees')
    this.changed()
  }

  async syncWorktreeSession(sessionId: string): Promise<SessionsOpResult<import('./sessionManagerApi.types').SessionWorktreeSyncResult>> {
    await this.lifecycle()
    return this.worktreeLifecycle.sync(sessionId, 'worker')
  }

  /** A Finish whose sync waits for a busy worker goes on once this look finds the worker idle (UA1-J14-4). */
  private resumeIdleWorkers(): void {
    const finish = this.finishDriver
    if (finish === null) return
    for (const record of this.records?.list() ?? [])
      if (record.worktreeLifecycle?.wait?.kind === 'worker-busy' && this.workerIdle(record.sessionId))
        this.detach(finish.workerIdle(record.sessionId), `Finishing session ${record.sessionId} after its worker became idle`)
  }

  private async syncReadyWorkers(): Promise<void> {
    if (this.syncStep === null) return
    for (const record of this.records?.list() ?? []) {
      if (record.worktreeLifecycle?.facts.worker.ready === undefined) continue
      try {
        if (!await this.ready?.current(record.sessionId)) continue
        if (this.workerIdle(record.sessionId)) await this.syncStep.run(record.sessionId, 'ready')
      } catch (error) {
        this.deps.onError(`Ready sync for ${record.sessionId}: ${ErrorText.of(error)}`)
      }
    }
  }

  deliveryPending(sessionId: string, pending: boolean): void {
    const count = this.pendingDeliveries.get(sessionId) ?? 0
    if (pending) this.pendingDeliveries.set(sessionId, count + 1)
    else if (count > 1) this.pendingDeliveries.set(sessionId, count - 1)
    else this.pendingDeliveries.delete(sessionId)
  }

  workerIdle(sessionId: string): boolean {
    return this.workerBusy(sessionId) === null
  }

  /** Why the worker does not count as idle, as a person reads it; null when it does. */
  workerBusy(sessionId: string): string | null {
    const record = this.records?.get(sessionId)
    if (!record || record.life !== 'live') return 'the worker is not running'
    // A line still due to the worker may start new work in it; the person sees which one it is.
    const message = [...this.notifyStore.pending(), ...this.handoffs.pending()].find((entry) => entry.sessionId === sessionId)
    if (message !== undefined) {
      const line = message.text.split('\n')[0]
      return `a message to the worker is not delivered yet: ${line.length > 160 ? `${line.slice(0, 159)}…` : line}`
    }
    const busy = WorkerIdle.busyOf(this.activityOf(record), this.monitor.polledAt(sessionId),
      this.terminals.pendingInput(sessionId) + (this.pendingDeliveries.get(sessionId) ?? 0))
    if (busy !== null) return busy
    const child = (this.records?.list() ?? []).find((child) => child.parent?.sessionId === sessionId && child.life === 'live'
      && (child.kind !== 'agent' || !WorkerIdle.of(this.activityOf(child), this.monitor.polledAt(child.sessionId), this.pendingDeliveries.get(child.sessionId) ?? 0)))
    return child === undefined ? null : `its child session ${child.title || child.sessionId} is still working`
  }

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

  /** A run record gone between the listing and this answer gets no line, and the next pass forgets it. */
  /** Only a run that still runs shows its last line; the record ends before the next listing says so. */
  private liveStepOf(record: SessionRecord): SessionStepInfo | null {
    switch (record.life) {
      case 'starting':
      case 'live': return this.runLines.stepOf(record.sessionId)
      case 'ended':
      case 'lost': return null
      default: throw new Error(`Unknown session life ${JSON.stringify(record.life satisfies never)}`)
    }
  }

  private liveLineOf(runtimeSessionId: string): boolean {
    const link = this.records?.get(runtimeSessionId)?.scriptOf
    return link !== undefined && SessionScriptDefinitions.known(link) && SessionScriptDefinitions.of(link).liveLine
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
