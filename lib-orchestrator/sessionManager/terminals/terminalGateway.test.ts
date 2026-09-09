import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  HostDescriptor,
  HostWsClientMsg,
  HostWsServerMsg,
  RuntimeRef,
} from '../../../app-host/app/wire/hostWire.js'
import type { TerminalAttachSocketDeps } from '../../hostClient/terminalAttachSocket'
import type { TerminalFrame } from '../sessionManagerApi.types'
import type { TerminalRefResolution, TerminalSocket } from './terminalAttachment'
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
    descriptor: HostDescriptor | null
    leaseId: string | null
    resolution: TerminalRefResolution
  }

  let world: World

  beforeEach(() => {
    const state: World = {
      gateway: null as unknown as TerminalGateway,
      sockets: [],
      frames: [],
      errors: [],
      descriptor: descriptorConst,
      leaseId: 'lease-1',
      resolution: { ok: true, ref: refConst, alive: true },
    }
    state.gateway = new TerminalGateway({
      descriptorOf: () => state.descriptor,
      leaseIdOf: () => state.leaseId,
      refOf: () => state.resolution,
      onError: (message) => state.errors.push(message),
      socketFactory: (deps) => {
        const socket = new FakeSocket(deps)
        state.sockets.push(socket)
        return socket
      },
    })
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

  function attach(
    attachId: string,
    spec: { sessionId: string; size: { cols: number; rows: number } | null },
    source: 'local' | 'remote' = 'local',
  ) {
    return world.gateway.attach(attachId, spec, {
      source,
      onFrame: (frame) => world.frames.push({ attachId, frame }),
    })
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

  it('attaches without a cursor, then moves it with what it is told', () => {
    expect(attach('a1', { sessionId: 'session-1', size: { cols: 120, rows: 40 } }))
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
  it('starts a second attach on the same session from nothing', () => {
    attach('a1', { sessionId: 'session-1', size: null })
    latest().serve(attached())
    latest().serve(snapshot(9))
    world.gateway.detach('a1')

    attach('a2', { sessionId: 'session-1', size: null })
    const frame = latest().attachFrame()
    expect(frame.sinceSeq).toBeUndefined()
    expect(frame.outputEpoch).toBeUndefined()
  })

  it('routes concurrent attaches on one session only through their own callbacks', () => {
    attach('local', { sessionId: 'session-1', size: null })
    attach('remote', { sessionId: 'session-1', size: null }, 'remote')
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

  it('gives geometry to an active local attach and promotes the latest remote after it leaves', () => {
    attach('remote', {
      sessionId: 'session-1',
      size: { cols: 90, rows: 20 },
    }, 'remote')
    const remote = latest()
    remote.serve(attached())

    attach('local', {
      sessionId: 'session-1',
      size: { cols: 120, rows: 40 },
    })
    const local = latest()
    local.serve(attached())

    expect(world.gateway.resize('remote', 100, 30)).toEqual({ kind: 'ignored' })
    expect(remote.sent.filter((frame) => frame.type === 'terminal.resize')).toEqual([])
    expect(world.gateway.resize('local', 120, 40)).toEqual({ kind: 'applied' })

    world.gateway.detach('local')

    expect(remote.sent.filter((frame) => frame.type === 'terminal.resize'))
      .toEqual([{ type: 'terminal.resize', cols: 100, rows: 30 }])
  })

  // A hidden tab measures 0x0, and fitting a terminal to that shrinks the PTY to about two columns.
  it('carries no geometry when the surface has no size to ask for', () => {
    attach('a1', { sessionId: 'session-1', size: null })
    const frame = latest().attachFrame()
    expect(frame.cols).toBeUndefined()
    expect(frame.rows).toBeUndefined()
  })

  it('reconnects a dropped socket from the cursor, and says so while it is gone', async () => {
    attach('a1', { sessionId: 'session-1', size: { cols: 120, rows: 40 } })
    latest().serve(attached())
    latest().serve(snapshot(12))

    latest().drop()
    expect(statuses()).toEqual([{ type: 'terminal.status', status: 'connecting', detail: 'the Host closed the attach socket' }])

    await vi.waitFor(() => expect(world.sockets).toHaveLength(2), { timeout: 2_000 })
    expect(latest().attachFrame()).toMatchObject({ outputEpoch: 1, sinceSeq: 12 })
  })

  // Both mean the same thing: the bytes this cursor names are gone from the Host too, so the only
  // thing left to ask for is the screen as it stands. The surface never sees the frame that said so.
  it('throws the cursor away for a truncated delta and for a truncation marker alike', () => {
    for (const truncation of [
      { type: 'terminal.delta', truncated: true } as const,
      { type: 'terminal.stream-truncated' } as const,
    ]) {
      world.sockets.length = 0
      world.frames.length = 0
      const attachId = truncation.type
      attach(attachId, { sessionId: 'session-1', size: null })
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

  it('says read-only when writing is refused, and takes it back on a lease that is not the dead one', () => {
    attach('a1', { sessionId: 'session-1', size: { cols: 120, rows: 40 } })
    latest().serve(attached())
    latest().serve({ type: 'error', code: 'not-writer', message: 'the lease is gone' })
    expect(statuses()).toEqual([
      { type: 'terminal.status', status: 'read-only', detail: 'the lease is gone' },
    ])

    // The same lease is the dead one: pressing a key must not spin up an attach that fails the same way.
    world.gateway.input('a1', 'a')
    expect(world.sockets).toHaveLength(1)

    world.leaseId = 'lease-2'
    world.gateway.input('a1', 'a')
    expect(world.sockets).toHaveLength(2)
    expect(latest().attachFrame().controllerLeaseId).toBe('lease-2')
    // A read-only keystroke is dropped, not queued: replaying old keys into an agent is worse.
    expect(latest().sent.filter((frame) => frame.type === 'terminal.input')).toEqual([])
  })

  it('attaches read-only without a lease at all, and still asks to be a writer', () => {
    world.leaseId = null
    attach('a1', { sessionId: 'session-1', size: null })
    expect(latest().attachFrame().controllerLeaseId).toBeUndefined()
    expect(latest().attachFrame().role).toBe('interactive')

    latest().serve(attached(false))
    expect(statuses()).toHaveLength(1)
    expect(statuses()[0]).toMatchObject({ status: 'read-only' })
  })

  it('re-resolves the ref once on a conflict and calls the second one lost', () => {
    attach('a1', { sessionId: 'session-1', size: null })
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

  it('calls an unknown runtime lost and stops there', () => {
    attach('a1', { sessionId: 'session-1', size: null })
    latest().serve({ type: 'error', code: 'unknown-runtime', message: 'no such runtime' })
    expect(statuses().at(-1)).toMatchObject({ status: 'lost' })
    expect(world.gateway.attachmentCount()).toBe(0)
    expect(latest().closed).toBe(true)
  })

  it('ends the attach when the runtime exits, and hands the exit on first', () => {
    attach('a1', { sessionId: 'session-1', size: null })
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
  it('sends a resize only when the size actually moved', () => {
    attach('a1', { sessionId: 'session-1', size: { cols: 120, rows: 40 } })
    latest().serve(attached())

    world.gateway.resize('a1', 120, 40)
    expect(latest().sent.filter((frame) => frame.type === 'terminal.resize')).toEqual([])

    world.gateway.resize('a1', 100, 30)
    world.gateway.resize('a1', 100, 30)
    expect(latest().sent.filter((frame) => frame.type === 'terminal.resize'))
      .toEqual([{ type: 'terminal.resize', cols: 100, rows: 30 }])
  })

  it('sends the newest size once when it changed while the attach was connecting', () => {
    attach('a1', { sessionId: 'session-1', size: null })
    world.gateway.resize('a1', 100, 30)
    expect(latest().sent.filter((frame) => frame.type === 'terminal.resize')).toEqual([])

    latest().serve(attached())
    world.gateway.resize('a1', 100, 30)
    expect(latest().sent.filter((frame) => frame.type === 'terminal.resize'))
      .toEqual([{ type: 'terminal.resize', cols: 100, rows: 30 }])
  })

  it('sends no resize and no input at all while it is not the writer', () => {
    attach('a1', { sessionId: 'session-1', size: null })
    latest().serve(attached(false))
    world.gateway.resize('a1', 100, 30)
    world.gateway.input('a1', 'a')
    expect(latest().sent).toHaveLength(1)
  })

  it('refuses an attach the Host or the records cannot answer', () => {
    world.resolution = { ok: false, code: 'not-live' }
    expect(attach('a1', { sessionId: 'session-1', size: null }))
      .toMatchObject({ ok: false, code: 'not-live' })

    world.resolution = { ok: false, code: 'unknown-session' }
    expect(attach('a1', { sessionId: 'session-1', size: null }))
      .toMatchObject({ ok: false, code: 'unknown-session' })

    world.descriptor = null
    world.resolution = { ok: true, ref: refConst, alive: true }
    expect(attach('a1', { sessionId: 'session-1', size: null }))
      .toMatchObject({ ok: false, code: 'host-unreachable' })

    expect(world.sockets).toEqual([])
  })

  /**
   * A runtime the Host still HAS and no longer runs is worth attaching to: what it printed before it
   * died is the whole answer to why it died, and refusing it threw that away. There is nothing left
   * to type at, so the attach asks for nothing - no lease, no interactive role.
   */
  it('attaches to a runtime that has already exited, as an observer and without a lease', () => {
    world.resolution = { ok: true, ref: refConst, alive: false }

    expect(attach('a1', { sessionId: 'session-1', size: { cols: 80, rows: 24 } }))
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
    it('gives it to the other surface of the same session, not to nobody', () => {
      attach('remote', { sessionId: 'session-1', size: { cols: 120, rows: 40 } }, 'remote')
      latest().serve(attached())
      attach('local', { sessionId: 'session-1', size: { cols: 80, rows: 24 } })
      latest().serve(attached())
      expect(world.gateway.resize('remote', 100, 30)).to.deep.equal({ kind: 'ignored' })

      expect(world.gateway.setGeometryActive('local', false)).to.deep.equal({ kind: 'ignored' })

      expect(world.gateway.resize('remote', 100, 30)).to.deep.equal({ kind: 'applied' })
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
    it('refuses ownership to a surface that has never measured', () => {
      attach('blind', { sessionId: 'session-1', size: null })
      latest().serve(attached())
      attach('measured', { sessionId: 'session-1', size: { cols: 80, rows: 24 } }, 'remote')
      latest().serve(attached())

      expect(world.gateway.setGeometryActive('blind', true)).to.deep.equal({ kind: 'ignored' })

      expect(world.gateway.resize('measured', 100, 30)).to.deep.equal({ kind: 'applied' })
    })

    it('answers unknown-attach for an id it is not holding', () => {
      expect(world.gateway.setGeometryActive('nobody', true))
        .to.deep.equal({ kind: 'unknown-attach' })
    })
  })

  it('reports a refused attach frame, tells the surface, and lets the attachment go', () => {
    attach('a1', { sessionId: 'session-1', size: { cols: 80, rows: 24 } })

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
  it('keeps a working attach when the Host refuses a later frame', () => {
    attach('a1', { sessionId: 'session-1', size: { cols: 80, rows: 24 } })
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
  it('sends a paste past the wire limit as several ordered input frames', () => {
    attach('a1', { sessionId: 'session-1', size: { cols: 80, rows: 24 } })
    latest().serve(attached())
    const paste = `\x1b[200~${'┌'.repeat(2_000)}\x1b[201~`

    expect(world.gateway.input('a1', paste)).to.deep.equal({ kind: 'sent' })

    const sent = inputsOf(latest())
    expect(sent.length).to.be.greaterThan(1)
    for (const data of sent) expect(Buffer.byteLength(data, 'utf8')).to.be.at.most(4_096)
    expect(sent.join('')).to.equal(paste)
  })

  it('sends a keystroke as the single frame it always was', () => {
    attach('a1', { sessionId: 'session-1', size: { cols: 80, rows: 24 } })
    latest().serve(attached())

    expect(world.gateway.input('a1', 'h')).to.deep.equal({ kind: 'sent' })

    expect(inputsOf(latest())).to.deep.equal(['h'])
  })

  it('does not reopen the socket when a key is pressed in a session that has already exited', () => {
    world.resolution = { ok: true, ref: refConst, alive: false }
    attach('a1', { sessionId: 'session-1', size: { cols: 80, rows: 24 } })
    latest().serve(attached(false))
    const opened = world.sockets.length

    for (const character of ['h', 'e', 'l', 'l', 'o'])
      expect(world.gateway.input('a1', character)).toEqual({ kind: 'not-writer' })

    expect(world.sockets.length).to.equal(opened)
    expect(latest().closed).to.equal(false)
  })

  /**
   * The two codes were branched as a pair, with `not-live` as the implicit half, so a third one would
   * have been reported with the other's sentence. Both places now say what they know or nothing.
   */
  it('throws on a resolution code it does not know, rather than writing a false sentence', () => {
    world.resolution = { ok: false, code: 'gone' as 'not-live' }
    expect(() => attach('a1', { sessionId: 'session-1', size: null }))
      .toThrow(/Unknown terminal ref refusal/)

    world.resolution = { ok: true, ref: refConst, alive: true }
    attach('a2', { sessionId: 'session-1', size: null })
    latest().serve(attached())
    world.resolution = { ok: false, code: 'gone' as 'not-live' }
    expect(() => latest().serve({ type: 'error', code: 'conflict', message: 'the generation moved' }))
      .toThrow(/Unknown terminal ref refusal/)
  })

  // The surface acts on the code; the sentence is for the person. Reading the refusal back out of
  // English is what the code exists to stop.
  it('names the code on a lost status that came from a refused resolution', async () => {
    attach('a1', { sessionId: 'session-1', size: null })
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

  it('carries no code on a lost status the Host itself reported', () => {
    attach('a1', { sessionId: 'session-1', size: null })
    latest().serve({ type: 'error', code: 'unknown-runtime', message: 'no such runtime' })
    expect(statuses().at(-1)).toEqual({
      type: 'terminal.status',
      status: 'lost',
      detail: 'no such runtime',
    })
  })

  it('replaces an attach that reuses an id, and lets an unknown id say anything', () => {
    attach('a1', { sessionId: 'session-1', size: null })
    const first = latest()
    attach('a1', { sessionId: 'session-1', size: null })

    expect(first.closed).toBe(true)
    expect(world.gateway.attachmentCount()).toBe(1)
    expect(() => world.gateway.input('nobody', 'a')).not.toThrow()
    expect(() => world.gateway.resize('nobody', 1, 1)).not.toThrow()
    expect(() => world.gateway.detach('nobody')).not.toThrow()
  })

  // Were the two calls ever to arrive out of order, the attach would otherwise outlive the surface
  // that asked for it and hold a socket nobody reads.
  it('closes an attach that arrives after its own detach', () => {
    world.gateway.detach('a1')
    expect(attach('a1', { sessionId: 'session-1', size: null })).toEqual({ ok: true })
    expect(world.sockets).toEqual([])
    expect(world.gateway.attachmentCount()).toBe(0)

    // Remembered exactly once: the next attach under that id is an ordinary one.
    attach('a1', { sessionId: 'session-1', size: null })
    expect(world.gateway.attachmentCount()).toBe(1)
  })

  it('lets one client go without touching another, and closes everything on stop', () => {
    attach('a1', { sessionId: 'session-1', size: null })
    attach('a2', { sessionId: 'session-1', size: null })
    attach('b1', { sessionId: 'session-1', size: null })

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
    attach('a1', { sessionId: 'session-1', size: null })
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
})
