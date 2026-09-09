import type {
  RemoteControlError,
  RemoteControlLocalOperation,
  RemoteControlLocalRequest,
  RemoteControlLocalResponse,
  RemoteControlLocalResponseBody,
  RemoteControlOperation,
  RemoteControlRequestUnion,
  RemoteControlResponse,
  RemoteControlSocketOperation,
  RemoteControlSocketRequest,
  RemoteControlSocketResponse,
} from './remoteControlApi.types'
import { RemoteControlConst } from './remoteControlProtocol'

type SocketAnswer = Extract<RemoteControlSocketResponse, { type: 'response' }>

/**
 * The answer envelope, built in one place per family.
 *
 * `{ protocol, requestId, operation, operationId, ok, value | error }` was assembled by hand in
 * eight private statics across five files and two packages. None of them was wrong; they were eight
 * copies of one shape, which stop agreeing the moment one of them needs a field.
 *
 * Three families, three pairs, because the three response TYPES are genuinely different: a control
 * answer, a local answer and a socket answer that carries a `type` discriminator. What they share is
 * the protocol name and the four ids, and that is what lives here.
 *
 * `refused` beside `failure` is the common case said once: a request that WAS read already carries
 * its own ids, so repeating them at the call site is where a wrong `operationId` gets typed.
 */
export class RemoteControlEnvelope {
  static success(request: RemoteControlRequestUnion, value: unknown): RemoteControlResponse {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: request.requestId,
      operation: request.operation,
      operationId: request.operationId ?? null,
      ok: true,
      value,
    } as RemoteControlResponse
  }

  /** For an answer whose request could not be read: the ids are whatever was recovered from it. */
  static failure(
    requestId: string | null,
    operation: RemoteControlOperation | null,
    operationId: string | null,
    error: RemoteControlError,
  ): RemoteControlResponse {
    return {
      protocol: RemoteControlConst.protocol,
      requestId,
      operation,
      operationId,
      ok: false,
      error,
    }
  }

  static refused(
    request: RemoteControlRequestUnion,
    error: RemoteControlError,
  ): RemoteControlResponse {
    return RemoteControlEnvelope.failure(
      request.requestId,
      request.operation,
      request.operationId ?? null,
      error,
    )
  }
}

/** The socket family, which carries a `type` beside the ids and answers `events.subscribe` with no
 *  `operationId` at all - a subscription is a read, and a read has no operation to be idempotent about. */
export class RemoteControlSocketEnvelope {
  static success(request: RemoteControlSocketRequest, value: unknown): SocketAnswer {
    return {
      protocol: RemoteControlConst.protocol,
      type: 'response',
      requestId: request.requestId,
      operation: request.operation,
      operationId: RemoteControlSocketEnvelope.operationIdOf(request),
      ok: true,
      value,
    } as SocketAnswer
  }

  static failure(
    requestId: string | null,
    operation: RemoteControlSocketOperation | null,
    operationId: string | null,
    error: RemoteControlError,
  ): SocketAnswer {
    return {
      protocol: RemoteControlConst.protocol,
      type: 'response',
      requestId,
      operation,
      operationId,
      ok: false,
      error,
    } as SocketAnswer
  }

  static refused(request: RemoteControlSocketRequest, error: RemoteControlError): SocketAnswer {
    return RemoteControlSocketEnvelope.failure(
      request.requestId,
      request.operation,
      RemoteControlSocketEnvelope.operationIdOf(request),
      error,
    )
  }

  private static operationIdOf(request: RemoteControlSocketRequest): string | null {
    return request.operation === 'events.subscribe' ? null : request.operationId
  }
}

/** The local family: the same envelope over the operations only a process on this machine may ask. */
export class RemoteControlLocalEnvelope {
  static success<K extends RemoteControlLocalOperation>(
    request: RemoteControlLocalRequest<K>,
    value: RemoteControlLocalResponseBody<K>,
  ): RemoteControlLocalResponse<K> {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: request.requestId,
      operation: request.operation,
      operationId: request.operationId ?? null,
      ok: true,
      value,
    } as RemoteControlLocalResponse<K>
  }

  static failure<K extends RemoteControlLocalOperation = RemoteControlLocalOperation>(
    requestId: string | null,
    operation: K | null,
    operationId: string | null,
    error: RemoteControlError,
  ): RemoteControlLocalResponse<K> {
    return {
      protocol: RemoteControlConst.protocol,
      requestId,
      operation,
      operationId,
      ok: false,
      error,
    }
  }
}
