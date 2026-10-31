import assert from 'node:assert/strict'
import { createSocket, Socket } from 'node:dgram'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import test from 'node:test'
import { createWolServer, parseApiKey, parseConfig } from './server.mjs'
import { LauncherInvitations } from './pairing.mjs'

const fixture = {
  publicUrl: 'http://127.0.0.1:9009',
  broadcast: '127.0.0.1',
  computers: [
    { id: 'first', label: 'First <PC>', mac: '02:11:22:33:44:55' },
    { id: 'second', label: 'Second PC', mac: '02:66:77:88:99:aa' },
  ],
}

test('launcher status passes only known target errors while keeping old launchers readable', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  /** @type {string | undefined} */
  let error
  const agent = await listen(createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ state: 'failed', error }))
  }), t)
  const config = { ...fixture, computers: [{ ...fixture.computers[0], launcher: { url: agent, key: 'ab'.repeat(32) } }] }
  const origin = await listen(createWolServer(config, { apiKey: '0'.repeat(64) }), t)
  const headers = { Host: '127.0.0.1:9009', Authorization: `Bearer ${'0'.repeat(64)}` }
  for (const value of [undefined, 'target-missing', 'target-invalid', 'launch-failed', 'readiness-timeout', 'profile-unavailable', 'C:/private/path']) {
    error = value
    now += 1100
    const response = await httpCall(origin, '/api/v1/computers/first/launcher', 'GET', headers)
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(response.text), { state: 'failed',
      ...(value && value !== 'C:/private/path' ? { error: value } : {}) })
  }
})

test('the API key is required and must be exactly 64 lowercase hex characters', () => {
  for (const key of [undefined, '', '0'.repeat(63), 'AB'.repeat(32), 'g'.repeat(64), 42])
    assert.throws(() => parseApiKey(key), /JAMAT_V3_WOL_API_KEY/)
  assert.equal(parseApiKey('0'.repeat(64)), '0'.repeat(64))
})

test('keyed wake sends the selected packet once per cooldown and reports send failures', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const receiver = createSocket('udp4')
  t.after(() => receiver.close())
  receiver.bind(9, '127.0.0.1')
  await once(receiver, 'listening')
  let packets = 0
  receiver.on('message', () => packets++)
  const origin = await listen(createWolServer(parseConfig(JSON.stringify(fixture)), { apiKey: '0'.repeat(64) }), t)
  const headers = { Host: '127.0.0.1:9009', Authorization: `Bearer ${'0'.repeat(64)}` }
  const wake = () => httpCall(origin, '/api/v1/computers/second/wake', 'POST', headers)
  for (let i = 0; i < 2; i++) {
    const received = once(receiver, 'message', { signal: AbortSignal.timeout(2000) })
    const response = await wake()
    assert.equal(response.status, 202)
    assert.deepEqual(JSON.parse(response.text), { sent: true })
    const [packet] = await received
    assert.equal(packet.length, 102)
    assert.equal(packet.subarray(0, 6).toString('hex'), 'ffffffffffff')
    assert.equal(packet.subarray(6).toString('hex'), '0266778899aa'.repeat(16))
    const limited = await wake()
    assert.equal(limited.status, 429)
    assert.equal(limited.headers['retry-after'], '3')
    assert.deepEqual(JSON.parse(limited.text), { error: 'rate-limited' })
    assert.equal(packets, i + 1)
    now += 3000
  }
  t.mock.method(Socket.prototype, 'send', () => { throw new Error('synthetic UDP failure') })
  const failed = await wake()
  assert.equal(failed.status, 502)
  assert.deepEqual(JSON.parse(failed.text), { error: 'wol-send-failed' })
})

test('keyed starts coalesce and return only starting or ready, with bounded generic failures', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  let state = 'starting'
  let calls = 0
  const agent = createServer((_req, res) => {
    calls++
    res.writeHead(state === 'starting' ? 202 : 200, { 'Content-Type': 'application/json' })
    setImmediate(() => res.end(JSON.stringify({ state })))
  })
  const agentUrl = await listen(agent, t)
  const config = parseConfig(JSON.stringify({ ...fixture, computers: [
    { ...fixture.computers[0], launcher: { url: agentUrl, key: 'ab'.repeat(32) } }, fixture.computers[1],
  ] }))
  const origin = await listen(createWolServer(config, { apiKey: '0'.repeat(64) }), t)
  const headers = { Host: '127.0.0.1:9009', Authorization: `Bearer ${'0'.repeat(64)}` }
  const start = () => httpCall(origin, '/api/v1/computers/first/start', 'POST', headers)
  for (const response of await Promise.all([start(), start()])) {
    assert.equal(response.status, 202)
    assert.deepEqual(JSON.parse(response.text), { state: 'starting' })
  }
  assert.equal(calls, 1)
  now += 1001
  state = 'ready'
  const ready = await start()
  assert.equal(ready.status, 200)
  assert.deepEqual(JSON.parse(ready.text), { state: 'ready' })
  const absent = await httpCall(origin, '/api/v1/computers/second/start', 'POST', headers)
  assert.equal(absent.status, 409)
  assert.deepEqual(JSON.parse(absent.text), { error: 'no-launcher' })
  await new Promise(resolve => agent.close(resolve))
  now += 1001
  const unavailable = await start()
  assert.equal(unavailable.status, 502)
  assert.deepEqual(JSON.parse(unavailable.text), { error: 'launcher-unavailable' })
})

test('keyed invitations enforce cooldowns, replacement and per-computer isolation without logging secrets', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  /** @type {unknown[][]} */
  const logged = []
  /** @param {...unknown} args */
  const capture = (...args) => logged.push(args)
  t.mock.method(console, 'log', capture)
  t.mock.method(console, 'error', capture)
  const config = parseConfig(JSON.stringify({ ...fixture, computers: fixture.computers.map((pc, index) => ({
    ...pc, launcher: { url: `http://127.0.0.1:${index + 9010}`, key: 'ab'.repeat(32) },
  })) }))
  const origin = await listen(createWolServer(config, { apiKey: '0'.repeat(64) }), t)
  const headers = { Host: '127.0.0.1:9009', Authorization: `Bearer ${'0'.repeat(64)}` }
  /** @param {string} id */
  const mint = id => httpCall(origin, `/api/v1/computers/${id}/invitation`, 'POST', headers)
  /** @param {string} invitationUrl */
  const redeem = invitationUrl => httpCall(origin, '/api/launcher-pair', 'POST',
    { Host: headers.Host, 'Content-Type': 'application/json' }, JSON.stringify({ token: new URL(invitationUrl).hash.slice(14) }))
  const concurrent = await Promise.all([mint('first'), mint('first')])
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 429])
  const accepted = concurrent.find(response => response.status === 200)
  const refused = concurrent.find(response => response.status === 429)
  assert.ok(accepted && refused)
  const invitation = JSON.parse(accepted.text)
  assert.match(invitation.invitationUrl, /^http:\/\/127\.0\.0\.1:9009\/#autolauncher=[0-9a-f]{64}$/)
  assert.equal(invitation.expiresInSeconds, 300)
  assert.equal(refused.headers['retry-after'], '10')
  assert.deepEqual(JSON.parse(refused.text), { error: 'rate-limited' })
  const paired = await redeem(invitation.invitationUrl)
  assert.equal(paired.status, 200)
  assert.deepEqual(JSON.parse(paired.text), { publicUrl: 'http://127.0.0.1:9010', key: 'ab'.repeat(32), gatewayAddress: '127.0.0.1' })
  now += 10000
  const old = JSON.parse((await mint('first')).text)
  const other = JSON.parse((await mint('second')).text)
  now += 10000
  const fresh = JSON.parse((await mint('first')).text)
  assert.equal((await redeem(old.invitationUrl)).status, 403)
  assert.equal((await redeem(other.invitationUrl)).status, 200)
  assert.equal((await redeem(fresh.invitationUrl)).status, 200)
  await httpCall(origin, '/api/v1/computers/first/launcher', 'GET', headers)
  await httpCall(origin, '/api/v1/computers/first/start', 'POST', headers)
  await httpCall(origin, '/api/v1/computers/first/wake', 'POST', headers)
  assert.deepEqual(logged, [])
})

test('keyed read API exposes only the public inventory and closed launcher states', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  let state = 'ready'
  let calls = 0
  const agentUrl = await listen(createServer((_req, res) => {
    calls++
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ state }))
  }), t)
  const config = parseConfig(JSON.stringify({ ...fixture, computers: [
    { ...fixture.computers[0], launcher: { url: agentUrl, key: 'ab'.repeat(32) } }, fixture.computers[1],
  ] }))
  const origin = await listen(createWolServer(config, { apiKey: '0'.repeat(64) }), t)
  const headers = { Host: '127.0.0.1:9009', Authorization: `Bearer ${'0'.repeat(64)}` }
  /** @param {string} path @param {string} [method] @param {Record<string, string>} [extra] @param {string} [body] */
  const call = async (path, method = 'GET', extra = {}, body = '') => {
    const response = await httpCall(origin, path, method, { ...headers, ...extra }, body)
    assert.equal(response.headers['content-type'], 'application/json')
    assert.equal(response.headers['cache-control'], 'no-store')
    return response
  }
  const list = await call('/api/v1/computers')
  assert.equal(list.status, 200)
  assert.deepEqual(JSON.parse(list.text), { computers: [
    { id: 'first', label: 'First <PC>', hasLauncher: true },
    { id: 'second', label: 'Second PC', hasLauncher: false },
  ] })
  for (const privateValue of ['ab'.repeat(32), '0'.repeat(64), agentUrl, ...fixture.computers.map(pc => pc.mac)])
    assert.ok(!list.text.includes(privateValue))
  for (const authorization of ['', `Bearer ${'1'.repeat(64)}`, 'Bearer short', `Basic ${'0'.repeat(64)}`]) {
    const response = await call('/api/v1/computers/first/launcher', 'GET', { Authorization: authorization })
    assert.equal(response.status, 401)
    assert.deepEqual(JSON.parse(response.text), { error: 'unauthorized' })
  }
  assert.equal((await httpCall(origin, '/api/v1/computers', 'GET', { Host: headers.Host })).status, 401)
  for (const [path, method, extra, body, status, error] of [
    ['/api/v1/computers', 'GET', { Origin: '' }, '', 403, 'forbidden'],
    ['/api/v1/computers', 'GET', { 'Content-Length': '1' }, 'x', 400, 'bad-request'],
    ['/api/v1/computers', 'GET', { 'Content-Encoding': 'gzip' }, '', 400, 'bad-request'],
    ['/api/v1/computers', 'POST', {}, '', 405, 'method-not-allowed'],
    ['/api/v1/computers/nope/launcher', 'GET', {}, '', 404, 'unknown-computer'],
    ['/api/v1/other', 'GET', {}, '', 404, 'not-found'],
    ['/api/v1/computers?key=x', 'GET', {}, '', 404, 'not-found'],
    ['/api/v1/computers', 'GET', { Host: 'attacker.test' }, '', 421, 'forbidden'],
  ]) {
    const response = await call(String(path), String(method), /** @type {Record<string, string>} */ (extra), String(body))
    assert.equal(response.status, status)
    assert.deepEqual(JSON.parse(response.text), { error })
  }
  assert.equal(calls, 0)
  for (state of ['ready', 'stopped', 'starting', 'failed']) {
    now += 1001
    const response = await call('/api/v1/computers/first/launcher')
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(response.text), { state })
  }
  assert.deepEqual(JSON.parse((await call('/api/v1/computers/second/launcher')).text), { error: 'no-launcher' })
  assert.equal((await call('/api/v1/computers/second/launcher')).status, 409)
  const closed = createServer()
  const closedUrl = await listen(closed, t)
  await new Promise(resolve => closed.close(resolve))
  const offline = await listen(createWolServer({ ...config, computers: [
    { ...fixture.computers[0], launcher: { url: closedUrl, key: 'ab'.repeat(32) } },
  ] }, { apiKey: '0'.repeat(64) }), t)
  assert.deepEqual(JSON.parse((await httpCall(offline, '/api/v1/computers/first/launcher', 'GET', headers)).text), { state: 'unavailable' })
  for (const path of ['/api/system/health', '/api/system/version'])
    assert.equal((await httpCall(origin, path, 'GET', { Host: headers.Host })).status, 200)
})

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
      assert.doesNotMatch(response.headers['content-type'] ?? '', /text\/html/i)
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

test('real HTTP launcher calls authenticate the fixed target and preserve the API boundary', async t => {
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
  const webUrl = await listen(createWolServer(parseConfig(JSON.stringify(configured)), { apiKey: '0'.repeat(64) }), t)
  /** @param {string} path @param {string} [method] @param {Record<string, string>} [headers] @param {string} [body] */
  const call = (path, method = 'GET', headers = {}, body = '') => {
    // Independent fake replies must be read outside the previous call's cache window.
    now += 1001
    return httpCall(webUrl, path, method, { Host: '127.0.0.1:9009', Authorization: `Bearer ${'0'.repeat(64)}`, ...headers }, body)
  }

  await t.test('returns launcher state and keeps the key and agent address private', async () => {
    const response = await call('/api/v1/computers/first/launcher')
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(response.text), { state: 'stopped' })
    assert.ok(!response.text.includes(key) && !response.text.includes(agentUrl))
    assert.equal(response.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'")
    assert.deepEqual(calls, [{ method: 'GET', path: '/api/status', body: '' }])
  })
  await t.test('rejects unconfigured targets, GET, wrong Host/Origin, query and bodies before the PC call', async () => {
    const before = calls.length
    assert.equal((await call('/api/v1/computers/first/start')).status, 405)
    assert.equal((await call('/api/v1/computers/second/start', 'POST')).status, 409)
    assert.equal((await call('/api/v1/computers/other/start', 'POST')).status, 404)
    assert.equal((await call('/api/v1/computers/first/start?profile=other', 'POST')).status, 404)
    assert.equal((await call('/api/v1/computers/first/start', 'POST', { Host: 'attacker.test' })).status, 421)
    assert.equal((await call('/api/v1/computers/first/start', 'POST', { Origin: 'http://attacker.test' })).status, 403)
    assert.equal((await call('/api/v1/computers/first/start', 'POST', { Origin: '' })).status, 403)
    assert.equal((await call('/api/v1/computers/first/start', 'POST', { 'Content-Length': '1' }, 'x')).status, 400)
    assert.equal((await call('/api/v1/computers/first/start', 'POST', { 'Transfer-Encoding': 'chunked' })).status, 400)
    assert.equal(calls.length, before)
  })
  await t.test('posts an empty signed start and returns starting or already ready', async () => {
    for (const [status, state] of [[202, 'starting'], [200, 'ready']]) {
      reply = (req, response) => {
        response.statusCode = req.method === 'POST' ? Number(status) : 200
        response.end(JSON.stringify({ state }))
      }
      const response = await call('/api/v1/computers/first/start', 'POST')
      assert.equal(response.status, status)
      assert.equal(response.headers.location, undefined)
      assert.deepEqual(JSON.parse(response.text), { state })
      assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/start', body: '' })
      const responseState = await call('/api/v1/computers/first/launcher')
      assert.deepEqual(JSON.parse(responseState.text), { state })
    }
    assert.equal(nonces.size, calls.length)
  })
  await t.test('returns a closed failure state without reflecting PC diagnostics or keys', async () => {
    reply = (_req, response) => response.end(JSON.stringify({ state: 'failed', error: `<script>${key}</script>` }))
    const page = await call('/api/v1/computers/first/launcher')
    assert.deepEqual(JSON.parse(page.text), { state: 'failed' })
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
      const response = await call('/api/v1/computers/first/start', 'POST')
      assert.equal(response.status, 502)
      assert.deepEqual(JSON.parse(response.text), { error: 'launcher-unavailable' })
    }
    reply = (_req, response) => {
      response.setHeader('Content-Type', 'text/html')
      response.end('{"state":"ready"}')
    }
    assert.equal((await call('/api/v1/computers/first/start', 'POST')).status, 502)
    reply = (_req, response) => response.end(Buffer.concat([Buffer.from('{"state":"ready","error":"'), Buffer.from([0xff]), Buffer.from('"}')]))
    assert.equal((await call('/api/v1/computers/first/start', 'POST')).status, 502)
    reply = (_req, response) => response.end('{"state":"unknown"}')
    assert.deepEqual(JSON.parse((await call('/api/v1/computers/first/launcher')).text), { state: 'unavailable' })
  })
  await t.test('does not follow redirects or accept the wrong launcher key', async () => {
    const before = calls.length
    reply = (_req, response) => {
      response.writeHead(302, { Location: `${agentUrl}/redirected` })
      response.end()
    }
    assert.equal((await call('/api/v1/computers/first/start', 'POST')).status, 502)
    assert.equal(calls.length, before + 1)
    const wrong = { ...configured, computers: [{ ...fixture.computers[0], launcher: { url: agentUrl, key: 'cd'.repeat(32) } }] }
    const wrongUrl = await listen(createWolServer(parseConfig(JSON.stringify(wrong)), { apiKey: '0'.repeat(64) }), t)
    const page = await httpCall(wrongUrl, '/api/v1/computers/first/launcher', 'GET', { Host: '127.0.0.1:9009', Authorization: `Bearer ${'0'.repeat(64)}` })
    assert.deepEqual(JSON.parse(page.text), { state: 'unavailable' })
    assert.equal(calls.length, before + 1)
  })
})

test('concurrent status reads and starts share bounded PC calls, including failed replies', async t => {
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
  const webUrl = await listen(createWolServer(config, { apiKey: '0'.repeat(64) }), t)
  const headers = { Host: '127.0.0.1:9009', Authorization: `Bearer ${'0'.repeat(64)}` }
  /** @param {string} path @param {string} method */
  const burst = (path, method) => Promise.all(Array.from({ length: 40 }, () => httpCall(webUrl, path, method, headers)))

  for (const response of await burst('/api/v1/computers/first/launcher', 'GET'))
    assert.deepEqual(JSON.parse(response.text), { state: 'stopped' })
  await burst('/api/v1/computers/first/launcher', 'GET')
  assert.equal(statusCalls, 1)
  for (const response of await burst('/api/v1/computers/first/start', 'POST'))
    assert.equal(response.status, 202)
  await burst('/api/v1/computers/first/start', 'POST')
  assert.equal(startCalls, 1)
  for (const response of await burst('/api/v1/computers/first/launcher', 'GET'))
    assert.deepEqual(JSON.parse(response.text), { state: 'starting' })
  assert.equal(statusCalls, 2, 'Start must invalidate the cached stopped state')
  await burst('/api/v1/computers/first/launcher', 'GET')
  assert.equal(statusCalls, 2)

  now += 1001
  await burst('/api/v1/computers/first/launcher', 'GET')
  assert.equal(statusCalls, 3)
  await burst('/api/v1/computers/first/start', 'POST')
  assert.equal(startCalls, 2)

  fail = true
  for (const response of await burst('/api/v1/computers/first/launcher', 'GET'))
    assert.deepEqual(JSON.parse(response.text), { state: 'unavailable' })
  await burst('/api/v1/computers/first/launcher', 'GET')
  assert.equal(statusCalls, 4)
  now += 1001
  fail = false
  for (const response of await burst('/api/v1/computers/first/launcher', 'GET'))
    assert.deepEqual(JSON.parse(response.text), { state: 'starting' })
  assert.equal(statusCalls, 5, 'Failed status calls must be retried after one second')

  fail = true
  for (const response of await burst('/api/v1/computers/first/start', 'POST'))
    assert.equal(response.status, 502)
  await burst('/api/v1/computers/first/start', 'POST')
  assert.equal(startCalls, 3)
  now += 1001
  fail = false
  for (const response of await burst('/api/v1/computers/first/start', 'POST'))
    assert.equal(response.status, 202)
  assert.equal(startCalls, 4, 'Failed start calls must be retried after one second')
  assert.equal(nonces.size, statusCalls + startCalls)
})

test('offline launcher deadlines run in parallel and never gate wake packets or health', async t => {
  const stalled = createServer(() => {})
  const agentUrl = await listen(stalled, t)
  const config = parseConfig(JSON.stringify({ ...fixture,
    computers: fixture.computers.map(computer => ({ ...computer, launcher: { url: agentUrl, key: 'ab'.repeat(32) } })),
  }))
  const webUrl = await listen(createWolServer(config, { apiKey: '0'.repeat(64) }), t)
  const headers = { Host: '127.0.0.1:9009', Authorization: `Bearer ${'0'.repeat(64)}` }
  const receiver = createSocket('udp4')
  t.after(() => receiver.close())
  receiver.bind(9, '127.0.0.1')
  await once(receiver, 'listening')
  const started = Date.now()
  const loadingStates = Promise.all(config.computers.map(pc => httpCall(webUrl, `/api/v1/computers/${pc.id}/launcher`, 'GET', headers)))
  const received = once(receiver, 'message', { signal: AbortSignal.timeout(2000) })
  assert.equal((await httpCall(webUrl, '/api/v1/computers/first/wake', 'POST', headers)).status, 202)
  const [packet] = await received
  assert.equal(packet.subarray(6).toString('hex'), '021122334455'.repeat(16))
  assert.equal((await httpCall(webUrl, '/api/system/health', 'GET', headers)).status, 200)
  assert.ok(Date.now() - started < 2500)
  const responses = await loadingStates
  assert.deepEqual(responses.map(response => response.status), [200, 200])
  assert.deepEqual(responses.map(response => JSON.parse(response.text)), [{ state: 'unavailable' }, { state: 'unavailable' }])
  assert.ok(Date.now() - started >= 2900)
  assert.ok(Date.now() - started < 5500, 'Two unavailable PCs must share one three-second status window')
  const startRequested = Date.now()
  assert.equal((await httpCall(webUrl, '/api/v1/computers/first/start', 'POST', headers)).status, 502)
  assert.ok(Date.now() - startRequested >= 2900)
  assert.ok(Date.now() - startRequested < 4500)
})

test('removed page and form paths return JSON without any side effect', async t => {
  let launcherCalls = 0
  const launcherUrl = await listen(createServer((_req, res) => {
    launcherCalls++
    res.end()
  }), t)
  const issue = t.mock.method(LauncherInvitations.prototype, 'issue', () => { throw new Error('Unexpected invitation') })
  const send = t.mock.method(Socket.prototype, 'send', () => { throw new Error('Unexpected packet') })
  const config = parseConfig(JSON.stringify({ ...fixture, computers: [
    { ...fixture.computers[0], launcher: { url: launcherUrl, key: 'ab'.repeat(32) } },
  ] }))
  const origin = await listen(createWolServer(config, { apiKey: '0'.repeat(64), buildTime: '2026-09-30T00:00:00Z' }), t)
  const headers = { Host: '127.0.0.1:9009' }
  /** @type {Record<string, string>[]} */
  const callerHeaders = [{}, { Origin: fixture.publicUrl }, { Authorization: `Bearer ${'0'.repeat(64)}` }]
  for (const [path, method] of [['/', 'GET'], ['/web.css', 'GET'], ['/wake/first', 'POST'], ['/start/first', 'POST'], ['/setup/first', 'POST']]) {
    for (const extra of callerHeaders) {
      const response = await httpCall(origin, path, method, { ...headers, ...extra })
      assert.equal(response.status, 404)
      assert.equal(response.headers['content-type'], 'application/json')
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.deepEqual(JSON.parse(response.text), { error: 'not-found' })
    }
  }
  assert.deepEqual(JSON.parse((await httpCall(origin, '/api/system/health', 'GET', headers)).text), { ok: true })
  const { version } = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  assert.equal(version, '2.0.1')
  assert.deepEqual(JSON.parse((await httpCall(origin, '/api/system/version', 'GET', headers)).text), {
    version: '2.0.1', buildTime: '2026-09-30T00:00:00Z',
  })
  assert.equal(launcherCalls, 0)
  assert.equal(issue.mock.callCount(), 0)
  assert.equal(send.mock.callCount(), 0)
})
