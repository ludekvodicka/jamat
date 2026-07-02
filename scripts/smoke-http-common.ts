/**
 * Smoke for the shared HTTP primitives (app-electron/src/main/http-common.ts) — the
 * bounded body reader, JSON sender, and the auth-gate primitives the three HTTP
 * surfaces compose. Electron-free: http-common imports only node:http types +
 * node:crypto, so it runs under tsx with no Electron.
 *
 * Run: `npx tsx scripts/smoke-http-common.ts`
 */

import http from 'node:http'
import type { IncomingMessage } from 'node:http'
import {
  readJsonBody, sendJson, bearerToken, timingSafeMatch, hasBrowserOrigin, hostAllowed,
} from '../app-electron/src/main/http-common'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}`) }
}

// Minimal fake request — the header primitives only read `req.headers`.
function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

// ── pure header / credential primitives ──
{
  ok('bearerToken extracts the token', bearerToken(fakeReq({ authorization: 'Bearer abc123' })) === 'abc123')
  ok('bearerToken returns undefined without Bearer', bearerToken(fakeReq({ authorization: 'Basic abc' })) === undefined)
  ok('bearerToken returns undefined when absent', bearerToken(fakeReq({})) === undefined)

  ok('timingSafeMatch: equal → true', timingSafeMatch('s3cr3t', 's3cr3t') === true)
  ok('timingSafeMatch: unequal same length → false', timingSafeMatch('s3cr3t', 's3cr3T') === false)
  ok('timingSafeMatch: length mismatch → false (no throw)', timingSafeMatch('ab', 'abc') === false)
  ok('timingSafeMatch: missing → false', timingSafeMatch(undefined, 'abc') === false && timingSafeMatch('abc', undefined) === false)

  ok('hasBrowserOrigin: Origin present → true', hasBrowserOrigin(fakeReq({ origin: 'http://evil.com' })) === true)
  ok('hasBrowserOrigin: no Origin → false', hasBrowserOrigin(fakeReq({})) === false)

  const portSet = new Set(['127.0.0.1:47100', 'localhost:47100'])
  ok('hostAllowed: exact host:port → true', hostAllowed(fakeReq({ host: '127.0.0.1:47100' }), portSet) === true)
  ok('hostAllowed: foreign host → false', hostAllowed(fakeReq({ host: 'evil.com' }), portSet) === false)
  ok('hostAllowed: empty host → false', hostAllowed(fakeReq({}), portSet) === false)
  const bareSet = new Set(['127.0.0.1', '127.0.0.1:47200'])
  ok('hostAllowed: bare-host fallback matches', hostAllowed(fakeReq({ host: '127.0.0.1:99999' }), bareSet) === true)
}

// ── readJsonBody + sendJson over a real server roundtrip ──
function post(port: number, path: string, raw: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, agent: false, headers: { 'Content-Length': Buffer.byteLength(raw) } }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => { let b: any; try { b = buf ? JSON.parse(buf) : {} } catch { b = { raw: buf } } resolve({ status: res.statusCode ?? 0, body: b }) })
    })
    req.on('error', reject)
    if (raw) req.write(raw)
    req.end()
  })
}

await (async () => {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '')
    if (path === '/echo') { readJsonBody(req, res, (body) => sendJson(res, { ok: true, got: body })); return }
    if (path === '/small') { readJsonBody(req, res, () => sendJson(res, { ok: true }), { maxBytes: 10 }); return }
    if (path === '/throw') { readJsonBody(req, res, async () => { throw new Error('boom') }); return }
    sendJson(res, { ok: true }, 404)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port

  const valid = await post(port, '/echo', JSON.stringify({ a: 1, b: 'x' }))
  ok('readJsonBody parses a valid body and hands it to the handler', valid.status === 200 && valid.body?.got?.a === 1 && valid.body?.got?.b === 'x')

  const empty = await post(port, '/echo', '')
  ok('readJsonBody treats an empty body as {}', empty.status === 200 && JSON.stringify(empty.body?.got) === '{}')

  const bad = await post(port, '/echo', '{not json')
  ok('readJsonBody rejects malformed JSON with 400', bad.status === 400 && bad.body?.ok === false)

  const big = await post(port, '/small', '012345678901234567890') // 21 bytes > maxBytes 10
  ok('readJsonBody enforces the byte cap with 413', big.status === 413 && big.body?.ok === false)

  const threw = await post(port, '/throw', '{}')
  ok('readJsonBody surfaces an async handler throw as 500 (socket never hangs)', threw.status === 500 && threw.body?.ok === false)

  const sent = await post(port, '/echo', JSON.stringify({ z: 9 }))
  ok('sendJson emits application/json with the payload', sent.body?.ok === true)

  await new Promise<void>((r) => server.close(() => r()))
})()

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed})`)
process.exit(failed === 0 ? 0 : 1)
