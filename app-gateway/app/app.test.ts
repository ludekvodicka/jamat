import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { GatewayApp } from './app'
import { GatewayAppHub } from './appHub'
import { GatewayLock } from './gatewayLock'
import type { ProcessMessage } from '../../lib-orchestrator/shared/processWire.types'
import type { ProcessCalls } from '../../lib-orchestrator/shared/processCalls'
import { SmokeForwardTrace } from './smokeForwardTrace'

class Parent extends EventEmitter {
  messages: ProcessMessage[] = []
  postMessage(message: ProcessMessage): void { this.messages.push(message) }
}
const build = { version: 'test', inputHash: 'a'.repeat(64), builtAt: '2026-11-03T00:00:00.000Z' }
let previousHostRoot: string | undefined, hostRoot: string
beforeEach(() => {
  previousHostRoot = process.env.JAMAT_V3_HOST_STATE_DIR
  hostRoot = mkdtempSync(join(tmpdir(), 'gateway-host-fixture-'))
  process.env.JAMAT_V3_HOST_STATE_DIR = hostRoot
})
afterEach(() => {
  if (previousHostRoot === undefined) delete process.env.JAMAT_V3_HOST_STATE_DIR
  else process.env.JAMAT_V3_HOST_STATE_DIR = previousHostRoot
  rmSync(hostRoot, { recursive: true, force: true })
})

test('gateway records a main hang and exits after 30 seconds without heartbeat', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-watchdog-'))
  const parent = new Parent(), exits: number[] = []
  let clock = 0
  const app = new GatewayApp(parent, build, code => exits.push(code), () => clock)
  try {
    app.start()
    parent.emit('message', { data: { type: 'initialize', identity: { configIdentity: 'test', channel: 'development', stateDirectory: directory } } })
    for (let attempt = 0; attempt < 100 && parent.messages.at(-1)?.type !== 'ready'; attempt++) await setTimeout(10)
    assert.equal(parent.messages.at(-1)?.type, 'ready')
    clock = 30000
    app.checkParent()
    await app.stop(1)
    assert.deepEqual(exits, [1])
    const records = readdirSync(join(directory, 'perf')).filter(name => name.endsWith('.jsonl'))
      .flatMap(name => readFileSync(join(directory, 'perf', name), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
    assert.ok(records.some(record => record.kind === 'hang' && record.target === 'main' && record.ms === 30000))
    const replacement = new GatewayLock(join(directory, 'gateway.lock'))
    await replacement.acquire()
    await replacement.release()
  } finally { await app.stop(0); rmSync(directory, { recursive: true, force: true }) }
})

test('native suspend preserves the gateway beyond 30 seconds but cannot suppress later parent loss', async () => {
  const parent = new Parent(), exits: number[] = []
  let at = 0
  const app = new GatewayApp(parent, build, code => exits.push(code), () => at)
  app.start()
  parent.emit('message', { data: { type: 'power', epoch: 1, event: 'suspend' } })
  at = 1_000; app.checkParent()
  at = 91_000
  parent.emit('message', { data: { type: 'heartbeat', seq: 1 } })
  app.checkParent()
  assert.deepEqual(exits, [])
  at += 29_999; app.checkParent()
  assert.deepEqual(exits, [])
  at += 1; app.checkParent()
  await app.stop(1)
  assert.deepEqual(exits, [1])
})

test('parent close exits the gateway and a held identity refuses a second gateway', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-lock-'))
  const first = new GatewayLock(join(directory, 'gateway.lock')), second = new GatewayLock(join(directory, 'gateway.lock'))
  try {
    await first.acquire()
    await assert.rejects(second.acquire(), /already owns/)
    await second.release()
    await assert.rejects(second.acquire(), /already owns/)
    await first.release()
    await second.acquire()
    await second.release()
    const parent = new Parent(), exits: number[] = []
    const app = new GatewayApp(parent, build, code => exits.push(code))
    app.start()
    parent.emit('close')
    await app.stop(0)
    assert.deepEqual(exits, [0])
  } finally { await first.release(); await second.release(); rmSync(directory, { recursive: true, force: true }) }
})

test('concurrent dead-owner reclaimers grant the identity to exactly one gateway', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-takeover-')), file = join(directory, 'gateway.lock')
  const locks = Array.from({ length: 8 }, () => new GatewayLock(file))
  try {
    writeFileSync(file, JSON.stringify({ pid: 2147483647, token: randomUUID() }))
    const results = await Promise.allSettled(locks.map(lock => lock.acquire()))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 7)
    await Promise.all(locks.map(lock => lock.release()))
    const next = new GatewayLock(file)
    await next.acquire()
    await next.release()
  } finally { await Promise.all(locks.map(lock => lock.release())); rmSync(directory, { recursive: true, force: true }) }
})

test('a throwing parent port cannot prevent cleanup or produce an unhandled rejection', async () => {
  const parent = new Parent(), exits: number[] = []
  const app = new GatewayApp(parent, build, code => exits.push(code))
  app.start()
  parent.postMessage = () => { throw new Error('port closed') }
  parent.emit('message', { data: { type: 'unexpected' } })
  await setTimeout(0)
  await app.stop(1)
  assert.deepEqual(exits, [1])
})

for (const smoke of [false, true]) test(`gateway enables receipts only for private smoke initialization: ${smoke}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-smoke-'))
  const parent = new Parent(), app = new GatewayApp(parent, build, () => {})
  const privatePort = Object.assign(new Parent(), { start() {}, close() {} })
  const sent = mock.method(SmokeForwardTrace, 'sent', (message: ProcessMessage, stateDirectory: string) => {
    assert.equal(privatePort.messages.at(-1), message, 'Receipt follows successful direct orchestration send')
    assert.equal(stateDirectory, directory)
  })
  try {
    app.start()
    parent.emit('message', { data: { type: 'initialize', smoke,
      identity: { configIdentity: 'test', channel: 'development', stateDirectory: directory } } })
    for (let attempt = 0; attempt < 100 && parent.messages.at(-1)?.type !== 'ready'; attempt++) await setTimeout(10)
    assert.equal(parent.messages.at(-1)?.type, 'ready')
    parent.emit('message', { data: { type: 'orchestrator-port' }, ports: [privatePort] })
    sent.mock.resetCalls()
    const calls = (app as unknown as { hub: { calls: ProcessCalls } }).hub.calls
    const result = calls.call('peer-work', 'execute', [{ connectionId: 'c' }, { requestId: 'r', operation: 'projects.list' }])
    const request = privatePort.messages.at(-1)
    assert(request?.type === 'call')
    assert.equal(parent.messages.some(message => message.type === 'call' && message.target === 'peer-work'), false)
    assert.equal(sent.mock.callCount(), smoke ? 1 : 0)
    privatePort.emit('message', { data: { type: 'reply', id: request.id, ok: true, value: null } })
    await result
  } finally {
    await app.stop(0)
    sent.mock.restore()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('gateway stopped receipts preserve the lease owner result, including failed release', async () => {
  for (const leaseRelease of ['released', 'not-held', 'failed'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'gateway-stop-receipt-'))
    const parent = new Parent(), exits: number[] = []
    const app = new GatewayApp(parent, build, code => exits.push(code))
    const result = mock.method(GatewayAppHub.prototype, 'leaseRelease', () => leaseRelease)
    try {
      app.start()
      parent.emit('message', { data: { type: 'initialize', identity: { configIdentity: 'test', channel: 'development', stateDirectory: directory } } })
      for (let attempt = 0; attempt < 100 && parent.messages.at(-1)?.type !== 'ready'; attempt++) await setTimeout(10)
      assert.equal(parent.messages.at(-1)?.type, 'ready')
      await app.stop(0)
      assert.deepEqual(parent.messages.at(-1), { type: 'stopped', process: 'gateway', leaseRelease })
      assert.deepEqual(exits, [0])
      const replacement = new GatewayLock(join(directory, 'gateway.lock'))
      await replacement.acquire()
      await replacement.release()
    } finally { result.mock.restore(); await app.stop(0); rmSync(directory, { recursive: true, force: true }) }
  }
})
