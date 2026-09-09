import http from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'

import {
  HostWireConst,
  isHostOpName,
  isReadOnlyOp,
} from '../wire/hostWire.js'
import { HostHttpBodyReader } from './http/hostHttpBodyReader.js'
import { HostHttpResponse } from './http/hostHttpResponse.js'
import { HostOperationError } from './hostOperationError.js'
import type { HostOperationRouter } from './hostOperationRouter.js'
import type { HostTransportCallbacks } from './hostTransport.types.js'
import { HostRequestAuthorizer } from './security/hostRequestAuthorizer.js'

export class HostTransport {
  private static readonly maxWebSocketConnectionsConst = 64
  private readonly server = http.createServer((request, response) => {
    void this.handleHttp(request, response)
  })
  private readonly webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: HostWireConst.maxOpBodyBytes,
  })
  private readonly authorizer: HostRequestAuthorizer
  private port = 0

  constructor(
    token: string,
    private readonly router: HostOperationRouter,
    private readonly callbacks: HostTransportCallbacks,
    private readonly log: (message: string) => void,
  ) {
    this.authorizer = new HostRequestAuthorizer(token, log)
    this.server.on('upgrade', (request, socket, head) =>
      this.handleUpgrade(request, socket, head))
    this.webSocketServer.on('connection', (webSocket) =>
      this.callbacks.onWebSocket(webSocket))
  }

  get listening(): boolean {
    return this.server.listening
  }

  /** Binds loopback on an ephemeral port; the descriptor is what tells a client where to find it. */
  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string')
      throw new Error('failed to resolve bound port')
    this.port = address.port
    return this.port
  }

  async stop(): Promise<void> {
    for (const client of this.webSocketServer.clients)
      try { client.terminate() } catch { /* gone */ }
    try { this.webSocketServer.close() } catch { /* closed */ }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
      setTimeout(resolve, 1_500)
    })
  }

  private async handleHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const denied = this.authorizer.authorize(request, this.port)
    if (denied) {
      HostHttpResponse.json(response, { error: denied.message }, denied.status)
      return
    }

    const pathname = (request.url ?? '/').split('?')[0]
    try {
      if (request.method === 'GET' && pathname === '/hello') {
        HostHttpResponse.json(response, this.callbacks.hello())
        return
      }
      if (request.method !== 'POST' || !pathname.startsWith('/op/'))
        throw new HostOperationError(404, 'not found')

      const name = pathname.slice('/op/'.length)
      if (!isHostOpName(name)) throw new HostOperationError(404, `unknown op ${name}`)
      const parsed = await HostHttpBodyReader.readJson(request)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new HostOperationError(400, 'body must be a JSON object')
      const body = parsed as Record<string, unknown>
      if (!isReadOnlyOp(name)) this.log(`op ${name}`)

      const hungUp = new AbortController()
      response.on('close', () => {
        if (!response.writableEnded) hungUp.abort()
      })
      const result = await this.router.dispatch(name, body, hungUp.signal)
      if (!hungUp.signal.aborted) HostHttpResponse.json(response, result)
    } catch (error) {
      if (error instanceof HostOperationError) {
        HostHttpResponse.json(response, { error: error.message }, error.status)
        return
      }
      this.log(`ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      HostHttpResponse.json(response, { error: 'internal error' }, 500)
    }
  }

  private handleUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const denied = this.authorizer.authorize(request, this.port)
    if (denied) {
      socket.write(
        `HTTP/1.1 ${denied.status} ${denied.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n\r\n`,
      )
      socket.destroy()
      return
    }
    if (this.webSocketServer.clients.size >= HostTransport.maxWebSocketConnectionsConst) {
      this.log(
        `WARN refusing WS upgrade - ${HostTransport.maxWebSocketConnectionsConst} sockets already open`,
      )
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      socket.destroy()
      return
    }
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
      this.webSocketServer.emit('connection', webSocket, request))
  }
}
