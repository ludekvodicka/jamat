import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HostDescriptor } from '../../app-host/app/wire/hostWire.js'
import type { HostCallResult } from '../hostClient/hostClient.types'
import { AtomicJsonFile } from '../shared/atomicJsonFile'
import type { SessionHostPort } from './lifecycle/sessionLifecycle'

export class HostGate {
  private readonly descriptor: () => HostDescriptor | null
  private readonly reachable: () => boolean
  private readonly file: string | undefined
  private failedInstance: string | null = null

  constructor(descriptor: () => HostDescriptor | null, reachable: () => boolean, file?: string) {
    this.descriptor = descriptor
    this.reachable = reachable
    this.file = file
    if (file !== undefined) {
      try { this.failedInstance = JSON.parse(readFileSync(file, 'utf8')).instanceId ?? null }
      catch { this.failedInstance = null }
    }
  }

  problemOf(managed = false): string | null {
    const host = this.descriptor()
    if (!this.reachable() || host === null) return 'The Host cannot be reached'
    if (!host.capabilities.includes('pty.release.v2')) return 'The Host cannot create terminals reliably (old build)'
    if (managed && this.managedProblemOf() !== null) return this.managedProblemOf()
    if (this.failedInstance === host.hostInstanceId) return 'The Host recorded ERR_WORKER_OUT_OF_MEMORY; restart the Host before launching terminals'
    return null
  }

  managedProblemOf(): string | null {
    const host = this.descriptor()
    return host !== null && !host.capabilities.includes('runtime.managed-descendants.v1')
      ? 'Restart the Host to finish the update before starting setup, checks or other managed runs' : null
  }

  record(detail: string, instanceId = this.descriptor()?.hostInstanceId): void {
    if (!detail.includes('ERR_WORKER_OUT_OF_MEMORY')) return
    this.failedInstance = instanceId ?? null
    if (this.file !== undefined && this.failedInstance !== null) {
      AtomicJsonFile.ensureDirectory(dirname(this.file))
      AtomicJsonFile.write(this.file, { instanceId: this.failedInstance })
    }
  }

  async launch<T>(run: () => Promise<HostCallResult<T>>): Promise<HostCallResult<T>> {
    const problem = this.problemOf()
    if (problem !== null) return { ok: false, code: 'host-unreachable', detail: problem }
    const instanceId = this.descriptor()?.hostInstanceId
    const result = await run()
    if (!result.ok) this.record(result.detail, instanceId)
    return result
  }

  guard(host: SessionHostPort): SessionHostPort {
    return {
      runtimeCreate: (request) => this.launch(() => host.runtimeCreate(request)),
      runtimeReplace: (request) => this.launch(() => host.runtimeReplace(request)),
      runtimeList: () => host.runtimeList(), runtimeStop: (target) => host.runtimeStop(target), runtimeRemove: (target) => host.runtimeRemove(target),
    }
  }
}
