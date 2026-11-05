import type { PerfSpans } from '../../../lib-orchestrator/perfMonitor/perfSpans'
import { PeerTerminalOutput } from './peerTerminalOutput'
import type { RemoteControlSocketOperation } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { PeerRequestFamily } from './peerFrontDoor'
import type { RemoteControlEventKind, RemoteControlRequestUnion } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import type { RemoteInboundConnectionDto, RemoteControlPeerTransport } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteControlPeerInboundApplicationMessage } from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { RemoteControlLiveTerminal } from '../../../lib-orchestrator/remoteControl/remoteControlLiveTerminal'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import { RemoteControlEventStore } from '../../../lib-orchestrator/remoteControl/remoteControlEventStore'
import { RemoteControlOperationStore } from '../../../lib-orchestrator/remoteControl/remoteControlOperationStore'
import { RemoteControlSocketOperations, type RemoteControlSocketCaller } from '../../../lib-orchestrator/remoteControl/remoteControlSocketOperations'
import { RemoteControlSocketValidation } from '../../../lib-orchestrator/remoteControl/remoteControlSocketValidation'
import { RemoteControlRequestValidation } from '../../../lib-orchestrator/remoteControl/remoteControlRequestValidation'
import { RemoteControlEnvelope, RemoteControlSocketEnvelope } from '../../../lib-orchestrator/remoteControl/remoteControlEnvelope'
import type { RemoteControlPeerAudit, RemoteControlAuditCaller } from '../../../lib-orchestrator/remoteControl/remoteControlAuditRows'
import { RemoteSessionSchemas } from '../../../lib-orchestrator/remoteControl/remoteSessionSchemas'
import { RemoteSessionCapabilities } from '../../../lib-orchestrator/remoteControl/remoteSessionCapabilities'
import { JsonShape } from '../../../lib-orchestrator/shared/jsonShape'
import type { PeerForwardPort } from '../../../lib-orchestrator/remoteControl/peerProcess.types'
import type { PeerTrustSet } from '../../../lib-orchestrator/remoteControl/peerTrustSet'
import { PeerFrontDoor } from './peerFrontDoor'

export interface RemoteControlInboundRegistryDeps {
  perf: Pick<PerfSpans, 'span'>
  forward: PeerForwardPort
  terminal: Pick<RemoteControlLiveTerminal, 'attachLive' | 'inputLive' | 'resizeLive' | 'setLiveActive' | 'detachLive' | 'detachOwner' | 'pasteImageLive' | 'pasteFileLive'>
  trust: Pick<PeerTrustSet, 'allows'>
  audit: RemoteControlPeerAudit
  onChanged(): void
  onError(message: string): void
  now?(): number
  eventLimit?: number
}

interface InboundPeerState {
  connection: RemoteControlPeerTransport
  connectedAt: number
  ownerId: string
  caller: RemoteControlAuditCaller
  attachments: Map<string, string>
  subscribed: boolean
  closed: boolean
  output: PeerTerminalOutput
  operations: RemoteControlSocketOperations
  door: PeerFrontDoor
  abort: AbortController
  work: Set<Promise<void>>
}

export class RemoteControlInboundRegistry {
  private readonly deps: RemoteControlInboundRegistryDeps
  private readonly byEndpoint: Map<string, InboundPeerState>
  private readonly work: Set<Promise<void>>
  private readonly eventStore: RemoteControlEventStore
  private readonly operationStore: RemoteControlOperationStore
  private readonly now: () => number

  constructor(deps: RemoteControlInboundRegistryDeps) {
    this.deps = deps
    this.byEndpoint = new Map()
    this.work = new Set()
    this.now = deps.now ?? Date.now
    this.eventStore = new RemoteControlEventStore(deps.eventLimit, this.now)
    this.operationStore = new RemoteControlOperationStore()
  }

  add(connection: RemoteControlPeerTransport): void {
    if (!this.deps.trust.allows(connection.remoteIdentity)) { connection.close(); return }
    const key = RemoteControlInboundRegistry.endpointKey(connection.remoteIdentity)
    const previous = this.byEndpoint.get(key)
    if (previous) { this.retire(key, previous); previous.connection.close() }
    const identity = connection.remoteIdentity
    const ownerId = `remote-peer:${identity.remoteComputerId}:${identity.remoteEndpointId}:${connection.connectionId}`
    const output = new PeerTerminalOutput(ownerId, this.deps.terminal, connection, this.deps.perf)
    const state: InboundPeerState = {
      connection, connectedAt: this.now(),
      ownerId, output, operations: new RemoteControlSocketOperations(output, this.deps.audit, 'peer-socket', this.operationStore),
      caller: { callerId: `remote-peer:${identity.remoteComputerId}:${identity.remoteEndpointId}`, callerKind: 'remote-peer' },
      attachments: new Map(), subscribed: false, closed: false, door: new PeerFrontDoor(), abort: new AbortController(), work: new Set(),
    }
    this.byEndpoint.set(key, state)
    connection.onMessage(message => {
      let work: Promise<void>
      try { work = this.route(state, message) }
      catch (error) { work = Promise.reject(error) }
      state.work.add(work)
      this.work.add(work)
      void work.catch(error => {
        if (state.closed) return
        this.deps.onError(`Remote peer request failed: ${ErrorText.of(error)}`)
        connection.close()
      }).finally(() => { state.work.delete(work); this.work.delete(work) })
    })
    connection.onClose(() => this.retire(key, state))
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


  async closeEndpoint(remoteComputerId: string, remoteEndpointId: string): Promise<void> {
    const key = RemoteControlInboundRegistry.endpointKey({ remoteComputerId, remoteEndpointId })
    const state = this.byEndpoint.get(key)
    if (!state) return
    this.retire(key, state)
    state.connection.close()
    await Promise.allSettled([...state.work])
  }

  async reconcileTrust(): Promise<void> {
    await Promise.all([...this.byEndpoint.values()].filter(state => !this.deps.trust.allows(state.connection.remoteIdentity))
      .map(state => this.closeEndpoint(state.connection.remoteIdentity.remoteComputerId, state.connection.remoteIdentity.remoteEndpointId)))
  }

  publishEvent(kind: RemoteControlEventKind): void {
    const event = this.eventStore.publish(kind)
    for (const state of this.byEndpoint.values())
      if (state.subscribed && this.active(state)) state.connection.send({ type: 'socket-response',
        response: { protocol: RemoteControlConst.protocol, type: 'event', event } })
  }

  async stop(): Promise<void> {
    await Promise.all([...this.byEndpoint.values()].map(state =>
      this.closeEndpoint(state.connection.remoteIdentity.remoteComputerId, state.connection.remoteIdentity.remoteEndpointId)))
    await Promise.allSettled([...this.work])
  }

  private route(state: InboundPeerState, message: RemoteControlPeerInboundApplicationMessage): Promise<void> {
    if (!this.active(state)) { state.connection.close(); return Promise.resolve() }
    if (message.type === 'socket-request') {
      const parsed = RemoteControlSocketValidation.parse(message.request)
      if (!parsed.ok) return this.socket(state, message.request)
      const request = parsed.request
      if (!state.connection.capabilities.includes(`socket:${request.operation}`)) {
        const refusal = RemoteControlSocketEnvelope.refused(request, { code: 'forbidden', detail: `${request.operation} was not granted` })
        state.connection.send({ type: 'socket-response', response: refusal })
        this.deps.audit.socket('peer-socket', request, refusal, state.caller)
        return Promise.resolve()
      }
      const family = RemoteControlInboundRegistry.socketFamily(request.operation)
      return state.door.run(family, () => this.active(state) ? this.socket(state, request) : Promise.resolve())
    } else if (message.type === 'control-request') {
      const parsed = RemoteControlRequestValidation.parse(message.request)
      if (!parsed.ok) {
        const response = RemoteControlEnvelope.failure(parsed.requestId, parsed.operation, parsed.operationId, parsed.error)
        state.connection.send({ type: 'control-response', response })
        this.deps.audit.peerControl(message.request, response, state.caller)
        return Promise.resolve()
      }
      if (!state.connection.capabilities.some(capability => capability === `control:${parsed.request.operation}`)) {
        const response = RemoteControlEnvelope.refused(parsed.request, { code: 'forbidden', detail: `${parsed.request.operation} was not granted` })
        state.connection.send({ type: 'control-response', response })
        this.deps.audit.peerControl(parsed.request, response, state.caller)
        return Promise.resolve()
      }
      return state.door.run('operation', () => this.control(state, parsed.request))
    } else if (message.type === 'session-view-request') {
      const request = RemoteSessionSchemas.viewRequest(message.request)
      if (!request) { state.connection.close(); return Promise.resolve() }
      const refused = RemoteSessionCapabilities.refusal(state.connection, request)
      if (refused !== null) {
        state.connection.send({ type: 'session-view-response', response: { requestId: request.requestId, operation: request.operation,
          result: { ok: false, error: { code: 'forbidden', detail: refused } } } })
        return Promise.resolve()
      }
      return state.door.run('view', async () => {
        if (!this.active(state)) return
        const result = await this.deps.forward.view(state.connection, request, state.abort.signal)
        if (this.active(state)) state.connection.send({ type: 'session-view-response', response: { requestId: request.requestId, operation: request.operation, result } })
      }, { closeView: request.operation === 'views.close', overflow: () => {
        state.connection.send({ type: 'session-view-response', response: { requestId: request.requestId, operation: request.operation,
          result: { ok: false, error: { code: 'unavailable', detail: 'Too many source view requests are in flight' } } } })
      } })
    } else if (message.type === 'session-state-request') {
      const request = RemoteSessionSchemas.stateRequest(message.request)
      const record = JsonShape.record(message.request)
      const requestId = request?.requestId ?? (typeof record?.requestId === 'string' ? record.requestId.slice(0, 256) : 'invalid')
      if (!state.connection.capabilities.includes('session-workspace.read') || request === null) {
        const error = !state.connection.capabilities.includes('session-workspace.read')
          ? { code: 'forbidden' as const, detail: 'Session workspace discovery was not granted' }
          : { code: 'invalid-request' as const, detail: 'Invalid session state request' }
        state.connection.send({ type: 'session-state-response', response: { requestId, result: { ok: false, error } } })
        return Promise.resolve()
      }
      return state.door.run('operation', async () => {
        if (!this.active(state)) return
        const result = await this.deps.forward.state(state.connection, request, state.abort.signal)
        if (this.active(state)) state.connection.send({ type: 'session-state-response', response: { requestId, result } })
      })
    } else if (message.type === 'control-response' || message.type === 'socket-response' || message.type === 'session-state-response' || message.type === 'session-view-response') {
      this.deps.onError('Remote peer sent a response on an inbound-only connection')
      state.connection.close()
      return Promise.resolve()
    } else throw new Error(`Unknown inbound peer message: ${JSON.stringify(message)}`)
  }

  private async control(state: InboundPeerState, request: RemoteControlRequestUnion): Promise<void> {
    if (!this.active(state)) return
    const response = await this.deps.forward.execute(state.connection, request, state.abort.signal)
    if (this.active(state)) state.connection.send({ type: 'control-response', response })
  }

  private socket(state: InboundPeerState, input: unknown): Promise<void> {
    const caller: RemoteControlSocketCaller = {
      ownerId: state.ownerId, caller: state.caller, connectionId: state.connection.connectionId,
      closed: () => !this.active(state),
      granted: operation => this.active(state) && state.connection.capabilities.includes(`socket:${operation}`),
      send: response => { if (this.active(state)) state.connection.send({ type: 'socket-response', response }) },
      subscribe: afterRevision => { state.subscribed = true; return this.eventStore.replay(afterRevision) },
      attached: (attachId, sessionId) => {
        if (!this.active(state)) { state.output.detachLive(state.ownerId, attachId); return }
        state.attachments.set(attachId, sessionId)
        this.deps.onChanged()
      },
      detached: attachId => this.removeAttachment(state, attachId),
      frame: (attachId, frame) => {
        if (!this.active(state)) return
        if (frame.type === 'terminal.exit' || frame.type === 'terminal.status' && frame.status === 'lost')
          this.removeAttachment(state, attachId)
      },
    }
    return state.operations.handle(caller, input)
  }

  private active(state: InboundPeerState): boolean {
    return !state.closed && this.byEndpoint.get(RemoteControlInboundRegistry.endpointKey(state.connection.remoteIdentity)) === state
      && this.deps.trust.allows(state.connection.remoteIdentity)
  }

  private removeAttachment(state: InboundPeerState, attachId: string): void {
    if (!state.attachments.delete(attachId)) return
    this.deps.onChanged()
  }

  private retire(key: string, state: InboundPeerState): void {
    if (state.closed) return
    state.closed = true
    state.abort.abort()
    this.deps.forward.releaseConnection(state.connection)
    state.output.detachOwner(state.ownerId)
    state.attachments.clear()
    if (this.byEndpoint.get(key) === state) { this.byEndpoint.delete(key); this.deps.onChanged() }
  }

  private static socketFamily(operation: RemoteControlSocketOperation): PeerRequestFamily {
    switch (operation) {
      case 'terminal.attach': return 'attach'
      case 'events.subscribe': return 'operation'
      case 'terminal.input':
      case 'terminal.resize':
      case 'terminal.active':
      case 'terminal.detach':
      case 'terminal.pasteImage':
      case 'terminal.pasteFile': return 'attached'
      default: throw new Error(`Unknown peer socket operation: ${operation}`)
    }
  }

  private static endpointKey(identity: { remoteComputerId: string; remoteEndpointId: string }): string {
    return JSON.stringify([identity.remoteComputerId, identity.remoteEndpointId])
  }
}
