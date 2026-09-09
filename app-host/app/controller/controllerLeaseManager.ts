import { randomUUID } from 'node:crypto'

import {
  HostWireConst,
  type ControllerLeaseResult,
} from '../wire/hostWire.js'

/**
 * One writer at a time. The Host holds a single controller lease; every mutation and every
 * interactive terminal write is checked against it, so a stale client cannot drive a runtime whose
 * control has moved on.
 */
export class ControllerLeaseManager {
  private lease: ControllerLeaseResult | null = null

  acquire(controllerId: string, ttlMs?: number): ControllerLeaseResult {
    if (!controllerId || controllerId.length > 200)
      throw new Error('controllerId must be a non-empty string up to 200 characters')
    const now = Date.now()
    if (this.lease && this.lease.expiresAt <= now) this.lease = null
    if (this.lease && this.lease.expiresAt > now && this.lease.controllerId !== controllerId)
      throw new Error(`Host is controlled by ${this.lease.controllerId}`)
    this.lease = {
      controllerLeaseId: this.lease?.controllerId === controllerId
        ? this.lease.controllerLeaseId
        : randomUUID(),
      controllerId,
      expiresAt: now + ControllerLeaseManager.ttl(ttlMs),
    }
    return { ...this.lease }
  }

  renew(controllerLeaseId: string, ttlMs?: number): ControllerLeaseResult {
    const lease = this.require(controllerLeaseId)
    this.lease = {
      ...lease,
      expiresAt: Date.now() + ControllerLeaseManager.ttl(ttlMs),
    }
    return { ...this.lease }
  }

  release(controllerLeaseId: string): void {
    this.require(controllerLeaseId)
    this.lease = null
  }

  require(controllerLeaseId: string): ControllerLeaseResult {
    if (!this.lease || this.lease.expiresAt <= Date.now()) {
      this.lease = null
      throw new Error('Controller lease is missing or expired')
    }
    if (this.lease.controllerLeaseId !== controllerLeaseId)
      throw new Error('Controller lease does not match')
    return { ...this.lease }
  }

  current(): ControllerLeaseResult | null {
    if (this.lease && this.lease.expiresAt <= Date.now()) this.lease = null
    return this.lease ? { ...this.lease } : null
  }

  private static ttl(value: number | undefined): number {
    if (value === undefined) return HostWireConst.defaultControllerLeaseTtlMs
    if (!Number.isInteger(value) || value < 1_000 || value > HostWireConst.maxControllerLeaseTtlMs)
      throw new Error(`ttlMs must be an integer 1000..${HostWireConst.maxControllerLeaseTtlMs}`)
    return value
  }
}
