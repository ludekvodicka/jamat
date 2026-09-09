import { HostOperationError } from '../hostTransport/hostOperationError.js'
import type { HostOperationRouter } from '../hostTransport/hostOperationRouter.js'
import type {
  ControllerLeaseAcquireReq,
  ControllerLeaseMutationReq,
  ControllerLeaseResult,
} from '../wire/hostWire.js'
import { ControllerLeaseManager } from './controllerLeaseManager.js'

/** The `controller.*` half of V2's single service: writer authority and nothing else. */
export class ServiceController {
  constructor(private readonly leases: ControllerLeaseManager) {}

  registerOperations(router: HostOperationRouter): void {
    router.register('controller.acquire', (body) => this.acquire(body))
    router.register('controller.renew', (body) => this.renew(body))
    router.register('controller.release', (body) => this.release(body))
  }

  private acquire(body: Record<string, unknown>): ControllerLeaseResult {
    const request = body as unknown as ControllerLeaseAcquireReq
    if (typeof request.controllerId !== 'string')
      throw new HostOperationError(400, 'controllerId is required')
    try { return this.leases.acquire(request.controllerId, request.ttlMs) }
    catch (error) { throw HostOperationError.conflictFrom(error) }
  }

  private renew(body: Record<string, unknown>): ControllerLeaseResult {
    const request = body as unknown as ControllerLeaseMutationReq
    if (typeof request.controllerLeaseId !== 'string')
      throw new HostOperationError(400, 'controllerLeaseId is required')
    try { return this.leases.renew(request.controllerLeaseId, request.ttlMs) }
    catch (error) { throw HostOperationError.conflictFrom(error) }
  }

  private release(body: Record<string, unknown>): Record<string, never> {
    const request = body as unknown as ControllerLeaseMutationReq
    if (typeof request.controllerLeaseId !== 'string')
      throw new HostOperationError(400, 'controllerLeaseId is required')
    try { this.leases.release(request.controllerLeaseId) }
    catch (error) { throw HostOperationError.conflictFrom(error) }
    return {}
  }
}
