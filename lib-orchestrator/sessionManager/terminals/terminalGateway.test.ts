import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  HostDescriptor,
  HostWsClientMsg,
  HostWsServerMsg,
  RuntimeRef,
} from '../../../app-host/app/wire/hostWire.js'
import type { TerminalAttachSocketDeps } from '../../hostClient/terminalAttachSocket'
import type { TerminalFrame } from '../sessionManagerApi.types'
import type { TerminalSocket } from './terminalAttachment'
import type { TerminalRefResolution } from './terminalPort'
import { TerminalGateway } from './terminalGateway'

/** The socket the attachment would have opened, with the wire replaced by two arrays. */
class FakeSocket implements TerminalSocket {
  readonly sent: HostWsClientMsg[] = []
  connectedTo: HostDescriptor | null = null
  closed = false

  constructor(private readonly deps: TerminalAttachSocketDeps) {}

  connect(descriptor: HostDescriptor): void {
    this.connectedTo = descriptor
  }

  send(message: HostWsClientMsg): void {
    this.sent.push(message)
  }

  close(): void {
    this.closed = true
  }

  /** What the Host would have said. */
  serve(frame: HostWsServerMsg): void {
    this.deps.onFrame(frame)
  }

  drop(detail = 'the Host closed the attach socket'): void {
    this.deps.onClosed(detail)
  }

  attachFrame(): Extract<HostWsClientMsg, { type: 'terminal.attach' }> {
    const frame = this.sent[0]
    if (frame?.type !== 'terminal.attach') throw new Error('the first frame was not an attach')
    return frame
  }
}

describe('lib-orchestrator/sessionManager/terminals/terminalGateway', () => {
  const descriptorConst = { hostInstanceId: 'host-1', port: 1, token: 't' } as unknown as HostDescriptor
  const refConst: RuntimeRef = {
    hostInstanceId: 'host-1',
    runtimeSessionId: 'session-1',
    generation: 3,
  }

  interface World {
    gateway: TerminalGateway
    sockets: FakeSocket[]
    frames: { attachId: string; frame: TerminalFrame }[]
    errors: string[]
    userInput: string[]
    userMarks: { sessionId: string; at: number }[]
    hints: ReadonlyMap<string, number>
    descriptor: HostDescriptor | null
    leaseId: string | null
    resolution: TerminalRefResolution
  }

  const published = new Set<string>()
  let world: World
  afterEach(() => { world.gateway.closeAll(); vi.useRealTimers() })

  beforeEach(() => {
    const state: World = {
      gateway: null as unknown as TerminalGateway,
      sockets: [],
      frames: [],
      errors: [],
      userInput: [],
      userMarks: [],
      hints: new Map(),
      descriptor: descriptorConst,
      leaseId: 'lease-1',
      resolution: { ok: true, ref: refConst, alive: true },
    }
    state.gateway = new TerminalGateway({
      descriptorOf: () => state.descriptor,
      leaseIdOf: () => state.leaseId,
      onError: (message) => state.errors.push(message),
      activity: { userInput: marks => { state.userInput.push(...marks.map(mark => mark.sessionId)); state.userMarks.push(...marks) }, pendingInputHint: counts => { state.hints = counts } },
      socketFactory: (deps) => {
        const socket = new FakeSocket(deps)
        state.sockets.push(socket)
        return socket
      },
    })
    let resolution = state.resolution
    Object.defineProperty(state, 'resolution', {
      get: () => resolution,
      set: (value: TerminalRefResolution) => {
        resolution = value
        void state.gateway.publishRefs([...published].map(sessionId => ({ sessionId, resolution })))
      },
    })
    published.clear()
    world = state
  })

  function latest(): FakeSocket {
    const socket = world.sockets.at(-1)
    if (!socket) throw new Error('no socket was opened')
    return socket
  }

  /** What was typed at a socket, in order, with everything else it was told left out. */
  function inputsOf(socket: FakeSocket): string[] {
    return socket.sent.flatMap((frame) => frame.type === 'terminal.input' ? [frame.data] : [])
  }

  it('queues writer input while held and refuses observers without acknowledging their input', async () => {
    await attach('writer', { sessionId: 'worker', size: null })
    const socket = latest()
    socket.serve(attached())
    const { release } = await world.gateway.inhibit('worker')
    const queued = world.gateway.input('writer', 'queued\r')
    expect(inputsOf(socket)).toEqual([])
    expect((await world.gateway.pendingInput('worker'))).toBe(1)
    release()
    release()
    expect(await queued).toEqual({ kind: 'sent' })
    expect(inputsOf(socket)).toEqual(['queued\r'])
    expect((await world.gateway.pendingInput('worker'))).toBe(0)
    await attach('observer', { sessionId: 'worker', size: null })
    latest().serve(attached(false))
    const { release: releaseObserver } = await world.gateway.inhibit('worker')
    expect((await world.gateway.input('observer', 'lost'))).toEqual({ kind: 'not-writer' })
    expect((await world.gateway.pendingInput('worker'))).toBe(0)
    releaseObserver()
  })

  it('never replays queued input into a reused attach ID and reports its refusal', async () => {
    await attach('same-id', { sessionId: 'worker', size: null })
    latest().serve(attached())
    const { release } = await world.gateway.inhibit('worker')
    const queued = world.gateway.input('same-id', 'old-worker-command')
    world.gateway.detach('same-id')
    expect(await queued).toEqual({ kind: 'unknown-attach' })
    await attach('same-id', { sessionId: 'other-session', size: null })
    const other = latest()
    other.serve(attached())
    release()
    expect(inputsOf(other)).toEqual([])
    expect(world.errors).toEqual([expect.stringContaining('attachment changed')])
  })

  it('replays local and automation input only after both inhibits release', async () => {
    await attach('person', { sessionId: 'worker', size: null })
    const person = latest()
    person.serve(attached())
    await attach('automation', { sessionId: 'worker', size: null }, 'remote')
    const automation = latest()
    automation.serve(attached())
    const first = await world.gateway.inhibit('worker')
    const second = await world.gateway.inhibit('worker')
    const firstInput = world.gateway.input('person', 'first')
    const secondInput = world.gateway.input('automation', 'second')
    first.release()
    first.release()
    expect(inputsOf(person)).toEqual([])
    expect(inputsOf(automation)).toEqual([])
    expect((await world.gateway.pendingInput('worker'))).toBe(2)
    second.release()
    second.release()
    expect(await firstInput).toEqual({ kind: 'sent' })
    expect(await secondInput).toEqual({ kind: 'sent' })
    expect(inputsOf(person)).toEqual(['first'])
    expect(inputsOf(automation)).toEqual(['second'])
    expect((await world.gateway.pendingInput('worker'))).toBe(0)
  })

  it.each([
    ['detach', 'unknown-attach'], ['replace', 'unknown-attach'], ['exit', 'unknown-attach'],
    ['disconnect', 'not-writer'], ['read-only', 'not-writer'], ['close', 'unknown-attach'],
  ] as const)('settles queued input promptly on %s and never replays it', async (stop, kind) => {
    await attach('cancelled', { sessionId: 'worker', size: null })
    const socket = latest()
    socket.serve(attached())
    const held = await world.gateway.inhibit('worker')
    const queued = world.gateway.input('cancelled', 'must not arrive')
    expect(await world.gateway.pendingInput('worker')).toBe(1)
    if (stop === 'detach') world.gateway.detach('cancelled')
    else if (stop === 'replace') await attach('cancelled', { sessionId: 'worker', size: null })
    else if (stop === 'exit') socket.serve({ type: 'terminal.exit', runtimeSessionId: 'session-1', generation: 3, exitCode: 0 })
    else if (stop === 'disconnect') socket.drop()
    else if (stop === 'read-only') socket.serve({ type: 'error', code: 'not-writer', message: 'writer lost' })
    else if (stop === 'close') world.gateway.closeAll()
    else throw new Error(`Unknown stop: ${stop satisfies never}`)
    expect(await queued).toEqual({ kind })
    expect(await world.gateway.pendingInput('worker')).toBe(0)
    held.release()
    expect(world.sockets.flatMap(inputsOf)).toEqual([])
    expect(world.userMarks).toEqual([])
    expect(world.errors).toHaveLength(1)
  })

  it('preserves remaining FIFO entries when a queued attachment is cancelled', async () => {
    await attach('cancelled', { sessionId: 'worker', size: null })
    latest().serve(attached())
    await attach('writer', { sessionId: 'worker', size: null })
    const socket = latest()
    socket.serve(attached())
    const held = await world.gateway.inhibit('worker')
    const first = world.gateway.input('writer', 'first')
    const cancelled = world.gateway.input('cancelled', 'discarded')
    const last = world.gateway.input('writer', 'last')
    world.gateway.detach('cancelled')
    expect(await cancelled).toEqual({ kind: 'unknown-attach' })
    expect(await world.gateway.pendingInput('worker')).toBe(2)
    held.release()
    expect(await first).toEqual({ kind: 'sent' })
    expect(await last).toEqual({ kind: 'sent' })
    expect(inputsOf(socket)).toEqual(['first', 'last'])
  })

  it('rejects a failed queued write and settles later input without retaining work', async () => {
    await attach('writer', { sessionId: 'worker', size: null })
    const socket = latest()
    socket.serve(attached())
    const held = await world.gateway.inhibit('worker')
    const first = world.gateway.input('writer', 'failed')
    const last = world.gateway.input('writer', 'last')
    vi.spyOn(socket, 'send').mockImplementationOnce(() => { throw new Error('socket failed') })
    const failed = expect(first).rejects.toThrow('socket failed')
    held.release()
    await failed
    expect(await last).toEqual({ kind: 'sent' })
    expect(inputsOf(socket)).toEqual(['last'])
    expect(await world.gateway.pendingInput('worker')).toBe(0)
  })

  it('waits for inhibits before granting a transaction and waits for end before inhibiting', async () => {
    await attach('take', { sessionId: 'worker', size: null })
    const socket = latest()
    socket.serve(attached())
    const held = await world.gateway.inhibit('worker')
    let acquired = false
    const waiting = world.gateway.transaction('take').then(value => { acquired = true; return value })
    await Promise.resolve()
    expect(acquired).toBe(false)
    held.release()
    const transaction = await waiting
    if ('refused' in transaction) throw new Error(transaction.refused)
    expect(await world.gateway.transaction('take')).toEqual({ refused: 'busy' })
    let inhibited = false
    const next = world.gateway.inhibit('worker').then(value => { inhibited = true; return value })
    const queued = world.gateway.input('take', 'queued')
    expect(await transaction.write('erase')).toEqual({ kind: 'sent' })
    expect(inputsOf(socket)).toEqual(['erase'])
    expect(inhibited).toBe(false)
    transaction.end()
    transaction.end()
    const inhibit = await next
    expect(inputsOf(socket)).toEqual(['erase'])
    inhibit.release()
    expect(await queued).toEqual({ kind: 'sent' })
    expect(inputsOf(socket)).toEqual(['erase', 'queued'])
  })

  it('refuses a transaction until the reopened connection acknowledges its writer', async () => {
    await attach('take', { sessionId: 'worker', size: null })
    latest().serve(attached())
    latest().serve({ type: 'terminal.stream-truncated', runtimeSessionId: refConst.runtimeSessionId, generation: refConst.generation, outputEpoch: 1, outputSeq: 0 })
    expect(await world.gateway.transaction('take')).toEqual({ refused: 'not-writer' })
    latest().serve(attached())
    const transaction = await world.gateway.transaction('take')
    if ('refused' in transaction) throw new Error(transaction.refused)
    expect(await transaction.write('after ack')).toEqual({ kind: 'sent' })
    transaction.end()
  })

  it.each(['same-session', 'other-session', 'reconnect'] as const)('does not transfer a waiting transaction after %s attachment replacement', async change => {
    await attach('take', { sessionId: 'worker', size: null })
    latest().serve(attached())
    const inhibit = await world.gateway.inhibit('worker')
    const waiting = world.gateway.transaction('take')
    if (change === 'same-session' || change === 'other-session') {
      world.gateway.detach('take')
      world.resolution = { ok: true, alive: true, ref: { ...refConst, generation: 4 } }
      await attach('take', { sessionId: change === 'same-session' ? 'worker' : 'replacement', size: null })
    } else if (change === 'reconnect')
      latest().serve({ type: 'terminal.stream-truncated', runtimeSessionId: refConst.runtimeSessionId, generation: refConst.generation, outputEpoch: 1, outputSeq: 0 })
    else throw new Error(`Unknown change: ${change satisfies never}`)
    latest().serve(attached())
    inhibit.release()
    expect(await waiting).toEqual({ refused: 'not-writer' })
    const fresh = await world.gateway.transaction('take')
    if ('refused' in fresh) throw new Error(fresh.refused)
    expect(await fresh.write('new edit')).toEqual({ kind: 'sent' })
    expect(world.sockets.flatMap(inputsOf)).toEqual(['new edit'])
    fresh.end()
  })

  it.each(['reattach', 'reconnect', 'detach', 'generation'] as const)('refuses transaction writes after %s', async change => {
    await attach('take', { sessionId: 'worker', size: null })
    latest().serve(attached())
    const transaction = await world.gateway.transaction('take')
    if ('refused' in transaction) throw new Error(transaction.refused)
    if (change === 'reattach') {
      await attach('take', { sessionId: 'worker', size: null })
      latest().serve(attached())
    } else if (change === 'reconnect') {
      latest().serve({ type: 'terminal.stream-truncated', runtimeSessionId: refConst.runtimeSessionId, generation: refConst.generation, outputEpoch: 1, outputSeq: 0 })
      latest().serve(attached())
    } else if (change === 'detach') world.gateway.detach('take')
    else if (change === 'generation') world.resolution = { ok: true, alive: true, ref: { ...refConst, generation: 4 } }
    else throw new Error(`Unknown change: ${change satisfies never}`)
    expect(await transaction.write('must not erase')).toEqual({ refused: 'disconnected' })
    expect(world.sockets.flatMap(inputsOf)).toEqual([])
    transaction.end()
  })

  async function attach(
    attachId: string,
    spec: { sessionId: string; size: { cols: number; rows: number } | null },
    source: 'local' | 'remote' = 'local',
  ) {
    published.add(spec.sessionId)
    await world.gateway.publishRefs([{ sessionId: spec.sessionId, resolution: world.resolution }])
    return (await world.gateway.attach(attachId, spec, {
      source,
      onFrame: (frame) => world.frames.push({ attachId, frame }),
    }))
  }

  function attached(writer = true): HostWsServerMsg {
    return {
      type: 'terminal.attached',
      writer,
      session: {
        runtimeSessionId: refConst.runtimeSessionId,
        generation: refConst.generation,
        alive: true,
        cols: 120,
        rows: 40,
        outputSeq: 0,
        outputEpoch: 1,
        lastOutputAt: null,
        startedAt: 1,
      },
    }
  }

  function snapshot(outputSeq: number, outputEpoch = 1): HostWsServerMsg {
    return {
      type: 'terminal.snapshot',
      projection: {
        runtimeSessionId: refConst.runtimeSessionId,
        generation: refConst.generation,
        outputEpoch,
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

  function data(delta: string, outputSeq: number): HostWsServerMsg {
    return {
      type: 'terminal.data',
      runtimeSessionId: refConst.runtimeSessionId,
      generation: refConst.generation,
      outputEpoch: 1,
      delta,
      outputSeq,
      lastOutputAt: 2,
    }
  }

  function statuses(): TerminalFrame[] {
    return world.frames
      .map((entry) => entry.frame)
      .filter((frame) => frame.type === 'terminal.status')
  }

  it('records accepted user input only, ignoring redraws, resizing, focus and protocol replies', async () => {
    await attach('a1', { sessionId: 'session-1', size: { cols: 120, rows: 40 } })
    expect((await world.gateway.input('a1', 'not ready'))).toEqual({ kind: 'not-writer' })
    expect((await world.gateway.input('missing', 'unknown'))).toEqual({ kind: 'unknown-attach' })
    const socket = latest()
    socket.serve(attached())
    socket.serve(snapshot(1))
    socket.serve(data('Automatic redraw', 2))
    await world.gateway.resize('a1', 100, 30)
    await world.gateway.input('a1', '\x1b[1;2R')
    await world.gateway.input('a1', '\x1b[I')
    await world.gateway.input('a1', '')
    expect(world.userInput).toEqual([])
    vi.useFakeTimers()
    await world.gateway.input('a1', 'prompt\r')
    await world.gateway.input('a1', '\x1b[200~pasted\x1b[201~')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(world.userInput).toEqual(['session-1', 'session-1'])
    socket.serve(attached(false))
    await world.gateway.input('a1', 'read only')
    expect(world.userInput).toHaveLength(2)
    world.gateway.closeAll()
  })

  it('attaches without a cursor, then moves it with what it is told', async () => {
    expect(await attach('a1', { sessionId: 'session-1', size: { cols: 120, rows: 40 } }))
      .toEqual({ ok: true })

    const socket = latest()
    expect(socket.connectedTo).toBe(descriptorConst)
    expect(socket.attachFrame()).toEqual({
      type: 'terminal.attach',
      target: refConst,
      role: 'interactive',
      controllerLeaseId: 'lease-1',
      cols: 120,
      rows: 40,
    })

    socket.serve(attached())
    socket.serve(snapshot(8))
    socket.serve(data('x', 9))
    expect(world.frames.map((entry) => entry.frame.type)).toEqual([
      'terminal.attached',
      'terminal.snapshot',
      'terminal.data',
    ])
    expect(world.frames.every((entry) => entry.attachId === 'a1')).toBe(true)
  })

  // The cursor belongs to the attach, not to the session: a panel that was closed and opened again
  // is a new attach and gets the screen as it stands, which is the only way it can be drawn at all.
  it('starts a second attach on the same session from nothing', async () => {
    await attach('a1', { sessionId: 'session-1', size: null })
    latest().serve(attached())
    latest().serve(snapshot(9))
    world.gateway.detach('a1')

    await attach('a2', { sessionId: 'session-1', size: null })
    const frame = latest().attachFrame()
    expect(frame.sinceSeq).toBeUndefined()
    expect(frame.outputEpoch).toBeUndefined()
  })

  it('routes concurrent attaches on one session only through their own callbacks', async () => {
    await attach('local', { sessionId: 'session-1', size: null })
    await attach('remote', { sessionId: 'session-1', size: null }, 'remote')
    const localSocket = world.sockets[0]
    const remoteSocket = world.sockets[1]
    if (!localSocket || !remoteSocket) throw new Error('both sockets were not opened')

    localSocket.serve(snapshot(3))
    remoteSocket.serve(data('remote', 4))

    expect(world.frames).toEqual([
      { attachId: 'local', frame: snapshot(3) },
      { attachId: 'remote', frame: data('remote', 4) },
    ])
  })

  it('gives geometry to an active local attach and promotes the latest remote after it leaves', async () => {
    await attach('remote', {
      sessionId: 'session-1',
      size: { cols: 90, rows: 20 },
    }, 'remote')
    const remote = latest()
    remote.serve(attached())

    await attach('local', {
      sessionId: 'session-1',
      size: { cols: 120, rows: 40 },
    })
    const local = latest()
    local.serve(attached())

    expect((await world.gateway.resize('remote', 100, 30))).toEqual({ kind: 'ignored' })
    expect(remote.sent.filter((frame) => frame.type === 'terminal.resize')).toEqual([])
    expect((await world.gateway.resize('local', 120, 40))).toEqual({ kind: 'applied' })

    world.gateway.detach('local')

    expect(remote.sent.filter((frame) => frame.type === 'terminal.resize'))
      .toEqual([{ type: 'terminal.resize', cols: 100, rows: 30 }])
  })

  // A hidden tab measures 0x0, and fitting a terminal to that shrinks the PTY to about two columns.
  it('carries no geometry when the surface has no size to ask for', async () => {
    await attach('a1', { sessionId: 'session-1', size: null })
    const frame = latest().attachFrame()
    expect(frame.cols).toBeUndefined()
    expect(frame.rows).toBeUndefined()
  })

  it('reconnects a dropped socket from the cursor, and says so while it is gone', async () => {
    await attach('a1', { sessionId: 'session-1', size: { cols: 120, rows: 40 } })
    latest().serve(attached())
    latest().serve(snapshot(12))

    latest().drop()
    expect(statuses()).toEqual([{ type: 'terminal.status', status: 'connecting', detail: 'the Host closed the attach socket' }])

    await vi.waitFor(() => expect(world.sockets).toHaveLength(2), { timeout: 2_000 })
    expect(latest().attachFrame()).toMatchObject({ outputEpoch: 1, sinceSeq: 12 })
  })

  // Both mean the same thing: the bytes this cursor names are gone from the Host too, so the only
  // thing left to ask for is the screen as it stands. The surface never sees the frame that said so.
  it('throws the cursor away for a truncated delta and for a truncation marker alike', async () => {
    for (const truncation of [
      { type: 'terminal.delta', truncated: true } as const,
      { type: 'terminal.stream-truncated' } as const,
    ]) {
      world.sockets.length = 0
      world.frames.length = 0
      const attachId = truncation.type
      await attach(attachId, { sessionId: 'session-1', size: null })
      latest().serve(attached())
      latest().serve(snapshot(30))

      latest().serve({
        ...truncation,
        runtimeSessionId: refConst.runtimeSessionId,
        generation: refConst.generation,
        outputEpoch: 1,
        outputSeq: 90,
        data: 'everything',
      } as HostWsServerMsg)

      expect(world.sockets).toHaveLength(2)
      const frame = latest().attachFrame()
      expect(frame.sinceSeq).toBeUndefined()
      expect(frame.outputEpoch).toBeUndefined()
      expect(world.frames.map((entry) => entry.frame.type))
        .toEqual(['terminal.attached', 'terminal.snapshot'])
    }
  })

  it('says read-only when writing is refused, and takes it back on a lease that is not the dead one', async () => {
    await attach('a1', { sessionId: 'session-1', size: { cols: 120, rows: 40 } })
    latest().serve(attached())
    latest().serve({ type: 'error', code: 'not-writer', message: 'the lease is gone' })
    expect(statuses()).toEqual([
      { type: 'terminal.status', status: 'read-only', detail: 'the lease is gone' },
    ])

    // The same lease is the dead one: pressing a key must not spin up an attach that fails the same way.
    await world.gateway.input('a1', 'a')
    expect(world.sockets).toHaveLength(1)

    world.leaseId = 'lease-2'
    await world.gateway.input('a1', 'a')
    expect(world.sockets).toHaveLength(2)
    expect(latest().attachFrame().controllerLeaseId).toBe('lease-2')
    // A read-only keystroke is dropped, not queued: replaying old keys into an agent is worse.
    expect(latest().sent.filter((frame) => frame.type === 'terminal.input')).toEqual([])
  })

  it('attaches read-only without a lease at all, and still asks to be a writer', async () => {
    world.leaseId = null
    await attach('a1', { sessionId: 'session-1', size: null })
    expect(latest().attachFrame().controllerLeaseId).toBeUndefined()
    expect(latest().attachFrame().role).toBe('interactive')

    latest().serve(attached(false))
    expect(statuses()).toHaveLength(1)
    expect(statuses()[0]).toMatchObject({ status: 'read-only' })
  })

  // UA1-J09-9: a restarted client attaches before the dead client's lease lapses. The grant that
  // comes later must make the terminal a writer without a keystroke being spent and dropped for it.
  it('attaches again as a writer when a lease arrives, and leaves a writer and an observer alone', async () => {
    world.leaseId = null
    await attach('a1', { sessionId: 'session-1', size: null })
    latest().serve(attached(false))
    world.gateway.leaseChanged()
    expect(world.sockets).toHaveLength(1)

    world.leaseId = 'lease-2'
    world.gateway.leaseChanged()
    expect(world.sockets).toHaveLength(2)
    expect(latest().attachFrame().controllerLeaseId).toBe('lease-2')
    latest().serve(attached(true))
    world.gateway.leaseChanged()
    expect(world.sockets).toHaveLength(2)

    world.resolution = { ok: true, ref: refConst, alive: false }
    await attach('observer', { sessionId: 'session-1', size: null })
    latest().serve(attached(false))
    world.leaseId = 'lease-3'
    world.gateway.leaseChanged()
    expect(world.sockets).toHaveLength(3)
  })

  it('re-resolves the ref once on a conflict and calls the second one lost', async () => {
    await attach('a1', { sessionId: 'session-1', size: null })
    latest().serve(attached())
    latest().serve({ type: 'error', code: 'conflict', message: 'the generation moved' })
    expect(world.sockets).toHaveLength(2)

    latest().serve({ type: 'error', code: 'conflict', message: 'the generation moved again' })
    expect(world.sockets).toHaveLength(2)
    expect(statuses().at(-1)).toEqual({
      type: 'terminal.status',
      status: 'lost',
      detail: 'the generation moved again',
    })
    expect(world.gateway.attachmentCount()).toBe(0)
  })

  it('calls an unknown runtime lost and stops there', async () => {
    await attach('a1', { sessionId: 'session-1', size: null })
    latest().serve({ type: 'error', code: 'unknown-runtime', message: 'no such runtime' })
    expect(statuses().at(-1)).toMatchObject({ status: 'lost' })
    expect(world.gateway.attachmentCount()).toBe(0)
    expect(latest().closed).toBe(true)
  })

  it('ends the attach when the runtime exits, and hands the exit on first', async () => {
    await attach('a1', { sessionId: 'session-1', size: null })
    latest().serve(attached())
    latest().serve({
      type: 'terminal.exit',
      runtimeSessionId: refConst.runtimeSessionId,
      generation: refConst.generation,
      exitCode: 0,
    })
    expect(world.frames.at(-1)?.frame).toMatchObject({ type: 'terminal.exit', exitCode: 0 })
    expect(world.gateway.attachmentCount()).toBe(0)
  })

  // Revealing a tab recomputes the same size, and a resize the PTY already has still triggers a
  // ConPTY reflow that corrupts wide and box-drawing characters.
  it('sends a resize only when the size actually moved', async () => {
    await attach('a1', { sessionId: 'session-1', size: { cols: 120, rows: 40 } })
    latest().serve(attached())

    await world.gateway.resize('a1', 120, 40)
    expect(latest().sent.filter((frame) => frame.type === 'terminal.resize')).toEqual([])

    await world.gateway.resize('a1', 100, 30)
    await world.gateway.resize('a1', 100, 30)
    expect(latest().sent.filter((frame) => frame.type === 'terminal.resize'))
      .toEqual([{ type: 'terminal.resize', cols: 100, rows: 30 }])
  })

  it('sends the newest size once when it changed while the attach was connecting', async () => {
    await attach('a1', { sessionId: 'session-1', size: null })
    await world.gateway.resize('a1', 100, 30)
    expect(latest().sent.filter((frame) => frame.type === 'terminal.resize')).toEqual([])

    latest().serve(attached())
    await world.gateway.resize('a1', 100, 30)
    expect(latest().sent.filter((frame) => frame.type === 'terminal.resize'))
      .toEqual([{ type: 'terminal.resize', cols: 100, rows: 30 }])
  })

  it('sends no resize and no input at all while it is not the writer', async () => {
    await attach('a1', { sessionId: 'session-1', size: null })
    latest().serve(attached(false))
    await world.gateway.resize('a1', 100, 30)
    await world.gateway.input('a1', 'a')
    expect(latest().sent).toHaveLength(1)
  })

  it('refuses an attach the Host or the records cannot answer', async () => {
    world.resolution = { ok: false, code: 'not-live' }
    expect(await attach('a1', { sessionId: 'session-1', size: null }))
      .toMatchObject({ ok: false, code: 'not-live' })

    world.resolution = { ok: false, code: 'unknown-session' }
    expect(await attach('a1', { sessionId: 'session-1', size: null }))
      .toMatchObject({ ok: false, code: 'unknown-session' })

    world.descriptor = null
    world.resolution = { ok: true, ref: refConst, alive: true }
    expect(await attach('a1', { sessionId: 'session-1', size: null }))
      .toMatchObject({ ok: false, code: 'host-unreachable' })

    expect(world.sockets).toEqual([])
  })

  /**
   * A runtime the Host still HAS and no longer runs is worth attaching to: what it printed before it
   * died is the whole answer to why it died, and refusing it threw that away. There is nothing left
   * to type at, so the attach asks for nothing - no lease, no interactive role.
   */
  it('attaches to a runtime that has already exited, as an observer and without a lease', async () => {
    world.resolution = { ok: true, ref: refConst, alive: false }

    expect(await attach('a1', { sessionId: 'session-1', size: { cols: 80, rows: 24 } }))
      .toEqual({ ok: true })
    expect(latest().attachFrame()).toEqual({
      type: 'terminal.attach',
      target: refConst,
      role: 'observer',
      cols: 80,
      rows: 24,
    })
  })

  /**
   * The reopen on a keystroke exists for the one case where writing can be had again: a controller
   * lease that came back under a new id. An observer attach asked for no lease at all, so its
   * remembered lease is null forever and the comparison alone was permanently unequal - one dropped
   * socket and one fresh WebSocket per character typed into a session that had already exited.
   */
  /**
   * The refusal the Host sends when the client built an attach frame it cannot answer. All three
   * things have to happen: the sentence reaches the app's error channel, the surface is told it is
   * lost with that detail, and the attachment lets go. Until 2026-08-23 the branch was reached by no
   * test at all, and `world.errors` was collected by the fixture and asserted nowhere, so it read as
   * error coverage and was decoration.
   */
  /**
   * `setGeometryActive` is how a surface that stopped being looked at hands the PTY geometry over,
   * and it was named by no test in the repository: an unconditional refusal could be dropped in its
   * place and the whole library stayed green. Both rules inside it are here.
   */
  describe('handing the geometry over when a surface stops being looked at', () => {
    it('gives it to the other surface of the same session, not to nobody', async () => {
      await attach('remote', { sessionId: 'session-1', size: { cols: 120, rows: 40 } }, 'remote')
      latest().serve(attached())
      await attach('local', { sessionId: 'session-1', size: { cols: 80, rows: 24 } })
      latest().serve(attached())
      expect((await world.gateway.resize('remote', 100, 30))).to.deep.equal({ kind: 'ignored' })

      expect((await world.gateway.setGeometryActive('local', false))).to.deep.equal({ kind: 'ignored' })

      expect((await world.gateway.resize('remote', 100, 30))).to.deep.equal({ kind: 'applied' })
    })

    /**
     * A surface that never measured has no size to hand over, so activating it must not take the
     * ownership away from one that has: the reconcile would then send `null` to the writer.
     *
     * Held in two places, and only one of them is load-bearing: `geometryOwnerOf` skips an attach
     * with no `wantedSize`, and `setGeometryActive` refuses to mark one active in the first place.
     * Removing the second alone changes nothing this can see - it is there to keep the ordering
     * counter from being bumped for a surface that could never own anything.
     */
    it('refuses ownership to a surface that has never measured', async () => {
      await attach('blind', { sessionId: 'session-1', size: null })
      latest().serve(attached())
      await attach('measured', { sessionId: 'session-1', size: { cols: 80, rows: 24 } }, 'remote')
      latest().serve(attached())

      expect((await world.gateway.setGeometryActive('blind', true))).to.deep.equal({ kind: 'ignored' })

      expect((await world.gateway.resize('measured', 100, 30))).to.deep.equal({ kind: 'applied' })
    })

    it('answers unknown-attach for an id it is not holding', async () => {
      expect((await world.gateway.setGeometryActive('nobody', true)))
        .to.deep.equal({ kind: 'unknown-attach' })
    })
  })

  it('reports a refused attach frame, tells the surface, and lets the attachment go', async () => {
    await attach('a1', { sessionId: 'session-1', size: { cols: 80, rows: 24 } })

    latest().serve({ type: 'error', code: 'bad-request', message: 'the attach frame is malformed' })

    expect(world.errors)
      .to.deep.equal(['The Host refused an attach frame: the attach frame is malformed'])
    expect(world.gateway.attachmentCount()).to.equal(0)
  })

  /**
   * The same code, after the attach worked, is a different fact: some LATER frame was refused, and
   * the screen it was typed at is still there. It used to be read as the attach failing, so one
   * oversized paste ended the terminal and left the session running with nothing attached to it.
   */
  it('keeps a working attach when the Host refuses a later frame', async () => {
    await attach('a1', { sessionId: 'session-1', size: { cols: 80, rows: 24 } })
    latest().serve(attached())

    latest().serve({ type: 'error', code: 'bad-request', message: 'input exceeds 4096 bytes' })

    expect(world.errors)
      .to.deep.equal(['The Host refused a terminal frame: input exceeds 4096 bytes'])
    expect(world.gateway.attachmentCount()).to.equal(1)
    expect(world.frames.filter((entry) => entry.frame.type === 'terminal.status')).to.deep.equal([])
  })

  /**
   * A paste is one string and the wire takes 4096 bytes a frame. Nothing between the clipboard and
   * here divides it, so this is where it is divided - and the whole point is that the pieces join
   * back into what was pasted, markers and multi-byte characters included.
   */
  it('sends a paste past the wire limit as several ordered input frames', async () => {
    await attach('a1', { sessionId: 'session-1', size: { cols: 80, rows: 24 } })
    latest().serve(attached())
    const paste = `\x1b[200~${'┌'.repeat(2_000)}\x1b[201~`

    expect((await world.gateway.input('a1', paste))).to.deep.equal({ kind: 'sent' })

    const sent = inputsOf(latest())
    expect(sent.length).to.be.greaterThan(1)
    for (const data of sent) expect(Buffer.byteLength(data, 'utf8')).to.be.at.most(4_096)
    expect(sent.join('')).to.equal(paste)
  })

  it('sends a keystroke as the single frame it always was', async () => {
    await attach('a1', { sessionId: 'session-1', size: { cols: 80, rows: 24 } })
    latest().serve(attached())

    expect((await world.gateway.input('a1', 'h'))).to.deep.equal({ kind: 'sent' })

    expect(inputsOf(latest())).to.deep.equal(['h'])
  })

  it('does not reopen the socket when a key is pressed in a session that has already exited', async () => {
    world.resolution = { ok: true, ref: refConst, alive: false }
    await attach('a1', { sessionId: 'session-1', size: { cols: 80, rows: 24 } })
    latest().serve(attached(false))
    const opened = world.sockets.length

    for (const character of ['h', 'e', 'l', 'l', 'o'])
      expect((await world.gateway.input('a1', character))).toEqual({ kind: 'not-writer' })

    expect(world.sockets.length).to.equal(opened)
    expect(latest().closed).to.equal(false)
  })

  /**
   * The two codes were branched as a pair, with `not-live` as the implicit half, so a third one would
   * have been reported with the other's sentence. Both places now say what they know or nothing.
   */
  it('throws on a resolution code it does not know, rather than writing a false sentence', async () => {
    world.resolution = { ok: false, code: 'gone' as 'not-live' }
    await expect(attach('a1', { sessionId: 'session-1', size: null }))
      .rejects.toThrow(/Unknown terminal ref refusal/)

    world.resolution = { ok: true, ref: refConst, alive: true }
    await attach('a2', { sessionId: 'session-1', size: null })
    latest().serve(attached())
    world.resolution = { ok: false, code: 'gone' as 'not-live' }
    expect(() => latest().serve({ type: 'error', code: 'conflict', message: 'the generation moved' }))
      .toThrow(/Unknown terminal ref refusal/)
  })

  // The surface acts on the code; the sentence is for the person. Reading the refusal back out of
  // English is what the code exists to stop.
  it('names the code on a lost status that came from a refused resolution', async () => {
    await attach('a1', { sessionId: 'session-1', size: null })
    latest().serve(attached())
    world.resolution = { ok: false, code: 'not-live' }
    latest().drop()

    await vi.waitFor(() => expect(statuses().at(-1)).toMatchObject({ status: 'lost' }), { timeout: 2_000 })
    expect(statuses().at(-1)).toEqual({
      type: 'terminal.status',
      status: 'lost',
      detail: 'this session has no live runtime',
      code: 'not-live',
    })
  })

  it('carries no code on a lost status the Host itself reported', async () => {
    await attach('a1', { sessionId: 'session-1', size: null })
    latest().serve({ type: 'error', code: 'unknown-runtime', message: 'no such runtime' })
    expect(statuses().at(-1)).toEqual({
      type: 'terminal.status',
      status: 'lost',
      detail: 'no such runtime',
    })
  })

  it('replaces an attach that reuses an id, and lets an unknown id say anything', async () => {
    await attach('a1', { sessionId: 'session-1', size: null })
    const first = latest()
    await attach('a1', { sessionId: 'session-1', size: null })

    expect(first.closed).toBe(true)
    expect(world.gateway.attachmentCount()).toBe(1)
    await expect(world.gateway.input('nobody', 'a')).resolves.toEqual({ kind: 'unknown-attach' })
    await expect(world.gateway.resize('nobody', 1, 1)).resolves.toEqual({ kind: 'unknown-attach' })
    expect(() => world.gateway.detach('nobody')).not.toThrow()
  })

  // Were the two calls ever to arrive out of order, the attach would otherwise outlive the surface
  // that asked for it and hold a socket nobody reads.
  it('closes an attach that arrives after its own detach', async () => {
    world.gateway.detach('a1')
    expect(await attach('a1', { sessionId: 'session-1', size: null })).toEqual({ ok: true })
    expect(world.sockets).toEqual([])
    expect(world.gateway.attachmentCount()).toBe(0)

    // Remembered exactly once: the next attach under that id is an ordinary one.
    await attach('a1', { sessionId: 'session-1', size: null })
    expect(world.gateway.attachmentCount()).toBe(1)
  })

  it('lets one client go without touching another, and closes everything on stop', async () => {
    await attach('a1', { sessionId: 'session-1', size: null })
    await attach('a2', { sessionId: 'session-1', size: null })
    await attach('b1', { sessionId: 'session-1', size: null })

    world.gateway.detachAll(['a1', 'a2'])
    expect(world.gateway.attachmentCount()).toBe(1)

    world.gateway.closeAll()
    expect(world.gateway.attachmentCount()).toBe(0)
    expect(world.sockets.every((socket) => socket.closed)).toBe(true)
    // Every one of them told the Host before it went, so no attach waits for a socket to fall over.
    expect(world.sockets.every((socket) =>
      socket.sent.some((frame) => frame.type === 'terminal.detach'))).toBe(true)
  })

  it('waits for a descriptor instead of failing an attach that raced the Host', async () => {
    await attach('a1', { sessionId: 'session-1', size: null })
    world.descriptor = null
    latest().drop()

    await vi.waitFor(() => expect(statuses().length).toBeGreaterThanOrEqual(2), { timeout: 2_000 })
    expect(statuses().at(-1)).toMatchObject({
      status: 'connecting',
      detail: 'no Host descriptor is published',
    })
    expect(world.gateway.attachmentCount()).toBe(1)
    world.gateway.closeAll()
  })

  it('waits for the matching Host descriptor and reports lost after five seconds across retries', async () => {
    vi.useFakeTimers()
    world.descriptor = { ...descriptorConst, hostInstanceId: 'replacement-host' }
    expect(await attach('waiting', { sessionId: 'session-1', size: null })).toEqual({ ok: true })
    expect(world.sockets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(statuses().at(-1)).toMatchObject({ status: 'connecting' })
    expect(world.gateway.attachmentCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(statuses().at(-1)).toMatchObject({ status: 'lost', detail: 'the runtime belongs to a different Host instance' })
    expect(world.gateway.attachmentCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('connects when the matching descriptor arrives within the mismatch wait', async () => {
    vi.useFakeTimers()
    world.descriptor = { ...descriptorConst, hostInstanceId: 'replacement-host' }
    await attach('waiting', { sessionId: 'session-1', size: null })
    await vi.advanceTimersByTimeAsync(3_000)
    world.descriptor = descriptorConst
    await vi.advanceTimersByTimeAsync(100)
    expect(latest().connectedTo?.hostInstanceId).toBe('host-1')
    expect(latest().attachFrame().target.hostInstanceId).toBe('host-1')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('batches fifty keys in one second and preserves capture time with immediate input after idle', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const marks: { sessionId: string; at: number }[] = []
    const gateway = new TerminalGateway({ descriptorOf: () => descriptorConst, leaseIdOf: () => 'lease',
      activity: { userInput: batch => marks.push(...batch), pendingInputHint: () => {} }, onError: () => {},
      socketFactory: deps => { const socket = new FakeSocket(deps); world.sockets.push(socket); return socket } })
    try {
      await gateway.publishRefs([{ sessionId: 'session-1', resolution: { ok: true, ref: refConst, alive: true } }])
      await gateway.attach('typing', { sessionId: 'session-1', size: null }, { source: 'remote', onFrame: () => {} })
      latest().serve(attached())
      for (let index = 0; index < 50; index++) {
        expect(await gateway.input('typing', 'x')).toEqual({ kind: 'sent' })
        await vi.advanceTimersByTimeAsync(20)
      }
      expect(marks).toEqual([{ sessionId: 'session-1', at: 10_000 }, { sessionId: 'session-1', at: 10_980 }])
      await vi.advanceTimersByTimeAsync(5_000)
      await gateway.input('typing', 'idle key')
      expect(marks.at(-1)).toEqual({ sessionId: 'session-1', at: 16_000 })
      await gateway.input('typing', 'last key')
      gateway.closeAll()
      expect(marks.at(-1)).toEqual({ sessionId: 'session-1', at: 16_000 })
      expect(vi.getTimerCount()).toBe(0)
    } finally { gateway.closeAll() }
  })

  it('authorizes only the owning window, revokes on detach and never grants remote attaches', async () => {
    await world.gateway.publishRefs([{ sessionId: 'session-1', resolution: world.resolution }])
    await world.gateway.attach('local', { sessionId: 'session-1', size: null }, { source: 'local', windowId: 'window', onFrame: () => {} })
    expect(await world.gateway.authorize('window', 'local')).toEqual({ sessionId: 'session-1' })
    expect(await world.gateway.authorize('other', 'local')).toEqual({ refused: true })
    await attach('remote', { sessionId: 'session-1', size: null }, 'remote')
    expect(await world.gateway.authorize('window', 'remote')).toEqual({ refused: true })
    world.gateway.detach('local')
    expect(await world.gateway.authorize('window', 'local')).toEqual({ refused: true })
  })


  it('answers pending input authoritatively before batched hints and preserves queued input time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    await attach('queued', { sessionId: 'session-1', size: null })
    latest().serve(attached())
    const held = await world.gateway.inhibit('session-1')
    const queued = world.gateway.input('queued', 'typed while held')
    expect(await world.gateway.pendingInput('session-1')).toBe(1)
    expect(world.hints.size).toBe(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(world.hints.get('session-1')).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    held.release()
    expect(await world.gateway.pendingInput('session-1')).toBe(0)
    expect(world.hints.get('session-1')).toBe(1)
    expect(await queued).toEqual({ kind: 'sent' })
    expect(world.userMarks).toEqual([{ sessionId: 'session-1', at: 100 }])
    await vi.advanceTimersByTimeAsync(0)
    expect(world.hints.size).toBe(0)
    world.gateway.closeAll()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops a removed session pending mark and clears its timer', async () => {
    vi.useFakeTimers()
    await attach('removed', { sessionId: 'session-1', size: null })
    latest().serve(attached())
    await world.gateway.input('removed', 'first')
    await world.gateway.input('removed', 'pending mark')
    await world.gateway.publishRefs([{ sessionId: 'session-1', resolution: { ok: false, code: 'unknown-session' } }])
    expect(vi.getTimerCount()).toBe(0)
    expect(world.userMarks).toHaveLength(1)
  })


  it('clears stopped pending input without rearming a hint timer on late inhibit release', async () => {
    vi.useFakeTimers()
    await attach('stopped', { sessionId: 'session-1', size: null })
    latest().serve(attached())
    const held = await world.gateway.inhibit('session-1')
    const queued = world.gateway.input('stopped', 'queued')
    world.gateway.closeAll()
    expect(await queued).toEqual({ kind: 'unknown-attach' })
    expect(await world.gateway.pendingInput('session-1')).toBe(0)
    held.release()
    expect(vi.getTimerCount()).toBe(0)
    expect(world.hints.size).toBe(0)
    expect(world.userMarks).toEqual([])
  })

})
