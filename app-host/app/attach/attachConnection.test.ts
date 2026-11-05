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

  it('keeps streamed output, resize and exit behind final consumption while input remains live', async () => {
    const h = await AttachConnectionTest.harness(directories)
    const lease = h.leases.acquire('stream-writer')
    await h.send({ type: 'terminal.attach', target: h.target, snapshotStreamId: 'stream', role: 'interactive', controllerLeaseId: lease.controllerLeaseId })
    expect(h.frames().map(frame => frame.type)).toEqual(['terminal.attached'])
    await h.send({ type: 'terminal.input', data: 'initial' })
    await h.send({ type: 'terminal.snapshot-next', streamId: 'stream', index: 0 })
    await h.send({ type: 'terminal.input', data: 'during' })
    h.terminals.latest().emitData('live')
    h.manager.terminalResize(h.target, 101, 31)
    h.terminals.latest().emitExit(7)
    await h.send({ type: 'terminal.snapshot-next', streamId: 'stream', index: 1 })
    await h.send({ type: 'terminal.snapshot-next', streamId: 'stream', index: 2 })
    expect(h.frames().map(frame => frame.type)).toEqual(['terminal.attached', 'terminal.snapshot-start', 'terminal.snapshot-chunk', 'terminal.snapshot-end'])
    expect(h.terminals.latest().writes).toEqual(['initial', 'during'])
    await h.send({ type: 'terminal.snapshot-next', streamId: 'stream', index: 3 })
    expect(h.frames().slice(-4).map(frame => frame.type)).toEqual(['terminal.data', 'terminal.resize', 'terminal.snapshot-complete', 'terminal.exit'])
  })

  it('resnapshots a resize-triggered live-buffer overflow instead of silently losing output or geometry', async () => {
    const h = await AttachConnectionTest.harness(directories)
    await h.send({ type: 'terminal.attach', target: h.target, snapshotStreamId: 'stream', role: 'observer' })
    await h.send({ type: 'terminal.snapshot-next', streamId: 'stream', index: 0 })
    h.terminals.latest().emitData('x'.repeat(1_048_400))
    h.manager.terminalResize(h.target, 101, 31)
    h.manager.terminalResize(h.target, 102, 32)
    h.terminals.latest().emitExit(3)
    await h.send({ type: 'terminal.snapshot-next', streamId: 'stream', index: 1 })
    expect(h.frames().at(-1)?.type).toBe('terminal.snapshot-end')
    await h.send({ type: 'terminal.snapshot-next', streamId: 'stream', index: 2 })
    expect(h.frames().slice(-3).map(frame => frame.type)).toEqual(['terminal.stream-truncated', 'terminal.snapshot-complete', 'terminal.exit'])
    expect(h.frames().filter(frame => frame.type === 'terminal.data')).toEqual([])
  })

  it('never sends or closes a replacement after an old snapshot promise resolves or rejects', async () => {
    const h = await AttachConnectionTest.harness(directories)
    const original = h.manager.terminalSnapshot.bind(h.manager)
    const snapshot = await original(h.target)
    let resolve!: (value: typeof snapshot) => void
    vi.spyOn(h.manager, 'terminalSnapshot').mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = h.send({ type: 'terminal.attach', target: h.target, role: 'observer' })
    await h.send({ type: 'terminal.attach', target: h.target, role: 'observer', snapshotStreamId: 'new' })
    const before = h.frames().length
    resolve(snapshot)
    await pending
    expect(h.frames()).toHaveLength(before)
    expect(h.closed()).toBe(0)
    await h.send({ type: 'terminal.snapshot-next', streamId: 'old', index: 0 })
    expect(h.frames()).toHaveLength(before)
    await h.send({ type: 'terminal.snapshot-next', streamId: 'new', index: 0 })
    expect(h.frames().at(-1)?.type).toBe('terminal.snapshot-start')
  })

  it('streams valid replay without reset and uses a full snapshot for a truncated epoch', async () => {
    const h = await AttachConnectionTest.harness(directories)
    const delta = vi.spyOn(h.manager, 'terminalDelta')
    delta.mockReturnValueOnce({ data: 'replay', outputSeq: 20, outputEpoch: 1, truncated: false })
    await h.send({ type: 'terminal.attach', target: h.target, role: 'observer', snapshotStreamId: 'replay', outputEpoch: 1, sinceSeq: 5 })
    await h.send({ type: 'terminal.snapshot-next', streamId: 'replay', index: 0 })
    expect(h.frames().at(-1)).toMatchObject({ type: 'terminal.snapshot-start', reset: false, projection: { outputSeq: 20 } })
    delta.mockReturnValueOnce({ data: 'lost-ring', outputSeq: 40, outputEpoch: 2, truncated: true })
    await h.send({ type: 'terminal.attach', target: h.target, role: 'observer', snapshotStreamId: 'reset', outputEpoch: 1, sinceSeq: 5 })
    await h.send({ type: 'terminal.snapshot-next', streamId: 'reset', index: 0 })
    expect(h.frames().at(-1)).toMatchObject({ type: 'terminal.snapshot-start', reset: true })
  })

  it('drops only geometry and data covered by the exact capture tick, retaining later resize and exit', async () => {
    const h = await AttachConnectionTest.harness(directories)
    const original = h.manager.terminalSnapshot.bind(h.manager)
    let capture!: () => Promise<void>
    vi.spyOn(h.manager, 'terminalSnapshot').mockImplementationOnce((ref, onCaptured) => new Promise(resolve => {
      capture = async () => resolve(await original(ref, onCaptured))
    }))
    await h.send({ type: 'terminal.attach', target: h.target, role: 'observer', snapshotStreamId: 'capture' })
    const starting = h.send({ type: 'terminal.snapshot-next', streamId: 'capture', index: 0 })
    h.terminals.latest().emitData('covered')
    h.manager.terminalResize(h.target, 101, 31)
    await capture(); await starting
    expect(h.frames().at(-1)).toMatchObject({ type: 'terminal.snapshot-start', projection: { cols: 101, rows: 31 } })
    h.manager.terminalResize(h.target, 102, 32)
    h.terminals.latest().emitExit(9)
    await h.send({ type: 'terminal.snapshot-next', streamId: 'capture', index: 1 })
    await h.send({ type: 'terminal.snapshot-next', streamId: 'capture', index: 2 })
    expect(h.frames().filter(frame => frame.type === 'terminal.resize')).toEqual([
      { type: 'terminal.resize', runtimeSessionId: h.target.runtimeSessionId, generation: 1, cols: 102, rows: 32 },
    ])
    expect(h.frames().filter(frame => frame.type === 'terminal.data')).toEqual([])
    expect(h.frames().at(-1)).toMatchObject({ type: 'terminal.exit', exitCode: 9 })
  })

  it('ignores a stale capture callback without clearing replacement output', async () => {
    const h = await AttachConnectionTest.harness(directories)
    const original = h.manager.terminalSnapshot.bind(h.manager)
    const projection = await original(h.target)
    let captured!: () => void, finish!: (value: typeof projection) => void
    vi.spyOn(h.manager, 'terminalSnapshot').mockImplementationOnce((_ref, onCaptured) => new Promise(resolve => {
      captured = onCaptured!; finish = resolve
    }))
    await h.send({ type: 'terminal.attach', target: h.target, role: 'observer', snapshotStreamId: 'old' })
    const old = h.send({ type: 'terminal.snapshot-next', streamId: 'old', index: 0 })
    await h.send({ type: 'terminal.attach', target: h.target, role: 'observer', snapshotStreamId: 'new' })
    await h.send({ type: 'terminal.snapshot-next', streamId: 'new', index: 0 })
    h.terminals.latest().emitData('replacement output')
    captured(); finish(projection); await old
    await h.send({ type: 'terminal.snapshot-next', streamId: 'new', index: 1 })
    await h.send({ type: 'terminal.snapshot-next', streamId: 'new', index: 2 })
    expect(h.frames().filter(frame => frame.type === 'terminal.data')).toEqual([
      expect.objectContaining({ delta: 'replacement output' }),
    ])
    expect(h.closed()).toBe(0)
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
      stopDescendants: false,
      command: 'fake',
      args: [],
      cwd: process.cwd(),
      env: {},
      cols: 80,
      rows: 24,
    }
  }
}
