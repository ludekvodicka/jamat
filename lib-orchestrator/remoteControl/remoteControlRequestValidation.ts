import type {
  RemoteControlError,
  RemoteControlMutatingOperation,
  RemoteControlOperation,
  RemoteControlRequestUnion,
} from './remoteControlApi.types'
import { RemoteControlEnvelopeValidation } from './remoteControlEnvelopeValidation'
import { RemoteControlConst } from './remoteControlProtocol'
import { RemoteControlBodySchemas, RemoteControlZod } from './remoteControlSchemas'

export type RemoteControlRequestValidationResult =
  | { ok: true; request: RemoteControlRequestUnion }
  | {
      ok: false
      requestId: string | null
      operation: RemoteControlOperation | null
      operationId: string | null
      error: RemoteControlError
    }

/**
 * A protocol request read without a registry: the envelope, then the body against the same zod schema
 * the registry validates with. The remote route uses it to refuse a malformed request before it
 * travels to a paired computer.
 */
export class RemoteControlRequestValidation {
  private static readonly specConst = {
    operations: [...RemoteControlConst.operations, ...RemoteControlConst.optionalOperations],
    isMutating: (operation: RemoteControlOperation) => RemoteControlRequestValidation.isMutating(operation),
  }

  static parse(input: unknown): RemoteControlRequestValidationResult {
    const envelope = RemoteControlEnvelopeValidation
      .parse<RemoteControlOperation>(input, RemoteControlRequestValidation.specConst)
    if (!envelope.ok) return envelope
    const { requestId, operation, operationId } = envelope
    const body = RemoteControlBodySchemas[operation].safeParse(envelope.body)
    if (!body.success)
      return {
        ok: false,
        requestId,
        operation,
        operationId,
        error: { code: 'invalid-request', detail: RemoteControlZod.problemOf(body.error, operation) },
      }
    return {
      ok: true,
      request: {
        protocol: RemoteControlConst.protocol,
        requestId,
        operation,
        ...(operationId === null ? {} : { operationId }),
        body: body.data,
      } as RemoteControlRequestUnion,
    }
  }

  static fingerprint(request: RemoteControlRequestUnion): string {
    return JSON.stringify({ operation: request.operation, body: request.body })
  }

  static isMutating(operation: RemoteControlOperation): operation is RemoteControlMutatingOperation {
    return (RemoteControlConst.mutatingOperations as readonly RemoteControlOperation[]).includes(operation)
  }
}
