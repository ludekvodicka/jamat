import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { App } from './app.js';
import { AppContext } from './appContext.js';
import type { RelayConfig } from './appConfig.js';

test('wake service is authenticated, optional and independent of the PC registry', async t => {
  let upstreamStatus = 200;
  let launcherState = 'stopped';
  let launcherError: string | undefined;
  let wakeLimited = false;
  let startStatus = 202;
  let startBody = { state: 'starting' } as { state?: string; error?: string };
  let invitationUrl = '';
  let invitationLimited = false;
  const calls: string[] = [];
  const upstream = createServer((req, res) => {
    calls.push(req.url!);
    assert.equal(req.headers.authorization === `Bearer ${'0'.repeat(64)}`, true);
    assert.equal(req.headers.origin, undefined);
    if (req.url === '/api/v1/computers/office/invitation') {
      assert.equal(req.method, 'POST');
      res.writeHead(invitationLimited ? 429 : 200, { 'Content-Type': 'application/json', 'Retry-After': '10' });
      res.end(JSON.stringify(invitationLimited ? { error: 'rate-limited' } : { invitationUrl, expiresInSeconds: 300 }));
      return;
    }
    if (req.url === '/api/v1/computers/office/start') {
      assert.equal(req.method, 'POST');
      res.writeHead(startStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(startBody));
      return;
    }
    if (req.url === '/api/v1/computers/laptop/wake') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown-computer' }));
      return;
    }
    if (req.url === '/api/v1/computers/office/wake') {
      assert.equal(req.method, 'POST');
      res.writeHead(wakeLimited ? 429 : 202, { 'Content-Type': 'application/json', 'Retry-After': '3' });
      res.end(JSON.stringify(wakeLimited ? { error: 'rate-limited' } : { sent: true }));
      return;
    }
    if (req.url === '/api/v1/computers/office/launcher') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: launcherState, error: launcherError }));
      return;
    }
    res.writeHead(upstreamStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(upstreamStatus === 401 ? { error: 'unauthorized' } : req.url === '/api/v1/computers'
      ? { computers: [{ id: 'office', label: 'Local', hasLauncher: true }, { id: 'extra', hasLauncher: false }] }
      : { version: '2.0.0' }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const config: RelayConfig = { origin: 'http://127.0.0.1', port: 0, username: 'admin',
    password: 'synthetic-password-for-local-tests-only', allowedEmails: [], buildTime: 'test',
    miniWol: { origin: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, apiKey: '0'.repeat(64) },
    pcs: [{ id: 'office', label: 'Local PC', ip: '127.0.0.1', agentPort: 1 },
      { id: 'laptop', label: 'Other PC', ip: '127.0.0.1', agentPort: 1 }] };
  const app = new App(config, new AppContext(new URL('../web/', import.meta.url)));
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => { app.server.closeAllConnections(); app.server.close(); });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const { request } = await import('node:http');
  const send = (path: string, cookie = '', body?: string, withOrigin = true) => new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { host: new URL(config.origin).host, cookie, ...(withOrigin ? { origin: config.origin } : {}), 'content-type': 'application/x-www-form-urlencoded' } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const anonymous = await send('/api/wake-service');
  assert.equal(anonymous.status, 401);
  assert.deepEqual(JSON.parse(anonymous.body), { error: 'Authentication required', loginUrl: '/login' });
  assert.equal(calls.length, 0);
  const form = await send('/login');
  const csrf = form.body.match(/name="csrf" value="([^"]+)"/)![1];
  const login = await send('/auth/password', form.headers['set-cookie']![0].split(';')[0],
    new URLSearchParams({ username: config.username, password: config.password, csrf }).toString());
  assert.equal(login.status, 303);
  const cookie = login.headers['set-cookie']![0].split(';')[0];
  const state = await send('/api/wake-service', cookie);
  assert.deepEqual(JSON.parse(state.body), { state: 'ready', version: '2.0.0', computers: [{ id: 'office', hasLauncher: true }] });
  assert.equal(state.body.includes('0'.repeat(64)), false);
  upstreamStatus = 401;
  assert.deepEqual(JSON.parse((await send('/api/wake-service', cookie)).body), { state: 'key-rejected' });
  assert.deepEqual(JSON.parse((await send('/api/pcs', cookie)).body), { pcs: [{ id: 'office', label: 'Local PC' }, { id: 'laptop', label: 'Other PC' }] });
  upstreamStatus = 200;
  await t.test('wake passes POST, requires Origin, scopes relay IDs and maps upstream failures', async () => {
    const before = calls.length;
    assert.equal((await send('/api/wake-service/office/wake', cookie, '', false)).status, 403);
    assert.equal((await send('/api/wake-service/nope/wake', cookie, '')).status, 404);
    assert.equal(calls.length, before);
    const wake = await send('/api/wake-service/office/wake', cookie, '');
    assert.equal(wake.status, 202);
    assert.deepEqual(JSON.parse(wake.body), { sent: true });
    assert.equal(calls.at(-1), '/api/v1/computers/office/wake');
    const absent = await send('/api/wake-service/laptop/wake', cookie, '');
    assert.equal(absent.status, 404);
    assert.deepEqual(JSON.parse(absent.body), { problem: 'unknown-computer' });
    wakeLimited = true;
    const limited = await send('/api/wake-service/office/wake', cookie, '');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers['retry-after'], '3');
    assert.deepEqual(JSON.parse(limited.body), { problem: 'rate-limited', retryAfter: 3 });
  });
  await t.test('launcher passes every closed state', async () => {
    for (const state of ['ready', 'stopped', 'starting', 'failed', 'unavailable']) {
      launcherState = state;
      const response = await send('/api/wake-service/office/launcher', cookie);
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.body), { state });
    }
  });
  await t.test('launcher forwards safe failure detail and strips private upstream text', async () => {
    launcherState = 'failed';
    launcherError = 'target-missing';
    assert.deepEqual(JSON.parse((await send('/api/wake-service/office/launcher', cookie)).body), { state: 'failed', error: 'target-missing' });
    launcherError = 'C:/private/secret.exe';
    assert.deepEqual(JSON.parse((await send('/api/wake-service/office/launcher', cookie)).body), { state: 'failed' });
    launcherError = undefined;
  });
  await t.test('start passes 202 starting and 200 ready, protects Origin and maps failures', async () => {
    const before = calls.length;
    assert.equal((await send('/api/wake-service/office/start', cookie, '', false)).status, 403);
    assert.equal(calls.length, before);
    for (const [status, state] of [[202, 'starting'], [200, 'ready']] as const) {
      startStatus = status;
      startBody = { state };
      const response = await send('/api/wake-service/office/start', cookie, '');
      assert.equal(response.status, status);
      assert.deepEqual(JSON.parse(response.body), { state });
    }
    for (const [status, error] of [[502, 'launcher-unavailable'], [409, 'no-launcher']] as const) {
      startStatus = status;
      startBody = { error };
      const response = await send('/api/wake-service/office/start', cookie, '');
      assert.equal(response.status, status);
      assert.deepEqual(JSON.parse(response.body), { problem: error });
    }
    startStatus = 202;
    startBody = { state: 'ready' };
    assert.deepEqual(JSON.parse((await send('/api/wake-service/office/start', cookie, '')).body), { problem: 'protocol-error' });
  });
  await t.test('invitation passes unchanged with no-store, validates its origin and rate limit', async () => {
    const before = calls.length;
    assert.equal((await send('/api/wake-service/office/invitation', cookie, '', false)).status, 403);
    assert.equal(calls.length, before);
    const valid = `${config.miniWol!.origin}/#autolauncher=${'a'.repeat(64)}`;
    invitationUrl = valid;
    const response = await send('/api/wake-service/office/invitation', cookie, '');
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const invitation = JSON.parse(response.body);
    assert.equal(invitation.invitationUrl === valid, true);
    assert.equal(invitation.expiresInSeconds, 300);
    assert.equal(calls.at(-1), '/api/v1/computers/office/invitation');
    for (const invalid of [valid.replace(config.miniWol!.origin, 'https://relay.invalid'),
      valid.replace('/#', '/?token=x#'), valid.replace('/#', '/path#'), valid + 'x', valid.replace(/a$/, 'A')]) {
      invitationUrl = invalid;
      const rejected = await send('/api/wake-service/office/invitation', cookie, '');
      assert.equal(rejected.status, 502);
      assert.deepEqual(JSON.parse(rejected.body), { problem: 'protocol-error' });
    }
    invitationLimited = true;
    const limited = await send('/api/wake-service/office/invitation', cookie, '');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers['retry-after'], '10');
    assert.deepEqual(JSON.parse(limited.body), { problem: 'rate-limited', retryAfter: 10 });
  });
});
