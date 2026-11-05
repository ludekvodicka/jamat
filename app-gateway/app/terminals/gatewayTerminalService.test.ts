import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { TerminalGateway, type TerminalGatewayDeps } from '../../../lib-orchestrator/sessionManager/terminalGateway'
import { TerminalPortClient } from '../../../lib-orchestrator/sessionManager/terminalPortClient'
import type { TerminalProcessCall, TerminalProcessControl, TerminalProcessEvent } from '../../../lib-orchestrator/sessionManager/terminalProcess.types'
import { ProcessCalls } from '../../../lib-orchestrator/shared/processCalls'
import type { ProcessCallMessage } from '../../../lib-orchestrator/shared/processWire.types'
import { GatewayTerminalService } from './gatewayTerminalService'

function fixture() {
  const emitted: string[] = [], marks: { sessionId: string; at: number }[] = [], reports: string[] = []
  const replies: ProcessCallMessage[] = []
  let holdReplies = false, hint = new Map<string, number>()
  const clientCalls = new ProcessCalls({ send: message => serverCalls.receive(structuredClone(message)),
    invoke: async () => { throw new Error('not supported') },
    event: (_target, name, payload) => client.receive({ name, payload } as TerminalProcessEvent), report: value => reports.push(value) })
  const serverCalls = new ProcessCalls({ send: message => {
    if (holdReplies && message.type === 'reply') replies.push(structuredClone(message))
    else clientCalls.receive(structuredClone(message))
  }, invoke: (_target, method, args, context) => service.invoke({ method, args } as TerminalProcessCall, context),
  event: (_target, name, payload) => service.control({ name, payload } as TerminalProcessControl), report: value => reports.push(value) })
  const client = new TerminalPortClient(clientCalls, {
    userInput: values => marks.push(...values), pendingInputHint: values => { hint = new Map(values) },
  })
  const gateway = new TerminalGateway({
    descriptorOf: () => ({ hostInstanceId: 'host', port: 1, token: 'fixture' }) as ReturnType<TerminalGatewayDeps['descriptorOf']>,
    leaseIdOf: () => 'lease', onError: value => reports.push(value),
    activity: { userInput: values => serverCalls.emit('terminals', 'userInput', values),
      pendingInputHint: values => serverCalls.emit('terminals', 'pendingInputHint', [...values]) },
    socketFactory: deps => ({ connect() {}, close() {}, send(message) {
      if (message.type === 'terminal.input') emitted.push(message.data)
      else if (message.type === 'terminal.attach')
        queueMicrotask(() => deps.onFrame({ type: 'terminal.attached', writer: true,
          session: { runtimeSessionId: 'runtime', generation: 1, alive: true, cols: 120, rows: 40,
            outputSeq: 0, outputEpoch: 1, lastOutputAt: null, startedAt: 1 } }))
    } }),
  })
  const service = new GatewayTerminalService(gateway, event => serverCalls.emit('terminals', event.name, event.payload))
  return { client, clientCalls, serverCalls, gateway, service, emitted, marks, reports, replies,
    hint: () => hint, holdReplies: (value: boolean) => { holdReplies = value },
    attach: async (id: string, source: 'local' | 'remote' = 'local') => {
      await client.publishRefs([{ sessionId: 'session', resolution: { ok: true, alive: true,
        ref: { hostInstanceId: 'host', runtimeSessionId: 'runtime', generation: 1 } } }])
      assert.deepEqual(await client.attach(id, { sessionId: 'session', size: null }, { source, windowId: 'window', onFrame() {} }), { ok: true })
    },
    close: () => { service.stop(); clientCalls.close(); serverCalls.close() },
  }
}

test('acknowledged inhibit holds every input source, authoritative count bypasses stale hints, release remains live', async () => {
  const h = fixture()
  try {
    await h.attach('local'); await h.attach('peer', 'remote'); await h.attach('automation')
    const inhibit = await h.client.inhibit('session')
    const pending = [h.client.input('local', 'local'), h.client.input('peer', 'peer'), h.client.input('automation', 'automation')]
    assert.deepEqual(h.emitted, [])
    assert.equal(h.hint().get('session') ?? 0, 0)
    assert.equal(await h.client.pendingInput('session'), 3)
    inhibit.release()
    assert.deepEqual(await Promise.all(pending), [{ kind: 'sent' }, { kind: 'sent' }, { kind: 'sent' }])
    assert.deepEqual(h.emitted, ['local', 'peer', 'automation'])
  } finally { h.close() }
})

test('detach settles held input and a waiting transaction without any later replay', async () => {
  const h = fixture()
  try {
    await h.attach('same')
    const inhibit = await h.client.inhibit('session')
    const input = h.client.input('same', 'never')
    const transaction = h.client.transaction('same')
    h.client.detach('same')
    assert.deepEqual(await input, { kind: 'unknown-attach' })
    await h.attach('same')
    inhibit.release()
    assert.deepEqual(await transaction, { refused: 'not-writer' })
    assert.deepEqual(h.emitted, [])
    assert.deepEqual(await h.client.input('same', 'replacement'), { kind: 'sent' })
  } finally { h.close() }
})

test('a successful grant whose reply is lost is released by later cancellation', async () => {
  const h = fixture()
  try {
    await h.attach('writer')
    h.holdReplies(true)
    const controller = new AbortController()
    const cancelled = assert.rejects(h.clientCalls.call('terminals', 'inhibit', ['session'], { signal: controller.signal }), /cancelled/)
    await setTimeout(0)
    assert.equal(h.replies.length, 1)
    controller.abort()
    await cancelled
    h.holdReplies(false)
    h.clientCalls.receive(h.replies.shift()!)
    assert.deepEqual(await h.client.input('writer', 'unheld'), { kind: 'sent' })
    assert.deepEqual(h.emitted, ['unheld'])
  } finally { h.close() }
})

test('a cancelled waiting transaction ends a grant that arrives after cancellation', async () => {
  const h = fixture()
  try {
    await h.attach('writer')
    await h.gateway.attach('private', { sessionId: 'session', size: null }, { source: 'local', windowId: 'window', onFrame() {} })
    const inhibit = await h.gateway.inhibit('session')
    const controller = new AbortController()
    const cancelled = assert.rejects(h.service.invoke({ method: 'transaction', args: ['private'] },
      { signal: controller.signal, pending() {} }), /cancelled/)
    controller.abort()
    inhibit.release()
    await cancelled
    assert.deepEqual(await h.client.input('writer', 'unheld'), { kind: 'sent' })
    assert.deepEqual(h.emitted, ['unheld'])
  } finally { h.close() }
})

test('close flushes a coalesced activity mark before acknowledgement and refuses queued writes', async () => {
  const h = fixture(), originalNow = Date.now
  let at = 100_000
  Date.now = () => at
  try {
    await h.attach('writer')
    await h.client.input('writer', 'first')
    at += 100
    await h.client.input('writer', 'second')
    assert.deepEqual(h.marks, [{ sessionId: 'session', at: 100_000 }])
    const inhibit = await h.client.inhibit('session')
    const queued = h.client.input('writer', 'never')
    await h.client.close()
    assert.deepEqual(h.marks, [{ sessionId: 'session', at: 100_000 }, { sessionId: 'session', at: 100_100 }])
    assert.deepEqual(await queued, { kind: 'unknown-attach' })
    inhibit.release()
    assert.deepEqual(h.emitted, ['first', 'second'])
  } finally { Date.now = originalNow; h.close() }
})
