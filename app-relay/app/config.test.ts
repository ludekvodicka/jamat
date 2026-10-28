import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppConfig } from './appConfig.js';
import { ExpiringStore } from './expiringStore.js';
import { RemoteControlPeerKeys } from '../../lib-orchestrator/remoteControl/remoteControlPeerKeys.js';
import { RemoteControlPairing } from '../../lib-orchestrator/remoteControl/remoteControlPairing.js';
import type { RemoteControlPeerIdentity } from '../../lib-orchestrator/remoteControl/remoteControlPeerApi.types.js';

test('startup fails closed for invalid authentication, origin and registry', t => {
  const directory = mkdtempSync(join(tmpdir(), 'jamat-relay-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registry = join(directory, 'registry.json');
  writeFileSync(registry, JSON.stringify({ pcs: [] }));
  const env = { JAMAT_V3_RELAY_AUTH_USER: 'admin', JAMAT_V3_RELAY_AUTH_PASSWORD: 'test-only-abcdefghijklmnopqrstuvwxyz',
    JAMAT_V3_RELAY_CONFIG: registry };
  assert.equal(AppConfig.read(env).origin, 'https://jamat.example');
  assert.equal(AppConfig.read({ ...env, JAMAT_V3_RELAY_ORIGIN: 'https://CUSTOM.example:443/' }).origin, 'https://custom.example');
  assert.equal(AppConfig.read({ ...env, JAMAT_V3_RELAY_ORIGIN: 'http://127.0.0.1:1234' }).origin, 'http://127.0.0.1:1234');
  assert.equal(AppConfig.read({ ...env, JAMAT_V3_RELAY_ORIGIN: 'http://localhost:1234/' }).origin, 'http://localhost:1234');
  assert.equal(AppConfig.read({ ...env, JAMAT_V3_RELAY_ORIGIN: 'http://[::1]:1234/' }).origin, 'http://[::1]:1234');
  for (const invalid of [
    { JAMAT_V3_RELAY_AUTH_PASSWORD: '' }, { JAMAT_V3_RELAY_AUTH_USER: 'bad:user' },
    { JAMAT_V3_RELAY_ORIGIN: '' }, { JAMAT_V3_RELAY_ORIGIN: 'not-an-origin' },
    { JAMAT_V3_RELAY_ORIGIN: 'http://public.test' }, { JAMAT_V3_RELAY_ORIGIN: 'https://public.test/path' },
    { JAMAT_V3_RELAY_ORIGIN: 'https://user:password@public.test' }, { JAMAT_V3_RELAY_PORT: '-1' },
    { JAMAT_V3_RELAY_GOOGLE_CLIENT_ID: 'id-only' },
    { JAMAT_V3_RELAY_GOOGLE_CLIENT_ID: 'id', JAMAT_V3_RELAY_GOOGLE_CLIENT_SECRET: 'secret' },
    { JAMAT_V3_RELAY_ALLOWED_EMAILS: '*@example.test,invalid' },
  ])
    assert.throws(() => AppConfig.read({ ...env, ...invalid }));
  const google = AppConfig.read({ ...env, JAMAT_V3_RELAY_GOOGLE_CLIENT_ID: 'fixture-id',
    JAMAT_V3_RELAY_GOOGLE_CLIENT_SECRET: 'fixture-secret', JAMAT_V3_RELAY_ALLOWED_EMAILS: 'FIRST@example.test,second@example.test' });
  assert.deepEqual(google.allowedEmails, ['first@example.test', 'second@example.test']);
  writeFileSync(registry, JSON.stringify({ pcs: [{}] }));
  assert.throws(() => AppConfig.read(env));
  const keys = RemoteControlPeerKeys.generateSigningKeyPair();
  const identity: RemoteControlPeerIdentity = { remoteComputerId: 'relay', remoteEndpointId: 'endpoint',
    configIdentity: 'config', runtimeChannel: 'production', displayName: 'Relay', signing: {
      algorithm: 'ed25519', publicKey: keys.publicKey, fingerprint: RemoteControlPeerKeys.fingerprint(keys.publicKey),
    } };
  const pc = { id: 'pc', label: 'PC', ip: '127.0.0.1', agentPort: 3501, mac: '', broadcast: '',
    peer: RemoteControlPairing.bundle(identity, { host: '127.0.0.1', port: 47150 }) };
  writeFileSync(registry, JSON.stringify({ pcs: [pc] }));
  assert.throws(() => AppConfig.read(env), /peer identity/);
  writeFileSync(registry, JSON.stringify({ pcs: [pc], peerIdentity: { identity, privateKey: keys.privateKey } }));
  assert.equal(AppConfig.read(env).pcs[0].peer?.identity.displayName, 'Relay');
  writeFileSync(registry, JSON.stringify({ pcs: [pc], peerIdentity: { identity,
    privateKey: RemoteControlPeerKeys.generateSigningKeyPair().privateKey } }));
  assert.throws(() => AppConfig.read(env), /does not match/);
  writeFileSync(registry, JSON.stringify({ pcs: [{ ...pc, peer: false }] }));
  assert.throws(() => AppConfig.read(env), /pairing bundle/);
});

test('session and login state expire and revoked tokens remain invalid', t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const store = new ExpiringStore<string>(600_000);
  const token = store.create('user');
  assert.equal(store.get(token), 'user');
  assert.equal(store.get('forged'), undefined);
  t.mock.timers.tick(600_001);
  assert.equal(store.get(token), undefined);
  const another = store.create('user');
  store.delete(another);
  assert.equal(store.get(another), undefined);
});
