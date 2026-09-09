import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  HostWsClientMsg,
  HostWsServerMsg,
  RuntimeRef,
} from '../../app-host/app/wire/hostWire.js'
import { FakeHost } from './fixtures/fakeHost'
import { TerminalAttachSocket } from './terminalAttachSocket'

describe('lib-orchestrator/hostClient/terminalAttachSocket', () => {
  const hosts: FakeHost[] = []
  const sockets: TerminalAttachSocket[] = []

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close()
    for (const host of hosts.splice(0)) await host.stop()
  })

  const targetConst: RuntimeRef = {
    hostInstanceId: 'fake-host',
    runtimeSessionId: 'session-1',
    generation: 1,
  }

  const attachFrameConst: HostWsClientMsg = {
    type: 'terminal.attach',
    target: targetConst,
    role: 'interactive',
    cols: 120,
    rows: 40,
  }

  async function startHost(): Promise<FakeHost> {
    const host = await FakeHost.start()
    hosts.push(host)
    return host
  }

  interface Harness {
    socket: TerminalAttachSocket
    frames: HostWsServerMsg[]
    closes: string[]
  }

  function harness(onFrame?: (frame: HostWsServerMsg) => void): Harness {
    const state = {
      socket: null as unknown as TerminalAttachSocket,
      frames: [] as HostWsServerMsg[],
      closes: [] as string[],
    }
    state.socket = new TerminalAttachSocket({
      onFrame: (frame) => {
        state.frames.push(frame)
        onFrame?.(frame)
      },
      onClosed: (detail) => state.closes.push(detail),
    })
    sockets.push(state.socket)
    return state
  }

  function snapshotFrame(outputSeq: number): HostWsServerMsg {
    return {
      type: 'terminal.snapshot',
      projection: {
        runtimeSessionId: targetConst.runtimeSessionId,
        generation: targetConst.generation,
        outputEpoch: 1,
        outputSeq,
        raw: 'prompt> ',
        screen: 'prompt> ',
        cols: 120,
        rows: 40,
        alive: true,
        lastOutputAt: null,
      },
    }
  }

  function dataFrame(delta: string, outputSeq: number): HostWsServerMsg {
    return {
      type: 'terminal.data',
      runtimeSessionId: targetConst.runtimeSessionId,
      generation: targetConst.generation,
      outputEpoch: 1,
      delta,
      outputSeq,
      lastOutputAt: 2,
    }
  }

  // The attach frame is written before the socket has opened, which is the only moment it can be
  // written at: it carries the geometry, and a frame sent to a CONNECTING socket is lost silently.
  it('sends what the caller wrote before the socket opened, and reads the answer', async () => {
    const host = await startHost()
    const context = harness()
    context.socket.connect(host.descriptor())
    context.socket.send(attachFrameConst)

    await vi.waitFor(() => expect(context.frames).toHaveLength(1), { timeout: 2_000 })
    expect(host.terminalFrames).toEqual([attachFrameConst])
    expect(context.frames[0]).toMatchObject({
      type: 'terminal.attached',
      session: { runtimeSessionId: 'session-1', cols: 120, rows: 40 },
    })
    expect(context.closes).toEqual([])
  })

  it('keeps the order the Host wrote in', async () => {
    const host = await startHost()
    const context = harness()
    context.socket.connect(host.descriptor())
    context.socket.send(attachFrameConst)
    await vi.waitFor(() => expect(host.attachedCount()).toBe(1), { timeout: 2_000 })

    host.pushTerminal(snapshotFrame(8))
    host.pushTerminal(dataFrame('a', 9))
    host.pushTerminal(dataFrame('b', 10))

    await vi.waitFor(() => expect(context.frames).toHaveLength(4), { timeout: 2_000 })
    expect(context.frames.map((frame) => frame.type)).toEqual([
      'terminal.attached',
      'terminal.snapshot',
      'terminal.data',
      'terminal.data',
    ])
    expect(context.frames[3]).toMatchObject({ delta: 'b', outputSeq: 10 })
  })

  it('carries input and resize on to the Host once open', async () => {
    const host = await startHost()
    const context = harness()
    context.socket.connect(host.descriptor())
    context.socket.send(attachFrameConst)
    await vi.waitFor(() => expect(host.attachedCount()).toBe(1), { timeout: 2_000 })

    context.socket.send({ type: 'terminal.input', data: 'echo hello\r' })
    context.socket.send({ type: 'terminal.resize', cols: 100, rows: 30 })

    await vi.waitFor(() => expect(host.terminalFrames).toHaveLength(3), { timeout: 2_000 })
    expect(host.terminalFrames[1]).toEqual({ type: 'terminal.input', data: 'echo hello\r' })
    expect(host.terminalFrames[2]).toEqual({ type: 'terminal.resize', cols: 100, rows: 30 })
  })

  // Reconnecting is the attachment's policy, not this socket's: it holds the cursor that decides
  // whether the next attach asks for a delta or for a snapshot, and this class holds no cursor.
  it('reports a dropped socket once and never reconnects on its own', async () => {
    const host = await startHost()
    const context = harness()
    context.socket.connect(host.descriptor())
    context.socket.send(attachFrameConst)
    await vi.waitFor(() => expect(host.attachedCount()).toBe(1), { timeout: 2_000 })

    host.dropSockets()
    await vi.waitFor(() => expect(context.closes).toHaveLength(1), { timeout: 2_000 })
    expect(context.closes[0]).toContain('attach socket')

    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(context.closes).toHaveLength(1)
    expect(host.terminalFrames).toHaveLength(1)
    expect(host.attachedCount()).toBe(0)
  })

  it('ends the attach on an unreadable frame instead of taking the process down', async () => {
    const host = await startHost()
    const context = harness()
    context.socket.connect(host.descriptor())
    context.socket.send(attachFrameConst)
    await vi.waitFor(() => expect(host.attachedCount()).toBe(1), { timeout: 2_000 })

    host.pushUnreadable()
    await vi.waitFor(() => expect(context.closes).toHaveLength(1), { timeout: 2_000 })
    expect(context.closes[0]).toContain('unreadable')
    expect(context.frames).toHaveLength(1)
  })

  // The frame handler is where the exhaustive branching lives, so a frame belonging to no attach
  // arrives here as a throw. It runs on the socket's emitter, where an escaping throw would take the
  // whole client down.
  it('ends the attach when the frame handler throws', async () => {
    const host = await startHost()
    const context = harness((frame) => {
      if (frame.type !== 'terminal.attached') throw new Error('frame belongs to no attach')
    })
    context.socket.connect(host.descriptor())
    context.socket.send(attachFrameConst)
    await vi.waitFor(() => expect(host.attachedCount()).toBe(1), { timeout: 2_000 })

    host.pushTerminal({ type: 'events.subscribed', throughRevision: 0, replay: [], truncated: false })
    await vi.waitFor(() => expect(context.closes).toHaveLength(1), { timeout: 2_000 })
    expect(context.closes[0]).toContain('could not be handled')
  })

  it('closes silently, twice over, and swallows a write to what is gone', async () => {
    const host = await startHost()
    const context = harness()
    context.socket.connect(host.descriptor())
    context.socket.send(attachFrameConst)
    await vi.waitFor(() => expect(host.attachedCount()).toBe(1), { timeout: 2_000 })

    context.socket.close()
    context.socket.close()
    expect(() => context.socket.send({ type: 'terminal.input', data: 'x' })).not.toThrow()

    await vi.waitFor(() => expect(host.attachedCount()).toBe(0), { timeout: 2_000 })
    // Nobody is told about their own decision, and the write after it reached no wire.
    expect(context.closes).toEqual([])
    expect(host.terminalFrames).toHaveLength(1)
  })

  it('replaces an attach when reconnected, without reporting the old one', async () => {
    const host = await startHost()
    const context = harness()
    context.socket.connect(host.descriptor())
    context.socket.send(attachFrameConst)
    await vi.waitFor(() => expect(host.attachedCount()).toBe(1), { timeout: 2_000 })

    context.socket.connect(host.descriptor())
    context.socket.send({ ...attachFrameConst, outputEpoch: 1, sinceSeq: 42 })

    await vi.waitFor(() => expect(host.terminalFrames).toHaveLength(2), { timeout: 2_000 })
    expect(host.terminalFrames[1]).toMatchObject({ sinceSeq: 42 })
    expect(context.closes).toEqual([])
  })
})
