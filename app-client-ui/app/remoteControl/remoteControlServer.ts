import { RemoteControlEnvelope } from '../../../lib-orchestrator/remoteControl/remoteControlEnvelope'
import { randomBytes, randomUUID } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocket, WebSocketServer, type RawData } from 'ws'

import { RemoteControlOperationStore } from '../../../lib-orchestrator/remoteControl/remoteControlOperationStore'
import { RemoteControlRequestValidation } from '../../../lib-orchestrator/remoteControl/remoteControlRequestValidation'
import type { RemoteControl } from '../../../lib-orchestrator/remoteControl/remoteControl'
import type {
  RemoteControlDescriptor,
  RemoteControlError,
  RemoteControlErrorCode,
  RemoteControlEventKind,
  RemoteControlHelloDto,
  RemoteControlLocalOperation,
  RemoteControlLocalResponse,
  RemoteControlOperation,
  RemoteControlRequest,
  RemoteControlResponse,
  RemoteControlSocketResponse,
  RemoteControlSystemIdentity,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst, RemoteControlLocalConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteControlPeerConst } from '../../../lib-orchestrator/remoteControl/remoteControlPeerProtocol'
import type { RemoteControlTerminal } from '../../../lib-orchestrator/remoteControl/remoteControlTerminal'
import type { TerminalFrame } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ErrorText } from '../../shared/errorText'
import { RemoteControlEventStore } from './core/remoteControlEventStore'
import { RemoteControlHttpBoundary } from './core/remoteControlHttpBoundary'
import {
  RemoteControlLocalOperations,
  type RemoteControlLocalPort,
} from './core/remoteControlLocalOperations'
import {
  RemoteControlSocketOperations,
  type RemoteControlSocketCaller,
  type RemoteControlSocketSubscription,
} from './core/remoteControlSocketOperations'
import { RemoteControlAudit, type RemoteControlAuditCaller } from './remoteControlAudit'
import { RemoteControlDescriptorStore } from './remoteControlDescriptorStore'
import { RemoteControlInstanceRegistration } from '../../../lib-orchestrator/remoteControl/remoteControlInstanceRegistry'
import { RemoteControlInstanceStore } from './remoteControlInstanceStore'
import { JsonShape } from '../../../lib-orchestrator/shared/jsonShape'

export interface RemoteControlServerDeps {
  identity: RemoteControlSystemIdentity
  control: Pick<RemoteControl, 'execute'>
  terminal: Pick<
    RemoteControlTerminal,
    'attachLive' | 'inputLive' | 'resizeLive' | 'setLiveActive' | 'detachLive' | 'detachOwner'
  >
  descriptorFile: string
  compatibilityDescriptorFile?: string
  instanceStore?: Pick<RemoteControlInstanceStore, 'write' | 'removeIfOwned'>
  auditFile: string
  onError(message: string): void
  token?(): string
  socketId?(): string
  eventLimit?: number
  local?: RemoteControlLocalPort
}

type RemoteControlHttpResponse = RemoteControlResponse | RemoteControlLocalResponse

type RemoteControlHttpBody =
  | { ok: true; input: unknown }
  | { ok: false; input: unknown; response: RemoteControlHttpResponse; status: number }

interface RemoteControlSocketState {
  ownerId: string
  caller: RemoteControlAuditCaller
  closed: boolean
  /** Answered the last ping. A socket that misses two in a row is holding PTY attachments open. */
  alive: boolean
  queue: Promise<void>
}

export class RemoteControlServer {
  private static readonly maximumWebSocketConnectionsConst = 64
  private static readonly maximumWebSocketPayloadBytesConst = 1_048_576
  /*
   * Terminal frames come off a PTY that does not wait for anybody. A reader that stops reading -
   * suspended, wedged, or gone without closing - otherwise buffers inside THIS process without any
   * bound at all, and the process it fills is the one drawing the window.
   */
  private static readonly maximumWebSocketBufferedBytesConst = 4_194_304
  private static readonly pingIntervalMillisecondsConst = 15_000
  private readonly token: string
  private readonly socketId: () => string
  private readonly descriptorStore: RemoteControlDescriptorStore
  private readonly compatibilityDescriptorStore: RemoteControlDescriptorStore | null
  private readonly instanceStore: Pick<RemoteControlInstanceStore, 'write' | 'removeIfOwned'> | null
  private readonly audit: RemoteControlAudit
  private readonly boundary: RemoteControlHttpBoundary
  private readonly eventStore: RemoteControlEventStore
  private readonly operations: RemoteControlSocketOperations
  private readonly localOperations: RemoteControlLocalOperations
  private readonly operationStore = new RemoteControlOperationStore()
  private readonly server = http.createServer((request, response) => {
    void this.handleHttp(request, response)
  })
  private readonly webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: RemoteControlServer.maximumWebSocketPayloadBytesConst,
  })
  private readonly eventSubscribers = new Set<WebSocket>()
  private readonly socketStates = new Map<WebSocket, RemoteControlSocketState>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private descriptorValue: RemoteControlDescriptor | null = null
  private startPromise: Promise<RemoteControlDescriptor> | null = null
  private stopping = false
  private port = 0

  constructor(private readonly deps: RemoteControlServerDeps) {
    this.token = (deps.token ?? (() => randomBytes(32).toString('base64url')))()
    this.socketId = deps.socketId ?? randomUUID
    this.descriptorStore = new RemoteControlDescriptorStore(deps.descriptorFile)
    this.compatibilityDescriptorStore = deps.compatibilityDescriptorFile === undefined
      ? null
      : new RemoteControlDescriptorStore(deps.compatibilityDescriptorFile)
    this.instanceStore = deps.instanceStore ?? null
    this.audit = new RemoteControlAudit(deps.auditFile, deps.onError)
    this.boundary = new RemoteControlHttpBoundary(this.token)
    this.eventStore = new RemoteControlEventStore(deps.eventLimit)
    this.operations = new RemoteControlSocketOperations(deps.terminal, this.audit, 'websocket')
    this.localOperations = new RemoteControlLocalOperations(
      deps.local,
      this.operationStore,
      (message) => deps.onError(message),
    )
    this.server.on('upgrade', (request, socket, head) =>
      this.handleUpgrade(request, socket, head))
    this.server.on('clientError', (_error, socket) => socket.destroy())
    this.webSocketServer.on('connection', (socket) => this.socketConnected(socket))
  }

  start(): Promise<RemoteControlDescriptor> {
    if (this.descriptorValue) return Promise.resolve(this.descriptorValue)
    if (this.startPromise) return this.startPromise
    if (this.stopping) return Promise.reject(new Error('Remote control server is stopping'))
    this.startPromise = this.startNow()
    return this.startPromise
  }

  beginStop(): void {
    if (this.stopping) return
    this.stopping = true
    this.removeRegistration(this.deps.identity.instanceId)
    this.descriptorStore.remove()
  }

  async stop(): Promise<void> {
    this.beginStop()
    if (this.startPromise)
      try { await this.startPromise } catch {}
    await this.closeTransport()
    this.audit.flush()
    this.descriptorValue = null
  }

  publishEvent(kind: RemoteControlEventKind): void {
    if (this.stopping) return
    const message: RemoteControlSocketResponse = {
      protocol: RemoteControlConst.protocol,
      type: 'event',
      event: this.eventStore.publish(kind),
    }
    for (const socket of this.eventSubscribers)
      this.sendSocket(socket, message)
  }

  private async startNow(): Promise<RemoteControlDescriptor> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string')
      throw new Error('Remote control server did not resolve its loopback port')
    this.port = address.port
    if (this.stopping) {
      await this.closeTransport()
      throw new Error('Remote control server stopped during startup')
    }
    const descriptor: RemoteControlDescriptor = {
      ...this.deps.identity,
      schemaVersion: 1,
      protocol: RemoteControlConst.protocol,
      address: '127.0.0.1',
      port: this.port,
      pid: process.pid,
      token: this.token,
      operations: RemoteControlConst.descriptorOperations,
      optionalOperations: RemoteControlConst.optionalOperations,
      ...(this.deps.local === undefined
        ? {}
        : { localOperations: RemoteControlLocalConst.operations }),
      websocket: true,
    }
    try {
      this.descriptorStore.write(descriptor)
      this.compatibilityDescriptorStore?.write(descriptor)
      this.instanceStore?.write(RemoteControlInstanceRegistration.of(
        descriptor,
        this.deps.descriptorFile,
      ))
    } catch (error) {
      this.stopping = true
      this.removeRegistration(descriptor.instanceId)
      this.descriptorStore.remove()
      await this.closeTransport()
      throw error
    }
    this.descriptorValue = descriptor
    this.pingTimer = setInterval(
      () => this.pingSockets(),
      RemoteControlServer.pingIntervalMillisecondsConst,
    )
    this.pingTimer.unref?.()
    return descriptor
  }

  private removeRegistration(instanceId: string): void {
    try { this.instanceStore?.removeIfOwned(instanceId) } catch {}
  }

  private async closeTransport(): Promise<void> {
    for (const [socket, state] of this.socketStates) {
      state.closed = true
      this.deps.terminal.detachOwner(state.ownerId)
      try { socket.terminate() } catch {}
    }
    this.socketStates.clear()
    this.eventSubscribers.clear()
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    try { this.webSocketServer.close() } catch {}
    if (!this.server.listening) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_500)
      this.server.close(() => {
        clearTimeout(timer)
        resolve()
      })
      this.server.closeAllConnections()
    })
  }

  /**
   * A loopback socket that stops answering is not a small thing: it holds terminal attachments, and
   * every attachment is a live PTY subscription this process keeps feeding. Two missed pings and it
   * goes, which is what `close` would have done if the far end had managed to send one.
   */
  private pingSockets(): void {
    for (const [socket, state] of this.socketStates) {
      if (!state.alive) {
        this.dropSocket(socket, state, 'stopped answering')
        continue
      }
      state.alive = false
      try { socket.ping() } catch {}
    }
  }

  private dropSocket(socket: WebSocket, state: RemoteControlSocketState, reason: string): void {
    this.deps.onError(`Remote control WebSocket ${reason}; closing it`)
    this.socketClosed(socket, state)
    try { socket.terminate() } catch {}
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const denied = this.boundary.authorize(request, this.port)
    if (denied) {
      RemoteControlHttpBoundary.json(response, { error: denied.detail }, denied.status)
      return
    }
    if (this.stopping) {
      RemoteControlHttpBoundary.json(response, { error: 'unavailable' }, 503)
      return
    }
    try {
      const pathname = (request.url ?? '/').split('?')[0]
      if (request.method === 'GET' && pathname === '/api/v3/hello') {
        await this.executeHttp(this.readRequest('system.hello'), response)
        return
      } else if (request.method === 'GET' && pathname === '/api/v3/status') {
        await this.executeHttp(this.readRequest('system.status'), response)
        return
      } else if (request.method !== 'POST') {
        RemoteControlHttpBoundary.json(
          response,
          RemoteControlServer.failure(null, null, null, 'not-found', 'Route not found'),
          404,
        )
        return
      }
      if (pathname.startsWith('/api/v3/local/op/')) {
        await this.handleLocalHttp(request, response, pathname.slice('/api/v3/local/op/'.length))
        return
      }
      if (pathname.startsWith('/api/v3/remote/')) {
        await this.handleRemoteHttp(request, response, pathname)
        return
      }
      if (pathname.startsWith('/api/v3/op/')) {
        await this.handleControlHttp(request, response, pathname.slice('/api/v3/op/'.length))
        return
      }
      RemoteControlHttpBoundary.json(
        response,
        RemoteControlServer.failure(null, null, null, 'not-found', 'Route not found'),
        404,
      )
    } catch (error) {
      this.deps.onError(`Remote control HTTP request failed: ${ErrorText.of(error)}`)
      RemoteControlHttpBoundary.json(
        response,
        RemoteControlServer.failure(
          null,
          null,
          null,
          'operation-failed',
          'The request failed unexpectedly',
        ),
        500,
      )
    }
  }

  private async handleControlHttp(
    request: IncomingMessage,
    response: ServerResponse,
    operationName: string,
  ): Promise<void> {
    if (!RemoteControlServer.isOperation(operationName)) {
      RemoteControlHttpBoundary.json(
        response,
        RemoteControlServer.failure(null, null, null, 'not-found', 'Operation not found'),
        404,
      )
      return
    }
    const body = await this.httpBody(request, operationName)
    if (!body.ok) {
      this.audit.http(body.input, body.response as RemoteControlResponse, this.httpCaller())
      RemoteControlHttpBoundary.json(response, body.response, body.status)
      return
    }
    await this.executeHttp(body.input, response)
  }

  private async handleLocalHttp(
    request: IncomingMessage,
    response: ServerResponse,
    operationName: string,
  ): Promise<void> {
    if (!RemoteControlServer.isLocalOperation(operationName) || this.deps.local === undefined) {
      RemoteControlHttpBoundary.json(
        response,
        RemoteControlServer.httpFailure(null, null, null, 'not-found', 'Operation not found'),
        404,
      )
      return
    }
    const body = await this.httpBody(request, operationName)
    if (!body.ok) {
      this.audit.localHttp(
        body.input,
        body.response as RemoteControlLocalResponse,
        this.httpCaller(),
      )
      RemoteControlHttpBoundary.json(response, body.response, body.status)
      return
    }
    await this.executeLocalHttp(body.input, response)
  }

  private async handleRemoteHttp(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const route = RemoteControlServer.remoteRoute(pathname)
    if (route === null || this.deps.local === undefined) {
      RemoteControlHttpBoundary.json(
        response,
        RemoteControlServer.failure(null, null, null, 'not-found', 'Route not found'),
        404,
      )
      return
    }
    if (!RemoteControlServer.isOperation(route.operationName)) {
      RemoteControlHttpBoundary.json(
        response,
        RemoteControlServer.failure(null, null, null, 'not-found', 'Operation not found'),
        404,
      )
      return
    }
    const body = await this.httpBody(request, route.operationName)
    if (!body.ok) {
      this.audit.remoteHttp(
        body.input,
        body.response as RemoteControlResponse,
        this.httpCaller(),
        route.remoteEndpointId,
      )
      RemoteControlHttpBoundary.json(response, body.response, body.status)
      return
    }
    const validated = RemoteControlRequestValidation.parse(body.input)
    let answer: RemoteControlResponse
    if (!validated.ok)
      answer = RemoteControlServer.failure(
        validated.requestId,
        validated.operation,
        validated.operationId,
        validated.error.code,
        validated.error.detail,
      )
    else if (!(RemoteControlPeerConst.controlOperations as readonly RemoteControlOperation[])
      .includes(validated.request.operation))
      answer = RemoteControlServer.failure(
        validated.request.requestId,
        validated.request.operation,
        validated.request.operationId ?? null,
        'forbidden',
        `${validated.request.operation} is not available through a remote computer`,
      )
    else
      answer = await this.deps.local.execute(route.remoteEndpointId, validated.request)
    this.audit.remoteHttp(body.input, answer, this.httpCaller(), route.remoteEndpointId)
    RemoteControlHttpBoundary.json(response, answer, RemoteControlServer.statusOf(answer))
  }

  private async httpBody(
    request: IncomingMessage,
    operation: RemoteControlOperation | RemoteControlLocalOperation,
  ): Promise<RemoteControlHttpBody> {
    const body = await RemoteControlHttpBoundary.readJson(request)
    if (!body.ok)
      return {
        ok: false,
        input: null,
        response: RemoteControlServer.httpFailure(
          null,
          operation,
          null,
          'invalid-request',
          body.detail,
        ),
        status: body.status,
      }
    const envelope = JsonShape.record(body.value)
    if (envelope?.operation !== operation)
      return {
        ok: false,
        input: body.value,
        response: RemoteControlServer.httpFailure(
          RemoteControlServer.optionalText(envelope?.requestId),
          operation,
          RemoteControlServer.optionalText(envelope?.operationId),
          'invalid-request',
          'Request operation does not match the route',
        ),
        status: 400,
      }
    return { ok: true, input: body.value }
  }

  private async executeLocalHttp(input: unknown, response: ServerResponse): Promise<void> {
    const answer = await this.localOperations.execute(input, this.httpCaller().callerId)
    this.audit.localHttp(input, answer, this.httpCaller())
    RemoteControlHttpBoundary.json(response, answer, RemoteControlServer.statusOf(answer))
  }

  private async executeHttp(input: unknown, response: ServerResponse): Promise<void> {
    const executed = await this.deps.control.execute(input, {
      ...this.httpCaller(),
      allowedOperations: [...RemoteControlConst.operations, ...RemoteControlConst.optionalOperations],
    })
    const envelope = JsonShape.record(input)
    const answer: RemoteControlResponse = envelope?.operation === 'system.hello' && executed.ok
      ? {
          ...executed,
          value: {
            ...(executed.value as RemoteControlHelloDto),
            optionalOperations: RemoteControlConst.optionalOperations,
          },
        } as RemoteControlResponse
      : executed
    this.audit.http(input, answer, this.httpCaller())
    RemoteControlHttpBoundary.json(response, answer, RemoteControlServer.statusOf(answer))
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const denied = this.boundary.authorize(request, this.port)
    if (denied) {
      RemoteControlHttpBoundary.refuseUpgrade(socket, denied.status)
      return
    }
    if (this.stopping || this.webSocketServer.clients.size >= RemoteControlServer.maximumWebSocketConnectionsConst) {
      RemoteControlHttpBoundary.refuseUpgrade(socket, 503)
      return
    }
    if ((request.url ?? '/').split('?')[0] !== '/api/v3/ws') {
      RemoteControlHttpBoundary.refuseUpgrade(socket, 404)
      return
    }
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
      this.webSocketServer.emit('connection', webSocket, request))
  }

  private socketConnected(socket: WebSocket): void {
    const socketId = this.socketId()
    const state: RemoteControlSocketState = {
      ownerId: `local-control:${this.deps.identity.instanceId}:ws:${socketId}`,
      caller: { callerId: `local-ws:${socketId}`, callerKind: 'local-cli' },
      closed: false,
      alive: true,
      queue: Promise.resolve(),
    }
    this.socketStates.set(socket, state)
    socket.on('pong', () => { state.alive = true })
    socket.on('message', (data, isBinary) => {
      state.queue = state.queue
        .then(() => this.handleSocketMessage(socket, state, data, isBinary))
        .catch((error: unknown) => {
          this.deps.onError(`Remote control WebSocket request failed: ${ErrorText.of(error)}`)
          this.sendSocket(socket, RemoteControlSocketOperations.failure(
            null,
            null,
            null,
            'operation-failed',
            'The WebSocket request failed unexpectedly',
          ))
        })
    })
    socket.on('close', () => this.socketClosed(socket, state))
    socket.on('error', () => this.socketClosed(socket, state))
  }

  private async handleSocketMessage(
    socket: WebSocket,
    state: RemoteControlSocketState,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (state.closed) return
    if (isBinary) {
      this.refuseSocket(socket, state, RemoteControlSocketOperations.failure(
        null,
        null,
        null,
        'invalid-request',
        'WebSocket requests must be UTF-8 JSON text',
      ))
      return
    }
    let input: unknown
    try {
      input = JSON.parse(data.toString())
    } catch {
      this.refuseSocket(socket, state, RemoteControlSocketOperations.failure(
        null,
        null,
        null,
        'invalid-request',
        'WebSocket request must be valid JSON',
      ))
      return
    }
    await this.operations.handle(this.socketCaller(socket, state), input)
  }

  /**
   * The local half of one shared protocol. A caller on the loopback socket has already proved the
   * bearer token, so every operation is granted; what is particular here is the subscriber set the
   * server publishes events through.
   */
  private socketCaller(
    socket: WebSocket,
    state: RemoteControlSocketState,
  ): RemoteControlSocketCaller {
    return {
      ownerId: state.ownerId,
      caller: state.caller,
      connectionId: state.caller.callerId,
      closed: () => state.closed,
      granted: () => true,
      send: (response) => this.sendSocket(socket, response),
      subscribe: (afterRevision): RemoteControlSocketSubscription => {
        this.eventSubscribers.add(socket)
        return this.eventStore.replay(afterRevision)
      },
      attached: () => undefined,
      detached: () => undefined,
      frame: (attachId, frame) => this.sendTerminalFrame(socket, attachId, frame),
    }
  }

  /** A refused request is a request: it leaves the same row as one that was carried out. */
  private refuseSocket(
    socket: WebSocket,
    state: RemoteControlSocketState,
    refusal: Extract<RemoteControlSocketResponse, { type: 'response'; ok: false }>,
  ): void {
    this.sendSocket(socket, refusal)
    this.audit.socket('websocket', null, refusal, state.caller)
  }

  private sendTerminalFrame(
    socket: WebSocket,
    attachId: string,
    frame: TerminalFrame,
  ): void {
    this.sendSocket(socket, {
      protocol: RemoteControlConst.protocol,
      type: 'terminal.frame',
      attachId,
      frame,
      terminalOutputUntrusted: true,
    })
  }

  private socketClosed(socket: WebSocket, state: RemoteControlSocketState): void {
    if (state.closed) return
    state.closed = true
    this.socketStates.delete(socket)
    this.eventSubscribers.delete(socket)
    this.deps.terminal.detachOwner(state.ownerId)
  }

  private sendSocket(socket: WebSocket, message: RemoteControlSocketResponse): void {
    if (socket.readyState !== WebSocket.OPEN) return
    const state = this.socketStates.get(socket)
    if (state !== undefined
      && socket.bufferedAmount > RemoteControlServer.maximumWebSocketBufferedBytesConst) {
      this.dropSocket(socket, state, 'is not reading what it asked for')
      return
    }
    try { socket.send(JSON.stringify(message)) } catch {}
  }

  private readRequest(
    operation: 'system.hello' | 'system.status',
  ): RemoteControlRequest<'system.hello'> | RemoteControlRequest<'system.status'> {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: `server:${randomUUID()}`,
      operation,
      body: {},
    } as RemoteControlRequest<'system.hello'> | RemoteControlRequest<'system.status'>
  }

  private httpCaller(): RemoteControlAuditCaller {
    return {
      callerId: `local-control:${this.deps.identity.instanceId}`,
      callerKind: 'local-cli',
    }
  }

  private static failure(
    requestId: string | null,
    operation: RemoteControlOperation | null,
    operationId: string | null,
    code: RemoteControlError['code'],
    detail: string,
  ): RemoteControlResponse {
    return RemoteControlEnvelope.failure(requestId, operation, operationId, { code, detail })
  }

  /**
   * The HTTP surface answers for BOTH families over one socket, so its operation may be a local one
   * - which is the only reason this is not just `failure` above. The envelope is the same envelope.
   */
  private static httpFailure(
    requestId: string | null,
    operation: RemoteControlOperation | RemoteControlLocalOperation | null,
    operationId: string | null,
    code: RemoteControlError['code'],
    detail: string,
  ): RemoteControlHttpResponse {
    return RemoteControlEnvelope.failure(
      requestId,
      operation as RemoteControlOperation | null,
      operationId,
      { code, detail },
    ) as RemoteControlHttpResponse
  }

  /**
   * A `Record` keyed by the error type rather than a ladder: a code added to the protocol stops this
   * file from compiling until it has a status, which is the only reminder that never gets skipped.
   */
  private static readonly httpStatusConst: Record<RemoteControlErrorCode, number> = {
    'invalid-request': 400,
    'protocol-mismatch': 400,
    forbidden: 403,
    'not-found': 404,
    conflict: 409,
    'operation-failed': 500,
    unavailable: 503,
    timeout: 504,
  }

  private static statusOf(response: RemoteControlHttpResponse): number {
    return response.ok ? 200 : RemoteControlServer.httpStatusConst[response.error.code]
  }

  private static isOperation(value: string): value is RemoteControlOperation {
    return ([...RemoteControlConst.operations, ...RemoteControlConst.optionalOperations] as readonly string[])
      .includes(value)
  }

  private static isLocalOperation(value: string): value is RemoteControlLocalOperation {
    return (RemoteControlLocalConst.operations as readonly string[]).includes(value)
  }

  private static remoteRoute(pathname: string): {
    remoteEndpointId: string
    operationName: string
  } | null {
    const prefix = '/api/v3/remote/'
    if (!pathname.startsWith(prefix)) return null
    const tail = pathname.slice(prefix.length)
    const marker = tail.indexOf('/op/')
    if (marker <= 0 || tail.indexOf('/op/', marker + 1) >= 0) return null
    const encodedEndpointId = tail.slice(0, marker)
    const operationName = tail.slice(marker + '/op/'.length)
    if (operationName.length === 0 || operationName.includes('/')) return null
    let remoteEndpointId: string
    try { remoteEndpointId = decodeURIComponent(encodedEndpointId) }
    catch { return null }
    if (remoteEndpointId.length === 0 || remoteEndpointId.length > 512) return null
    return { remoteEndpointId, operationName }
  }


  private static optionalText(value: unknown): string | null {
    return typeof value === 'string' ? value : null
  }
}
