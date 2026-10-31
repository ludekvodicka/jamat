import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { test, type TestContext } from 'node:test';
import { MiniWolClient } from './miniWolClient.js';

async function fixture(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { server, origin, client: new MiniWolClient({ origin, apiKey: '0'.repeat(64) }) };
}

test('MiniWol list and version validate and strip non-public fields with bodyless bearer requests', async t => {
  const { client, origin } = await fixture(t, async (req, res) => {
    assert.equal(req.headers.authorization === `Bearer ${'0'.repeat(64)}`, true);
    assert.equal(req.headers.host, new URL(origin).host);
    assert.equal(req.headers.origin, undefined);
    assert.equal(req.method, 'GET');
    let size = 0;
    for await (const chunk of req) size += chunk.length;
    assert.equal(size, 0);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/v1/computers'
      ? { computers: [{ id: 'office', label: 'Local', hasLauncher: true, mac: 'private', launcher: 'private' }] }
      : { version: '2.0.0', buildTime: 'fixture' }));
  });
  assert.deepEqual(await client.computers(), { ok: true, value: [{ id: 'office', hasLauncher: true }] });
  assert.deepEqual(await client.version(), { ok: true, value: { version: '2.0.0' } });
});

test('MiniWol rejects incompatible HTTP and schema responses', async t => {
  let status = 200;
  let type = 'application/json';
  let body = '{}';
  const { client } = await fixture(t, (_req, res) => {
    res.writeHead(status, { 'Content-Type': type, Location: '/redirected' });
    res.end(body);
  });
  for (const entry of [
    [401, 'application/json', '{"error":"unauthorized"}', 'key-rejected'],
    [404, 'text/plain', 'Not found', 'needs-update'],
    [302, 'application/json', '{}', 'protocol-error'],
    [200, 'application/json', ' '.repeat(17 * 1024), 'protocol-error'],
    [200, 'text/plain', '{"computers":[]}', 'protocol-error'],
    [502, 'application/json', '{"error":"new-error"}', 'protocol-error'],
    [200, 'application/json', '{"computers":[{"id":"office"}]}', 'protocol-error'],
    [200, 'application/json', 'invalid json', 'protocol-error'],
  ] as const) {
    [status, type, body] = entry;
    assert.deepEqual(await client.computers(), { ok: false, problem: entry[3] });
  }
});

test('MiniWol connection refusal and six-second timeout are unreachable', async t => {
  const { client, server } = await fixture(t, () => {});
  const start = Date.now();
  assert.deepEqual(await client.computers(), { ok: false, problem: 'unreachable' });
  assert.ok(Date.now() - start >= 5900);
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  assert.deepEqual(await client.computers(), { ok: false, problem: 'unreachable' });
});

test('launcher detail is optional, allowlisted and compatible with the old state-only API', async t => {
  let error: string | undefined;
  const { client } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: 'failed', error }));
  });
  assert.deepEqual(await client.launcherStatus('office'), { ok: true, value: { state: 'failed' } });
  error = 'target-missing';
  assert.deepEqual(await client.launcherStatus('office'), { ok: true, value: { state: 'failed', error } });
  assert.deepEqual(await client.launcher('office'), { ok: true, value: 'failed' });
  error = 'Private path C:/Users/test/key.txt';
  assert.deepEqual(await client.launcherStatus('office'), { ok: true, value: { state: 'failed' } });
});
