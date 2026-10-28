import type { RemoteControl } from '../../../lib-orchestrator/remoteControl/remoteControl'
import type {
  RemoteControlEventKind,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import type { RemoteInboundConnectionDto } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteControlPeerTransport } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  RemoteControlPeerInboundApplicationMessage,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { RemoteControlPeerConst } from '../../../lib-orchestrator/remoteControl/remoteControlPeerProtocol'
import type { RemoteControlTerminal } from '../../../lib-orchestrator/remoteControl/remoteControlTerminal'
import { ErrorText } from '../../shared/errorText'
import { RemoteControlEventStore } from './core/remoteControlEventStore'
import {
  RemoteControlSocketOperations,
  type RemoteControlSocketCaller,
  type RemoteControlSocketSubscription,
} from './core/remoteControlSocketOperations'
import { RemoteControlAudit, type RemoteControlAuditCaller } from './remoteControlAudit'
import { RemoteSessionSchemas } from '../../../lib-orchestrator/remoteControl/remoteSessionSchemas'
import { JsonShape } from '../../../lib-orchestrator/shared/jsonShape'
import type { RemoteSessionViews } from './remoteSessionViews'
import type { RemoteSessionSnapshots } from './remoteSessionSnapshots'

export interface RemoteControlInboundRegistryDeps {
  control: Pick<RemoteControl, 'execute'>
  terminal: Pick<
    RemoteControlTerminal,
    'attachLive' | 'inputLive' | 'resizeLive' | 'setLiveActive' | 'detachLive' | 'detachOwner' | 'pasteImageLive' | 'pasteFileLive'
  >
  auditFile: string
  onChanged(): void
  onError(message: string): void
  now?(): number
  eventLimit?: number
  sessionViews?: Pick<RemoteSessionViews, 'request' | 'releaseConnection'>
  sessionSnapshots?: Pick<RemoteSessionSnapshots, 'page'>
}

interface InboundPeerState {
  connection: RemoteControlPeerTransport
  connectedAt: number
  ownerId: string
  caller: RemoteControlAuditCaller
  attachments: Map<string, string>
  subscribed: boolean
  closed: boolean
  queue: Promise<void>
  viewRequests: number
}

export class RemoteControlInboundRegistry {
  private readonly byEndpoint = new Map<string, InboundPeerState>()
  private readonly eventStore: RemoteControlEventStore
  private readonly audit: RemoteControlAudit
  private readonly operations: RemoteControlSocketOperations
  private readonly now: () => number

  constructor(private readonly deps: RemoteControlInboundRegistryDeps) {
    this.now = deps.now ?? Date.now
    this.eventStore = new RemoteControlEventStore(deps.eventLimit, this.now)
    this.audit = new RemoteControlAudit(deps.auditFile, deps.onError, this.now)
    this.operations = new RemoteControlSocketOperations(deps.terminal, this.audit, 'peer-socket')
  }

  add(connection: RemoteControlPeerTransport): void {
    const key = RemoteControlInboundRegistry.endpointKey(connection.remoteIdentity)
    const previous = this.byEndpoint.get(key)
    if (previous) previous.connection.close()
    const identity = connection.remoteIdentity
    const state: InboundPeerState = {
      connection,
      connectedAt: this.now(),
      ownerId: `remote-peer:${identity.remoteComputerId}:${identity.remoteEndpointId}:${connection.connectionId}`,
      caller: {
        callerId: `remote-peer:${identity.remoteComputerId}:${identity.remoteEndpointId}`,
        callerKind: 'remote-peer',
      },
      attachments: new Map(),
      subscribed: false,
      closed: false,
      queue: Promise.resolve(),
      viewRequests: 0,
    }
    this.byEndpoint.set(key, state)
    connection.onMessage((message) => {
      if (message.type === 'session-view-request') {
        // A publication may outlive its viewer; close, terminal and discovery must still progress.
        void this.viewRequest(state, message).catch((error: unknown) => {
          if (state.closed) return
          this.deps.onError(`Remote peer view failed: ${ErrorText.of(error)}`)
          connection.close()
        })
        return
      }
      state.queue = state.queue
        .then(() => this.handle(state, message))
        .catch((error: unknown) => {
          this.deps.onError(`Remote peer request failed: ${ErrorText.of(error)}`)
          connection.close()
        })
    })
    connection.onClose(() => this.closed(key, state))
    this.deps.onChanged()
  }

  snapshot(): readonly RemoteInboundConnectionDto[] {
    return [...this.byEndpoint.values()]
      .map((state) => ({
        connectionId: state.connection.connectionId,
        connectedAt: state.connectedAt,
        identity: {
          remoteComputerId: state.connection.remoteIdentity.remoteComputerId,
          remoteEndpointId: state.connection.remoteIdentity.remoteEndpointId,
          configIdentity: state.connection.remoteIdentity.configIdentity,
          runtimeChannel: state.connection.remoteIdentity.runtimeChannel,
          displayName: state.connection.remoteIdentity.displayName,
        },
        activeSessionIds: [...new Set(state.attachments.values())].sort(),
      }))
      .sort((first, second) => first.identity.remoteEndpointId.localeCompare(
        second.identity.remoteEndpointId,
      ))
  }

  /**
   * Hangs up on one identity, and the reason revoking inbound trust has to call it: the handshake
   * checks trust when a peer CONNECTS and never again, so a peer that was let in yesterday keeps its
   * control of this computer until it next reconnects. Taking the right away has to take the
   * connection with it.
   *
   * Idempotent: an identity with nothing open is the ordinary case, not a mistake.
   */
  closeEndpoint(remoteComputerId: string, remoteEndpointId: string): void {
    const key = RemoteControlInboundRegistry.endpointKey({ remoteComputerId, remoteEndpointId })
    const state = this.byEndpoint.get(key)
    if (state === undefined) return
    state.closed = true
    this.deps.sessionViews?.releaseConnection(state.connection)
    this.deps.terminal.detachOwner(state.ownerId)
    state.attachments.clear()
    this.byEndpoint.delete(key)
    state.connection.close()
    this.deps.onChanged()
  }

  publishEvent(kind: RemoteControlEventKind): void {
    const event = this.eventStore.publish(kind)
    for (const state of this.byEndpoint.values()) {
      if (!state.subscribed) continue
      state.connection.send({
        type: 'socket-response',
        response: { protocol: RemoteControlConst.protocol, type: 'event', event },
      })
    }
  }

  stop(): void {
    for (const state of this.byEndpoint.values()) {
      state.closed = true
      this.deps.sessionViews?.releaseConnection(state.connection)
      this.deps.terminal.detachOwner(state.ownerId)
      state.connection.close()
    }
    if (this.byEndpoint.size > 0) {
      this.byEndpoint.clear()
      this.deps.onChanged()
    }
    this.audit.flush()
  }

  private async viewRequest(state: InboundPeerState, message: Extract<RemoteControlPeerInboundApplicationMessage, { type: 'session-view-request' }>): Promise<void> {
    if (state.closed) return
    const request = RemoteSessionSchemas.viewRequest(message.request)
    if (!request) { state.connection.close(); return }
    const counted = request.operation !== 'views.close'
    if (counted && state.viewRequests >= 16) {
      state.connection.send({ type: 'session-view-response', response: { requestId: request.requestId, operation: request.operation,
        result: { ok: false, error: { code: 'unavailable', detail: 'Too many source view requests are in flight' } } } })
      return
    }
    if (counted) state.viewRequests++
    try { await this.handle(state, message) }
    finally { if (counted) state.viewRequests-- }
  }

  private async handle(
    state: InboundPeerState,
    message: RemoteControlPeerInboundApplicationMessage,
  ): Promise<void> {
    if (state.closed) return
    if (message.type === 'session-view-request') {
      const request = RemoteSessionSchemas.viewRequest(message.request)
      if (!request) { state.connection.close(); return }
      const result = this.deps.sessionViews
        ? await this.deps.sessionViews.request(state.connection, request)
        : { ok: false as const, error: { code: 'unavailable' as const, detail: 'Session views are unavailable' } }
      if (!state.closed) state.connection.send({ type: 'session-view-response', response: { requestId: request.requestId, operation: request.operation, result } })
    } else if (message.type === 'session-state-request') {
      const request = RemoteSessionSchemas.stateRequest(message.request)
      const record = JsonShape.record(message.request)
      const requestId = request?.requestId ?? (typeof record?.requestId === 'string' ? record.requestId.slice(0, 256) : 'invalid')
      const result = !state.connection.capabilities.includes('session-workspace.read')
        ? { ok: false as const, error: { code: 'forbidden' as const, detail: 'Session workspace discovery was not granted' } }
        : request === null
          ? { ok: false as const, error: { code: 'invalid-request' as const, detail: 'Invalid session state request' } }
          : this.deps.sessionSnapshots?.page(request)
            ?? { ok: false as const, error: { code: 'unavailable' as const, detail: 'Session discovery is unavailable' } }
      state.connection.send({ type: 'session-state-response', response: { requestId, result } })
    } else if (message.type === 'control-request')
      await this.control(state, message.request)
    else if (message.type === 'socket-request')
      await this.socket(state, message.request)
    else if (message.type === 'control-response' || message.type === 'socket-response' || message.type === 'session-state-response' || message.type === 'session-view-response') {
      this.deps.onError('Remote peer sent a response on an inbound-only connection')
      state.connection.close()
    } else
      throw new Error(`Unknown inbound peer message: ${JSON.stringify(message)}`)
  }

  private async control(
    state: InboundPeerState,
    request: unknown,
  ): Promise<void> {
    const allowed = RemoteControlPeerConst.controlOperations.filter((operation) =>
      state.connection.capabilities.includes(`control:${operation}`))
    const response = await this.deps.control.execute(request, {
      callerId: state.caller.callerId,
      callerKind: 'remote-peer',
      allowedOperations: allowed,
    })
    state.connection.send({ type: 'control-response', response })
    this.audit.peerControl(request, response, state.caller)
  }

  /**
   * The peer half of one shared protocol. Everything below is what makes this transport different
   * from the local WebSocket: a peer is granted operations one by one, its attachments are drawn in
   * the inbound list, and a terminal that ends takes its attachment with it.
   */
  private socket(state: InboundPeerState, input: unknown): Promise<void> {
    const caller: RemoteControlSocketCaller = {
      ownerId: state.ownerId,
      caller: state.caller,
      connectionId: state.connection.connectionId,
      closed: () => state.closed,
      granted: (operation) => state.connection.capabilities.includes(`socket:${operation}`),
      send: (response) => state.connection.send({ type: 'socket-response', response }),
      subscribe: (afterRevision): RemoteControlSocketSubscription => {
        state.subscribed = true
        return this.eventStore.replay(afterRevision)
      },
      attached: (attachId, sessionId) => {
        state.attachments.set(attachId, sessionId)
        this.deps.onChanged()
      },
      detached: (attachId) => this.removeAttachment(state, attachId),
      frame: (attachId, frame) => {
        state.connection.send({
          type: 'socket-response',
          response: {
            protocol: RemoteControlConst.protocol,
            type: 'terminal.frame',
            attachId,
            frame,
            terminalOutputUntrusted: true,
          },
        })
        if (frame.type === 'terminal.exit'
          || (frame.type === 'terminal.status' && frame.status === 'lost'))
          this.removeAttachment(state, attachId)
      },
    }
    return this.operations.handle(caller, input)
  }

  private removeAttachment(state: InboundPeerState, attachId: string): void {
    if (!state.attachments.delete(attachId)) return
    this.deps.onChanged()
  }

  private closed(key: string, state: InboundPeerState): void {
    if (state.closed) return
    state.closed = true
    this.deps.sessionViews?.releaseConnection(state.connection)
    this.deps.terminal.detachOwner(state.ownerId)
    state.attachments.clear()
    if (this.byEndpoint.get(key) === state) {
      this.byEndpoint.delete(key)
      this.deps.onChanged()
    }
  }

  private static endpointKey(identity: {
    remoteComputerId: string
    remoteEndpointId: string
  }): string {
    return `${identity.remoteComputerId}\u0000${identity.remoteEndpointId}`
  }

}
