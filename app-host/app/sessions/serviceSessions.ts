import { ControllerLeaseManager } from '../controller/controllerLeaseManager.js'
import { EventHub } from '../events/eventHub.js'
import { HostOperationError } from '../hostTransport/hostOperationError.js'
import type { HostOperationRouter } from '../hostTransport/hostOperationRouter.js'
import type {
  RuntimeCreateReq,
  RuntimeInspectReq,
  RuntimeInspectResult,
  RuntimeListResult,
  RuntimeMutationAck,
  RuntimeReplaceReq,
  RuntimeResult,
  RuntimeTargetMutationReq,
} from '../wire/hostWire.js'
import { SessionError } from './sessionError.js'
import { SessionManager } from './sessionManager.js'

/**
 * The `runtime.*` half of V2's single service: it maps the lifecycle domain onto wire operations and
 * translates a SessionError code into the HTTP status the transport answers with.
 *
 * The lease is checked twice on every mutation, once when the request arrives and again when its
 * queued operation actually starts, because authority can change while a request waits in the queue.
 */
export class ServiceSessions {
  constructor(
    private readonly sessions: SessionManager,
    private readonly leases: ControllerLeaseManager,
    private readonly events: EventHub,
  ) {}

  registerOperations(router: HostOperationRouter): void {
    router.register('runtime.list', () => this.list())
    router.register('runtime.inspect', (body) => this.inspect(body))
    router.register('runtime.create', (body) => this.mapErrors(() => this.create(body)))
    router.register('runtime.replace', (body) => this.mapErrors(() => this.replace(body)))
    router.register('runtime.stop', (body) => this.mapErrors(() => this.stop(body)))
    router.register('runtime.remove', (body) => this.mapErrors(() => this.remove(body)))
  }

  private list(): RuntimeListResult {
    return {
      hostInstanceId: this.sessions.instanceId,
      sessions: this.sessions.list(),
      throughRevision: this.events.revision,
    }
  }

  private inspect(body: Record<string, unknown>): Promise<RuntimeInspectResult> {
    const request = body as unknown as RuntimeInspectReq
    return this.mapErrors(() => this.sessions.inspect(request.target))
  }

  private async create(body: Record<string, unknown>): Promise<RuntimeResult> {
    const request = body as unknown as RuntimeCreateReq
    this.requireLease(request.controllerLeaseId)
    return {
      hostInstanceId: this.sessions.instanceId,
      session: await this.sessions.create(
        request,
        () => this.requireLease(request.controllerLeaseId),
      ),
    }
  }

  private async replace(body: Record<string, unknown>): Promise<RuntimeResult> {
    const request = body as unknown as RuntimeReplaceReq
    this.requireLease(request.controllerLeaseId)
    return {
      hostInstanceId: this.sessions.instanceId,
      session: await this.sessions.replace(
        request,
        () => this.requireLease(request.controllerLeaseId),
      ),
    }
  }

  private async stop(body: Record<string, unknown>): Promise<RuntimeMutationAck> {
    const request = body as unknown as RuntimeTargetMutationReq
    this.requireLease(request.controllerLeaseId)
    return this.sessions.stop(
      request.target,
      () => this.requireLease(request.controllerLeaseId),
    )
  }

  private async remove(body: Record<string, unknown>): Promise<RuntimeMutationAck> {
    const request = body as unknown as RuntimeTargetMutationReq
    this.requireLease(request.controllerLeaseId)
    return this.sessions.remove(
      request.target,
      () => this.requireLease(request.controllerLeaseId),
    )
  }

  private requireLease(controllerLeaseId: unknown): void {
    if (typeof controllerLeaseId !== 'string')
      throw new HostOperationError(400, 'controllerLeaseId is required')
    try { this.leases.require(controllerLeaseId) }
    catch (error) { throw HostOperationError.conflictFrom(error) }
  }

  private async mapErrors<T>(operation: () => T | Promise<T>): Promise<T> {
    try { return await operation() }
    catch (error) {
      if (error instanceof SessionError)
        throw new HostOperationError(ServiceSessions.status(error), error.message)
      throw error
    }
  }

  private static status(error: SessionError): number {
    if (error.code === 'invalid-request') return 400
    else if (error.code === 'not-found') return 404
    else if (error.code === 'conflict') return 409
    else if (error.code === 'limit-exceeded') return 429
    else
      throw new Error(`Unknown session error: ${JSON.stringify(error.code)}`)
  }
}
