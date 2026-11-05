import type {
  RemoteControlError,
  RemoteControlSocketOperation,
  RemoteControlSocketRequest,
  RemoteControlSocketResponse,
  RemoteControlStepResult,
} from './remoteControlApi.types'
import { RemoteControlConst } from './remoteControlProtocol'
import { RemoteControlOperationStore } from './remoteControlOperationStore'
import type { RemoteControlLiveTerminal } from './remoteControlLiveTerminal'
import type { TerminalFrame } from '../sessionManager/sessionManagerApi.types'
import type { RemoteControlPeerAudit, RemoteControlAuditCaller } from './remoteControlAuditRows'
import { RemoteControlSocketValidation } from './remoteControlSocketValidation'

export type RemoteControlSocketTerminalPort = Pick<
  RemoteControlLiveTerminal,
  'attachLive' | 'inputLive' | 'resizeLive' | 'setLiveActive' | 'detachLive' | 'pasteImageLive' | 'pasteFileLive'
>

export interface RemoteControlSocketSubscription {
  throughRevision: number
  truncated: boolean
  events: readonly Extract<RemoteControlSocketResponse, { type: 'event' }>['event'][]
}

/**
 * One side of one socket, as the operations below need it. What differs between the two transports
 * lives here and nowhere else: who is asking, what they were granted, where an answer goes, and what
 * the surface does when an attachment appears or ends.
 */
export interface RemoteControlSocketCaller {
  readonly ownerId: string
  readonly caller: RemoteControlAuditCaller
  /** Two connections of one caller must not share an operationId. */
  readonly connectionId: string
  closed(): boolean
  granted(operation: RemoteControlSocketOperation): boolean
  send(response: RemoteControlSocketResponse): void
  subscribe(afterRevision: number | undefined): RemoteControlSocketSubscription
  attached(attachId: string, sessionId: string): void
  detached(attachId: string): void
  frame(attachId: string, frame: TerminalFrame): void
}

/**
 * The socket protocol, once.
 *
 * The local WebSocket server and the peer registry answer the same eight operations, and until
 * 2026-08-23 each carried its own copy - which had already begun to differ: one dropped an
 * attachment when its terminal exited and the other kept it, and one audited a refused request while
 * the other left no trace. Two copies of a protocol do not stay equal; they take turns being right.
 */
export class RemoteControlSocketOperations {
  private readonly operationStore: RemoteControlOperationStore

  private readonly terminal: RemoteControlSocketTerminalPort
  private readonly audit: RemoteControlPeerAudit
  private readonly transport: 'websocket' | 'peer-socket'

  constructor(terminal: RemoteControlSocketTerminalPort, audit: RemoteControlPeerAudit, transport: 'websocket' | 'peer-socket',
    operationStore = new RemoteControlOperationStore()) {
    this.terminal = terminal
    this.audit = audit
    this.transport = transport
    this.operationStore = operationStore
  }

  async handle(caller: RemoteControlSocketCaller, input: unknown): Promise<void> {
    const parsed = RemoteControlSocketValidation.parse(input)
    if (!parsed.ok) {
      const refusal = RemoteControlSocketOperations.failure(
        parsed.requestId,
        parsed.operation,
        parsed.operationId,
        parsed.error.code,
        parsed.error.detail,
        parsed.error.data,
      )
      caller.send(refusal)
      // A request that never parsed still happened, and it is the one anybody would want to find.
      this.audit.socket(this.transport, null, refusal, caller.caller)
      return
    }
    const request = parsed.request
    const answer = await this.answer(caller, request)
    caller.send(answer)
    this.audit.socket(this.transport, request, answer, caller.caller)
  }

  private async answer(
    caller: RemoteControlSocketCaller,
    request: RemoteControlSocketRequest,
  ): Promise<Extract<RemoteControlSocketResponse, { type: 'response' }>> {
    if (!caller.granted(request.operation))
      return RemoteControlSocketOperations.refuse(
        request,
        'forbidden',
        `${request.operation} was not granted`,
      )
    if (request.operation === 'events.subscribe') return this.subscribe(caller, request)
    const stored = await this.operationStore.runOrRefuse(
      `${caller.caller.callerId}:${caller.connectionId}`,
      request.operationId,
      RemoteControlSocketValidation.fingerprint(request),
      async () => this.mutate(caller, request),
    )
    const result = stored.ok ? stored.value : stored
    return result.ok
      ? RemoteControlSocketOperations.success(request, result.value)
      : RemoteControlSocketOperations.refuse(
          request,
          result.error.code,
          result.error.detail,
          result.error.data,
        )
  }

  private subscribe(
    caller: RemoteControlSocketCaller,
    request: Extract<RemoteControlSocketRequest, { operation: 'events.subscribe' }>,
  ): Extract<RemoteControlSocketResponse, { type: 'response' }> {
    const replay = caller.subscribe(request.afterRevision)
    // After the answer, never before it: a replayed event must not arrive ahead of the revision it
    // is measured against.
    queueMicrotask(() => {
      if (caller.closed()) return
      for (const event of replay.events)
        caller.send({ protocol: RemoteControlConst.protocol, type: 'event', event })
    })
    return RemoteControlSocketOperations.success(request, {
      throughRevision: replay.throughRevision,
      truncated: replay.truncated,
    })
  }

  private async mutate(
    caller: RemoteControlSocketCaller,
    request: Exclude<RemoteControlSocketRequest, { operation: 'events.subscribe' }>,
  ): Promise<RemoteControlStepResult<unknown>> {
    if (caller.closed()) return { ok: false, error: { code: 'unavailable', detail: 'The terminal connection closed' } }
    if (!caller.granted(request.operation))
      return { ok: false, error: { code: 'forbidden', detail: `${request.operation} was not granted` } }
    if (request.operation === 'terminal.attach') {
      const attached = await this.terminal.attachLive(
        caller.ownerId,
        request.attachId,
        { sessionId: request.sessionId, size: request.size },
        (frame) => caller.frame(request.attachId, frame),
      )
      if (attached.ok) caller.attached(request.attachId, request.sessionId)
      return attached
    } else if (request.operation === 'terminal.input')
      return this.terminal.inputLive(caller.ownerId, request.attachId, request.data)
    else if (request.operation === 'terminal.resize')
      return this.terminal.resizeLive(
        caller.ownerId,
        request.attachId,
        request.cols,
        request.rows,
      )
    else if (request.operation === 'terminal.active')
      return this.terminal.setLiveActive(caller.ownerId, request.attachId, request.active)
    else if (request.operation === 'terminal.detach') {
      const detached = this.terminal.detachLive(caller.ownerId, request.attachId)
      if (detached.ok) caller.detached(request.attachId)
      return detached
    } else if (request.operation === 'terminal.pasteImage')
      return this.terminal.pasteImageLive(
        caller.ownerId,
        request.attachId,
        Buffer.from(request.data, 'base64'),
      )
    else if (request.operation === 'terminal.pasteFile')
      return this.terminal.pasteFileLive(caller.ownerId, request.attachId, request.uploadId, {
        fileName: request.fileName,
        size: request.size,
        offset: request.offset,
        bytes: Buffer.from(request.data, 'base64'),
      })
    else
      throw new Error(`Unknown socket mutation: ${JSON.stringify(request)}`)
  }

  private static success(
    request: RemoteControlSocketRequest,
    value: unknown,
  ): Extract<RemoteControlSocketResponse, { type: 'response'; ok: true }> {
    return {
      protocol: RemoteControlConst.protocol,
      type: 'response',
      requestId: request.requestId,
      operation: request.operation,
      operationId: request.operation === 'events.subscribe' ? null : request.operationId,
      ok: true,
      value,
    }
  }

  private static refuse(
    request: RemoteControlSocketRequest,
    code: RemoteControlError['code'],
    detail: string,
    data?: Record<string, unknown>,
  ): Extract<RemoteControlSocketResponse, { type: 'response'; ok: false }> {
    return RemoteControlSocketOperations.failure(
      request.requestId,
      request.operation,
      request.operation === 'events.subscribe' ? null : request.operationId,
      code,
      detail,
      data,
    )
  }

  static failure(
    requestId: string | null,
    operation: RemoteControlSocketOperation | null,
    operationId: string | null,
    code: RemoteControlError['code'],
    detail: string,
    data?: Record<string, unknown>,
  ): Extract<RemoteControlSocketResponse, { type: 'response'; ok: false }> {
    return {
      protocol: RemoteControlConst.protocol,
      type: 'response',
      requestId,
      operation,
      operationId,
      ok: false,
      error: { code, detail, ...(data === undefined ? {} : { data }) },
    }
  }
}
