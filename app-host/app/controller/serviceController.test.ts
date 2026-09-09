import { describe, expect, it } from 'vitest'

import { HostOperationError } from '../hostTransport/hostOperationError.js'
import { HostOperationRouter } from '../hostTransport/hostOperationRouter.js'
import { ControllerLeaseManager } from './controllerLeaseManager.js'
import { ServiceController } from './serviceController.js'

describe('app-host/app/controller/serviceController', () => {
  function harness() {
    const leases = new ControllerLeaseManager()
    const router = new HostOperationRouter()
    new ServiceController(leases).registerOperations(router)
    const dispatch = (operation: 'controller.acquire' | 'controller.renew' | 'controller.release',
      body: Record<string, unknown>) =>
      router.dispatch(operation, body, new AbortController().signal)
    return { leases, router, dispatch }
  }

  async function refusal(
    call: () => Promise<unknown> | unknown,
  ): Promise<HostOperationError> {
    try { await call() }
    catch (error) {
      expect(error).toBeInstanceOf(HostOperationError)
      return error as HostOperationError
    }
    throw new Error('the operation was expected to fail')
  }

  it('acquires, renews and releases a lease', async () => {
    const { dispatch } = harness()
    const acquired = await dispatch('controller.acquire', { controllerId: 'controller-a' }) as
      { controllerLeaseId: string; controllerId: string; expiresAt: number }
    expect(acquired.controllerId).toBe('controller-a')
    expect(typeof acquired.controllerLeaseId).toBe('string')

    const renewed = await dispatch('controller.renew', {
      controllerLeaseId: acquired.controllerLeaseId,
    }) as { controllerLeaseId: string }
    expect(renewed.controllerLeaseId).toBe(acquired.controllerLeaseId)

    expect(await dispatch('controller.release', {
      controllerLeaseId: acquired.controllerLeaseId,
    })).toEqual({})
  })

  it('answers 400 when the request omits its required identifier', async () => {
    const { dispatch } = harness()
    expect((await refusal(() => dispatch('controller.acquire', {}))).status).toBe(400)
    expect((await refusal(() => dispatch('controller.renew', {}))).status).toBe(400)
    expect((await refusal(() => dispatch('controller.release', {}))).status).toBe(400)
  })

  // A second controller is a conflict, not a bad request: the caller is well-formed but not in charge.
  it('answers 409 when another controller already holds the lease', async () => {
    const { dispatch } = harness()
    await dispatch('controller.acquire', { controllerId: 'controller-a' })
    expect((await refusal(() => dispatch('controller.acquire', {
      controllerId: 'controller-b',
    }))).status).toBe(409)
  })

  it('answers 409 for a renew or release of an unknown lease', async () => {
    const { dispatch } = harness()
    await dispatch('controller.acquire', { controllerId: 'controller-a' })
    expect((await refusal(() => dispatch('controller.renew', {
      controllerLeaseId: 'not-the-lease',
    }))).status).toBe(409)
    expect((await refusal(() => dispatch('controller.release', {
      controllerLeaseId: 'not-the-lease',
    }))).status).toBe(409)
  })

  it('rejects a ttl outside the permitted range', async () => {
    const { dispatch } = harness()
    expect((await refusal(() => dispatch('controller.acquire', {
      controllerId: 'controller-a',
      ttlMs: 999,
    }))).status).toBe(409)
    expect((await refusal(() => dispatch('controller.acquire', {
      controllerId: 'controller-a',
      ttlMs: 30_001,
    }))).status).toBe(409)
  })

  // The split moved these three ops out of the sessions service; only both halves together are complete.
  it('registers exactly the controller operations, leaving the rest to the other services', () => {
    const { router } = harness()
    expect(() => router.assertComplete()).toThrow(/runtime\./)
  })
})
