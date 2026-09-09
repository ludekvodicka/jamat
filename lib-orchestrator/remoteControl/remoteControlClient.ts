import { randomUUID } from 'node:crypto'

import { WebSocket, type RawData } from 'ws'

import type {
  RemoteControlDescriptor,
  RemoteControlError,
  RemoteControlLocalOperation,
  RemoteControlLocalRequest,
  RemoteControlLocalResponse,
  RemoteControlOperation,
  RemoteControlRequest,
  RemoteControlResponse,
  RemoteControlSocketResponse,
  RemoteControlStepResult,
} from './remoteControlApi.types'
import { RemoteControlCapabilities, RemoteControlConst } from './remoteControlProtocol'
import { RemoteControlResponseValidation } from './core/remoteControlResponseValidation'
import { RemoteControlPeerConst } from './remoteControlPeerProtocol'

export interface RemoteControlEventWatchOptions {
  afterRevision?: number
  signal?: AbortSignal
  onMessage(message: Exclude<RemoteControlSocketResponse, { type: 'terminal.frame' }>): void
}

export interface RemoteControlClientDeps {
  fetch?: typeof fetch
  socket?(url: string, token: string): WebSocket
  requestId?(): string
  timeoutMilliseconds?: number
}

export class RemoteControlClient {
  private static readonly timeoutMillisecondsConst = 65_000
  private static readonly maximumResponseCharactersConst = 16_777_216
  private readonly httpFetch: typeof fetch
  private readonly socket: (url: string, token: string) => WebSocket
  private readonly requestId: () => string
  private readonly timeoutMilliseconds: number

  constructor(
    private readonly descriptor: RemoteControlDescriptor,
    deps?: RemoteControlClientDeps,
  ) {
    this.httpFetch = deps?.fetch ?? fetch
    this.socket = deps?.socket ?? RemoteControlClient.openSocket
    this.requestId = deps?.requestId ?? randomUUID
    this.timeoutMilliseconds = deps?.timeoutMilliseconds
      ?? RemoteControlClient.timeoutMillisecondsConst
  }

  async execute<K extends RemoteControlOperation>(
    request: RemoteControlRequest<K>,
    signal?: AbortSignal,
  ): Promise<RemoteControlResponse<K>> {
    if (!RemoteControlCapabilities.of(this.descriptor).includes(request.operation))
      return RemoteControlClient.failure(
        request,
        'unavailable',
        `${request.operation} is not exposed by this AppClientUI`,
      )
    return this.executeHttp(
      `/api/v3/op/${encodeURIComponent(request.operation)}`,
      request,
      (input) => RemoteControlClient.response(input, request),
      (code, detail) => RemoteControlClient.failure(request, code, detail),
      signal,
    )
  }

  async executeLocal<K extends RemoteControlLocalOperation>(
    request: RemoteControlLocalRequest<K>,
  ): Promise<RemoteControlLocalResponse<K>> {
    if (!this.descriptor.localOperations?.includes(request.operation))
      return RemoteControlClient.localFailure(
        request,
        'unavailable',
        `${request.operation} is not exposed by this AppClientUI`,
      )
    return this.executeHttp(
      `/api/v3/local/op/${encodeURIComponent(request.operation)}`,
      request,
      (input) => RemoteControlClient.localResponse(input, request),
      (code, detail) => RemoteControlClient.localFailure(request, code, detail),
    )
  }

  async executeRemote<K extends RemoteControlOperation>(
    remoteEndpointId: string,
    request: RemoteControlRequest<K>,
  ): Promise<RemoteControlResponse<K>> {
    if (!(RemoteControlPeerConst.controlOperations as readonly RemoteControlOperation[])
      .includes(request.operation))
      return RemoteControlClient.failure(
        request,
        'forbidden',
        `${request.operation} is not available through a remote computer`,
      )
    return this.executeHttp(
      `/api/v3/remote/${encodeURIComponent(remoteEndpointId)}/op/${encodeURIComponent(request.operation)}`,
      request,
      (input) => RemoteControlClient.response(input, request),
      (code, detail) => RemoteControlClient.failure(request, code, detail),
    )
  }

  private async executeHttp<T>(
    path: string,
    request: { operation: string },
    validate: (input: unknown) => T | null,
    failure: (code: RemoteControlError['code'], detail: string) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      const response = await this.httpFetch(
        `${this.httpBase()}${path}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.descriptor.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
          signal: signal === undefined
            ? AbortSignal.timeout(this.timeoutMilliseconds)
            : AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMilliseconds)]),
        },
      )
      const text = await response.text()
      if (text.length > RemoteControlClient.maximumResponseCharactersConst)
        return failure('operation-failed', 'Control response is too large')
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch {
        return failure(
          'operation-failed',
          'AppClientUI returned an invalid control response',
        )
      }
      const validated = validate(parsed)
      return validated ?? failure(
        'operation-failed',
        'AppClientUI returned an incompatible control response',
      )
    } catch (error) {
      return failure(
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? 'timeout'
          : 'unavailable',
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? 'The AppClientUI control request timed out'
          : 'The AppClientUI control endpoint is unavailable',
      )
    }
  }

  watchEvents(options: RemoteControlEventWatchOptions): Promise<RemoteControlStepResult<void>> {
    if (options.signal?.aborted) return Promise.resolve({ ok: true, value: undefined })
    return new Promise((resolve) => {
      const requestId = this.requestId()
      let settled = false
      let subscribed = false
      let socket: WebSocket | null = null
      const finish = (result: RemoteControlStepResult<void>): void => {
        if (settled) return
        settled = true
        options.signal?.removeEventListener('abort', abort)
        try { socket?.close() } catch {}
        resolve(result)
      }
      const abort = (): void => finish({ ok: true, value: undefined })
      try {
        socket = this.socket(`${this.webSocketBase()}/api/v3/ws`, this.descriptor.token)
      } catch {
        return finish(RemoteControlClient.stepError(
          'unavailable',
          'The AppClientUI event endpoint is unavailable',
        ))
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      socket.once('open', () => socket?.send(JSON.stringify({
        protocol: RemoteControlConst.protocol,
        requestId,
        operation: 'events.subscribe',
        ...(options.afterRevision === undefined ? {} : { afterRevision: options.afterRevision }),
      })))
      socket.on('message', (data, isBinary) => {
        if (settled) return
        const message = RemoteControlClient.socketMessage(data, isBinary)
        if (!message.ok) {
          finish(message)
          return
        }
        if (message.value.type === 'terminal.frame') {
          finish(RemoteControlClient.stepError(
            'operation-failed',
            'The event endpoint returned a terminal frame',
          ))
          return
        }
        if (message.value.type === 'response') {
          if (message.value.requestId !== requestId
            || message.value.operation !== 'events.subscribe'
            || message.value.operationId !== null) {
            finish(RemoteControlClient.stepError(
              'operation-failed',
              'The event subscription response does not match its request',
            ))
            return
          }
          if (!message.value.ok) {
            finish({ ok: false, error: message.value.error })
            return
          }
          subscribed = true
        }
        try { options.onMessage(message.value) } catch {
          finish(RemoteControlClient.stepError(
            'operation-failed',
            'The event consumer rejected a control message',
          ))
        }
      })
      socket.once('error', () => finish(RemoteControlClient.stepError(
        'unavailable',
        'The AppClientUI event endpoint is unavailable',
      )))
      socket.once('close', () => {
        if (!settled)
          finish(RemoteControlClient.stepError(
            'unavailable',
            subscribed
              ? 'The AppClientUI event connection closed'
              : 'The AppClientUI event endpoint refused the connection',
          ))
      })
      return undefined
    })
  }

  private httpBase(): string {
    return `http://${this.descriptor.address}:${this.descriptor.port}`
  }

  private webSocketBase(): string {
    return `ws://${this.descriptor.address}:${this.descriptor.port}`
  }

  private static openSocket(url: string, token: string): WebSocket {
    return new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: RemoteControlClient.timeoutMillisecondsConst,
      maxPayload: RemoteControlClient.maximumResponseCharactersConst,
    })
  }

  private static response<K extends RemoteControlOperation>(
    input: unknown,
    request: RemoteControlRequest<K>,
  ): RemoteControlResponse<K> | null {
    if (!RemoteControlClient.responseMatches(input, request)) return null
    return input as RemoteControlResponse<K>
  }

  private static localResponse<K extends RemoteControlLocalOperation>(
    input: unknown,
    request: RemoteControlLocalRequest<K>,
  ): RemoteControlLocalResponse<K> | null {
    if (!RemoteControlClient.responseMatches(input, request)) return null
    return input as RemoteControlLocalResponse<K>
  }

  private static responseMatches(
    input: unknown,
    request: { requestId: string; operation: string; operationId?: string },
  ): boolean {
    const answer = RemoteControlResponseValidation.control(input)
    return answer !== null
      && answer.requestId === request.requestId
      && answer.operation === request.operation
      && answer.operationId === (request.operationId ?? null)
  }

  private static socketMessage(
    data: RawData,
    isBinary: boolean,
  ): RemoteControlStepResult<RemoteControlSocketResponse> {
    if (isBinary)
      return RemoteControlClient.stepError(
        'operation-failed',
        'The event endpoint returned a binary message',
      )
    let parsed: unknown
    try { parsed = JSON.parse(data.toString()) } catch {
      return RemoteControlClient.stepError(
        'operation-failed',
        'The event endpoint returned invalid JSON',
      )
    }
    if (typeof parsed === 'object'
      && parsed !== null
      && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).protocol !== RemoteControlConst.protocol)
      return RemoteControlClient.stepError(
        'protocol-mismatch',
        'The event endpoint uses another control protocol',
      )
    const message = RemoteControlResponseValidation.socket(parsed)
    if (message === null)
      return RemoteControlClient.stepError(
        'operation-failed',
        'The event endpoint returned an invalid message',
      )
    return { ok: true, value: message }
  }

  private static failure<K extends RemoteControlOperation>(
    request: RemoteControlRequest<K>,
    code: RemoteControlError['code'],
    detail: string,
  ): RemoteControlResponse<K> {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: request.requestId,
      operation: request.operation as K,
      operationId: request.operationId ?? null,
      ok: false,
      error: { code, detail },
    }
  }

  private static localFailure<K extends RemoteControlLocalOperation>(
    request: RemoteControlLocalRequest<K>,
    code: RemoteControlError['code'],
    detail: string,
  ): RemoteControlLocalResponse<K> {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: request.requestId,
      operation: request.operation,
      operationId: request.operationId ?? null,
      ok: false,
      error: { code, detail },
    } as RemoteControlLocalResponse<K>
  }

  private static stepError<T>(
    code: RemoteControlError['code'],
    detail: string,
  ): RemoteControlStepResult<T> {
    return { ok: false, error: { code, detail } }
  }
}
