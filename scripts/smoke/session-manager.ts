/**
 * End-to-end proof that lib-orchestrator's SessionManager drives the whole chain against a real
 * AppHost: the record a client that died mid-create left behind, replayed under the id it was written
 * with and deduplicated by the Host; a session created, running and producing output; the Host
 * disappearing without a single record being relabelled; the Host coming back without the runtime;
 * the same session reopened under the same id; an ended session reopened through `runtime.replace`;
 * a runtime created straight over the wire showing up as an orphan and being adopted; and finally a
 * stop and a remove that leave no record behind.
 *
 * Then the setup path, against a real git repository this run creates: a worktree whose project
 * declares an install, the install running as a session of its own while `create` has already
 * answered, the session starting once that install exits 0 - and the other ending, where the install
 * exits non-zero and the session never runs while its worktree stays exactly where it is. Finally a
 * setup of TWO steps whose FIRST one fails, which is the only shape that proves a later step's own
 * operator cannot decide the fate of an earlier one.
 *
 * Unit tests drive the manager against a fake Host on loopback, so this is the only place the whole
 * composition meets a real PTY. No Electron: plain Node through tsx.
 *
 * Everything lives under one temporary root - the config directory, the machine state root of both
 * the Host and the orchestrator, the working directory the sessions run in and the git repository the
 * worktrees are cut from - so the machine's own %LOCALAPPDATA%\jamat-v3, ~/.jamat-v3 and every real
 * checkout are never read and never written.
 */
import { SmokeHarness, SmokeRun } from './smokeHarness.js'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  ControllerLeaseResult,
  HostDescriptor,
  RuntimeListResult,
  RuntimeResult,
  RuntimeSessionInfo,
} from '../../app-host/app/wire/hostWire.js'
import { CheckpointLayout } from '../../lib-orchestrator/git/checkpointLayout.js'
import type { VersioningMode } from '../../lib-orchestrator/git/git.types.js'
import { GitInvoker } from '../../lib-orchestrator/git/gitInvoker.js'
import { HostDescriptorPaths } from '../../lib-orchestrator/hostClient/hostDescriptorPaths.js'
import { LaunchPlanner } from '../../lib-orchestrator/sessionManager/launch/launchPlanner.js'
import type { SessionRecord } from '../../lib-orchestrator/sessionManager/records/sessionRecord.types.js'
import { SessionRecordsStore } from '../../lib-orchestrator/sessionManager/records/sessionRecordsStore.js'
import { ChildEnvironment } from '../../lib-orchestrator/shared/childEnvironment.js'
import { SessionManager } from '../../lib-orchestrator/sessionManager/sessionManager.js'
import type {
  HostDebugRuntimeRow,
  SessionCreateSpec,
  SessionInfo,
  SessionsOpErrorCode,
  SessionsOpResult,
} from '../../lib-orchestrator/sessionManager/sessionManagerApi.types.js'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore.js'
import { OrchestratorPaths } from '../../lib-orchestrator/shared/orchestratorPaths.js'

class SmokeSessionManager extends SmokeHarness {
  protected override get waitMilliseconds(): number {
    return SmokeSessionManager.settleMillisecondsConst
  }

  private static readonly channelConst = 'development'
  private static readonly orphanRuntimeIdConst = 'smoke-orphan-1'
  /** The session a client died in the middle of creating, and the operation it never heard back on. */
  private static readonly crashedSessionIdConst = 'smoke-crashed-create-1'
  private static readonly crashedOperationIdConst = 'smoke-crashed-operation-1'
  /**
   * The manager takes its writer authority under this name, and the smoke acquires the SAME name to
   * put a runtime on the Host that no record knows about. A second controller id would be refused
   * outright: the Host grants one lease at a time, on purpose.
   */
  private static readonly controllerIdConst = 'jamat-session-manager-smoke'
  private static readonly hostBootMillisecondsConst = 30_000
  private static readonly settleMillisecondsConst = 30_000
  private static readonly repoRootConst = join(import.meta.dirname, '..', '..')
  /** The three worktrees this run cuts, one per ending of an install. */
  private static readonly setupOkSlugConst = 'setup-ok'
  private static readonly setupFailingSlugConst = 'setup-failing'
  private static readonly setupFirstStepFailsSlugConst = 'setup-first-step-fails'
  /**
   * The awkward name is the point: the space and the `&` are what the win32 caret escaping and the
   * POSIX single quoting exist for, and the worktree cut from this repository inherits both into the
   * `cd` of every install. Without them the escaping is only ever proved by string equality, which
   * is how the win32 branch shipped broken in the first place.
   */
  private static readonly projectDirectoryConst = 'R&D project'
  private static readonly setupScriptConst = 'setup.cjs'
  /** Written by the install into the directory it was actually given, which is what proves it ran. */
  private static readonly setupProofConst = 'setup-ran.txt'
  /** The per-step proofs of the two-step install, so each step can be told apart from the other. */
  private static readonly firstStepProofConst = 'first-step-ran.txt'
  private static readonly secondStepProofConst = 'second-step-ran.txt'
  private static readonly projectFileConst = 'README.md'
  private static readonly setupExitCodeConst = 7
  /** Deliberately not `setupExitCodeConst`: the session has to end with the code of THAT step. */
  private static readonly firstStepExitCodeConst = 9
  /**
   * How long the install takes. It has to outlast the reconcile `createSession` runs before it
   * answers, or "the id came back while the install was still running" would be a race rather than a
   * check.
   */
  private static readonly setupDelayMillisecondsConst = 1_500

  private readonly configDir: string
  private readonly stateRoot: string
  private readonly workDir: string
  private readonly projectRoot: string
  /** A project with NO version control at all, which is what checkpoints mode is for. */
  private readonly bareProjectRoot: string
  private readonly configIdentity: string
  private readonly descriptorFile: string
  private readonly errors: string[] = []
  private readonly manager: SessionManager
  private readonly git = new GitInvoker()
  private readonly crashedRecord: SessionRecord
  private host: ChildProcess | null = null
  private checkpointSession: { sessionId: string; worktreePath: string } | null = null
  /** What `acquireLease` holds the Host to: one lease id per Host process, never a second. */
  private heldLease: { hostInstanceId: string; controllerLeaseId: string } | null = null
  private changes = 0
  /**
   * Which mode the manager is in RIGHT NOW. One manager covers both, because the callback is
   * contracted to be read per operation - two managers would prove the wiring and not the
   * contract. Every scenario written before checkpoints existed keeps running in explicit `git`,
   * so it goes on covering that mode rather than quietly moving to the other one.
   */
  private versioningMode: VersioningMode = 'git'

  private constructor(root: string) {
    super()
    this.configDir = join(root, 'config')
    this.stateRoot = join(root, 'state')
    this.workDir = join(root, 'work')
    // The repository sits under the REAL path of the root, and only it does: on Windows `os.tmpdir()`
    // can answer with an 8.3 short name while git answers `rev-parse --show-toplevel` with the long
    // one. Two spellings of one directory is exactly the shape a resolved step is refused for, as a
    // step that escapes the repository it was resolved against.
    this.projectRoot = join(realpathSync.native(root), SmokeSessionManager.projectDirectoryConst)
    this.bareProjectRoot = join(realpathSync.native(root), 'project-without-vcs')
    mkdirSync(this.workDir, { recursive: true })
    // Named before anything resolves a path: both the Host's state scope and the orchestrator's hang
    // off it, and the Host child inherits it through its environment. The Host scope is pinned to
    // its default place inside that root rather than inherited, so an exported
    // JAMAT_V3_HOST_STATE_DIR cannot put this run's Host next to the developer's own.
    process.env.JAMAT_V3_LOCAL_STATE_DIR = this.stateRoot
    process.env.JAMAT_V3_HOST_STATE_DIR = join(this.stateRoot, 'host')
    this.configIdentity = ConfigIdentityStore
      .loadOrCreate(this.configDir, SmokeSessionManager.channelConst)
      .configIdentity
    this.descriptorFile = HostDescriptorPaths.descriptorFile(
      this.configIdentity,
      SmokeSessionManager.channelConst,
    )
    this.manager = new SessionManager({
      configDir: this.configDir,
      configIdentity: this.configIdentity,
      channel: SmokeSessionManager.channelConst,
      // The Host of this run is the one spawned below; nothing here may launch a detached one.
      autoStartHost: false,
      onChanged: () => { this.changes += 1 },
      onError: (message) => { this.errors.push(message) },
      controllerId: SmokeSessionManager.controllerIdConst,
      applicationRoot: SmokeSessionManager.repoRootConst,
      // A source tree: the Host starts from `app-host/start.ts`, never from a packaged bundle.
      resourcesRoot: null,
      versioningModeOf: () => this.versioningMode,
    })
    this.crashedRecord = {
      sessionId: SmokeSessionManager.crashedSessionIdConst,
      kind: 'shell',
      title: 'A create that never got its answer',
      directory: { mode: 'adHoc', path: this.workDir },
      binding: null,
      life: 'starting',
      pendingOperationId: SmokeSessionManager.crashedOperationIdConst,
      pendingOperationKind: 'create',
      createdAt: Date.now(),
    }
  }

  static async run(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-session-manager-smoke-'))
    const smoke = new SmokeSessionManager(root)
    try {
      await smoke.execute()
    } finally {
      await smoke.retire()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }

  private async execute(): Promise<void> {
    this.host = this.spawnHost()
    await this.waitForDescriptor()
    // Before the manager reads them: the records are loaded once, at start, which is exactly the
    // moment a client that crashed during a create comes back to them.
    await this.seedCrashedCreate()
    await this.manager.start()
    await this.waitUntil(
      () => this.manager.snapshot().host.presence === 'running',
      'the manager never reached the Host',
    )
    const snapshot = this.manager.snapshot()
    this.check(`the manager is talking to the Host it was pointed at (${snapshot.host.hostVersion})`,
      snapshot.host.hostVersion !== null && snapshot.host.hostInstanceId !== null)

    await this.checkCrashedCreateReplay()
    const sessionId = await this.checkCreate()
    await this.checkColourAndAdmits(sessionId)
    await this.checkHostLoss(sessionId)
    await this.checkHostReturn(sessionId)
    await this.checkReopen(sessionId)
    await this.checkReopenAfterEnd(sessionId)
    await this.checkOrphan()
    await this.checkStopAndRemove(sessionId)
    await this.prepareProject()
    await this.checkSetupSucceeds()
    await this.checkRetrySetup(await this.checkSetupFails())
    await this.checkSetupFirstStepFails()
    await this.checkMergeAndTeardown()
    await this.checkMergeAlreadyLanded()
    await this.checkMergeConflict()
    await this.checkDiscardWorktree()
    await this.checkCheckpointsMode()
    await this.checkSessionNumbers()
    await this.checkDetachKillsNothing()

    this.check(`the snapshot changed as the run went along (${this.changes} times)`, this.changes > 0)
    // The merge checks run against a project with no package.json and no `setup`, so the setup
    // manager truthfully says it installed nothing in each of their worktrees. Those three lines are
    // this run's own doing; anything else reaching the error channel is a fault.
    const unexpected = this.errors
      .filter((line) => !line.includes('nothing was installed in the worktree'))
    this.check(`nothing unexpected was reported through onError (${unexpected.join(' | ')})`,
      unexpected.length === 0)
    console.log(`\nsmoke-session-manager: ${this.passed} checks passed`)
  }

  /**
   * The half of the create ordering no unit test can reach: a record written before the wire call,
   * a client that never came back for the answer, and a real Host on the other side of the replay.
   *
   * The second half is the Host's own deduplication. The replay is sent a second time, byte for byte
   * - same operationId, same launch, so the same digest - and the Host has to answer with the runtime
   * it already made rather than start another process behind the same id.
   */
  private async checkCrashedCreateReplay(): Promise<void> {
    const sessionId = SmokeSessionManager.crashedSessionIdConst
    await this.waitUntil(
      () => this.sessionOf(sessionId)?.life === 'live',
      'the create that never got its answer was never replayed onto the Host',
    )
    const replayed = await this.runtimeOf(sessionId)
    this.check(`a starting record with a pending operation is replayed onto the Host (pid ${
      replayed.pid})`, replayed.alive)

    const again = await SmokeSessionManager.op<RuntimeResult>(
      this.readDescriptor(), 'runtime.create', {
        controllerLeaseId: await this.acquireLease(),
        operationId: SmokeSessionManager.crashedOperationIdConst,
        runtimeSessionId: sessionId,
        launch: LaunchPlanner.plan(this.crashedRecord),
      },
    )
    this.check('replaying that operationId answers with the runtime it already made',
      again.session.pid === replayed.pid && again.session.generation === replayed.generation)
    const listed = await this.listRuntimes()
    this.check('the Host is left holding one runtime for it, not two',
      listed.sessions.filter((session) => session.runtimeSessionId === sessionId).length === 1)

    // Cleared away so the rest of the run measures the world it was written for.
    SmokeSessionManager.valueOf(await this.manager.stopSession(sessionId), 'stopSession')
    await this.waitUntil(() => this.sessionOf(sessionId)?.life === 'ended',
      'the replayed session never ended')
    SmokeSessionManager.valueOf(await this.manager.removeSession(sessionId), 'removeSession')
  }

  /**
   * The two facts a surface reads off a session that are not about the Host at all: the colour it
   * was given, and which operations it admits. Both go through the records file and the snapshot,
   * which is the round trip worth proving here rather than in a unit test.
   */
  private async checkColourAndAdmits(sessionId: string): Promise<void> {
    // `finalize` joined the list on 2026-08-24, when the row's four operations moved from the
    // renderer's own reading into the library: for a live session it means stop-and-finish, which is
    // exactly what the row's button does. What a shell still does NOT admit is anything that needs a
    // conversation - no fork, no compact, no newBeside.
    this.check('a live shell admits a restart and a finish, and nothing that needs an agent',
      SmokeSessionManager.sameSet(
        this.sessionOf(sessionId)?.admits ?? [],
        ['restart', 'finalize'],
      ))
    this.check('a fork of a shell is refused, because a shell holds no conversation',
      await this.refusedWith(this.manager.forkSession(sessionId), 'invalid-spec'))

    this.check('a session starts with no colour', this.sessionOf(sessionId)?.color === undefined)
    SmokeSessionManager.valueOf(
      await this.manager.setSessionColor(sessionId, 'teal'), 'setSessionColor')
    this.check('the colour reaches the snapshot', this.sessionOf(sessionId)?.color === 'teal')
    SmokeSessionManager.valueOf(
      await this.manager.setSessionColor(sessionId, null), 'setSessionColor')
    this.check('clearing the colour takes it off the session',
      this.sessionOf(sessionId)?.color === undefined)
    this.check('a colour outside the palette is refused',
      await this.refusedWith(
        this.manager.setSessionColor(sessionId, 'chartreuse' as never), 'invalid-spec'))
  }

  private async refusedWith(
    operation: Promise<SessionsOpResult<unknown>>,
    code: SessionsOpErrorCode,
  ): Promise<boolean> {
    const result = await operation
    return !result.ok && result.code === code
  }

  private static sameSet(actual: readonly string[], expected: readonly string[]): boolean {
    return actual.length === expected.length && expected.every((one) => actual.includes(one))
  }

  private async checkCreate(): Promise<string> {
    const created = SmokeSessionManager.valueOf(
      await this.manager.createSession({
        kind: 'shell',
        directory: { mode: 'adHoc', path: this.workDir },
      }),
      'createSession',
    )
    this.check('a created session is live on the Host',
      this.sessionOf(created.sessionId)?.life === 'live')
    this.check('its directory is outside every catalog category, so it binds as adHoc',
      this.sessionOf(created.sessionId)?.project.kind === 'adHoc')
    // The shell writing its first prompt is the whole chain proving itself: a real PTY, the Host's
    // projection, the listing this manager polls and the diagnostic it hands out.
    //
    // Asked of `debugStatus()` rather than of the snapshot: the counters left `SessionInfo` on
    // 2026-08-24 because nothing drew them and everything they touched woke every window once a
    // poll. They live on the diagnostic surface, which is read when somebody asks.
    await this.waitUntil(
      () => (this.outputSeqOf(created.sessionId) ?? 0) > 0,
      'the session never produced any output',
    )
    this.check('the session is producing output',
      this.lastOutputAtOf(created.sessionId) !== null)
    this.check('the Host reports it among its live runtimes',
      this.manager.snapshot().host.liveCount === 1)
    return created.sessionId
  }

  /**
   * The descriptor is withdrawn before the process is killed, which is the order the Host's own
   * shutdown uses. A process killed under a descriptor that stays on disk is a different and equally
   * correct story - the client reports the socket it lost, once - and this run is asserting that the
   * quiet path stays quiet, so it does not stage that one.
   */
  private async checkHostLoss(sessionId: string): Promise<void> {
    rmSync(this.descriptorFile, { force: true })
    await this.waitUntil(
      () => this.manager.snapshot().host.presence === 'unreachable',
      'the manager never noticed the Host was gone',
    )
    await this.killHost()
    this.check('a Host that went away is unreachable, not a Host that lost its sessions',
      this.sessionOf(sessionId)?.life === 'live')
  }

  private async checkHostReturn(sessionId: string): Promise<void> {
    this.host = this.spawnHost()
    await this.waitForDescriptor()
    await this.waitUntil(
      () => this.sessionOf(sessionId)?.life === 'lost',
      'the session was never marked lost by the Host that came back without it',
    )
    this.check('a Host that answers and does not have the runtime marks the session lost',
      this.manager.snapshot().host.presence === 'running')
  }

  /**
   * A sequence number climbing above zero says nothing here: the session carried one from before the
   * Host went away. What the wait cannot see is WHEN the output arrived, so the moment of the reopen
   * is taken first and the Host's own timestamp on the last output has to be later than it - which
   * only a runtime created by this reopen can produce.
   */
  private async checkReopen(sessionId: string): Promise<void> {
    const reopenedAt = Date.now()
    SmokeSessionManager.valueOf(await this.manager.reopenSession(sessionId), 'reopenSession')
    this.check('reopening puts the session back under the very same id',
      this.sessionOf(sessionId)?.life === 'live')
    await this.waitUntil(
      () => (this.outputSeqOf(sessionId) ?? 0) > 0,
      'the reopened session never produced any output',
    )
    const lastOutputAt = this.lastOutputAtOf(sessionId)
    this.check('the output of the reopened session arrived after the reopen, not before the Host '
      + `went away (${lastOutputAt} >= ${reopenedAt})`,
      lastOutputAt !== null && lastOutputAt >= reopenedAt)
  }

  /**
   * The reopen route no unit test has run against a real Host. A session that ENDED still has its
   * dead runtime in the Host's listing, so the reopen goes through `runtime.replace` rather than
   * `runtime.create` - and the generation is what proves which one ran: a replace raises it on the
   * same runtime id, and a create against an id the Host already knows is refused outright.
   */
  private async checkReopenAfterEnd(sessionId: string): Promise<void> {
    SmokeSessionManager.valueOf(await this.manager.stopSession(sessionId), 'stopSession')
    await this.waitUntil(
      () => this.sessionOf(sessionId)?.life === 'ended',
      'the session that was stopped for the replace route never ended',
    )
    const before = await this.runtimeOf(sessionId)
    this.check(`an ended session keeps its dead runtime on the Host (generation ${
      before.generation})`, !before.alive)

    SmokeSessionManager.valueOf(await this.manager.reopenSession(sessionId), 'reopenSession')
    const after = await this.runtimeOf(sessionId)
    this.check(`reopening it replaces that runtime in place (generation ${before.generation} -> ${
      after.generation})`, after.alive && after.generation > before.generation)
    await this.waitUntil(
      () => this.sessionOf(sessionId)?.life === 'live',
      'the replaced session never came back live in the snapshot',
    )
  }

  private async checkOrphan(): Promise<void> {
    await this.createRuntimeOverTheWire(SmokeSessionManager.orphanRuntimeIdConst)
    await this.waitUntil(
      () => this.manager.snapshot().orphans
        .some((orphan) => orphan.runtimeSessionId === SmokeSessionManager.orphanRuntimeIdConst),
      'a runtime with no record was never reported as an orphan',
    )
    this.check('a live runtime nobody recorded is an orphan, and it is reported alive',
      this.manager.snapshot().orphans.some((orphan) =>
        orphan.runtimeSessionId === SmokeSessionManager.orphanRuntimeIdConst && orphan.alive))
    SmokeSessionManager.valueOf(
      await this.manager.adoptOrphan(SmokeSessionManager.orphanRuntimeIdConst),
      'adoptOrphan',
    )
    const snapshot = this.manager.snapshot()
    this.check('adopting it makes it a shell session and empties the orphan list',
      snapshot.orphans.length === 0
      && this.sessionOf(SmokeSessionManager.orphanRuntimeIdConst)?.kind === 'shell'
      && this.sessionOf(SmokeSessionManager.orphanRuntimeIdConst)?.life === 'live')
  }

  private async checkStopAndRemove(sessionId: string): Promise<void> {
    SmokeSessionManager.valueOf(await this.manager.stopSession(sessionId), 'stopSession')
    await this.waitUntil(
      () => this.sessionOf(sessionId)?.life === 'ended',
      'the stopped session never ended',
    )
    // The wait already proved the life; what it never looked at is the exit code, which travels from
    // the PTY through the Host's listing and the reconciler's mark-ended. An `undefined` there prints
    // exactly like a number in a message and would have gone on passing.
    const exitCode = this.sessionOf(sessionId)?.exitCode
    this.check(`a stopped session ends carrying the code the process exited with (${exitCode})`,
      typeof exitCode === 'number')
    SmokeSessionManager.valueOf(await this.manager.removeSession(sessionId), 'removeSession')
    this.check('removing an ended session leaves no record of it',
      this.sessionOf(sessionId) === undefined)
  }

  /**
   * The setup path with nothing faked: a real repository, a real worktree cut from it, a real shell
   * running the install and a real Host owning both PTYs.
   *
   * The session that waits for the install is a SHELL with a worktree rather than an agent, and that
   * is the point of the setup being decided by `spec.worktree` and not by the kind: this run proves
   * the whole chain without any agent binary being installed on the machine.
   *
   * `.worktree.json` is written into the MAIN copy and never committed, which is where the resolution
   * reads it - the worktree git makes has no such file at all.
   */
  private async checkSetupSucceeds(): Promise<void> {
    // `dev` is a key this build has never heard of, and the read is meant to walk straight past it.
    this.writeWorktreeConfig({
      dev: 'read by nothing here',
      setup: ['echo installing', `node ${SmokeSessionManager.setupScriptConst} 0`],
    })
    const created = await this.createThroughSetupGate({
      kind: 'shell',
      directory: { mode: 'project', categoryId: 'smoke', projectPath: this.projectRoot },
      worktree: { slug: SmokeSessionManager.setupOkSlugConst },
    }, ['echo installing', `node ${SmokeSessionManager.setupScriptConst} 0`])
    const waiting = this.sessionOf(created.sessionId)
    const install = this.setupSessionOf(created.sessionId)
    const worktreePath = waiting?.worktree?.worktreePath
    if (worktreePath === undefined)
      throw new Error('FAILED: the session created with a worktree names none')
    this.check('a worktree create whose project declares a setup answers with the session id while '
      + `the install is still running (life ${waiting?.life})`, waiting?.life === 'starting')
    this.check(`the install is a session of its own, live on the Host (${install?.sessionId})`,
      install !== undefined && install.kind === 'shell' && install.life === 'live')
    this.check('the waiting session says an install is running and names the session running it',
      waiting?.setup !== undefined && waiting.setup.state === 'running'
      && waiting.setup.setupSessionId === install?.sessionId)

    await this.waitUntil(
      () => this.sessionOf(created.sessionId)?.life === 'live',
      'the session never started after its install finished',
    )
    this.check('the session starts once the install exits 0, under the id create had already answered '
      + 'with', this.sessionOf(created.sessionId)?.life === 'live')
    this.check('and it says it is waiting for nothing any more',
      this.sessionOf(created.sessionId)?.setup === undefined)
    this.check(`the install really ran inside the worktree (${worktreePath})`,
      existsSync(join(worktreePath, SmokeSessionManager.setupProofConst)))
    const finished = this.setupSessionOf(created.sessionId)
    this.check(`the install session is left ended, with its terminal and its exit code (${
      finished?.exitCode})`, finished?.life === 'ended' && finished.exitCode === 0)

    // Cleared away because this root is deleted at the end: a live shell holds its worktree open.
    SmokeSessionManager.valueOf(await this.manager.stopSession(created.sessionId), 'stopSession')
    await this.waitUntil(() => this.sessionOf(created.sessionId)?.life === 'ended',
      'the session the install started never stopped')
  }

  /**
   * The other ending. The install exits non-zero, so the session it was preparing never runs - and
   * the worktree and the branch stay exactly where they are, because nothing here throws away a
   * directory a retry needs and a user may want.
   */
  private async checkSetupFails(): Promise<{ sessionId: string; worktreePath: string }> {
    this.writeWorktreeConfig({
      setup: [`node ${SmokeSessionManager.setupScriptConst} ${
        SmokeSessionManager.setupExitCodeConst}`],
    })
    const created = await this.createThroughSetupGate({
      kind: 'shell',
      directory: { mode: 'project', categoryId: 'smoke', projectPath: this.projectRoot },
      worktree: { slug: SmokeSessionManager.setupFailingSlugConst },
    }, [`node ${SmokeSessionManager.setupScriptConst} ${SmokeSessionManager.setupExitCodeConst}`])
    const worktreePath = this.sessionOf(created.sessionId)?.worktree?.worktreePath
    if (worktreePath === undefined)
      throw new Error('FAILED: the session created with a failing setup names no worktree')
    await this.waitUntil(
      () => this.sessionOf(created.sessionId)?.life === 'ended',
      'the session whose install failed never ended',
    )
    const reason = this.sessionOf(created.sessionId)?.endedReason ?? ''
    this.check(`a session whose install failed ends naming the failure (${reason})`,
      reason.startsWith('setup failed:')
      && reason.includes(String(SmokeSessionManager.setupExitCodeConst)))
    const marker = this.sessionOf(created.sessionId)?.setup
    this.check('it still names the install session, which is what a retry works from',
      marker !== undefined && marker.state === 'failed'
      && marker.setupSessionId === this.setupSessionOf(created.sessionId)?.sessionId)
    this.check(`the worktree it made is left on disk with the commit in it (${worktreePath})`,
      existsSync(join(worktreePath, SmokeSessionManager.projectFileConst)))
    // The failure is announced on the error channel as well. Taking it here is what turns it into an
    // assertion instead of a surprise for the run's own "nothing was reported" check.
    const announced = this.takeReports((message) => message.includes(worktreePath))
    this.check('and what it leaves behind is named on the error channel, once',
      announced.length === 1 && announced[0].includes('the setup failed'))
    return { sessionId: created.sessionId, worktreePath }
  }

  /**
   * The way back from a failed install, and the only one there is: the worktree and its branch are
   * still on disk, so a fresh create over the same slug is refused as `worktree-exists` and `reopen`
   * is refused because the worktree is not installed.
   *
   * What makes it work is that `retrySetup` RE-RESOLVES instead of replaying: the commands stored on
   * the install session still say exit 7, and a retry that repeated them would walk into the same
   * wall for ever. So fixing `.worktree.json` is what fixes the session, and the session starting is
   * the proof the fresh file is what ran.
   */
  private async checkRetrySetup(
    failed: { sessionId: string; worktreePath: string },
  ): Promise<void> {
    const install = this.setupSessionOf(failed.sessionId)?.sessionId
    // The cause, removed the way a user removes it. The first install's proof goes with it, so the
    // file being back afterwards is proof that a SECOND one ran.
    const fixed = [`node ${SmokeSessionManager.setupScriptConst} 0`]
    this.writeWorktreeConfig({ setup: fixed })
    rmSync(join(failed.worktreePath, SmokeSessionManager.setupProofConst), { force: true })

    // The edit that fixes a failed install is the very edit that moves the hash, so the retry meets
    // the gate on commands nobody has seen yet - and is refused rather than skipped, because a retry
    // has a caller who can answer.
    const refused = await this.manager.retrySetup(failed.sessionId)
    this.check(`a retry whose .worktree.json changed since it was agreed to asks again (${
      refused.ok ? 'accepted' : refused.code})`,
      !refused.ok && refused.code === 'setup-not-acknowledged'
      && JSON.stringify(refused.setup?.commands) === JSON.stringify(fixed))

    SmokeSessionManager.valueOf(
      await this.manager.retrySetup(
        failed.sessionId,
        refused.ok ? undefined : refused.setup?.hash,
      ),
      'retrySetup',
    )

    await this.waitUntil(
      () => this.sessionOf(failed.sessionId)?.life === 'live',
      'the session never started after its setup was retried',
    )
    this.check('a retried setup resolves the project again, so the session starts on the fixed '
      + '.worktree.json and not on the commands that failed',
      this.sessionOf(failed.sessionId)?.setup === undefined)
    this.check('the retry reopens the same install session instead of making a second one',
      install !== undefined && this.setupSessionOf(failed.sessionId)?.sessionId === install)
    this.check(`the retried install ran in the worktree that was already there (${
      failed.worktreePath})`,
      existsSync(join(failed.worktreePath, SmokeSessionManager.setupProofConst)))

    // Cleared away because this root is deleted at the end: a live shell holds its worktree open.
    SmokeSessionManager.valueOf(await this.manager.stopSession(failed.sessionId), 'stopSession')
    await this.waitUntil(() => this.sessionOf(failed.sessionId)?.life === 'ended',
      'the retried session never stopped')
  }

  /**
   * The install that has more than one step, and the shape no other scenario here can reach: the
   * FIRST step fails and the SECOND one carries a tolerating operator of its own.
   *
   * Joined with `&&`, that operator used to cover the whole line - `&&` and `||` have equal precedence
   * and associate to the left - so a failed first step exited 0, the reconciler read a clean install
   * and launched the agent into a worktree with nothing installed in it. Every step's exit code being
   * its own is what the three checks below are for: the code the session ends with, the proof that
   * step one really ran, and the absence of any trace that step two did.
   */
  private async checkSetupFirstStepFails(): Promise<void> {
    this.writeWorktreeConfig({
      setup: [
        `node ${SmokeSessionManager.setupScriptConst} ${
          SmokeSessionManager.firstStepExitCodeConst} ${SmokeSessionManager.firstStepProofConst}`,
        `node ${SmokeSessionManager.setupScriptConst} 0 ${
          SmokeSessionManager.secondStepProofConst} || echo tolerated`,
      ],
    })
    const created = await this.createThroughSetupGate({
      kind: 'shell',
      directory: { mode: 'project', categoryId: 'smoke', projectPath: this.projectRoot },
      worktree: { slug: SmokeSessionManager.setupFirstStepFailsSlugConst },
    }, [
      `node ${SmokeSessionManager.setupScriptConst} ${
        SmokeSessionManager.firstStepExitCodeConst} ${SmokeSessionManager.firstStepProofConst}`,
      `node ${SmokeSessionManager.setupScriptConst} 0 ${
        SmokeSessionManager.secondStepProofConst} || echo tolerated`,
    ])
    const worktreePath = this.sessionOf(created.sessionId)?.worktree?.worktreePath
    if (worktreePath === undefined)
      throw new Error('FAILED: the session created with a two-step setup names no worktree')
    await this.waitUntil(
      () => this.sessionOf(created.sessionId)?.life === 'ended',
      'the session whose first install step failed never ended',
    )
    const reason = this.sessionOf(created.sessionId)?.endedReason ?? ''
    this.check('a two-step install whose FIRST step fails ends the session with THAT step\'s code, '
      + `not with the tolerated code of the second (${reason})`,
      reason.startsWith('setup failed:')
      && reason.includes(String(SmokeSessionManager.firstStepExitCodeConst)))
    this.check(`the install session carries the same code (${
      this.setupSessionOf(created.sessionId)?.exitCode})`,
      this.setupSessionOf(created.sessionId)?.exitCode
        === SmokeSessionManager.firstStepExitCodeConst)
    this.check('the first step really ran, so the failure is the step\'s and not the planning\'s',
      existsSync(join(worktreePath, SmokeSessionManager.firstStepProofConst)))
    this.check('and the second step left no trace, because it never ran',
      !existsSync(join(worktreePath, SmokeSessionManager.secondStepProofConst)))

    const announced = this.takeReports((message) => message.includes(worktreePath))
    this.check('what it leaves behind is named on the error channel, once',
      announced.length === 1 && announced[0].includes('the setup failed'))
  }

  /**
   * The merge, against real git. What no unit test reaches is whether the commands themselves do
   * what the flow believes: that `--no-ff` leaves a merge commit, that the forced removal takes the
   * directory, and that the branch is gone afterwards.
   */
  private async checkMergeAndTeardown(): Promise<void> {
    const session = await this.worktreeSession('merge-clean', 'clean.txt', 'merged from a worktree')
    const merged = await this.manager.mergeSession(session.sessionId)
    this.check(`a clean merge finishes (${merged.ok ? 'ok' : `${merged.code}: ${merged.detail}`})`,
      merged.ok)

    const log = await this.git.run(this.projectRoot, ['log', '--oneline', '-1', '--merges'])
    this.check(`the main copy carries a merge commit (${log.stdout.trim()})`,
      log.stdout.trim().length > 0)
    this.check('the file the session wrote is in the main copy',
      existsSync(join(this.projectRoot, 'clean.txt')))
    this.check(`the worktree is gone from disk (${session.worktreePath})`,
      !existsSync(session.worktreePath))
    const branches = await this.git.run(this.projectRoot, ['branch', '--list', session.branch])
    this.check(`the branch is gone too (${session.branch})`, branches.stdout.trim().length === 0)
    this.check('and the record no longer names either',
      this.sessionOf(session.sessionId)?.worktree === undefined)
  }

  /**
   * The crash the flow's whole shape rests on: the main merge landed and the client died before
   * the teardown. Running Merge again must do the teardown and NOT merge a second time, and the
   * only thing that can answer it is real git - `merge-base --is-ancestor` against a real
   * `--no-ff` merge commit. A fake would only repeat what the flow already believes.
   *
   * The interruption is simulated the honest way: the branch is merged with a raw `git merge`,
   * exactly as the flow would have, and nothing is written to the record. That is what a crash
   * between the two steps leaves on disk.
   */
  private async checkMergeAlreadyLanded(): Promise<void> {
    const session = await this.worktreeSession('merge-landed', 'landed.txt', 'already merged')
    await this.runGit([
      '-c', 'user.name=Jamat Smoke',
      '-c', 'user.email=smoke@jamat.invalid',
      '-c', 'commit.gpgsign=false',
      'merge', '--no-ff', '--no-edit', '--end-of-options', session.branch,
    ])
    const before = await this.git.run(this.projectRoot, ['rev-parse', 'HEAD'])

    const merged = await this.manager.mergeSession(session.sessionId)

    this.check(`Merge run over a branch that is already home finishes (${
      merged.ok ? 'ok' : `${merged.code}: ${merged.detail}`})`, merged.ok)
    const after = await this.git.run(this.projectRoot, ['rev-parse', 'HEAD'])
    this.check('and it made no second merge commit, because there was nothing left to merge',
      before.stdout.trim() === after.stdout.trim())
    this.check(`the teardown still ran and the worktree is gone (${session.worktreePath})`,
      !existsSync(session.worktreePath))
    const branches = await this.git.run(this.projectRoot, ['branch', '--list', session.branch])
    this.check(`the branch is gone too (${session.branch})`, branches.stdout.trim().length === 0)
    this.check('and the record no longer names either',
      this.sessionOf(session.sessionId)?.worktree === undefined)
  }

  /**
   * The other half of the design: a conflict stops in the worktree, the record says so, and running
   * Merge again after the person resolved it finishes the job.
   */
  private async checkMergeConflict(): Promise<void> {
    // Both sides change the same line, which is what makes it a conflict rather than two edits.
    const contested = 'contested.txt'
    writeFileSync(join(this.projectRoot, contested), 'the original line\n', 'utf8')
    await this.runGit(['add', '--', contested])
    await this.commitSmoke('the line both sides will change')

    const session = await this.worktreeSession('merge-conflict', contested, 'the worktree line')
    writeFileSync(join(this.projectRoot, contested), 'the main copy line\n', 'utf8')
    await this.runGit(['add', '--', contested])
    await this.commitSmoke('the main copy changes it too')

    const refused = await this.manager.mergeSession(session.sessionId)
    this.check(`a conflicting merge stops rather than guessing (${
      refused.ok ? 'ok' : refused.code})`, !refused.ok && refused.code === 'merge-conflict')
    this.check('the record says it is being resolved',
      this.sessionOf(session.sessionId)?.merge?.phase === 'resolving')
    this.check('the worktree is left with the half-finished merge in it, markers and all',
      readFileSync(join(session.worktreePath, contested), 'utf8').includes('<<<<<<<'))

    // Resolved by hand, which is the fallback path that is always available.
    writeFileSync(join(session.worktreePath, contested), 'both lines, reconciled\n', 'utf8')
    await this.runGitIn(session.worktreePath, ['add', '--', contested])
    await this.commitSmoke('resolve the conflict', session.worktreePath)

    const finished = await this.manager.mergeSession(session.sessionId)
    this.check(`Merge run again after the resolution finishes it (${
      finished.ok ? 'ok' : `${finished.code}: ${finished.detail}`})`, finished.ok)
    this.check('and the worktree is gone', !existsSync(session.worktreePath))
    this.check('the reconciled line is what the main copy has now',
      readFileSync(join(this.projectRoot, contested), 'utf8').includes('reconciled'))
  }

  private async checkDiscardWorktree(): Promise<void> {
    const session = await this.worktreeSession('merge-discard', 'thrown-away.txt', 'never merged')
    const discarded = await this.manager.discardWorktree(session.sessionId)
    this.check(`a discard finishes (${discarded.ok ? 'ok' : discarded.code})`, discarded.ok)

    this.check('the worktree is gone', !existsSync(session.worktreePath))
    const branches = await this.git.run(this.projectRoot, ['branch', '--list', session.branch])
    this.check(`the branch is gone (${session.branch})`, branches.stdout.trim().length === 0)
    this.check('and nothing of it reached the main copy',
      !existsSync(join(this.projectRoot, 'thrown-away.txt')))
  }

  /**
   * A worktree session with one commit in it, stopped and ready to be merged. The session itself is
   * a shell that does nothing: what is under test is the git, not the agent.
   */
  private async worktreeSession(
    slug: string,
    file: string,
    line: string,
  ): Promise<{ sessionId: string; worktreePath: string; branch: string }> {
    // The setup checks above left a `.worktree.json` behind, and a session that has to wait for an
    // install is not what these three are about. With no `setup` key there is no gate and no wait.
    this.writeWorktreeConfig({})
    const created = SmokeSessionManager.valueOf(await this.manager.createSession({
      kind: 'shell',
      directory: { mode: 'project', categoryId: 'smoke', projectPath: this.projectRoot },
      worktree: { slug },
    }), 'createSession')
    const info = this.sessionOf(created.sessionId)
    const worktreePath = info?.worktree?.worktreePath
    const branch = info?.worktree?.branch
    if (worktreePath === undefined || branch === undefined)
      throw new Error('FAILED: a session created with a worktree names none')

    writeFileSync(join(worktreePath, file), `${line}\n`, 'utf8')
    await this.runGitIn(worktreePath, ['add', '--', file])
    await this.commitSmoke(`work done in ${slug}`, worktreePath)

    // A merge tears the directory down, so the session standing in it has to be finished first.
    SmokeSessionManager.valueOf(await this.manager.stopSession(created.sessionId), 'stopSession')
    await this.waitUntil(() => this.sessionOf(created.sessionId)?.life === 'ended',
      `the ${slug} session never ended`)
    return { sessionId: created.sessionId, worktreePath, branch }
  }

  /** The identity and the hooks are this commit's own: the machine's git config decides nothing. */
  private async commitSmoke(message: string, cwd = this.projectRoot): Promise<void> {
    await this.runGitIn(cwd, [
      '-c', 'user.name=Jamat Smoke',
      '-c', 'user.email=smoke@jamat.invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '--no-verify', '--quiet', '-m', message,
    ])
  }

  private async runGitIn(cwd: string, args: string[]): Promise<void> {
    const outcome = await this.git.run(cwd, args)
    if (outcome.failure !== null || outcome.code !== 0)
      throw new Error(`FAILED: git ${args.join(' ')} in ${cwd}: ${
        outcome.stderr.trim() || outcome.stdout.trim() || `exit ${outcome.code}`}`)
  }

  /**
   * The numbering, against a real state directory and a real project folder. What no unit test
   * reaches is the wiring: that the facade finds the file `OrchestratorPaths` names, and that the
   * seed reads the `.worktrees/` of the project it was actually handed.
   */
  /**
   * The whole point of checkpoints mode, against a project that has NO version control at all - no
   * `.git`, no `.svn`, nothing. Nothing in this section is reachable in git mode: there is no
   * repository to cut a worktree from, which the git-mode check at the end asserts directly.
   *
   * The mode is switched on the live callback rather than by building a second manager, because
   * "read per operation" is the contract and a second manager would only prove the constructor.
   */
  private async checkCheckpointsMode(): Promise<void> {
    this.versioningMode = 'checkpoints'
    try {
      await this.checkCheckpointCut()
      await this.checkCheckpointLanding()
      await this.checkCheckpointRefusesInGitMode()
    }
    finally {
      this.versioningMode = 'git'
    }
  }

  private async checkCheckpointCut(): Promise<void> {
    mkdirSync(this.bareProjectRoot, { recursive: true })
    writeFileSync(join(this.bareProjectRoot, 'shared.txt'), 'head\nmiddle\ntail\n', 'utf8')
    writeFileSync(join(this.bareProjectRoot, 'human.txt'), 'the human wrote this\n', 'utf8')

    const created = SmokeSessionManager.valueOf(await this.manager.createSession({
      kind: 'shell',
      directory: { mode: 'project', categoryId: 'smoke', projectPath: this.bareProjectRoot },
      worktree: { slug: 'checkpoint-cut' },
    }), 'createSession')
    const worktreePath = this.sessionOf(created.sessionId)?.worktree?.worktreePath
    if (worktreePath === undefined)
      throw new Error('FAILED: a checkpoint session created with a worktree names none')

    this.check('a project with no version control at all got a store of its own',
      existsSync(join(this.bareProjectRoot, CheckpointLayout.storeRelativeConst, 'HEAD')))
    this.check('and it never gained a .git of its own',
      !existsSync(join(this.bareProjectRoot, '.git')))
    this.check(`the worktree points into the store rather than at a repository (${worktreePath})`,
      readFileSync(join(worktreePath, '.git'), 'utf8').includes(CheckpointLayout.storeNameConst))
    this.check('the work that was already there came along into the worktree',
      readFileSync(join(worktreePath, 'shared.txt'), 'utf8').includes('middle'))

    this.checkpointSession = { sessionId: created.sessionId, worktreePath }
  }

  /**
   * The landing MERGES: the session's change and the human's uncommitted change are two sides of one
   * merge, not one overwriting the other. That is the property the whole mode exists for, so it is
   * asserted on the bytes of the file rather than on the result code.
   */
  private async checkCheckpointLanding(): Promise<void> {
    const session = this.checkpointSession
    if (session === null) throw new Error('FAILED: no checkpoint session to land')

    writeFileSync(
      join(session.worktreePath, 'shared.txt'),
      'head\nmiddle\nTAIL FROM THE SESSION\n',
      'utf8',
    )
    writeFileSync(join(session.worktreePath, 'from-session.txt'), 'the session wrote this\n', 'utf8')
    // NOTHING is committed here, on purpose: an agent leaves its work on disk. Until 2026-08-28 the
    // merge refused that in this mode, and the bash twin did worse - it carried nothing and reported
    // a landing. The checkpoint the merge takes of the worktree is what these checks now prove.
    SmokeSessionManager.valueOf(await this.manager.stopSession(session.sessionId), 'stopSession')
    await this.waitUntil(() => this.sessionOf(session.sessionId)?.life === 'ended',
      'the checkpoint session never ended')

    // The human is mid-edit in their own copy when Merge is pressed. In git mode this is a refusal;
    // here the checkpoint takes it into the merge, which is the difference the mode is for.
    writeFileSync(join(this.bareProjectRoot, 'shared.txt'), 'HEAD FROM THE HUMAN\nmiddle\ntail\n', 'utf8')
    writeFileSync(join(this.bareProjectRoot, 'untracked.txt'), 'never staged by anyone\n', 'utf8')

    const merged = await this.manager.mergeSession(session.sessionId)
    this.check(`a merge over a main copy the human is editing finishes (${
      merged.ok ? 'ok' : `${merged.code}: ${merged.detail}`})`, merged.ok)

    const landed = readFileSync(join(this.bareProjectRoot, 'shared.txt'), 'utf8')
    this.check(`the session's change reached the main copy (${landed.includes('TAIL FROM THE SESSION')})`,
      landed.includes('TAIL FROM THE SESSION'))
    this.check('and the human\'s uncommitted line survived it, so the landing merged rather than overwrote',
      landed.includes('HEAD FROM THE HUMAN'))
    this.check('the file the session added is there too',
      existsSync(join(this.bareProjectRoot, 'from-session.txt')))
    this.check('and an untracked file nobody staged was left alone',
      existsSync(join(this.bareProjectRoot, 'untracked.txt')))
    this.check(`the worktree is gone from disk (${session.worktreePath})`,
      !existsSync(session.worktreePath))
    this.check('and the record no longer names it',
      this.sessionOf(session.sessionId)?.worktree === undefined)

    const store = join(this.bareProjectRoot, CheckpointLayout.storeRelativeConst)
    const log = await this.git.run(this.bareProjectRoot, [
      '--git-dir', store, '--work-tree', this.bareProjectRoot,
      'log', CheckpointLayout.branchConst, '--format=%an|%s',
    ])
    const lines = log.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    this.check(`the store's ${CheckpointLayout.branchConst} line carries the cut checkpoint (${
      lines.length} commits)`,
      lines.some((line) => line.includes('Checkpoint in the main copy before cutting worktree checkpoint-cut')))
    this.check('and the checkpoint taken before the landing',
      lines.some((line) => line.includes('Checkpoint in the main copy before merging')))
    this.check('and the one the merge took of the worktree, which nobody committed by hand',
      lines.some((line) => line.includes('Checkpoint in the worktree on')))
    this.check(`every checkpoint says a tool wrote it, not a person (${
      CheckpointLayout.authorNameConst})`,
      lines.filter((line) => line.includes('Checkpoint in the'))
        .every((line) => line.startsWith(`${CheckpointLayout.authorNameConst}|`)))
  }

  /** The escape hatch behaves as it always did: no repository, no worktree, and nothing created. */
  private async checkCheckpointRefusesInGitMode(): Promise<void> {
    this.versioningMode = 'git'
    const bare = join(this.bareProjectRoot, '..', 'project-git-mode-refusal')
    mkdirSync(bare, { recursive: true })
    writeFileSync(join(bare, 'a.txt'), 'nothing versions this\n', 'utf8')

    const refused = await this.manager.createSession({
      kind: 'shell',
      directory: { mode: 'project', categoryId: 'smoke', projectPath: bare },
      worktree: { slug: 'git-mode' },
    })

    this.check(`git mode refuses a project that is not a repository (${
      refused.ok ? 'ok' : refused.code})`, !refused.ok && refused.code === 'not-a-repo')
    this.check('and it created neither a git nor a store while refusing',
      !existsSync(join(bare, '.git'))
      && !existsSync(join(bare, CheckpointLayout.folderNameConst))
      && !existsSync(join(bare, '.worktrees')))
    this.versioningMode = 'checkpoints'
  }

  private async checkSessionNumbers(): Promise<void> {
    const first = SmokeSessionManager.valueOf(
      await this.manager.nextSessionNumber(this.projectRoot), 'nextSessionNumber')
    this.check(`a project nobody has numbered starts at 001 (${first.token})`, first.token === '001')

    const taken = SmokeSessionManager.valueOf(
      await this.manager.allocateSessionNumber(this.projectRoot), 'allocateSessionNumber')
    const second = SmokeSessionManager.valueOf(
      await this.manager.allocateSessionNumber(this.projectRoot), 'allocateSessionNumber')
    this.check(`allocating twice hands out two numbers (${taken.token}, ${second.token})`,
      taken.token === '001' && second.token === '002')

    const file = OrchestratorPaths.sessionNumbersFile(
      this.configIdentity, SmokeSessionManager.channelConst)
    this.check(`the count is on disk where OrchestratorPaths says (${file})`, existsSync(file))

    // The worktrees the setup checks already left behind are numbered by their own slugs, so this
    // one is written by hand: it is the seed path a lost counter file has to recover through.
    mkdirSync(join(this.projectRoot, '.worktrees', '044-carried-over'), { recursive: true })
    rmSync(file, { force: true })
    const reloaded = new SessionManager({
      configDir: this.configDir,
      configIdentity: this.configIdentity,
      channel: SmokeSessionManager.channelConst,
      autoStartHost: false,
      onChanged: () => {},
      onError: (message) => { this.errors.push(message) },
      controllerId: SmokeSessionManager.controllerIdConst,
      applicationRoot: SmokeSessionManager.repoRootConst,
      resourcesRoot: null,
    })
    const recovered = SmokeSessionManager.valueOf(
      await reloaded.allocateSessionNumber(this.projectRoot), 'allocateSessionNumber')
    this.check(`a lost counter file counts on from the worktrees on disk (${recovered.token})`,
      recovered.token === '045')
    await reloaded.stop()
  }

  /**
   * A repository one commit deep to cut worktrees from, carrying the script the installs run. The
   * script is COMMITTED so that the worktree has it: the install runs in the copy git makes, not in
   * the directory the configuration was read from.
   */
  private async prepareProject(): Promise<void> {
    mkdirSync(this.projectRoot, { recursive: true })
    writeFileSync(
      join(this.projectRoot, SmokeSessionManager.projectFileConst),
      'The project a worktree is cut from.\n',
      'utf8',
    )
    writeFileSync(
      join(this.projectRoot, SmokeSessionManager.setupScriptConst),
      SmokeSessionManager.setupScriptSource(),
      'utf8',
    )
    await this.runGit(['init', '--quiet'])
    await this.runGit([
      'add', '--',
      SmokeSessionManager.projectFileConst,
      SmokeSessionManager.setupScriptConst,
    ])
    // The identity and the hooks are this commit's own: the machine's git config decides nothing here.
    await this.runGit([
      '-c', 'user.name=Jamat Smoke',
      '-c', 'user.email=smoke@jamat.invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '--no-verify', '--quiet', '-m', 'The commit the worktrees are cut from',
    ])
  }

  /**
   * The install itself. It writes proof that it ran in the directory it was handed, waits long enough
   * for this run to SEE it running, and exits with the code its `.worktree.json` step asked for. Plain
   * CommonJS and `node` off the PATH, so it needs nothing installed and runs on either platform.
   *
   * The proof file is named by the step when a setup has more than one, so the steps of one install
   * can be told apart on disk; a single-step setup leaves it out and gets the default name.
   */
  private static setupScriptSource(): string {
    return [
      "const { writeFileSync } = require('node:fs')",
      `writeFileSync(process.argv[3] ?? '${
        SmokeSessionManager.setupProofConst}', process.cwd())`,
      `setTimeout(() => process.exit(Number(process.argv[2])), ${
        SmokeSessionManager.setupDelayMillisecondsConst})`,
      '',
    ].join('\n')
  }

  private writeWorktreeConfig(document: Record<string, unknown>): void {
    writeFileSync(
      join(this.projectRoot, '.worktree.json'),
      `${JSON.stringify(document, null, 2)}\n`,
      'utf8',
    )
  }

  private async runGit(args: string[]): Promise<void> {
    const outcome = await this.git.run(this.projectRoot, args)
    if (outcome.failure !== null || outcome.code !== 0)
      throw new Error(`FAILED: git ${args.join(' ')} in the smoke repository: ${
        outcome.stderr.trim() || outcome.stdout.trim() || `exit ${outcome.code}`}`)
  }

  /**
   * A create whose project declares its own setup, through the gate that stands in front of one.
   *
   * The first attempt is expected to be refused: `.worktree.json` travels with a repository, so its
   * commands are the one input this library runs that nobody on this machine wrote. The refusal
   * carries them and a hash, and the second attempt hands that hash back - which is exactly what the
   * launcher's button does, and what makes this the end-to-end proof of the gate.
   */
  private async createThroughSetupGate(
    spec: SessionCreateSpec,
    expected: readonly string[],
  ): Promise<{ sessionId: string }> {
    const refused = await this.manager.createSession(spec)
    if (refused.ok)
      throw new Error('FAILED: a repository-authored setup started without anybody agreeing to it')
    this.check(`a create whose project declares its own setup is refused until somebody agrees `
      + `(${refused.code})`, refused.code === 'setup-not-acknowledged')
    this.check('the refusal names the commands it is asking about',
      JSON.stringify(refused.setup?.commands) === JSON.stringify(expected))
    // The whole reason the gate stands before the worktree is cut rather than beside the resolution.
    this.check('the refused create left no worktree behind',
      !existsSync(join(this.projectRoot, '.worktrees', spec.worktree?.slug ?? '')))

    return SmokeSessionManager.valueOf(
      await this.manager.createSession({ ...spec, acknowledgeSetup: refused.setup?.hash }),
      'createSession',
    )
  }

  /** The install session of a session, which is the only place the pair is visible from outside. */
  private setupSessionOf(sessionId: string): SessionInfo | undefined {
    return this.manager.snapshot().sessions.find((session) => session.setupFor === sessionId)
  }

  /**
   * Lines this run EXPECTS on the error channel: they are checked where they happen and taken out of
   * the way of the silence check at the end, which then keeps meaning what it says.
   */
  private takeReports(matches: (message: string) => boolean): string[] {
    const taken = this.errors.filter(matches)
    for (const message of taken) this.errors.splice(this.errors.indexOf(message), 1)
    return taken
  }

  /** The invariant the whole design stands on: closing a client detaches, it does not terminate. */
  private async checkDetachKillsNothing(): Promise<void> {
    const descriptor = this.readDescriptor()
    await this.manager.stop()
    const listed = await SmokeSessionManager.op<RuntimeListResult>(descriptor, 'runtime.list', {})
    this.check('detaching the client leaves every runtime the Host owns alive',
      listed.sessions.some((session) =>
        session.runtimeSessionId === SmokeSessionManager.orphanRuntimeIdConst && session.alive))
  }

  /**
   * The record a client writes before it calls the Host, left behind by a client that never made the
   * call - or made it and died before the answer. Written through the store the manager itself uses,
   * so it is a record the manager could have written, not a shape invented here.
   */
  private async seedCrashedCreate(): Promise<void> {
    const store = await SessionRecordsStore.load(
      OrchestratorPaths.sessionRecordsFile(this.configIdentity, SmokeSessionManager.channelConst),
      {
        snapshotsDirectory: OrchestratorPaths.sessionSnapshotsDirectory(
          this.configIdentity,
          SmokeSessionManager.channelConst,
        ),
        report: (message) => this.errors.push(message),
      },
    )
    if (!await store.put(this.crashedRecord))
      throw new Error('the crashed create could not be written to the records file')
  }

  /**
   * A runtime the manager knows nothing about, created the way any other client of the wire would.
   * The lease is acquired under the manager's own controller id and deliberately never released:
   * releasing it would take the writer authority away from the manager that is holding it.
   */
  private async createRuntimeOverTheWire(runtimeSessionId: string): Promise<void> {
    const descriptor = this.readDescriptor()
    await SmokeSessionManager.op<RuntimeResult>(descriptor, 'runtime.create', {
      controllerLeaseId: await this.acquireLease(),
      operationId: `smoke-${runtimeSessionId}`,
      runtimeSessionId,
      launch: {
        command: process.env.ComSpec ?? 'cmd.exe',
        args: [],
        cwd: this.workDir,
        env: ChildEnvironment.withoutJamat(process.env),
        cols: 120,
        rows: 30,
      },
    })
  }

  private readDescriptor(): HostDescriptor {
    return JSON.parse(readFileSync(this.descriptorFile, 'utf8')) as HostDescriptor
  }

  /**
   * The lease the manager is holding, and this reads it rather than replacing it - but only because
   * of one invariant in `ControllerLeaseManager.acquire`: an unexpired lease of the SAME controllerId
   * is answered with the id it was already granted. The manager took its lease under this very name
   * and its keeper renews it, so an acquire here comes back with the manager's own id.
   *
   * Let that lease lapse and the Host mints a NEW id here, the id the manager still holds goes stale,
   * and its next mutation is refused far away from the cause. So the id is remembered per Host
   * process - a Host that was restarted grants a new lease, legitimately - and a second id from the
   * same Host is called out where it happens rather than left to surface as a puzzling refusal.
   *
   * Never released either, for the reason `createRuntimeOverTheWire` gives: the manager is holding it.
   */
  private async acquireLease(): Promise<string> {
    const descriptor = this.readDescriptor()
    const lease = await SmokeSessionManager.op<ControllerLeaseResult>(
      descriptor,
      'controller.acquire',
      { controllerId: SmokeSessionManager.controllerIdConst },
    )
    const held = this.heldLease
    if (held !== null && held.hostInstanceId === descriptor.hostInstanceId
      && held.controllerLeaseId !== lease.controllerLeaseId)
      throw new Error('FAILED: the Host minted a second controller lease for '
        + `${SmokeSessionManager.controllerIdConst}, so the lease the manager holds has lapsed and `
        + 'the writer authority it thinks it has is stale')
    this.heldLease = {
      hostInstanceId: descriptor.hostInstanceId,
      controllerLeaseId: lease.controllerLeaseId,
    }
    return lease.controllerLeaseId
  }

  private async listRuntimes(): Promise<RuntimeListResult> {
    return SmokeSessionManager.op<RuntimeListResult>(this.readDescriptor(), 'runtime.list', {})
  }

  /** What the Host itself says about a runtime, which is where a generation can be read at all. */
  /**
   * How much a runtime has written, off the DIAGNOSTIC surface. `SessionInfo` carried this pair
   * until 2026-08-24 and does not any more: nothing drew it, and it moved on every poll, which
   * minted a revision and rebuilt the tree in every window over a screen nobody was touching.
   */
  private outputSeqOf(sessionId: string): number | null {
    return this.debugRowOf(sessionId)?.outputSeq ?? null
  }

  private lastOutputAtOf(sessionId: string): number | null {
    return this.debugRowOf(sessionId)?.lastOutputAt ?? null
  }

  private debugRowOf(sessionId: string): HostDebugRuntimeRow | undefined {
    return this.manager.debugStatus().runtimes
      .find((row) => row.runtimeSessionId === sessionId)
  }

  private async runtimeOf(runtimeSessionId: string): Promise<RuntimeSessionInfo> {
    const listed = await this.listRuntimes()
    const found = listed.sessions.find((session) =>
      session.runtimeSessionId === runtimeSessionId)
    if (!found) throw new Error(`FAILED: the Host has no runtime ${runtimeSessionId}`)
    return found
  }

  private spawnHost(): ChildProcess {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(SmokeSessionManager.repoRootConst, 'app-host', 'start.ts'),
        '--config-dir', this.configDir, '--channel', SmokeSessionManager.channelConst],
      {
        cwd: SmokeSessionManager.repoRootConst,
        env: { ...process.env, JAMAT_V3_LOCAL_STATE_DIR: this.stateRoot },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    )
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`  host! ${chunk}`))
    return child
  }

  private async killHost(): Promise<void> {
    const child = this.host
    this.host = null
    if (child === null || child.exitCode !== null) return
    child.kill()
    await this.waitUntil(() => child.exitCode !== null || child.signalCode !== null,
      'the Host process never exited')
  }

  /** Detach, then take the Host down with the runtimes it owns: this root is about to be deleted. */
  private async retire(): Promise<void> {
    await this.manager.stop()
    await this.killHost()
  }

  private async waitForDescriptor(): Promise<void> {
    const deadline = Date.now() + SmokeSessionManager.hostBootMillisecondsConst
    while (Date.now() < deadline) {
      if (existsSync(this.descriptorFile)) return
      await SmokeHarness.sleep(150)
    }
    throw new Error(`the Host never published ${this.descriptorFile}`)
  }

  private sessionOf(sessionId: string): SessionInfo | undefined {
    return this.manager.snapshot().sessions.find((session) => session.sessionId === sessionId)
  }

  private static async op<T>(
    descriptor: HostDescriptor,
    name: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/op/${name}`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${descriptor.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${name} answered ${response.status}: ${text}`)
    return JSON.parse(text) as T
  }

  private static valueOf<T>(result: SessionsOpResult<T>, operation: string): T {
    if (!result.ok)
      throw new Error(`FAILED: ${operation} refused with ${result.code}: ${result.detail}`)
    return result.value
  }


}

void SmokeSessionManager.run().catch((error: unknown) => SmokeRun.failed('smoke-session-manager', error))
