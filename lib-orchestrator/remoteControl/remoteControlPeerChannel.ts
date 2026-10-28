import { RemoteControlEnvelope, RemoteControlSocketEnvelope } from './remoteControlEnvelope'
import type {
  RemoteControlError,
  RemoteControlRequestUnion,
  RemoteControlResponse,
  RemoteControlSocketRequest,
  RemoteControlSocketResponse,
  RemoteControlStepResult,
} from './remoteControlApi.types'
import { RemoteControlResponseValidation } from './core/remoteControlResponseValidation'
import type { RemoteControlPeerTransport } from './remoteConnectionsApi.types'
import type { RemoteControlPeerInboundApplicationMessage } from './remoteControlPeerApi.types'
import type { RemoteSessionStateRequest, RemoteSessionStatePage, RemoteSessionViewRequest, RemoteSessionViewResponse } from './remoteSessionApi.types'
import { RemoteSessionSchemas } from './remoteSessionSchemas'

interface PendingSessionState {
  request: RemoteSessionStateRequest
  timer: ReturnType<typeof setTimeout>
  resolve(result: RemoteControlStepResult<RemoteSessionStatePage>): void
}

interface PendingControl {
  operation: RemoteControlRequestUnion['operation']
  operationId: string | null
  timer: ReturnType<typeof setTimeout>
  resolve(response: RemoteControlResponse): void
}

interface PendingSocket {
  operation: RemoteControlSocketRequest['operation']
  operationId: string | null
  timer: ReturnType<typeof setTimeout>
  resolve(response: Extract<RemoteControlSocketResponse, { type: 'response' }>): void
}

export interface RemoteControlPeerChannelOptions {
  requestTimeoutMilliseconds?: number
  onError?(message: string): void
}

export class RemoteControlPeerChannel {
  private static readonly requestTimeoutMillisecondsConst = 10_000
  private readonly sessionViews = new Map<string, { request: RemoteSessionViewRequest; timer: ReturnType<typeof setTimeout>; resolve(response: RemoteSessionViewResponse['result']): void }>()
  private readonly controls = new Map<string, PendingControl>()
  private readonly sockets = new Map<string, PendingSocket>()
  private readonly sessionStates = new Map<string, PendingSessionState>()
  private readonly eventListeners = new Set<(
    event: Extract<RemoteControlSocketResponse, { type: 'event' }>,
  ) => void>()
  private readonly terminalListeners = new Set<(
    frame: Extract<RemoteControlSocketResponse, { type: 'terminal.frame' }>,
  ) => void>()
  private readonly releaseMessage: () => void
  private readonly releaseClose: () => void
  private closed = false

  constructor(
    readonly transport: RemoteControlPeerTransport,
    private readonly options?: RemoteControlPeerChannelOptions,
  ) {
    this.releaseMessage = transport.onMessage((message) => this.receive(message))
    this.releaseClose = transport.onClose(() => this.finishClose())
  }

  control(request: RemoteControlRequestUnion): Promise<RemoteControlResponse> {
    if (request.operation === 'accounts.list' && !this.granted('agents.accounts'))
      return Promise.resolve(RemoteControlPeerChannel.controlFailure(request, 'forbidden', 'Remote peer did not grant agents.accounts'))
    if (request.operation === 'sessions.create' && !this.granted('agents.accounts')) {
      const { account: _account, ...spec } = request.body.spec
      if (spec.agent) {
        const { accountId: _accountId, ...agent } = spec.agent
        spec.agent = agent
      }
      request = { ...request, body: { ...request.body, spec } }
    }
    if (this.closed || !this.transport.isOpen())
      return Promise.resolve(RemoteControlPeerChannel.controlFailure(
        request,
        'unavailable',
        'Remote AppClientUI is offline',
      ))
    if (!this.granted(`control:${request.operation}`))
      return Promise.resolve(RemoteControlPeerChannel.controlFailure(
        request,
        'forbidden',
        `Remote peer did not grant ${request.operation}`,
      ))
    if (this.controls.has(request.requestId) || this.sockets.has(request.requestId) || this.sessionStates.has(request.requestId) || this.sessionViews.has(request.requestId))
      return Promise.resolve(RemoteControlPeerChannel.controlFailure(
        request,
        'conflict',
        `requestId ${JSON.stringify(request.requestId)} is already pending`,
      ))
    return new Promise((resolve) => {
      const pending: PendingControl = {
        operation: request.operation,
        operationId: request.operationId ?? null,
        timer: this.timeout(() => {
          if (this.controls.get(request.requestId) !== pending) return
          this.controls.delete(request.requestId)
          resolve(RemoteControlPeerChannel.controlFailure(
            request,
            'timeout',
            'Remote control request timed out',
          ))
        }),
        resolve,
      }
      this.controls.set(request.requestId, pending)
      if (!this.transport.send({ type: 'control-request', request })) {
        this.controls.delete(request.requestId)
        clearTimeout(pending.timer)
        resolve(RemoteControlPeerChannel.controlFailure(
          request,
          'unavailable',
          'Remote AppClientUI is offline',
        ))
      }
    })
  }

  socket(
    request: RemoteControlSocketRequest,
  ): Promise<Extract<RemoteControlSocketResponse, { type: 'response' }>> {
    if (this.closed || !this.transport.isOpen())
      return Promise.resolve(RemoteControlPeerChannel.socketFailure(
        request,
        'unavailable',
        'Remote AppClientUI is offline',
      ))
    if (!this.granted(`socket:${request.operation}`))
      return Promise.resolve(RemoteControlPeerChannel.socketFailure(
        request,
        'forbidden',
        `Remote peer did not grant ${request.operation}`,
      ))
    if (this.controls.has(request.requestId) || this.sockets.has(request.requestId) || this.sessionStates.has(request.requestId) || this.sessionViews.has(request.requestId))
      return Promise.resolve(RemoteControlPeerChannel.socketFailure(
        request,
        'conflict',
        `requestId ${JSON.stringify(request.requestId)} is already pending`,
      ))
    return new Promise((resolve) => {
      const pending: PendingSocket = {
        operation: request.operation,
        operationId: request.operation === 'events.subscribe' ? null : request.operationId,
        timer: this.timeout(() => {
          if (this.sockets.get(request.requestId) !== pending) return
          this.sockets.delete(request.requestId)
          resolve(RemoteControlPeerChannel.socketFailure(
            request,
            'timeout',
            'Remote socket request timed out',
          ))
        }),
        resolve,
      }
      this.sockets.set(request.requestId, pending)
      if (!this.transport.send({ type: 'socket-request', request })) {
        this.sockets.delete(request.requestId)
        clearTimeout(pending.timer)
        resolve(RemoteControlPeerChannel.socketFailure(
          request,
          'unavailable',
          'Remote AppClientUI is offline',
        ))
      }
    })
  }

  onEvent(listener: (
    event: Extract<RemoteControlSocketResponse, { type: 'event' }>,
  ) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onTerminalFrame(listener: (
    frame: Extract<RemoteControlSocketResponse, { type: 'terminal.frame' }>,
  ) => void): () => void {
    this.terminalListeners.add(listener)
    return () => this.terminalListeners.delete(listener)
  }

  close(): void {
    this.transport.close()
    this.finishClose()
  }

  sessionView(request: RemoteSessionViewRequest): Promise<RemoteSessionViewResponse['result']> {
    if (this.closed || !this.transport.isOpen())
      return Promise.resolve({ ok: false, error: { code: 'unavailable', detail: 'Remote AppClientUI is offline' } })
    if (!this.granted('session-workspace.views') || !this.granted(RemoteSessionSchemas.viewCapabilities[request.operation]))
      return Promise.resolve({ ok: false, error: { code: 'forbidden', detail: 'Remote peer does not support this session view operation' } })
    if (!RemoteSessionSchemas.viewRequest(request))
      return Promise.resolve({ ok: false, error: { code: 'invalid-request', detail: 'Invalid session view request' } })
    if (this.sessionViews.has(request.requestId) || this.sessionStates.has(request.requestId) || this.controls.has(request.requestId) || this.sockets.has(request.requestId))
      return Promise.resolve({ ok: false, error: { code: 'conflict', detail: 'Session view request ID is already pending' } })
    return new Promise((resolve) => {
      const timer = this.timeout(() => {
        this.sessionViews.delete(request.requestId)
        resolve({ ok: false, error: { code: 'timeout', detail: 'Remote session view request timed out' } })
      })
      this.sessionViews.set(request.requestId, { request, timer, resolve })
      if (!this.transport.send({ type: 'session-view-request', request })) {
        clearTimeout(timer)
        this.sessionViews.delete(request.requestId)
        resolve({ ok: false, error: { code: 'unavailable', detail: 'Remote session view request could not be sent' } })
      }
    })
  }

  sessionState(request: RemoteSessionStateRequest): Promise<RemoteControlStepResult<RemoteSessionStatePage>> {
    if (this.closed || !this.transport.isOpen())
      return Promise.resolve({ ok: false, error: { code: 'unavailable', detail: 'Remote AppClientUI is offline' } })
    if (!this.granted('session-workspace.read'))
      return Promise.resolve({ ok: false, error: { code: 'forbidden', detail: 'Remote peer does not support session workspace discovery' } })
    if (RemoteSessionSchemas.stateRequest(request) === null)
      return Promise.resolve({ ok: false, error: { code: 'invalid-request', detail: 'Invalid session state request' } })
    if (this.sessionStates.has(request.requestId) || this.sessionViews.has(request.requestId) || this.controls.has(request.requestId) || this.sockets.has(request.requestId))
      return Promise.resolve({ ok: false, error: { code: 'conflict', detail: 'Session state request ID is already pending' } })
    return new Promise((resolve) => {
      const timer = this.timeout(() => {
        this.sessionStates.delete(request.requestId)
        resolve({ ok: false, error: { code: 'timeout', detail: 'Remote session state request timed out' } })
      })
      this.sessionStates.set(request.requestId, { request, timer, resolve })
      if (!this.transport.send({ type: 'session-state-request', request })) {
        clearTimeout(timer)
        this.sessionStates.delete(request.requestId)
        resolve({ ok: false, error: { code: 'unavailable', detail: 'Remote session state request could not be sent' } })
      }
    })
  }

  /**
   * Everything here came off ANOTHER COMPUTER. Being paired proves who is on the far end, not that
   * what it sends is well formed, so each answer is validated before a pending request is settled
   * with it - until 2026-08-23 nothing was, and the types said otherwise.
   */
  private receive(message: RemoteControlPeerInboundApplicationMessage): void {
    if (this.closed) return
    if (message.type === 'session-view-response') {
      const answer = RemoteSessionSchemas.viewResponse(message.response)
      if (!answer) { this.report('Remote peer returned a malformed view response'); return }
      const pending = this.sessionViews.get(answer.requestId)
      if (!pending || answer.operation !== pending.request.operation) return
      if (answer.result.ok && answer.result.value !== null && 'viewId' in answer.result.value) {
        const view = answer.result.value
        const request = pending.request
        if (request.operation !== 'views.open' || view.epoch !== request.epoch || view.sessionId !== request.body.sessionId || view.viewerId !== request.body.viewerId) return
      }
      this.sessionViews.delete(answer.requestId)
      clearTimeout(pending.timer)
      pending.resolve(answer.result)
    } else if (message.type === 'session-state-response') {
      const answer = RemoteSessionSchemas.stateResponse(message.response)
      if (!answer) {
        this.report('Remote peer returned a malformed session state response')
        return
      }
      const pending = this.sessionStates.get(answer.requestId)
      if (!pending) return
      if (answer.result.ok) {
        const page = answer.result.value
        const request = pending.request
        if (page.kind !== request.kind || page.offset !== request.offset
          || (request.expected !== null && (page.epoch !== request.expected.epoch || page.revision !== request.expected.revision))
          || (page.kind === 'detail' && request.kind === 'detail' && page.sessionId !== request.sessionId)) {
          this.report('Remote peer returned mismatched session state')
          return
        }
      }
      clearTimeout(pending.timer)
      this.sessionStates.delete(answer.requestId)
      pending.resolve(answer.result)
    } else if (message.type === 'control-response') {
      const answer = RemoteControlResponseValidation.control(message.response)
      if (answer === null) {
        this.report('Remote peer returned a malformed control response')
        return
      }
      const pending = answer.requestId === null
        ? undefined
        : this.controls.get(answer.requestId)
      if (!pending
        || answer.operation !== pending.operation
        || answer.operationId !== pending.operationId) {
        this.report('Remote peer returned an unmatched control response')
        return
      }
      this.controls.delete(answer.requestId as string)
      clearTimeout(pending.timer)
      pending.resolve(answer)
    } else if (message.type === 'socket-response') {
      const response = RemoteControlResponseValidation.socket(message.response)
      if (response === null) {
        this.report('Remote peer returned a malformed socket response')
        return
      }
      if (response.type === 'event')
        for (const listener of this.eventListeners) listener(response)
      else if (response.type === 'terminal.frame')
        for (const listener of this.terminalListeners) listener(response)
      else if (response.type === 'response') {
        const pending = response.requestId === null
          ? undefined
          : this.sockets.get(response.requestId)
        if (!pending
          || response.operation !== pending.operation
          || response.operationId !== pending.operationId) {
          this.report('Remote peer returned an unmatched socket response')
          return
        }
        this.sockets.delete(response.requestId as string)
        clearTimeout(pending.timer)
        pending.resolve(response)
      } else
        throw new Error(`Unknown remote socket response: ${JSON.stringify(response)}`)
    } else if (message.type === 'control-request' || message.type === 'socket-request' || message.type === 'session-state-request' || message.type === 'session-view-request') {
      this.report('Remote peer sent a request on an outbound-only connection')
      this.close()
    } else
      throw new Error(`Unknown remote peer application message: ${JSON.stringify(message)}`)
  }

  private finishClose(): void {
    if (this.closed) return
    this.closed = true
    this.releaseMessage()
    this.releaseClose()
    for (const [requestId, pending] of this.controls) {
      clearTimeout(pending.timer)
      pending.resolve(RemoteControlEnvelope.failure(
        requestId,
        pending.operation,
        pending.operationId,
        { code: 'unavailable', detail: 'Remote AppClientUI disconnected' },
      ))
    }
    for (const [requestId, pending] of this.sockets) {
      clearTimeout(pending.timer)
      pending.resolve(RemoteControlSocketEnvelope.failure(
        requestId,
        pending.operation,
        pending.operationId,
        { code: 'unavailable', detail: 'Remote AppClientUI disconnected' },
      ))
    }
    this.controls.clear()
    this.sockets.clear()
    for (const pending of this.sessionStates.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, error: { code: 'unavailable', detail: 'Remote AppClientUI disconnected' } })
    }
    this.sessionStates.clear()
    for (const pending of this.sessionViews.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, error: { code: 'unavailable', detail: 'Remote AppClientUI disconnected' } })
    }
    this.sessionViews.clear()
    this.eventListeners.clear()
    this.terminalListeners.clear()
  }

  private timeout(callback: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(
      callback,
      this.options?.requestTimeoutMilliseconds
        ?? RemoteControlPeerChannel.requestTimeoutMillisecondsConst,
    )
    timer.unref?.()
    return timer
  }

  /**
   * A name a peer CAN be granted, or one it cannot: `control:tabs.open` is never on the list, and
   * asking for it has to answer false rather than fail to compile.
   */
  private granted(capability: string): boolean {
    return this.transport.capabilities.some((granted) => granted === capability)
  }

  private report(message: string): void {
    try { this.options?.onError?.(message) } catch {}
  }

  private static controlFailure(
    request: RemoteControlRequestUnion,
    code: RemoteControlError['code'],
    detail: string,
  ): RemoteControlResponse {
    return RemoteControlEnvelope.refused(request, { code, detail })
  }

  private static socketFailure(
    request: RemoteControlSocketRequest,
    code: RemoteControlError['code'],
    detail: string,
  ): Extract<RemoteControlSocketResponse, { type: 'response' }> {
    return RemoteControlSocketEnvelope.refused(request, { code, detail })
  }
}
