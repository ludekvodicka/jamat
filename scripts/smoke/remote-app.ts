import { CliClient, type CliEnvelope } from './cliClient.js'
import { SmokeHarness, SmokeRun } from './smokeHarness.js'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClientStatePaths } from '../../app-client-ui/app/clientState/clientStatePaths.js'
import { RemoteConnectionsManager } from '../../app-client-ui/app/remoteControl/remoteConnectionsManager.js'
import { RemoteControlInboundRegistry } from '../../app-client-ui/app/remoteControl/remoteControlInboundRegistry.js'
import {
  RemoteControlPairingManager,
  type RemoteControlPairingImportResult,
} from '../../app-client-ui/app/remoteControl/remoteControlPairingManager.js'
import { RemoteControlPeerServer } from '../../app-client-ui/app/remoteControl/remoteControlPeerServer.js'
import {
  RemoteInboundApprovalManager,
  type RemoteInboundApprovalRequest,
} from '../../app-client-ui/app/remoteControl/remoteInboundApprovalManager.js'
import { RemoteControlServer } from '../../app-client-ui/app/remoteControl/remoteControlServer.js'
import { RemoteControlSettingsSection } from '../../app-client-ui/app/remoteControl/remoteControlSettingsSection.js'
import { RemoteEndpointIdentityStore } from '../../app-client-ui/app/remoteControl/remoteEndpointIdentityStore.js'
import {
  RemotePeerListenerManager,
  type RemoteListenerApplyResult,
} from '../../app-client-ui/app/remoteControl/remotePeerListenerManager.js'
import {
  RemotePeerCredentialStore,
  type RemotePeerTrustedIdentity,
} from '../../app-client-ui/app/remoteControl/remotePeerCredentialStore.js'
import {
  RemoteProfileLifecycle,
  type RemoteProfileSaveResult,
} from '../../app-client-ui/app/remoteControl/remoteProfileLifecycle.js'
import type { RemoteControlListenerSettings } from '../../app-client-ui/shared/remoteControlSettings.js'
import { ConfigStore } from '../../lib-orchestrator/configStore/configStore.js'
import { HostDescriptorPaths } from '../../lib-orchestrator/hostClient/hostDescriptorPaths.js'
import {
  RemoteControl,
  type RemoteControlAgentsPort,
  type RemoteControlProjectsPort,
  type RemoteControlSessionsPort,
  type RemoteControlTabsPort,
  type RemoteControlTranscriptPort,
} from '../../lib-orchestrator/remoteControl/remoteControl.js'
import type {
  RemoteControlRequestUnion,
  RemoteControlResponse,
  RemoteControlStepResult,
  RemoteControlSystemIdentity,
  RemoteControlTabCommandDto,
  RemoteControlTabOpenFileDto,
} from '../../lib-orchestrator/remoteControl/remoteControlApi.types.js'
import { RemoteControlConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol.js'
import type {
  RemoteConnectionsSnapshot,
  RemoteInboundConnectionDto,
} from '../../lib-orchestrator/remoteControl/remoteConnectionsApi.types.js'
import type {
  RemoteControlPeerEndpoint,
  RemoteControlPeerIdentity,
  RemoteControlPeerPairingBundle,
  RemoteControlPeerProfile,
} from '../../lib-orchestrator/remoteControl/remoteControlPeerApi.types.js'
import { RemoteControlPairing } from '../../lib-orchestrator/remoteControl/remoteControlPairing.js'
import { RemoteControlPeerClient } from '../../lib-orchestrator/remoteControl/remoteControlPeerClient.js'
import { RemoteControlPeerKeys } from '../../lib-orchestrator/remoteControl/remoteControlPeerKeys.js'
import { RemoteControlPeerConst } from '../../lib-orchestrator/remoteControl/remoteControlPeerProtocol.js'
import {
  RemoteControlTerminal,
  type RemoteControlTerminalSessionPort,
} from '../../lib-orchestrator/remoteControl/remoteControlTerminal.js'
import { SessionManager } from '../../lib-orchestrator/sessionManager/sessionManager.js'
import type {
  SessionCreateSpec,
  SessionsOpResult,
  SessionsSnapshot,
  TerminalAttachResult,
  TerminalFrame,
} from '../../lib-orchestrator/sessionManager/sessionManagerApi.types.js'
import type {
  TerminalAttachOwner,
  TerminalInputResult,
  TerminalResizeResult,
} from '../../lib-orchestrator/sessionManager/terminals/terminalGateway.js'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore.js'

interface SmokeRuntimeIdentity {
  hostInstanceId: string
  runtimeSessionId: string
  generation: number
  pid: number
}

interface SmokeSidePaths {
  configDir: string
  configIdentity: string
  credentialsFile: string
  machineIdentityFile: string
  endpointIdentityFile: string
  pairingBundleFile: string
  snapshotsDirectory: string
  auditFile: string
}

class SmokeRemoteApp extends SmokeHarness {
  protected override get waitMilliseconds(): number {
    return SmokeRemoteApp.waitMillisecondsConst
  }

  private static readonly channelConst = 'development'
  private static readonly waitMillisecondsConst = 30_000
  private static readonly repoRootConst = join(import.meta.dirname, '..', '..')
  /**
   * How many further refusals prove a caller really did dial again after its answer, rather than
   * stopping. Three, because the backoff here is 50ms: a caller that went quiet reaches the wait's
   * deadline instead of this number, and says so.
   */
  private static readonly redialsAfterAnswerConst = 3

  private readonly controllerPaths: SmokeSidePaths
  private readonly targetPaths: SmokeSidePaths
  private readonly stateRoot: string
  private readonly workDir: string
  private readonly hostDescriptorFile: string
  private host: ChildProcess | null = null
  private controller: SmokeControllerApp | null = null
  private target: SmokeTargetApp | null = null
  private targetPort = 0
  private controllerPort = 0
  private readonly errors: string[] = []
  /**
   * The person at the target's dialog, and its clock. It outlives every `SmokeTargetApp` this run
   * builds, the same way `errors` does: a target restart composes a new approval manager over the
   * same trust file, and the questions asked before the restart are part of what this run proved.
   */
  private readonly approvals = new SmokeInboundApprovals()

  private constructor(private readonly root: string) {
    super()
    this.stateRoot = join(root, 'state')
    this.workDir = join(root, 'workspace')
    mkdirSync(this.workDir, { recursive: true })
    process.env.JAMAT_V3_LOCAL_STATE_DIR = this.stateRoot
    process.env.JAMAT_V3_HOST_STATE_DIR = join(this.stateRoot, 'host')
    this.controllerPaths = this.sidePaths('controller')
    this.targetPaths = this.sidePaths('target')
    this.hostDescriptorFile = HostDescriptorPaths.descriptorFile(
      this.targetPaths.configIdentity,
      SmokeRemoteApp.channelConst,
    )
  }

  static async run(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-remote-app-smoke-'))
    const smoke = new SmokeRemoteApp(root)
    try { await smoke.execute() }
    finally {
      await smoke.retire()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }

  private async execute(): Promise<void> {
    this.host = this.spawnHost()
    await this.checkWaiting(
      'CLI created a real session on the target computer',
      () => existsSync(this.hostDescriptorFile),
      `the target AppHost never published ${this.hostDescriptorFile}`,
    )
    this.target = new SmokeTargetApp(
      this.targetPaths,
      SmokeRemoteApp.repoRootConst,
      this.errors,
      this.approvals,
    )
    this.targetPort = await this.target.start(0)
    await this.waitUntil(
      () => this.requiredTarget().sessions.snapshot().host.presence === 'running',
      'the target AppClientUI composition never reached AppHost',
    )
    this.controller = new SmokeControllerApp(this.controllerPaths, this.errors)
    this.controllerPort = await this.controller.start(0)

    await this.proveTypedAddressPairing()
    await this.proveInboundApproval()

    const computers = CliClient.valueOf(
      await this.cli('remote', 'computers', 'list'),
      'remote.computers.list',
    )
    const listedComputers = CliClient.array(computers.computers, 'remote computers')
    this.check('CLI lists the paired target as connected', listedComputers.some((entry) => {
      const computer = CliClient.object(entry, 'remote computer')
      return computer.remoteEndpointId === this.requiredTarget().peerIdentity.remoteEndpointId
        && computer.status === 'connected'
    }))

    const sessionId = await this.createRemoteSession()
    await this.verifyRemoteStatusAndIsolation(sessionId)
    const localFrames = new SmokeTerminalFrames()
    const remoteFrames = new SmokeTerminalFrames()
    this.attachLocal('target-local-before-restarts', sessionId, localFrames)
    await this.attachRemote('controller-remote-before-restarts', sessionId, remoteFrames)
    await this.waitForWriters(localFrames, remoteFrames)
    await this.verifyDualTerminal(sessionId, localFrames, remoteFrames)
    const before = this.runtimeIdentity()

    await this.restartController()
    this.checkRuntimeIdentity('controller AppClientUI restart', before)
    const controllerRestartFrames = new SmokeTerminalFrames()
    await this.attachRemote('controller-remote-after-controller-restart', sessionId,
      controllerRestartFrames)
    await this.waitUntil(
      () => controllerRestartFrames.writer,
      'the remote terminal did not become writable after the controller restart',
    )
    this.check('the controller reattached to the existing target runtime',
      controllerRestartFrames.runtimeSessionId === before.runtimeSessionId)

    await this.restartTarget(sessionId, controllerRestartFrames)
    this.checkRuntimeIdentity('target AppClientUI restart', before)
    const targetRestartFrames = new SmokeTerminalFrames()
    this.attachLocal('target-local-after-target-restart', sessionId, targetRestartFrames)
    await this.waitUntil(
      () => targetRestartFrames.writer,
      'the local target terminal did not become writable after the target restart',
    )
    await this.writeAndObserve(
      'echo smoke-after-target-restart',
      'smoke-after-target-restart',
      targetRestartFrames,
      controllerRestartFrames,
      () => this.requiredController().terminalInput(
        'controller-remote-after-controller-restart',
        'echo smoke-after-target-restart\r',
      ),
    )

    await this.verifyCliTerminal(sessionId)
    await this.finalizeRemoteSession(sessionId)
    await this.proveModelSelection()
    await this.proveReplayedCreate()
    await this.proveListenerRebind()
    await this.proveKeyMismatch()
    await this.proveRevokeAndReadmit()
    await this.proveForget()
    this.check('the real AppHost process remained alive until explicit smoke cleanup',
      this.host?.exitCode === null && this.host?.signalCode === null)
    this.check(`both app compositions reported no errors (${this.errors.join(' | ')})`,
      this.errors.length === 0)
    console.log(`\nsmoke-remote-app: ${this.passed} checks passed`)
  }

  /**
   * The half of the ceremony that needs no copy-paste: a person types an address and nothing else.
   * The probe asks whatever answers there for the same public bundle a paste would have carried, so
   * what gets pinned is whatever answered - which is exactly why the second check reads the pinned
   * fingerprint back against the computer that really did.
   */
  private async proveTypedAddressPairing(): Promise<void> {
    const target = this.requiredTarget().peerIdentity
    const paired = await this.requiredController().pairFromAddress({
      host: '127.0.0.1',
      port: this.targetPort,
    })
    this.check('typing host:port alone pairs the computer that answered there', paired.ok)
    this.check('the typed address pinned the key that computer really holds',
      this.requiredController().pinnedFingerprintOf(target.remoteEndpointId)
      === target.signing.fingerprint)
  }

  /**
   * The target half of the ceremony, over two real listeners: a caller nobody pinned is refused, a
   * person is asked about it by name, fingerprint and calling address, and the brakes on that
   * question are proved one at a time.
   *
   * Nothing waits on the wire while the question stands. The dial that raised it was already
   * refused, so what makes an answer take effect is the caller's own backoff coming round again -
   * which is why every step here is a wait rather than a return value.
   */
  private async proveInboundApproval(): Promise<void> {
    const controller = this.requiredController().peerIdentity
    await this.waitUntil(
      () => this.approvals.count === 1,
      'the target never asked about the unknown computer dialling it',
    )
    const raised = this.approvals.at(0)
    this.check('an unknown caller is refused and raises one approval naming it and where it called from',
      raised?.remoteComputerId === controller.remoteComputerId
      && raised?.remoteEndpointId === controller.remoteEndpointId
      && raised?.fingerprint === controller.signing.fingerprint
      && (raised?.remoteAddress.length ?? 0) > 0)
    this.check('while nobody has answered, no inbound connection exists',
      this.requiredTarget().inboundSnapshot().length === 0)
    this.takeRefusals('every report while the caller was unknown was the handshake refusal')

    const stranger = new SmokeStranger({
      remoteComputerId: 'remote-app-smoke-stranger-computer',
      remoteEndpointId: 'remote-app-smoke-stranger-endpoint',
      displayName: 'Remote app smoke stranger',
    }, this.errors)
    const strangerGotIn = await stranger.dial(this.targetIdentity(), this.targetEndpoint())
    this.check('a second unknown caller while one prompt stands raises nothing',
      !strangerGotIn && this.approvals.count === 1)
    this.takeRefusals('the second unknown caller was turned away on the wire instead')

    this.approvals.answer(false)
    await this.waitUntil(
      () => this.errors.length >= SmokeRemoteApp.redialsAfterAnswerConst,
      'the denied computer stopped dialling instead of being turned away again',
    )
    this.check('Deny writes no trust', !this.requiredTarget().trustsInbound(controller))
    this.check('a denied caller redialling inside the window raises no second prompt',
      this.approvals.count === 1)

    this.approvals.advance(RemoteInboundApprovalManager.denySuppressionMillisecondsConst)
    await this.waitUntil(
      () => this.approvals.count === 2,
      'the target never asked again once the deny window had passed',
    )
    this.approvals.answer(true)
    await this.checkWaiting(
      'Allow lets the very next dial in',
      () => this.requiredTarget().inboundSnapshot().length === 1,
      'the allowed computer never completed a handshake',
    )
    await this.waitForControllerConnection()
    this.takeRefusals('every report while the caller was refused was that refusal')
    this.check('the target holds no profile of the computer that controls it',
      !this.requiredTarget().hasProfile(controller.remoteEndpointId))
    this.check('the controlling computer\'s own listener was never dialled back',
      this.requiredController().inboundConnections === 0
      && this.requiredController().unknownCallers === 0
      && this.requiredController().connected)
  }

  /**
   * The model feature end to end: the capability that gates it, the offer it is composed from, and a
   * create carrying the chosen one. The create names a `resume` with nothing to resume, so the target
   * refuses it in the session manager's own first line - which is what proves the body got past the
   * exact-keys validator and reached the manager, without an agent binary being started for it.
   */
  private async proveModelSelection(): Promise<void> {
    const endpointId = this.requiredTarget().peerIdentity.remoteEndpointId
    await this.checkWaiting(
      'the target advertises agents.describe to the computer that controls it',
      () => this.requiredController().optionalOperationsOf(endpointId).includes('agents.describe'),
      'the controller never stored agents.describe from the target hello',
    )
    // No operationId: a read may not carry one, and the far side refuses the whole request over it.
    const described = await this.requiredController().execute(endpointId, {
      protocol: RemoteControlConst.protocol,
      requestId: randomUUID(),
      operation: 'agents.describe',
      body: {},
    })
    if (!described.ok)
      throw new Error(`FAILED: agents.describe was refused: ${described.error.detail}`)
    const agents = CliClient.array(
      CliClient.object(described.value, 'agents.describe value').agents,
      'described agents',
    ).map((entry) => CliClient.object(entry, 'described agent'))
    this.check('agents.describe answers with what the TARGET can start an agent on',
      agents.map((agent) => agent.agentId).join(',') === 'claude,codex'
      && agents[0]?.configuredModel === 'opus')

    const created = await this.requiredController().execute(endpointId, {
      protocol: RemoteControlConst.protocol,
      requestId: randomUUID(),
      operationId: 'remote-app-model-create',
      operation: 'sessions.create',
      body: {
        spec: {
          kind: 'agent',
          directory: { mode: 'adHoc', path: this.workDir },
          agent: { agentId: 'claude', mode: 'resume', model: 'claude-fable-5' },
          title: 'Remote app model smoke',
        },
      },
    })
    this.check('a create carrying a chosen model is not refused by the target request validator',
      !created.ok && created.error.code === 'operation-failed')
    this.check('the chosen model reached the target session manager unchanged',
      this.requiredTarget().lastRemoteCreateSpec()?.agent?.model === 'claude-fable-5')
  }

  /** Retrying a create the caller never heard the answer to must not be a second session. */
  private async proveReplayedCreate(): Promise<void> {
    const before = this.requiredTarget().sessions.snapshot().sessions.length
    const first = await this.replayedCreate()
    await this.waitUntil(
      () => this.requiredTarget().sessions.snapshot().sessions.some((candidate) =>
        candidate.sessionId === first),
      'the replayed create never reached the target session manager',
    )
    const second = await this.replayedCreate()
    this.check('a create replayed with the same operationId answers with the stored session',
      first === second)
    this.check('the replayed create started no second session on the target',
      this.requiredTarget().sessions.snapshot().sessions.length === before + 1)
  }

  private async replayedCreate(): Promise<string> {
    const created = CliClient.valueOf(await this.cli(
      'sessions',
      'create',
      '--computer',
      this.requiredTarget().peerIdentity.remoteEndpointId,
      '--directory',
      this.workDir,
      '--title',
      'Remote app replay',
      '--operation-id',
      'remote-app-replayed-create',
    ), 'sessions.create')
    return CliClient.text(
      CliClient.object(created.session, 'replayed session').sessionId,
      'replayed sessionId',
    )
  }

  /** Moving the port a computer is shared on, with nothing restarted and nothing re-paired by hand. */
  private async proveListenerRebind(): Promise<void> {
    const previousPort = this.targetPort
    const applied = await this.requiredTarget().rebindListener(0)
    if (!applied.ok)
      throw new Error(`FAILED: the target listener refused to rebind: ${applied.detail}`)
    this.targetPort = this.requiredTarget().listeningPort()
    this.check('the target listener took a new port without its client being restarted',
      this.targetPort !== previousPort)
    await this.checkWaiting(
      'moving the listener drops what the old port was holding',
      () => !this.requiredController().connected,
      'the controller never noticed the listener move',
    )
    const imported = CliClient.valueOf(await this.cli(
      'remote',
      'pairing',
      'import',
      '--file',
      this.targetPaths.pairingBundleFile,
      '--operation-id',
      'remote-app-pairing-rebind',
    ), 'remote.pairing.import')
    this.check('the republished pairing bundle names the port that actually bound',
      CliClient.object(imported.endpoint, 'reimported endpoint').port === this.targetPort)
    await this.checkWaiting(
      'the paired computer reconnects to the port the listener moved to',
      () => this.requiredController().connected
        && this.requiredTarget().inboundSnapshot().length === 1,
      'the controller never reconnected to the rebound listener',
    )
  }

  /**
   * The one refusal that must never become a question. A computer this one has let in, dialling
   * under a key it does not hold, is an impersonation attempt: it is turned away like any stranger
   * and raises no dialog for anybody to be talked into answering.
   */
  private async proveKeyMismatch(): Promise<void> {
    const controller = this.requiredController().peerIdentity
    const raised = this.approvals.count
    const impostor = new SmokeStranger({
      remoteComputerId: controller.remoteComputerId,
      remoteEndpointId: controller.remoteEndpointId,
      displayName: controller.displayName,
    }, this.errors)
    const gotIn = await impostor.dial(this.targetIdentity(), this.targetEndpoint())
    this.check('a known id arriving under another key is refused with no prompt',
      !gotIn && this.approvals.count === raised)
    this.takeRefusals('the impersonated identity was reported as a plain handshake refusal')
  }

  /**
   * Taking access back, and giving it again. Revoke is the target's ONLY inbound removal now, so it
   * has to do the whole job: hang up what the trust was holding open, empty the Allowed-in row, and
   * leave the caller in the same silent refusal it started in. Getting back in takes the same
   * question as the first time, which is what makes a re-installed master repairable.
   */
  private async proveRevokeAndReadmit(): Promise<void> {
    const target = this.requiredTarget()
    const controller = this.requiredController().peerIdentity
    const raised = this.approvals.count
    target.revokeInbound(controller)
    await this.checkWaiting(
      'Revoke in the Allowed-in list hangs up what the trust was holding open',
      () => target.inboundSnapshot().length === 0,
      'the revoked peer kept its live inbound connection',
    )
    this.check('Revoke takes the row out of the Allowed-in list', target.allowedIn().length === 0)
    await this.checkWaiting(
      'the revoked computer is turned away when it dials again',
      () => this.errors.some((message) => message.includes('handshake refused')),
      'the revoked peer was never refused when it retried',
    )
    this.approvals.advance(RemoteInboundApprovalManager.promptIntervalMillisecondsConst)
    await this.waitUntil(
      () => this.approvals.count === raised + 1,
      'the target never asked about the revoked computer again',
    )
    this.approvals.answer(true)
    await this.checkWaiting(
      'a fresh prompt re-admits the revoked computer',
      () => target.inboundSnapshot().length === 1,
      'the re-admitted computer never got back in',
    )
    this.takeRefusals('every report between the revoke and the new answer was that refusal')
  }

  /**
   * Unpairing at the MASTER, which is the only side that holds a profile now: it removes that
   * profile and nothing else. What the other computer allowed in is the other computer's, so its
   * Allowed-in row is still there afterwards - two rights, two owners, one of them untouched.
   */
  private async proveForget(): Promise<void> {
    const master = this.requiredController()
    const target = this.requiredTarget()
    const targetEndpointId = target.peerIdentity.remoteEndpointId
    this.check('the controlling computer forgets the computer it was controlling',
      master.forget(master.profileIdOf(targetEndpointId)).ok)
    this.check('forgetting takes the profile with it', !master.hasProfile(targetEndpointId))
    await this.checkWaiting(
      'forgetting hangs up the connection that profile was holding open',
      () => target.inboundSnapshot().length === 0,
      'the forgotten computer kept its live connection',
    )
    this.check('forgetting at the master leaves the Allowed-in row over there alone',
      target.trustsInbound(master.peerIdentity) && target.allowedIn().length === 1)
    // Nothing is paired any more, so the controller has nothing left to dial. It is stopped here
    // rather than left running, so that the run's last check still means "nothing ELSE".
    await master.stop()
    this.controller = null
  }

  private targetIdentity(): RemoteControlPeerIdentity {
    return this.requiredTarget().peerIdentity
  }

  private targetEndpoint(): RemoteControlPeerEndpoint {
    return { host: '127.0.0.1', port: this.targetPort }
  }

  /**
   * A caller that is not trusted retries and is turned away every time, so those reports are part
   * of what is being proved rather than a fault. Taking them by name is what keeps the run's last
   * check - that nothing else was reported - worth anything.
   */
  private takeRefusals(description: string): void {
    const taken = this.errors.splice(0)
    this.check(`${description} (${taken.length})`,
      taken.length > 0 && taken.every((message) => message.includes('handshake refused')))
  }

  private async createRemoteSession(): Promise<string> {
    const created = CliClient.valueOf(await this.cli(
      'sessions',
      'create',
      '--computer',
      this.requiredTarget().peerIdentity.remoteEndpointId,
      '--directory',
      this.workDir,
      '--title',
      'Remote app smoke',
      '--operation-id',
      'remote-app-session-create',
    ), 'sessions.create')
    const session = CliClient.object(created.session, 'created remote session')
    const sessionId = CliClient.text(session.sessionId, 'created remote sessionId')
    await this.waitUntil(
      () => this.requiredTarget().sessions.snapshot().sessions.some((candidate) =>
        candidate.sessionId === sessionId && candidate.life === 'live'),
      'the remotely created session never went live in target AppHost',
    )
    return sessionId
  }

  private async verifyRemoteStatusAndIsolation(sessionId: string): Promise<void> {
    const targetSelector = this.requiredTarget().peerIdentity.remoteEndpointId
    const status = CliClient.valueOf(
      await this.cli('status', '--computer', targetSelector),
      'system.status',
    )
    const sessionsStatus = CliClient.object(status.sessions, 'remote status sessions')
    const host = CliClient.object(sessionsStatus.host, 'remote status host')
    this.check('CLI status reaches the target AppHost through both AppClientUI instances',
      host.presence === 'running' && sessionsStatus.count === 1)

    const listed = CliClient.valueOf(
      await this.cli('sessions', 'list', '--computer', targetSelector),
      'sessions.list',
    )
    const sessions = CliClient.array(listed.sessions, 'remote sessions')
    this.check('remote session listing contains target-local sessions only',
      sessions.length === 1
      && CliClient.object(sessions[0], 'remote session').sessionId === sessionId)
    await this.checkWaiting(
      'the target records the controller under Remote connections',
      () => this.requiredTarget().inboundSnapshot().length === 1,
      'the target did not expose the inbound controller connection',
    )
  }

  private async verifyDualTerminal(
    sessionId: string,
    localFrames: SmokeTerminalFrames,
    remoteFrames: SmokeTerminalFrames,
  ): Promise<void> {
    await this.checkWaiting(
      'the target Remote connections snapshot names the attached session',
      () => this.requiredTarget().inboundSnapshot()[0]?.activeSessionIds.includes(sessionId) === true,
      'the target did not record the remote terminal attachment',
    )
    const remoteResize = await this.requiredController().terminalResize(
      'controller-remote-before-restarts',
      90,
      25,
    )
    const remoteResizeValue = remoteResize.ok
      ? CliClient.object(remoteResize.value, 'remote resize result')
      : null
    this.check('a remote resize yields to an active local terminal',
      remoteResizeValue?.applied === false)
    this.check('the active local terminal owns geometry',
      this.requiredTarget().sessions.terminalResize(
        'target-local-before-restarts',
        110,
        31,
      ).kind === 'applied')
    await this.writeAndObserve(
      'echo smoke-local-writer',
      'smoke-local-writer',
      localFrames,
      remoteFrames,
      () => Promise.resolve(this.requiredTarget().sessions.terminalInput(
        'target-local-before-restarts',
        'echo smoke-local-writer\r',
      )),
    )
    await this.writeAndObserve(
      'echo smoke-remote-writer',
      'smoke-remote-writer',
      localFrames,
      remoteFrames,
      () => this.requiredController().terminalInput(
        'controller-remote-before-restarts',
        'echo smoke-remote-writer\r',
      ),
    )
    this.check('local and remote terminals can both read and write one PTY',
      localFrames.contains('smoke-local-writer') && remoteFrames.contains('smoke-remote-writer'))
  }

  private async restartController(): Promise<void> {
    await this.requiredController().stop()
    this.controller = new SmokeControllerApp(this.controllerPaths, this.errors)
    const restartedPort = await this.controller.start(this.controllerPort)
    this.check('the controller AppClientUI listener restarted on its own bound port',
      restartedPort === this.controllerPort)
    await this.waitForControllerConnection()
    const status = CliClient.valueOf(await this.cli(
      'status',
      '--computer',
      this.requiredTarget().peerIdentity.remoteEndpointId,
    ), 'system.status')
    this.check('CLI rediscovered the restarted controller AppClientUI',
      CliClient.object(status.sessions, 'status sessions').count === 1)
  }

  private async restartTarget(
    sessionId: string,
    remoteFrames: SmokeTerminalFrames,
  ): Promise<void> {
    const attachCount = remoteFrames.attachedCount
    await this.requiredTarget().stop()
    this.target = new SmokeTargetApp(
      this.targetPaths,
      SmokeRemoteApp.repoRootConst,
      this.errors,
      this.approvals,
    )
    const restartedPort = await this.target.start(this.targetPort)
    this.check('the target AppClientUI listener restarted on its paired endpoint',
      restartedPort === this.targetPort)
    await this.checkWaiting(
      'the live remote terminal reattached after target AppClientUI restart',
      () => this.requiredTarget().sessions.snapshot().host.presence === 'running',
      'the restarted target AppClientUI never reached AppHost',
    )
    await this.waitUntil(
      () => this.requiredController().connected
        && remoteFrames.attachedCount > attachCount
        && this.requiredTarget().inboundSnapshot()[0]?.activeSessionIds.includes(sessionId) === true,
      'the controller did not reconnect and reattach after target AppClientUI restart',
    )
  }

  private async verifyCliTerminal(sessionId: string): Promise<void> {
    const selector = this.requiredTarget().peerIdentity.remoteEndpointId
    const sent = CliClient.valueOf(await this.cli(
      'terminal',
      'send',
      '--computer',
      selector,
      '--session-id',
      sessionId,
      '--text',
      'echo smoke-cli-remote',
      '--enter',
      '--operation-id',
      'remote-app-terminal-send',
    ), 'terminal.send')
    this.check('CLI terminal send writes through the controller to the target PTY',
      sent.accepted === true)
    let peeked = false
    await this.waitUntilAsync(async () => {
      const answer = CliClient.valueOf(await this.cli(
        'terminal',
        'peek',
        '--computer',
        selector,
        '--session-id',
        sessionId,
      ), 'terminal.peek')
      const snapshot = CliClient.object(answer.snapshot, 'remote terminal snapshot')
      const projection = CliClient.object(snapshot.projection, 'remote terminal projection')
      peeked = answer.terminalOutputUntrusted === true && projection.screen !== undefined
        && String(projection.screen).includes('smoke-cli-remote')
      return peeked
    }, 'CLI terminal peek did not see the command sent through the remote computer')
    this.check('CLI terminal peek reads the target PTY and marks its output untrusted', peeked)
  }

  private async finalizeRemoteSession(sessionId: string): Promise<void> {
    await this.cli(
      'sessions',
      'finalize',
      '--computer',
      this.requiredTarget().peerIdentity.remoteEndpointId,
      '--session-id',
      sessionId,
      '--operation-id',
      'remote-app-session-finalize',
    )
    await this.checkWaiting(
      'CLI finalize stops the target runtime without stopping AppHost',
      () => this.requiredTarget().sessions.snapshot().sessions.some((session) =>
        session.sessionId === sessionId && session.life === 'ended'),
      'the remotely finalized session never ended',
    )
  }

  private attachLocal(
    attachId: string,
    sessionId: string,
    frames: SmokeTerminalFrames,
  ): void {
    const answer = this.requiredTarget().sessions.terminalAttach(
      attachId,
      { sessionId, size: { cols: 110, rows: 31 } },
      { source: 'local', onFrame: (frame) => frames.add(frame) },
    )
    if (!answer.ok) throw new Error(`FAILED: local terminal attach refused: ${answer.detail}`)
  }

  private async attachRemote(
    attachId: string,
    sessionId: string,
    frames: SmokeTerminalFrames,
  ): Promise<void> {
    const answer = await this.requiredController().attachTerminal(
      attachId,
      sessionId,
      frames,
    )
    if (!answer.ok) throw new Error(`FAILED: remote terminal attach refused: ${answer.error.detail}`)
  }

  private async waitForWriters(
    localFrames: SmokeTerminalFrames,
    remoteFrames: SmokeTerminalFrames,
  ): Promise<void> {
    await this.waitUntil(
      () => localFrames.writer && remoteFrames.writer,
      'local and remote terminal attaches did not both become writers',
    )
  }

  private async writeAndObserve(
    description: string,
    marker: string,
    first: SmokeTerminalFrames,
    second: SmokeTerminalFrames,
    write: () => Promise<unknown>,
  ): Promise<void> {
    const result = await write()
    const accepted = SmokeRemoteApp.writeAccepted(result)
    if (!accepted) throw new Error(`FAILED: ${description} was not accepted`)
    await this.waitUntil(
      () => first.contains(marker) && second.contains(marker),
      `${description} was not observed by both terminal attachments`,
    )
  }

  private runtimeIdentity(): SmokeRuntimeIdentity {
    const hostInstanceId = this.requiredTarget().sessions.snapshot().host.hostInstanceId
    const runtime = this.requiredTarget().sessions.debugStatus().runtimes.find((row) => row.alive)
    if (hostInstanceId === null || !runtime || runtime.pid === null)
      throw new Error('FAILED: target runtime identity is unavailable')
    return {
      hostInstanceId,
      runtimeSessionId: runtime.runtimeSessionId,
      generation: runtime.generation,
      pid: runtime.pid,
    }
  }

  private checkRuntimeIdentity(label: string, expected: SmokeRuntimeIdentity): void {
    const actual = this.runtimeIdentity()
    this.check(`${label} preserved the AppHost process and PTY runtime`,
      JSON.stringify(actual) === JSON.stringify(expected))
  }

  private async waitForControllerConnection(): Promise<void> {
    await this.waitUntil(
      () => this.requiredController().connected,
      'the controller AppClientUI did not connect to the target AppClientUI',
    )
  }

  private sidePaths(name: 'controller' | 'target'): SmokeSidePaths {
    const configDir = join(this.root, `${name}-config`)
    const configIdentity = ConfigIdentityStore
      .loadOrCreate(configDir, SmokeRemoteApp.channelConst)
      .configIdentity
    const sideRoot = join(this.root, `${name}-machine`)
    const appState = join(sideRoot, 'client-ui', configIdentity, SmokeRemoteApp.channelConst)
    return {
      configDir,
      configIdentity,
      credentialsFile: join(sideRoot, 'peer-credentials.json'),
      machineIdentityFile: join(sideRoot, 'machine-identity.json'),
      endpointIdentityFile: join(appState, 'remote-endpoint.json'),
      pairingBundleFile: join(appState, 'remote-pairing.json'),
      snapshotsDirectory: join(appState, 'snapshots'),
      auditFile: join(appState, 'remote-control-audit.jsonl'),
    }
  }

  /** The shipped wrapper, run as a child: what an agent actually executes. */
  private cli(...args: string[]): Promise<CliEnvelope> {
    return new CliClient({
      configDir: this.controllerPaths.configDir,
      channel: SmokeRemoteApp.channelConst,
      cwd: this.workDir,
      stateRoot: this.stateRoot,
      timeoutMilliseconds: SmokeRemoteApp.waitMillisecondsConst,
    }).run(...args)
  }

  private spawnHost(): ChildProcess {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        join(SmokeRemoteApp.repoRootConst, 'app-host', 'start.ts'),
        '--config-dir',
        this.targetPaths.configDir,
        '--channel',
        SmokeRemoteApp.channelConst,
      ],
      {
        cwd: SmokeRemoteApp.repoRootConst,
        env: { ...process.env, JAMAT_V3_LOCAL_STATE_DIR: this.stateRoot },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    )
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`  host! ${chunk}`))
    return child
  }

  private async retire(): Promise<void> {
    try { await this.controller?.stop() } catch {}
    this.controller = null
    try { await this.target?.stop() } catch {}
    this.target = null
    const child = this.host
    this.host = null
    if (child === null || child.exitCode !== null) return
    child.kill()
    await this.waitUntil(
      () => child.exitCode !== null || child.signalCode !== null,
      'the smoke AppHost process never exited',
    )
  }

  private requiredController(): SmokeControllerApp {
    if (this.controller === null) throw new Error('FAILED: controller AppClientUI is unavailable')
    return this.controller
  }

  private requiredTarget(): SmokeTargetApp {
    if (this.target === null) throw new Error('FAILED: target AppClientUI is unavailable')
    return this.target
  }

  /**
   * A wait IS an assertion: it throws when the condition never holds. Recording it as a check line
   * is what makes the run read as the list of things it proved, rather than as `check(text, true)`
   * sitting next to a wait somebody has to notice.
   */
  /** The same pair as the base's, and it names its own failure: these run over a wire. */
  private async checkWaiting(
    description: string,
    condition: () => boolean,
    failure: string,
  ): Promise<void> {
    await this.waitUntil(condition, failure)
    this.check(description, true)
  }


  private static writeAccepted(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false
    if ('kind' in value) return value.kind === 'sent'
    if ('ok' in value && value.ok === true && 'value' in value)
      return typeof value.value === 'object'
        && value.value !== null
        && 'accepted' in value.value
        && value.value.accepted === true
    return false
  }

}

class SmokeTargetApp {
  readonly sessions: SessionManager
  readonly peerIdentity: RemoteControlPeerIdentity
  private readonly config: ConfigStore
  private readonly credentials: RemotePeerCredentialStore
  private readonly remoteSessions: SmokeSessionsObserver
  private readonly pairing: RemoteControlPairingManager
  private readonly inbound: RemoteControlInboundRegistry
  private readonly connections: RemoteConnectionsManager
  private readonly listener: RemotePeerListenerManager
  private readonly approval: RemoteInboundApprovalManager

  constructor(
    paths: SmokeSidePaths,
    applicationRoot: string,
    private readonly errors: string[],
    approvals: SmokeInboundApprovals,
  ) {
    const config = ConfigStore.load(paths.configDir, {
      snapshotsDirectory: paths.snapshotsDirectory,
      report: (message) => this.errors.push(message),
    })
    this.config = config
    this.credentials = RemotePeerCredentialStore.loadOrCreate(
      paths.credentialsFile,
      paths.machineIdentityFile,
      {
        computerId: () => 'remote-app-smoke-target-computer',
        displayName: () => 'Remote app smoke target',
      },
    )
    this.peerIdentity = RemoteEndpointIdentityStore.loadOrCreate(
      paths.endpointIdentityFile,
      this.credentials.machineIdentity(),
      paths.configIdentity,
      'development',
      () => 'remote-app-smoke-target-endpoint',
    ).identity(this.credentials.machineIdentity())
    let inbound: RemoteControlInboundRegistry | null = null
    this.sessions = new SessionManager({
      applicationRoot,
      resourcesRoot: null,
      configDir: paths.configDir,
      configIdentity: paths.configIdentity,
      channel: 'development',
      autoStartHost: false,
      controllerId: 'remote-app-smoke-target-controller',
      onChanged: () => inbound?.publishEvent('sessions.changed'),
      onError: (message) => this.errors.push(message),
    })
    const terminal = new RemoteControlTerminal(this.sessions, {
      onError: (message) => this.errors.push(message),
    })
    const identity = SmokeRemoteAppPorts.system(paths.configIdentity, 'target')
    this.remoteSessions = new SmokeSessionsObserver(this.sessions)
    const control = new RemoteControl({
      system: { identity: () => identity },
      projects: SmokeRemoteAppPorts.projects(),
      sessions: this.remoteSessions,
      tabs: SmokeRemoteAppPorts.tabs(),
      terminal,
      transcript: SmokeRemoteAppPorts.transcript(),
      agents: SmokeRemoteAppPorts.agents(),
      onError: (message) => this.errors.push(message),
    })
    /*
     * On this side the pairing manager publishes and serves the PUBLIC bundle and never imports
     * one: under one-way pairing the computer being controlled holds no profile of its controller.
     * The confirm callback is what a person would answer if it ever did.
     */
    this.pairing = new RemoteControlPairingManager(
      config,
      this.credentials,
      this.peerIdentity,
      paths.pairingBundleFile,
      () => Promise.resolve(true),
    )
    this.inbound = new RemoteControlInboundRegistry({
      control,
      terminal,
      auditFile: paths.auditFile,
      onChanged: () => undefined,
      onError: (message) => this.errors.push(message),
    })
    inbound = this.inbound
    /*
     * The REAL approval manager, with the smoke standing in for the person at the dialog. It is the
     * only writer of inbound trust on this computer, so composing a fake here would leave the whole
     * ceremony untested; what the smoke replaces is the window, never the decision around it.
     */
    this.approval = new RemoteInboundApprovalManager({
      credentials: this.credentials,
      confirm: (request) => approvals.confirm(request),
      onChanged: () => undefined,
      onError: (message) => this.errors.push(message),
      now: () => approvals.now(),
    })
    /*
     * The shared computer holds a dialler of its own, and it is the point rather than scenery: it
     * COULD reach back if anything had paired it, and under one-way pairing nothing does. That is
     * what makes "the controlling computer's own listener was never dialled back" mean something.
     */
    const peerClient = new RemoteControlPeerClient(
      this.peerIdentity,
      (payload) => this.credentials.sign(payload),
      {
        connectTimeoutMilliseconds: 2_000,
        heartbeatIntervalMilliseconds: 250,
        heartbeatTimeoutMilliseconds: 2_000,
        onError: (message) => this.errors.push(message),
      },
    )
    this.connections = new RemoteConnectionsManager({
      identity: this.peerIdentity,
      profiles: () => config.readSection(RemoteControlSettingsSection.spec).profiles,
      connect: (profile) => peerClient.connect(profile),
      onChanged: () => undefined,
      onError: (message) => this.errors.push(message),
      reconnectDelay: () => 50,
    })
    this.listener = new RemotePeerListenerManager({
      serverFactory: () => new RemoteControlPeerServer({
        identity: this.peerIdentity,
        sign: (payload) => this.credentials.sign(payload),
        trustedInbound: (computerId, endpointId) =>
          this.credentials.trustedInbound(computerId, endpointId),
        onConnection: (connection) => this.inbound.add(connection),
        onUnknownPeer: (claimant, remoteAddress) =>
          this.approval.request(claimant, remoteAddress),
        pairingBundleText: () => {
          try { return JSON.stringify(this.pairing.bundle()) } catch { return null }
        },
        onError: (message) => this.errors.push(message),
      }),
      onBound: (advertisedHost, port) => { this.pairing.publish({ host: advertisedHost, port }) },
      onChanged: () => undefined,
    })
  }

  async start(port: number): Promise<number> {
    await this.sessions.start()
    const applied = await this.listener.apply(SmokeTargetApp.listenerSettings(port))
    if (!applied.ok)
      throw new Error(`FAILED: the target listener refused to bind: ${applied.detail}`)
    this.connections.start()
    this.connections.holdConnections('smoke')
    return this.listeningPort()
  }

  async stop(): Promise<void> {
    this.connections.stop()
    this.listener.beginStop()
    await this.listener.stop()
    this.inbound.stop()
    await this.sessions.stop()
  }

  rebindListener(port: number): Promise<RemoteListenerApplyResult> {
    return this.listener.apply(SmokeTargetApp.listenerSettings(port))
  }

  listeningPort(): number {
    const runtime = this.listener.runtime()
    if (runtime.status !== 'listening')
      throw new Error(`FAILED: the target listener is ${runtime.status}, not listening`)
    return runtime.actualPort
  }

  /** What the Allowed-in list's Revoke does: the socket first, because trust is read at connect. */
  revokeInbound(identity: RemoteControlPeerIdentity): void {
    this.inbound.closeEndpoint(identity.remoteComputerId, identity.remoteEndpointId)
    this.credentials.revokeInbound(identity.remoteComputerId, identity.remoteEndpointId)
  }

  /** The Allowed-in list itself: every computer a person let in here, and nothing secret. */
  allowedIn(): readonly RemotePeerTrustedIdentity[] {
    return this.credentials.inboundPeers()
  }

  hasProfile(remoteEndpointId: string): boolean {
    return this.profiles().some((candidate) => candidate.remoteEndpointId === remoteEndpointId)
  }

  trustsInbound(identity: RemoteControlPeerIdentity): boolean {
    return this.credentials.trustedInbound(
      identity.remoteComputerId,
      identity.remoteEndpointId,
    ) !== null
  }

  lastRemoteCreateSpec(): SessionCreateSpec | null {
    return this.remoteSessions.lastCreateSpec
  }

  inboundSnapshot(): readonly RemoteInboundConnectionDto[] {
    return this.inbound.snapshot()
  }

  private profiles(): readonly RemoteControlPeerProfile[] {
    return this.config.readSection(RemoteControlSettingsSection.spec).profiles
  }

  private static listenerSettings(port: number): RemoteControlListenerSettings {
    return { enabled: true, bindHost: '127.0.0.1', port, advertisedHost: '127.0.0.1' }
  }
}

/**
 * The target's real session manager with one thing written down: the spec the last remote create
 * carried. Nothing is answered here - every call goes straight through - and the twenty checks
 * around it are what prove that, so what it reports is what actually arrived over the socket.
 */
class SmokeSessionsObserver implements RemoteControlSessionsPort {
  private createSpec: SessionCreateSpec | null = null

  constructor(private readonly sessions: RemoteControlSessionsPort) {}

  get lastCreateSpec(): SessionCreateSpec | null {
    return this.createSpec
  }

  snapshot(): SessionsSnapshot {
    return this.sessions.snapshot()
  }

  createSession(
    spec: SessionCreateSpec,
  ): Promise<SessionsOpResult<{ sessionId: string; tabTitle: string }>> {
    this.createSpec = structuredClone(spec)
    return this.sessions.createSession(spec)
  }

  reopenSession(sessionId: string): Promise<SessionsOpResult> {
    return this.sessions.reopenSession(sessionId)
  }

  finalizeSession(sessionId: string): Promise<SessionsOpResult> {
    return this.sessions.finalizeSession(sessionId)
  }

  discardPlainSession(sessionId: string): Promise<SessionsOpResult> {
    return this.sessions.discardPlainSession(sessionId)
  }
}

class SmokeControllerApp {
  readonly peerIdentity: RemoteControlPeerIdentity
  private readonly config: ConfigStore
  private readonly connections: RemoteConnectionsManager
  private readonly server: RemoteControlServer
  private readonly peerServer: RemoteControlPeerServer
  private readonly pairing: RemoteControlPairingManager
  private readonly lifecycle: RemoteProfileLifecycle
  private inboundDials = 0
  private unknownDials = 0

  constructor(paths: SmokeSidePaths, private readonly errors: string[]) {
    const config = ConfigStore.load(paths.configDir, {
      snapshotsDirectory: paths.snapshotsDirectory,
      report: (message) => this.errors.push(message),
    })
    this.config = config
    const credentials = RemotePeerCredentialStore.loadOrCreate(
      paths.credentialsFile,
      paths.machineIdentityFile,
      {
        computerId: () => 'remote-app-smoke-controller-computer',
        displayName: () => 'Remote app smoke controller',
      },
    )
    this.peerIdentity = RemoteEndpointIdentityStore.loadOrCreate(
      paths.endpointIdentityFile,
      credentials.machineIdentity(),
      paths.configIdentity,
      'development',
      () => 'remote-app-smoke-controller-endpoint',
    ).identity(credentials.machineIdentity())
    this.pairing = new RemoteControlPairingManager(
      config,
      credentials,
      this.peerIdentity,
      paths.pairingBundleFile,
      // The smoke stands in for the person at the dialog: it drives pairing deliberately, which is
      // exactly the answer the dialog exists to require.
      () => Promise.resolve(true),
    )
    /*
     * A real listener on the controlling side, and it is the point rather than scenery: this machine
     * is reachable, so "one-way" has to be a fact about what the other side holds rather than about
     * there being nowhere to dial. Both counters must stay at zero: nothing completed a handshake
     * in here, and nothing even knocked.
     */
    this.peerServer = new RemoteControlPeerServer({
      identity: this.peerIdentity,
      sign: (payload) => credentials.sign(payload),
      trustedInbound: (computerId, endpointId) =>
        credentials.trustedInbound(computerId, endpointId),
      onConnection: (connection) => {
        this.inboundDials += 1
        connection.close()
      },
      onUnknownPeer: () => { this.unknownDials += 1 },
      pairingBundleText: () => {
        try { return JSON.stringify(this.pairing.bundle()) } catch { return null }
      },
      onError: (message) => this.errors.push(message),
    })
    const peerClient = new RemoteControlPeerClient(
      this.peerIdentity,
      (payload) => credentials.sign(payload),
      {
        connectTimeoutMilliseconds: 2_000,
        heartbeatIntervalMilliseconds: 250,
        heartbeatTimeoutMilliseconds: 2_000,
        onError: (message) => this.errors.push(message),
      },
    )
    this.connections = new RemoteConnectionsManager({
      identity: this.peerIdentity,
      profiles: () => config.readSection(RemoteControlSettingsSection.spec).profiles,
      connect: (profile) => peerClient.connect(profile),
      onChanged: () => undefined,
      onError: (message) => this.errors.push(message),
      reconnectDelay: () => 50,
    })
    const unavailableSessions = new SmokeUnavailableSessions()
    const terminal = new RemoteControlTerminal(unavailableSessions, {
      onError: (message) => this.errors.push(message),
    })
    const identity = SmokeRemoteAppPorts.system(paths.configIdentity, 'controller')
    const control = new RemoteControl({
      system: { identity: () => identity },
      projects: SmokeRemoteAppPorts.projects(),
      sessions: unavailableSessions,
      tabs: SmokeRemoteAppPorts.tabs(),
      terminal,
      transcript: SmokeRemoteAppPorts.transcript(),
      agents: SmokeRemoteAppPorts.agents(),
      onError: (message) => this.errors.push(message),
    })
    this.server = new RemoteControlServer({
      identity,
      control,
      terminal,
      descriptorFile: ClientStatePaths.controlInstanceDescriptorFile(
        paths.configIdentity,
        'development',
        identity.instanceId,
        identity.startedAt,
      ),
      compatibilityDescriptorFile: ClientStatePaths.controlDescriptorFile(
        paths.configIdentity,
        'development',
      ),
      auditFile: paths.auditFile,
      onError: (message) => this.errors.push(message),
      local: {
        snapshot: () => this.snapshot(),
        execute: (endpointId, request) => this.connections.execute(endpointId, request),
        pairingBundle: () => this.pairing.bundle(),
        importPairing: (bundle) => this.importPairing(bundle),
      },
    })
    this.lifecycle = new RemoteProfileLifecycle({
      configStore: config,
      connections: this.connections,
    })
  }

  get connected(): boolean {
    return this.connections.snapshot().outbound.some((entry) => entry.status === 'connected')
  }

  /** How many peers ever completed a handshake INTO this computer. The one-way check reads it. */
  get inboundConnections(): number {
    return this.inboundDials
  }

  /** How many peers were ever refused at this computer's own door, which is the stricter half. */
  get unknownCallers(): number {
    return this.unknownDials
  }

  async start(port: number): Promise<number> {
    const address = await this.peerServer.start('127.0.0.1', port)
    this.pairing.publish(address)
    this.connections.start()
    // What a running app does while a window is on a screen that draws remote computers. Nothing is
    // dialled without it, so the smoke would prove a connection that a real client also would not
    // have made.
    this.connections.holdConnections('smoke')
    await this.server.start()
    return address.port
  }

  async stop(): Promise<void> {
    this.server.beginStop()
    this.peerServer.beginStop()
    this.connections.stop()
    await this.peerServer.stop()
    await this.server.stop()
  }

  /** The typed-address half of the ceremony: no bundle text anywhere, only `host:port`. */
  async pairFromAddress(
    endpoint: RemoteControlPeerEndpoint,
  ): Promise<RemoteControlPairingImportResult> {
    const imported = await this.pairing.importFromAddress(endpoint)
    if (imported.ok) this.connections.reloadProfiles()
    return imported
  }

  pinnedFingerprintOf(remoteEndpointId: string): string | null {
    return this.profiles().find((candidate) =>
      candidate.remoteEndpointId === remoteEndpointId)?.pinnedIdentity.fingerprint ?? null
  }

  profileIdOf(remoteEndpointId: string): string {
    const profile = this.profiles().find((candidate) =>
      candidate.remoteEndpointId === remoteEndpointId)
    if (!profile) throw new Error(`FAILED: the controller has no profile for ${remoteEndpointId}`)
    return profile.profileId
  }

  hasProfile(remoteEndpointId: string): boolean {
    return this.profiles().some((candidate) => candidate.remoteEndpointId === remoteEndpointId)
  }

  forget(profileId: string): RemoteProfileSaveResult {
    return this.lifecycle.forget(profileId)
  }

  optionalOperationsOf(remoteEndpointId: string): readonly string[] {
    return this.connections.snapshot().outbound.find((entry) =>
      entry.remoteEndpointId === remoteEndpointId)?.optionalOperations ?? []
  }

  execute(
    remoteEndpointId: string,
    request: RemoteControlRequestUnion,
  ): Promise<RemoteControlResponse> {
    return this.connections.execute(remoteEndpointId, request)
  }

  attachTerminal(
    attachId: string,
    sessionId: string,
    frames: SmokeTerminalFrames,
  ) {
    const endpoint = this.connectedEndpoint()
    return this.connections.attachTerminal(
      endpoint,
      attachId,
      { sessionId, size: { cols: 90, rows: 25 } },
      (frame) => frames.add(frame),
    )
  }

  terminalInput(attachId: string, data: string) {
    return this.connections.terminalInput(this.connectedEndpoint(), attachId, data)
  }

  terminalResize(attachId: string, cols: number, rows: number) {
    return this.connections.terminalResize(this.connectedEndpoint(), attachId, cols, rows)
  }

  private connectedEndpoint(): string {
    const endpoint = this.connections.snapshot().outbound.find((entry) =>
      entry.status === 'connected')
    if (!endpoint) throw new Error('FAILED: controller has no connected remote endpoint')
    return endpoint.remoteEndpointId
  }

  private profiles(): readonly RemoteControlPeerProfile[] {
    return this.config.readSection(RemoteControlSettingsSection.spec).profiles
  }

  private snapshot(): RemoteConnectionsSnapshot {
    const snapshot = this.connections.snapshot()
    return { revision: snapshot.revision, outbound: snapshot.outbound, inbound: [] }
  }

  private async importPairing(
    bundle: RemoteControlPeerPairingBundle,
  ): Promise<RemoteControlStepResult<RemoteControlPeerProfile>> {
    const imported = await this.pairing.import(bundle)
    if (imported.ok) {
      this.connections.reloadProfiles()
      return { ok: true, value: imported.value }
    } else if (imported.code === 'config-refused')
      return { ok: false, error: { code: 'operation-failed', detail: imported.detail } }
    else if (imported.code === 'invalid-bundle')
      return { ok: false, error: { code: 'invalid-request', detail: imported.detail } }
    else if (imported.code === 'identity-conflict')
      return { ok: false, error: { code: 'conflict', detail: imported.detail } }
    else if (imported.code === 'not-confirmed')
      return { ok: false, error: { code: 'forbidden', detail: imported.detail } }
    // Not reachable over the control API, which takes a bundle and never an address; named anyway,
    // because a code with no arm here would reach the CLI as a thrown sentence.
    else if (imported.code === 'probe-failed')
      return { ok: false, error: { code: 'unavailable', detail: imported.detail } }
    else
      throw new Error(`Unknown pairing import result: ${JSON.stringify(imported)}`)
  }
}

class SmokeUnavailableSessions implements RemoteControlSessionsPort, RemoteControlTerminalSessionPort {
  snapshot(): SessionsSnapshot {
    return {
      revision: 0,
      reconciled: true,
      host: {
        presence: 'unreachable',
        hostVersion: null,
        hostInstanceId: null,
        liveCount: 0,
        lastStartError: null,
      },
      categories: [],
      sessions: [],
      orphans: [],
    }
  }

  createSession(
    _spec: SessionCreateSpec,
  ): Promise<SessionsOpResult<{ sessionId: string; tabTitle: string }>> {
    return Promise.resolve(SmokeUnavailableSessions.refused())
  }

  reopenSession(_sessionId: string): Promise<SessionsOpResult> {
    return Promise.resolve(SmokeUnavailableSessions.refused())
  }

  finalizeSession(_sessionId: string): Promise<SessionsOpResult> {
    return Promise.resolve(SmokeUnavailableSessions.refused())
  }

  discardPlainSession(_sessionId: string): Promise<SessionsOpResult> {
    return Promise.resolve(SmokeUnavailableSessions.refused())
  }

  terminalAttach(
    _attachId: string,
    _spec: { sessionId: string; size: { cols: number; rows: number } | null },
    _owner: TerminalAttachOwner,
  ): TerminalAttachResult {
    return { ok: false, code: 'host-unreachable', detail: 'controller smoke has no local Host' }
  }

  terminalInput(_attachId: string, _data: string): TerminalInputResult {
    return { kind: 'unknown-attach' }
  }

  terminalResize(_attachId: string, _cols: number, _rows: number): TerminalResizeResult {
    return { kind: 'unknown-attach' }
  }

  terminalSetGeometryActive(_attachId: string, _active: boolean): TerminalResizeResult {
    return { kind: 'unknown-attach' }
  }

  terminalDetach(_attachId: string): void {}

  terminalDetachAll(_attachIds: readonly string[]): void {}

  private static refused<T>(): SessionsOpResult<T> {
    return { ok: false, code: 'not-found', detail: 'controller smoke has no local sessions' }
  }
}

/**
 * The person at the target's dialog, scripted, and the clock that dialog's brakes are measured on.
 *
 * Every question is kept and answered one at a time, deliberately: a prompt left standing IS the
 * state the single-pending brake exists for, so the smoke has to be able to hold one open while
 * another computer knocks. The clock is the approval manager's own `now` seam, because the deny
 * window is ten minutes and the prompt interval a minute, and a smoke that sat those out in real
 * time is a smoke nobody would run.
 */
class SmokeInboundApprovals {
  private readonly raised: RemoteInboundApprovalRequest[] = []
  private readonly waiting: ((allowed: boolean) => void)[] = []
  private skewMilliseconds = 0

  get count(): number {
    return this.raised.length
  }

  at(index: number): RemoteInboundApprovalRequest | undefined {
    return this.raised[index]
  }

  now(): number {
    return Date.now() + this.skewMilliseconds
  }

  advance(milliseconds: number): void {
    this.skewMilliseconds += milliseconds
  }

  confirm(request: RemoteInboundApprovalRequest): Promise<boolean> {
    this.raised.push(request)
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  answer(allowed: boolean): void {
    const resolve = this.waiting.shift()
    if (resolve === undefined)
      throw new Error('FAILED: no inbound approval is waiting for an answer')
    resolve(allowed)
  }
}

/**
 * A caller with an identity of its own and nothing else: no config, no stores, no listener. It is
 * the only thing in this run that is not one of the two applications, and it exists because two of
 * the brakes are about a computer that is NOT the controller - a stranger arriving while a question
 * stands, and the controller's own ids arriving under a key it does not hold.
 */
class SmokeStranger {
  readonly identity: RemoteControlPeerIdentity
  private readonly privateKey: string

  constructor(
    names: { remoteComputerId: string; remoteEndpointId: string; displayName: string },
    private readonly errors: string[],
  ) {
    const keyPair = RemoteControlPeerKeys.generateSigningKeyPair()
    this.privateKey = keyPair.privateKey
    this.identity = {
      remoteComputerId: names.remoteComputerId,
      remoteEndpointId: names.remoteEndpointId,
      configIdentity: 'remote-app-smoke-stranger-config',
      runtimeChannel: 'development',
      displayName: names.displayName,
      signing: {
        algorithm: RemoteControlPeerConst.signingAlgorithm,
        publicKey: keyPair.publicKey,
        fingerprint: RemoteControlPeerKeys.fingerprint(keyPair.publicKey),
      },
    }
  }

  /** Whether the handshake stood. In this run it never may, which is the whole of what it proves. */
  async dial(
    target: RemoteControlPeerIdentity,
    endpoint: RemoteControlPeerEndpoint,
  ): Promise<boolean> {
    const client = new RemoteControlPeerClient(
      this.identity,
      (payload) => RemoteControlPeerKeys.sign(this.privateKey, payload),
      {
        connectTimeoutMilliseconds: 2_000,
        onError: (message) => this.errors.push(message),
      },
    )
    const answer = await client.connect(
      RemoteControlPairing.profile(RemoteControlPairing.bundle(target, endpoint)),
    )
    if (!answer.ok) return false
    answer.value.close()
    return true
  }
}

class SmokeTerminalFrames {
  private readonly frames: TerminalFrame[] = []

  get writer(): boolean {
    return this.frames.some((frame) => frame.type === 'terminal.attached' && frame.writer)
  }

  get attachedCount(): number {
    return this.frames.filter((frame) => frame.type === 'terminal.attached').length
  }

  get runtimeSessionId(): string | null {
    const attached = [...this.frames].reverse().find((frame) => frame.type === 'terminal.attached')
    return attached?.type === 'terminal.attached' ? attached.session.runtimeSessionId : null
  }

  add(frame: TerminalFrame): void {
    this.frames.push(structuredClone(frame))
  }

  contains(marker: string): boolean {
    let output = ''
    for (const frame of this.frames) {
      if (frame.type === 'terminal.snapshot') output += frame.projection.screen
      else if (frame.type === 'terminal.data') output += frame.delta
      else if (frame.type === 'terminal.delta') output += frame.data
    }
    return output.includes(marker)
  }
}

class SmokeRemoteAppPorts {
  static system(configIdentity: string, side: string): RemoteControlSystemIdentity {
    return {
      configIdentity,
      runtimeChannel: 'development',
      instanceId: `${side}:${randomUUID()}`,
      startedAt: Date.now(),
      applicationVersion: 'smoke',
    }
  }

  static projects(): RemoteControlProjectsPort {
    return {
      listCategories: () => Promise.resolve([]),
      listProjects: () => Promise.resolve({
        ok: true,
        value: {
          entries: [],
          projects: [],
          virtualFolders: [],
          truncated: false,
          available: true,
        },
      }),
    }
  }

  static tabs(): RemoteControlTabsPort {
    return {
      list: () => Promise.resolve([]),
      open: (_sessionId, _tabTitle, _options) => Promise.resolve(
        SmokeRemoteAppPorts.tabRefusal(),
      ),
      openFile: (_sessionId, _tabTitle, _path, _options) => Promise.resolve(
        SmokeRemoteAppPorts.tabFileRefusal(),
      ),
      focus: (_panelId) => Promise.resolve(SmokeRemoteAppPorts.tabRefusal()),
      close: (_panelId) => Promise.resolve(SmokeRemoteAppPorts.tabRefusal()),
    }
  }

  /**
   * What each side answers to `agents.describe`. Two entries with one model apiece: the smoke is a
   * client of the operation, not of anybody's catalog.
   */
  static agents(): RemoteControlAgentsPort {
    return {
      describe: () => ({
        agents: [
          {
            agentId: 'claude',
            configuredModel: 'opus',
            models: [{
              id: 'claude-fable-5',
              label: 'Claude Fable 5',
              kind: 'version',
              context: 200_000,
              efforts: ['high'],
            }],
          },
          {
            agentId: 'codex',
            configuredModel: null,
            models: [{
              id: 'gpt-5.6-sol',
              label: 'GPT-5.6-Sol',
              kind: 'version',
              context: 272_000,
              efforts: ['high'],
            }],
          },
        ],
      }),
    }
  }

  static transcript(): RemoteControlTranscriptPort {
    return {
      read: () => Promise.resolve({
        kind: 'none',
        code: 'not-agent',
        reason: 'remote-app smoke sessions have no local transcript fixture',
      }),
    }
  }

  private static tabRefusal(): RemoteControlStepResult<RemoteControlTabCommandDto> {
    return { ok: false, error: { code: 'forbidden', detail: 'smoke has no renderer tabs' } }
  }

  private static tabFileRefusal(): RemoteControlStepResult<RemoteControlTabOpenFileDto> {
    return { ok: false, error: { code: 'forbidden', detail: 'smoke has no renderer tabs' } }
  }
}

void SmokeRemoteApp.run().catch((error: unknown) => SmokeRun.failed('smoke-remote-app', error))
