import type {
  RemoteControlError,
  RemoteControlSocketOperation,
  RemoteControlSocketRequest,
} from '../../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../../../lib-orchestrator/remoteControl/remoteControlProtocol'

class RemoteControlSocketValidationError extends Error {
  constructor(
    readonly code: RemoteControlError['code'],
    message: string,
  ) {
    super(message)
  }
}

export type RemoteControlSocketValidationResult =
  | { ok: true; request: RemoteControlSocketRequest }
  | {
      ok: false
      requestId: string | null
      operation: RemoteControlSocketOperation | null
      operationId: string | null
      error: RemoteControlError
    }

export class RemoteControlSocketValidation {
  private static readonly idLengthConst = 512
  private static readonly inputLengthConst = 65_536

  static parse(input: unknown): RemoteControlSocketValidationResult {
    let requestId: string | null = null
    let operation: RemoteControlSocketOperation | null = null
    let operationId: string | null = null
    try {
      const value = RemoteControlSocketValidation.object(input, 'WebSocket request')
      requestId = RemoteControlSocketValidation.text(
        value.requestId,
        'requestId',
        RemoteControlSocketValidation.idLengthConst,
      )
      operation = RemoteControlSocketValidation.operation(value.operation)
      if (value.protocol !== RemoteControlConst.protocol)
        throw new RemoteControlSocketValidationError(
          'protocol-mismatch',
          `protocol must be ${RemoteControlConst.protocol}`,
        )
      if (operation === 'events.subscribe') {
        RemoteControlSocketValidation.keys(
          value,
          ['protocol', 'requestId', 'operation', 'afterRevision'],
          operation,
        )
        const afterRevision = value.afterRevision === undefined
          ? undefined
          : RemoteControlSocketValidation.integer(value.afterRevision, 'afterRevision', 0, Number.MAX_SAFE_INTEGER)
        return {
          ok: true,
          request: {
            protocol: RemoteControlConst.protocol,
            requestId,
            operation,
            ...(afterRevision === undefined ? {} : { afterRevision }),
          },
        }
      }
      operationId = RemoteControlSocketValidation.text(
        value.operationId,
        'operationId',
        RemoteControlSocketValidation.idLengthConst,
      )
      if (operation === 'terminal.attach') {
        RemoteControlSocketValidation.keys(
          value,
          ['protocol', 'requestId', 'operationId', 'operation', 'attachId', 'sessionId', 'size'],
          operation,
        )
        return {
          ok: true,
          request: {
            protocol: RemoteControlConst.protocol,
            requestId,
            operationId,
            operation,
            attachId: RemoteControlSocketValidation.text(
              value.attachId,
              'attachId',
              RemoteControlSocketValidation.idLengthConst,
            ),
            sessionId: RemoteControlSocketValidation.text(
              value.sessionId,
              'sessionId',
              RemoteControlSocketValidation.idLengthConst,
            ),
            size: RemoteControlSocketValidation.size(value.size),
          },
        }
      } else if (operation === 'terminal.input') {
        RemoteControlSocketValidation.keys(
          value,
          ['protocol', 'requestId', 'operationId', 'operation', 'attachId', 'data'],
          operation,
        )
        return {
          ok: true,
          request: {
            protocol: RemoteControlConst.protocol,
            requestId,
            operationId,
            operation,
            attachId: RemoteControlSocketValidation.text(
              value.attachId,
              'attachId',
              RemoteControlSocketValidation.idLengthConst,
            ),
            data: RemoteControlSocketValidation.string(
              value.data,
              'data',
              RemoteControlSocketValidation.inputLengthConst,
            ),
          },
        }
      } else if (operation === 'terminal.resize') {
        RemoteControlSocketValidation.keys(
          value,
          ['protocol', 'requestId', 'operationId', 'operation', 'attachId', 'cols', 'rows'],
          operation,
        )
        return {
          ok: true,
          request: {
            protocol: RemoteControlConst.protocol,
            requestId,
            operationId,
            operation,
            attachId: RemoteControlSocketValidation.text(
              value.attachId,
              'attachId',
              RemoteControlSocketValidation.idLengthConst,
            ),
            cols: RemoteControlSocketValidation.integer(value.cols, 'cols', 2, 1_000),
            rows: RemoteControlSocketValidation.integer(value.rows, 'rows', 1, 500),
          },
        }
      } else if (operation === 'terminal.active') {
        RemoteControlSocketValidation.keys(
          value,
          ['protocol', 'requestId', 'operationId', 'operation', 'attachId', 'active'],
          operation,
        )
        if (typeof value.active !== 'boolean')
          throw new RemoteControlSocketValidationError('invalid-request', 'active must be a boolean')
        return {
          ok: true,
          request: {
            protocol: RemoteControlConst.protocol,
            requestId,
            operationId,
            operation,
            attachId: RemoteControlSocketValidation.text(
              value.attachId,
              'attachId',
              RemoteControlSocketValidation.idLengthConst,
            ),
            active: value.active,
          },
        }
      } else if (operation === 'terminal.detach') {
        RemoteControlSocketValidation.keys(
          value,
          ['protocol', 'requestId', 'operationId', 'operation', 'attachId'],
          operation,
        )
        return {
          ok: true,
          request: {
            protocol: RemoteControlConst.protocol,
            requestId,
            operationId,
            operation,
            attachId: RemoteControlSocketValidation.text(
              value.attachId,
              'attachId',
              RemoteControlSocketValidation.idLengthConst,
            ),
          },
        }
      } else
        throw new Error(`Unknown WebSocket operation: ${JSON.stringify(operation)}`)
    } catch (error) {
      if (error instanceof RemoteControlSocketValidationError)
        return {
          ok: false,
          requestId,
          operation,
          operationId,
          error: { code: error.code, detail: error.message },
        }
      throw error
    }
  }

  static fingerprint(request: Exclude<RemoteControlSocketRequest, { operation: 'events.subscribe' }>): string {
    return JSON.stringify({
      protocol: request.protocol,
      operationId: request.operationId,
      operation: request.operation,
      ...(request.operation === 'terminal.attach'
        ? { attachId: request.attachId, sessionId: request.sessionId, size: request.size }
        : request.operation === 'terminal.input'
          ? { attachId: request.attachId, data: request.data }
          : request.operation === 'terminal.resize'
            ? { attachId: request.attachId, cols: request.cols, rows: request.rows }
            : request.operation === 'terminal.active'
              ? { attachId: request.attachId, active: request.active }
              : request.operation === 'terminal.detach'
                ? { attachId: request.attachId }
                : RemoteControlSocketValidation.unknownMutation(request)),
    })
  }

  private static operation(input: unknown): RemoteControlSocketOperation {
    if (typeof input !== 'string'
      || !RemoteControlConst.socketOperations.includes(input as RemoteControlSocketOperation))
      throw new RemoteControlSocketValidationError('invalid-request', 'unknown WebSocket operation')
    return input as RemoteControlSocketOperation
  }

  private static size(input: unknown): { cols: number; rows: number } | null {
    if (input === null) return null
    const value = RemoteControlSocketValidation.object(input, 'size')
    RemoteControlSocketValidation.keys(value, ['cols', 'rows'], 'size')
    return {
      cols: RemoteControlSocketValidation.integer(value.cols, 'cols', 2, 1_000),
      rows: RemoteControlSocketValidation.integer(value.rows, 'rows', 1, 500),
    }
  }

  private static object(input: unknown, name: string): Record<string, unknown> {
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new RemoteControlSocketValidationError('invalid-request', `${name} must be an object`)
    return input as Record<string, unknown>
  }

  private static keys(
    input: Record<string, unknown>,
    allowed: readonly string[],
    name: string,
  ): void {
    const unknown = Object.keys(input).filter((key) => !allowed.includes(key))
    if (unknown.length > 0)
      throw new RemoteControlSocketValidationError(
        'invalid-request',
        `${name} has unknown field ${JSON.stringify(unknown[0])}`,
      )
  }

  private static text(input: unknown, name: string, maximum: number): string {
    const value = RemoteControlSocketValidation.string(input, name, maximum)
    if (value.length === 0)
      throw new RemoteControlSocketValidationError('invalid-request', `${name} must not be empty`)
    return value
  }

  private static string(input: unknown, name: string, maximum: number): string {
    if (typeof input !== 'string')
      throw new RemoteControlSocketValidationError('invalid-request', `${name} must be a string`)
    if (input.length > maximum)
      throw new RemoteControlSocketValidationError(
        'invalid-request',
        `${name} exceeds ${maximum} characters`,
      )
    return input
  }

  private static integer(
    input: unknown,
    name: string,
    minimum: number,
    maximum: number,
  ): number {
    if (!Number.isSafeInteger(input) || (input as number) < minimum || (input as number) > maximum)
      throw new RemoteControlSocketValidationError(
        'invalid-request',
        `${name} must be an integer from ${minimum} through ${maximum}`,
      )
    return input as number
  }

  private static unknownMutation(input: never): never {
    throw new Error(`Unknown WebSocket mutation: ${JSON.stringify(input)}`)
  }
}
