import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { LauncherTarget } from './launcherTarget'

export class LauncherServer {
  readonly server: Server
  private readonly publicUrl: URL
  private readonly key: Buffer
  private readonly target: LauncherTarget
  private readonly nonces = new Map<string, number>()

  constructor(publicUrl: URL, key: Buffer, target: LauncherTarget) {
    this.publicUrl = publicUrl
    this.key = key
    this.target = target
    this.server = createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      const end = (code: number, body: unknown): void => {
        response.writeHead(code, { Connection: 'close' })
        response.end(JSON.stringify(body))
      }
      if (request.headers.host !== this.publicUrl.host || request.headers.origin !== undefined)
        return end(403, { error: 'Forbidden' })
      if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0)
        return end(400, { error: 'Empty body required' })
      if (!this.authorized(request)) return end(401, { error: 'Unauthorized' })
      try {
        if (request.method === 'GET' && request.url === '/api/status')
          return end(200, await this.target.status())
        if (request.method === 'POST' && request.url === '/api/pause') {
          const ok = this.target.pause()
          return end(ok ? 200 : 409, { ok })
        }
        if (request.method === 'POST' && request.url === '/api/resume') {
          this.target.resume()
          return end(200, { ok: true })
        }
        if (request.method === 'POST' && request.url === '/api/start') {
          const status = await this.target.start()
          return end(status.state === 'ready' ? 200 : 202, status)
        }
        return end(404, { error: 'Not found' })
      } catch { return end(503, { error: 'Registered target unavailable' }) }
    })
    this.server.headersTimeout = 5000
    this.server.requestTimeout = 5000
    this.server.timeout = 5000
    this.server.maxHeadersCount = 30
  }

  private authorized(request: IncomingMessage): boolean {
    const timestamp = request.headers['x-jamat-timestamp']
    const nonce = request.headers['x-jamat-nonce']
    const signature = request.headers['x-jamat-signature']
    if (typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp)
      || Math.abs(Date.now() - Number(timestamp)) > 30_000
      || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)
      || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature))
      return false
    for (const [key, expiry] of this.nonces)
      if (expiry < Date.now()) this.nonces.delete(key)
    if (this.nonces.has(nonce) || this.nonces.size >= 2048) return false
    const expected = createHmac('sha256', this.key)
      .update(`${request.method}\n${request.url}\n${timestamp}\n${nonce}`).digest()
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return false
    this.nonces.set(nonce, Number(timestamp) + 30_000)
    return true
  }
}
