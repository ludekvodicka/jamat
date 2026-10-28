import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import { App } from './app.js';
import { AppContext } from './appContext.js';
import { AppHub } from './appHub.js';
import type { RelayConfig } from './appConfig.js';
import { GoogleLogin } from './googleLogin.js';
import { RelayLogin } from './relayLogin.js';

const origin = 'https://jamat.example.test';
const password = 'test-password-only-abcdefghijklmnopqrstuvwxyz';
const allowed = ['first@example.test', 'second@example.test', 'third@example.test'];
const web = new URL('../dist/web/', import.meta.url);

function requestFixture(base: string, path: string, options: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(base + path, { method: options.method ?? 'GET',
      headers: { host: new URL(origin).host, ...Object.fromEntries(new Headers(options.headers)) } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const headers = new Headers();
        for (const [name, values] of Object.entries(response.headers))
          for (const value of Array.isArray(values) ? values : values ? [values] : [])
            headers.append(name, value);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    request.on('error', reject);
    request.end(options.body?.toString());
  });
}

test('relay login and protected HTTP routes', async t => {
  const calls: { url?: string; authorization?: string; cookie?: string }[] = [];
  const upstream = createServer((req, res) => {
    calls.push({ url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'evil=upstream', 'WWW-Authenticate': 'Basic' });
    res.end(JSON.stringify({ ok: true }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const config: RelayConfig = { origin, port: 0, username: 'admin', password, allowedEmails: allowed, buildTime: 'test-build',
    pcs: [{ id: 'fixture', label: 'Fixture PC', ip: '127.0.0.1', agentPort: (upstream.address() as { port: number }).port,
      mac: '00:11:22:33:44:55', broadcast: '127.0.0.1', token: 'fixture-machine-key' }] };
  const app = new App(config, new AppContext(web));
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => { app.server.closeAllConnections(); app.server.close(); });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (path: string, options: RequestInit = {}) => requestFixture(base, path, options);
  let cookie = '';
  let csrf = '';
  const form = async () => {
    const response = await request('/login');
    cookie = response.headers.getSetCookie()[0].split(';')[0];
    csrf = (await response.text()).match(/name="csrf" value="([^"]+)"/)![1];
  };
  const post = (path: string, body: Record<string, string>, extra: Record<string, string> = {}) => request(path, {
    method: 'POST', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded', ...extra }, body: new URLSearchParams(body),
  });
  await t.test('anonymous entry is a form redirect without a browser challenge', async () => {
    const response = await request('/', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login');
    assert.equal(response.headers.get('www-authenticate'), null);
    const login = await request('/login', { headers: { 'sec-fetch-site': 'cross-site' } });
    const html = await login.text();
    assert.equal(login.status, 200);
    assert.match(html, /autocomplete="current-password"/);
    assert.match(html, /action="\/auth\/google"/);
    assert.doesNotMatch(html, /fixture-machine-key|test-password-only/);
    assert.equal(calls.length, 0);
  });
  await t.test('only exact health is anonymous and read-only', async () => {
    for (const method of ['GET', 'HEAD']) {
      const response = await request('/api/system/health?probe=1', { method });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), method === 'HEAD' ? '' : '{"status":"ok"}');
    }
    assert.equal((await request('/api/system/health', { method: 'POST' })).status, 405);
    for (const path of ['/api/system/health/', '/api/system/%68ealth', '/api/pcs', '/api/pc/fixture/sessions', '/api/pc/fixture/transcript', '/api/system/version', '/relay/version'])
      assert.equal((await request(path)).status, 401);
    assert.equal((await request('/computer.html?pc=fixture')).status, 303);
    assert.equal(calls.length, 0);
  });
  await t.test('Basic credentials no longer authenticate and never cause a challenge', async () => {
    const response = await request('/api/pcs', { headers: { authorization: `Basic ${Buffer.from('admin:' + password).toString('base64')}` } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), null);
  });
  await t.test('wrong credentials, foreign origin and missing CSRF fail', async () => {
    await form();
    assert.equal((await post('/auth/password', { username: 'admin', password, csrf }, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await post('/auth/password', { username: 'admin', password })).status, 403);
    await form();
    const wrong = await post('/auth/password', { username: 'admin', password: 'wrong', csrf });
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /Nesprávné/);
    assert.equal(wrong.headers.get('www-authenticate'), null);
  });
  await t.test('valid form rotates into a secure session and one-time form cannot replay', async () => {
    await form();
    const oldCookie = cookie;
    const response = await post('/auth/password', { username: 'admin', password, csrf });
    assert.equal(response.status, 303);
    const setCookie = response.headers.getSetCookie()[0];
    assert.match(setCookie, /^__Host-jamat_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.doesNotMatch(setCookie, /Domain=/);
    assert.equal((await post('/auth/password', { username: 'admin', password, csrf }, { cookie: oldCookie })).status, 403);
    cookie = setCookie.split(';')[0];
    const session = await request('/api/auth/session', { headers: { cookie } });
    assert.deepEqual(await session.json(), { user: 'admin' });
  });
  await t.test('menu, identity, metadata and PC registry require and accept session', async () => {
    const response = await request('/', { headers: { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Odhlásit se/);
    const pcs = await request('/api/pcs', { headers: { cookie } });
    assert.deepEqual(await pcs.json(), { pcs: [{ id: 'fixture', label: 'Fixture PC' }] });
    const version = await request('/api/system/version', { headers: { cookie } });
    assert.deepEqual(await version.json(), { version: '1.4.3', buildTime: 'test-build' });
    assert.equal((await request('/.private/config-remote.json', { headers: { cookie } })).status, 404);
    for (const path of ['/computer.html', '/computer.js', '/computer.css'])
      assert.equal((await request(path, { headers: { cookie } })).status, 200);
  });
  await t.test('proxy preserves queries and injects machine credentials without forwarding cookies', async () => {
    const response = await request('/api/pc/fixture/sessions?project=a%20b', { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('www-authenticate'), null);
    assert.deepEqual(calls.at(-1), { url: '/api/sessions?project=a%20b', authorization: 'Bearer fixture-machine-key', cookie: undefined });
    const before = calls.length;
    assert.equal((await request('/api/pc/fixture/launch', { method: 'POST', headers: { cookie, origin: 'https://evil.test' } })).status, 403);
    assert.equal((await request('/api/wol', { method: 'POST', headers: { cookie } })).status, 403);
    assert.equal(calls.length, before);
    assert.equal((await request('/api/wol', { method: 'POST', headers: { cookie, origin } })).status, 503);
  });
  await t.test('session creation requires authentication and the exact same origin', async () => {
    const path = '/api/pc/fixture/sessions';
    const before = calls.length;
    assert.equal((await request(path, { method: 'POST', headers: { origin } })).status, 401);
    assert.equal((await request(path, { method: 'POST', headers: { cookie } })).status, 403);
    assert.equal((await request(path, { method: 'POST', headers: { cookie, origin: 'https://evil.test' } })).status, 403);
    assert.equal((await request(path, { method: 'POST', headers: { cookie, origin, 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal(calls.length, before);
    assert.equal((await request(path, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: '{}' })).status, 200);
    assert.equal(calls.length, before + 1);
  });
  await t.test('logout revokes server-side session, cannot be triggered from a foreign form', async () => {
    assert.equal((await request('/auth/logout', { method: 'POST', headers: { cookie, origin: 'https://evil.test' } })).status, 403);
    assert.equal((await request('/api/pcs', { headers: { cookie } })).status, 200);
    const response = await request('/auth/logout', { method: 'POST', headers: { cookie, origin } });
    assert.equal(response.status, 303);
    assert.match(response.headers.getSetCookie()[0], /Max-Age=0/);
    assert.equal((await request('/api/pcs', { headers: { cookie } })).status, 401);
  });
  await t.test('forged host, malformed forms and unavailable Google cannot bypass authentication', async () => {
    assert.equal((await request('/login', { headers: { host: 'evil.test' } })).status, 400);
    assert.equal((await request('/auth/password', { method: 'POST', headers: { origin }, body: '{}' })).status, 400);
    await form();
    assert.equal((await post('/auth/google', { csrf })).status, 503);
    assert.equal((await request('/auth/google/callback?code=forged&state=forged')).status, 400);
  });
  await t.test('password attempts are bounded', async () => {
    let response: Response | undefined;
    for (let i = 0; i < 21; i++)
      response = await post('/auth/password', {}, { 'x-real-ip': 'fixture-throttle' });
    assert.equal(response?.status, 429);
    assert.equal(response?.headers.get('retry-after'), '600');
  });
});

test('Google OAuth verifies signed identities and browser-bound flow', async t => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const client = new OAuth2Client({ clientId: 'fixture-client', clientSecret: 'fixture-secret' });
  const google = new GoogleLogin(client, 'fixture-client', origin, allowed);
  let claims: Record<string, unknown> = {};
  let invalidSignature = false;
  let lastVerifier: string | undefined;
  const signedToken = () => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'fixture-client', sub: 'fixture-user',
      email: allowed[0], email_verified: true, iat: now, exp: now + 3600, ...claims })).toString('base64url');
    const data = `${header}.${body}`;
    return `${data}.${sign('RSA-SHA256', Buffer.from(data), invalidSignature ? otherKey : privateKey).toString('base64url')}`;
  };
  t.mock.method(client, 'getFederatedSignonCertsAsync', async () => ({ certs: { fixture: publicKey.export({ type: 'spki', format: 'pem' }) }, format: 'PEM' }));
  t.mock.method(client, 'getToken', async (options: { codeVerifier: string; redirect_uri: string }) => {
    lastVerifier = options.codeVerifier;
    assert.equal(options.redirect_uri, `${origin}/auth/google/callback`);
    return { tokens: { id_token: signedToken() } };
  });
  await t.test('authorization uses exact callback, state, nonce, minimal scopes and PKCE', async () => {
    const { url, flow } = await google.start('fixture-state');
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://accounts.google.com');
    assert.equal(parsed.searchParams.get('redirect_uri'), `${origin}/auth/google/callback`);
    assert.equal(parsed.searchParams.get('state'), 'fixture-state');
    assert.equal(parsed.searchParams.get('nonce'), flow.nonce);
    assert.equal(parsed.searchParams.get('scope'), 'openid email');
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(flow.verifier.length >= 43);
    claims = { nonce: flow.nonce };
    assert.equal(await google.finish('code', flow), allowed[0]);
    assert.equal(lastVerifier, flow.verifier);
  });
  for (const [name, override] of Object.entries({ unknown: { email: 'unknown@example.test' }, unverified: { email_verified: false },
    audience: { aud: 'other-client' }, issuer: { iss: 'https://evil.test' }, expired: { exp: 1 }, nonce: { nonce: 'wrong' } }))
    await t.test(`rejects ${name} identity`, async () => {
      const { flow } = await google.start('state');
      claims = { nonce: flow.nonce, ...override };
      await assert.rejects(google.finish('code', flow));
    });
  await t.test('rejects invalid signature and accepts each exact allowed account', async () => {
    const { flow } = await google.start('state');
    claims = { nonce: flow.nonce };
    invalidSignature = true;
    await assert.rejects(google.finish('code', flow));
    invalidSignature = false;
    for (const email of allowed) {
      claims = { nonce: flow.nonce, email };
      assert.equal(await google.finish('code', flow), email);
    }
  });
  await t.test('callback requires its browser cookie and one-time state, then creates a real session', async () => {
    const config: RelayConfig = { origin, port: 0, username: 'admin', password, pcs: [], allowedEmails: allowed, buildTime: 'test' };
    const context = new AppContext(web);
    const hub = new AppHub(config, context);
    const login = new RelayLogin(origin, 'admin', password, readFileSync(new URL('login.html', web), 'utf8'), google);
    t.mock.method(hub.login, 'authorize', login.authorize.bind(login));
    const app = new App(config, context, hub);
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    t.after(() => { app.server.closeAllConnections(); app.server.close(); });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const request = (path: string, options: RequestInit = {}) => requestFixture(base, path, options);
    const begin = async () => {
      const form = await request('/login');
      const csrf = (await form.text()).match(/name="csrf" value="([^"]+)"/)![1];
      const response = await request('/auth/google', { method: 'POST', headers: { origin,
        cookie: form.headers.getSetCookie()[0].split(';')[0], 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) });
      assert.equal(response.status, 303);
      return { url: new URL(response.headers.get('location')!), cookie: response.headers.getSetCookie()[0].split(';')[0] };
    };
    const stolen = await begin();
    assert.equal((await request('/auth/google/callback?code=code&state=' + stolen.url.searchParams.get('state'))).status, 400);
    const flow = await begin();
    claims = { nonce: flow.url.searchParams.get('nonce'), email: allowed[2] };
    const callback = '/auth/google/callback?code=code&state=' + flow.url.searchParams.get('state');
    const response = await request(callback, { headers: { cookie: flow.cookie, 'sec-fetch-site': 'cross-site' } });
    assert.equal(response.status, 303);
    const sessionCookie = response.headers.getSetCookie()[0].split(';')[0];
    assert.deepEqual(await (await request('/api/auth/session', { headers: { cookie: sessionCookie } })).json(), { user: allowed[2] });
    assert.equal((await request(callback, { headers: { cookie: flow.cookie } })).status, 400);
  });
});
