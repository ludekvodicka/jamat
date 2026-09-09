import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  RemoteControlRequestUnion,
  RemoteControlResponse,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import type { RemoteControlCallContext } from '../../../lib-orchestrator/remoteControl/remoteControl'
import type { RemoteControlPeerTransport } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  RemoteControlPeerApplicationMessage,
  RemoteControlPeerCapability,
  RemoteControlPeerIdentity,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { RemoteControlPeerConst } from '../../../lib-orchestrator/remoteControl/remoteControlPeerProtocol'
import type { TerminalFrame } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { RemoteControlInboundRegistry } from './remoteControlInboundRegistry'

describe('app-client-ui/app/remoteControl/remoteControlInboundRegistry', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('lists live inbound peers without credentials and tracks attaches per peer', async () => {
    const harness = new RemoteControlInboundRegistryTest(roots)
    const first = new RemoteControlInboundRegistryTestTransport('computer-a', 'endpoint-a')
    const second = new RemoteControlInboundRegistryTestTransport('computer-b', 'endpoint-b')
    harness.registry.add(first)
    harness.registry.add(second)
    expect(harness.registry.snapshot().map((entry) => entry.activeSessionIds)).toEqual([[], []])
    first.emit(RemoteControlInboundRegistryTest.attach('request-a', 'attach-a', 'session-shared'))
    second.emit(RemoteControlInboundRegistryTest.attach('request-b', 'attach-b', 'session-shared'))
    await harness.waitUntil(() => harness.registry.snapshot().every((entry) =>
      entry.activeSessionIds.length === 1))
    const snapshot = harness.registry.snapshot()
    expect(snapshot).toHaveLength(2)
    expect(snapshot.map((entry) => entry.activeSessionIds)).toEqual([
      ['session-shared'],
      ['session-shared'],
    ])
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('signing')
    expect(serialized).not.toContain('publicKey')
    expect(serialized).not.toContain('privateKey')
    expect(serialized).not.toContain('token')

    first.close()
    await harness.waitUntil(() => harness.registry.snapshot().length === 1)
    expect(harness.terminal.detachedOwners).toHaveLength(1)
    harness.registry.stop()
  })

  it('dispatches only remote capabilities and never grants target tab control', async () => {
    const harness = new RemoteControlInboundRegistryTest(roots)
    const peer = new RemoteControlInboundRegistryTestTransport('computer-a', 'endpoint-a')
    harness.registry.add(peer)
    peer.emit({
      type: 'control-request',
      request: {
        protocol: RemoteControlConst.protocol,
        requestId: 'control-a',
        operation: 'sessions.list',
        body: {},
      },
    })
    await harness.waitUntil(() => peer.sent.some((message) => message.type === 'control-response'))
    expect(harness.control.contexts[0]?.callerKind).toBe('remote-peer')
    expect(harness.control.contexts[0]?.allowedOperations).not.toContain('tabs.open')
    expect(harness.control.contexts[0]?.allowedOperations).not.toContain('tabs.openFile')
    expect(harness.control.contexts[0]?.allowedOperations).toEqual(
      RemoteControlPeerConst.controlOperations,
    )
    harness.registry.stop()
  })

  /**
   * What revoking an inbound right has to be able to do. The handshake reads trust when a peer
   * CONNECTS and never again, so a peer already on the socket keeps its control of this computer
   * until it next reconnects unless the revoke hangs up on it.
   */
  it('hangs up on one identity and leaves every other peer alone', async () => {
    const harness = new RemoteControlInboundRegistryTest(roots)
    const revoked = new RemoteControlInboundRegistryTestTransport('computer-a', 'endpoint-a')
    const kept = new RemoteControlInboundRegistryTestTransport('computer-b', 'endpoint-b')
    harness.registry.add(revoked)
    harness.registry.add(kept)
    revoked.emit(RemoteControlInboundRegistryTest.attach('request-a', 'attach-a', 'session-a'))
    await harness.waitUntil(() => harness.registry.snapshot().some((entry) =>
      entry.activeSessionIds.length === 1))

    harness.registry.closeEndpoint('computer-a', 'endpoint-a')

    expect(revoked.isOpen()).toBe(false)
    expect(kept.isOpen()).toBe(true)
    expect(harness.registry.snapshot().map((entry) => entry.identity.remoteEndpointId))
      .toEqual(['endpoint-b'])
    // The terminal it was holding goes with it; nothing keeps typing after the right is gone.
    expect(harness.terminal.detachedOwners).toHaveLength(1)
    // An identity with nothing open is the ordinary case, not a mistake.
    harness.registry.closeEndpoint('computer-a', 'endpoint-a')
    expect(harness.registry.snapshot()).toHaveLength(1)
    harness.registry.stop()
  })

  /*
   * The gate itself, which the test above cannot reach: its peer holds everything, so
   * `allowedOperations` equals the full constant whether the filter runs or not. Deleting the filter
   * at `:154-155` and the `socket:` check at `:184-189` left all 33 tests green. This is the peer
   * that negotiated one capability and must be held to it - the difference between a paired peer and
   * a paired peer that may type into a terminal.
   */
  it('holds a peer to the capabilities it negotiated, on both transports', async () => {
    const harness = new RemoteControlInboundRegistryTest(roots)
    const peer = new RemoteControlInboundRegistryTestTransport(
      'computer-a',
      'endpoint-a',
      ['control:sessions.list'],
    )
    harness.registry.add(peer)

    peer.emit({
      type: 'control-request',
      request: {
        protocol: RemoteControlConst.protocol,
        requestId: 'control-a',
        operation: 'sessions.list',
        body: {},
      },
    })
    await harness.waitUntil(() => peer.sent.some((message) => message.type === 'control-response'))

    expect(harness.control.contexts[0]?.allowedOperations).toEqual(['sessions.list'])

    // And the socket half: a capability it did not negotiate is refused rather than performed.
    peer.emit({
      type: 'socket-request',
      request: {
        protocol: RemoteControlConst.protocol,
        requestId: 'socket-a',
        operation: 'terminal.input',
        operationId: 'op-a',
        attachId: 'attach-a',
        data: 'ls',
      },
    })
    const answered = (): RemoteControlPeerApplicationMessage | undefined => peer.sent.find((message) =>
      message.type === 'socket-response'
      && message.response.type === 'response'
      && message.response.requestId === 'socket-a')
    await harness.waitUntil(() => answered() !== undefined)

    const refusal = answered()
    if (refusal?.type !== 'socket-response' || refusal.response.type !== 'response')
      throw new Error('no socket response arrived')
    if (refusal.response.ok) throw new Error('the ungranted operation was performed')
    expect(refusal.response.error.code).toBe('forbidden')
    harness.registry.stop()
  })

  it('replays bounded events and audits terminal input without recording its text', async () => {
    const harness = new RemoteControlInboundRegistryTest(roots, 1)
    const peer = new RemoteControlInboundRegistryTestTransport('computer-a', 'endpoint-a')
    harness.registry.add(peer)
    harness.registry.publishEvent('sessions.changed')
    harness.registry.publishEvent('sessions.changed')
    peer.emit({
      type: 'socket-request',
      request: {
        protocol: RemoteControlConst.protocol,
        requestId: 'subscribe',
        operation: 'events.subscribe',
        afterRevision: 0,
      },
    })
    await harness.waitUntil(() => peer.sent.some((message) =>
      message.type === 'socket-response'
      && message.response.type === 'response'
      && message.response.requestId === 'subscribe'))
    const subscribe = peer.sent.find((message) =>
      message.type === 'socket-response'
      && message.response.type === 'response'
      && message.response.requestId === 'subscribe')
    expect(subscribe).toMatchObject({
      type: 'socket-response',
      response: { ok: true, value: { throughRevision: 2, truncated: true } },
    })

    peer.emit(RemoteControlInboundRegistryTest.attach('attach-request', 'attach-a', 'session-a'))
    await harness.waitUntil(() => harness.registry.snapshot()[0]?.activeSessionIds.length === 1)
    peer.emit({
      type: 'socket-request',
      request: {
        protocol: RemoteControlConst.protocol,
        requestId: 'input-request',
        operationId: 'input-operation',
        operation: 'terminal.input',
        attachId: 'attach-a',
        data: 'SECRET-TERMINAL-TEXT',
      },
    })
    await harness.waitUntil(() => peer.sent.some((message) =>
      message.type === 'socket-response'
      && message.response.type === 'response'
      && message.response.requestId === 'input-request'))
    // Audit rows are batched off the request path, and a stop is what puts the last of them on disk.
    harness.registry.stop()
    const audit = readFileSync(harness.auditFile, 'utf8')
    expect(audit).toContain('peer-socket')
    expect(audit).toContain('"characterCount":20')
    expect(audit).not.toContain('SECRET-TERMINAL-TEXT')
  })
})

class RemoteControlInboundRegistryTest {
  readonly auditFile: string
  readonly control = new RemoteControlInboundRegistryTestControl()
  readonly terminal = new RemoteControlInboundRegistryTestTerminal()
  readonly registry: RemoteControlInboundRegistry

  constructor(roots: string[], eventLimit?: number) {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-inbound-registry-test-'))
    roots.push(root)
    this.auditFile = join(root, 'audit.jsonl')
    this.registry = new RemoteControlInboundRegistry({
      control: this.control,
      terminal: this.terminal,
      auditFile: this.auditFile,
      onChanged: () => {},
      onError: (message) => { throw new Error(message) },
      ...(eventLimit === undefined ? {} : { eventLimit }),
    })
  }

  async waitUntil(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (condition()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('Inbound registry test timed out')
  }

  static attach(
    requestId: string,
    attachId: string,
    sessionId: string,
  ): RemoteControlPeerApplicationMessage {
    return {
      type: 'socket-request',
      request: {
        protocol: RemoteControlConst.protocol,
        requestId,
        operationId: `operation-${requestId}`,
        operation: 'terminal.attach',
        attachId,
        sessionId,
        size: null,
      },
    }
  }
}

class RemoteControlInboundRegistryTestControl {
  readonly contexts: RemoteControlCallContext[] = []

  execute(
    request: RemoteControlRequestUnion,
    context: RemoteControlCallContext,
  ): Promise<RemoteControlResponse> {
    this.contexts.push(structuredClone(context))
    return Promise.resolve({
      protocol: RemoteControlConst.protocol,
      requestId: request.requestId,
      operation: request.operation,
      operationId: request.operationId ?? null,
      ok: true,
      value: request.operation === 'sessions.list'
        ? {
            revision: 1,
            reconciled: true,
            host: {
              presence: 'running',
              hostVersion: null,
              hostInstanceId: null,
              liveCount: 0,
              lastStartError: null,
            },
            categories: [],
            sessions: [],
            orphans: [],
          }
        : {},
    } as RemoteControlResponse)
  }
}

class RemoteControlInboundRegistryTestTerminal {
  readonly detachedOwners: string[] = []
  private readonly frames = new Map<string, (frame: TerminalFrame) => void>()

  attachLive(
    ownerId: string,
    attachId: string,
    spec: { sessionId: string },
    onFrame: (frame: TerminalFrame) => void,
  ) {
    this.frames.set(`${ownerId}\u0000${attachId}`, onFrame)
    return { ok: true as const, value: { attachId, sessionId: spec.sessionId } }
  }

  inputLive(_ownerId: string, attachId: string, data: string) {
    return { ok: true as const, value: { attachId, accepted: true as const, characterCount: data.length } }
  }

  resizeLive(_ownerId: string, attachId: string) {
    return { ok: true as const, value: { attachId, accepted: true as const, applied: true } }
  }

  setLiveActive(_ownerId: string, attachId: string) {
    return { ok: true as const, value: { attachId, accepted: true as const, applied: true } }
  }

  detachLive(ownerId: string, attachId: string) {
    this.frames.delete(`${ownerId}\u0000${attachId}`)
    return { ok: true as const, value: { attachId } }
  }

  detachOwner(ownerId: string): void {
    this.detachedOwners.push(ownerId)
    for (const key of this.frames.keys())
      if (key.startsWith(`${ownerId}\u0000`)) this.frames.delete(key)
  }
}

class RemoteControlInboundRegistryTestTransport implements RemoteControlPeerTransport {
  /**
   * Settable, and that is the point: every fixture peer used to hold EVERY capability, so the test
   * that named the gate asserted the same constant the code returns when the gate is deleted.
   */
  readonly capabilities: readonly RemoteControlPeerCapability[]
  readonly remoteIdentity: RemoteControlPeerIdentity
  readonly connectionId: string
  readonly sent: RemoteControlPeerApplicationMessage[] = []
  private readonly messages = new Set<(message: RemoteControlPeerApplicationMessage) => void>()
  private readonly closes = new Set<() => void>()
  private open = true

  constructor(
    remoteComputerId: string,
    remoteEndpointId: string,
    capabilities: readonly RemoteControlPeerCapability[] = [...RemoteControlPeerConst.capabilities],
  ) {
    this.capabilities = capabilities
    this.connectionId = `connection-${remoteEndpointId}`
    this.remoteIdentity = {
      remoteComputerId,
      remoteEndpointId,
      configIdentity: `config-${remoteEndpointId}`,
      runtimeChannel: 'development',
      displayName: 'Same name',
      signing: {
        algorithm: 'ed25519',
        publicKey: `public-${remoteEndpointId}`.padEnd(64, 'a'),
        fingerprint: `fingerprint-${remoteEndpointId}`.padEnd(43, 'b'),
      },
    }
  }

  isOpen(): boolean { return this.open }

  send(message: RemoteControlPeerApplicationMessage): boolean {
    if (!this.open) return false
    this.sent.push(message)
    return true
  }

  onMessage(listener: (message: RemoteControlPeerApplicationMessage) => void): () => void {
    this.messages.add(listener)
    return () => this.messages.delete(listener)
  }

  onClose(listener: () => void): () => void {
    this.closes.add(listener)
    return () => this.closes.delete(listener)
  }

  close(): void {
    if (!this.open) return
    this.open = false
    for (const listener of this.closes) listener()
  }

  emit(message: RemoteControlPeerApplicationMessage): void {
    for (const listener of this.messages) listener(message)
  }
}
