import type { RemoteControlError } from './remoteControlApi.types'
import { RemoteControlConst } from './remoteControlProtocol'

/** What a validator throws for input it will not accept. Caught by `parse` and by each body parser. */
export class RemoteControlValidationError extends Error {}

/** The one thing the two request families do not share: which operations exist, and which mutate. */
export interface RemoteControlEnvelopeSpec<TOperation extends string> {
  operations: readonly TOperation[]
  isMutating(operation: TOperation): boolean
}

export type RemoteControlEnvelopeReading<TOperation extends string> =
  | {
      ok: true
      requestId: string
      operation: TOperation
      operationId: string | null
      body: unknown
    }
  | {
      ok: false
      requestId: string | null
      operation: TOperation | null
      operationId: string | null
      error: RemoteControlError
    }

/**
 * The envelope every request of every family arrives in: `protocol`, `requestId`, `operation`,
 * `operationId`, `body`, and the rules that decide whether it may be read at all.
 *
 * The two validators over it - the outside surface's and the local one's - each carried their own
 * copy of this, their own error class and their own `object` / `keys` / `text` / `empty` helpers.
 * They had begun to drift: the same `operationId` sentence written twice, and `requestId` bounded by
 * an explicit constant on one side and a default on the other. What genuinely differs between them
 * is the operation set, the mutating set and the per-operation body, and that is all each keeps.
 *
 * **A failure reports the ids it managed to read**, which is the reason this returns a shape rather
 * than throwing: a caller answering a request it could not parse still has to say which request, and
 * how far the read got decides how much of that it can say.
 */
export class RemoteControlEnvelopeValidation {
  /** Long enough for any id a client will mint, short enough that a body cannot hide in one. */
  static readonly idLengthConst = 256

  private static readonly envelopeKeysConst =
    ['protocol', 'requestId', 'operation', 'operationId', 'body'] as const

  static parse<TOperation extends string>(
    input: unknown,
    spec: RemoteControlEnvelopeSpec<TOperation>,
  ): RemoteControlEnvelopeReading<TOperation> {
    let requestId: string | null = null
    let operation: TOperation | null = null
    let operationId: string | null = null
    try {
      const value = RemoteControlEnvelopeValidation.object(input, 'request')
      RemoteControlEnvelopeValidation.keys(
        value,
        RemoteControlEnvelopeValidation.envelopeKeysConst,
        'request',
      )
      requestId = RemoteControlEnvelopeValidation.text(value.requestId, 'requestId')
      // Before the operation on purpose: a client speaking another protocol has said nothing this
      // one can read, so naming an operation it might not have would be an invention.
      if (value.protocol !== RemoteControlConst.protocol)
        return {
          ok: false,
          requestId,
          operation: null,
          operationId: null,
          error: {
            code: 'protocol-mismatch',
            detail: `Expected protocol ${RemoteControlConst.protocol}`,
          },
        }
      operation = RemoteControlEnvelopeValidation.operationOf(value.operation, spec)
      operationId = value.operationId === undefined
        ? null
        : RemoteControlEnvelopeValidation.text(value.operationId, 'operationId')
      if (spec.isMutating(operation) && operationId === null)
        throw new RemoteControlValidationError(`operationId is required for ${operation}`)
      if (!spec.isMutating(operation) && operationId !== null)
        throw new RemoteControlValidationError(`operationId is not allowed for ${operation}`)
      return { ok: true, requestId, operation, operationId, body: value.body }
    } catch (error) {
      if (!(error instanceof RemoteControlValidationError)) throw error
      return {
        ok: false,
        requestId,
        operation,
        operationId,
        error: { code: 'invalid-request', detail: error.message },
      }
    }
  }

  static object(input: unknown, name: string): Record<string, unknown> {
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new RemoteControlValidationError(`${name} must be an object`)
    return input as Record<string, unknown>
  }

  /** An unknown key is refused rather than ignored: it is the client saying something nobody read. */
  static keys(
    value: Record<string, unknown>,
    allowed: readonly string[],
    name: string,
  ): void {
    const accepted = new Set(allowed)
    const unknown = Object.keys(value).find((key) => !accepted.has(key))
    if (unknown !== undefined)
      throw new RemoteControlValidationError(`${name} has unknown field ${JSON.stringify(unknown)}`)
  }

  static text(
    input: unknown,
    name: string,
    maximum: number = RemoteControlEnvelopeValidation.idLengthConst,
  ): string {
    if (typeof input !== 'string')
      throw new RemoteControlValidationError(`${name} must be a string`)
    if (input.length === 0)
      throw new RemoteControlValidationError(`${name} must not be empty`)
    if (input.length > maximum)
      throw new RemoteControlValidationError(`${name} exceeds ${maximum} characters`)
    return input
  }

  /** A body with nothing in it, and nothing in it is the assertion: an unknown key is refused. */
  static empty(input: unknown, operation: string): Record<string, never> {
    const value = RemoteControlEnvelopeValidation.object(input, `${operation} body`)
    RemoteControlEnvelopeValidation.keys(value, [], `${operation} body`)
    return {}
  }

  /**
   * The narrowing a mutation's request type needs. `parse` has already refused a mutation with no
   * `operationId`, so reaching this with `null` is a defect in this file rather than bad input -
   * which is why it throws a plain `Error` and not a validation one.
   */
  static requiredOperationId(value: string | null): string {
    if (value === null)
      throw new Error('A mutating request passed validation without operationId')
    return value
  }

  private static operationOf<TOperation extends string>(
    input: unknown,
    spec: RemoteControlEnvelopeSpec<TOperation>,
  ): TOperation {
    if (typeof input !== 'string' || !(spec.operations as readonly string[]).includes(input))
      throw new RemoteControlValidationError(`Unknown operation: ${JSON.stringify(input)}`)
    return input as TOperation
  }
}
