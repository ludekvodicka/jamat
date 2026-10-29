import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import type { CodexSessionLaunch } from '../../lib-orchestrator/sessionManager/codexSessionIdentity'
import { App } from './app'

const nativeId = '11111111-1111-4111-8111-111111111111'
const wsModule = createRequire(import.meta.url).resolve('ws')
const command = (source: string) => ({command: process.execPath, prefixArgs: ['-e', source, '--'], args: []})

function fixture(backend: string, client: string) {
  const temp = resolve(import.meta.dirname, '../../.aidocs/temp')
  mkdirSync(temp, { recursive: true })
  const cwd = mkdtempSync(join(temp, 'jamat codex transport '))
  const receiptFile = join(cwd, 'identity.json')
  const launch: CodexSessionLaunch = {
    schemaVersion: 1, jamatSessionId: 'tab', launchId: 'generation', mode: 'new', cwd, receiptFile,
    server: command(`const lines = require('node:readline').createInterface({input: process.stdin});
      lines.on('line', line => { const request = JSON.parse(line); ${backend} });
      lines.on('close', () => process.exit(0));`),
    client: command(`const {WebSocket} = require(${JSON.stringify(wsModule)});
      const {readFileSync, existsSync} = require('node:fs');
      const assert = require('node:assert/strict');
      const url = process.argv[process.argv.indexOf('--remote') + 1];
      const token = process.env.JAMAT_V3_CODEX_BRIDGE_TOKEN;
      const file = ${JSON.stringify(receiptFile)};
      ${client}`),
  }
  return {launch, dispose: () => rmSync(cwd, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})}
}

test('authenticated relay writes the correlated receipt before delivering the response and shuts down', async () => {
  const fixtureRun = fixture(`process.stdout.write(JSON.stringify({id: request.id,
    result: {thread: {id: ${JSON.stringify(nativeId)}, source: 'vscode'}}}) + '\\n');`, `
    const rejected = new WebSocket(url, {headers: {authorization: 'Bearer wrong'}});
    rejected.on('close', code => {
      assert.equal(code, 1008);
      const socket = new WebSocket(url, {headers: {authorization: 'Bearer ' + token}});
      socket.on('open', () => socket.send(JSON.stringify({id: 7, method: 'thread/start', params: {}})));
      socket.on('message', bytes => {
        const response = JSON.parse(bytes);
        const identity = JSON.parse(readFileSync(file, 'utf8'));
        assert.equal(response.result.thread.id, identity.nativeSessionId);
        assert.equal(identity.jamatSessionId, 'tab');
        assert.equal(identity.launchId, 'generation');
        process.exit(0);
      });
    });`)
  try {
    assert.equal(await new App(App.launchOf(fixtureRun.launch)).run(), 0)
  } finally { fixtureRun.dispose() }
})

test('protocol corruption stops both children without producing a guessed identity', async () => {
  const fixtureRun = fixture(`process.stdout.write('not-json\\n');`, `
    const socket = new WebSocket(url, {headers: {authorization: 'Bearer ' + token}});
    socket.on('open', () => socket.send(JSON.stringify({id: 1, method: 'thread/start', params: {}})));
    setInterval(() => {}, 1000);`)
  try {
    assert.equal(await new App(fixtureRun.launch).run(), 1)
    assert.equal(existsSync(fixtureRun.launch.receiptFile), false)
  } finally { fixtureRun.dispose() }
})

test('both bridge children inherit the selected profile and shared SQLite home', async () => {
  const oldHome = process.env.CODEX_HOME, oldSqlite = process.env.CODEX_SQLITE_HOME
  const environmentCheck = `require('node:assert/strict').equal(process.env.CODEX_HOME, 'fixture-added');
    require('node:assert/strict').equal(process.env.CODEX_SQLITE_HOME, 'fixture-main');`
  const fixtureRun = fixture(`${environmentCheck}
    process.stdout.write(JSON.stringify({id: request.id, result: {ok: true}}) + '\\n');`, `${environmentCheck}
    const socket = new WebSocket(url, {headers: {authorization: 'Bearer ' + token}});
    socket.on('open', () => socket.send(JSON.stringify({id: 1, method: 'initialize', params: {}})));
    socket.on('message', () => process.exit(0));`)
  process.env.CODEX_HOME = 'fixture-added'
  process.env.CODEX_SQLITE_HOME = 'fixture-main'
  try { assert.equal(await new App(fixtureRun.launch).run(), 0) }
  finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = oldHome
    if (oldSqlite === undefined) delete process.env.CODEX_SQLITE_HOME
    else process.env.CODEX_SQLITE_HOME = oldSqlite
    fixtureRun.dispose()
  }
})

test('backend diagnostics stay out of the terminal while protocol responses still arrive', async t => {
  const diagnostic = 'ERROR rmcp::transport::worker: worker quit with fatal: HTTP 403 challenge\n'
  const terminal = t.mock.method(process.stderr, 'write', () => true)
  const fixtureRun = fixture(`process.stderr.write(${JSON.stringify(diagnostic)});
    process.stdout.write(JSON.stringify({id: request.id, result: {ok: true}}) + '\\n');`, `
    const socket = new WebSocket(url, {headers: {authorization: 'Bearer ' + token}});
    socket.on('open', () => socket.send(JSON.stringify({id: 1, method: 'initialize', params: {}})));
    socket.on('message', bytes => {
      assert.equal(JSON.parse(bytes).result.ok, true);
      process.exit(0);
    });`)
  try {
    assert.equal(await new App(fixtureRun.launch).run(), 0)
    assert.equal(terminal.mock.calls.length, 0)
    assert.equal(readFileSync(join(fixtureRun.launch.cwd, 'generation.server.log'), 'utf8'), diagnostic)
  } finally { fixtureRun.dispose() }
})

test('a backend failure remains visible and points to its preserved diagnostics', async t => {
  const diagnostic = 'Codex app-server failed to initialize\n'
  const terminal = t.mock.method(process.stderr, 'write', () => true)
  const fixtureRun = fixture(`require('node:fs').writeSync(2, ${JSON.stringify(diagnostic)}); process.exit(17);`, `
    const socket = new WebSocket(url, {headers: {authorization: 'Bearer ' + token}});
    socket.on('open', () => socket.send(JSON.stringify({id: 1, method: 'initialize', params: {}})));
    setInterval(() => {}, 1000);`)
  try {
    assert.equal(await new App(fixtureRun.launch).run(), 1)
    const output = terminal.mock.calls.map(call => String(call.arguments[0])).join('')
    assert.match(output, /Codex app-server exited \(17\)/)
    const logFile = join(fixtureRun.launch.cwd, 'generation.server.log')
    assert.ok(output.includes(logFile))
    assert.equal(readFileSync(logFile, 'utf8'), diagnostic)
  } finally { fixtureRun.dispose() }
})

test('a terminal disconnect without its process exiting is a failed runtime', async () => {
  const fixtureRun = fixture('', `
    const socket = new WebSocket(url, {headers: {authorization: 'Bearer ' + token}});
    socket.on('open', () => socket.close());
    setInterval(() => {}, 1000);`)
  try {
    assert.equal(await new App(fixtureRun.launch).run(), 1)
    assert.equal(existsSync(fixtureRun.launch.receiptFile), false)
  } finally { fixtureRun.dispose() }
})

test('launch validation refuses relative paths, unknown modes and incomplete resume/fork identities', () => {
  const fixtureRun = fixture('', '')
  try {
    for (const fields of [{cwd: '.'}, {receiptFile: 'relative'}, {launchId: '../old'},
      {mode: 'unknown'}, {mode: 'resume'}, {mode: 'fork'}, {yolo: 'true'}, {client: {command: '', prefixArgs: [], args: []}}])
      assert.throws(() => App.launchOf({...fixtureRun.launch, ...fields}))
  } finally { fixtureRun.dispose() }
})
