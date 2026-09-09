import type {
  RemoteControlError,
  RemoteControlLocalMutatingOperation,
  RemoteControlLocalOperation,
  RemoteControlLocalRequestUnion,
} from './remoteControlApi.types'
import {
  RemoteControlEnvelopeValidation,
  RemoteControlValidationError,
} from './remoteControlEnvelopeValidation'
import { RemoteControlPairing } from './remoteControlPairing'
import { RemoteControlConst, RemoteControlLocalConst } from './remoteControlProtocol'

export type RemoteControlLocalRequestValidationResult =
  | { ok: true; request: RemoteControlLocalRequestUnion }
  | {
      ok: false
      requestId: string | null
      operation: RemoteControlLocalOperation | null
      operationId: string | null
      error: RemoteControlError
    }

/**
 * The local surface's requests, read strictly.
 *
 * The envelope and the field helpers are `RemoteControlEnvelopeValidation`'s, shared with the
 * outside surface's validator: the two carried byte-identical copies of the protocol check, the
 * unknown-key refusal and the `operationId` rules, and had already begun to word them differently.
 * What is this file's own is the operation list, which of them mutate, and each body.
 */
export class RemoteControlLocalRequestValidation {
  private static readonly specConst = {
    operations: RemoteControlLocalConst.operations,
    isMutating: (operation: RemoteControlLocalOperation) =>
      RemoteControlLocalRequestValidation.isMutating(operation),
  }

  static parse(input: unknown): RemoteControlLocalRequestValidationResult {
    const envelope = RemoteControlEnvelopeValidation
      .parse<RemoteControlLocalOperation>(input, RemoteControlLocalRequestValidation.specConst)
    if (!envelope.ok) return envelope
    const { requestId, operation, operationId, body } = envelope
    try {
      return { ok: true, request: RemoteControlLocalRequestValidation.requestOf(
        requestId,
        operation,
        operationId,
        body,
      ) }
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

  static fingerprint(request: RemoteControlLocalRequestUnion): string {
    return JSON.stringify({ operation: request.operation, body: request.body })
  }

  static isMutating(
    operation: RemoteControlLocalOperation,
  ): operation is RemoteControlLocalMutatingOperation {
    return (RemoteControlLocalConst.mutatingOperations as readonly RemoteControlLocalOperation[])
      .includes(operation)
  }

  private static requestOf(
    requestId: string,
    operation: RemoteControlLocalOperation,
    operationId: string | null,
    body: unknown,
  ): RemoteControlLocalRequestUnion {
    const base = { protocol: RemoteControlConst.protocol, requestId }
    if (operation === 'remote.computers.list')
      return {
        ...base,
        operation,
        body: RemoteControlEnvelopeValidation.empty(body, operation),
      }
    else if (operation === 'remote.pairing.export')
      return {
        ...base,
        operation,
        body: RemoteControlEnvelopeValidation.empty(body, operation),
      }
    else if (operation === 'remote.pairing.import')
      return {
        ...base,
        operation,
        operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId),
        body: RemoteControlLocalRequestValidation.pairingImport(body),
      }
    else
      throw new Error(`Unknown local control operation: ${JSON.stringify(operation)}`)
  }

  private static pairingImport(
    input: unknown,
  ): Extract<RemoteControlLocalRequestUnion, { operation: 'remote.pairing.import' }>['body'] {
    const value = RemoteControlEnvelopeValidation.object(input, 'remote.pairing.import body')
    RemoteControlEnvelopeValidation.keys(value, ['bundle'], 'remote.pairing.import body')
    let bundle
    try { bundle = RemoteControlPairing.parse(value.bundle) }
    catch {
      throw new RemoteControlValidationError('bundle must be a valid remote pairing bundle')
    }
    return { bundle }
  }
}
