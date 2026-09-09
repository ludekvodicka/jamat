import { RemoteControlLocalEnvelope } from '../../../../lib-orchestrator/remoteControl/remoteControlEnvelope'
import { RemoteControlLocalRequestValidation } from '../../../../lib-orchestrator/remoteControl/remoteControlLocalRequestValidation'
import type {
  RemoteControlComputersDto,
  RemoteControlLocalRequestUnion,
  RemoteControlLocalResponse,
  RemoteControlStepResult,
} from '../../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlOperationStore } from '../../../../lib-orchestrator/remoteControl/remoteControlOperationStore'
import type {
  RemoteConnectionsPort,
  RemoteConnectionsSnapshot,
} from '../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  RemoteControlPeerPairingBundle,
  RemoteControlPeerProfile,
} from '../../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { ErrorText } from '../../../shared/errorText'

export interface RemoteControlLocalPort {
  snapshot(): RemoteConnectionsSnapshot
  execute: RemoteConnectionsPort['execute']
  pairingBundle(): RemoteControlPeerPairingBundle
  /** Awaited: trusting a machine is asked of a person, so this one blocks on a dialog. */
  importPairing(
    bundle: RemoteControlPeerPairingBundle,
  ): Promise<RemoteControlStepResult<RemoteControlPeerProfile>>
}

/**
 * The three operations that manage OTHER computers: which ones are paired, this computer's own
 * pairing bundle, and taking somebody else's in. A separate service from the control API beside it -
 * different operations, different validator, different port - and it used to live inside the same
 * class only because both arrive over the same loopback listener.
 */
export class RemoteControlLocalOperations {
  constructor(
    private readonly port: RemoteControlLocalPort | undefined,
    private readonly operationStore: RemoteControlOperationStore,
    private readonly onError: (message: string) => void,
  ) {}

  async execute(input: unknown, callerId: string): Promise<RemoteControlLocalResponse> {
    const validated = RemoteControlLocalRequestValidation.parse(input)
    if (!validated.ok)
      return RemoteControlLocalEnvelope.failure(
        validated.requestId,
        validated.operation,
        validated.operationId,
        validated.error,
      )
    const request = validated.request
    try {
      if (RemoteControlLocalRequestValidation.isMutating(request.operation)) {
        const operationId = request.operationId
        if (operationId === undefined)
          throw new Error(`Mutation ${request.operation} passed validation without operationId`)
        const stored = await this.operationStore.runOrRefuse(
          callerId,
          operationId,
          RemoteControlLocalRequestValidation.fingerprint(request),
          () => this.dispatchLocal(request),
        )
        if (!stored.ok)
          return RemoteControlLocalEnvelope.failure(
            request.requestId,
            request.operation,
            operationId,
            stored.error,
          )
        return stored.value
      }
      return this.dispatchLocal(request)
    } catch (error) {
      this.onError(`Local control ${request.operation} failed: ${ErrorText.of(error)}`)
      return RemoteControlLocalEnvelope.failure(
        request.requestId,
        request.operation,
        request.operationId ?? null,
        { code: 'operation-failed', detail: 'The operation failed unexpectedly' },
      )
    }
  }

  private async dispatchLocal(
    request: RemoteControlLocalRequestUnion,
  ): Promise<RemoteControlLocalResponse> {
    const local = this.port
    if (local === undefined)
      return RemoteControlLocalEnvelope.failure(
        request.requestId,
        request.operation,
        request.operationId ?? null,
        { code: 'unavailable', detail: 'Local remote management is unavailable' },
      )
    if (request.operation === 'remote.computers.list') {
      const snapshot = local.snapshot()
      const value: RemoteControlComputersDto = {
        revision: snapshot.revision,
        computers: snapshot.outbound.map((endpoint) => ({
          profileId: endpoint.profileId,
          remoteComputerId: endpoint.remoteComputerId,
          remoteEndpointId: endpoint.remoteEndpointId,
          configIdentity: endpoint.configIdentity,
          runtimeChannel: endpoint.runtimeChannel,
          displayName: endpoint.displayName,
          endpoint: structuredClone(endpoint.endpoint),
          status: endpoint.status,
          error: endpoint.error === null ? null : structuredClone(endpoint.error),
          lastConnectedAt: endpoint.lastConnectedAt,
          nextRetryAt: endpoint.nextRetryAt,
          applicationVersion: endpoint.applicationVersion,
          optionalOperations: endpoint.optionalOperations === null
            ? null
            : [...endpoint.optionalOperations],
          sessionCount: endpoint.sessions?.sessions.length ?? null,
        })),
      }
      return RemoteControlLocalEnvelope.success(request, value)
    } else if (request.operation === 'remote.pairing.export')
      return RemoteControlLocalEnvelope.success(request, local.pairingBundle())
    else if (request.operation === 'remote.pairing.import') {
      const imported = await local.importPairing(request.body.bundle)
      return imported.ok
        ? RemoteControlLocalEnvelope.success(request, imported.value)
        : RemoteControlLocalEnvelope.failure(
            request.requestId,
            request.operation,
            request.operationId ?? null,
            imported.error,
          )
    } else
      throw new Error(`Unknown local control operation: ${JSON.stringify(request)}`)
  }
}
