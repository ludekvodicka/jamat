import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import test from 'node:test'
import { createWolServer, parseConfig } from './server.mjs'

const fixture = {
  publicUrl: 'http://127.0.0.1:9009',
  broadcast: '127.0.0.1',
  computers: [
    { id: 'first', label: 'First <PC>', mac: '02:11:22:33:44:55' },
    { id: 'second', label: 'Second PC', mac: '02:66:77:88:99:aa' },
  ],
}

test('rejects invalid configuration before opening a listener', () => {
  for (const config of [
    { ...fixture, broadcast: 'example.com' },
    { ...fixture, publicUrl: 'http://example.com:9009' },
    { ...fixture, publicUrl: 'http://127.0.0.1:9009/path' },
    { ...fixture, computers: [] },
    { ...fixture, computers: [fixture.computers[0], fixture.computers[0]] },
    { ...fixture, computers: [{ ...fixture.computers[0], mac: 'invalid' }] },
    { ...fixture, computers: [{ ...fixture.computers[0], id: '../other' }] },
  ]) assert.throws(() => parseConfig(JSON.stringify(config)))
})

test('validates optional fixed PC launcher configuration without exposing its values', () => {
  const launcher = { url: 'http://127.0.0.1:9010', key: 'ab'.repeat(32) }
  assert.throws(() => parseConfig(`{"key":"${launcher.key}" broken}`), { message: 'Config must contain valid JSON' })
  assert.equal(parseConfig(JSON.stringify(fixture)).computers[0].launcher, undefined)
  const parsed = parseConfig(JSON.stringify({ ...fixture, computers: [{ ...fixture.computers[0], launcher }] }))
  assert.deepEqual(parsed.computers[0].launcher, launcher)
  for (const invalid of [
    null, [], {}, { ...launcher, key: 'a'.repeat(63) }, { ...launcher, key: 'g'.repeat(64) },
    { ...launcher, key: 42 }, { ...launcher, url: 'not a URL' },
    { ...launcher, url: 'http://example.com:9010' }, { ...launcher, url: 'https://127.0.0.1:9010' },
    { ...launcher, url: 'http://127.0.0.1:9010/api' }, { ...launcher, url: 'http://127.0.0.1:9010/?key=x' },
    { ...launcher, url: 'http://127.0.0.1:9010/#x' }, { ...launcher, url: 'http://user:pass@127.0.0.1:9010' },
    { ...launcher, profile: 'another' },
  ]) assert.throws(() => parseConfig(JSON.stringify({ ...fixture, computers: [{ ...fixture.computers[0], launcher: invalid }] })))
})

/** @param {import('node:http').Server} server @param {import('node:test').TestContext} t */
async function listen(server, t) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

/** @param {string} origin @param {string} path @param {string} [method] @param {Record<string, string>} [headers] @param {string} [body] */
function httpCall(origin, path, method = 'GET', headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, origin), { method, headers, agent: false }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('real HTTP launcher calls authenticate the fixed target and preserve the web boundary', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const key = 'ab'.repeat(32)
  const nonces = new Set()
  /** @type {{method: string | undefined, path: string | undefined, body: string}[]} */
  const calls = []
  /** @type {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void} */
  let reply = (_request, response) => { response.end(JSON.stringify({ state: 'stopped' })) }
  const agent = createServer((req, res) => {
    const timestamp = req.headers['x-jamat-timestamp']
    const nonce = req.headers['x-jamat-nonce']
    const signature = req.headers['x-jamat-signature']
    if (req.headers.origin !== undefined || req.headers.host !== new URL(agentUrl).host
      || typeof timestamp !== 'string' || !/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 30000
      || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce) || nonces.has(nonce)
      || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) {
      res.writeHead(403)
      return res.end()
    }
    const expected = createHmac('sha256', Buffer.from(key, 'hex')).update(`${req.method}\n${req.url}\n${timestamp}\n${nonce}`).digest()
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) {
      res.writeHead(403)
      return res.end()
    }
    nonces.add(nonce)
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      calls.push({ method: req.method, path: req.url, body })
      if (body || !((req.method === 'GET' && req.url === '/api/status') || (req.method === 'POST' && req.url === '/api/start'))) {
        res.writeHead(400)
        return res.end()
      }
      res.setHeader('Content-Type', 'application/json')
      reply(req, res)
    })
  })
  const agentUrl = await listen(agent, t)
  const configured = { ...fixture, computers: [{ ...fixture.computers[0], launcher: { url: agentUrl, key } }, fixture.computers[1]] }
  const webUrl = await listen(createWolServer(parseConfig(JSON.stringify(configured)), undefined), t)
  /** @param {string} path @param {string} [method] @param {Record<string, string>} [headers] @param {string} [body] */
  const call = (path, method = 'GET', headers = {}, body = '') => {
    // Independent fake replies must be read outside the previous call's cache window.
    now += 1001
    return httpCall(webUrl, path, method, { Host: '127.0.0.1:9009', Origin: fixture.publicUrl, ...headers }, body)
  }

  await t.test('renders startup and setup forms and keeps the key and agent address private', async () => {
    const page = await call('/')
    assert.equal(page.status, 200)
    assert.equal((page.text.match(/<button /g) ?? []).length, 4)
    assert.match(page.text, /action="\/start\/first"/)
    assert.doesNotMatch(page.text, /action="\/start\/second"/)
    assert.match(page.text, /action="\/setup\/first"/)
    assert.doesNotMatch(page.text, /action="\/setup\/second"/)
    assert.match(page.text, /Jamat je vypnutý/)
    assert.match(page.text, /href="\/">Obnovit stav/)
    assert.ok(!page.text.includes(key) && !page.text.includes(agentUrl))
    assert.match(page.headers['content-security-policy'] ?? '', /default-src 'none'.*form-action 'self'.*frame-ancestors 'none'/)
    assert.deepEqual(calls, [{ method: 'GET', path: '/api/status', body: '' }])
  })
  await t.test('rejects unconfigured targets, GET, wrong Host/Origin, query and bodies before the PC call', async () => {
    const before = calls.length
    assert.equal((await call('/start/first')).status, 404)
    assert.equal((await call('/start/second', 'POST')).status, 404)
    assert.equal((await call('/start/other', 'POST')).status, 404)
    assert.equal((await call('/start/first?profile=other', 'POST')).status, 404)
    assert.equal((await call('/start/first', 'POST', { Host: 'attacker.test' })).status, 421)
    assert.equal((await call('/start/first', 'POST', { Origin: 'http://attacker.test' })).status, 403)
    assert.equal((await call('/start/first', 'POST', { Origin: '' })).status, 403)
    assert.equal((await call('/start/first', 'POST', { 'Content-Length': '1' }, 'x')).status, 400)
    assert.equal((await call('/start/first', 'POST', { 'Transfer-Encoding': 'chunked' })).status, 400)
    assert.equal(calls.length, before)
  })
  await t.test('posts an empty signed start and redirects for both starting and already ready', async () => {
    for (const [status, state] of [[202, 'starting'], [200, 'ready']]) {
      reply = (req, response) => {
        response.statusCode = req.method === 'POST' ? Number(status) : 200
        response.end(JSON.stringify({ state }))
      }
      const response = await call('/start/first', 'POST')
      assert.equal(response.status, 303)
      assert.equal(response.headers.location, '/?started=first')
      assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/start', body: '' })
      const page = await call(response.headers.location)
      assert.match(page.text, /na First &lt;PC&gt; byl přijat/)
      assert.match(page.text, state === 'starting' ? /Jamat se spouští/ : /Jamat je připravený/)
    }
    assert.equal(nonces.size, calls.length)
  })
  await t.test('shows a generic Czech failure without reflecting PC diagnostics or keys', async () => {
    reply = (_req, response) => response.end(JSON.stringify({ state: 'failed', error: `<script>${key}</script>` }))
    const page = await call('/')
    assert.match(page.text, /Spuštění Jamatu selhalo/)
    assert.ok(!page.text.includes(key))
    assert.doesNotMatch(page.text, /<script>/)
  })
  await t.test('rejects malformed JSON, shapes, state/status mismatches and oversized replies', async () => {
    for (const [status, body] of [
      [200, '{'], [200, 'null'], [200, '[]'], [200, '{"state":"unknown"}'],
      [200, '{"state":"ready","extra":true}'], [200, '{"state":"ready","error":42}'],
      [202, '{"state":"ready"}'], [200, '{"state":"starting"}'], [200, '{"state":"stopped"}'],
      [500, '{"state":"failed"}'], [200, JSON.stringify({ state: 'ready', error: 'x'.repeat(16384) })],
    ]) {
      reply = (_req, response) => {
        response.statusCode = Number(status)
        response.end(body)
      }
      const response = await call('/start/first', 'POST')
      assert.equal(response.status, 502)
      assert.match(response.text, /Jamat se nepodařilo spustit/)
    }
    reply = (_req, response) => {
      response.setHeader('Content-Type', 'text/html')
      response.end('{"state":"ready"}')
    }
    assert.equal((await call('/start/first', 'POST')).status, 502)
    reply = (_req, response) => response.end(Buffer.concat([Buffer.from('{"state":"ready","error":"'), Buffer.from([0xff]), Buffer.from('"}')]))
    assert.equal((await call('/start/first', 'POST')).status, 502)
    reply = (_req, response) => response.end('{"state":"unknown"}')
    assert.match((await call('/')).text, /Spouštěč Jamatu není dostupný/)
  })
  await t.test('does not follow redirects or accept the wrong launcher key', async () => {
    const before = calls.length
    reply = (_req, response) => {
      response.writeHead(302, { Location: `${agentUrl}/redirected` })
      response.end()
    }
    assert.equal((await call('/start/first', 'POST')).status, 502)
    assert.equal(calls.length, before + 1)
    const wrong = { ...configured, computers: [{ ...fixture.computers[0], launcher: { url: agentUrl, key: 'cd'.repeat(32) } }] }
    const wrongUrl = await listen(createWolServer(parseConfig(JSON.stringify(wrong)), undefined), t)
    const page = await httpCall(wrongUrl, '/', 'GET', { Host: '127.0.0.1:9009' })
    assert.match(page.text, /Spouštěč Jamatu není dostupný/)
    assert.equal(calls.length, before + 1)
  })
})

test('concurrent pages and starts share bounded PC calls, including failed replies', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  let statusCalls = 0
  let startCalls = 0
  let state = 'stopped'
  let fail = false
  const nonces = new Set()
  const agent = createServer((req, res) => {
    nonces.add(req.headers['x-jamat-nonce'])
    if (req.url === '/api/status')
      statusCalls++
    else if (req.url === '/api/start') {
      startCalls++
      state = 'starting'
    } else throw new Error('Unexpected PC endpoint')
    res.writeHead(fail ? 503 : req.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json' })
    setImmediate(() => res.end(JSON.stringify({ state })))
  })
  const agentUrl = await listen(agent, t)
  const config = parseConfig(JSON.stringify({ ...fixture,
    computers: [{ ...fixture.computers[0], launcher: { url: agentUrl, key: 'ab'.repeat(32) } }],
  }))
  const webUrl = await listen(createWolServer(config, undefined), t)
  const headers = { Host: '127.0.0.1:9009', Origin: fixture.publicUrl }
  /** @param {string} path @param {string} method */
  const burst = (path, method) => Promise.all(Array.from({ length: 40 }, (_, index) =>
    httpCall(webUrl, method === 'GET' ? `${path}?visit=${index}` : path, method, headers)))

  for (const response of await burst('/', 'GET'))
    assert.match(response.text, /Jamat je vypnutý/)
  await burst('/', 'GET')
  assert.equal(statusCalls, 1)
  for (const response of await burst('/start/first', 'POST'))
    assert.equal(response.status, 303)
  await burst('/start/first', 'POST')
  assert.equal(startCalls, 1)
  for (const response of await burst('/', 'GET'))
    assert.match(response.text, /Jamat se spouští/)
  assert.equal(statusCalls, 2, 'Start must invalidate the cached stopped state')
  await burst('/', 'GET')
  assert.equal(statusCalls, 2)

  now += 1001
  await burst('/', 'GET')
  assert.equal(statusCalls, 3)
  await burst('/start/first', 'POST')
  assert.equal(startCalls, 2)

  fail = true
  for (const response of await burst('/', 'GET'))
    assert.match(response.text, /Spouštěč Jamatu není dostupný/)
  await burst('/', 'GET')
  assert.equal(statusCalls, 4)
  now += 1001
  fail = false
  for (const response of await burst('/', 'GET'))
    assert.match(response.text, /Jamat se spouští/)
  assert.equal(statusCalls, 5, 'Failed status calls must be retried after one second')

  fail = true
  for (const response of await burst('/start/first', 'POST'))
    assert.equal(response.status, 502)
  await burst('/start/first', 'POST')
  assert.equal(startCalls, 3)
  now += 1001
  fail = false
  for (const response of await burst('/start/first', 'POST'))
    assert.equal(response.status, 303)
  assert.equal(startCalls, 4, 'Failed start calls must be retried after one second')
  assert.equal(nonces.size, statusCalls + startCalls)
})

test('offline launcher deadlines run in parallel and never gate wake packets or health', async t => {
  const stalled = createServer(() => {})
  const agentUrl = await listen(stalled, t)
  const config = parseConfig(JSON.stringify({ ...fixture,
    computers: fixture.computers.map(computer => ({ ...computer, launcher: { url: agentUrl, key: 'ab'.repeat(32) } })),
  }))
  const webUrl = await listen(createWolServer(config, undefined), t)
  const headers = { Host: '127.0.0.1:9009', Origin: fixture.publicUrl }
  const receiver = createSocket('udp4')
  t.after(() => receiver.close())
  receiver.bind(9, '127.0.0.1')
  await once(receiver, 'listening')
  const started = Date.now()
  const loadingPage = httpCall(webUrl, '/', 'GET', headers)
  const received = once(receiver, 'message', { signal: AbortSignal.timeout(2000) })
  assert.equal((await httpCall(webUrl, '/wake/first', 'POST', headers)).status, 303)
  const [packet] = await received
  assert.equal(packet.subarray(6).toString('hex'), '021122334455'.repeat(16))
  assert.equal((await httpCall(webUrl, '/api/system/health', 'GET', headers)).status, 200)
  assert.ok(Date.now() - started < 2500)
  const page = await loadingPage
  assert.equal(page.status, 200)
  assert.equal((page.text.match(/Spouštěč Jamatu není dostupný/g) ?? []).length, 2)
  assert.ok(Date.now() - started >= 2900)
  assert.ok(Date.now() - started < 5500, 'Two unavailable PCs must share one three-second status window')
  const startRequested = Date.now()
  assert.equal((await httpCall(webUrl, '/start/first', 'POST', headers)).status, 502)
  assert.ok(Date.now() - startRequested >= 2900)
  assert.ok(Date.now() - startRequested < 4500)
})

test('real HTTP forms send only the selected computer’s UDP magic packet', async t => {
  const receiver = createSocket('udp4')
  t.after(() => receiver.close())
  receiver.bind(9, '127.0.0.1')
  await once(receiver, 'listening')
  /** @type {Buffer[]} */
  const packets = []
  receiver.on('message', packet => packets.push(packet))
  const server = createWolServer(parseConfig(JSON.stringify(fixture)), '2026-09-30T00:00:00Z')
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port

  /** @param {string} path @param {string} [method] @param {Record<string, string>} [headers] @param {string} [body] */
  function call(path, method = 'GET', headers = {}, body = '') {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method,
        headers: { Host: '127.0.0.1:9009', Origin: fixture.publicUrl, ...headers } }, res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  await t.test('renders exactly two accessible forms and escapes labels', async () => {
    const response = await call('/')
    assert.equal(response.status, 200)
    assert.equal((response.text.match(/<button /g) ?? []).length, 2)
    assert.match(response.text, /First &lt;PC&gt;/)
    assert.match(response.text, /action="\/wake\/second"/)
    assert.equal((await call('/web.css')).status, 200)
  })
  await t.test('rejects arbitrary targets, GET wake, cross-origin requests and request bodies', async () => {
    assert.equal((await call('/wake/first')).status, 404)
    assert.equal((await call('/wake/other', 'POST')).status, 404)
    assert.equal((await call('/wake/first', 'POST', { Origin: 'http://attacker.test' })).status, 403)
    assert.equal((await call('/wake/first', 'POST', { Origin: '' })).status, 403)
    assert.equal((await call('/wake/first', 'POST', { Host: 'attacker.test' })).status, 421)
    assert.equal((await call('/wake/first', 'POST', { 'Content-Length': '1' }, 'x')).status, 400)
    assert.equal(packets.length, 0)
  })
  await t.test('sends the second MAC on UDP port 9 and redirects after success', async () => {
    const received = once(receiver, 'message', { signal: AbortSignal.timeout(3000) })
    const response = await call('/wake/second', 'POST')
    const [packet] = await received
    assert.equal(response.status, 303)
    assert.equal(response.headers.location, '/?sent=second')
    assert.equal(packet.length, 102)
    assert.equal(packet.subarray(0, 6).toString('hex'), 'ffffffffffff')
    assert.equal(packet.subarray(6).toString('hex'), '0266778899aa'.repeat(16))
    const page = await call(response.headers.location)
    assert.match(page.text, /Probuzení počítače zatím není ověřené/)
    assert.equal(packets.length, 1)
  })
  await t.test('publishes the packaged version and build time without sending packets', async () => {
    assert.deepEqual(JSON.parse((await call('/api/system/health')).text), { ok: true })
    assert.deepEqual(JSON.parse((await call('/api/system/version')).text), {
      version: '1.2.0', buildTime: '2026-09-30T00:00:00Z',
    })
    assert.equal(packets.length, 1)
  })
})
