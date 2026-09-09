import http from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocket, WebSocketServer, type RawData } from 'ws'

import type {
  RemoteControlPeerIdentity,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { RemoteControlPeerConst } from '../../../lib-orchestrator/remoteControl/remoteControlPeerProtocol'
import { RemoteControlPeerCodec } from '../../../lib-orchestrator/remoteControl/remoteControlPeerCodec'
import { RemoteControlPeerConnection } from '../../../lib-orchestrator/remoteControl/remoteControlPeerConnection'
import { RemoteControlPeerHandshakeError } from '../../../lib-orchestrator/remoteControl/core/remoteControlPeerHandshakeError'
import { ErrorText } from '../../shared/errorText'
import { RemoteControlPeerNonceStore } from './core/remoteControlPeerNonceStore'

export interface RemoteControlPeerServerDeps {
  identity: RemoteControlPeerIdentity
  sign(payload: Buffer): string
  trustedInbound(remoteComputerId: string, remoteEndpointId: string): RemoteControlPeerIdentity | null
  onConnection(connection: RemoteControlPeerConnection): void
  /**
   * An unknown caller that proved possession of the key it presented was refused. Fire and forget:
   * the socket is closed by the time this runs, and whatever this leads to reaches the caller only
   * on one of its later dials.
   */
  onUnknownPeer(claimant: RemoteControlPeerIdentity, remoteAddress: string): void
  /** The published PUBLIC pairing bundle as JSON text, or null while nothing is published. */
  pairingBundleText(): string | null
  onError(message: string): void
  handshakeTimeoutMilliseconds?: number
}

export interface RemoteControlPeerListenAddress {
  host: string
  port: number
}

interface PendingPeerHandshake {
  timer: ReturnType<typeof setTimeout>
  finished: boolean
}

export class RemoteControlPeerServer {
  private static readonly handshakeTimeoutMillisecondsConst = 10_000
  private static readonly maximumConnectionsConst = 64
  /*
   * The cheap half of this listener - opening a TCP connection and saying nothing - is reachable by
   * anyone, and it used to be able to hold all 64 slots until each handshake window expired, which
   * kept every paired computer out for as long as the flood lasted. Established peers have paid the
   * signature and nonce checks; unfinished handshakes now get a small allowance of their own.
   */
  private static readonly maximumPendingHandshakesConst = 8
  private static readonly pairingPathConst = '/api/v3/peer/pairing'
  private readonly nonceStore = new RemoteControlPeerNonceStore()
  private readonly server = http.createServer((request, response) => {
    if (request.method !== 'GET'
      || (request.url ?? '').split('?')[0] !== RemoteControlPeerServer.pairingPathConst) {
      response.writeHead(404, { 'Content-Length': '0' })
      response.end()
      return
    }
    const text = this.deps.pairingBundleText()
    if (text === null) {
      response.writeHead(503, { 'Content-Length': '0' })
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(text)
  })
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: RemoteControlPeerConst.maximumFrameBytes,
  })
  private readonly connections = new Set<RemoteControlPeerConnection>()
  private pendingHandshakes = 0
  private stopping = false

  constructor(private readonly deps: RemoteControlPeerServerDeps) {
    this.server.on('upgrade', (request, socket, head) => {
      if (this.stopping
        || this.sockets.clients.size >= RemoteControlPeerServer.maximumConnectionsConst
        || this.pendingHandshakes >= RemoteControlPeerServer.maximumPendingHandshakesConst) {
        RemoteControlPeerServer.refuse(socket, 503)
        return
      }
      if ((request.url ?? '').split('?')[0] !== '/api/v3/peer') {
        RemoteControlPeerServer.refuse(socket, 404)
        return
      }
      if (request.headers.origin !== undefined) {
        RemoteControlPeerServer.refuse(socket, 403)
        return
      }
      this.sockets.handleUpgrade(request, socket, head, (webSocket) =>
        this.sockets.emit('connection', webSocket, request))
    })
    this.server.on('clientError', (_error, socket) => socket.destroy())
    this.sockets.on('connection', (socket, request) =>
      this.beginHandshake(socket, request.socket.remoteAddress ?? ''))
  }

  start(host: string, port: number): Promise<RemoteControlPeerListenAddress> {
    if (this.stopping) return Promise.reject(new Error('Remote peer server is stopping'))
    if (this.server.listening) return Promise.reject(new Error('Remote peer server is already running'))
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => {
        this.server.off('error', reject)
        const address = this.server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('Remote peer server did not resolve its listen address'))
          return
        }
        resolve({ host, port: address.port })
      })
    })
  }

  beginStop(): void {
    if (this.stopping) return
    this.stopping = true
    for (const connection of this.connections) connection.close()
    this.connections.clear()
  }

  async stop(): Promise<void> {
    if (this.stopping && !this.server.listening) return
    this.beginStop()
    for (const socket of this.sockets.clients)
      try { socket.terminate() } catch {}
    try { this.sockets.close() } catch {}
    if (!this.server.listening) return
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
  }

  private beginHandshake(socket: WebSocket, remoteAddress: string): void {
    const pending: PendingPeerHandshake = {
      finished: false,
      timer: setTimeout(() => this.refuseHandshake(socket, pending),
        this.deps.handshakeTimeoutMilliseconds
          ?? RemoteControlPeerServer.handshakeTimeoutMillisecondsConst),
    }
    this.pendingHandshakes += 1
    const message = (data: RawData, isBinary: boolean): void => {
      if (pending.finished) return
      this.finishHandshake(pending)
      socket.off('message', message)
      try {
        if (isBinary) throw new Error('Peer hello must be JSON text')
        const codec = RemoteControlPeerCodec.acceptClientHello(JSON.parse(data.toString()), {
          identity: this.deps.identity,
          trustedInbound: (computerId, endpointId) =>
            this.deps.trustedInbound(computerId, endpointId),
          sign: (payload) => this.deps.sign(payload),
          acceptNonce: (computerId, nonce, sentAt) =>
            this.nonceStore.accept(computerId, nonce, sentAt),
        })
        const connection = new RemoteControlPeerConnection(socket, codec, {
          onError: (detail) => this.deps.onError(detail),
        })
        this.connections.add(connection)
        connection.onClose(() => this.connections.delete(connection))
        socket.send(JSON.stringify(codec.hello))
        this.deps.onConnection(connection)
      } catch (error) {
        if (error instanceof RemoteControlPeerHandshakeError && error.claimant !== undefined)
          this.deps.onUnknownPeer(error.claimant, remoteAddress)
        this.deps.onError(`Remote peer handshake refused: ${ErrorText.of(error)}`)
        try { socket.close(1008) } catch {}
      }
    }
    socket.once('message', message)
    /*
     * Registered with the other two, before any frame can arrive, because until
     * `RemoteControlPeerConnection` is built there is nothing else listening for `error` on this
     * socket. `ws` routes every receiver failure into `websocket.emit('error')`, and an emit with
     * no listener throws `ERR_UNHANDLED_ERROR` - which this process does not catch, so it exits.
     *
     * Reachable by anyone who can open a TCP connection: the listener binds `0.0.0.0` by default,
     * and a frame over `maxPayload`, one with a bad reserved bit or invalid UTF-8 text all take
     * this path BEFORE pairing, the signature check and the nonce check. No credential is involved.
     */
    socket.on('error', (error: Error) => {
      this.deps.onError(`Remote peer socket failed before its handshake: ${ErrorText.of(error)}`)
      this.finishHandshake(pending)
      socket.terminate()
    })
    socket.once('close', () => this.finishHandshake(pending))
  }

  private finishHandshake(pending: PendingPeerHandshake): void {
    if (pending.finished) return
    pending.finished = true
    clearTimeout(pending.timer)
    this.pendingHandshakes -= 1
  }

  private refuseHandshake(socket: WebSocket, pending: PendingPeerHandshake): void {
    if (pending.finished) return
    this.finishHandshake(pending)
    // `terminate`, not `close`: a client that never answers the close frame would otherwise hold
    // one of the connection slots long after its handshake window expired.
    socket.terminate()
  }

  private static refuse(socket: Duplex, status: 403 | 404 | 503): void {
    const reason = status === 403
      ? 'Forbidden'
      : status === 404
        ? 'Not Found'
        : status === 503
          ? 'Service Unavailable'
          : RemoteControlPeerServer.unknownStatus(status)
    // Node removes its own `error` listener before emitting `upgrade`, so a write to a socket the
    // peer has already reset has nothing to catch it either.
    socket.on('error', () => undefined)
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }

  private static unknownStatus(status: never): never {
    throw new Error(`Unknown peer server status: ${JSON.stringify(status)}`)
  }
}
