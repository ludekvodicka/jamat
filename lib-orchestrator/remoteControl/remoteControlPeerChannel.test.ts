import { describe, expect, it } from 'vitest'

import type {
  RemoteControlRequestUnion,
} from './remoteControlApi.types'
import { RemoteControlConst } from './remoteControlProtocol'
import type { RemoteControlPeerTransport } from './remoteConnectionsApi.types'
import type {
  RemoteControlPeerApplicationMessage,
  RemoteControlPeerCapability,
  RemoteControlPeerIdentity,
  RemoteControlPeerInboundApplicationMessage,
} from './remoteControlPeerApi.types'
import { RemoteControlPeerConst } from './remoteControlPeerProtocol'
import { RemoteControlPeerChannel } from './remoteControlPeerChannel'

describe('lib-orchestrator/remoteControl/remoteControlPeerChannel', () => {
  it('correlates control and socket responses and publishes events and terminal frames', async () => {
    const transport = new RemoteControlPeerChannelTestTransport()
    const channel = new RemoteControlPeerChannel(transport)
    const events: unknown[] = []
    const frames: unknown[] = []
    channel.onEvent((event) => events.push(event))
    channel.onTerminalFrame((frame) => frames.push(frame))
    const request = RemoteControlPeerChannelTest.request('control-1')
    const pending = channel.control(request)
    transport.emit({
      type: 'control-response',
      response: {
        protocol: RemoteControlConst.protocol,
        requestId: request.requestId,
        operation: request.operation,
        operationId: null,
        ok: true,
        value: RemoteControlPeerChannelTest.snapshot(),
      },
    })
    expect(await pending).toMatchObject({ ok: true })

    const subscription = channel.socket({
      protocol: RemoteControlConst.protocol,
      requestId: 'socket-1',
      operation: 'events.subscribe',
    })
    transport.emit({
      type: 'socket-response',
      response: {
        protocol: RemoteControlConst.protocol,
        type: 'response',
        requestId: 'socket-1',
        operation: 'events.subscribe',
        operationId: null,
        ok: true,
        value: { throughRevision: 0, truncated: false },
      },
    })
    expect(await subscription).toMatchObject({ ok: true })
    transport.emit({
      type: 'socket-response',
      response: {
        protocol: RemoteControlConst.protocol,
        type: 'event',
        event: { revision: 1, kind: 'sessions.changed', at: 1 },
      },
    })
    transport.emit({
      type: 'socket-response',
      response: {
        protocol: RemoteControlConst.protocol,
        type: 'terminal.frame',
        attachId: 'attach-1',
        frame: { type: 'terminal.status', status: 'connecting', detail: null },
        terminalOutputUntrusted: true,
      },
    })
    expect(events).toHaveLength(1)
    expect(frames).toHaveLength(1)
  })

  it('fails pending requests when the encrypted connection closes', async () => {
    const transport = new RemoteControlPeerChannelTestTransport()
    const channel = new RemoteControlPeerChannel(transport)
    const pending = channel.control(RemoteControlPeerChannelTest.request('pending'))
    transport.close()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('rejects capabilities that were not granted and closes on reverse requests', async () => {
    const transport = new RemoteControlPeerChannelTestTransport([])
    const channel = new RemoteControlPeerChannel(transport)
    expect(await channel.control(RemoteControlPeerChannelTest.request('forbidden')))
      .toMatchObject({ ok: false, error: { code: 'forbidden' } })
    transport.emit({ type: 'control-request', request: RemoteControlPeerChannelTest.request('reverse') })
    expect(transport.isOpen()).toBe(false)
  })
})

class RemoteControlPeerChannelTestTransport implements RemoteControlPeerTransport {
  readonly connectionId = 'connection-1'
  readonly remoteIdentity: RemoteControlPeerIdentity = {
    remoteComputerId: 'computer-a',
    remoteEndpointId: 'endpoint-a',
    configIdentity: 'config-a',
    runtimeChannel: 'development',
    displayName: 'Computer A',
    signing: { algorithm: 'ed25519', publicKey: 'a'.repeat(64), fingerprint: 'b'.repeat(43) },
  }
  private readonly messages =
    new Set<(message: RemoteControlPeerInboundApplicationMessage) => void>()
  private readonly closes = new Set<() => void>()
  private open = true

  constructor(
    readonly capabilities: readonly RemoteControlPeerCapability[]
      = RemoteControlPeerConst.capabilities,
  ) {}

  isOpen(): boolean { return this.open }

  send(_message: RemoteControlPeerApplicationMessage): boolean { return this.open }

  onMessage(listener: (message: RemoteControlPeerInboundApplicationMessage) => void): () => void {
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
    this.emitRaw(message)
  }

  /** What a peer can actually put on the wire, which is anything at all. */
  emitRaw(message: RemoteControlPeerInboundApplicationMessage): void {
    for (const listener of this.messages) listener(message)
  }
}

/*
 * Being paired says who is on the far end. It says nothing about what that end sends, and the cipher
 * cannot help: a sealed frame is authentic and can still carry `{}`. Until 2026-08-23 the channel
 * settled pending requests with whatever arrived, typed as a validated response.
 */
describe('lib-orchestrator/remoteControl/remoteControlPeerChannel refuses malformed answers', () => {
  it('leaves a request pending and reports rather than resolving it with a shapeless answer', async () => {
    const transport = new RemoteControlPeerChannelTestTransport()
    const reports: string[] = []
    const channel = new RemoteControlPeerChannel(transport, {
      requestTimeoutMilliseconds: 40,
      onError: (message) => reports.push(message),
    })
    const request = RemoteControlPeerChannelTest.request('control-1')

    const pending = channel.control(request)
    transport.emitRaw({ type: 'control-response', response: {} })
    transport.emitRaw({
      type: 'control-response',
      response: {
        protocol: RemoteControlConst.protocol,
        requestId: request.requestId,
        operation: request.operation,
        operationId: null,
        ok: true,
      },
    })

    expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' } })
    expect(reports).toEqual([
      'Remote peer returned a malformed control response',
      'Remote peer returned a malformed control response',
    ])
  })

  it('drops a socket answer of an unknown kind instead of throwing where it is read', async () => {
    const transport = new RemoteControlPeerChannelTestTransport()
    const reports: string[] = []
    const frames: unknown[] = []
    const channel = new RemoteControlPeerChannel(transport, {
      requestTimeoutMilliseconds: 40,
      onError: (message) => reports.push(message),
    })
    channel.onTerminalFrame((frame) => frames.push(frame))

    transport.emitRaw({
      type: 'socket-response',
      response: { protocol: RemoteControlConst.protocol, type: 'terminal.smuggled' },
    })
    transport.emitRaw({
      type: 'socket-response',
      response: {
        protocol: RemoteControlConst.protocol,
        type: 'terminal.frame',
        attachId: 'attach-1',
        frame: { type: 'not-a-frame' },
        terminalOutputUntrusted: true,
      },
    })

    expect(frames).toEqual([])
    expect(reports).toEqual([
      'Remote peer returned a malformed socket response',
      'Remote peer returned a malformed socket response',
    ])
    channel.close()
  })
})

class RemoteControlPeerChannelTest {
  static request(requestId: string): RemoteControlRequestUnion {
    return {
      protocol: RemoteControlConst.protocol,
      requestId,
      operation: 'sessions.list',
      body: {},
    }
  }

  static snapshot() {
    return {
      revision: 1,
      reconciled: true,
      host: {
        presence: 'running' as const,
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
}
