import { randomUUID } from 'node:crypto'

import type {
  HostDescriptor,
  HostEvent,
  HostOpName,
  RuntimeInspectResult,
  RuntimeLaunchSpec,
  RuntimeListResult,
  RuntimeMutationAck,
  RuntimeRef,
  RuntimeResult,
} from '../../app-host/app/wire/hostWire.js'
import type { HostDebugStatus } from '../sessionManager/sessionManagerApi.types'
import { ErrorText } from '../shared/errorText'
import { ControllerLeaseKeeper } from './controllerLeaseKeeper'
import type { HostCallResult, HostConnectionPresence, HostHelloReading } from './hostClient.types'
import { HostDescriptorWatcher } from './hostDescriptorWatcher'
import { HostEventsSocket } from './hostEventsSocket'
import { HostHttpClient } from './hostHttpClient'

export interface HostClientDeps {
  descriptorFile: string
  onEvent: (event: HostEvent) => void
  onPresence: (presence: HostConnectionPresence) => void
  /** A full `runtime.list` is owed: a new Host process, or a replay window that fell behind. */
  onResync: () => void
  onError: (message: string) => void
  /** Random per client process by default: two clients sharing one id would steal each other's lease. */
  controllerId?: string
  descriptorPollMilliseconds?: number
}

/**
 * The whole of the Host wire seen from the rest of this library: a descriptor watch, one socket, one
 * lease, and the operations, all of them answering with values. Nothing here knows what a session is.
 */
export class HostClient {
  private readonly watcher: HostDescriptorWatcher
  private readonly http: HostHttpClient
  private readonly events: HostEventsSocket
  private readonly lease: ControllerLeaseKeeper
  private presenceValue: HostConnectionPresence = 'unreachable'
  private started = false

  constructor(private readonly deps: HostClientDeps) {
    this.watcher = new HostDescriptorWatcher({
      descriptorFile: deps.descriptorFile,
      pollMilliseconds: deps.descriptorPollMilliseconds,
      onChange: (descriptor) => this.onDescriptor(descriptor),
      onError: deps.onError,
    })
    this.http = new HostHttpClient(() => this.watcher.current())
    this.events = new HostEventsSocket({
      onEvent: deps.onEvent,
      onResync: deps.onResync,
      onConnected: () => this.settlePresence(),
      onDisconnected: () => this.settlePresence(),
      onError: deps.onError,
    })
    this.lease = new ControllerLeaseKeeper({
      controllerId: deps.controllerId ?? `jamat-client-${randomUUID()}`,
      call: (name, body) => this.http.call(name, body),
      onError: deps.onError,
    })
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.watcher.start()
  }

  /** Detach only: the socket closes, the lease is released if it can be, and no runtime dies. */
  async stop(): Promise<void> {
    this.started = false
    this.watcher.stop()
    this.events.close()
    await this.lease.stop()
    this.settlePresence()
  }

  presence(): HostConnectionPresence {
    return this.presenceValue
  }

  descriptor(): HostDescriptor | null {
    return this.watcher.current()
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
    return this.lease.leaseId()
  }

  /**
   * The one way the parts this class owns are read from outside it. Each of them names its own block
   * of the debug shape, so nothing here restates a field or decides what a reader may see.
   */
  debugView(): Pick<HostDebugStatus, 'watcher' | 'eventsSocket' | 'lease'> {
    return {
      watcher: this.watcher.debugView(),
      eventsSocket: this.events.debugView(),
      lease: this.lease.debugView(),
    }
  }

  async runtimeList(): Promise<HostCallResult<RuntimeListResult>> {
    return this.http.call<RuntimeListResult>('runtime.list', {})
  }

  async runtimeInspect(target: RuntimeRef): Promise<HostCallResult<RuntimeInspectResult>> {
    return this.http.call<RuntimeInspectResult>('runtime.inspect', { target })
  }

  async runtimeCreate(request: {
    operationId: string
    runtimeSessionId: string
    launch: RuntimeLaunchSpec
  }): Promise<HostCallResult<RuntimeResult>> {
    return this.mutate<RuntimeResult>(
      'runtime.create',
      (controllerLeaseId) => ({ controllerLeaseId, ...request }),
    )
  }

  async runtimeReplace(request: {
    target: RuntimeRef
    operationId: string
    launch: RuntimeLaunchSpec
  }): Promise<HostCallResult<RuntimeResult>> {
    return this.mutate<RuntimeResult>(
      'runtime.replace',
      (controllerLeaseId) => ({ controllerLeaseId, ...request }),
    )
  }

  async runtimeStop(target: RuntimeRef): Promise<HostCallResult<RuntimeMutationAck>> {
    return this.mutate<RuntimeMutationAck>(
      'runtime.stop',
      (controllerLeaseId) => ({ controllerLeaseId, target }),
    )
  }

  async runtimeRemove(target: RuntimeRef): Promise<HostCallResult<RuntimeMutationAck>> {
    return this.mutate<RuntimeMutationAck>(
      'runtime.remove',
      (controllerLeaseId) => ({ controllerLeaseId, target }),
    )
  }

  /** No lease means the call is refused here rather than queued: authority is not something to wait for. */
  private async mutate<T>(
    name: HostOpName,
    bodyOf: (controllerLeaseId: string) => Record<string, unknown>,
  ): Promise<HostCallResult<T>> {
    if (this.watcher.current() === null)
      return { ok: false, code: 'host-unreachable', detail: `${name}: no Host descriptor is published` }
    const controllerLeaseId = this.lease.leaseId()
    if (controllerLeaseId === null)
      return { ok: false, code: 'no-lease', detail: `${name}: no live controller lease` }
    return this.http.call<T>(name, bodyOf(controllerLeaseId))
  }

  private onDescriptor(descriptor: HostDescriptor | null): void {
    // A read that was already inside `await readFile(...)` when `stop()` cleared the watcher's timer
    // lands here afterwards. Clearing an interval cannot cancel a file operation already in flight,
    // so without this the client opens a socket and takes a lease after it was stopped.
    if (!this.started) return
    if (descriptor === null) {
      this.events.close()
      this.detach(this.lease.stop(), 'Releasing the Host controller lease')
      this.settlePresence()
      return
    }
    this.events.connect(descriptor)
    this.detach(this.lease.start(), 'Taking the Host controller lease')
    this.settlePresence()
  }

  /** The descriptor watch calls this from a timer, so a rejection here has no caller to reach. */
  private detach(work: Promise<void>, what: string): void {
    void work.catch((error) => this.deps.onError(`${what} failed: ${ErrorText.of(error)}`))
  }

  private settlePresence(): void {
    const next: HostConnectionPresence = this.watcher.current() !== null && this.events.connected()
      ? 'running'
      : 'unreachable'
    if (next === this.presenceValue) return
    this.presenceValue = next
    this.deps.onPresence(next)
  }
}
