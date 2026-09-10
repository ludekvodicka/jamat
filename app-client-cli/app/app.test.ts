import { describe, expect, it } from 'vitest'

import type {
  RemoteControlComputerDto,
  RemoteControlDescriptor,
  RemoteControlError,
  RemoteControlLocalRequestUnion,
  RemoteControlLocalResponse,
  RemoteControlRequestUnion,
  RemoteControlResponse,
  RemoteControlSocketResponse,
} from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst, RemoteControlLocalConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteControlPairing } from '../../lib-orchestrator/remoteControl/remoteControlPairing'
import { RemoteControlPeerKeys } from '../../lib-orchestrator/remoteControl/remoteControlPeerKeys'
import type {
  SessionInfo,
  SessionsSnapshot,
} from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AppConfig } from './appConfig'
import type { CommitAsideRequest } from './commitAsideLauncher'
import {
  AppClientCli,
  type AppClientCliClientPort,
  type AppClientCliDeps,
} from './app'

class FakeCliClient implements AppClientCliClientPort {
  readonly requests: RemoteControlRequestUnion[] = []
  readonly localRequests: RemoteControlLocalRequestUnion[] = []
  readonly remoteRequests: { remoteEndpointId: string; request: RemoteControlRequestUnion }[] = []
  readonly watchCalls: { afterRevision?: number; signal?: AbortSignal }[] = []
  responseError: RemoteControlError | null = null
  computers: RemoteControlComputerDto[] = []
  sessions: SessionInfo[] = [
    FakeCliClient.session('session-001', '001', 'Q:/Apps/One'),
    FakeCliClient.session('session-007', '007', 'Q:/Apps/Seven'),
    FakeCliClient.session('session-014-015', '014-015', 'Q:/Apps/Fork'),
  ]
  invalidSessionsSnapshot = false

  execute(request: RemoteControlRequestUnion): Promise<RemoteControlResponse> {
    this.requests.push(request)
    if (this.responseError)
      return Promise.resolve({
        protocol: RemoteControlConst.protocol,
        requestId: request.requestId,
        operation: request.operation,
        operationId: request.operationId ?? null,
        ok: false,
        error: this.responseError,
      })
    return Promise.resolve({
      protocol: RemoteControlConst.protocol,
      requestId: request.requestId,
      operation: request.operation,
      operationId: request.operationId ?? null,
      ok: true,
      value: this.value(request.operation),
    } as RemoteControlResponse)
  }

  executeLocal(request: RemoteControlLocalRequestUnion): Promise<RemoteControlLocalResponse> {
    this.localRequests.push(request)
    return Promise.resolve({
      protocol: RemoteControlConst.protocol,
      requestId: request.requestId,
      operation: request.operation,
      operationId: request.operationId ?? null,
      ok: true,
      value: request.operation === 'remote.computers.list'
        ? { revision: 1, computers: this.computers }
        : { accepted: true },
    } as unknown as RemoteControlLocalResponse)
  }

  executeRemote(
    remoteEndpointId: string,
    request: RemoteControlRequestUnion,
  ): Promise<RemoteControlResponse> {
    this.remoteRequests.push({ remoteEndpointId, request })
    return Promise.resolve({
      protocol: RemoteControlConst.protocol,
      requestId: request.requestId,
      operation: request.operation,
      operationId: request.operationId ?? null,
      ok: true,
      value: this.value(request.operation),
    } as RemoteControlResponse)
  }

  private value(operation: RemoteControlRequestUnion['operation']): unknown {
    if (operation === 'sessions.list')
      return this.invalidSessionsSnapshot ? { sessions: [null] } : FakeCliClient.snapshot(this.sessions)
    if (operation === 'sessions.transcript')
      return {
        sessionId: 'session-001',
        transcriptContentUntrusted: true,
        reading: {
          kind: 'messages',
          messages: [{ role: 'assistant', text: 'untrusted result', at: 2_000, textTruncated: false }],
          bounds: { maxMessages: 10, maxCharactersPerMessage: 2_000, scannedBytes: 128 },
          earlierContentOmitted: false,
        },
      }
    return { accepted: true }
  }

  private static snapshot(sessions: SessionInfo[]): SessionsSnapshot {
    return {
      revision: 1,
      reconciled: true,
      host: {
        presence: 'running',
        hostVersion: '1.0.0',
        hostInstanceId: 'host-1',
        liveCount: sessions.filter((session) => session.life === 'live').length,
        lastStartError: null,
      },
      categories: [],
      sessions,
      orphans: [],
    }
  }

  private static session(
    sessionId: string,
    number: string,
    directory: string,
  ): SessionInfo {
    return {
      sessionId,
      kind: 'shell',
      title: `${number} Session`,
      titleParts: { number, name: 'Session' },
      tabTitle: `Project - ${number} Session`,
      directory: { mode: 'adHoc', path: directory },
      project: { kind: 'none' },
      life: 'ended',
      activity: null,
      admits: [],
    }
  }

  async watchEvents(options: {
    afterRevision?: number
    signal?: AbortSignal
    onMessage(message: Exclude<RemoteControlSocketResponse, { type: 'terminal.frame' }>): void
  }): Promise<{ ok: true; value: undefined }> {
    this.watchCalls.push({
      ...(options.afterRevision === undefined ? {} : { afterRevision: options.afterRevision }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    options.onMessage({
      protocol: RemoteControlConst.protocol,
      type: 'response',
      requestId: 'watch-1',
      operation: 'events.subscribe',
      operationId: null,
      ok: true,
      value: { throughRevision: 4, truncated: false },
    })
    options.onMessage({
      protocol: RemoteControlConst.protocol,
      type: 'event',
      event: { revision: 5, kind: 'tabs.changed', at: 5_000 },
    })
    return { ok: true, value: undefined }
  }
}

class CliHarness {
  readonly env: NodeJS.ProcessEnv = {}
  readonly asideCalls: CommitAsideRequest[] = []
  readonly writtenMessages: string[] = []
  messageInput = 'Message from file\n\nDetails'
  readonly client = new FakeCliClient()
  readonly output: string[] = []
  configLoads = 0
  discoveries = 0
  nextOperationId = 0
  nextRequestId = 0
  discoveryError: RemoteControlError | null = null
  jsonInput: unknown = {}
  readonly descriptor: RemoteControlDescriptor = {
    schemaVersion: 1,
    protocol: RemoteControlConst.protocol,
    address: '127.0.0.1',
    port: 12345,
    pid: 1,
    token: 'x'.repeat(32),
    operations: RemoteControlConst.operations,
    optionalOperations: RemoteControlConst.optionalOperations,
    localOperations: RemoteControlLocalConst.operations,
    websocket: true,
    configIdentity: 'config-1',
    runtimeChannel: 'development',
    instanceId: 'instance-1',
    startedAt: 1,
    applicationVersion: '1.0.0',
  }
  readonly config = {
    configDir: 'Q:\\Config',
    runtimeChannel: 'development',
    identity: {
      schemaVersion: 1,
      configIdentity: 'config-1',
      runtimeChannel: 'development',
      createdAt: '2026-08-21T00:00:00.000Z',
    },
  } as AppConfig

  deps(signal?: AbortSignal): AppClientCliDeps {
    return {
      env: this.env,
      cwd: () => 'Q:/Apps/One',
      readMessage: () => this.messageInput,
      writeMessageFile: async (text) => { this.writtenMessages.push(text); return 'Q:/temp/message.txt' },
      aside: { open: async (request) => { this.asideCalls.push(request); return { ok: true,
        value: { kind: 'opened-aside', tool: request.vcs === 'svn' ? 'tortoisesvn' : 'tortoisegit', scope: request.scope, reason: request.reason } } } },
      loadConfig: () => {
        this.configLoads += 1
        return this.config
      },
      discover: () => {
        this.discoveries += 1
        return this.discoveryError
          ? { ok: false, error: this.discoveryError }
          : { ok: true, value: this.descriptor }
      },
      client: () => this.client,
      operationId: () => `operation-${++this.nextOperationId}`,
      requestId: () => `request-${++this.nextRequestId}`,
      write: (value) => this.output.push(value),
      readJson: () => this.jsonInput,
      ...(signal === undefined ? {} : { signal }),
    }
  }

  parsedOutput(index = 0): Record<string, unknown> {
    return JSON.parse(this.output[index] ?? '') as Record<string, unknown>
  }

  static computer(overrides?: Partial<RemoteControlComputerDto>): RemoteControlComputerDto {
    return {
      profileId: 'profile-remote',
      remoteComputerId: 'computer-remote',
      remoteEndpointId: 'endpoint-remote',
      configIdentity: 'config-remote',
      runtimeChannel: 'development',
      displayName: 'Remote computer',
      endpoint: { host: 'remote.lan', port: 47_150 },
      status: 'connected',
      error: null,
      lastConnectedAt: 1_700_000_000_000,
      nextRetryAt: null,
      applicationVersion: '2026.08.31.10.00',
      optionalOperations: ['sessions.transcript'],
      sessionCount: 2,
      ...overrides,
    }
  }

  static pairingBundle() {
    const keys = RemoteControlPeerKeys.generateSigningKeyPair()
    return RemoteControlPairing.bundle({
      remoteComputerId: 'computer-paired',
      remoteEndpointId: 'endpoint-paired',
      configIdentity: 'config-paired',
      runtimeChannel: 'development',
      displayName: 'Paired computer',
      signing: {
        algorithm: 'ed25519',
        publicKey: keys.publicKey,
        fingerprint: RemoteControlPeerKeys.fingerprint(keys.publicKey),
      },
    }, { host: 'paired.lan', port: 47_151 })
  }
}

describe('app-client-cli/app/app', () => {
  it('opens a native SVN dialog for --self with the proposed message, without invoking the fallback', async () => {
    const harness = new CliHarness()
    harness.env.JAMAT_V3_SESSION_ID = 'session-001'
    harness.client.sessions[0] = { ...harness.client.sessions[0]!, life: 'live' }
    expect(await new AppClientCli(['commit-svn-jamat', '--self', '--message-file', 'proposal.txt'], harness.deps()).run()).toBe(0)
    expect(harness.client.requests).toMatchObject([{ operation: 'sessions.list' }, { operation: 'tabs.openCommit',
      body: { session: { kind: 'sessionId', sessionId: 'session-001' }, vcs: 'svn', message: harness.messageInput } }])
    expect(harness.asideCalls).toEqual([])
  })

  it.each(['unavailable', 'conflict', 'timeout', 'forbidden', 'operation-failed'] as const)('uses the aside only for discovery unavailable, not %s', async (code) => {
    const harness = new CliHarness()
    harness.discoveryError = { code, detail: 'Discovery refused' }
    await new AppClientCli(['commit-svn-jamat', '--self', '--message', 'Český návrh\n\nBody'], harness.deps()).run()
    if (code === 'unavailable') {
      expect(harness.asideCalls).toMatchObject([{ vcs: 'svn', messageFile: 'Q:/temp/message.txt', reason: 'jamat-unavailable' }])
      expect(harness.writtenMessages).toEqual(['Český návrh\n\nBody'])
      expect(harness.parsedOutput()).toMatchObject({ ok: true, value: { kind: 'opened-aside', tool: 'tortoisesvn' } })
    } else expect(harness.asideCalls).toEqual([])
  })

  it.each(['absent', 'ended'] as const)('opens TortoiseGit for an %s session and sends no commit operation', async (state) => {
    const harness = new CliHarness()
    if (state === 'absent') harness.client.sessions = []
    expect(await new AppClientCli(['commit-git-jamat', '--session-id', 'session-001'], harness.deps()).run()).toBe(0)
    expect(harness.asideCalls).toMatchObject([{ vcs: 'git', reason: 'session-not-open' }])
    expect(harness.client.requests.map((request) => request.operation)).toEqual(['sessions.list'])
  })

  it('reports capability, listing and ambiguous selector failures without a fallback', async () => {
    const old = new CliHarness()
    old.descriptor.optionalOperations = []
    expect(await new AppClientCli(['commit-svn-jamat', '--self'], old.deps()).run()).toBe(6)
    expect(old.asideCalls).toEqual([])
    const listing = new CliHarness()
    listing.client.responseError = { code: 'unavailable', detail: 'List unavailable' }
    expect(await new AppClientCli(['commit-svn-jamat', '--session-id', 'session-001'], listing.deps()).run()).toBe(6)
    expect(listing.asideCalls).toEqual([])
    const ambiguous = new CliHarness()
    ambiguous.client.sessions.push({ ...ambiguous.client.sessions[0]!, sessionId: 'other' })
    expect(await new AppClientCli(['commit-svn-jamat', '--number', '001'], ambiguous.deps()).run()).toBe(4)
    expect(ambiguous.asideCalls).toEqual([])
  })

  it.each([
    ['--self', '--session-id', 'one'], ['--self', '--config-dir', 'Q:/config'], ['--self', '--number', '001'],
    ['--self', '--message', 'one', '--message-file', 'two'], ['--self', '--computer', 'remote'], ['--self', '--unknown'],
    ['--self', '--message', 'x'.repeat(16_385)],
  ])('rejects invalid commit arguments before discovery: %j', async (...args) => {
    const harness = new CliHarness()
    expect(await new AppClientCli(['commit-svn-jamat', ...args], harness.deps()).run()).toBe(2)
    expect(harness.discoveries).toBe(0)
    expect(harness.asideCalls).toEqual([])
  })

  it('rejects unknown and command-specific arguments before config discovery', async () => {
    const unknown = new CliHarness()
    const wrongCommand = new CliHarness()

    expect(await new AppClientCli(
      ['status', '--config-dirr', 'Q:\\Wrong'],
      unknown.deps(),
    ).run()).toBe(2)
    expect(await new AppClientCli(
      ['sessions', 'list', '--panel-id', 'x'],
      wrongCommand.deps(),
    ).run()).toBe(2)
    expect(unknown.configLoads).toBe(0)
    expect(wrongCommand.configLoads).toBe(0)
    expect(unknown.parsedOutput()).toMatchObject({
      protocol: RemoteControlConst.protocol,
      ok: false,
      error: { code: 'invalid-request' },
    })
  })

  it('rejects config directory and config identity selectors together before discovery', async () => {
    const harness = new CliHarness()

    expect(await new AppClientCli([
      'status',
      '--config-dir', 'Q:\\Config',
      '--config-identity', 'identity-a',
    ], harness.deps()).run()).toBe(2)
    expect(harness.configLoads).toBe(0)
    expect(harness.discoveries).toBe(0)
    expect(harness.parsedOutput()).toMatchObject({
      ok: false,
      error: { code: 'invalid-request', detail: expect.stringContaining('mutually exclusive') },
    })
  })

  it('maps every HTTP command to its operation and keeps explicit selectors', async () => {
    const cases: { args: string[]; operation: RemoteControlRequestUnion['operation'] }[] = [
      { args: [], operation: 'system.status' },
      { args: ['projects', 'list', '--category-id', 'apps', '--sort', 'recent'], operation: 'projects.list' },
      { args: ['sessions', 'list'], operation: 'sessions.list' },
      { args: ['sessions', 'create', '--directory', 'Q:\\One'], operation: 'sessions.create' },
      { args: ['sessions', 'reopen', '--session-id', 'session-1'], operation: 'sessions.reopen' },
      { args: ['sessions', 'finalize', '--number', '001'], operation: 'sessions.finalize' },
      { args: ['sessions', 'transcript', '--session-id', 'session-001'], operation: 'sessions.transcript' },
      { args: ['tabs', 'list'], operation: 'tabs.list' },
      { args: ['tabs', 'open', '--number', '001'], operation: 'tabs.open' },
      {
        args: ['tabs', 'open-file', '--number', '001', '--path', 'reports/report.md'],
        operation: 'tabs.openFile',
      },
      { args: ['tabs', 'focus', '--panel-id', 'terminal:{}'], operation: 'tabs.focus' },
      { args: ['tabs', 'close', '--panel-id', 'terminal:{}'], operation: 'tabs.close' },
      { args: ['terminal', 'peek', '--session-id', 'session-1'], operation: 'terminal.peek' },
      {
        args: ['terminal', 'send', '--number', '001', '--text', 'status', '--enter'],
        operation: 'terminal.send',
      },
    ]
    for (const item of cases) {
      const harness = new CliHarness()
      expect(await new AppClientCli(item.args, harness.deps()).run()).toBe(0)
      expect(harness.client.requests.at(-1)?.operation).toBe(item.operation)
      expect(harness.output).toHaveLength(1)
      expect(harness.parsedOutput()).toMatchObject({ ok: true, operation: item.operation })
    }
  })

  it('lists remote computers and routes an eligible command through the selected endpoint', async () => {
    const listed = new CliHarness()
    listed.client.computers = [CliHarness.computer()]
    expect(await new AppClientCli(['remote', 'computers', 'list'], listed.deps()).run()).toBe(0)
    expect(listed.client.localRequests).toMatchObject([{ operation: 'remote.computers.list' }])

    const routed = new CliHarness()
    routed.client.computers = [CliHarness.computer()]
    expect(await new AppClientCli(
      ['sessions', 'list', '--computer', 'Remote computer'],
      routed.deps(),
    ).run()).toBe(0)
    expect(routed.client.requests).toEqual([])
    expect(routed.client.localRequests).toMatchObject([{ operation: 'remote.computers.list' }])
    expect(routed.client.remoteRequests).toMatchObject([{
      remoteEndpointId: 'endpoint-remote',
      request: { operation: 'sessions.list' },
    }])
  })

  it('requires an unambiguous computer and rejects local tab presentation for remote create', async () => {
    const ambiguous = new CliHarness()
    ambiguous.client.computers = [
      CliHarness.computer({ profileId: 'profile-a', remoteEndpointId: 'endpoint-a' }),
      CliHarness.computer({ profileId: 'profile-b', remoteEndpointId: 'endpoint-b' }),
    ]
    expect(await new AppClientCli(
      ['status', '--computer', 'computer-remote'],
      ambiguous.deps(),
    ).run()).toBe(4)
    expect(ambiguous.client.remoteRequests).toEqual([])
    expect(ambiguous.parsedOutput()).toMatchObject({
      ok: false,
      error: { code: 'conflict', data: { candidates: expect.any(Array) } },
    })

    const localOnly = new CliHarness()
    expect(await new AppClientCli(
      ['sessions', 'create', '--computer', 'computer-remote', '--open-tab'],
      localOnly.deps(),
    ).run()).toBe(2)
    expect(localOnly.configLoads).toBe(0)

    const tabs = new CliHarness()
    expect(await new AppClientCli(
      ['tabs', 'list', '--computer', 'computer-remote'],
      tabs.deps(),
    ).run()).toBe(2)
    expect(tabs.configLoads).toBe(0)
  })

  it('exports pairing and imports a raw or exported bundle through the local API', async () => {
    const exported = new CliHarness()
    expect(await new AppClientCli(['remote', 'pairing', 'export'], exported.deps()).run()).toBe(0)
    expect(exported.client.localRequests).toMatchObject([{ operation: 'remote.pairing.export' }])

    const imported = new CliHarness()
    const bundle = CliHarness.pairingBundle()
    imported.jsonInput = {
      protocol: RemoteControlConst.protocol,
      requestId: 'exported',
      operation: 'remote.pairing.export',
      operationId: null,
      ok: true,
      value: bundle,
    }
    expect(await new AppClientCli([
      'remote', 'pairing', 'import',
      '--file', 'pairing.json',
      '--operation-id', 'pairing-import',
    ], imported.deps()).run()).toBe(0)
    expect(imported.client.localRequests[0]).toMatchObject({
      operation: 'remote.pairing.import',
      operationId: 'pairing-import',
      body: { bundle },
    })
    expect(imported.client.localRequests[0]?.body).not.toHaveProperty('enabled')
    expect(imported.client.localRequests[0]?.body).not.toHaveProperty('role')
  })

  /**
   * An import grants ONE direction and carries no right to name, so the two words that used to name
   * one are not narrower arguments now - they are arguments this CLI has never heard of, refused by
   * the parser before a config directory is even looked for.
   */
  it('refuses the retired --role and --disabled as unknown, before discovery', async () => {
    for (const extra of [['--role', 'allow'], ['--disabled']]) {
      const harness = new CliHarness()
      harness.jsonInput = CliHarness.pairingBundle()

      expect(await new AppClientCli(
        ['remote', 'pairing', 'import', '--file', 'pairing.json', ...extra],
        harness.deps(),
      ).run()).toBe(2)

      expect(harness.configLoads).toBe(0)
      expect(harness.client.localRequests).toEqual([])
      expect(harness.parsedOutput()).toMatchObject({
        ok: false,
        error: { code: 'invalid-request' },
      })
    }
  })

  /*
   * A plain session lives in its tab: the tree does not carry one, so a plain session created
   * without a tab is invisible from the moment it starts and nothing ever cleans it up. The create
   * path already knew this - it discards the session when the tab fails to open - but asking for
   * exactly that state up front went through.
   */
  it('refuses --plain without --open-tab before it reaches the server', async () => {
    const harness = new CliHarness()

    expect(await new AppClientCli(
      ['sessions', 'create', '--directory', 'Q:\One', '--plain'],
      harness.deps(),
    ).run()).toBe(2)

    expect(harness.client.requests).toEqual([])
    expect(harness.parsedOutput()).toMatchObject({
      ok: false,
      error: { code: 'invalid-request', detail: '--plain requires --open-tab' },
    })
  })

  it('builds the full create spec and reports the actual operation id on unavailable retry', async () => {
    const args = [
      'sessions', 'create',
      '--category-id', 'apps',
      '--project-path', 'Q:\\Apps\\One',
      '--agent', 'codex',
      '--mode', 'resume',
      '--native-session-id', 'native-1',
      '--prompt', 'continue',
      '--worktree', 'task-1',
      '--base-ref', 'main',
      '--title', 'Work',
      '--flow-id', 'flow-1',
      '--plain',
      '--open-tab',
      '--operation-id', 'caller-operation',
    ]
    const built = new CliHarness()
    expect(await new AppClientCli(args, built.deps()).run()).toBe(0)
    expect(built.client.requests[0]).toMatchObject({
      operation: 'sessions.create',
      operationId: 'caller-operation',
      body: {
        openTab: true,
        spec: {
          kind: 'agent',
          directory: {
            mode: 'project',
            categoryId: 'apps',
            projectPath: 'Q:\\Apps\\One',
          },
          agent: {
            agentId: 'codex',
            mode: 'resume',
            nativeSessionId: 'native-1',
            initialPrompt: 'continue',
          },
          worktree: { slug: 'task-1', baseRef: 'main' },
          title: 'Work',
          flowId: 'flow-1',
          presentation: 'tab',
        },
      },
    })

    const harness = new CliHarness()
    harness.discoveryError = { code: 'unavailable', detail: 'AppClientUI is not running' }
    const exit = await new AppClientCli(args, harness.deps()).run()

    expect(exit).toBe(6)
    expect(harness.parsedOutput()).toMatchObject({
      operation: 'sessions.create',
      operationId: 'caller-operation',
      ok: false,
      error: { code: 'unavailable' },
    })
    expect(harness.client.requests).toEqual([])
  })

  it('mints a mutation id once and validates exact three-digit session numbers', async () => {
    const harness = new CliHarness()
    expect(await new AppClientCli(
      ['terminal', 'send', '--number', '007', '--text', 'x'],
      harness.deps(),
    ).run()).toBe(0)
    expect(harness.client.requests.at(-1)).toMatchObject({
      operationId: 'operation-1',
      body: { session: { kind: 'sessionId', sessionId: 'session-007' }, text: 'x' },
    })

    const invalid = new CliHarness()
    expect(await new AppClientCli(
      ['terminal', 'peek', '--number', '7'],
      invalid.deps(),
    ).run()).toBe(2)
    expect(invalid.configLoads).toBe(0)
  })

  it('accepts fork numbers and canonicalizes local numbers through sessions.list', async () => {
    const harness = new CliHarness()

    expect(await new AppClientCli(
      ['sessions', 'finalize', '--number', '014-015'],
      harness.deps(),
    ).run()).toBe(0)
    expect(harness.client.requests).toMatchObject([
      { operation: 'sessions.list' },
      {
        operation: 'sessions.finalize',
        body: { session: { kind: 'sessionId', sessionId: 'session-014-015' } },
      },
    ])
  })

  it('reads transcripts by exact id or canonical number and leaves ambiguous numbers unread', async () => {
    const exact = new CliHarness()
    const numbered = new CliHarness()
    const ambiguous = new CliHarness()
    ambiguous.client.sessions = [
      ...ambiguous.client.sessions,
      {
        ...ambiguous.client.sessions[0]!,
        sessionId: 'session-001-other',
        directory: { mode: 'adHoc', path: 'Q:/Apps/Other' },
      },
    ]

    expect(await new AppClientCli(
      ['sessions', 'transcript', '--session-id', 'session-001'],
      exact.deps(),
    ).run()).toBe(0)
    expect(exact.client.requests).toMatchObject([{
      operation: 'sessions.transcript',
      body: { session: { kind: 'sessionId', sessionId: 'session-001' } },
    }])
    expect(exact.parsedOutput()).toMatchObject({
      ok: true,
      value: {
        transcriptContentUntrusted: true,
        reading: { kind: 'messages', messages: [{ text: 'untrusted result' }] },
      },
    })

    expect(await new AppClientCli(
      ['sessions', 'transcript', '--number', '001'],
      numbered.deps(),
    ).run()).toBe(0)
    expect(numbered.client.requests).toMatchObject([
      { operation: 'sessions.list' },
      {
        operation: 'sessions.transcript',
        body: { session: { kind: 'sessionId', sessionId: 'session-001' } },
      },
    ])

    expect(await new AppClientCli(
      ['sessions', 'transcript', '--number', '001'],
      ambiguous.deps(),
    ).run()).toBe(4)
    expect(ambiguous.client.requests).toMatchObject([{ operation: 'sessions.list' }])
    expect(ambiguous.client.requests).toHaveLength(1)
  })

  it('rejects remote transcript selection before discovery and old descriptors before HTTP', async () => {
    const remote = new CliHarness()
    const old = new CliHarness()
    old.descriptor.optionalOperations = undefined

    expect(await new AppClientCli([
      'sessions',
      'transcript',
      '--session-id',
      'session-001',
      '--computer',
      'computer-remote',
    ], remote.deps()).run()).toBe(2)
    expect(remote.configLoads).toBe(0)
    expect(remote.discoveries).toBe(0)
    expect(remote.client.requests).toEqual([])

    expect(await new AppClientCli(
      ['sessions', 'transcript', '--number', '001'],
      old.deps(),
    ).run()).toBe(6)
    expect(old.discoveries).toBe(1)
    expect(old.client.requests).toEqual([])
    expect(old.parsedOutput()).toMatchObject({
      ok: false,
      operation: 'sessions.transcript',
      error: { code: 'unavailable' },
    })
  })

  it('uses the selected remote endpoint for both listing and canonical execution', async () => {
    const harness = new CliHarness()
    harness.client.computers = [CliHarness.computer()]

    expect(await new AppClientCli([
      'terminal',
      'peek',
      '--number',
      '001',
      '--computer',
      'endpoint-remote',
    ], harness.deps()).run()).toBe(0)
    expect(harness.client.requests).toEqual([])
    expect(harness.client.localRequests).toMatchObject([{ operation: 'remote.computers.list' }])
    expect(harness.client.remoteRequests).toMatchObject([
      { remoteEndpointId: 'endpoint-remote', request: { operation: 'sessions.list' } },
      {
        remoteEndpointId: 'endpoint-remote',
        request: {
          operation: 'terminal.peek',
          body: { session: { kind: 'sessionId', sessionId: 'session-001' } },
        },
      },
    ])
  })

  it('uses working directory only as an exact number disambiguator', async () => {
    const harness = new CliHarness()
    harness.client.sessions = [
      {
        ...harness.client.sessions[0]!,
        sessionId: 'session-root',
        directory: { mode: 'adHoc', path: 'Q:/Apps/One' },
      },
      {
        ...harness.client.sessions[0]!,
        sessionId: 'session-child',
        directory: { mode: 'adHoc', path: 'Q:/Apps/One/Child' },
      },
    ]

    expect(await new AppClientCli([
      'sessions',
      'reopen',
      '--number',
      '001',
      '--working-directory',
      'Q:/Apps/One',
    ], harness.deps()).run()).toBe(0)
    expect(harness.client.requests.at(-1)).toMatchObject({
      operation: 'sessions.reopen',
      body: { session: { kind: 'sessionId', sessionId: 'session-root' } },
    })
  })

  it('rejects working directory with a session id or a non-selector command before discovery', async () => {
    const withId = new CliHarness()
    const nonSelector = new CliHarness()
    const empty = new CliHarness()

    expect(await new AppClientCli([
      'terminal',
      'peek',
      '--session-id',
      'session-1',
      '--working-directory',
      'Q:/Apps/One',
    ], withId.deps()).run()).toBe(2)
    expect(await new AppClientCli([
      'sessions',
      'list',
      '--working-directory',
      'Q:/Apps/One',
    ], nonSelector.deps()).run()).toBe(2)
    expect(await new AppClientCli([
      'terminal',
      'peek',
      '--number',
      '001',
      '--working-directory',
      '',
    ], empty.deps()).run()).toBe(2)
    expect(withId.configLoads).toBe(0)
    expect(nonSelector.configLoads).toBe(0)
    expect(empty.configLoads).toBe(0)
  })

  it('stops before the selected operation when sessions.list is invalid', async () => {
    const harness = new CliHarness()
    harness.client.invalidSessionsSnapshot = true

    expect(await new AppClientCli(
      ['terminal', 'peek', '--number', '001'],
      harness.deps(),
    ).run()).toBe(7)
    expect(harness.client.requests).toMatchObject([{ operation: 'sessions.list' }])
    expect(harness.parsedOutput()).toMatchObject({
      ok: false,
      operation: 'terminal.peek',
      error: { code: 'operation-failed' },
    })
  })

  it('does not treat the local display computer as an implicit selector', async () => {
    const harness = new CliHarness()

    expect(await new AppClientCli(
      ['terminal', 'peek', '--number', '001', '--computer', 'Local computer'],
      harness.deps(),
    ).run()).toBe(3)
    expect(harness.client.requests).toEqual([])
    expect(harness.client.remoteRequests).toEqual([])
    expect(harness.parsedOutput()).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    })
  })

  it('builds tabs open-file with a path and rejects undeclared placement before discovery', async () => {
    const harness = new CliHarness()
    expect(await new AppClientCli([
      'tabs',
      'open-file',
      '--number',
      '001',
      '--path',
      'reports/report.md',
    ], harness.deps()).run()).toBe(0)
    expect(harness.client.requests.at(-1)).toMatchObject({
      operation: 'tabs.openFile',
      operationId: 'operation-1',
      body: {
        session: { kind: 'sessionId', sessionId: 'session-001' },
        path: 'reports/report.md',
      },
    })

    const invalid = new CliHarness()
    expect(await new AppClientCli([
      'tabs',
      'open-file',
      '--number',
      '001',
      '--path',
      'reports/report.md',
      '--placement',
      'split',
    ], invalid.deps()).run()).toBe(2)
    expect(invalid.configLoads).toBe(0)
  })

  it('maps every stable error code to its documented exit code', async () => {
    const cases: [RemoteControlError['code'], number][] = [
      ['invalid-request', 2],
      ['not-found', 3],
      ['conflict', 4],
      ['timeout', 5],
      ['unavailable', 6],
      ['protocol-mismatch', 7],
      ['forbidden', 7],
      ['operation-failed', 7],
    ]
    for (const [code, exit] of cases) {
      const harness = new CliHarness()
      harness.client.responseError = { code, detail: `error-${code}` }
      expect(await new AppClientCli(['status'], harness.deps()).run()).toBe(exit)
      expect(harness.parsedOutput()).toMatchObject({ ok: false, error: { code } })
    }
  })

  it('writes event watch output as versioned JSON lines and forwards the cursor and signal', async () => {
    const harness = new CliHarness()
    const abort = new AbortController()
    const exit = await new AppClientCli(
      ['events', 'watch', '--after-revision', '4'],
      harness.deps(abort.signal),
    ).run()

    expect(exit).toBe(0)
    expect(harness.client.watchCalls).toEqual([{
      afterRevision: 4,
      signal: abort.signal,
    }])
    expect(harness.output.map((line) => JSON.parse(line))).toMatchObject([
      { protocol: RemoteControlConst.protocol, type: 'response', ok: true },
      { protocol: RemoteControlConst.protocol, type: 'event', event: { revision: 5 } },
    ])
  })
})
