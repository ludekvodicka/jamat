import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { WebSocketServer, type WebSocket } from 'ws'

import type {
  ControllerLeaseResult,
  HostDescriptor,
  HostEvent,
  HostEventPayload,
  HostHello,
  HostOpName,
  HostWsClientMsg,
  HostWsServerMsg,
  RuntimeListResult,
} from '../../../app-host/app/wire/hostWire.js'

export interface FakeHostAnswer {
  /** Anything other than 200 is answered as the Host answers a refusal: `{ error }` at that status. */
  status?: number
  body: unknown
  /** Written to the wire exactly as given, for the answers a client is not supposed to be able to read. */
  raw?: string
}

export type FakeHostOpHandler = (body: Record<string, unknown>) => FakeHostAnswer

export interface FakeHostCall {
  name: string
  body: Record<string, unknown>
}

export interface FakeHostOptions {
  hostInstanceId?: string
  leaseTtlMilliseconds?: number
}

/**
 * A Host on loopback that serves the shapes of `hostWire.ts` and nothing more: the token, the ops the
 * client calls, the controller lease with a TTL a test can shorten, and the events socket with its
 * replay window. It exists so a unit test can drive the real transport without a real Host, a real
 * PTY or a real machine state root.
 */
export class FakeHost {
  private static readonly defaultLeaseTtlMillisecondsConst = 15_000
  readonly calls: FakeHostCall[] = []
  /** The `afterRevision` of every `events.subscribe`, in order: the client's cursor, as sent. */
  readonly subscribes: number[] = []
  /** Every terminal frame a client sent, in order: what an attach asked for, typed. */
  readonly terminalFrames: Extract<HostWsClientMsg, { type: `terminal.${string}` }>[] = []
  private readonly handlers = new Map<HostOpName, FakeHostOpHandler>()
  private readonly holds = new Map<HostOpName, Promise<void>>()
  private readonly subscribers = new Set<WebSocket>()
  private readonly attached = new Set<WebSocket>()
  private readonly sockets = new Set<WebSocket>()
  private readonly webSocketServer = new WebSocketServer({ noServer: true })
  private readonly token = randomUUID()
  private events: HostEvent[] = []
  private revision = 0
  private lease: ControllerLeaseResult | null = null
  private leaseRefusedValue = false
  private portValue = 0
  private helloPatch: Partial<HostHello> = {}
  private helloHangs = false
  private helloCountValue = 0

  private constructor(
    private readonly server: Server,
    private readonly hostInstanceId: string,
    private readonly leaseTtlMilliseconds: number,
  ) {}

  static async start(options?: FakeHostOptions): Promise<FakeHost> {
    const server = createServer()
    const host = new FakeHost(
      server,
      options?.hostInstanceId ?? `fake-host-${randomUUID()}`,
      options?.leaseTtlMilliseconds ?? FakeHost.defaultLeaseTtlMillisecondsConst,
    )
    host.wire()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string')
      throw new Error('the fake Host did not bind a port')
    host.portValue = address.port
    return host
  }

  descriptor(): HostDescriptor {
    return {
      schemaVersion: 1,
      pid: process.pid,
      processStartedAt: 1,
      port: this.portValue,
      token: this.token,
      protocol: { major: 1, minor: 0 },
      capabilities: ['events.replay.v1', 'runtime.lifecycle.v1'],
      hostVersion: '0.0.0-fake',
      payloadHash: 'fake',
      configIdentity: 'fake-identity',
      runtimeChannel: 'development',
      hostInstanceId: this.hostInstanceId,
      hostGeneration: 'fake-generation',
      startedAt: 1,
    }
  }

  /** What `GET /hello` answers, which is the only route that carries the Host's build. */
  hello(): HostHello {
    return {
      app: 'jamat-host',
      protocol: { major: 1, minor: 0 },
      capabilities: ['events.replay.v1', 'runtime.lifecycle.v1'],
      buildInfo: {
        buildVersion: '0.0.0-fake',
        sourceRevision: 'fake-revision',
        platform: 'fake-platform',
        arch: 'fake-arch',
        hostWire: { major: 1, minor: 0 },
        capabilities: ['events.replay.v1', 'runtime.lifecycle.v1'],
        payloadHash: 'fake',
      },
      configIdentity: 'fake-identity',
      runtimeChannel: 'development',
      hostGeneration: 'fake-generation',
      process: {
        hostInstanceId: this.hostInstanceId,
        pid: process.pid,
        processStartedAt: 1,
        payloadHash: 'fake',
      },
      runtimes: { live: 0, dead: 0 },
      eventRevision: this.revision,
      ...this.helloPatch,
    }
  }

  /** Whatever a test needs this Host to claim about itself, over the defaults above. */
  setHello(patch: Partial<HostHello>): void {
    this.helloPatch = { ...this.helloPatch, ...patch }
  }

  /** Accepts the request and never answers it: what a Host too busy to talk looks like. */
  hangHello(hangs: boolean): void {
    this.helloHangs = hangs
  }

  /** Pings are counted apart from `calls`, which stays a list of operations. */
  helloCount(): number {
    return this.helloCountValue
  }

  /** Replaces one op for the rest of this fake Host's life; every other op keeps its default. */
  handle(name: HostOpName, handler: FakeHostOpHandler): void {
    this.handlers.set(name, handler)
  }

  /** Acquire answers 409 while this is on, the way a Host under another controller does. */
  refuseLease(refused: boolean): void {
    this.leaseRefusedValue = refused
    if (refused) this.lease = null
  }

  currentLeaseId(): string | null {
    return this.lease?.controllerLeaseId ?? null
  }

  publish(payload: HostEventPayload): HostEvent {
    this.revision += 1
    const event = { ...payload, revision: this.revision, timestamp: Date.now() } as HostEvent
    this.events.push(event)
    const frame = JSON.stringify({ type: 'event', event } satisfies HostWsServerMsg)
    for (const socket of this.subscribers) socket.send(frame)
    return event
  }

  /** Shrinks the replay window, which is what makes the next subscribe report `truncated`. */
  forgetEventsBefore(revision: number): void {
    this.events = this.events.filter((event) => event.revision >= revision)
  }

  /**
   * Hold the ANSWER of the next call of this op on the wire, so a test can put a landing response on
   * the far side of something else. What the op DOES has already happened when the caller parks.
   */
  hold(name: HostOpName): { release: () => void } {
    let open = (): void => {}
    this.holds.set(name, new Promise<void>((resolve) => { open = resolve }))
    return { release: () => open() }
  }

  subscriberCount(): number {
    return this.subscribers.size
  }

  attachedCount(): number {
    return this.attached.size
  }

  /** Whatever a test needs a live attach to receive, in the order it calls this. */
  pushTerminal(message: HostWsServerMsg): void {
    for (const socket of this.attached) FakeHost.send(socket, message)
  }

  /** Not JSON at all: what a client must survive without taking its process down. */
  pushUnreadable(): void {
    for (const socket of this.attached) socket.send('{ this is not a frame')
  }

  /** Kills the client connections and keeps serving: what a Host under load does, not a shutdown. */
  dropSockets(): void {
    for (const socket of this.sockets) socket.terminate()
    this.sockets.clear()
    this.subscribers.clear()
    this.attached.clear()
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate()
    this.sockets.clear()
    this.subscribers.clear()
    this.attached.clear()
    this.webSocketServer.close()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private wire(): void {
    this.server.on('request', (request, response) => void this.onRequest(request, response))
    this.server.on('upgrade', (request, socket, head) => {
      if (!this.authorized(request)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
        this.onWebSocket(webSocket))
    })
  }

  private async onRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorized(request)) {
      FakeHost.json(response, 401, { error: 'unauthorized' })
      return
    }
    const pathname = (request.url ?? '/').split('?')[0]
    if (request.method === 'GET' && pathname === '/hello') {
      this.helloCountValue += 1
      if (!this.helloHangs) FakeHost.json(response, 200, this.hello())
      return
    }
    if (!pathname.startsWith('/op/')) {
      FakeHost.json(response, 404, { error: 'not found' })
      return
    }
    const name = pathname.slice('/op/'.length) as HostOpName
    const body = JSON.parse(await FakeHost.readBody(request)) as Record<string, unknown>
    this.calls.push({ name, body })
    // The answer is computed BEFORE the gate on purpose: an acquire held here has already granted,
    // which is exactly the ordering the lease race is made of - the Host acted, the answer has not
    // reached the client.
    const answer = this.answer(name, body)
    const gate = this.holds.get(name)
    if (gate !== undefined) {
      this.holds.delete(name)
      await gate
    }
    if (answer.raw === undefined) FakeHost.json(response, answer.status ?? 200, answer.body)
    else FakeHost.text(response, answer.status ?? 200, answer.raw)
  }

  private answer(name: HostOpName, body: Record<string, unknown>): FakeHostAnswer {
    const handler = this.handlers.get(name)
    if (handler) return handler(body)
    if (name === 'controller.acquire') return this.acquire(body)
    else if (name === 'controller.renew') return this.renew(body)
    else if (name === 'controller.release') return this.release(body)
    else if (name === 'runtime.list')
      return {
        body: {
          sessions: [],
          throughRevision: this.revision,
          hostInstanceId: this.hostInstanceId,
        } satisfies RuntimeListResult,
      }
    else if (name === 'runtime.create'
      || name === 'runtime.replace'
      || name === 'runtime.inspect'
      || name === 'runtime.stop'
      || name === 'runtime.remove'
      || name === 'host.stop')
      // No runtimes here: a test that cares registers its own handler, and one that does not is
      // asking about the transport rather than about the answer.
      return { status: 501, body: { error: `${name} is not implemented by the fake Host` } }
    else
      throw new Error(`Unknown Host op: ${JSON.stringify(name)}`)
  }

  private acquire(body: Record<string, unknown>): FakeHostAnswer {
    if (this.leaseRefusedValue)
      return { status: 409, body: { error: 'Host is controlled by someone else' } }
    this.lease = {
      controllerLeaseId: this.lease?.controllerLeaseId ?? randomUUID(),
      controllerId: String(body.controllerId),
      expiresAt: Date.now() + this.leaseTtlMilliseconds,
    }
    return { body: this.lease }
  }

  private renew(body: Record<string, unknown>): FakeHostAnswer {
    if (this.lease === null || this.lease.controllerLeaseId !== body.controllerLeaseId)
      return { status: 409, body: { error: 'Controller lease is missing or expired' } }
    this.lease = { ...this.lease, expiresAt: Date.now() + this.leaseTtlMilliseconds }
    return { body: this.lease }
  }

  private release(body: Record<string, unknown>): FakeHostAnswer {
    if (this.lease === null || this.lease.controllerLeaseId !== body.controllerLeaseId)
      return { status: 409, body: { error: 'Controller lease does not match' } }
    this.lease = null
    return { body: {} }
  }

  private onWebSocket(socket: WebSocket): void {
    this.sockets.add(socket)
    socket.on('message', (raw: Buffer) => this.onFrame(socket, raw))
    socket.on('close', () => {
      this.sockets.delete(socket)
      this.subscribers.delete(socket)
      this.attached.delete(socket)
    })
  }

  private onFrame(socket: WebSocket, raw: Buffer): void {
    const frame = JSON.parse(raw.toString('utf8')) as HostWsClientMsg
    if (frame.type === 'events.subscribe')
      this.onSubscribe(socket, frame.afterRevision ?? 0)
    else if (frame.type === 'terminal.attach') {
      this.terminalFrames.push(frame)
      this.attached.add(socket)
      FakeHost.send(socket, {
        type: 'terminal.attached',
        writer: frame.role !== 'observer'
          && frame.controllerLeaseId === this.lease?.controllerLeaseId,
        session: {
          runtimeSessionId: frame.target.runtimeSessionId,
          generation: frame.target.generation,
          alive: true,
          cols: frame.cols ?? 80,
          rows: frame.rows ?? 24,
          outputSeq: 0,
          outputEpoch: 1,
          lastOutputAt: null,
          startedAt: 1,
        },
      })
    }
    else if (frame.type === 'terminal.detach') {
      this.terminalFrames.push(frame)
      this.attached.delete(socket)
    }
    else if (frame.type === 'terminal.input' || frame.type === 'terminal.resize')
      this.terminalFrames.push(frame)
    else
      throw new Error(`Unknown client frame: ${JSON.stringify((frame as { type: unknown }).type)}`)
  }

  private onSubscribe(socket: WebSocket, afterRevision: number): void {
    this.subscribers.add(socket)
    this.subscribes.push(afterRevision)
    const oldest = this.events[0]?.revision ?? this.revision + 1
    FakeHost.send(socket, {
      type: 'events.subscribed',
      throughRevision: this.revision,
      replay: this.events.filter((event) => event.revision > afterRevision),
      truncated: afterRevision < oldest - 1,
    })
  }

  private authorized(request: IncomingMessage): boolean {
    return request.headers.authorization === `Bearer ${this.token}`
  }

  private static send(socket: WebSocket, message: HostWsServerMsg): void {
    socket.send(JSON.stringify(message))
  }

  private static json(response: ServerResponse, status: number, body: unknown): void {
    FakeHost.text(response, status, JSON.stringify(body))
  }

  private static text(response: ServerResponse, status: number, payload: string): void {
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    })
    response.end(payload)
  }

  private static async readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    return text.length === 0 ? '{}' : text
  }
}
