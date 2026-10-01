import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import test from 'node:test'
import { createWolServer, parseConfig } from './server.mjs'

const key = 'ab'.repeat(32)
const publicUrl = 'http://127.0.0.1:9009'

/** @param {import('node:http').Server} server @param {import('node:test').TestContext} t @param {string} [host] */
async function listen(server, t, host = '127.0.0.1') {
  server.listen(0, host)
  await once(server, 'listening')
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

/** @param {string} origin @param {string} path @param {string} method @param {import('node:http').OutgoingHttpHeaders} headers @param {string | Buffer} [body] @param {string} [localAddress] */
function call(origin, path, method, headers, body = '', localAddress = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const url = new URL(origin)
    const req = request({ hostname: url.hostname, port: url.port, path, method, localAddress, agent: false,
      headers: { Host: new URL(publicUrl).host, ...headers } }, response => {
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

/** @param {import('node:test').TestContext} t @param {string} [host] */
async function setup(t, host) {
  const launcher = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"state":"stopped"}')
  })
  const launcherUrl = await listen(launcher, t)
  const config = parseConfig(JSON.stringify({ publicUrl, broadcast: '127.0.0.1', computers: [
    { id: 'first', label: 'First <PC>', mac: '02:11:22:33:44:55', launcher: { url: launcherUrl, key } },
    { id: 'wake-only', label: 'Wake only', mac: '02:11:22:33:44:56' },
  ] }))
  const server = createWolServer(config, undefined)
  const webUrl = await listen(server, t, host)
  const mint = async () => {
    const response = await call(webUrl, '/setup/first', 'POST', { Origin: publicUrl })
    assert.equal(response.status, 200)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.headers.location, undefined)
    const match = response.text.match(/<textarea[^>]*>(http:\/\/127\.0\.0\.1:9009\/#autolauncher=([0-9a-f]{64}))<\/textarea>/)
    assert.ok(match, 'The page must contain a copyable opaque invitation URL')
    assert.ok(!response.text.includes(key) && !response.text.includes(launcherUrl))
    assert.doesNotMatch(response.text, /"key"|"publicUrl"|<script/i)
    assert.match(response.text, /First &lt;PC&gt;/)
    assert.match(response.text, /5 minut/)
    return match[2]
  }
  /** @param {string} token @param {import('node:http').OutgoingHttpHeaders} [headers] @param {string} [localAddress] */
  const redeem = (token, headers = {}, localAddress) => call(webUrl, '/api/launcher-pair', 'POST',
    { 'Content-Type': 'application/json', ...headers }, JSON.stringify({ token }), localAddress)
  return { webUrl, launcherUrl, server, mint, redeem }
}

test('an invitation returns only the fixed launcher once to the matching PC over real HTTP', async t => {
  const { webUrl, launcherUrl, mint, redeem } = await setup(t)
  const token = await mint()
  for (const path of ['/', '/api/system/health', '/api/system/version']) {
    const page = await call(webUrl, path, 'GET', {})
    assert.equal(page.status, 200)
    assert.ok(!page.text.includes(key) && !page.text.includes(token) && !page.text.includes(launcherUrl))
  }
  const response = await redeem(token)
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['content-type'], 'application/json')
  assert.equal(response.headers.location, undefined)
  assert.deepEqual(JSON.parse(response.text), { publicUrl: launcherUrl, key, gatewayAddress: '127.0.0.1' })
  const replay = await redeem(token)
  assert.equal(replay.status, 403)
  assert.ok(!replay.text.includes(key) && !replay.text.includes(token) && !replay.text.includes(launcherUrl))
})

test('wrong source, token, expiry and replay deny identically without consuming a valid invitation', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const { mint, redeem } = await setup(t)
  const token = await mint()
  const unknown = await redeem('cd'.repeat(32))
  assert.equal(unknown.status, 403)
  const wrongSource = await redeem(token, { 'X-Forwarded-For': '127.0.0.1', Forwarded: 'for=127.0.0.1' }, '127.0.0.2')
  assert.equal(wrongSource.status, 403)
  assert.equal(wrongSource.text, unknown.text)
  assert.equal((await redeem(token)).status, 200)
  assert.equal((await redeem(token)).text, unknown.text)
  const expiring = await mint()
  now += 5 * 60 * 1000
  const expired = await redeem(expiring)
  assert.equal(expired.status, 403)
  assert.equal(expired.text, unknown.text)
  const valid = await mint()
  now += 5 * 60 * 1000 - 1
  assert.equal((await redeem(valid)).status, 200)
})

test('new invitations replace old ones and concurrent redeems succeed exactly once', async t => {
  const { mint, redeem } = await setup(t)
  const old = await mint()
  const fresh = await mint()
  assert.notEqual(old, fresh)
  assert.equal((await redeem(old)).status, 403)
  const responses = await Promise.all(Array.from({ length: 24 }, () => redeem(fresh)))
  assert.equal(responses.filter(response => response.status === 200).length, 1)
  assert.equal(responses.filter(response => response.status === 403).length, 23)
})

test('IPv4-mapped socket addresses redeem the configured IPv4 launcher', async t => {
  const { mint, redeem } = await setup(t, '::')
  assert.equal((await redeem(await mint())).status, 200)
})

test('replacing one PC invitation leaves another PC invitation usable', async t => {
  const secondKey = 'cd'.repeat(32)
  const config = parseConfig(JSON.stringify({ publicUrl, broadcast: '127.0.0.1', computers: [
    { id: 'first', label: 'First PC', mac: '02:11:22:33:44:55', launcher: { url: 'http://127.0.0.1:3511', key } },
    { id: 'second', label: 'Second PC', mac: '02:11:22:33:44:56', launcher: { url: 'http://127.0.0.2:3511', key: secondKey } },
  ] }))
  const webUrl = await listen(createWolServer(config, undefined), t)
  /** @param {string} id */
  const mint = async id => {
    const page = await call(webUrl, `/setup/${id}`, 'POST', { Origin: publicUrl })
    const match = page.text.match(/#autolauncher=([0-9a-f]{64})/)
    assert.equal(page.status, 200)
    assert.ok(match)
    assert.ok(!page.text.includes(key) && !page.text.includes(secondKey))
    return match[1]
  }
  const old = await mint('first')
  const other = await mint('second')
  await mint('first')
  const headers = { 'Content-Type': 'application/json' }
  assert.equal((await call(webUrl, '/api/launcher-pair', 'POST', headers, JSON.stringify({ token: old }))).status, 403)
  const response = await call(webUrl, '/api/launcher-pair', 'POST', headers, JSON.stringify({ token: other }), '127.0.0.2')
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.text), { publicUrl: 'http://127.0.0.2:3511', key: secondKey, gatewayAddress: '127.0.0.1' })
})

test('only a same-origin empty native form can issue a fixed-target invitation', async t => {
  const { webUrl, mint, redeem } = await setup(t)
  const token = await mint()
  for (const path of ['/setup/unknown', '/setup/wake-only', '/setup/first?target=other', '/setup/../setup/first'])
    assert.equal((await call(webUrl, path, 'POST', { Origin: publicUrl })).status, 404)
  assert.equal((await call(webUrl, '/setup/first', 'GET', { Origin: publicUrl })).status, 404)
  for (const origin of ['', 'http://attacker.test'])
    assert.equal((await call(webUrl, '/setup/first', 'POST', { Origin: origin })).status, 403)
  assert.equal((await call(webUrl, '/setup/first', 'POST', {})).status, 403)
  assert.equal((await call(webUrl, '/setup/first', 'POST', { Origin: publicUrl, Host: 'attacker.test' })).status, 421)
  for (const headers of [
    { 'Content-Length': '1' }, { 'Transfer-Encoding': 'chunked' }, { 'Content-Encoding': 'gzip' },
  ]) assert.equal((await call(webUrl, '/setup/first', 'POST', { Origin: publicUrl, ...headers }, 'x')).status, 400)
  assert.equal((await redeem(token)).status, 200, 'Rejected mint requests must not invalidate the outstanding invitation')
})

test('redemption rejects Host, Origin, malformed bodies, compression and nonexact targets', async t => {
  const { webUrl, mint, redeem } = await setup(t)
  const token = await mint()
  assert.equal((await redeem(token, { Host: 'attacker.test' })).status, 421)
  for (const origin of ['', publicUrl, 'null', 'http://attacker.test'])
    assert.equal((await redeem(token, { Origin: origin })).status, 403)
  for (const headers of [
    { 'Content-Type': '' }, { 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json; charset=utf-16' },
    { 'Content-Encoding': 'gzip' }, { 'Content-Encoding': 'identity' },
  ]) assert.equal((await redeem(token, headers)).status, 400)
  for (const body of [
    '', '{', 'null', '[]', '{}', '{"token":42}', JSON.stringify({ token: 'AB'.repeat(32) }),
    JSON.stringify({ token: token.slice(1) }), JSON.stringify({ token, url: 'http://127.0.0.2:3511' }),
    JSON.stringify({ token, key }), Buffer.concat([Buffer.from('{"token":"'), Buffer.from([0xff]), Buffer.from('"}')]),
  ]) {
    const response = await call(webUrl, '/api/launcher-pair', 'POST', { 'Content-Type': 'application/json' }, body)
    assert.equal(response.status, 400)
    assert.ok(!response.text.includes(key) && !response.text.includes(token))
  }
  for (const path of ['/api/launcher-pair?redirect=/other', '/api/launcher-pair/', '/api/../api/launcher-pair'])
    assert.equal((await call(webUrl, path, 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ token }))).status, 404)
  for (const path of [`${publicUrl}/api/launcher-pair`, 'http://attacker.test/api/launcher-pair', '//attacker.test/api/launcher-pair', '/api/launcher-pair#fragment'])
    assert.equal((await call(webUrl, path, 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ token }))).status, 400)
  assert.equal((await call(webUrl, '/api/launcher-pair', 'GET', {})).status, 404)
  assert.equal((await redeem(token, { 'Content-Type': 'application/json; charset=utf-8' })).status, 200)
})

test('body limits apply to both declared and streamed lengths without consuming the invitation', async t => {
  const { webUrl, mint, redeem } = await setup(t)
  const token = await mint()
  const body = JSON.stringify({ token }).padEnd(1025)
  for (const headers of [{ 'Content-Length': String(Buffer.byteLength(body)) }, { 'Transfer-Encoding': 'chunked' }])
    assert.equal((await call(webUrl, '/api/launcher-pair', 'POST', { 'Content-Type': 'application/json', ...headers }, body)).status, 400)
  const exact = await call(webUrl, '/api/launcher-pair', 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ token }).padEnd(1024))
  assert.equal(exact.status, 200)
  assert.equal((await redeem(token)).status, 403)
})

test('slow body readers have a deadline and bounded concurrency while health remains available', { timeout: 10000 }, async t => {
  const { webUrl, server, mint, redeem } = await setup(t)
  const token = await mint()
  const target = new URL(webUrl)
  /** @type {import('node:http').ClientRequest[]} */
  const stalled = []
  t.after(() => stalled.forEach(req => req.destroy()))
  const started = Date.now()
  const accepted = new Promise(resolve => {
    let count = 0
    server.on('request', () => {
      if (++count === 16)
        resolve(undefined)
    })
  })
  const pending = Array.from({ length: 16 }, () => new Promise((resolve, reject) => {
    const req = request({ hostname: target.hostname, port: target.port, path: '/api/launcher-pair', method: 'POST', agent: false,
      headers: { Host: new URL(publicUrl).host, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    req.on('error', reject)
    req.write('{')
    stalled.push(req)
  }))
  await accepted
  assert.equal((await redeem(token)).status, 503)
  assert.equal((await call(webUrl, '/api/system/health', 'GET', {})).status, 200)
  assert.deepEqual(await Promise.all(pending), Array(16).fill(400))
  assert.ok(Date.now() - started >= 2900)
  assert.ok(Date.now() - started < 4500)
  assert.equal((await redeem(token)).status, 200)
})
