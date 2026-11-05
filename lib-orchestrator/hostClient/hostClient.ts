import type {
  HostDescriptor,
  HostEvent,
  HostHealthResult,
  HostOpName,
  HostWireConst,
  RuntimeInspectResult,
  RuntimeLaunchSpec,
  RuntimeListResult,
  RuntimeMutationAck,
  RuntimeRef,
  RuntimeResult,
  TerminalProjectionView,
} from '../../app-host/app/wire/hostWire.js'
import type { HostDebugStatus } from '../sessionManager/sessionManagerApi.types'
import type { HostConnectionSource } from './hostConnection'
import type { HostCallResult, HostConnectionPresence, HostHelloReading } from './hostClient.types'
import { HostEventsSocket } from './hostEventsSocket'
import { HostHttpClient } from './hostHttpClient'

export interface HostClientDeps {
  connection: HostConnectionSource
  onEvent: (event: HostEvent) => void
  onPresence: (presence: HostConnectionPresence) => void
  /** A full `runtime.list` is owed: a new Host process, or a replay window that fell behind. */
  onResync: () => void
  onError: (message: string) => void
  /** The controller lease is held under a new id (`ControllerLeaseKeeperDeps.onGranted`). */
  onLeaseGranted?: () => void
}

/**
 * Host calls and the events socket read their descriptor and authority from the injected source.
 * Nothing here knows whether that source watches a file or receives another process's state.
 */
export class HostClient {
  /** Mirrored through the type system: the annotation fails to compile if the Host drops the name. */
  private static readonly healthCapabilityConst:
    Extract<typeof HostWireConst.capabilities[number], 'host.health.v1'> = 'host.health.v1'
  private readonly deps: HostClientDeps
  private unsubscribe: (() => void) | null = null
  private descriptorIdentity: string | null = null
  private leaseIdentity: string | null = null
  private readonly http: HostHttpClient
  private readonly events: HostEventsSocket
  private presenceValue: HostConnectionPresence = 'unreachable'
  private started = false

  constructor(deps: HostClientDeps) {
    this.deps = deps
    this.http = new HostHttpClient(() => this.descriptor())
    this.events = new HostEventsSocket({
      onEvent: deps.onEvent,
      onResync: deps.onResync,
      onConnected: () => this.settlePresence(),
      onDisconnected: () => this.settlePresence(),
      onError: deps.onError,
    })
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribe = this.deps.connection.onChanged(() => this.onConnection())
    this.onConnection()
  }

  /** Detach only: the socket closes; the connection owner releases the lease. */
  async stop(): Promise<void> {
    this.started = false
    this.unsubscribe?.()
    this.unsubscribe = null
    this.descriptorIdentity = null
    this.leaseIdentity = null
    this.events.close()
    this.settlePresence()
  }

  presence(): HostConnectionPresence {
    return this.presenceValue
  }

  descriptor(): HostDescriptor | null {
    return this.deps.connection.descriptor()
  }

  /** The ping. Not an operation and not on any cadence of this class: a caller asks, or nobody does. */
  async hello(): Promise<HostCallResult<HostHelloReading>> {
    return this.http.hello()
  }

  /**
   * The lease a mutation would be made under, for the one caller that needs to name it on a frame
   * instead of in a body: a terminal attach asking to be a writer. The Host holds one lease at a
   * time, so a second controller identity would take this one away from every `runtime.*` call.
   */
  controllerLeaseId(): string | null {
    return this.deps.connection.leaseId()
  }

  /**
   * The one way the parts this class owns are read from outside it. Each of them names its own block
   * of the debug shape, so nothing here restates a field or decides what a reader may see.
   */
  debugView(): Pick<HostDebugStatus, 'eventsSocket'> {
    return {
      eventsSocket: this.events.debugView(),
    }
  }

  /**
   * The Host's memory history. Null when the running Host predates `host.health`: it would answer
   * 404, and that is a fact about its build rather than a failure worth reporting.
   */
  async health(): Promise<HostCallResult<HostHealthResult> | null> {
    const descriptor = this.descriptor()
    if (descriptor === null)
      return { ok: false, code: 'host-unreachable', detail: 'host.health: no Host descriptor is published' }
    if (!descriptor.capabilities.includes(HostClient.healthCapabilityConst)) return null
    return this.http.call<HostHealthResult>('host.health', {})
  }

  async runtimeList(): Promise<HostCallResult<RuntimeListResult>> {
    return this.http.call<RuntimeListResult>('runtime.list', {})
  }

  /**
   * `view` says how much of the projection the caller reads; omitting it asks for all of it, which
   * is also what a Host older than the field answers whatever is sent.
   */
  async runtimeInspect(
    target: RuntimeRef,
    view?: TerminalProjectionView,
  ): Promise<HostCallResult<RuntimeInspectResult>> {
    return this.http.call<RuntimeInspectResult>(
      'runtime.inspect', view === undefined ? { target } : { target, view })
  }

  async runtimeCreate(request: {
    operationId: string
    runtimeSessionId: string
    launch: RuntimeLaunchSpec
  }): Promise<HostCallResult<RuntimeResult>> {
    if (request.launch.stopDescendants && this.descriptor() !== null && !this.descriptor()?.capabilities.includes('runtime.managed-descendants.v1'))
      return { ok: false, code: 'op-rejected', status: 400, detail: 'This Host does not support managed descendants. Restart the Host before starting managed runs.' }
    return this.mutate<RuntimeResult>(
      'runtime.create',
      (controllerLeaseId) => ({ controllerLeaseId, ...request, launch: { ...request.launch, stopDescendants: request.launch.stopDescendants === true } }),
    )
  }

  async runtimeReplace(request: {
    target: RuntimeRef
    operationId: string
    launch: RuntimeLaunchSpec
  }): Promise<HostCallResult<RuntimeResult>> {
    if (request.launch.stopDescendants && this.descriptor() !== null && !this.descriptor()?.capabilities.includes('runtime.managed-descendants.v1'))
      return { ok: false, code: 'op-rejected', status: 400, detail: 'This Host does not support managed descendants. Restart the Host before starting managed runs.' }
    return this.mutate<RuntimeResult>(
      'runtime.replace',
      (controllerLeaseId) => ({ controllerLeaseId, ...request, launch: { ...request.launch, stopDescendants: request.launch.stopDescendants === true } }),
    )
  }

  async runtimeStop(target: RuntimeRef, confirmExternalStop = false): Promise<HostCallResult<RuntimeMutationAck>> {
    const current = this.descriptor()
    if (confirmExternalStop && current !== null && current.hostInstanceId !== target.hostInstanceId)
      return { ok: true, value: { servedByHostInstanceId: current.hostInstanceId, target, diagnostic: 'already-removed' } }
    return this.mutate<RuntimeMutationAck>(
      'runtime.stop',
      (controllerLeaseId) => ({ controllerLeaseId, target, ...(confirmExternalStop ? { confirmExternalStop: true } : {}) }),
    )
  }

  /** A previous instance holds nothing any more, and the current Host refuses its targets. */
  async runtimeRemove(target: RuntimeRef): Promise<HostCallResult<RuntimeMutationAck>> {
    const current = this.descriptor()
    if (current !== null && current.hostInstanceId !== target.hostInstanceId)
      return { ok: true, value: { servedByHostInstanceId: current.hostInstanceId, target, diagnostic: 'already-removed' } }
    return this.mutate<RuntimeMutationAck>(
      'runtime.remove',
      (controllerLeaseId) => ({ controllerLeaseId, target }),
    )
  }

  /** `warnings` names what the old Host could not stop; a Host older than that answer leaves it out. */
  async stopHost(expectedHostInstanceId: string): Promise<HostCallResult<{ stopping: true; live: number; warnings?: string[] }>> {
    if (this.descriptor()?.hostInstanceId !== expectedHostInstanceId)
      return { ok: false, code: 'host-unreachable', detail: 'The Host changed before the restart. Try again.' }
    return this.mutate('host.stop', (controllerLeaseId) => ({ controllerLeaseId, force: true }))
  }

  /** No lease means the call is refused here rather than queued: authority is not something to wait for. */
  private async mutate<T>(
    name: HostOpName,
    bodyOf: (controllerLeaseId: string) => Record<string, unknown>,
  ): Promise<HostCallResult<T>> {
    if (this.descriptor() === null)
      return { ok: false, code: 'host-unreachable', detail: `${name}: no Host descriptor is published` }
    const controllerLeaseId = this.deps.connection.leaseId()
    if (controllerLeaseId === null)
      return { ok: false, code: 'no-lease', detail: `${name}: no live controller lease` }
    return this.http.call<T>(name, bodyOf(controllerLeaseId))
  }

  private onConnection(): void {
    if (!this.started) return
    const descriptor = this.descriptor()
    const identity = descriptor === null ? null : `${descriptor.hostInstanceId}:${descriptor.port}:${descriptor.token}`
    if (identity !== this.descriptorIdentity) {
      this.descriptorIdentity = identity
      if (descriptor === null) this.events.close()
      else this.events.connect(descriptor)
    }
    const leaseId = this.deps.connection.leaseId()
    if (leaseId !== this.leaseIdentity) {
      this.leaseIdentity = leaseId
      if (leaseId !== null) this.deps.onLeaseGranted?.()
    }
    this.settlePresence()
  }

  private settlePresence(): void {
    const next: HostConnectionPresence = this.descriptor() !== null && this.events.connected()
      ? 'running'
      : 'unreachable'
    if (next === this.presenceValue) return
    this.presenceValue = next
    this.deps.onPresence(next)
  }
}
