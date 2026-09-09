import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ControllerLeaseManager } from '../controller/controllerLeaseManager.js'
import { EventHub } from '../events/eventHub.js'
import { HostOperationError } from '../hostTransport/hostOperationError.js'
import { HostOperationRouter } from '../hostTransport/hostOperationRouter.js'
import { TerminalLaunchError } from '../terminal/terminalLaunchError.js'
import type { HostOpName } from '../wire/hostWire.js'
import { FakeTerminalInstances } from './fixtures/fakeTerminalInstance.js'
import { SessionManager } from './sessionManager.js'
import { SessionStore } from './sessionStore.js'
import { ServiceSessions } from './serviceSessions.js'

describe('app-host/app/sessions/serviceSessions', () => {
  const directories: string[] = []

  afterEach(() => {
    vi.useRealTimers()
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  it('maps every malformed HTTP target to 400 before runtime lookup', async () => {
    const harness = await ServiceSessionsTest.harness(directories)
    const malformed = {
      hostInstanceId: 'host-1',
      runtimeSessionId: 'runtime-1',
    }
    const cases: Array<[HostOpName, Record<string, unknown>]> = [
      ['runtime.inspect', { target: malformed }],
      ['runtime.replace', {
        controllerLeaseId: harness.leaseId,
        operationId: 'replace-malformed',
        target: malformed,
        launch: ServiceSessionsTest.launch(),
      }],
      ['runtime.stop', { controllerLeaseId: harness.leaseId, target: malformed }],
      ['runtime.remove', { controllerLeaseId: harness.leaseId, target: malformed }],
    ]

    for (const [operation, body] of cases) {
      const error = await harness.refusal(operation, body)
      expect(error).toBeInstanceOf(HostOperationError)
      expect((error as HostOperationError).status).toBe(400)
    }
  })

  it('maps every foreign Host target to conflict and leaves its namesake alive', async () => {
    const harness = await ServiceSessionsTest.harness(directories)
    const foreign = {
      hostInstanceId: 'host-2',
      runtimeSessionId: 'runtime-1',
      generation: 1,
    }
    for (const [operation, body] of [
      ['runtime.inspect', { target: foreign }],
      ['runtime.replace', {
        controllerLeaseId: harness.leaseId,
        operationId: 'replace-foreign',
        target: foreign,
        launch: ServiceSessionsTest.launch(),
      }],
      ['runtime.stop', { controllerLeaseId: harness.leaseId, target: foreign }],
      ['runtime.remove', { controllerLeaseId: harness.leaseId, target: foreign }],
    ] satisfies Array<[HostOpName, Record<string, unknown>]>) {
      const error = await harness.refusal(operation, body)
      expect(error).toBeInstanceOf(HostOperationError)
      expect((error as HostOperationError).status).toBe(409)
    }
    expect(harness.manager.get('runtime-1')?.alive).toBe(true)
  })

  it('requires create runtime and operation IDs as actual strings', async () => {
    const harness = await ServiceSessionsTest.harness(directories)
    const cases: Record<string, unknown>[] = [
      {
        controllerLeaseId: harness.leaseId,
        operationId: 'missing-runtime-id',
        launch: ServiceSessionsTest.launch(),
      },
      {
        controllerLeaseId: harness.leaseId,
        runtimeSessionId: 'runtime-2',
        launch: ServiceSessionsTest.launch(),
      },
    ]

    for (const body of cases) {
      const error = await harness.refusal('runtime.create', body)
      expect(error).toBeInstanceOf(HostOperationError)
      expect((error as HostOperationError).status).toBe(400)
    }
  })

  /**
   * The status is the whole point of the fix: a launch that does not start is the caller's problem
   * and must not arrive as 500, or the client cannot separate "your command is wrong" from
   * "the Host is broken" and shows the wrong thing to the user.
   */
  it('answers 400 rather than 500 when the child never starts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-host-service-launch-'))
    directories.push(directory)
    const events = new EventHub()
    const leases = new ControllerLeaseManager()
    const manager = new SessionManager(
      new SessionStore(join(directory, 'host-state.json'), () => undefined),
      events,
      'host-1',
      () => { throw new TerminalLaunchError('could not spawn nonexistent.exe: ENOENT') },
    )
    const leaseId = leases.acquire('controller').controllerLeaseId
    const router = new HostOperationRouter()
    new ServiceSessions(manager, leases, events).registerOperations(router)

    let caught: unknown
    try {
      await router.dispatch('runtime.create', {
        controllerLeaseId: leaseId,
        operationId: 'create-bad-command',
        runtimeSessionId: 'runtime-1',
        launch: ServiceSessionsTest.launch(),
      }, new AbortController().signal)
    } catch (error) { caught = error }

    expect(caught).toBeInstanceOf(HostOperationError)
    expect((caught as HostOperationError).status).toBe(400)
    expect((caught as HostOperationError).message).toMatch(/could not spawn/)
  })

  // Authority is checked when the request arrives AND again when its queued operation starts.
  it('revalidates a queued mutation after controller lease takeover', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-host-service-lease-'))
    directories.push(directory)
    const terminalOptions: { readyBarrier?: Promise<void> } = {}
    const terminals = new FakeTerminalInstances(terminalOptions)
    const events = new EventHub()
    const leases = new ControllerLeaseManager()
    const manager = new SessionManager(
      new SessionStore(join(directory, 'host-state.json'), () => undefined),
      events,
      'host-1',
      terminals.factory,
    )
    await manager.create({
      controllerLeaseId: 'unused-by-manager',
      operationId: 'create-before-queue',
      runtimeSessionId: 'runtime-1',
      launch: ServiceSessionsTest.launch(),
    })
    let releaseReady!: () => void
    terminalOptions.readyBarrier = new Promise<void>((resolve) => {
      releaseReady = resolve
    })
    const leaseA = leases.acquire('controller-a', 1_000)
    const router = new HostOperationRouter()
    new ServiceSessions(manager, leases, events).registerOperations(router)

    const blockingCreate = router.dispatch('runtime.create', {
      controllerLeaseId: leaseA.controllerLeaseId,
      operationId: 'create-blocking',
      runtimeSessionId: 'runtime-2',
      launch: ServiceSessionsTest.launch(),
    }, new AbortController().signal)
    await vi.waitFor(() => expect(terminals.records).toHaveLength(2))
    const staleStop = router.dispatch('runtime.stop', {
      controllerLeaseId: leaseA.controllerLeaseId,
      target: {
        hostInstanceId: 'host-1',
        runtimeSessionId: 'runtime-1',
        generation: 1,
      },
    }, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(1_001)
    leases.acquire('controller-b', 1_000)
    releaseReady()

    await blockingCreate
    await expect(staleStop).rejects.toMatchObject({ status: 409 })
    expect(manager.get('runtime-1')?.alive).toBe(true)
  })
})

class ServiceSessionsTest {
  static async harness(directories: string[]) {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-host-service-'))
    directories.push(directory)
    const events = new EventHub()
    const leases = new ControllerLeaseManager()
    const manager = new SessionManager(
      new SessionStore(join(directory, 'host-state.json'), () => undefined),
      events,
      'host-1',
      new FakeTerminalInstances().factory,
    )
    await manager.create({
      controllerLeaseId: 'unused-by-manager',
      operationId: 'create-service',
      runtimeSessionId: 'runtime-1',
      launch: ServiceSessionsTest.launch(),
    })
    const leaseId = leases.acquire('controller').controllerLeaseId
    const router = new HostOperationRouter()
    new ServiceSessions(manager, leases, events).registerOperations(router)
    return {
      leaseId,
      manager,
      refusal: async (operation: HostOpName, body: Record<string, unknown>) => {
        try {
          await router.dispatch(operation, body, new AbortController().signal)
        } catch (error) {
          return error
        }
        throw new Error(`${operation} was expected to fail`)
      },
    }
  }

  static launch() {
    return {
      command: 'fake',
      args: [],
      cwd: process.cwd(),
      env: {},
      cols: 80,
      rows: 24,
    }
  }
}
