import type { PeerAuthority, PeerForwardPort } from '../../../lib-orchestrator/remoteControl/peerProcess.types'
import { RemoteControlAuditRows, type RemoteControlAuditEntry } from '../../../lib-orchestrator/remoteControl/remoteControlAuditRows'
import { ProcessCalls } from '../../../lib-orchestrator/shared/processCalls'

import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import type {
  RemoteControlRequestUnion,
  RemoteControlResponse,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import type { RemoteControlPeerTransport } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  RemoteControlPeerApplicationMessage,
  RemoteControlPeerCapability,
  RemoteControlPeerIdentity,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { RemoteControlPeerConst } from '../../../lib-orchestrator/remoteControl/remoteControlPeerProtocol'
import type { TerminalFrame } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { RemoteControlInboundRegistry } from './remoteControlInboundRegistry'

describe('app-gateway/app/peers/remoteControlInboundRegistry', () => {
  it('keeps existing input independent, checks capabilities before enqueue and cancels queued work on revoke', async () => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve }), executed: unknown[] = []
    let gateway!: ProcessCalls
    const main = new ProcessCalls({ send: message => gateway.receive(message), invoke: async (_target, _method, args, context) => {
      context.pending(); executed.push(args); await pending; return null
    }, event: () => {}, report: () => {} })
    gateway = new ProcessCalls({ send: message => main.receive(message), invoke: async () => { throw new Error('unexpected reverse call') },
      event: () => {}, report: () => {} })
    const h = new RemoteControlInboundRegistryTest(undefined, undefined,
      (peer, request, signal) => gateway.call('work', 'execute', [peer, request], { signal }))
    const peer = new RemoteControlInboundRegistryTestTransport('computer-a', 'endpoint-a',
      ['control:sessions.list', 'socket:terminal.attach', 'socket:terminal.input', 'socket:terminal.detach'])
    const other = new RemoteControlInboundRegistryTestTransport('computer-b', 'endpoint-b')
    try {
      h.registry.add(peer); h.registry.add(other)
      peer.emit(RemoteControlInboundRegistryTest.attach('attach', 'a', 'session'))
      await h.waitUntil(() => h.registry.snapshot()[0]?.activeSessionIds.length === 1)
      const control = (requestId: string, operation: 'sessions.list' | 'system.status' = 'sessions.list') => ({ type: 'control-request' as const,
        request: { protocol: RemoteControlConst.protocol, requestId, operation, body: {} } })
      peer.emit(control('slow'))
      await h.waitUntil(() => executed.length === 1)
      peer.emit(control('queued'))
      peer.emit(RemoteControlInboundRegistryTest.attach('queued-attach', 'b', 'later-session'))
      peer.emit(control('forbidden', 'system.status'))
      peer.emit({ type: 'socket-request', request: { protocol: RemoteControlConst.protocol, requestId: 'input', operationId: 'input-op',
        operation: 'terminal.input', attachId: 'a', data: 'independent' } })
      await h.waitUntil(() => peer.sent.some(message => message.type === 'socket-response' && message.response.type === 'response'
        && message.response.requestId === 'input' && message.response.ok))
      assert.ok(peer.sent.some(message => message.type === 'control-response' && message.response.requestId === 'forbidden'
        && !message.response.ok && message.response.error.code === 'forbidden'))
      assert.equal(executed.length, 1)
      h.denied.add('endpoint-a')
      await h.registry.closeEndpoint('computer-a', 'endpoint-a')
      assert.equal(peer.isOpen(), false)
      assert.equal(other.isOpen(), true)
      const replacement = new RemoteControlInboundRegistryTestTransport('computer-a', 'endpoint-a')
      h.registry.add(replacement)
      assert.equal(replacement.isOpen(), false)
      finish(); await pending; await new Promise(resolve => setTimeout(resolve, 0))
      assert.equal(executed.length, 1)
      assert.equal(peer.sent.some(message => message.type === 'socket-response' && message.response.type === 'response'
        && message.response.requestId === 'queued-attach'), false)
    } finally { finish(); await h.registry.stop(); gateway.close(); main.close() }
  })
  it('keeps terminal and view closure responsive while bounding concurrent source work', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const request = mock.fn<PeerForwardPort['view']>(async (_peer, body) => {
      if (body.operation !== 'views.close') await pending
      return { ok: true as const, value: null }
    })
    const releaseConnection = mock.fn()
    const harness = new RemoteControlInboundRegistryTest(undefined, { view: request, releaseConnection })
    const peer = new RemoteControlInboundRegistryTestTransport('computer-a', 'endpoint-a')
    harness.registry.add(peer)
    const base = { epoch: peer.connectionId, viewId: 'view', viewerId: 'window', sessionId: 'session' }
    for (let index = 0; index < 17; index++) peer.emit({ type: 'session-view-request', request: {
      ...base, requestId: `read-${index}`, operation: 'files.request', body: { kind: 'project-directory' },
    } })
    peer.emit({ type: 'session-view-request', request: { ...base, requestId: 'close', operation: 'views.close', body: {} } })
    peer.emit(RemoteControlInboundRegistryTest.attach('attach', 'attach', 'session'))
    await harness.waitUntil(() => peer.sent.some((message) => message.type === 'socket-response'))
    assert.partialDeepStrictEqual(peer.sent.find(message => message.type === 'session-view-response' && message.response.requestId === 'close'), { type: 'session-view-response', response: { requestId: 'close', result: { ok: true, value: null } } })
    assert.partialDeepStrictEqual(peer.sent.find(message => message.type === 'session-view-response' && message.response.requestId === 'read-16'), { type: 'session-view-response', response: { requestId: 'read-16', result: { ok: false } } })
    assert.equal(request.mock.callCount(), 17)
    peer.close()
    const sentBeforeCompletion = peer.sent.length
    finish()
    await pending; await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal((peer.sent).length, sentBeforeCompletion)
    assert.deepEqual(releaseConnection.mock.calls.map(call => call.arguments), [[peer]])
    await harness.registry.stop()
  })

  it('lists live inbound peers without credentials and tracks attaches per peer', async () => {
    const harness = new RemoteControlInboundRegistryTest()
    const first = new RemoteControlInboundRegistryTestTransport('computer-a', 'endpoint-a')
    const second = new RemoteControlInboundRegistryTestTransport('computer-b', 'endpoint-b')
    harness.registry.add(first)
    harness.registry.add(second)
    assert.deepEqual(harness.registry.snapshot().map((entry) => entry.activeSessionIds), [[], []])
    first.emit(RemoteControlInboundRegistryTest.attach('request-a', 'attach-a', 'session-shared'))
    second.emit(RemoteControlInboundRegistryTest.attach('request-b', 'attach-b', 'session-shared'))
    await harness.waitUntil(() => harness.registry.snapshot().every((entry) =>
      entry.activeSessionIds.length === 1))
    const snapshot = harness.registry.snapshot()
    assert.equal((snapshot).length, 2)
    assert.deepEqual(snapshot.map((entry) => entry.activeSessionIds), [
      ['session-shared'],
      ['session-shared'],
    ])
    const serialized = JSON.stringify(snapshot)
    assert.equal((serialized)?.includes('signing'), false)
    assert.equal((serialized)?.includes('publicKey'), false)
    assert.equal((serialized)?.includes('privateKey'), false)
    assert.equal((serialized)?.includes('token'), false)

    first.close()
    await harness.waitUntil(() => harness.registry.snapshot().length === 1)
    assert.equal((harness.terminal.detachedOwners).length, 1)
    await harness.registry.stop()
  })

  it('dispatches only remote capabilities and admits explicit source file opens', async () => {
    const harness = new RemoteControlInboundRegistryTest()
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
    assert.deepEqual(harness.control.peers[0]?.remoteIdentity, peer.remoteIdentity)
    assert.equal((harness.control.peers[0]?.capabilities)?.includes('control:tabs.open' as never), false)
    assert.equal((harness.control.peers[0]?.capabilities)?.includes('control:tabs.openFile'), true)
    assert.deepEqual(harness.control.peers[0]?.capabilities,
      RemoteControlPeerConst.capabilities,
    )
    await harness.registry.stop()
  })

  /**
   * What revoking an inbound right has to be able to do. The handshake reads trust when a peer
   * CONNECTS and never again, so a peer already on the socket keeps its control of this computer
   * until it next reconnects unless the revoke hangs up on it.
   */
  it('hangs up on one identity and leaves every other peer alone', async () => {
    const harness = new RemoteControlInboundRegistryTest()
    const revoked = new RemoteControlInboundRegistryTestTransport('computer-a', 'endpoint-a')
    const kept = new RemoteControlInboundRegistryTestTransport('computer-b', 'endpoint-b')
    harness.registry.add(revoked)
    harness.registry.add(kept)
    revoked.emit(RemoteControlInboundRegistryTest.attach('request-a', 'attach-a', 'session-a'))
    await harness.waitUntil(() => harness.registry.snapshot().some((entry) =>
      entry.activeSessionIds.length === 1))

    await harness.registry.closeEndpoint('computer-a', 'endpoint-a')

    assert.equal(revoked.isOpen(), false)
    assert.equal(kept.isOpen(), true)
    assert.deepEqual(harness.registry.snapshot().map((entry) => entry.identity.remoteEndpointId), ['endpoint-b'])
    // The terminal it was holding goes with it; nothing keeps typing after the right is gone.
    assert.equal((harness.terminal.detachedOwners).length, 1)
    // An identity with nothing open is the ordinary case, not a mistake.
    await harness.registry.closeEndpoint('computer-a', 'endpoint-a')
    assert.equal((harness.registry.snapshot()).length, 1)
    await harness.registry.stop()
  })

  /*
   * The gate itself, which the test above cannot reach: its peer holds everything, so
   * `allowedOperations` equals the full constant whether the filter runs or not. Deleting the filter
   * at `:154-155` and the `socket:` check at `:184-189` left all 33 tests green. This is the peer
   * that negotiated one capability and must be held to it - the difference between a paired peer and
   * a paired peer that may type into a terminal.
   */
  it('holds a peer to the capabilities it negotiated, on both transports', async () => {
    const harness = new RemoteControlInboundRegistryTest()
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

    assert.deepEqual(harness.control.peers[0]?.capabilities, ['control:sessions.list'])

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
    assert.equal(refusal.response.error.code, 'forbidden')
    await harness.registry.stop()
  })

  it('replays bounded events and audits terminal input without recording its text', async () => {
    const harness = new RemoteControlInboundRegistryTest(1)
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
    assert.partialDeepStrictEqual(subscribe, {
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
    // The gateway emits only redacted rows; the main-owned writer persists them after drain.
    await harness.registry.stop()
    const audit = harness.auditRows.map(row => JSON.stringify(row)).join("\n")
    assert.equal((audit)?.includes('peer-socket'), true)
    assert.equal((audit)?.includes('"characterCount":20'), true)
    assert.equal((audit)?.includes('SECRET-TERMINAL-TEXT'), false)
  })
})

class RemoteControlInboundRegistryTest {
  readonly auditRows: RemoteControlAuditEntry[] = []
  readonly denied = new Set<string>()
  readonly control = new RemoteControlInboundRegistryTestControl()
  readonly terminal = new RemoteControlInboundRegistryTestTerminal()
  readonly registry: RemoteControlInboundRegistry

  constructor(eventLimit?: number, views?: Pick<PeerForwardPort, 'view' | 'releaseConnection'>, execute?: PeerForwardPort['execute']) {
    this.registry = new RemoteControlInboundRegistry({
      perf: { span: (_name, run) => run() }, trust: { allows: identity => !this.denied.has(identity.remoteEndpointId) },
      forward: {
        execute: execute ?? ((peer, request) => this.control.execute(request as RemoteControlRequestUnion, peer)),
        view: views?.view ?? (async () => ({ ok: true, value: null })),
        state: async () => ({ ok: false, error: { code: 'unavailable', detail: 'fixture' } }),
        releaseConnection: views?.releaseConnection ?? (() => {}),
      },
      terminal: this.terminal,
      audit: {
        socket: (transport, request, response, caller) => this.auditRows.push(RemoteControlAuditRows.socket(123, transport, request, response, caller)),
        peerControl: (request, response, caller) => this.auditRows.push(RemoteControlAuditRows.control(123, 'peer-control', request, response, caller)),
      },
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
  readonly peers: PeerAuthority[] = []

  execute(
    request: RemoteControlRequestUnion,
    peer: PeerAuthority,
  ): Promise<RemoteControlResponse> {
    this.peers.push({ connectionId: peer.connectionId, remoteIdentity: structuredClone(peer.remoteIdentity), capabilities: [...peer.capabilities] })
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

  async attachLive(
    ownerId: string,
    attachId: string,
    spec: { sessionId: string },
    onFrame: (frame: TerminalFrame) => void,
  ) {
    this.frames.set(`${ownerId}\u0000${attachId}`, onFrame)
    return { ok: true as const, value: { attachId, sessionId: spec.sessionId } }
  }

  async inputLive(_ownerId: string, attachId: string, data: string) {
    return { ok: true as const, value: { attachId, accepted: true as const, characterCount: data.length } }
  }

  async resizeLive(_ownerId: string, attachId: string) {
    return { ok: true as const, value: { attachId, accepted: true as const, applied: true } }
  }

  async setLiveActive(_ownerId: string, attachId: string) {
    return { ok: true as const, value: { attachId, accepted: true as const, applied: true } }
  }

  async pasteImageLive(_ownerId: string, attachId: string) {
    return { ok: true as const, value: { attachId, path: `/images/${attachId}.png` } }
  }

  async pasteFileLive(_ownerId: string, attachId: string) {
    return { ok: true as const, value: { attachId, received: 0, path: `/files/${attachId}.txt` } }
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

  send(message: RemoteControlPeerApplicationMessage, sent?: (error?: Error) => void): boolean {
    if (!this.open) return false
    this.sent.push(message)
    sent?.()
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
