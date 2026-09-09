import { describe, expect, it } from 'vitest'

import {
  type RemoteControlPeerApplicationMessage,
  type RemoteControlPeerCapability,
  type RemoteControlPeerIdentity,
  type RemoteControlPeerProfile,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { RemoteControlHelloDto } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlPeerTransport } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  SessionsSnapshot,
  TerminalFrame,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { RemoteConnectionsManager } from './remoteConnectionsManager'

describe('app-client-ui/app/remoteControl/remoteConnectionsManager', () => {
  it('connects, keeps a stale snapshot offline and reconnects with open terminal attaches', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    harness.manager.holdConnections('test')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')
    expect(harness.manager.snapshot().outbound[0]?.sessions?.revision).toBe(1)
    const frames: unknown[] = []
    expect(await harness.manager.attachTerminal(
      'target-endpoint',
      'attach-a',
      { sessionId: 'session-a', size: { cols: 80, rows: 24 } },
      (frame) => frames.push(frame),
    )).toMatchObject({ ok: true })
    expect(harness.transports[0]?.attachRequests).toBe(1)
    expect(await harness.manager.terminalActive('target-endpoint', 'attach-a', true))
      .toMatchObject({ ok: true })
    expect(harness.transports[0]?.activeRequests).toBe(1)

    harness.transports[0]?.close()
    await harness.waitUntil(() => harness.transports.length === 2
      && harness.manager.snapshot().outbound[0]?.status === 'connected')
    expect(harness.transports[1]?.attachRequests).toBe(1)
    expect(harness.transports[1]?.activeRequests).toBe(1)
    expect(harness.manager.snapshot().outbound[0]?.sessions?.revision).toBe(2)
    expect(frames).toContainEqual({
      type: 'terminal.status',
      status: 'connecting',
      detail: 'Remote AppClientUI disconnected',
    })
    harness.manager.stop()
  })

  /*
   * The block a person copies to hand a session to a SECOND agent. Nothing is asked of the paired
   * computer: its sessions arrive whole on every refresh, so what is held is what the block is made
   * of - and the transcript is left out, because that file is on the other machine's disk.
   */
  it('writes down a paired session from what is held, and refuses what it does not hold', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    harness.manager.holdConnections('test')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')

    expect(harness.manager.sessionReference('target-endpoint', 'session-a')).toEqual({
      ok: true,
      value: {
        text: [
          'AppJamatV3 session',
          'reference version: 2',
          'computer: "Same name"',
          'route: remote',
          'controller config identity: "config-local-endpoint"',
          'controller channel: development',
          'remote endpoint id: "target-endpoint"',
          'target config identity: "config-target-endpoint"',
          'target channel: development',
          'session: "014 remote work"',
          'agent: codex',
          'agent session id: "native-remote-1"',
          'working directory: "D:/code/Alpha"',
          'jamat session id: "session-a"',
        ].join('\n'),
      },
    })
    expect(harness.manager.sessionReference('target-endpoint', 'session-gone'))
      .toMatchObject({ ok: false, code: 'not-found' })
    expect(harness.manager.sessionReference('endpoint-gone', 'session-a'))
      .toMatchObject({ ok: false, code: 'not-found' })
    harness.manager.stop()
  })

  /*
   * A paired peer is still another computer. Its answer used to be accepted after six field checks
   * and an assertion for the rest, so `sessions: [null]` travelled straight into the tree and threw
   * where the row was drawn - in the local window, from a remote machine's data.
   */
  it('refuses a sessions snapshot whose elements are not sessions', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    harness.manager.holdConnections('test')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')
    const transport = harness.transports[0]
    if (!transport) throw new Error('Transport was not created')

    transport.poisonSnapshot = true
    transport.snapshotRevision = 9
    transport.emitEvent(9)
    await harness.waitUntil(() =>
      harness.manager.snapshot().outbound[0]?.error?.detail === 'Remote sessions snapshot is invalid')

    expect(harness.manager.snapshot().outbound[0]?.sessions?.revision).toBe(1)
    harness.manager.stop()
  })

  /*
   * A refusal is the far end's own answer and it is final. The attachment used to stay behind it, so
   * the attachId was taken for good - every retry came back `already exists` - and each reconnect
   * re-opened a session that is not there.
   */
  it('frees the attachId when the far end refuses a terminal attach', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    harness.manager.holdConnections('test')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')
    const transport = harness.transports[0]
    if (!transport) throw new Error('Transport was not created')
    transport.refuseAttach = true

    const refused = await harness.manager.attachTerminal(
      'target-endpoint',
      'attach-a',
      { sessionId: 'session-gone', size: null },
      () => {},
    )
    expect(refused).toMatchObject({ ok: false, error: { code: 'not-found' } })

    transport.refuseAttach = false
    expect(await harness.manager.attachTerminal(
      'target-endpoint',
      'attach-a',
      { sessionId: 'session-a', size: null },
      () => {},
    )).toMatchObject({ ok: true })
    harness.manager.stop()
  })

  /*
   * The whole point of dialling on demand: starting the app reaches nobody. Before this, every
   * paired computer was dialled at boot and held open for the life of the process, so the sessions
   * tree drew a live row for a machine nobody had asked about.
   */
  it('dials nothing until something asks', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    expect(harness.dials).toEqual([])
    expect(harness.manager.snapshot().outbound[0]).toMatchObject({
      remoteEndpointId: 'target-endpoint',
      status: 'idle',
    })

    harness.manager.holdConnections('a-screen')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')
    expect(harness.dials).toEqual(['target-endpoint'])
    harness.manager.stop()
  })

  /* Two screens open at once are two holds, and the second closing is what hangs up. */
  it('hangs up once the last holder lets go, and not before', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    harness.manager.holdConnections('one')
    harness.manager.holdConnections('two')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')

    harness.manager.releaseConnections('one')
    await harness.settle()
    expect(harness.manager.snapshot().outbound[0]?.status).toBe('connected')

    harness.manager.releaseConnections('two')
    await harness.settle()

    expect(harness.manager.snapshot().outbound[0]).toMatchObject({
      status: 'idle',
      error: null,
      // Kept: it is history, and the settings row is where a person reads it.
      lastConnectedAt: harness.clock,
    })
    expect(harness.transports[0]?.isOpen()).toBe(false)
    harness.manager.stop()
  })

  /*
   * A command names a computer and knows nothing about connections. Refusing an idle one would have
   * made every CLI call depend on a window being open somewhere on the machine.
   */
  it('dials for a command sent to an idle computer, and hangs up after it', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()

    const answer = await harness.manager.execute('target-endpoint', {
      protocol: 'appjamat-v3-control.v1',
      requestId: 'request-a',
      operation: 'sessions.list',
      body: {},
    })

    expect(answer.ok).toBe(true)
    expect(harness.dials).toEqual(['target-endpoint'])
    await harness.settle()
    expect(harness.manager.snapshot().outbound[0]?.status).toBe('idle')
    harness.manager.stop()
  })

  it('takes a full sessions snapshot after an event revision gap', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    harness.manager.holdConnections('test')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')
    const transport = harness.transports[0]
    if (!transport) throw new Error('Transport was not created')
    transport.snapshotRevision = 7
    transport.emitEvent(3)
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.sessions?.revision === 7)
    expect(transport.sessionLists).toBe(2)
    harness.manager.stop()
  })

  it('stops terminal mutations after an exit frame', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    harness.manager.holdConnections('test')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')
    expect(await harness.manager.attachTerminal(
      'target-endpoint',
      'attach-a',
      { sessionId: 'session-a', size: null },
      () => undefined,
    )).toMatchObject({ ok: true })
    harness.transports[0]?.emitTerminalFrame('attach-a', {
      type: 'terminal.exit',
      runtimeSessionId: 'runtime-a',
      generation: 1,
      exitCode: 0,
    })
    expect(await harness.manager.terminalInput('target-endpoint', 'attach-a', 'ignored'))
      .toMatchObject({ ok: false, error: { code: 'unavailable' } })
    harness.manager.stop()
  })

  /*
   * What a paired computer runs, and what it offers beyond the operations every controller may
   * call. One question after the connection stands, and the reason nothing else has to ask: the
   * tree draws no row for a computer that is not connected, so this is what the settings screen
   * reads instead.
   */
  it('reads the version and the offered operations from one hello, dropping a name it does not know', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    harness.manager.holdConnections('test')
    await harness.waitUntil(() =>
      harness.manager.snapshot().outbound[0]?.applicationVersion !== null)

    expect(harness.manager.snapshot().outbound[0]).toMatchObject({
      status: 'connected',
      lastConnectedAt: harness.clock,
      nextRetryAt: null,
      applicationVersion: '2026.08.31.10.00',
      // `agents.forecast` was in the answer and is not in this build's list. A gate reads these, so
      // an operation nobody here can name must not arrive as one that is offered.
      optionalOperations: ['sessions.transcript'],
    })
    expect(harness.transports[0]?.hellos).toBe(1)
    harness.manager.stop()
  })

  /* An older computer grants no hello, which costs the two readings and not the connection. */
  it('stays connected to a computer that answers no hello', async () => {
    const harness = new RemoteConnectionsManagerTest(undefined, { offersHello: false })
    harness.manager.start()
    harness.manager.holdConnections('test')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    expect(harness.manager.snapshot().outbound[0]).toMatchObject({
      status: 'connected',
      applicationVersion: null,
      optionalOperations: null,
    })
    expect(harness.transports[0]?.hellos).toBe(0)
    harness.manager.stop()
  })

  /*
   * The wait between two dials, said as a moment rather than as a duration, and then dropped. The
   * screen that draws it is the only place a computer nothing answers at is drawn at all, and the
   * button beside it is for the person who has just started the far end or written the firewall
   * rule - they know what the backoff cannot.
   */
  it('says when the next dial is due, and dials at once when a person asks', async () => {
    const harness = new RemoteConnectionsManagerTest(undefined, { heldTimers: true })
    harness.refuseConnect = true
    harness.manager.start()
    harness.manager.holdConnections('test')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'offline')

    expect(harness.manager.snapshot().outbound[0]).toMatchObject({
      status: 'offline',
      lastConnectedAt: null,
      nextRetryAt: harness.clock + 30_000,
    })
    expect(harness.timers.map((timer) => timer.milliseconds)).toEqual([30_000])

    harness.manager.retryNow('endpoint-nobody-has')
    expect(harness.dials).toEqual(['target-endpoint'])

    harness.refuseConnect = false
    harness.clock += 5_000
    harness.manager.retryNow('target-endpoint')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')

    expect(harness.timers[0]?.cleared).toBe(true)
    expect(harness.dials).toEqual(['target-endpoint', 'target-endpoint'])
    expect(harness.manager.snapshot().outbound[0]).toMatchObject({
      lastConnectedAt: harness.clock,
      nextRetryAt: null,
    })
    harness.manager.stop()
  })

  it('keeps public renderer snapshots free of pinned keys and allows duplicate display names', async () => {
    const harness = new RemoteConnectionsManagerTest([
      RemoteConnectionsManagerTest.profile('profile-a', 'computer-a', 'endpoint-a'),
      RemoteConnectionsManagerTest.profile('profile-b', 'computer-b', 'endpoint-b'),
    ])
    harness.manager.start()
    harness.manager.holdConnections('test')
    await harness.waitUntil(() => harness.manager.snapshot().outbound.every((entry) =>
      entry.status === 'connected'))
    const snapshot = harness.manager.snapshot()
    expect(snapshot.outbound.map((entry) => entry.displayName)).toEqual(['Same name', 'Same name'])
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('pinnedIdentity')
    expect(serialized).not.toContain('publicKey')
    expect(serialized).not.toContain('privateKey')
    expect(serialized).not.toContain('token')
    harness.manager.stop()
  })
})

/** A reconnect that was scheduled and has not fired: the wait, and whether it was called off. */
interface RemoteConnectionsManagerTestTimer {
  milliseconds: number
  handle: ReturnType<typeof setTimeout>
  cleared: boolean
}

interface RemoteConnectionsManagerTestOptions {
  /**
   * Timers the test holds instead of the clock: nothing fires on its own, so a pending reconnect
   * stays pending and `retryNow` is the only thing that can move it.
   */
  heldTimers?: boolean
  /** A peer that grants no hello - an older computer, which is a refusal and not a failure. */
  offersHello?: boolean
}

class RemoteConnectionsManagerTest {
  readonly transports: RemoteConnectionsManagerTestTransport[] = []
  readonly timers: RemoteConnectionsManagerTestTimer[] = []
  readonly dials: string[] = []
  readonly manager: RemoteConnectionsManager
  /** Read through the dep, so both timestamps in the snapshot are exact rather than approximate. */
  clock = 1_700_000_000_000
  refuseConnect = false
  private requestSequence = 0

  constructor(
    profiles: readonly RemoteControlPeerProfile[] = [
      RemoteConnectionsManagerTest.profile('target-profile', 'target-computer', 'target-endpoint'),
    ],
    options: RemoteConnectionsManagerTestOptions = {},
  ) {
    const held = options.heldTimers === true
    this.manager = new RemoteConnectionsManager({
      identity: RemoteConnectionsManagerTest.identity('local-computer', 'local-endpoint'),
      profiles: () => profiles,
      connect: async (profile) => {
        this.dials.push(profile.remoteEndpointId)
        if (this.refuseConnect)
          return { ok: false, error: { code: 'unavailable', detail: 'Nothing answers there' } }
        const transport = new RemoteConnectionsManagerTestTransport(
          RemoteConnectionsManagerTest.identity(profile.remoteComputerId, profile.remoteEndpointId),
          `connection-${this.transports.length + 1}`,
          this.transports.length + 1,
          options.offersHello !== false,
        )
        this.transports.push(transport)
        return { ok: true, value: transport }
      },
      onChanged: () => {},
      onError: (message) => { throw new Error(message) },
      requestId: () => `request-${++this.requestSequence}`,
      operationId: () => `operation-${this.requestSequence}`,
      reconnectDelay: () => (held ? 30_000 : 0),
      // Zero, so a hang-up happens on the next macrotask rather than half a minute later. What the
      // real delay is worth is a judgement about people opening and closing cards, not a rule a
      // test can check.
      idleDelayMilliseconds: 0,
      now: () => this.clock,
      ...(held
        ? {
            // A real handle so the manager's own `unref` and `clearTimeout` are the ones being
            // exercised; what it would run is this test's to call, and it never runs by itself.
            setTimer: (_callback: () => void, milliseconds: number) => {
              const handle = setTimeout(() => undefined, 60_000)
              this.timers.push({ milliseconds, handle, cleared: false })
              return handle
            },
            clearTimer: (handle: ReturnType<typeof setTimeout>) => {
              clearTimeout(handle)
              const found = this.timers.find((timer) => timer.handle === handle)
              if (found) found.cleared = true
            },
          }
        : {}),
    })
  }

  /** One macrotask, which is what the zero-delay hang-up above waits for. */
  async settle(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  async waitUntil(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (condition()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`Remote manager test timed out: ${JSON.stringify(this.manager.snapshot())}`)
  }

  static profile(
    profileId: string,
    remoteComputerId: string,
    remoteEndpointId: string,
  ): RemoteControlPeerProfile {
    return {
      profileId,
      remoteComputerId,
      remoteEndpointId,
      configIdentity: `config-${remoteEndpointId}`,
      runtimeChannel: 'development',
      displayName: 'Same name',
      endpoint: { host: '127.0.0.1', port: 47_150 },
      pinnedIdentity: {
        algorithm: 'ed25519',
        publicKey: `${remoteEndpointId}a`.padEnd(64, 'a'),
        fingerprint: `${remoteEndpointId}b`.padEnd(43, 'b'),
      },
    }
  }

  static identity(remoteComputerId: string, remoteEndpointId: string): RemoteControlPeerIdentity {
    return {
      remoteComputerId,
      remoteEndpointId,
      configIdentity: `config-${remoteEndpointId}`,
      runtimeChannel: 'development',
      displayName: 'Same name',
      signing: {
        algorithm: 'ed25519',
        publicKey: `${remoteEndpointId}a`.padEnd(64, 'a'),
        fingerprint: `${remoteEndpointId}b`.padEnd(43, 'b'),
      },
    }
  }
}

class RemoteConnectionsManagerTestTransport implements RemoteControlPeerTransport {
  readonly capabilities: readonly RemoteControlPeerCapability[]
  private readonly messages = new Set<(message: RemoteControlPeerApplicationMessage) => void>()
  private readonly closes = new Set<() => void>()
  private open = true
  sessionLists = 0
  hellos = 0
  poisonSnapshot = false
  refuseAttach = false
  attachRequests = 0
  activeRequests = 0

  constructor(
    readonly remoteIdentity: RemoteControlPeerIdentity,
    readonly connectionId: string,
    public snapshotRevision: number,
    offersHello: boolean,
  ) {
    this.capabilities = [
      // A peer that grants no hello is a peer this side asks nothing of: the channel refuses the
      // call itself, which is how an older computer arrives rather than as a broken connection.
      ...(offersHello ? ['control:system.hello' as const] : []),
      'control:sessions.list',
      'socket:events.subscribe',
      'socket:terminal.attach',
      'socket:terminal.input',
      'socket:terminal.resize',
      'socket:terminal.active',
      'socket:terminal.detach',
    ]
  }

  isOpen(): boolean { return this.open }

  send(message: RemoteControlPeerApplicationMessage): boolean {
    if (!this.open) return false
    queueMicrotask(() => this.answer(message))
    return true
  }

  onMessage(listener: (message: RemoteControlPeerApplicationMessage) => void): () => void {
    this.messages.add(listener)
    return () => this.messages.delete(listener)
  }

  onClose(listener: () => void): () => void {
    this.closes.add(listener)
    return () => this.closes.delete(listener)
  }

  close(): void {
    if (!this.open) return
    this.open = false
    for (const listener of this.closes) listener()
  }

  emitEvent(revision: number): void {
    this.emit({
      type: 'socket-response',
      response: {
        protocol: 'appjamat-v3-control.v1',
        type: 'event',
        event: { revision, kind: 'sessions.changed', at: Date.now() },
      },
    })
  }

  emitTerminalFrame(attachId: string, frame: TerminalFrame): void {
    this.emit({
      type: 'socket-response',
      response: {
        protocol: 'appjamat-v3-control.v1',
        type: 'terminal.frame',
        attachId,
        frame,
        terminalOutputUntrusted: true,
      },
    })
  }

  private answer(message: RemoteControlPeerApplicationMessage): void {
    if (!this.open) return
    if (message.type === 'control-request') {
      if (message.request.operation === 'system.hello') {
        this.hellos += 1
        this.emit({
          type: 'control-response',
          response: {
            protocol: 'appjamat-v3-control.v1',
            requestId: message.request.requestId,
            operation: message.request.operation,
            operationId: null,
            ok: true,
            value: RemoteConnectionsManagerTestTransport.hello(),
          },
        })
        return
      }
      if (message.request.operation !== 'sessions.list')
        throw new Error(`Unexpected control operation: ${message.request.operation}`)
      this.sessionLists += 1
      this.emit({
        type: 'control-response',
        response: {
          protocol: 'appjamat-v3-control.v1',
          requestId: message.request.requestId,
          operation: message.request.operation,
          operationId: null,
          ok: true,
          value: this.poisonSnapshot
            // The cast is the test: a peer on another computer is under no obligation to send
            // what this type says, and the local side has to survive that.
            ? {
                ...RemoteConnectionsManagerTestTransport.snapshot(this.snapshotRevision),
                sessions: [null],
              } as unknown as SessionsSnapshot
            : RemoteConnectionsManagerTestTransport.snapshot(this.snapshotRevision),
        },
      })
    } else if (message.type === 'socket-request') {
      if (message.request.operation === 'terminal.attach') this.attachRequests += 1
      else if (message.request.operation === 'terminal.active') this.activeRequests += 1
      if (this.refuseAttach && message.request.operation === 'terminal.attach') {
        this.emit({
          type: 'socket-response',
          response: {
            protocol: 'appjamat-v3-control.v1',
            type: 'response',
            requestId: message.request.requestId,
            operation: message.request.operation,
            operationId: message.request.operationId,
            ok: false,
            error: { code: 'not-found', detail: 'No such session over there' },
          },
        })
        return
      }
      this.emit({
        type: 'socket-response',
        response: {
          protocol: 'appjamat-v3-control.v1',
          type: 'response',
          requestId: message.request.requestId,
          operation: message.request.operation,
          operationId: message.request.operation === 'events.subscribe'
            ? null
            : message.request.operationId,
          ok: true,
          value: message.request.operation === 'events.subscribe'
            ? { throughRevision: 0, truncated: false }
            : message.request.operation === 'terminal.attach'
              ? { attachId: message.request.attachId, sessionId: message.request.sessionId }
              : { attachId: message.request.attachId },
        },
      })
    } else if (message.type === 'control-response' || message.type === 'socket-response')
      throw new Error(`Unexpected response from manager: ${message.type}`)
    else
      throw new Error(`Unknown manager message: ${JSON.stringify(message)}`)
  }

  private emit(message: RemoteControlPeerApplicationMessage): void {
    for (const listener of this.messages) listener(message)
  }

  /**
   * What another computer says about itself. `agents.forecast` is deliberately NOT an operation
   * this build knows, and the cast is the test: a peer is under no obligation to send what this
   * type says, and a name this side has no gate for is dropped rather than kept or refused.
   */
  private static hello(): RemoteControlHelloDto {
    return {
      protocol: 'appjamat-v3-control.v1',
      configIdentity: 'config-target-endpoint',
      runtimeChannel: 'development',
      instanceId: 'instance-target',
      startedAt: 1_699_000_000_000,
      applicationVersion: '2026.08.31.10.00',
      operations: ['system.hello', 'sessions.list'],
      optionalOperations: ['sessions.transcript', 'agents.forecast'],
    } as unknown as RemoteControlHelloDto
  }

  private static snapshot(revision: number): SessionsSnapshot {
    return {
      revision,
      reconciled: true,
      host: {
        presence: 'running',
        hostVersion: 'test',
        hostInstanceId: 'host',
        liveCount: 0,
        lastStartError: null,
      },
      categories: [],
      sessions: [{
        sessionId: 'session-a',
        kind: 'agent',
        title: '014 remote work',
        titleParts: { number: '014', name: 'remote work' },
        tabTitle: 'Alpha - 014 remote work',
        directory: { mode: 'project', categoryId: 'code', projectPath: 'D:/code/Alpha' },
        project: {
          kind: 'project',
          categoryId: 'code',
          projectName: 'Alpha',
          projectPath: 'D:/code/Alpha',
        },
        agent: { agentId: 'codex', nativeSessionId: 'native-remote-1' },
        life: 'live',
        activity: 'idle',
        admits: [],
      }],
      orphans: [],
    }
  }
}
