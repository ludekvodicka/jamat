import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

export interface RemoteControlHttpDenial {
  status: 401 | 403
  detail: 'unauthorized' | 'forbidden'
}

export type RemoteControlHttpBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 408 | 413; detail: string }

export class RemoteControlHttpBoundary {
  private static readonly maxBodyBytesConst = 1_048_576
  private static readonly bodyTimeoutMillisecondsConst = 15_000

  constructor(private readonly token: string) {
    if (token.length === 0)
      throw new Error('Remote control token must not be empty')
  }

  authorize(request: IncomingMessage, port: number): RemoteControlHttpDenial | null {
    const address = request.socket.remoteAddress
    if (address !== '127.0.0.1' && address !== '::ffff:127.0.0.1')
      return { status: 403, detail: 'forbidden' }
    if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== undefined)
      return { status: 403, detail: 'forbidden' }
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string'
      || !this.sameToken(authorization, `Bearer ${this.token}`))
      return { status: 401, detail: 'unauthorized' }
    return null
  }

  static readJson(request: IncomingMessage): Promise<RemoteControlHttpBodyResult> {
    const contentLength = request.headers['content-length']
    if (typeof contentLength === 'string') {
      const declared = Number(contentLength)
      if (!Number.isSafeInteger(declared) || declared < 0)
        return Promise.resolve({ ok: false, status: 400, detail: 'Invalid Content-Length' })
      if (declared > RemoteControlHttpBoundary.maxBodyBytesConst) {
        request.resume()
        return Promise.resolve({
          ok: false,
          status: 413,
          detail: `Request body exceeds ${RemoteControlHttpBoundary.maxBodyBytesConst} bytes`,
        })
      }
    }
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let bytes = 0
      let done = false
      const finish = (result: RemoteControlHttpBodyResult): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        request.resume()
        finish({ ok: false, status: 408, detail: 'Request body timed out' })
      }, RemoteControlHttpBoundary.bodyTimeoutMillisecondsConst)
      request.on('data', (chunk: Buffer | string) => {
        if (done) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > RemoteControlHttpBoundary.maxBodyBytesConst) {
          request.resume()
          finish({
            ok: false,
            status: 413,
            detail: `Request body exceeds ${RemoteControlHttpBoundary.maxBodyBytesConst} bytes`,
          })
          return
        }
        chunks.push(buffer)
      })
      request.on('end', () => {
        if (done) return
        try {
          finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch {
          finish({ ok: false, status: 400, detail: 'Request body must be valid JSON' })
        }
      })
      request.on('aborted', () =>
        finish({ ok: false, status: 400, detail: 'Request body was aborted' }))
      request.on('error', () =>
        finish({ ok: false, status: 400, detail: 'Request body could not be read' }))
    })
  }

  static json(response: ServerResponse, value: unknown, status = 200): void {
    if (response.writableEnded || response.destroyed) return
    const body = JSON.stringify(value)
    response.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    })
    response.end(body)
  }

  static refuseUpgrade(socket: Duplex, status: 401 | 403 | 404 | 503): void {
    const reason = status === 401
      ? 'Unauthorized'
      : status === 403
        ? 'Forbidden'
        : status === 404
          ? 'Not Found'
          : status === 503
            ? 'Service Unavailable'
            : RemoteControlHttpBoundary.unknownStatus(status)
    // Node removes its own `error` listener before emitting `upgrade`, so a write to a socket the
    // peer has already reset has nothing to catch it either.
    socket.on('error', () => undefined)
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }

  private sameToken(received: string, expected: string): boolean {
    const receivedBytes = Buffer.from(received)
    const expectedBytes = Buffer.from(expected)
    return receivedBytes.length === expectedBytes.length
      && timingSafeEqual(receivedBytes, expectedBytes)
  }

  private static unknownStatus(status: never): never {
    throw new Error(`Unknown upgrade status: ${JSON.stringify(status)}`)
  }
}
