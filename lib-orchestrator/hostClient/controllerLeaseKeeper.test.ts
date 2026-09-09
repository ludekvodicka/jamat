import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ControllerLeaseResult, HostOpName } from '../../app-host/app/wire/hostWire.js'
import { ControllerLeaseKeeper } from './controllerLeaseKeeper'
import type { HostCallResult } from './hostClient.types'

describe('lib-orchestrator/hostClient/controllerLeaseKeeper', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  interface Harness {
    keeper: ControllerLeaseKeeper
    calls: HostOpName[]
    errors: string[]
    grantTtl: (milliseconds: number) => void
    refuse: (refused: boolean) => void
    leaseId: () => string | null
    /**
     * Hold the ANSWER of the next call of this op on the wire. The answer is computed first, so the
     * fake Host has already granted or released by the time the caller is parked - which is the
     * ordering the race is made of: the Host acted, the response has not landed.
     */
    holdNext: (name: HostOpName) => { release: () => void }
  }

  function harness(initialTtl = 10_000): Harness {
    let ttl = initialTtl
    let refused = false
    let granted: ControllerLeaseResult | null = null
    const calls: HostOpName[] = []
    const errors: string[] = []
    const holds = new Map<HostOpName, Promise<void>>()
    const call = async <T>(
      name: HostOpName,
      body: Record<string, unknown>,
    ): Promise<HostCallResult<T>> => {
      calls.push(name)
      const answer = answerOf<T>(name, body)
      const gate = holds.get(name)
      if (gate !== undefined) {
        holds.delete(name)
        await gate
      }
      return answer
    }
    const answerOf = <T>(
      name: HostOpName,
      body: Record<string, unknown>,
    ): HostCallResult<T> => {
      if (refused)
        return { ok: false, code: 'op-rejected', status: 409, detail: `${name} answered 409` }
      if (name === 'controller.acquire') {
        granted = { controllerLeaseId: 'lease-1', controllerId: String(body.controllerId), expiresAt: Date.now() + ttl }
        return { ok: true, value: granted as unknown as T }
      }
      if (name === 'controller.renew') {
        if (granted === null || granted.controllerLeaseId !== body.controllerLeaseId)
          return {
            ok: false,
            code: 'op-rejected',
            status: 409,
            detail: 'controller.renew answered 409',
          }
        granted = { ...granted, expiresAt: Date.now() + ttl }
        return { ok: true, value: granted as unknown as T }
      }
      if (name === 'controller.release') {
        granted = null
        return { ok: true, value: {} as T }
      }
      throw new Error(`the keeper called an op it has no business with: ${name}`)
    }
    const keeper = new ControllerLeaseKeeper({
      controllerId: 'test-controller',
      call,
      onError: (message) => errors.push(message),
    })
    return {
      keeper,
      calls,
      errors,
      grantTtl: (milliseconds) => { ttl = milliseconds },
      refuse: (value) => { refused = value },
      leaseId: () => (granted === null ? null : granted.controllerLeaseId),
      holdNext: (name) => {
        let open = (): void => {}
        holds.set(name, new Promise<void>((resolve) => { open = resolve }))
        return { release: () => open() }
      },
    }
  }

  it('acquires on start and hands out the lease the Host granted', async () => {
    const context = harness()
    await context.keeper.start()
    expect(context.calls).toEqual(['controller.acquire'])
    expect(context.keeper.leaseId()).toBe('lease-1')
  })

  // The TTL is the Host's to choose: a client renewing on a constant of its own lets the lease lapse
  // the day the Host shortens it, and hammers it the day the Host lengthens it.
  it('renews on a cadence derived from expiresAt, not on a constant', async () => {
    const context = harness(1_000)
    await context.keeper.start()
    await vi.advanceTimersByTimeAsync(400)
    expect(context.calls).toEqual(['controller.acquire'])
    await vi.advanceTimersByTimeAsync(200)
    expect(context.calls).toEqual(['controller.acquire', 'controller.renew'])

    const slow = harness(60_000)
    await slow.keeper.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(slow.calls).toEqual(['controller.acquire'])
    await slow.keeper.stop()
    await context.keeper.stop()
  })

  it('reports no lease once the granted one has expired, without being told', async () => {
    const context = harness(1_000)
    await context.keeper.start()
    expect(context.keeper.leaseId()).toBe('lease-1')
    // Past expiry and before the renew this keeper is about to make: a mutation now has no authority.
    vi.setSystemTime(Date.now() + 1_100)
    expect(context.keeper.leaseId()).toBeNull()
    await context.keeper.stop()
  })

  it('takes the lease again after a refused renew', async () => {
    const context = harness(1_000)
    await context.keeper.start()
    context.refuse(true)
    await vi.advanceTimersByTimeAsync(600)
    expect(context.calls).toEqual(['controller.acquire', 'controller.renew', 'controller.acquire'])
    expect(context.keeper.leaseId()).toBeNull()

    context.refuse(false)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(context.keeper.leaseId()).toBe('lease-1')
    await context.keeper.stop()
  })

  it('retries a refused acquire and says so once, not once a second', async () => {
    const context = harness(1_000)
    context.refuse(true)
    await context.keeper.start()
    expect(context.keeper.leaseId()).toBeNull()
    expect(context.errors).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3_100)
    expect(context.calls.length).toBeGreaterThan(2)
    expect(context.errors).toHaveLength(1)
    await context.keeper.stop()
  })

  it('drops the lease of the Host that is gone when it starts against another one', async () => {
    const context = harness()
    await context.keeper.start()
    context.refuse(true)
    const restarted = context.keeper.start()
    // The old lease is forgotten the moment the restart begins: carrying it over would only buy a
    // 409 on the first mutation instead of an honest no-lease.
    expect(context.keeper.leaseId()).toBeNull()
    await restarted
    expect(context.keeper.leaseId()).toBeNull()
    await context.keeper.stop()
  })

  // An expired lease is no lease for a mutation, and the expiry it lapsed at is what says why.
  it('shows the authority it holds, and shows an expired one as none', async () => {
    const context = harness(1_000)
    expect(context.keeper.debugView()).toEqual({
      controllerId: 'test-controller',
      leaseId: null,
      expiresAt: null,
    })

    await context.keeper.start()
    const held = context.keeper.debugView()
    expect(held.leaseId).toBe('lease-1')
    expect(held.expiresAt).toBe(Date.now() + 1_000)

    vi.setSystemTime(Date.now() + 2_000)
    const lapsed = context.keeper.debugView()
    expect(lapsed.leaseId).toBeNull()
    expect(lapsed.expiresAt).toBe(held.expiresAt)
    await context.keeper.stop()
  })

  it('releases on stop and stops renewing', async () => {
    const context = harness(1_000)
    await context.keeper.start()
    await context.keeper.stop()
    expect(context.calls).toEqual(['controller.acquire', 'controller.release'])
    expect(context.leaseId()).toBeNull()
    expect(context.keeper.leaseId()).toBeNull()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(context.calls).toEqual(['controller.acquire', 'controller.release'])
  })

  /**
   * The race this class was rewritten for, made deterministic. Measured on 2026-08-25 as 8 failures
   * in 24 loaded runs of `hostClient.test.ts`, where it read as a flaky test rather than as a Host
   * left under the control of a client that had gone.
   */
  it('releases the lease an acquire in flight brings, even when the stop came first', async () => {
    const context = harness()
    const held = context.holdNext('controller.acquire')
    const started = context.keeper.start()
    await vi.advanceTimersByTimeAsync(0)
    // The Host has granted; the answer carrying the id has not landed here.
    expect(context.leaseId()).toBe('lease-1')
    expect(context.keeper.leaseId()).toBeNull()

    const stopped = context.keeper.stop()
    expect(context.keeper.leaseId()).toBeNull()
    held.release()
    await started
    await stopped

    expect(context.calls).toEqual(['controller.acquire', 'controller.release'])
    expect(context.leaseId()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(context.calls).toEqual(['controller.acquire', 'controller.release'])
  })

  it('releases the grant a renew in flight brings back, and hands out none meanwhile', async () => {
    const context = harness(1_000)
    await context.keeper.start()
    const held = context.holdNext('controller.renew')
    await vi.advanceTimersByTimeAsync(600)
    expect(context.calls).toEqual(['controller.acquire', 'controller.renew'])

    const stopped = context.keeper.stop()
    // The grant it still holds has not expired: only the stop makes this null.
    expect(context.keeper.leaseId()).toBeNull()
    held.release()
    await stopped

    expect(context.calls).toEqual(['controller.acquire', 'controller.renew', 'controller.release'])
    expect(context.leaseId()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  // A refused renew normally takes the lease again, which is the whole job. After a stop it would
  // hand the Host authority nobody is left to use, and nothing would ever release it.
  it('does not take the lease again when a renew refused after stop comes back', async () => {
    const context = harness(1_000)
    await context.keeper.start()
    context.refuse(true)
    const held = context.holdNext('controller.renew')
    await vi.advanceTimersByTimeAsync(600)
    expect(context.calls).toEqual(['controller.acquire', 'controller.renew'])

    const stopped = context.keeper.stop()
    held.release()
    await stopped

    expect(context.calls).toEqual(['controller.acquire', 'controller.renew'])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(context.calls).toEqual(['controller.acquire', 'controller.renew'])
  })
})
