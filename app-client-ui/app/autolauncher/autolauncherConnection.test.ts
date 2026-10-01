import { createHmac, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { AutolauncherConnection, type AutolauncherPairing } from './autolauncherConnection'

const key = 'ac'.repeat(32)
const token = 'ab'.repeat(32)
const failure = 'Pairing failed. Create a new invitation for this PC in MiniWolService and try again.'
const servers: Server[] = []
const intervals: ReturnType<typeof setInterval>[] = []

afterEach(async () => {
  for (const interval of intervals.splice(0)) clearInterval(interval)
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})

async function listen(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void): Promise<string> {
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => handler(request, response, body))
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback HTTP listener')
  return `http://127.0.0.1:${address.port}`
}

function invitation(origin: string): string {
  return `${origin}/#autolauncher=${token}`
}

function pairing(publicUrl = 'http://127.0.0.1:3511'): AutolauncherPairing {
  return { publicUrl, key, gatewayAddress: '127.0.0.1' }
}

describe('app-client-ui/app/autolauncher/autolauncherConnection', () => {
  it('redeems a one-time invitation using the exact JSON endpoint and headers', async () => {
    const received: { request: IncomingMessage; body: string }[] = []
    let consumed = false
    const origin = await listen((request, response, body) => {
      received.push({ request, body })
      response.writeHead(consumed ? 403 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(consumed ? { error: `private diagnostic ${key} ${token}` } : pairing()))
      consumed = true
    })
    const connection = new AutolauncherConnection()

    await expect(connection.pair(`  ${invitation(origin)}\n`)).resolves.toEqual(pairing())
    await expect(connection.pair(invitation(origin))).rejects.toMatchObject({ message: failure })
    expect(received).toHaveLength(2)
    for (const { request, body } of received) {
      expect(request.method).toBe('POST')
      expect(request.url).toBe('/api/launcher-pair')
      expect(body).toBe(JSON.stringify({ token }))
      expect(request.headers).toEqual({
        host: new URL(origin).host,
        connection: 'close',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      })
    }
  })

  it('rejects malformed invitations before contacting the service', async () => {
    let requests = 0
    const origin = await listen((_request, response) => {
      requests++
      response.end()
    })
    const connection = new AutolauncherConnection()
    const invalid: unknown[] = [
      undefined, null, {}, [], 42, '', 'x'.repeat(1025), origin,
      `${origin}/#autolauncher=${'AB'.repeat(32)}`, `${origin}/#autolauncher=${token.slice(1)}`,
      `${origin}/#autolauncher=${token}&other=x`, `${origin}/#token=${token}`,
      `${origin}/another#autolauncher=${token}`, `${origin}/?target=another#autolauncher=${token}`,
      invitation(origin.replace('http:', 'https:')), invitation(origin.replace('127.0.0.1', 'localhost')),
      invitation(origin.replace('http://', `http://user:${key}@`)),
    ]
    for (const value of invalid)
      await expect(connection.pair(value)).rejects.toThrow(/^(Paste the setup invitation from MiniWolService\.|The setup invitation is invalid\.)$/)
    expect(requests).toBe(0)
  })

  it('requires a strict pairing shape, a local PC address and the invitation gateway address', async () => {
    let body: unknown = pairing()
    const origin = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(body))
    })
    const connection = new AutolauncherConnection()
    const invalid: unknown[] = [
      null, [], {}, { publicUrl: pairing().publicUrl, key }, { ...pairing(), extra: true },
      { ...pairing(), key: 42 }, { ...pairing(), key: 'a'.repeat(63) }, { ...pairing(), key: 'g'.repeat(64) },
      { ...pairing(), publicUrl: 3511 }, { ...pairing(), publicUrl: `invalid URL with secret ${key}` },
      { ...pairing(), publicUrl: 'https://127.0.0.1:3511' }, { ...pairing(), publicUrl: 'http://localhost:3511' },
      { ...pairing(), publicUrl: 'http://[::1]:3511' }, { ...pairing(), publicUrl: 'http://127.0.0.1:3511/path' },
      { ...pairing(), publicUrl: 'http://127.0.0.1:3511/?profile=other' },
      { ...pairing(), publicUrl: 'http://127.0.0.1:3511/#fragment' },
      { ...pairing(), publicUrl: `http://user:${key}@127.0.0.1:3511` },
      { ...pairing(), publicUrl: 'http://203.0.113.254:3511' },
      { ...pairing(), gatewayAddress: '127.0.0.2' }, { ...pairing(), gatewayAddress: 'localhost' },
      { ...pairing(), gatewayAddress: '::1' }, { ...pairing(), gatewayAddress: 42 },
    ]
    for (body of invalid)
      await expect(connection.pair(invitation(origin))).rejects.toMatchObject({ message: failure })
    body = { ...pairing(), key: key.toUpperCase() }
    await expect(connection.pair(invitation(origin))).resolves.toEqual(body)
  })

  it('never follows redirects or discloses their destination in pairing errors', async () => {
    let followed = 0
    const destination = await listen((_request, response) => {
      followed++
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(pairing()))
    })
    let status = 302
    let requests = 0
    const origin = await listen((_request, response) => {
      requests++
      response.writeHead(status, { Location: `${destination}/private/${key}`, 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: `${key} ${token}` }))
    })
    const connection = new AutolauncherConnection()
    for (status of [301, 302, 303, 307, 308])
      await expect(connection.pair(invitation(origin))).rejects.toMatchObject({ message: failure })
    expect(requests).toBe(5)
    expect(followed).toBe(0)
  })

  it('rejects wrong HTTP status, response content type, compression and malformed UTF-8 or JSON', async () => {
    let status = 200
    let headers: Record<string, string> = { 'Content-Type': 'application/json' }
    let body: string | Buffer = JSON.stringify(pairing())
    const origin = await listen((_request, response) => {
      response.writeHead(status, headers)
      response.end(body)
    })
    const connection = new AutolauncherConnection()
    for (status of [201, 202, 401, 403, 500])
      await expect(connection.pair(invitation(origin))).rejects.toMatchObject({ message: failure })
    status = 200
    for (headers of [
      {}, { 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json; charset=utf-16' },
      { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      { 'Content-Type': 'application/json', 'Content-Encoding': 'identity' },
    ]) await expect(connection.pair(invitation(origin))).rejects.toMatchObject({ message: failure })
    headers = { 'Content-Type': 'application/json' }
    for (body of ['', '{', `{not-json ${key}`, Buffer.concat([Buffer.from('{"key":"'), Buffer.from([0xff]), Buffer.from('"}')])])
      await expect(connection.pair(invitation(origin))).rejects.toMatchObject({ message: failure })
  })

  it('bounds streamed responses at 16 KiB and accepts the exact byte limit', async () => {
    let size = 16 * 1024
    const origin = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.write(JSON.stringify(pairing()))
      response.end(' '.repeat(size - Buffer.byteLength(JSON.stringify(pairing()))))
    })
    const connection = new AutolauncherConnection()
    await expect(connection.pair(invitation(origin))).resolves.toEqual(pairing())
    size++
    await expect(connection.pair(invitation(origin))).rejects.toMatchObject({ message: failure })
  })

  it('times out stalled headers and continuously arriving partial bodies after three seconds', async () => {
    const silent = await listen(() => {})
    let closed = false
    const trickling = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.write('{')
      const interval = setInterval(() => response.write(' '), 100)
      intervals.push(interval)
      response.once('close', () => {
        closed = true
        clearInterval(interval)
      })
    })
    const connection = new AutolauncherConnection()
    const started = performance.now()
    await Promise.all([
      expect(connection.pair(invitation(silent))).rejects.toMatchObject({ message: failure }),
      expect(connection.pair(invitation(trickling))).rejects.toMatchObject({ message: failure }),
      expect(connection.probe(pairing(silent))).resolves.toBe(false),
    ])
    expect(performance.now() - started).toBeGreaterThanOrEqual(2800)
    expect(performance.now() - started).toBeLessThan(5500)
    await expect.poll(() => closed).toBe(true)
  }, 8000)

  it('authenticates each empty status probe with a fresh HMAC nonce and rejects a wrong key', async () => {
    const received: { request: IncomingMessage; body: string }[] = []
    const nonces = new Set<string>()
    let state = 'stopped'
    const origin = await listen((request, response, body) => {
      received.push({ request, body })
      response.setHeader('Content-Type', 'application/json')
      const timestamp = request.headers['x-jamat-timestamp']
      const nonce = request.headers['x-jamat-nonce']
      const signature = request.headers['x-jamat-signature']
      if (request.method !== 'GET' || request.url !== '/api/status' || body || request.headers.origin !== undefined
        || request.headers.host !== new URL(origin).host
        || typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 30000
        || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce) || nonces.has(nonce)
        || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) {
        response.writeHead(401)
        response.end(JSON.stringify({ error: `Invalid request ${key}` }))
        return
      }
      const expected = createHmac('sha256', Buffer.from(key, 'hex'))
        .update(`GET\n/api/status\n${timestamp}\n${nonce}`).digest()
      if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
        response.writeHead(401)
        response.end(JSON.stringify({ error: `Wrong key ${key}` }))
        return
      }
      nonces.add(nonce)
      response.end(JSON.stringify({ state, ...(state === 'failed' ? { error: 'The configured target did not start' } : {}) }))
    })
    const connection = new AutolauncherConnection()
    for (state of ['stopped', 'starting', 'ready', 'failed'])
      await expect(connection.probe(pairing(origin))).resolves.toBe(true)
    await expect(connection.probe({ ...pairing(origin), key: '34'.repeat(32) })).resolves.toBe(false)
    expect(nonces.size).toBe(4)
    expect(received).toHaveLength(5)
    for (const { request, body } of received) {
      expect(body).toBe('')
      expect(request.headers['transfer-encoding']).toBeUndefined()
      expect(Number(request.headers['content-length'] ?? 0)).toBe(0)
      expect(JSON.stringify(request.headers)).not.toContain(key)
    }
  })

  it('refuses malformed status shapes and redirected probes', async () => {
    let body: unknown
    let status = 200
    let requests = 0
    const origin = await listen((_request, response) => {
      requests++
      response.writeHead(status, { 'Content-Type': 'application/json', ...(status === 302 ? { Location: `${origin}/redirected` } : {}) })
      response.end(JSON.stringify(body))
    })
    const connection = new AutolauncherConnection()
    const invalid = [null, [], {}, { state: 'unknown' }, { state: 42 }, { state: ['ready'] },
      { state: 'ready', extra: true }, { state: 'ready', error: 42 }]
    for (body of invalid)
      await expect(connection.probe(pairing(origin))).resolves.toBe(false)
    status = 302
    body = { state: 'ready' }
    await expect(connection.probe(pairing(origin))).resolves.toBe(false)
    expect(requests).toBe(invalid.length + 1)
  })
})
