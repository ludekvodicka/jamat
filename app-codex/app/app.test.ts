import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CodexSessionLaunch } from '../../lib-orchestrator/sessionManager/codexSessionIdentity'
import { App } from './app'

const nativeId = '11111111-1111-4111-8111-111111111111'
const wsModule = createRequire(import.meta.url).resolve('ws')
const command = (source: string) => ({command: process.execPath, prefixArgs: ['-e', source, '--'], args: []})

function fixture(backend: string, client: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'jamat codex transport '))
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
  return {launch, dispose: () => rmSync(cwd, {recursive: true, force: true})}
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
