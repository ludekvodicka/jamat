import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type { HostDescriptor } from '../../app-host/app/wire/hostWire.js'
import type { HostDebugStatus } from '../sessionManager/sessionManagerApi.types'
import { ErrorText } from '../shared/errorText'
import { ControllerLeaseKeeper } from './controllerLeaseKeeper'
import { HostDescriptorWatcher } from './hostDescriptorWatcher'
import { HostHttpClient } from './hostHttpClient'

export interface HostConnectionSource {
  descriptor(): HostDescriptor | null
  leaseId(): string | null
  onChanged(listener: () => void): () => void
}

export interface HostConnectionSnapshot {
  descriptor: HostDescriptor | null
  leaseId: string | null
  debug: Pick<HostDebugStatus, 'watcher' | 'lease'>
}

export interface LocalHostConnectionDeps {
  descriptorFile: string
  controllerId?: string
  descriptorPollMilliseconds?: number
  onError: (message: string) => void
}

export class LocalHostConnection implements HostConnectionSource {
  private readonly deps: LocalHostConnectionDeps
  private readonly watcher: HostDescriptorWatcher
  private readonly lease: ControllerLeaseKeeper
  private readonly listeners = new Set<() => void>()
  private started = false
  private lastDescriptor: HostDescriptor | null = null
  private lastLeaseId: string | null = null

  constructor(deps: LocalHostConnectionDeps) {
    this.deps = deps
    this.watcher = new HostDescriptorWatcher({
      descriptorFile: deps.descriptorFile,
      pollMilliseconds: deps.descriptorPollMilliseconds,
      onChange: descriptor => this.onDescriptor(descriptor),
      onError: deps.onError,
    })
    const http = new HostHttpClient(() => this.descriptor())
    this.lease = new ControllerLeaseKeeper({
      controllerId: deps.controllerId ?? `jamat-client-${randomUUID()}`,
      call: (name, body) => http.call(name, body),
      onError: deps.onError,
      onGranted: () => {},
      onChanged: () => this.changed(),
    })
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.watcher.start()
  }

  async stop(): Promise<void> {
    this.started = false
    this.watcher.stop()
    await this.lease.stop()
  }

  releaseResult(): ReturnType<ControllerLeaseKeeper['releaseResult']> { return this.lease.releaseResult() }

  descriptor(): HostDescriptor | null { return this.watcher.current() }
  leaseId(): string | null { return this.lease.leaseId() }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  debugView(): Pick<HostDebugStatus, 'watcher' | 'lease'> {
    return { watcher: this.watcher.debugView(), lease: this.lease.debugView() }
  }

  private onDescriptor(descriptor: HostDescriptor | null): void {
    // A descriptor read can land after stop; it must not acquire authority for a dead owner.
    if (!this.started) return
    const work = descriptor === null ? this.lease.stop() : this.lease.start()
    this.changed()
    void work.catch(error => this.deps.onError(
      `${descriptor === null ? 'Releasing' : 'Taking'} the Host controller lease failed: ${ErrorText.of(error)}`))
  }

  private changed(): void {
    const descriptor = this.descriptor(), leaseId = this.leaseId()
    if (descriptor === this.lastDescriptor && leaseId === this.lastLeaseId) return
    this.lastDescriptor = descriptor
    this.lastLeaseId = leaseId
    for (const listener of this.listeners) listener()
  }
}

export class FedHostConnection implements HostConnectionSource {
  private descriptorValue: HostDescriptor | null = null
  private leaseValue: string | null = null
  private readonly listeners = new Set<() => void>()

  descriptor(): HostDescriptor | null { return this.descriptorValue }
  leaseId(): string | null { return this.leaseValue }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  update(descriptor: HostDescriptor | null, leaseId: string | null): void {
    if (isDeepStrictEqual(descriptor, this.descriptorValue) && leaseId === this.leaseValue) return
    this.descriptorValue = descriptor
    this.leaseValue = leaseId
    for (const listener of this.listeners) listener()
  }
}
