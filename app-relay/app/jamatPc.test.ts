import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { RemoteControlPeerKeys as Keys } from '../../lib-orchestrator/remoteControl/remoteControlPeerKeys.js';
import { RemoteControlPeerCodec } from '../../lib-orchestrator/remoteControl/remoteControlPeerCodec.js';
import { RemoteControlPeerConnection } from '../../lib-orchestrator/remoteControl/remoteControlPeerConnection.js';
import { RemoteControlPairing } from '../../lib-orchestrator/remoteControl/remoteControlPairing.js';
import { RemoteControlRequestValidation } from '../../lib-orchestrator/remoteControl/remoteControlRequestValidation.js';
import type { RemoteControlPeerCapability, RemoteControlPeerIdentity } from '../../lib-orchestrator/remoteControl/remoteControlPeerApi.types.js';
import type { RemoteControlRequestUnion, RemoteControlResponse } from '../../lib-orchestrator/remoteControl/remoteControlApi.types.js';
import { JamatPc } from './jamatPc.js';
import type { PcConfig } from './appConfig.js';

function identity(name: string) {
  const keys = Keys.generateSigningKeyPair();
  const identity: RemoteControlPeerIdentity = { remoteComputerId: name, remoteEndpointId: `${name}-endpoint`,
    configIdentity: `${name}-config`, runtimeChannel: 'production', displayName: name,
    signing: { algorithm: 'ed25519', publicKey: keys.publicKey, fingerprint: Keys.fingerprint(keys.publicKey) } };
  return { identity, privateKey: keys.privateKey };
}

test('paired V3 endpoint uses authenticated encrypted calls, reconnects and allows only bounded session creation', async t => {
  const relay = identity('relay');
  const target = identity('target');
  const sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(sockets, 'listening');
  const connections: RemoteControlPeerConnection[] = [];
  const requests: RemoteControlRequestUnion[] = [];
  const sessionGroups = [{ id: 'waiting', title: 'My queue' }, { id: 'none', title: 'Sessions' }, { id: 'pinned', title: 'Pinned' }];
  let allowedCapabilities: readonly RemoteControlPeerCapability[] | undefined;
  const created: { sessionId: string; tabTitle: string; callerOperationId: string }[] = [];
  const launch = { operationId: randomUUID(), categoryId: 'apps', projectPath: 'Q:/Apps/Jamat', title: 'Task', agentId: 'codex', model: null, worktree: false };
  let trusted = false;
  let dials = 0;
  sockets.on('connection', socket => {
    dials++;
    socket.once('message', data => {
      try {
        const codec = RemoteControlPeerCodec.acceptClientHello(JSON.parse(data.toString()), {
          identity: target.identity, allowedCapabilities, trustedInbound: () => trusted ? relay.identity : null,
          sign: payload => Keys.sign(target.privateKey, payload), acceptNonce: () => true,
        });
        socket.send(JSON.stringify(codec.hello));
        const connection = new RemoteControlPeerConnection(socket, codec);
        connections.push(connection);
        connection.onMessage(message => {
          if (message.type !== 'control-request')
            throw new Error('Unexpected message');
          const parsed = RemoteControlRequestValidation.parse(message.request);
          assert.equal(parsed.ok, true);
          const request = parsed.request;
          requests.push(request);
          if (request.operation === 'sessions.create') {
            assert.ok(request.operationId);
            if (request.body.spec.title === 'Reject') {
              connection.send({ type: 'control-response', response: { protocol: request.protocol,
                requestId: request.requestId, operation: request.operation, operationId: request.operationId, ok: false,
                error: { code: 'invalid-request', detail: 'Project no longer exists' } } });
              return;
            }
            created.push({ sessionId: randomUUID(), tabTitle: request.body.spec.title!, callerOperationId: request.operationId });
            if (request.body.spec.title === 'Lose reply') { connection.close(); return; }
          }
          const value = request.operation === 'sessions.transcript'
            ? { sessionId: '00000000-0000-4000-8000-000000000001', transcriptContentUntrusted: true,
                reading: { kind: 'none', code: 'not-agent', reason: 'Shell fixture' } }
            : request.operation === 'sessions.list' ? { fixture: request.operation, sessionGroups, sessions: created }
            : request.operation === 'projects.list' ? { categories: [] }
            : request.operation === 'agents.describe' ? { agents: [] }
            : request.operation === 'sessions.create' ? { session: created.at(-1), tabOpen: null, groupAssign: null }
            : { fixture: request.operation };
          connection.send({ type: 'control-response', response: { protocol: request.protocol,
            requestId: request.requestId, operation: request.operation, operationId: request.operationId ?? null, ok: true, value } as RemoteControlResponse });
        });
      } catch {
        socket.close(1008);
      }
    });
  });
  const config: PcConfig = { id: 'fixture', label: 'Fixture', ip: '127.0.0.1', agentPort: 3501,
    peer: RemoteControlPairing.bundle(target.identity, { host: '127.0.0.1', port: (sockets.address() as { port: number }).port }) };
  const pc = new JamatPc(config, relay);
  const http = createServer((req, res) => { void pc.handle(req, res, req.url!); });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const post = (value: unknown, contentType = 'application/json') => fetch(url + '/api/sessions', {
    method: 'POST', headers: { 'content-type': contentType }, body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  t.after(() => {
    pc.close();
    for (const connection of connections)
      connection.close();
    for (const socket of sockets.clients)
      socket.terminate();
    sockets.close();
    http.closeAllConnections();
    http.close();
  });
  await t.test('unpaired is unavailable, never sleeping, and executes no operations', async () => {
    const status = await pc.status();
    assert.equal(status.online, false);
    assert.match(status.detail, /Jamat web/);
    assert.equal(requests.length, 0);
  });
  await t.test('approval enables one shared connection for concurrent calls', async () => {
    trusted = true;
    const before = dials;
    const statuses = await Promise.all([pc.status(), pc.status()]);
    assert.equal(dials, before + 1);
    assert.deepEqual(statuses[0], { online: true, detail: 'Jamat online', href: '/computer.html?pc=fixture' });
    const response = await fetch(url + '/api/sessions');
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { sessionGroups: unknown }).sessionGroups, sessionGroups);
    assert.equal(requests.at(-1)?.operation, 'sessions.list');
  });
  await t.test('preview uses the selected canonical session ID and validates it', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000001';
    assert.equal((await fetch(url + '/api/transcript?sessionId=' + sessionId)).status, 200);
    assert.deepEqual(requests.at(-1)?.body, { session: { kind: 'sessionId', sessionId } });
    assert.equal((await fetch(url + '/api/terminal?sessionId=' + sessionId)).status, 200);
    assert.deepEqual(requests.at(-1)?.body, { session: { kind: 'sessionId', sessionId }, cols: 120, rows: 40 });
    const count = requests.length;
    assert.equal((await fetch(url + '/api/terminal?sessionId=bad')).status, 400);
    assert.equal((await fetch(url + '/api/launch', { method: 'POST' })).status, 405);
    assert.equal((await fetch(url + '/api/update')).status, 404);
    assert.equal(requests.length, count);
  });
  await t.test('launcher reads target projects and models, then forwards both agent choices with worktree and model', async () => {
    assert.deepEqual(await (await fetch(url + '/api/launch-options')).json(), { projects: { categories: [] }, agents: { agents: [] }, createAvailable: true });
    for (const agentId of ['codex', 'claude']) {
      const input = { ...launch, operationId: randomUUID(), agentId, model: agentId === 'claude' ? 'opus' : 'gpt-5', worktree: agentId === 'claude' };
      const response = await post(input);
      assert.equal(response.status, 201);
      assert.equal((await response.json() as { session: { callerOperationId: string } }).session.callerOperationId, input.operationId);
      const request = requests.at(-1)!;
      assert.equal(request.operation, 'sessions.create');
      if (request.operation !== 'sessions.create') throw new Error('Expected create');
      assert.deepEqual(request.body.spec.agent, { agentId, mode: 'new', model: input.model });
      assert.deepEqual(request.body.spec.worktree, input.worktree ? { slug: input.title } : undefined);
      assert.equal(request.body.spec.acknowledgeSetup, undefined);
      assert.equal(request.body.openTab, undefined);
    }
  });
  await t.test('malformed, oversized and unrestricted requests never reach the peer', async () => {
    const before = requests.length;
    for (const value of ['{broken', ' '.repeat(9000), { ...launch, command: 'anything' }, { ...launch, agentId: 'shell' }]) {
      const response = await post(value);
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { uncertain: boolean }).uncertain, false);
    }
    assert.equal((await post(launch, 'text/plain')).status, 400);
    assert.equal(requests.length, before);
  });
  await t.test('a source rejection is final; a lost reply stays uncertain and can be found by operation ID', async () => {
    const rejected = await post({ ...launch, operationId: randomUUID(), title: 'Reject' });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json() as { uncertain: boolean }).uncertain, false);
    const operationId = randomUUID();
    const lost = await post({ ...launch, operationId, title: 'Lose reply' });
    assert.equal(lost.status, 503);
    assert.equal((await lost.json() as { uncertain: boolean }).uncertain, true);
    const response = await fetch(url + '/api/sessions');
    const snapshot = await response.json() as { sessions: typeof created };
    assert.equal(snapshot.sessions.filter(session => session.callerOperationId === operationId).length, 1);
    assert.equal(requests.filter(request => request.operationId === operationId).length, 1);
  });
  await t.test('older peers use target defaults and cannot silently ignore an explicit model', async () => {
    allowedCapabilities = ['control:system.status', 'control:projects.list', 'control:sessions.list', 'control:sessions.create'];
    const closed = once([...sockets.clients][0], 'close');
    connections.at(-1)!.close();
    await closed;
    assert.deepEqual(await (await fetch(url + '/api/launch-options')).json(), { projects: { categories: [] }, agents: null, createAvailable: true });
    const before = requests.length;
    assert.equal((await post({ ...launch, model: 'gpt-5' })).status, 409);
    assert.equal(requests.length, before);
    assert.equal((await post({ ...launch, operationId: randomUUID() })).status, 201);
  });
  await t.test('peers without create capability never receive a mutation', async () => {
    allowedCapabilities = ['control:system.status', 'control:projects.list', 'control:sessions.list'];
    const closed = once([...sockets.clients][0], 'close');
    connections.at(-1)!.close();
    await closed;
    assert.equal((await (await fetch(url + '/api/launch-options')).json() as { createAvailable: boolean }).createAvailable, false);
    const before = requests.length;
    assert.equal((await post(launch)).status, 409);
    assert.equal(requests.length, before);
    allowedCapabilities = undefined;
  });
  await t.test('disconnect does not reuse a dead channel', async () => {
    const closed = once([...sockets.clients][0], 'close');
    connections.at(-1)!.close();
    await closed;
    const before = dials;
    assert.equal((await pc.status()).online, true);
    assert.equal(dials, before + 1);
  });
  await t.test('wrong pinned target identity is refused', async () => {
    const wrong = new JamatPc({ ...config, peer: RemoteControlPairing.bundle(identity('impostor').identity, config.peer!.endpoint) }, relay);
    try {
      const count = requests.length;
      assert.equal((await wrong.status()).online, false);
      assert.equal(requests.length, count);
    } finally {
      wrong.close();
    }
  });
});
