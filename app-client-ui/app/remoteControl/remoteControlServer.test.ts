import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { request as nodeRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectListResult } from '../../../lib-orchestrator/projectManager/projectManagerApi.types'
import { RemoteControl, type RemoteControlDeps } from '../../../lib-orchestrator/remoteControl/remoteControl'
import type {
  RemoteControlDescriptor,
  RemoteControlRequestUnion,
  RemoteControlResponse,
  RemoteControlSocketResponse,
  RemoteControlStepResult,
  RemoteControlSystemIdentity,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst, RemoteControlLocalConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteControlPairing } from '../../../lib-orchestrator/remoteControl/remoteControlPairing'
import { RemoteControlPeerKeys } from '../../../lib-orchestrator/remoteControl/remoteControlPeerKeys'
import { RemoteControlInstanceStore } from './remoteControlInstanceStore'
import type {
  RemoteControlLiveTerminalAttachDto,
  RemoteControlLiveTerminalInputDto,
  RemoteControlLiveTerminalResizeDto,
} from '../../../lib-orchestrator/remoteControl/remoteControlTerminal'
import type {
  SessionInfo,
  SessionsSnapshot,
  TerminalAttachSpec,
  TerminalFrame,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { RemoteControlServer } from './remoteControlServer'

interface LiveAttach {
  ownerId: string
  attachId: string
  spec: TerminalAttachSpec
  onFrame(frame: TerminalFrame): void
}

class FakeLiveTerminal {
  readonly attachments = new Map<string, LiveAttach>()
  readonly inputs: { ownerId: string; attachId: string; data: string }[] = []
  readonly resizes: { ownerId: string; attachId: string; cols: number; rows: number }[] = []
  readonly active: { ownerId: string; attachId: string; active: boolean }[] = []
  readonly detachedOwners: string[] = []
  readOnly = false

  attachLive(
    ownerId: string,
    attachId: string,
    spec: TerminalAttachSpec,
    onFrame: (frame: TerminalFrame) => void,
  ): RemoteControlStepResult<RemoteControlLiveTerminalAttachDto> {
    const key = FakeLiveTerminal.key(ownerId, attachId)
    if (this.attachments.has(key))
      return { ok: false, error: { code: 'conflict', detail: 'already attached' } }
    this.attachments.set(key, { ownerId, attachId, spec, onFrame })
    return { ok: true, value: { attachId, sessionId: spec.sessionId } }
  }

  inputLive(
    ownerId: string,
    attachId: string,
    data: string,
  ): RemoteControlStepResult<RemoteControlLiveTerminalInputDto> {
    if (!this.attachments.has(FakeLiveTerminal.key(ownerId, attachId)))
      return { ok: false, error: { code: 'not-found', detail: 'missing attach' } }
    if (this.readOnly)
      return { ok: false, error: { code: 'conflict', detail: 'read-only' } }
    this.inputs.push({ ownerId, attachId, data })
    return { ok: true, value: { attachId, accepted: true, characterCount: data.length } }
  }

  resizeLive(
    ownerId: string,
    attachId: string,
    cols: number,
    rows: number,
  ): RemoteControlStepResult<RemoteControlLiveTerminalResizeDto> {
    this.resizes.push({ ownerId, attachId, cols, rows })
    return { ok: true, value: { attachId, accepted: true, applied: true } }
  }

  setLiveActive(
    ownerId: string,
    attachId: string,
    active: boolean,
  ): RemoteControlStepResult<RemoteControlLiveTerminalResizeDto> {
    this.active.push({ ownerId, attachId, active })
    return { ok: true, value: { attachId, accepted: true, applied: true } }
  }

  detachLive(ownerId: string, attachId: string): RemoteControlStepResult<{ attachId: string }> {
    const key = FakeLiveTerminal.key(ownerId, attachId)
    if (!this.attachments.delete(key))
      return { ok: false, error: { code: 'not-found', detail: 'missing attach' } }
    return { ok: true, value: { attachId } }
  }

  detachOwner(ownerId: string): void {
    this.detachedOwners.push(ownerId)
    for (const [key, attachment] of this.attachments)
      if (attachment.ownerId === ownerId) this.attachments.delete(key)
  }

  emit(attachId: string, frame: TerminalFrame): void {
    const attachment = [...this.attachments.values()].find((entry) => entry.attachId === attachId)
    if (!attachment) throw new Error(`No attach ${attachId}`)
    attachment.onFrame(frame)
  }

  private static key(ownerId: string, attachId: string): string {
    return `${ownerId}\0${attachId}`
  }
}

class SocketInbox {
  readonly messages: RemoteControlSocketResponse[] = []
  private readonly waiters = new Set<() => void>()

  constructor(socket: WebSocket) {
    socket.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()) as RemoteControlSocketResponse)
      for (const waiter of this.waiters) waiter()
    })
  }

  wait(
    predicate: (message: RemoteControlSocketResponse) => boolean,
    timeoutMilliseconds = 1_000,
  ): Promise<RemoteControlSocketResponse> {
    const existing = this.messages.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check)
        reject(new Error(`WebSocket answer timed out: ${JSON.stringify(this.messages)}`))
      }, timeoutMilliseconds)
      const check = (): void => {
        const found = this.messages.find(predicate)
        if (!found) return
        clearTimeout(timer)
        this.waiters.delete(check)
        resolve(found)
      }
      this.waiters.add(check)
    })
  }
}

class RemoteControlServerHarness {
  readonly root = mkdtempSync(join(tmpdir(), 'jamat-v3-control-'))
  readonly descriptorFile = join(this.root, 'control-descriptors', 'instance-test.json')
  readonly compatibilityDescriptorFile = join(this.root, 'remote-control.json')
  readonly registryFile = join(this.root, 'registry.json')
  readonly auditFile = join(this.root, 'audit.jsonl')
  readonly terminal = new FakeLiveTerminal()
  readonly errors: string[] = []
  readonly sentText: string[] = []
  readonly transcriptReads: string[] = []
  readonly identity: RemoteControlSystemIdentity = {
    configIdentity: 'config-test',
    runtimeChannel: 'development',
    instanceId: 'instance-test',
    startedAt: 1_000,
    applicationVersion: '3.0.0-test',
  }
  readonly control: RemoteControl
  readonly server: RemoteControlServer
  readonly remoteExecutions: { remoteEndpointId: string; request: RemoteControlRequestUnion }[] = []
  creates = 0
  pairingImports = 0
  descriptor: RemoteControlDescriptor | null = null

  constructor(
    eventLimit = 2,
    withLocalManagement = false,
    instanceStore?: Pick<RemoteControlInstanceStore, 'write' | 'removeIfOwned'>,
  ) {
    const session = RemoteControlServerHarness.session()
    const sessions = [session]
    const listing: ProjectListResult = {
      entries: [],
      projects: [],
      virtualFolders: [],
      truncated: false,
      available: true,
    }
    const deps: RemoteControlDeps = {
      system: { identity: () => this.identity },
      projects: {
        listCategories: async () => [],
        listProjects: async () => ({ ok: true, value: listing }),
      },
      sessions: {
        snapshot: () => RemoteControlServerHarness.snapshot(sessions),
        createSession: async () => {
          this.creates += 1
          return { ok: true, value: { sessionId: `created-${this.creates}`, tabTitle: 'Created' } }
        },
        reopenSession: async () => ({ ok: true, value: undefined }),
        finalizeSession: async () => ({ ok: true, value: undefined }),
        discardPlainSession: async () => ({ ok: true, value: undefined }),
      },
      tabs: {
        list: async () => [],
        open: async () => ({
          ok: true,
          value: { kind: 'opened', panelId: 'terminal:{}', windowId: 'main' },
        }),
        openFile: async () => ({
          ok: true,
          value: {
            kind: 'file-opened',
            panelId: 'terminal:{}',
            windowId: 'main',
            path: 'Q:\\Proven\\report.md',
          },
        }),
        focus: async () => ({
          ok: true,
          value: { kind: 'focused-existing', panelId: 'terminal:{}', windowId: 'main' },
        }),
        close: async () => ({
          ok: true,
          value: { kind: 'closed', panelId: 'terminal:{}', windowId: 'main' },
        }),
      },
      terminal: {
        peek: async (sessionId) => ({
          ok: true,
          value: {
            sessionId,
            snapshot: {
              type: 'terminal.snapshot',
              projection: {
                runtimeSessionId: 'runtime-1',
                generation: 1,
                outputEpoch: 1,
                outputSeq: 1,
                screen: 'terminal-secret-output',
                screenTruncated: false,
                cols: 80,
                rows: 24,
                alive: true,
                lastOutputAt: 2,
              },
            },
            terminalOutputUntrusted: true,
          },
        }),
        send: async (sessionId, text, options) => {
          this.sentText.push(text)
          return {
            ok: true,
            value: {
              sessionId,
              accepted: true,
              characterCount: text.length,
              enter: options.enter,
            },
          }
        },
      },
      transcript: {
        read: async (sessionId) => {
          this.transcriptReads.push(sessionId)
          return {
            kind: 'messages',
            messages: [{
              role: 'assistant',
              text: 'secret transcript message',
              at: 2_000,
              textTruncated: false,
            }],
            bounds: { maxMessages: 10, maxCharactersPerMessage: 2_000, scannedBytes: 256 },
            earlierContentOmitted: true,
          }
        },
      },
      agents: {
        describe: () => ({
          agents: [{
            agentId: 'claude',
            configuredModel: 'opus',
            models: [{
              id: 'opus',
              label: 'Opus (newest)',
              kind: 'alias',
              context: 200_000,
              efforts: ['low', 'high'],
            }],
          }],
        }),
      },
      onError: (message) => this.errors.push(message),
    }
    this.control = new RemoteControl(deps)
    const signing = RemoteControlPeerKeys.generateSigningKeyPair()
    const pairingBundle = RemoteControlPairing.bundle({
      remoteComputerId: 'computer-local',
      remoteEndpointId: 'endpoint-local',
      configIdentity: 'config-test',
      runtimeChannel: 'development',
      displayName: 'Local computer',
      signing: {
        algorithm: 'ed25519',
        publicKey: signing.publicKey,
        fingerprint: RemoteControlPeerKeys.fingerprint(signing.publicKey),
      },
    }, { host: 'local.lan', port: 47_150 })
    this.server = new RemoteControlServer({
      identity: this.identity,
      control: this.control,
      terminal: this.terminal,
      descriptorFile: this.descriptorFile,
      compatibilityDescriptorFile: this.compatibilityDescriptorFile,
      instanceStore: instanceStore ?? new RemoteControlInstanceStore(this.registryFile),
      auditFile: this.auditFile,
      onError: (message) => this.errors.push(message),
      token: () => 'local-control-token',
      socketId: (() => {
        let next = 0
        return () => `socket-${++next}`
      })(),
      eventLimit,
      ...(withLocalManagement ? {
        local: {
          snapshot: () => ({
            revision: 7,
            outbound: [{
              profileId: 'profile-remote',
              remoteComputerId: 'computer-remote',
              remoteEndpointId: 'endpoint-remote',
              configIdentity: 'config-remote',
              runtimeChannel: 'development' as const,
              displayName: 'Remote computer',
              endpoint: { host: 'remote.lan', port: 47_151 },
              status: 'connected' as const,
              error: null,
              lastConnectedAt: 1_700_000_000_000,
              nextRetryAt: null,
              applicationVersion: '2026.08.31.10.00',
              optionalOperations: ['sessions.transcript' as const],
              connectionId: 'connection-1',
              sessions: RemoteControlServerHarness.snapshot([session]),
            }],
            inbound: [],
          }),
          execute: (remoteEndpointId: string, request: RemoteControlRequestUnion) => {
            this.remoteExecutions.push({ remoteEndpointId, request })
            return Promise.resolve({
              protocol: RemoteControlConst.protocol,
              requestId: request.requestId,
              operation: request.operation,
              operationId: request.operationId ?? null,
              ok: true as const,
              value: { routed: true },
            } as unknown as RemoteControlResponse)
          },
          pairingBundle: () => structuredClone(pairingBundle),
          // Awaited in production because it waits on a person; the stub answers at once.
          importPairing: (bundle: unknown) => {
            this.pairingImports += 1
            return Promise.resolve({
              ok: true as const,
              value: RemoteControlPairing.profile(bundle),
            })
          },
        },
      } : {}),
    })
  }

  async start(): Promise<RemoteControlDescriptor> {
    this.descriptor = await this.server.start()
    return this.descriptor
  }

  async stop(): Promise<void> {
    await this.server.stop()
    rmSync(this.root, { recursive: true, force: true })
  }

  async fetch(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    if (!this.descriptor) throw new Error('Harness has not started')
    return fetch(`http://127.0.0.1:${this.descriptor.port}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.descriptor.token}`,
        ...init?.headers,
      },
    })
  }

  async socket(): Promise<{ socket: WebSocket; inbox: SocketInbox }> {
    if (!this.descriptor) throw new Error('Harness has not started')
    const socket = new WebSocket(`ws://127.0.0.1:${this.descriptor.port}/api/v3/ws`, {
      headers: { Authorization: `Bearer ${this.descriptor.token}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    return { socket, inbox: new SocketInbox(socket) }
  }

  rawGet(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    if (!this.descriptor) throw new Error('Harness has not started')
    return new Promise((resolve, reject) => {
      const request = nodeRequest({
        hostname: '127.0.0.1',
        port: this.descriptor?.port,
        path,
        method: 'GET',
        headers,
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      request.on('error', reject)
      request.end()
    })
  }

  static request(
    operation: string,
    body: Record<string, unknown>,
    operationId?: string,
    requestId = `request-${operation}`,
  ): string {
    return JSON.stringify({
      protocol: RemoteControlConst.protocol,
      requestId,
      operation,
      ...(operationId === undefined ? {} : { operationId }),
      body,
    })
  }

  private static session(): SessionInfo {
    return {
      sessionId: 'session-1',
      kind: 'shell',
      title: '001 - shell',
      titleParts: { number: '001', name: 'shell' },
      tabTitle: 'Project - 001 - shell',
      directory: { mode: 'default' },
      project: { kind: 'adHoc', path: 'Q:\\Project' },
      life: 'live',
      activity: null,
      admits: [],
    }
  }

  private static snapshot(sessions: SessionInfo[]): SessionsSnapshot {
    return {
      revision: 1,
      reconciled: true,
      host: {
        presence: 'running',
        hostVersion: '1.0.0',
        hostInstanceId: 'host-1',
        liveCount: sessions.length,
        lastStartError: null,
      },
      categories: [],
      sessions,
      orphans: [],
    }
  }
}

describe('app-client-ui/app/remoteControl/remoteControlServer', () => {
  const harnesses: RemoteControlServerHarness[] = []

  afterEach(async () => {
    for (const harness of harnesses.splice(0))
      await harness.stop()
  })

  it('publishes private and compatibility descriptors and removes only the private one', async () => {
    const harness = new RemoteControlServerHarness()
    harnesses.push(harness)
    const descriptor = await harness.start()

    expect(descriptor).toMatchObject({
      schemaVersion: 1,
      protocol: RemoteControlConst.protocol,
      address: '127.0.0.1',
      token: 'local-control-token',
      configIdentity: 'config-test',
      runtimeChannel: 'development',
      operations: RemoteControlConst.descriptorOperations,
      optionalOperations: RemoteControlConst.optionalOperations,
      websocket: true,
    })
    expect(JSON.parse(readFileSync(harness.descriptorFile, 'utf8'))).toEqual(descriptor)
    expect(JSON.parse(readFileSync(harness.compatibilityDescriptorFile, 'utf8')))
      .toEqual(descriptor)
    const registration = JSON.parse(readFileSync(harness.registryFile, 'utf8'))
    expect(registration).toEqual({
      schemaVersion: 1,
      configIdentity: descriptor.configIdentity,
      runtimeChannel: descriptor.runtimeChannel,
      instanceId: descriptor.instanceId,
      startedAt: descriptor.startedAt,
      applicationVersion: descriptor.applicationVersion,
      pid: descriptor.pid,
      descriptorFile: harness.descriptorFile,
    })
    expect(JSON.stringify(registration)).not.toContain(descriptor.token)
    for (const forbidden of ['token', 'address', 'port', 'operations'])
      expect(registration).not.toHaveProperty(forbidden)

    harness.server.beginStop()
    harness.server.beginStop()
    expect(existsSync(harness.registryFile)).toBe(false)
    expect(existsSync(harness.descriptorFile)).toBe(false)
    expect(existsSync(harness.compatibilityDescriptorFile)).toBe(true)
    await harness.server.stop()
  })

  it('removes the descriptor and closes when registration publication fails', async () => {
    const harness = new RemoteControlServerHarness(2, false, {
      write() { throw new Error('registry write failed') },
      removeIfOwned() {},
    })
    harnesses.push(harness)

    await expect(harness.server.start()).rejects.toThrow('registry write failed')
    expect(existsSync(harness.descriptorFile)).toBe(false)
    expect(existsSync(harness.compatibilityDescriptorFile)).toBe(true)
    expect(existsSync(harness.registryFile)).toBe(false)
  })

  it('rejects accepted work and closes connections during a startup rollback', async () => {
    const pending: { request: Promise<'answered' | 'refused'> | null } = { request: null }
    const harness = new RemoteControlServerHarness(2, false, {
      write(registration) {
        const descriptor = JSON.parse(
          readFileSync(registration.descriptorFile, 'utf8'),
        ) as RemoteControlDescriptor
        pending.request = fetch(`http://127.0.0.1:${descriptor.port}/api/v3/op/system.status`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${descriptor.token}`,
            'Content-Type': 'application/json',
          },
          body: RemoteControlServerHarness.request('system.status', {}),
        }).then(() => 'answered' as const, () => 'refused' as const)
        throw new Error('registry write failed after request started')
      },
      removeIfOwned() {},
    })
    harnesses.push(harness)
    const execute = vi.spyOn(harness.control, 'execute')

    await expect(harness.server.start()).rejects.toThrow('registry write failed after request started')
    const startedRequest = pending.request
    if (startedRequest === null) throw new Error('The rollback request was not started')
    const outcome = await new Promise<'answered' | 'refused' | 'timed-out'>((resolve) => {
      const timer = setTimeout(() => resolve('timed-out'), 2_000)
      void startedRequest.then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
    expect(outcome).not.toBe('timed-out')
    expect(execute).not.toHaveBeenCalled()
    expect(existsSync(harness.descriptorFile)).toBe(false)
    expect(existsSync(harness.compatibilityDescriptorFile)).toBe(true)
  })

  it('leaves neither publication when the descriptor write fails', async () => {
    const harness = new RemoteControlServerHarness()
    harnesses.push(harness)
    mkdirSync(harness.descriptorFile, { recursive: true })

    await expect(harness.server.start()).rejects.toThrow()
    expect(existsSync(harness.registryFile)).toBe(false)
    expect(existsSync(harness.compatibilityDescriptorFile)).toBe(false)
    expect(readdirSync(join(harness.root, 'control-descriptors'))
      .some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('closes a listener stopped during startup without publishing either file', async () => {
    const harness = new RemoteControlServerHarness()
    harnesses.push(harness)

    const starting = harness.server.start()
    harness.server.beginStop()
    await expect(starting).rejects.toThrow('stopped during startup')
    expect(existsSync(harness.registryFile)).toBe(false)
    expect(existsSync(harness.descriptorFile)).toBe(false)
    expect(existsSync(harness.compatibilityDescriptorFile)).toBe(false)
  })

  it('exposes local computer discovery and replay-safe pairing without credentials', async () => {
    const harness = new RemoteControlServerHarness(2, true)
    harnesses.push(harness)
    const descriptor = await harness.start()
    expect(descriptor.localOperations).toEqual(RemoteControlLocalConst.operations)

    const listed = await harness.fetch('/api/v3/local/op/remote.computers.list', {
      method: 'POST',
      body: RemoteControlServerHarness.request('remote.computers.list', {}),
    })
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({
      operation: 'remote.computers.list',
      ok: true,
      value: {
        revision: 7,
        computers: [{
          remoteComputerId: 'computer-remote',
          remoteEndpointId: 'endpoint-remote',
          status: 'connected',
          sessionCount: 1,
          // The connector's diagnosis reaches the CLI through the same DTO the window reads, which
          // is the whole reason it was added to the shared facts rather than beside one surface.
          lastConnectedAt: 1_700_000_000_000,
          nextRetryAt: null,
          applicationVersion: '2026.08.31.10.00',
          optionalOperations: ['sessions.transcript'],
        }],
      },
    })

    const exported = await harness.fetch('/api/v3/local/op/remote.pairing.export', {
      method: 'POST',
      body: RemoteControlServerHarness.request('remote.pairing.export', {}),
    })
    const exportEnvelope = await exported.json() as { value: unknown }
    expect(JSON.stringify(exportEnvelope)).not.toContain('privateKey')
    const importBody = RemoteControlServerHarness.request(
      'remote.pairing.import',
      { bundle: exportEnvelope.value },
      'pairing-operation',
    )
    const firstImport = await harness.fetch('/api/v3/local/op/remote.pairing.import', {
      method: 'POST',
      body: importBody,
    })
    const replayedImport = await harness.fetch('/api/v3/local/op/remote.pairing.import', {
      method: 'POST',
      body: importBody,
    })
    expect(firstImport.status).toBe(200)
    expect(replayedImport.status).toBe(200)
    expect(harness.pairingImports).toBe(1)
  })

  it('routes only peer-granted operations to the selected remote endpoint', async () => {
    const harness = new RemoteControlServerHarness(2, true)
    harnesses.push(harness)
    await harness.start()

    const routed = await harness.fetch('/api/v3/remote/endpoint-remote/op/sessions.list', {
      method: 'POST',
      body: RemoteControlServerHarness.request('sessions.list', {}),
    })
    expect(routed.status).toBe(200)
    expect(await routed.json()).toMatchObject({
      operation: 'sessions.list',
      ok: true,
      value: { routed: true },
    })
    expect(harness.remoteExecutions).toMatchObject([{
      remoteEndpointId: 'endpoint-remote',
      request: { operation: 'sessions.list' },
    }])

    const forbidden = await harness.fetch('/api/v3/remote/endpoint-remote/op/tabs.list', {
      method: 'POST',
      body: RemoteControlServerHarness.request('tabs.list', {}),
    })
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    })
    expect(harness.remoteExecutions).toHaveLength(1)
    // Audit rows are batched off the request path, and a stop is what puts the last of them on disk.
    await harness.server.stop()
    expect(readFileSync(harness.auditFile, 'utf8')).toContain('endpoint-remote')
  })

  it('serves transcripts locally, refuses peer routing and audits only the canonical session id', async () => {
    const harness = new RemoteControlServerHarness(2, true)
    harnesses.push(harness)
    await harness.start()

    const local = await harness.fetch('/api/v3/op/sessions.transcript', {
      method: 'POST',
      body: RemoteControlServerHarness.request(
        'sessions.transcript',
        { session: { kind: 'number', number: '001' } },
      ),
    })
    const peer = await harness.fetch('/api/v3/remote/endpoint-remote/op/sessions.transcript', {
      method: 'POST',
      body: RemoteControlServerHarness.request(
        'sessions.transcript',
        { session: { kind: 'sessionId', sessionId: 'session-1' } },
      ),
    })

    expect(local.status).toBe(200)
    expect(await local.json()).toMatchObject({
      ok: true,
      operation: 'sessions.transcript',
      value: {
        sessionId: 'session-1',
        transcriptContentUntrusted: true,
        reading: { kind: 'messages', messages: [{ text: 'secret transcript message' }] },
      },
    })
    expect(peer.status).toBe(403)
    expect(await peer.json()).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(harness.transcriptReads).toEqual(['session-1'])
    expect(harness.remoteExecutions).toEqual([])

    await harness.server.stop()
    const audit = readFileSync(harness.auditFile, 'utf8')
    const row = audit.trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((item) => item.operation === 'sessions.transcript')
    expect(row).toMatchObject({ operation: 'sessions.transcript', target: { sessionId: 'session-1' } })
    expect(audit).not.toContain('secret transcript message')
    expect(audit).not.toContain('assistant')
    expect(audit).not.toContain('Q:\\Project')
    expect(audit).not.toContain('transcriptContentUntrusted')
    expect(audit).not.toContain('reading')
  })

  it('requires bearer auth, the exact loopback Host and no browser Origin', async () => {
    const harness = new RemoteControlServerHarness()
    harnesses.push(harness)
    const descriptor = await harness.start()
    const url = `http://127.0.0.1:${descriptor.port}/api/v3/hello`

    const unauthorized = await fetch(url)
    /*
     * The two that actually reach `sameToken`. Without them the test refused only a MISSING header
     * (caught by the `typeof authorization !== 'string'` branch above it), so the constant-time
     * comparison - the one thing between any local process and `terminal.send` - had no coverage at
     * all: replacing its body with `return true` left the whole suite green.
     */
    const wrongToken = await fetch(url, {
      headers: { Authorization: `Bearer ${descriptor.token}x` },
    })
    // Equal length is the case that exercises `timingSafeEqual` rather than the length guard.
    const sameLengthToken = await fetch(url, {
      headers: {
        Authorization: `Bearer ${'z'.repeat(descriptor.token.length)}`,
      },
    })
    const badHost = await harness.rawGet('/api/v3/hello', {
      Authorization: `Bearer ${descriptor.token}`,
      Host: `localhost:${descriptor.port}`,
    })
    const browser = await fetch(url, {
      headers: { Authorization: `Bearer ${descriptor.token}`, Origin: 'http://evil.example' },
    })
    const accepted = await harness.fetch('/api/v3/hello')

    expect(unauthorized.status).toBe(401)
    expect(wrongToken.status).toBe(401)
    expect(sameLengthToken.status).toBe(401)
    expect(badHost.status).toBe(403)
    expect(browser.status).toBe(403)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      ok: true,
      operation: 'system.hello',
      value: {
        operations: [...RemoteControlConst.descriptorOperations],
        optionalOperations: [...RemoteControlConst.optionalOperations],
      },
    })
    expect(JSON.stringify([
      await unauthorized.json(),
      await wrongToken.json(),
      await sameLengthToken.json(),
      JSON.parse(badHost.body),
      await browser.json(),
      harness.errors,
    ])).not.toContain(descriptor.token)
  })

  /**
   * The upgrade is the other authorized route, and it carries `terminal.input` - so an unauthenticated
   * one is keystroke injection into any live session. Until 2026-08-21 the harness always sent the
   * right token and nothing else ever opened this URL, so replacing the whole `authorize` call in
   * `handleUpgrade` with `null` left all 33 tests green.
   */
  it('refuses a WebSocket upgrade without auth, with a wrong token, or from a browser', async () => {
    const harness = new RemoteControlServerHarness()
    harnesses.push(harness)
    const descriptor = await harness.start()
    const url = `ws://127.0.0.1:${descriptor.port}/api/v3/ws`

    const refused = async (headers: Record<string, string>): Promise<string> => {
      const socket = new WebSocket(url, { headers })
      return new Promise<string>((resolve) => {
        socket.once('open', () => {
          socket.close()
          resolve('opened')
        })
        socket.once('error', (error: Error) => resolve(error.message))
      })
    }

    expect(await refused({})).toContain('401')
    expect(await refused({ Authorization: `Bearer ${descriptor.token}x` })).toContain('401')
    expect(await refused({
      Authorization: `Bearer ${descriptor.token}`,
      Origin: 'http://evil.example',
    })).toContain('403')

    // And the correct one still opens, so the three above are refusals and not a broken route.
    const accepted = await harness.socket()
    accepted.socket.close()
  })

  it('bounds HTTP input, rejects route mismatches and replays mutations without secret audit data', async () => {
    const harness = new RemoteControlServerHarness()
    harnesses.push(harness)
    const descriptor = await harness.start()
    const create = RemoteControlServerHarness.request(
      'sessions.create',
      { spec: { kind: 'shell', directory: { mode: 'default' } } },
      'create-once',
      'create-1',
    )
    const first = await harness.fetch('/api/v3/op/sessions.create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: create,
    })
    const replay = await harness.fetch('/api/v3/op/sessions.create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: RemoteControlServerHarness.request(
        'sessions.create',
        { spec: { kind: 'shell', directory: { mode: 'default' } } },
        'create-once',
        'create-2',
      ),
    })
    const conflict = await harness.fetch('/api/v3/op/sessions.create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: RemoteControlServerHarness.request(
        'sessions.create',
        { spec: { kind: 'shell', directory: { mode: 'default' }, title: 'different' } },
        'create-once',
      ),
    })
    const secret = 'do-not-write-this-to-audit'
    const terminal = await harness.fetch('/api/v3/op/terminal.send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: RemoteControlServerHarness.request(
        'terminal.send',
        { session: { kind: 'sessionId', sessionId: 'session-1' }, text: secret, enter: true },
        'send-1',
      ),
    })
    const file = await harness.fetch('/api/v3/op/tabs.openFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: RemoteControlServerHarness.request(
        'tabs.openFile',
        {
          session: { kind: 'sessionId', sessionId: 'session-1' },
          path: 'unproven-input.md',
        },
        'open-file-1',
      ),
    })
    const mismatch = await harness.fetch('/api/v3/op/sessions.list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: RemoteControlServerHarness.request('tabs.list', {}),
    })
    const unknown = await harness.fetch('/api/v3/op/unknown', { method: 'POST', body: '{}' })
    const oversized = await harness.fetch('/api/v3/op/sessions.list', {
      method: 'POST',
      body: `{"padding":"${'x'.repeat(1_048_576)}"}`,
    })

    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({
      requestId: 'create-2',
      ok: true,
      value: { session: { sessionId: 'created-1' } },
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(terminal.status).toBe(200)
    expect(file.status).toBe(200)
    expect(mismatch.status).toBe(400)
    expect(unknown.status).toBe(404)
    expect(oversized.status).toBe(413)
    expect(harness.creates).toBe(1)
    expect(harness.sentText).toEqual([secret])

    await harness.server.stop()
    const audit = readFileSync(harness.auditFile, 'utf8')
    expect(audit).toContain('sessions.create')
    expect(audit).toContain('terminal.send')
    expect(audit).toContain(`"characterCount":${secret.length}`)
    const fileAudit = audit.trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => row.operation === 'tabs.openFile')
    expect(fileAudit).toMatchObject({ target: { path: 'Q:\\Proven\\report.md' } })
    expect(audit).not.toContain('unproven-input.md')
    expect(audit).not.toContain(secret)
    expect(audit).not.toContain('terminal-secret-output')
    expect(audit).not.toContain(descriptor.token)
  })

  it('streams terminal frames and events, deduplicates input and detaches the socket owner', async () => {
    const harness = new RemoteControlServerHarness()
    harnesses.push(harness)
    await harness.start()
    const { socket, inbox } = await harness.socket()
    socket.send(JSON.stringify({
      protocol: RemoteControlConst.protocol,
      requestId: 'attach-1',
      operationId: 'attach-op',
      operation: 'terminal.attach',
      attachId: 'terminal-1',
      sessionId: 'session-1',
      size: { cols: 80, rows: 24 },
    }))
    await expect(inbox.wait((message) =>
      message.type === 'response' && message.requestId === 'attach-1')).resolves.toMatchObject({
      ok: true,
      value: { attachId: 'terminal-1', sessionId: 'session-1' },
    })

    harness.terminal.emit('terminal-1', {
      type: 'terminal.data',
      runtimeSessionId: 'runtime-1',
      generation: 1,
      outputEpoch: 1,
      outputSeq: 2,
      delta: 'untrusted-output',
      lastOutputAt: 2,
    })
    await expect(inbox.wait((message) => message.type === 'terminal.frame')).resolves.toMatchObject({
      type: 'terminal.frame',
      attachId: 'terminal-1',
      frame: { type: 'terminal.data', delta: 'untrusted-output' },
      terminalOutputUntrusted: true,
    })

    const input = {
      protocol: RemoteControlConst.protocol,
      requestId: 'input-1',
      operationId: 'input-op',
      operation: 'terminal.input',
      attachId: 'terminal-1',
      data: 'secret-input',
    }
    socket.send(JSON.stringify(input))
    await inbox.wait((message) => message.type === 'response' && message.requestId === 'input-1')
    socket.send(JSON.stringify({ ...input, requestId: 'input-2' }))
    await expect(inbox.wait((message) =>
      message.type === 'response' && message.requestId === 'input-2')).resolves.toMatchObject({
      ok: true,
      value: { accepted: true, characterCount: 12 },
    })
    socket.send(JSON.stringify({ ...input, requestId: 'input-3', data: 'different' }))
    await expect(inbox.wait((message) =>
      message.type === 'response' && message.requestId === 'input-3')).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    })
    expect(harness.terminal.inputs).toHaveLength(1)

    socket.send(JSON.stringify({
      protocol: RemoteControlConst.protocol,
      requestId: 'events-1',
      operation: 'events.subscribe',
    }))
    await inbox.wait((message) => message.type === 'response' && message.requestId === 'events-1')
    harness.server.publishEvent('sessions.changed')
    await expect(inbox.wait((message) => message.type === 'event')).resolves.toMatchObject({
      type: 'event',
      event: { revision: 1, kind: 'sessions.changed' },
    })

    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve())
      socket.close()
    })
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1_000
      const check = (): void => {
        if (harness.terminal.attachments.size === 0) resolve()
        else if (Date.now() >= deadline) reject(new Error('Server did not detach the closed socket'))
        else setTimeout(check, 5)
      }
      check()
    })
    expect(harness.terminal.attachments.size).toBe(0)
    expect(harness.terminal.detachedOwners).toHaveLength(1)
    await harness.server.stop()
    const audit = readFileSync(harness.auditFile, 'utf8')
    expect(audit).toContain(`"characterCount":12`)
    expect(audit).not.toContain('secret-input')
    expect(audit).not.toContain('untrusted-output')
  })

  it('reports a truncated event cursor without replaying stale events', async () => {
    const harness = new RemoteControlServerHarness(2)
    harnesses.push(harness)
    await harness.start()
    harness.server.publishEvent('sessions.changed')
    harness.server.publishEvent('tabs.changed')
    harness.server.publishEvent('sessions.changed')
    const { socket, inbox } = await harness.socket()
    socket.send(JSON.stringify({
      protocol: RemoteControlConst.protocol,
      requestId: 'events-gap',
      operation: 'events.subscribe',
      afterRevision: 0,
    }))

    await expect(inbox.wait((message) =>
      message.type === 'response' && message.requestId === 'events-gap')).resolves.toMatchObject({
      ok: true,
      value: { throughRevision: 3, truncated: true },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(inbox.messages.filter((message) => message.type === 'event')).toEqual([])
    socket.close()
  })
})
