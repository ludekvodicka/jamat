import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { HostDescriptor, HostOpName } from '../../app-host/app/wire/hostWire.js'
import { FedHostConnection, LocalHostConnection } from './hostConnection'
import { HostHttpClient } from './hostHttpClient'
import type { HostCallResult } from './hostClient.types'

const descriptor: HostDescriptor = {
  schemaVersion: 1, pid: 10, processStartedAt: 1, port: 4321, token: 'test-token',
  protocol: { major: 1, minor: 0 }, capabilities: [], hostVersion: '1', payloadHash: 'hash',
  configIdentity: 'identity', runtimeChannel: 'development', hostInstanceId: 'host',
  hostGeneration: 'generation', startedAt: 1,
}

describe('FedHostConnection', () => {
  it('notifies changed leases and descriptors, suppresses equal values and unsubscribes', () => {
    const source = new FedHostConnection()
    const changed = vi.fn()
    const unsubscribe = source.onChanged(changed)
    expect(source.descriptor()).toBeNull()
    expect(source.leaseId()).toBeNull()
    source.update(null, null)
    expect(changed).toHaveBeenCalledTimes(0)
    source.update(descriptor, 'lease-one')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(source.descriptor()).toEqual(descriptor)
    expect(source.leaseId()).toBe('lease-one')
    source.update({ ...descriptor, capabilities: [] }, 'lease-one')
    expect(changed).toHaveBeenCalledTimes(1)
    source.update(descriptor, 'lease-two')
    expect(changed).toHaveBeenCalledTimes(2)
    expect(source.leaseId()).toBe('lease-two')
    source.update({ ...descriptor, token: 'replacement-token' }, 'lease-two')
    expect(changed).toHaveBeenCalledTimes(3)
    source.update(null, null)
    expect(changed).toHaveBeenCalledTimes(4)
    expect(source.descriptor()).toBeNull()
    expect(source.leaseId()).toBeNull()
    unsubscribe()
    source.update(descriptor, 'lease-three')
    expect(changed).toHaveBeenCalledTimes(4)
  })
})

describe('LocalHostConnection', () => {
  it('publishes expiry during a delayed renew, preserves release authority and suppresses normal renewals', async () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-host-connection-'))
    const descriptorFile = join(root, 'descriptor.json')
    writeFileSync(descriptorFile, JSON.stringify(descriptor))
    let finishRenew: () => void = () => {}
    let holdRenew = false
    const pendingRenew = new Promise<void>(resolve => { finishRenew = resolve })
    const calls: { name: HostOpName; body: Record<string, unknown> }[] = []
    const http = vi.spyOn(HostHttpClient.prototype, 'call').mockImplementation(async <T>(
      name: HostOpName, body: Record<string, unknown>,
    ): Promise<HostCallResult<T>> => {
      calls.push({ name, body })
      if (name === 'controller.acquire' || name === 'controller.renew') {
        const value = { controllerId: 'controller', controllerLeaseId: 'lease', expiresAt: Date.now() + 1_000 }
        if (name === 'controller.renew' && holdRenew) await pendingRenew
        return { ok: true, value: value as T }
      } else if (name === 'controller.release')
        return { ok: true, value: {} as T }
      else throw new Error(`Unexpected call: ${name}`)
    })
    const connection = new LocalHostConnection({ descriptorFile, onError: message => { throw new Error(message) } })
    const changes: (string | null)[] = []
    const unsubscribe = connection.onChanged(() => changes.push(connection.leaseId()))
    try {
      connection.start()
      await vi.waitFor(() => expect(connection.leaseId()).toBe('lease'))
      expect(changes).toEqual([null, 'lease'])
      await vi.advanceTimersByTimeAsync(500)
      expect(calls.filter(call => call.name === 'controller.renew')).toHaveLength(1)
      expect(changes).toEqual([null, 'lease'])
      holdRenew = true
      await vi.advanceTimersByTimeAsync(500)
      expect(calls.filter(call => call.name === 'controller.renew')).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(500)
      expect(connection.leaseId()).toBeNull()
      expect(changes).toEqual([null, 'lease', null])
      expect(connection.debugView().lease.expiresAt).not.toBeNull()
      const stopped = connection.stop()
      finishRenew()
      await stopped
      expect(connection.releaseResult()).toBe('released')
      expect(calls.at(-1)).toEqual({ name: 'controller.release', body: { controllerLeaseId: 'lease' } })
      expect(changes).toEqual([null, 'lease', null])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      finishRenew()
      await connection.stop()
      unsubscribe()
      http.mockRestore()
      vi.useRealTimers()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
