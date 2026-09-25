/**
 * End-to-end proof of the local control boundary. It starts a real AppHost and PTY, composes the
 * same semantic control and loopback server used by AppClientUI, then invokes the shipped skill
 * wrapper from a foreign working directory. Electron is not started and the user's running client
 * is not touched.
 */
import { CliClient, type CliEnvelope } from './cliClient.js'
import { randomUUID } from 'node:crypto'
import { SmokeHarness, SmokeRun } from './smokeHarness.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { ClientStatePaths } from '../../app-client-ui/app/clientState/clientStatePaths.js'
import { RemoteControlInstanceStore } from '../../app-client-ui/app/remoteControl/remoteControlInstanceStore.js'
import { RemoteControlServer } from '../../app-client-ui/app/remoteControl/remoteControlServer.js'
import { RemoteSessionGroups } from '../../app-client-ui/app/sessionGroups/remoteSessionGroups.js'
import { SessionTranscriptAccess } from '../../app-client-ui/app/sessionTranscript/sessionTranscriptAccess.js'
import { SessionsGroupsState } from '../../app-client-ui/shared/sessionsGroupsState.js'
import { HostDescriptorPaths } from '../../lib-orchestrator/hostClient/hostDescriptorPaths.js'
import type { ProviderTranscriptRef } from '../../lib-orchestrator/projectManager/providerTranscriptView.js'
import {
  RemoteControl,
  type RemoteControlSessionGroupsPort,
  type RemoteControlSessionsPort,
  type RemoteControlTabsPort,
} from '../../lib-orchestrator/remoteControl/remoteControl.js'
import { RemoteControlClient } from '../../lib-orchestrator/remoteControl/remoteControlClient.js'
import { RemoteControlConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol.js'
import type {
  RemoteControlDescriptor,
  RemoteControlStepResult,
  RemoteControlSystemIdentity,
  RemoteControlTabCommandDto,
  RemoteControlTabDto,
  RemoteControlTabOpenFileDto,
} from '../../lib-orchestrator/remoteControl/remoteControlApi.types.js'
import { RemoteControlInstanceRegistry } from '../../lib-orchestrator/remoteControl/remoteControlInstanceRegistry.js'
import { RemoteControlTerminal } from '../../lib-orchestrator/remoteControl/remoteControlTerminal.js'
import { SessionManager } from '../../lib-orchestrator/sessionManager/sessionManager.js'
import type { SessionGroup } from '../../lib-orchestrator/sessionManager/sessionManagerApi.types.js'
import type { SessionRecord } from '../../lib-orchestrator/sessionManager/records/sessionRecord.types.js'
import {
  SessionTranscriptReader,
  type SessionTranscriptContext,
} from '../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReader.js'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore.js'
import { OrchestratorPaths } from '../../lib-orchestrator/shared/orchestratorPaths.js'

class SmokeRemoteControl extends SmokeHarness {
  protected override get waitMilliseconds(): number {
    return SmokeRemoteControl.waitMillisecondsConst
  }

  private static readonly channelConst = 'development'
  private static readonly controllerIdConst = 'jamat-remote-control-smoke'
  private static readonly waitMillisecondsConst = 30_000
  private static readonly markerConst = 'smoke-remote-control-marker'
  private static readonly forkSessionIdConst = 'smoke-fork-session'
  private static readonly nativeSessionIdConst = 'smoke-native'
  private static readonly repoRootConst = join(import.meta.dirname, '..', '..')

  private readonly configDir: string
  private readonly configIdentity: string
  private readonly stateRoot: string
  private readonly workDir: string
  private readonly hostDescriptorFile: string
  private readonly controlDescriptorFile: string
  private readonly compatibilityDescriptorFile: string
  private readonly registryFile: string
  private readonly transcriptFile: string
  private readonly transcriptCwd: string
  private readonly transcriptBytes: number
  private readonly transcriptContexts: SessionTranscriptContext[] = []
  private readonly errors: string[] = []
  private readonly groupAssigns: { key: string; group: SessionGroup }[] = []
  private readonly tabs: RemoteControlTabDto[] = []
  private readonly manager: SessionManager
  private readonly transcriptAccess: SessionTranscriptAccess
  private readonly terminal: RemoteControlTerminal
  private readonly server: RemoteControlServer
  private conflictServer: RemoteControlServer | null = null
  private host: ChildProcess | null = null
  private tabSequence = 0
  private readonly commitSessionId = randomUUID()
  private commitSessionOwner = ''
  private commitReads = 0

  private constructor(root: string) {
    super()
    this.configDir = join(root, 'config')
    this.stateRoot = join(root, 'state')
    this.workDir = join(root, 'foreign-cwd')
    mkdirSync(this.workDir, { recursive: true })
    const osLocalState = join(root, 'os-local-state')
    process.env.LOCALAPPDATA = osLocalState
    process.env.XDG_STATE_HOME = osLocalState
    process.env.JAMAT_V3_LOCAL_STATE_DIR = this.stateRoot
    process.env.JAMAT_V3_HOST_STATE_DIR = join(this.stateRoot, 'host')
    this.configIdentity = ConfigIdentityStore
      .loadOrCreate(this.configDir, SmokeRemoteControl.channelConst)
      .configIdentity
    this.transcriptFile = join(root, 'transcripts', `${SmokeRemoteControl.nativeSessionIdConst}.jsonl`)
    this.transcriptCwd = join(root, 'removed-worktree')
    this.transcriptBytes = this.seedAgentTranscript(root)
    const identity: RemoteControlSystemIdentity = {
      configIdentity: this.configIdentity,
      runtimeChannel: SmokeRemoteControl.channelConst,
      instanceId: 'remote-control-smoke',
      startedAt: Date.now(),
      applicationVersion: 'smoke',
    }
    this.hostDescriptorFile = HostDescriptorPaths.descriptorFile(
      this.configIdentity,
      SmokeRemoteControl.channelConst,
    )
    this.controlDescriptorFile = ClientStatePaths.controlInstanceDescriptorFile(
      this.configIdentity,
      SmokeRemoteControl.channelConst,
      identity.instanceId,
      identity.startedAt,
    )
    this.compatibilityDescriptorFile = ClientStatePaths.controlDescriptorFile(
      this.configIdentity,
      SmokeRemoteControl.channelConst,
    )
    this.registryFile = RemoteControlInstanceRegistry.fileOf(
      this.configIdentity,
      SmokeRemoteControl.channelConst,
      identity.instanceId,
      identity.startedAt,
    )
    const transcripts = {
      resolve: (context: SessionTranscriptContext): Promise<ProviderTranscriptRef | null> => {
        this.transcriptContexts.push(context)
        if (context.agentId !== 'codex'
          || context.nativeSessionId !== SmokeRemoteControl.nativeSessionIdConst
          || context.cwd !== this.transcriptCwd)
          return Promise.resolve(null)
        const stats = statSync(this.transcriptFile)
        return Promise.resolve({
          agentId: 'codex',
          nativeSessionId: context.nativeSessionId,
          file: this.transcriptFile,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        })
      },
    }
    this.manager = new SessionManager({
      applicationRoot: SmokeRemoteControl.repoRootConst,
      resourcesRoot: null,
      configDir: this.configDir,
      configIdentity: this.configIdentity,
      channel: SmokeRemoteControl.channelConst,
      autoStartHost: false,
      onChanged: () => this.server.publishEvent('sessions.changed'),
      onError: (message) => { this.errors.push(message) },
      controllerId: SmokeRemoteControl.controllerIdConst,
      transcripts,
    })
    this.transcriptAccess = new SessionTranscriptAccess(
      this.manager,
      new SessionTranscriptReader({ transcripts }),
    )
    this.terminal = new RemoteControlTerminal(this.manager, {
      onError: (message) => { this.errors.push(message) },
    })
    const control = this.control(identity)
    this.server = new RemoteControlServer({
      identity,
      control,
      terminal: this.terminal,
      descriptorFile: this.controlDescriptorFile,
      compatibilityDescriptorFile: this.compatibilityDescriptorFile,
      instanceStore: this.instanceStore(
        this.configIdentity,
        identity.instanceId,
        identity.startedAt,
      ),
      auditFile: ClientStatePaths.controlAuditFile(
        this.configIdentity,
        SmokeRemoteControl.channelConst,
      ),
      onError: (message) => { this.errors.push(message) },
    })
  }

  static async run(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-remote-control-smoke-'))
    const smoke = new SmokeRemoteControl(root)
    try {
      await smoke.execute()
    } finally {
      await smoke.retire()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }

  private async execute(): Promise<void> {
    this.host = this.spawnHost()
    await this.checkWaiting(
      'AppHost published its descriptor',
      () => existsSync(this.hostDescriptorFile),
      `the Host never published ${this.hostDescriptorFile}`,
    )
    await this.manager.start()
    await this.waitUntil(
      () => this.manager.snapshot().host.presence === 'running',
      'the SessionManager never reached AppHost',
    )
    await this.server.start()
    this.check('AppClientUI published a private per-instance control descriptor',
      existsSync(this.controlDescriptorFile))
    this.check('AppClientUI published the fixed compatibility descriptor',
      existsSync(this.compatibilityDescriptorFile))

    await this.checkStatusAndProjects()
    await this.checkDiscoveryConflict()
    const sessionId = await this.checkCreateReplayAndList()
    await this.checkRepaint(sessionId)
    await this.checkCustomNumber()
    await this.checkForkTranscript()
    const panelId = await this.checkTabs(sessionId)
    await this.checkTerminal(sessionId)
    await this.checkDeliver(sessionId)
    await this.checkFinalize(sessionId)
    this.check('the fake renderer tab was closed', !this.tabs.some((tab) => tab.panelId === panelId))

    await this.server.stop()
    this.check('stopping AppClientUI control removed its private descriptor',
      !existsSync(this.controlDescriptorFile))
    this.check('stopping AppClientUI control left the write-only compatibility descriptor',
      existsSync(this.compatibilityDescriptorFile))
    this.check('stopping AppClientUI control removed its registry entry',
      !existsSync(this.registryFile))
    this.check(`nothing was reported through onError (${this.errors.join(' | ')})`,
      this.errors.length === 0)
    console.log(`\nsmoke-remote-control: ${this.passed} checks passed`)
  }

  private async checkStatusAndProjects(): Promise<void> {
    const status = CliClient.valueOf(await this.cli('status'), 'system.status')
    const sessions = CliClient.object(status.sessions, 'status sessions')
    const host = CliClient.object(sessions.host, 'status host')
    this.check('CLI status reaches the running AppHost through AppClientUI',
      host.presence === 'running')

    const projects = CliClient.valueOf(
      await this.cli('projects', 'list'),
      'projects.list',
    )
    this.check('CLI projects list crossed the semantic project port',
      Array.isArray(projects.categories) && projects.categories.length === 0)
  }

  private seedAgentTranscript(root: string): number {
    const transcript = `${Array.from({ length: 11 }, (_, index) => JSON.stringify({
      timestamp: new Date(2_000 + index).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: index === 10
            ? 'untrusted smoke transcript history'
            : `older transcript message ${index}`,
        }],
      },
    })).join('\n')}\n`
    mkdirSync(dirname(this.transcriptFile), { recursive: true })
    writeFileSync(this.transcriptFile, transcript, 'utf8')
    const record = {
      sessionId: SmokeRemoteControl.forkSessionIdConst,
      kind: 'agent',
      title: '014-015 - handed over',
      directory: { mode: 'adHoc', path: join(root, 'merged-main') },
      agent: {
        agentId: 'codex',
        launchMode: 'fork',
        nativeSessionId: SmokeRemoteControl.nativeSessionIdConst,
        forkParentId: 'smoke-parent',
      },
      transcriptCwd: this.transcriptCwd,
      binding: null,
      life: 'ended',
      createdAt: 1_000,
      endedAt: 2_000,
      exitCode: 0,
      exitReason: 'process-exit',
    } as const satisfies SessionRecord
    const recordsFile = OrchestratorPaths.sessionRecordsFile(
      this.configIdentity,
      SmokeRemoteControl.channelConst,
    )
    mkdirSync(dirname(recordsFile), { recursive: true })
    writeFileSync(recordsFile, JSON.stringify({
      schemaVersion: 1,
      savedAt: Date.now(),
      records: [record],
    }), 'utf8')
    return Buffer.byteLength(transcript)
  }

  private async checkDiscoveryConflict(): Promise<void> {
    const configDir = join(this.workDir, 'second-config')
    const configIdentity = ConfigIdentityStore
      .loadOrCreate(configDir, SmokeRemoteControl.channelConst)
      .configIdentity
    const identity: RemoteControlSystemIdentity = {
      configIdentity,
      runtimeChannel: SmokeRemoteControl.channelConst,
      instanceId: 'remote-control-smoke-second',
      startedAt: Date.now() + 1,
      applicationVersion: 'smoke-second',
    }
    const descriptorFile = ClientStatePaths.controlInstanceDescriptorFile(
      configIdentity,
      SmokeRemoteControl.channelConst,
      identity.instanceId,
      identity.startedAt,
    )
    const server = new RemoteControlServer({
      identity,
      control: this.control(identity),
      terminal: this.terminal,
      descriptorFile,
      compatibilityDescriptorFile: ClientStatePaths.controlDescriptorFile(
        configIdentity,
        SmokeRemoteControl.channelConst,
      ),
      instanceStore: this.instanceStore(
        configIdentity,
        identity.instanceId,
        identity.startedAt,
      ),
      auditFile: ClientStatePaths.controlAuditFile(
        configIdentity,
        SmokeRemoteControl.channelConst,
      ),
      onError: (message) => { this.errors.push(message) },
    })
    this.conflictServer = server
    const descriptor = await server.start()
    const conflicted = await this.cliFailure(4, 'status')
    const serialized = JSON.stringify(conflicted)
    this.check('two live AppClientUI instances return a discovery conflict',
      conflicted.ok === false && conflicted.error?.code === 'conflict')
    this.check('the discovery conflict contains no credential or private path facts',
      !serialized.includes(descriptor.token)
      && !serialized.includes(this.stateRoot)
      && !serialized.includes(configDir)
      && !serialized.includes('descriptorFile')
      && !serialized.includes('"port"')
      && !serialized.includes('"token"'))

    const selected = CliClient.valueOf(
      await this.cli('status', '--config-identity', this.configIdentity),
      'system.status',
    )
    const selectedIdentity = CliClient.object(selected.identity, 'selected identity')
    this.check('an exact config identity selects one controller after the conflict',
      selectedIdentity.configIdentity === this.configIdentity)
    await server.stop()
    this.conflictServer = null
  }

  private async checkCreateReplayAndList(): Promise<string> {
    const args = [
      'sessions',
      'create',
      '--directory',
      this.workDir,
      '--title',
      'Remote control smoke',
      '--color',
      'magenta',
      '--group',
      'automation',
      '--operation-id',
      'smoke-create-1',
    ]
    const created = CliClient.valueOf(
      await this.cli(...args),
      'sessions.create',
    )
    const firstSession = CliClient.object(created.session, 'created session')
    const sessionId = CliClient.text(firstSession.sessionId, 'created sessionId')
    const replayed = CliClient.valueOf(
      await this.cli(...args),
      'sessions.create',
    )
    const replayedSession = CliClient.object(replayed.session, 'replayed session')
    this.check('reusing one operationId returned the original session',
      replayedSession.sessionId === sessionId)

    await this.waitUntil(
      () => this.manager.snapshot().sessions
        .some((session) => session.sessionId === sessionId && session.life === 'live'),
      'the CLI-created shell session never went live',
    )
    const listed = CliClient.valueOf(
      await this.cli('sessions', 'list'),
      'sessions.list',
    )
    const sessions = CliClient.array(listed.sessions, 'listed sessions')
    const mine = sessions
      .map((session) => CliClient.object(session, 'listed session'))
      .filter((session) => session.sessionId === sessionId)
    this.check('CLI sessions list contains one replay-safe live session', mine.length === 1)
    // The whole chain the colour has to survive: the CLI parser, the listener, the create validator
    // that reads the body with exact keys, the record, and the snapshot that draws the tree.
    this.check('the created session is painted the colour its create named',
      mine[0]?.color === 'magenta')
    // The group takes the same chain as the colour and lands somewhere else at the end of it: the
    // client's own state rather than the session record, which is why the create reports the step.
    const groupAssign = CliClient.object(created.groupAssign, 'group assignment')
    this.check('the create reports the section it filed the session under',
      groupAssign.ok === true
      && this.groupAssigns.length === 1
      && this.groupAssigns[0]?.key === SmokeRemoteControl.groupKeyOf(sessionId)
      && this.groupAssigns[0]?.group === 'automation')
    return sessionId
  }

  /**
   * The number a caller brings, end to end through the real wrapper: the CLI parser, the listener,
   * the create validator reading the body with exact keys, the composed title, and then the
   * selector finding the session again by the very thing the create named it. The last check is
   * the one the feature exists for - a number nobody counted is still a number you can address.
   */
  private async checkCustomNumber(): Promise<void> {
    const created = CliClient.valueOf(
      await this.cli(
        'sessions', 'create', '--directory', this.workDir,
        '--title', 'Issue work', '--number', 'i34',
        '--operation-id', 'smoke-create-custom-number',
      ),
      'sessions.create',
    )
    const session = CliClient.object(created.session, 'created session')
    const sessionId = CliClient.text(session.sessionId, 'created sessionId')
    const record = this.manager.snapshot().sessions.find((one) => one.sessionId === sessionId)
    this.check('a create composes the title around the number it was given',
      record?.title === 'i34 - Issue work' && record.titleParts.number === 'i34')

    const selected = CliClient.valueOf(
      await this.cli('sessions', 'transcript', '--number', 'i34'),
      'sessions.transcript',
    )
    this.check('a custom number resolves to the canonical Jamat session id it named',
      selected.sessionId === sessionId)

    // Refused in the parser, before discovery: an allocated number is the answering computer's.
    const refused = await this.cliFailure(
      2, 'sessions', 'create', '--directory', this.workDir, '--number', '014',
    )
    this.check('a create bringing an allocated number never reaches the controller',
      refused.ok === false && refused.error?.code === 'invalid-request')
  }

  /**
   * The other half of what a create can already say, on a session that is running. The chain is the
   * same one the create's colour takes and it ends in two different places: the colour on the
   * session record the snapshot draws, and the group in the client's own state.
   */
  private async checkRepaint(sessionId: string): Promise<void> {
    const repainted = CliClient.valueOf(
      await this.cli(
        'sessions', 'color', '--session-id', sessionId,
        '--color', 'cyan', '--operation-id', 'smoke-color-1',
      ),
      'sessions.color',
    )
    this.check('a live session takes the colour a later request names',
      repainted.sessionId === sessionId
      && repainted.color === 'cyan'
      && this.manager.snapshot().sessions
        .find((session) => session.sessionId === sessionId)?.color === 'cyan')

    const refiled = CliClient.valueOf(
      await this.cli(
        'sessions', 'group', '--session-id', sessionId,
        '--group', 'waiting', '--operation-id', 'smoke-group-1',
      ),
      'sessions.group',
    )
    this.check('a live session moves to the section a later request names',
      refiled.sessionId === sessionId
      && refiled.group === 'waiting'
      && this.groupAssigns.length === 2
      && this.groupAssigns[1]?.key === SmokeRemoteControl.groupKeyOf(sessionId)
      && this.groupAssigns[1]?.group === 'waiting')

    const listed = CliClient.valueOf(await this.cli('sessions', 'list'), 'sessions.list')
    this.check('sessions list reads back the assigned group',
      CliClient.array(listed.sessions, 'sessions').some((entry) => {
        const session = CliClient.object(entry, 'session')
        return session.sessionId === sessionId && session.group === 'waiting'
      }))

    /*
     * The note is the one session field with a read of its own, so the three forms of one command
     * are proven as one chain: what a write stores is what the read answers, and a clear leaves
     * nothing behind rather than an empty string nobody can tell from a note.
     */
    const written = CliClient.valueOf(
      await this.cli(
        'sessions', 'note', '--session-id', sessionId,
        '--note', '  Waiting for the SVN review of r4599.  ', '--operation-id', 'smoke-note-1',
      ),
      'sessions.setNote',
    )
    const read = CliClient.valueOf(await this.cli('sessions', 'note', '--session-id', sessionId), 'sessions.note')
    this.check('a note is stored trimmed and read back by the command that wrote it',
      written.note === 'Waiting for the SVN review of r4599.'
      && read.note === written.note
      && this.manager.snapshot().sessions
        .find((session) => session.sessionId === sessionId)?.note === written.note)

    const cleared = CliClient.valueOf(
      await this.cli('sessions', 'note', '--session-id', sessionId, '--clear', '--operation-id', 'smoke-note-2'),
      'sessions.setNote',
    )
    this.check('a cleared note leaves the record with none at all',
      cleared.note === null
      && CliClient.valueOf(await this.cli('sessions', 'note', '--session-id', sessionId), 'sessions.note').note === null
      && this.manager.snapshot().sessions
        .find((session) => session.sessionId === sessionId)?.note === undefined)

    const bothFlags = await this.cliFailure(2, 'sessions', 'note', '--session-id', sessionId,
      '--note', 'one thing', '--clear')
    this.check('a note that says two things at once is refused without reaching the controller',
      bothFlags.ok === false && bothFlags.error?.code === 'invalid-request')

    // Refused by the CLI parser, before any round trip: the palette is fixed and both sides have it.
    const unknown = await this.cliFailure(2, 'sessions', 'color', '--session-id', sessionId, '--color', 'chartreuse')
    this.check('an unknown colour is refused without reaching the controller',
      unknown.ok === false && unknown.error?.code === 'invalid-request')

    /*
     * A group goes the other way, and this is the whole chain that proves it. The sections are made
     * on the computer that answers, so a well-formed id this one has never had travels the parser,
     * the listener and the validator, and dies at the only place that knows - which says what this
     * computer does have, so the caller has something to try next.
     */
    const missing = await this.cliFailure(2, 'sessions', 'group', '--session-id', sessionId,
      '--group', 'invented-yesterday', '--operation-id', 'smoke-group-2')
    this.check('a group the controller has no section for is refused by the controller, by name',
      missing.ok === false
      && missing.error?.code === 'invalid-request'
      && String(missing.error?.detail).includes('invented-yesterday')
      && String(missing.error?.detail).includes('automation')
      && this.groupAssigns.length === 2)

    const malformed = await this.cliFailure(2, 'sessions', 'group', '--session-id', sessionId, '--group', 'Not An Id')
    this.check('a group id no computer could have is refused without reaching the controller',
      malformed.ok === false && malformed.error?.code === 'invalid-request')

    CliClient.valueOf(await this.cli('sessions', 'group', '--session-id', sessionId,
      '--group', 'none', '--operation-id', 'smoke-group-clear'), 'sessions.group')
    const ungrouped = CliClient.valueOf(await this.cli('sessions', 'list'), 'sessions.list')
    this.check('sessions list reports null after an explicit None assignment',
      CliClient.array(ungrouped.sessions, 'sessions').some((entry) => {
        const session = CliClient.object(entry, 'session')
        return session.sessionId === sessionId && session.group === null
      }))
  }

  /** The key the client files a local session under, spelled by the rule both sides read. */
  private static groupKeyOf(sessionId: string): string {
    return SessionsGroupsState.sessionKeyOf({ kind: 'local', sessionId })
  }

  private async checkForkTranscript(): Promise<void> {
    const value = CliClient.valueOf(
      await this.cli('sessions', 'transcript', '--number', '014-015'),
      'sessions.transcript',
    )
    const reading = CliClient.object(value.reading, 'transcript reading')
    const bounds = CliClient.object(reading.bounds, 'transcript bounds')
    const messages = CliClient.array(reading.messages, 'transcript messages')
    const message = CliClient.object(messages[messages.length - 1], 'transcript message')
    this.check('the fork number resolves to a canonical Jamat session id',
      value.sessionId === SmokeRemoteControl.forkSessionIdConst)
    this.check('the agent record preserved transcript provenance after its worktree disappeared',
      this.transcriptContexts.length === 1
      && this.transcriptContexts[0]?.agentId === 'codex'
      && this.transcriptContexts[0]?.nativeSessionId === SmokeRemoteControl.nativeSessionIdConst
      && this.transcriptContexts[0]?.cwd === this.transcriptCwd)
    this.check('the real local transcript reader returns untrusted bounded history',
      value.transcriptContentUntrusted === true
      && reading.kind === 'messages'
      && reading.earlierContentOmitted === true
      && bounds.maxMessages === 10
      && bounds.maxCharactersPerMessage === 2_000
      && bounds.scannedBytes === this.transcriptBytes
      && messages.length === 10
      && message.role === 'assistant'
      && message.text === 'untrusted smoke transcript history'
      && message.textTruncated === false)
  }

  private async checkTabs(sessionId: string): Promise<string> {
    const opened = CliClient.valueOf(
      await this.cli(
        'tabs',
        'open',
        '--session-id',
        sessionId,
        '--operation-id',
        'smoke-tab-open-1',
      ),
      'tabs.open',
    )
    const panelId = CliClient.text(opened.panelId, 'opened panelId')
    const listed = CliClient.valueOf(await this.cli('tabs', 'list'), 'tabs.list')
    const tabs = CliClient.array(listed.tabs, 'listed tabs')
    this.check('CLI tabs open and list reached the renderer acknowledgement seam',
      tabs.some((tab) => CliClient.object(tab, 'listed tab').panelId === panelId))

    const fileOpened = CliClient.valueOf(
      await this.cli(
        'tabs',
        'open-file',
        '--session-id',
        sessionId,
        '--path',
        'reports/report.md',
        '--operation-id',
        'smoke-tab-open-file-1',
      ),
      'tabs.openFile',
    )
    this.check('CLI tabs open-file crossed the wrapper and semantic tab port',
      fileOpened.kind === 'file-opened'
      && fileOpened.panelId === panelId
      && fileOpened.path === join(this.workDir, 'reports/report.md'))

    const commitOpened = CliClient.valueOf(await this.cli('commit-svn-jamat', '--session-id', sessionId,
      '--message', 'Review these changes', '--fallback', 'report', '--operation-id', 'smoke-commit-open-1'), 'tabs.openCommit')
    this.check('CLI commit command crossed the wrapper and opened in the existing session panel',
      commitOpened.kind === 'commit-opened' && commitOpened.panelId === panelId
      && commitOpened.scopeRoot === this.workDir && commitOpened.messageApplied === true)
    this.check('native open exposes a commit UUID', commitOpened.commitSessionId === this.commitSessionId)
    const pending = CliClient.valueOf(await this.cli('commit', 'status', '--commit-session-id', this.commitSessionId), 'tabs.commitStatus')
    this.check('commit status reports this review as pending', pending.state === 'editing' && pending.closed === false)
    const completed = CliClient.valueOf(await this.cli('commit', 'status', '--commit-session-id', this.commitSessionId, '--wait'), 'tabs.commitStatus')
    this.check('commit wait returns the completed revision while the panel remains open', completed.state === 'committed' && completed.revision === '42' && completed.closed === false)

    await this.cli(
      'tabs',
      'focus',
      '--panel-id',
      panelId,
      '--operation-id',
      'smoke-tab-focus-1',
    )
    this.check('CLI tabs focus selected the requested panel',
      this.tabs.find((tab) => tab.panelId === panelId)?.active === true)
    await this.cli(
      'tabs',
      'close',
      '--panel-id',
      panelId,
      '--operation-id',
      'smoke-tab-close-1',
    )
    return panelId
  }

  private async checkTerminal(sessionId: string): Promise<void> {
    const sent = CliClient.valueOf(
      await this.cli(
        'terminal',
        'send',
        '--session-id',
        sessionId,
        '--text',
        `echo ${SmokeRemoteControl.markerConst}`,
        '--enter',
        '--operation-id',
        'smoke-terminal-send-1',
      ),
      'terminal.send',
    )
    this.check('CLI terminal send was accepted by the real PTY', sent.accepted === true)

    let untrusted = false
    let screen = ''
    await this.waitUntilAsync(async () => {
      const peeked = CliClient.valueOf(
        await this.cli('terminal', 'peek', '--session-id', sessionId),
        'terminal.peek',
      )
      untrusted = peeked.terminalOutputUntrusted === true
      const snapshot = CliClient.object(peeked.snapshot, 'terminal snapshot')
      const projection = CliClient.object(snapshot.projection, 'terminal projection')
      screen = CliClient.text(projection.screen, 'terminal screen')
      return screen.includes(SmokeRemoteControl.markerConst)
    }, 'the command sent through the CLI never appeared in a terminal snapshot')
    this.check('CLI terminal peek returned the real projected screen',
      screen.includes(SmokeRemoteControl.markerConst))
    this.check('terminal output is marked as untrusted', untrusted)
  }

  /**
   * The smoke has no agent to deliver to, so this proves the seams around the loop: the capability
   * is advertised twice, and a refusal with its `data` travels the listener and the wrapper intact.
   */
  private async checkDeliver(sessionId: string): Promise<void> {
    const descriptor = JSON.parse(readFileSync(this.controlDescriptorFile, 'utf8')) as RemoteControlDescriptor
    this.check('the control descriptor lists terminal.deliver',
      descriptor.optionalOperations?.includes('terminal.deliver') === true)
    const hello = await new RemoteControlClient(descriptor).execute({
      protocol: RemoteControlConst.protocol,
      requestId: randomUUID(),
      operation: 'system.hello',
      body: {},
    })
    this.check('system.hello lists terminal.deliver',
      hello.ok && hello.value.optionalOperations?.includes('terminal.deliver') === true)

    const refused = await this.cliFailure(2, 'terminal', 'deliver', '--session-id', sessionId,
      '--text', 'never typed', '--operation-id', 'smoke-terminal-deliver-1')
    const data = CliClient.object(refused.error?.data, 'terminal.deliver failure data')
    this.check('terminal deliver on a shell session is refused through the wrapper with its reason',
      refused.ok === false
      && refused.error?.code === 'invalid-request'
      && data.stage === 'validate'
      && data.reason === 'shell-session'
      && data.typed === false)
  }

  private async checkFinalize(sessionId: string): Promise<void> {
    await this.cli(
      'sessions',
      'finalize',
      '--session-id',
      sessionId,
      '--operation-id',
      'smoke-finalize-1',
    )
    await this.checkWaiting(
      'CLI finalize stopped the real runtime',
      () => this.manager.snapshot().sessions
        .some((session) => session.sessionId === sessionId && session.life === 'ended'),
      'the CLI-finalized session never ended',
    )
  }

  private control(identity: RemoteControlSystemIdentity): RemoteControl {
    return new RemoteControl({
      system: { identity: () => identity },
      projects: {
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
      },
      sessions: this.sessionPort(),
      groups: this.groupPort(),
      tabs: this.tabPort(),
      terminal: this.terminal,
      transcript: {
        read: (sessionId) => this.transcriptAccess.read(sessionId),
      },
      // One agent with one model: this smoke drives the CLI, not the model picker.
      agents: {
        describe: () => ({
          agents: [{
            agentId: 'claude',
            configuredModel: null,
            models: [{
              id: 'claude-fable-5',
              label: 'Claude Fable 5',
              kind: 'version',
              context: 200_000,
              efforts: ['high'],
            }],
          }],
        }),
      },
      onError: (message) => { this.errors.push(message) },
    })
  }

  private sessionPort(): RemoteControlSessionsPort {
    return {
      snapshot: () => {
        return this.manager.snapshot()
      },
      createSession: (spec) => this.manager.createSession(spec),
      reopenSession: (sessionId) => this.manager.reopenSession(sessionId),
      finalizeSession: (sessionId) => this.manager.finalizeSession(sessionId),
      removeSession: (sessionId) => this.manager.removeSession(sessionId),
      setSessionColor: (sessionId, color) => this.manager.setSessionColor(sessionId, color),
      setSessionDetails: (sessionId, update) => this.manager.setSessionDetails(sessionId, update),
    }
  }

  /**
   * The client's REAL adapter over a state store that records instead of writing. The smoke keeps no
   * client state, and the thing worth driving here is not the file - it is that the adapter is the
   * only place that knows which sections exist, so a group named on a command line survives the
   * parser, the listener and the validator and is then either filed or refused by name.
   */
  private groupPort(): RemoteControlSessionGroupsPort {
    return new RemoteSessionGroups(
      () => SessionsGroupsState.defaultsConst,
      {
        loadSessionGroups: () => [...new Map(this.groupAssigns.map((entry) => [entry.key, entry])).values()],
        assignSessionGroup: (key, group) => {
          this.groupAssigns.push({ key, group })
          return true
        },
      },
      () => {},
    )
  }

  private instanceStore(
    configIdentity: string,
    instanceId: string,
    startedAt: number,
  ): RemoteControlInstanceStore {
    return new RemoteControlInstanceStore(RemoteControlInstanceRegistry.fileOf(
      configIdentity,
      SmokeRemoteControl.channelConst,
      instanceId,
      startedAt,
    ))
  }

  private tabPort(): RemoteControlTabsPort {
    return {
      list: () => Promise.resolve(this.tabs.map((tab) => ({
        ...tab,
        params: { ...tab.params },
      }))),
      open: (sessionId, tabTitle) => Promise.resolve(this.openTab(sessionId, tabTitle)),
      openCommit: async (sessionId, title, _vcs, scope, proposal) => {
        const opened = this.openTab(sessionId, title)
        if (!opened.ok) return opened
        this.commitSessionOwner = sessionId
        this.commitReads = 0
        return { ok: true, value: { kind: 'commit-opened', panelId: opened.value.panelId, windowId: opened.value.windowId,
          commitSessionId: this.commitSessionId,
          scopeRoot: scope === null ? this.workDir : join(this.workDir, scope), messageApplied: proposal !== null } }
      },
      commitStatus: (commitSessionId) => {
        if (commitSessionId !== this.commitSessionId) return { ok: false, error: { code: 'not-found', detail: 'Unknown review' } }
        const completed = ++this.commitReads >= 3
        return { ok: true, value: { kind: 'commit-status', commitSessionId, sessionId: this.commitSessionOwner,
          vcs: 'svn', scopeRoot: this.workDir, state: completed ? 'committed' : 'editing', closed: false,
          revision: completed ? '42' : null, detail: null } }
      },
      openFile: (sessionId, tabTitle, path) =>
        Promise.resolve(this.openFile(sessionId, tabTitle, path)),
      focus: (panelId) => Promise.resolve(this.focusTab(panelId)),
      close: (panelId) => Promise.resolve(this.closeTab(panelId)),
    }
  }

  private openTab(
    sessionId: string,
    tabTitle: string,
  ): RemoteControlStepResult<RemoteControlTabCommandDto> {
    const existing = this.tabs.find((tab) => tab.sessionId === sessionId)
    if (existing) {
      this.activate(existing.panelId)
      return SmokeRemoteControl.success({
        kind: 'focused-existing',
        panelId: existing.panelId,
        windowId: existing.windowId,
      })
    }
    this.tabSequence += 1
    const panelId = `smoke-panel-${this.tabSequence}`
    this.activate(null)
    this.tabs.push({
      panelId,
      windowId: 'smoke-main',
      key: `terminal:${sessionId}`,
      title: tabTitle,
      params: { sessionId },
      sessionId,
      active: true,
    })
    this.server.publishEvent('tabs.changed')
    return SmokeRemoteControl.success({ kind: 'opened', panelId, windowId: 'smoke-main' })
  }

  private openFile(
    sessionId: string,
    tabTitle: string,
    path: string,
  ): RemoteControlStepResult<RemoteControlTabOpenFileDto> {
    const opened = this.openTab(sessionId, tabTitle)
    if (!opened.ok) return opened
    return {
      ok: true,
      value: {
        kind: 'file-opened',
        panelId: opened.value.panelId,
        windowId: opened.value.windowId,
        path: join(this.workDir, path),
      },
    }
  }

  private focusTab(panelId: string): RemoteControlStepResult<RemoteControlTabCommandDto> {
    const tab = this.tabs.find((candidate) => candidate.panelId === panelId)
    if (!tab) return SmokeRemoteControl.notFound(panelId)
    this.activate(panelId)
    this.server.publishEvent('tabs.changed')
    return SmokeRemoteControl.success({
      kind: 'focused-existing',
      panelId,
      windowId: tab.windowId,
    })
  }

  private closeTab(panelId: string): RemoteControlStepResult<RemoteControlTabCommandDto> {
    const index = this.tabs.findIndex((tab) => tab.panelId === panelId)
    if (index < 0) return SmokeRemoteControl.notFound(panelId)
    const [closed] = this.tabs.splice(index, 1)
    if (!closed) throw new Error(`FAILED: no tab removed for ${panelId}`)
    if (closed.active && this.tabs.length > 0) this.tabs[0].active = true
    this.server.publishEvent('tabs.changed')
    return SmokeRemoteControl.success({ kind: 'closed', panelId, windowId: closed.windowId })
  }

  private activate(panelId: string | null): void {
    for (const tab of this.tabs) tab.active = tab.panelId === panelId
  }

  /** The shipped wrapper, run as a child: what an agent actually executes. */
  private cli(...args: string[]): Promise<CliEnvelope> {
    return new CliClient({
      cwd: this.workDir,
      timeoutMilliseconds: SmokeRemoteControl.waitMillisecondsConst,
    }).run(...args)
  }

  private cliFailure(exitCode: number, ...args: string[]): Promise<CliEnvelope> {
    return new CliClient({
      cwd: this.workDir,
      timeoutMilliseconds: SmokeRemoteControl.waitMillisecondsConst,
    }).runFailure(exitCode, ...args)
  }

  private spawnHost(): ChildProcess {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        join(SmokeRemoteControl.repoRootConst, 'app-host', 'start.ts'),
        '--config-dir',
        this.configDir,
        '--channel',
        SmokeRemoteControl.channelConst,
      ],
      {
        cwd: SmokeRemoteControl.repoRootConst,
        env: { ...process.env, JAMAT_V3_LOCAL_STATE_DIR: this.stateRoot },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    )
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`  host! ${chunk}`))
    return child
  }

  private async retire(): Promise<void> {
    await this.conflictServer?.stop()
    this.conflictServer = null
    await this.server.stop()
    await this.manager.stop()
    const child = this.host
    this.host = null
    if (child === null || child.exitCode !== null) return
    child.kill()
    await this.waitUntil(
      () => child.exitCode !== null || child.signalCode !== null,
      'the Host process never exited',
    )
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


  private static success(
    value: RemoteControlTabCommandDto,
  ): RemoteControlStepResult<RemoteControlTabCommandDto> {
    return { ok: true, value }
  }

  private static notFound(
    panelId: string,
  ): RemoteControlStepResult<RemoteControlTabCommandDto> {
    return {
      ok: false,
      error: { code: 'not-found', detail: `No tab ${JSON.stringify(panelId)}` },
    }
  }

}

void SmokeRemoteControl.run().catch((error: unknown) => SmokeRun.failed('smoke-remote-control', error))
