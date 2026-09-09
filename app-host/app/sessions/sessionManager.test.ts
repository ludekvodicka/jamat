import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EventHub } from '../events/eventHub.js'
import { AtomicJsonFile } from '../shared/atomicJsonFile.js'
import type { TerminalInstanceFactory } from '../terminal/terminal.types.js'
import { TerminalLaunchError } from '../terminal/terminalLaunchError.js'
import type { RuntimeCreateReq, RuntimeLaunchSpec } from '../wire/hostWire.js'
import { FakeTerminalInstances } from './fixtures/fakeTerminalInstance.js'
import { SessionError } from './sessionError.js'
import { SessionManager } from './sessionManager.js'
import { SessionStore } from './sessionStore.js'

describe('app-host/app/sessions/sessionManager', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  it('creates, stops, replaces and removes through a structural terminal factory', async () => {
    const harness = SessionManagerTest.harness(directories)
    const created = await harness.manager.create(
      SessionManagerTest.createRequest('create-1'),
    )
    expect(created).toMatchObject({ runtimeSessionId: 'runtime-1', generation: 1, alive: true })

    const stopped = await harness.manager.stop(SessionManagerTest.ref(1))
    expect(stopped.diagnostic).toBe('stopped')
    const replaced = await harness.manager.replace({
      controllerLeaseId: 'lease-1',
      operationId: 'replace-1',
      target: SessionManagerTest.ref(1),
      launch: SessionManagerTest.launch({ A: 'one' }),
    })
    expect(replaced).toMatchObject({ generation: 2, alive: true })

    await harness.manager.stop(SessionManagerTest.ref(2))
    await harness.manager.remove(SessionManagerTest.ref(2))

    expect(harness.manager.get('runtime-1')).toBeUndefined()
    expect(harness.terminals.records).toHaveLength(2)
    expect(harness.terminals.records[0]?.disposed()).toBe(true)
  })

  it('writes the diagnostics document once for one resize', async () => {
    const harness = SessionManagerTest.harness(directories)
    await harness.manager.create(SessionManagerTest.createRequest('create-1'))
    const write = vi.spyOn(AtomicJsonFile, 'write')

    harness.manager.terminalResize(SessionManagerTest.ref(1), 120, 40)

    expect(write).toHaveBeenCalledTimes(1)
    expect(harness.manager.get('runtime-1')).toMatchObject({ cols: 120, rows: 40 })
    write.mockRestore()
  })

  it('replays a create when launch.env differs only in key order', async () => {
    const harness = SessionManagerTest.harness(directories)
    const first = await harness.manager.create({
      ...SessionManagerTest.createRequest('same-operation'),
      launch: SessionManagerTest.launch({ B: 'two', A: 'one' }),
    })
    const replay = await harness.manager.create({
      ...SessionManagerTest.createRequest('same-operation'),
      controllerLeaseId: 'lease-2',
      launch: SessionManagerTest.launch({ A: 'one', B: 'two' }),
    })

    expect(replay).toEqual(first)
    expect(harness.terminals.records).toHaveLength(1)
  })

  it('serializes concurrent retries before consulting the operation ledger', async () => {
    let releaseReady!: () => void
    const readyBarrier = new Promise<void>((resolve) => {
      releaseReady = resolve
    })
    const terminals = new FakeTerminalInstances({ readyBarrier })
    const harness = SessionManagerTest.harness(directories, terminals)
    const request = SessionManagerTest.createRequest('concurrent-create')

    const first = harness.manager.create(request)
    await vi.waitFor(() => expect(terminals.records).toHaveLength(1))
    const retry = harness.manager.create(request)
    await Promise.resolve()
    expect(terminals.records).toHaveLength(1)

    releaseReady()
    await expect(Promise.all([first, retry])).resolves.toEqual([
      expect.objectContaining({ generation: 1 }),
      expect.objectContaining({ generation: 1 }),
    ])
    expect(terminals.records).toHaveLength(1)
  })

  it('rejects an operation ID reused for a different request', async () => {
    const harness = SessionManagerTest.harness(directories)
    await harness.manager.create(SessionManagerTest.createRequest('reused-operation'))

    await expect(harness.manager.create({
      ...SessionManagerTest.createRequest('reused-operation'),
      launch: SessionManagerTest.launch({ A: 'different' }),
    })).rejects.toThrow(/reused for a different request/)
    expect(harness.terminals.records).toHaveLength(1)
  })

  it('rejects every targeted operation for a namesake on another Host', async () => {
    const harness = SessionManagerTest.harness(directories)
    await harness.manager.create(SessionManagerTest.createRequest('create-foreign'))
    const foreign = {
      ...SessionManagerTest.ref(1),
      hostInstanceId: 'host-2',
    }

    await expect(harness.manager.inspect(foreign)).rejects.toThrow(/Expected Host instance/)
    await expect(harness.manager.replace({
      controllerLeaseId: 'lease-1',
      operationId: 'replace-foreign',
      target: foreign,
      launch: SessionManagerTest.launch({}),
    })).rejects.toThrow(/Expected Host instance/)
    await expect(harness.manager.stop(foreign)).rejects.toThrow(/Expected Host instance/)
    await expect(harness.manager.remove(foreign)).rejects.toThrow(/Expected Host instance/)
    expect(harness.manager.get('runtime-1')?.alive).toBe(true)
  })

  it('keeps generation monotonic across remove and cannot mutate the later namesake', async () => {
    const harness = SessionManagerTest.harness(directories)
    await harness.manager.create(SessionManagerTest.createRequest('create-generation-1'))
    await harness.manager.stop(SessionManagerTest.ref(1))
    expect((await harness.manager.remove(SessionManagerTest.ref(1))).diagnostic).toBe('removed')

    const second = await harness.manager.create(
      SessionManagerTest.createRequest('create-generation-2'),
    )
    expect(second.generation).toBe(2)
    expect((await harness.manager.stop(SessionManagerTest.ref(1))).diagnostic)
      .toBe('superseded')
    expect((await harness.manager.remove(SessionManagerTest.ref(1))).diagnostic)
      .toBe('superseded')
    expect(harness.manager.get('runtime-1')).toMatchObject({ generation: 2, alive: true })
  })

  it('replays only while the recorded result remains the current ref', async () => {
    const harness = SessionManagerTest.harness(directories)
    const create = SessionManagerTest.createRequest('create-replay')
    const first = await harness.manager.create(create)
    expect(await harness.manager.create(create)).toEqual(first)
    const replace = {
      controllerLeaseId: 'lease-1',
      operationId: 'replace-replay',
      target: SessionManagerTest.ref(1),
      launch: SessionManagerTest.launch({}),
    }
    const second = await harness.manager.replace(replace)
    expect(await harness.manager.replace(replace)).toEqual(second)

    await expect(harness.manager.create(create)).rejects.toThrow(/no longer current/)
    await harness.manager.stop(SessionManagerTest.ref(2))
    await harness.manager.remove(SessionManagerTest.ref(2))
    await expect(harness.manager.replace(replace)).rejects.toThrow(/no longer current/)
  })

  it('does not acknowledge a stop or replace when the child stays alive', async () => {
    const terminals = new FakeTerminalInstances({ stopLeavesAlive: true })
    const harness = SessionManagerTest.harness(directories, terminals)
    await harness.manager.create(SessionManagerTest.createRequest('create-kill-race'))

    await expect(harness.manager.stop(SessionManagerTest.ref(1)))
      .rejects.toThrow(/did not confirm its death/)
    await expect(harness.manager.replace({
      controllerLeaseId: 'lease-1',
      operationId: 'replace-kill-race',
      target: SessionManagerTest.ref(1),
      launch: SessionManagerTest.launch({}),
    })).rejects.toThrow(/did not confirm its death/)
    expect(harness.manager.get('runtime-1')).toMatchObject({ generation: 1, alive: true })
    expect(terminals.records).toHaveLength(1)
  })

  /**
   * The reversal of what this asserted until 2026-08-19, and the measurement that decided it: a stop
   * asked for at 14:53:23.625 was refused, and the process exited at 14:53:24.974. The reason had
   * been dropped with the refusal, so that exit was filed as one nobody asked for and the row read as
   * a crash. An agent that runs its own shutdown outliving the ladder is the ordinary case here, not
   * the strange one.
   *
   * What it costs is the opposite mistake: a stop that truly failed, whose process then exits an hour
   * later for its own reasons, is filed as stopped. That one is benign - somebody had asked to finish
   * with that session and it is now finished - and it is the smaller of the two.
   */
  it('keeps the stop reason for an exit that lands after an unconfirmed kill', async () => {
    const terminals = new FakeTerminalInstances({ stopLeavesAlive: true })
    const harness = SessionManagerTest.harness(directories, terminals)
    await harness.manager.create(SessionManagerTest.createRequest('create-stop-reason'))

    await expect(harness.manager.stop(SessionManagerTest.ref(1)))
      .rejects.toThrow(/did not confirm its death/)
    terminals.latest().emitExit(7)

    expect(harness.manager.get('runtime-1')).toMatchObject({
      alive: false,
      exitCode: 7,
      exitReason: 'stopped',
    })
  })

  it('revalidates authority when a queued Host-wide stop reaches its effect', async () => {
    const terminalOptions: { readyBarrier?: Promise<void> } = {}
    const terminals = new FakeTerminalInstances(terminalOptions)
    const harness = SessionManagerTest.harness(directories, terminals)
    await harness.manager.create(SessionManagerTest.createRequest('create-before-host-stop'))
    let releaseReady!: () => void
    terminalOptions.readyBarrier = new Promise<void>((resolve) => {
      releaseReady = resolve
    })
    const blockingCreate = harness.manager.create({
      ...SessionManagerTest.createRequest('create-blocking-host-stop'),
      runtimeSessionId: 'runtime-2',
    })
    await vi.waitFor(() => expect(terminals.records).toHaveLength(2))
    let authorized = true
    const staleStop = harness.manager.stopAll(() => {
      if (!authorized)
        throw new Error('controller authority changed')
    })
    authorized = false
    releaseReady()

    await blockingCreate
    await expect(staleStop).rejects.toThrow(/authority changed/)
    expect(harness.manager.list()).toEqual([
      expect.objectContaining({ runtimeSessionId: 'runtime-2', alive: true }),
      expect.objectContaining({ runtimeSessionId: 'runtime-1', alive: true }),
    ])
  })

  it('rejects lifecycle mutations queued after a Host-wide stop', async () => {
    const harness = SessionManagerTest.harness(directories)
    await harness.manager.create(SessionManagerTest.createRequest('create-before-quiesce'))

    const stopping = harness.manager.stopAll()
    const lateCreate = harness.manager.create({
      ...SessionManagerTest.createRequest('create-after-quiesce'),
      runtimeSessionId: 'runtime-2',
    })

    await stopping
    await expect(lateCreate).rejects.toThrow(/Host is stopping/)
    expect(harness.manager.liveCount()).toBe(0)
  })

  /**
   * A child that never starts is the caller's launch spec being wrong, not the Host breaking. Before
   * this was classified, both the spawn and the ready failure escaped as plain Errors and the caller
   * received a 500, unable to tell a bad command from a broken Host.
   */
  it('classifies a failed spawn as an invalid request', async () => {
    const harness = SessionManagerTest.harness(directories, undefined, () => {
      throw new TerminalLaunchError('could not spawn nonexistent.exe: ENOENT')
    })

    const error = await SessionManagerTest.rejection(
      harness.manager.create(SessionManagerTest.createRequest('create-bad-command')),
    )
    expect(error).toBeInstanceOf(SessionError)
    expect((error as SessionError).code).toBe('invalid-request')
    expect((error as SessionError).message).toMatch(/could not spawn/)
  })

  it('classifies a child that never reaches a stable identity as an invalid request', async () => {
    const terminals = new FakeTerminalInstances({
      readyError: new TerminalLaunchError('PTY process did not expose a stable start identity'),
    })
    const harness = SessionManagerTest.harness(directories, terminals)

    const error = await SessionManagerTest.rejection(
      harness.manager.create(SessionManagerTest.createRequest('create-no-identity')),
    )
    expect(error).toBeInstanceOf(SessionError)
    expect((error as SessionError).code).toBe('invalid-request')
    // the half-started runtime must not be left behind in the registry
    expect(harness.manager.get('runtime-1')).toBeUndefined()
  })

  // Only a launch failure is the caller's fault. A defect in this Host has to keep reading as one.
  it('does not blame the caller for a non-launch failure', async () => {
    const terminals = new FakeTerminalInstances({ readyError: new Error('projection exploded') })
    const harness = SessionManagerTest.harness(directories, terminals)

    const error = await SessionManagerTest.rejection(
      harness.manager.create(SessionManagerTest.createRequest('create-internal-defect')),
    )
    expect(error).not.toBeInstanceOf(SessionError)
    expect((error as Error).message).toBe('projection exploded')
  })

  it('rejects malformed and unissued targets before runtime lookup', async () => {
    const harness = SessionManagerTest.harness(directories)
    await harness.manager.create(SessionManagerTest.createRequest('create-target'))

    await expect(harness.manager.stop(undefined as never)).rejects.toThrow(/target is required/)
    await expect(harness.manager.stop({
      ...SessionManagerTest.ref(1),
      generation: 2,
    })).rejects.toThrow(/was not issued/)
    expect(harness.manager.get('runtime-1')?.alive).toBe(true)
  })
})

class SessionManagerTest {
  static harness(
    directories: string[],
    terminals = new FakeTerminalInstances(),
    factory: TerminalInstanceFactory = terminals.factory,
  ) {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-host-manager-'))
    directories.push(directory)
    const manager = new SessionManager(
      new SessionStore(join(directory, 'host-state.json'), () => undefined),
      new EventHub(),
      'host-1',
      factory,
    )
    return { manager, terminals }
  }

  static async rejection(promise: Promise<unknown>): Promise<unknown> {
    try { await promise }
    catch (error) { return error }
    throw new Error('the operation was expected to fail')
  }

  static createRequest(operationId: string): RuntimeCreateReq {
    return {
      controllerLeaseId: 'lease-1',
      operationId,
      runtimeSessionId: 'runtime-1',
      launch: SessionManagerTest.launch({ A: 'one' }),
    }
  }

  static ref(generation: number) {
    return {
      hostInstanceId: 'host-1',
      runtimeSessionId: 'runtime-1',
      generation,
    }
  }

  static launch(env: Record<string, string>): RuntimeLaunchSpec {
    return {
      command: 'fake',
      args: [],
      cwd: process.cwd(),
      env,
      cols: 80,
      rows: 24,
    }
  }
}
