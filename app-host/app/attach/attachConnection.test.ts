import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ControllerLeaseManager } from '../controller/controllerLeaseManager.js'
import { EventHub } from '../events/eventHub.js'
import {
  FakeTerminalInstances,
  type FakeTerminalInstanceOptions,
} from '../sessions/fixtures/fakeTerminalInstance.js'
import { SessionManager } from '../sessions/sessionManager.js'
import { SessionStore } from '../sessions/sessionStore.js'
import type { HostWsServerMsg, RuntimeRef } from '../wire/hostWire.js'
import { AttachConnection, type AttachSocket } from './attachConnection.js'

describe('app-host/app/attach/attachConnection', () => {
  const directories: string[] = []

  afterEach(() => {
    vi.useRealTimers()
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  it('revalidates the controller lease before every writer frame', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = await AttachConnectionTest.harness(directories)
    const lease = harness.leases.acquire('controller-a', 1_000)
    await harness.send({
      type: 'terminal.attach',
      target: harness.target,
      role: 'interactive',
      controllerLeaseId: lease.controllerLeaseId,
    })
    await vi.advanceTimersByTimeAsync(1_001)

    await harness.send({ type: 'terminal.input', data: 'blocked' })

    expect(harness.terminals.latest().writes).toEqual([])
    expect(harness.frames()).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'not-writer',
    }))
    expect(harness.leases.acquire('controller-b', 1_000).controllerId)
      .toBe('controller-b')
  })

  /*
   * The ack goes out before the screen does, so a projection that cannot answer leaves the client
   * holding an attach the Host has already dropped. Every frame after it is answered `bad-request:
   * not attached`, which a client reads as one bad frame rather than as the end of an attach - so
   * it kept typing into a socket nobody was listening on, reporting each keystroke as sent, for as
   * long as the panel stayed open. One socket is one attach, so the socket ends with it and the
   * client's own reconnect ladder asks again.
   */
  it('ends the socket when the attach cannot be served after its ack', async () => {
    const harness = await AttachConnectionTest.harness(directories, {
      snapshotError: new Error('the projection is busy'),
    })
    const lease = harness.leases.acquire('controller-a')

    await harness.send({
      type: 'terminal.attach',
      target: harness.target,
      role: 'interactive',
      controllerLeaseId: lease.controllerLeaseId,
    })

    expect(harness.frames()).toContainEqual(expect.objectContaining({
      type: 'terminal.attached',
      writer: true,
    }))
    expect(harness.frames()).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'bad-request',
    }))
    expect(harness.closed()).toBe(1)
    // What the close is for: the attach really is gone, and nothing typed into it arrives.
    await harness.send({ type: 'terminal.input', data: 'lost' })
    expect(harness.terminals.latest().writes).toEqual([])
  })

  it('does not deliver a later generation or write through the stale attach', async () => {
    const harness = await AttachConnectionTest.harness(directories)
    const lease = harness.leases.acquire('controller-a')
    await harness.send({
      type: 'terminal.attach',
      target: harness.target,
      role: 'interactive',
      controllerLeaseId: lease.controllerLeaseId,
    })
    await harness.manager.replace({
      controllerLeaseId: lease.controllerLeaseId,
      operationId: 'replace-attached',
      target: harness.target,
      launch: AttachConnectionTest.launch(),
    })
    const framesBeforeNewData = harness.frames().length
    harness.terminals.latest().emitData('new-generation')
    await harness.send({ type: 'terminal.input', data: 'stale-write' })

    const later = harness.frames().slice(framesBeforeNewData)
    expect(later.some((frame) =>
      frame.type === 'terminal.data' && frame.generation === 2)).toBe(false)
    expect(harness.terminals.latest().writes).toEqual([])
    expect(harness.frames()).toContainEqual(expect.objectContaining({
      type: 'terminal.exit',
      generation: 1,
    }))
  })

  /**
   * The two rejections must not share a code. A malformed frame is the caller's bug; a foreign or
   * superseded ref is a race the caller recovers from by resolving a fresh ref and re-attaching, and it
   * can only do that if the code tells the two apart. HTTP has always separated 400 from 409.
   */
  it('separates a malformed attach target from a foreign one before lookup', async () => {
    const harness = await AttachConnectionTest.harness(directories)
    await harness.send({
      type: 'terminal.attach',
      target: {
        hostInstanceId: 'host-1',
        runtimeSessionId: 'runtime-1',
      },
      role: 'observer',
    })
    await harness.send({
      type: 'terminal.attach',
      target: { ...harness.target, hostInstanceId: 'host-2' },
      role: 'observer',
    })
    await harness.send({
      type: 'terminal.attach',
      target: { ...harness.target, generation: harness.target.generation + 1 },
      role: 'observer',
    })

    expect(harness.frames().filter((frame) => frame.type === 'error'))
      .toEqual([
        expect.objectContaining({ type: 'error', code: 'bad-request' }),
        expect.objectContaining({ type: 'error', code: 'conflict' }),
        expect.objectContaining({ type: 'error', code: 'conflict' }),
      ])
  })

  /**
   * Past the ack the connection is subscribed and buffering. A throw there used to leave it
   * half-attached: the client had seen `terminal.attached`, and every later event of that generation,
   * `terminal.exit` included, was buffered forever instead of delivered.
   */
  it('detaches when the attach phase fails after the ack', async () => {
    const harness = await AttachConnectionTest.harness(directories)
    vi.spyOn(harness.manager, 'terminalSnapshot').mockRejectedValueOnce(
      new Error('projection disposed mid-attach'),
    )

    await harness.send({
      type: 'terminal.attach',
      target: harness.target,
      role: 'observer',
    })

    const frames = harness.frames()
    expect(frames.some((frame) => frame.type === 'terminal.attached')).toBe(true)
    expect(frames.filter((frame) => frame.type === 'error'))
      .toEqual([expect.objectContaining({ type: 'error', code: 'bad-request' })])

    // The assertion has to distinguish "detached" from "still attached and buffering", because in BOTH
    // cases no terminal.data reaches the client: a half-attached connection swallows it into the buffer.
    // `requireWriter` reports the two states differently, so an input frame is the observable difference:
    // detached answers `not attached`, half-attached would answer `read-only attach`.
    await harness.send({ type: 'terminal.input', data: 'after the failure' })
    expect(harness.frames().at(-1)).toEqual(expect.objectContaining({
      type: 'error',
      code: 'bad-request',
      message: 'not attached',
    }))
  })

  // The exit branch detaches, and detaching drops a pending marker together with its flush timer.
  it('says the tail is missing before it says the runtime exited', async () => {
    const harness = await AttachConnectionTest.harness(directories)
    const lease = harness.leases.acquire('controller-a')
    await harness.send({
      type: 'terminal.attach',
      target: harness.target,
      role: 'interactive',
      controllerLeaseId: lease.controllerLeaseId,
    })

    harness.socket.bufferedAmount = 2 * 1024 * 1024
    harness.terminals.latest().emitData('tail-the-client-never-sees')
    harness.terminals.latest().emitExit(0)

    const types = harness.frames().map((frame) => frame.type)
    expect(types).toContain('terminal.stream-truncated')
    expect(types.indexOf('terminal.stream-truncated'))
      .toBeLessThan(types.indexOf('terminal.exit'))
    expect(types).not.toContain('terminal.data')
  })

  it('does not treat an unknown attach role as an interactive writer', async () => {
    const harness = await AttachConnectionTest.harness(directories)
    const lease = harness.leases.acquire('controller-a')

    await harness.send({
      type: 'terminal.attach',
      target: harness.target,
      role: 'writer',
      controllerLeaseId: lease.controllerLeaseId,
    })
    await harness.send({ type: 'terminal.input', data: 'must-not-write' })

    expect(harness.frames()).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'bad-request',
    }))
    expect(harness.terminals.latest().writes).toEqual([])
  })
})

class AttachConnectionTest {
  static async harness(directories: string[], terminalOptions: FakeTerminalInstanceOptions = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-host-attach-'))
    directories.push(directory)
    const sent: string[] = []
    let closed = 0
    const socket = {
      bufferedAmount: 0,
      readyState: WebSocket.OPEN,
      send: (data: string) => { sent.push(data) },
      close: () => { closed += 1 },
    } satisfies AttachSocket
    const events = new EventHub()
    const leases = new ControllerLeaseManager()
    const terminals = new FakeTerminalInstances(terminalOptions)
    const manager = new SessionManager(
      new SessionStore(join(directory, 'host-state.json'), () => undefined),
      events,
      'host-1',
      terminals.factory,
    )
    const session = await manager.create({
      controllerLeaseId: 'unused-by-manager',
      operationId: 'create-attach',
      runtimeSessionId: 'runtime-1',
      launch: AttachConnectionTest.launch(),
    })
    const target: RuntimeRef = {
      hostInstanceId: 'host-1',
      runtimeSessionId: session.runtimeSessionId,
      generation: session.generation,
    }
    const connection = new AttachConnection(
      socket,
      manager,
      leases,
      events,
    )
    return {
      leases,
      manager,
      socket,
      target,
      terminals,
      closed: () => closed,
      frames: () => sent.map((value) => JSON.parse(value) as HostWsServerMsg),
      send: (value: unknown) => connection.onMessage(
        Buffer.from(JSON.stringify(value)),
      ),
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
