import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test, type TestContext } from 'node:test'
import { ProcessCalls } from '../../lib-orchestrator/shared/processCalls'
import type { WindowMessage } from '../../lib-orchestrator/shared/windowWire.types'
import type { RemoteOutboundPort } from '../../lib-orchestrator/remoteControl/remoteOutbound.types'
import type { TerminalAttachOwner, TerminalPort } from '../../lib-orchestrator/sessionManager/terminalPort'
import type { TerminalAttachResult, TerminalAttachSpec, TerminalFrame } from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { GatewayWindow } from './gatewayWindow'

const turn = async (): Promise<void> => { for (let n = 0; n < 12; n++) await Promise.resolve() }
class Port extends EventEmitter {
  messages: WindowMessage[] = []
  consume: (message: WindowMessage) => void = () => {}
  closed = false
  postMessage(message: WindowMessage): void { this.messages.push(structuredClone(message)); this.consume(message) }
  start(): void {}
  close(): void { if (!this.closed) { this.closed = true; this.emit('close') } }
}

function fixture(t: TestContext, snapshotStreaming = false) {
  const records: { method: string; args: unknown[] }[] = [], reports: string[] = []
  const owners = new Map<string, TerminalAttachOwner>(), specs = new Map<string, TerminalAttachSpec>()
  const state = { answer: { ok: true } as TerminalAttachResult, wait: null as Promise<void> | null,
    attachError: null as Error | null, detachError: null as Error | null, inputWait: null as Promise<void> | null,
    remoteAttachError: null as Error | null, remoteUnavailable: false, remoteRefusal: false }
  const remoteOwners = new Map<string, (frame: TerminalFrame) => void>()
  const remote = {
    attachTerminal: async (endpoint: string, id: string, spec: TerminalAttachSpec, onFrame: (frame: TerminalFrame) => void) => {
      records.push({ method: 'remote-attach', args: [endpoint, id, spec] }); remoteOwners.set(id, onFrame)
      if (state.remoteAttachError) throw state.remoteAttachError
      if (state.remoteRefusal) return { ok: false, error: { code: 'not-found', detail: 'The remote session disappeared' } }
      return state.remoteUnavailable ? { ok: false, error: { code: 'unavailable', detail: 'offline' } } : { ok: true, value: { attachId: id, sessionId: spec.sessionId } }
    },
    detachTerminal: async (endpoint: string, id: string) => { records.push({ method: 'remote-detach', args: [endpoint, id] }); return { ok: true, value: { attachId: id } } },
    terminalInput: async (endpoint: string, id: string, data: string) => { records.push({ method: 'remote-input', args: [endpoint, id, data] }); return { ok: true, value: {} } },
    terminalActive: async () => ({ ok: true, value: {} }),
  } as unknown as RemoteOutboundPort
  const terminals: Pick<TerminalPort, 'capabilities' | 'attach' | 'input' | 'resize' | 'setGeometryActive' | 'detach' | 'authorize'> = {
    capabilities: { snapshotStreaming },
    attach: async (id, spec, owner) => {
      records.push({ method: 'attach', args: [id, spec, owner] }); owners.set(id, owner); specs.set(id, spec)
      await state.wait
      if (state.attachError) throw state.attachError
      return state.answer
    },
    input: async (id, data) => { records.push({ method: 'input', args: [id, data] }); await state.inputWait; return { kind: 'sent' } },
    resize: async (id, cols, rows) => { records.push({ method: 'resize', args: [id, cols, rows] }); return { kind: 'applied' } },
    setGeometryActive: async (id, active) => { records.push({ method: 'active', args: [id, active] }); return { kind: 'applied' } },
    detach: id => { records.push({ method: 'detach', args: [id] }); specs.delete(id); if (state.detachError) throw state.detachError },
    authorize: async (windowId, id) => {
      const spec = specs.get(id)
      return spec && owners.get(id)?.windowId === windowId ? { sessionId: spec.sessionId } : { refused: true }
    },
  }
  const windows: { server: GatewayWindow; calls: ProcessCalls }[] = []
  t.after(() => { state.detachError = null; for (const window of windows) { window.server.close(); window.calls.close() } })
  const window = (windowId: string) => {
    const port = new Port(), frames: Extract<WindowMessage, { type: 'terminal-frame' }>[] = []
    const remoteFrames: Extract<WindowMessage, { type: 'remote-terminal-frame' }>[] = []
    const nativeCalls: string[] = []
    let acknowledge = true, holdReply = false
    const calls = new ProcessCalls({ send: message => port.emit('message', { data: structuredClone(message) }),
      invoke: async () => { throw new Error('not supported') }, event: () => {}, report: value => reports.push(value) })
    port.consume = message => {
      if (message.type === 'terminal-frame') {
        frames.push(message)
        if (acknowledge) port.emit('message', { data: { type: 'frame-received', generation: message.generation, sequence: message.sequence } })
      } else if (message.type === 'remote-terminal-frame') {
        remoteFrames.push(message)
        if (acknowledge) port.emit('message', { data: { type: 'frame-received', generation: message.generation, sequence: message.sequence } })
      } else if (message.type === 'stream-truncated') return
      else if (message.type === 'power') calls.power(message)
      else if (message.type === 'alive') calls.alive()
      else if (message.type === 'reply' && holdReply) return
      else if (message.type === 'call' || message.type === 'pending' || message.type === 'reply' || message.type === 'cancel'
        || message.type === 'received' || message.type === 'event') calls.receive(message)
      else throw new Error(`Unexpected fixture message: ${message.type}`)
    }
    const server = new GatewayWindow(windowId, true, port, terminals, { outbound: () => remote, snapshot: () => ({ revision: 0, outbound: [], inbound: [] }), clipboard: async () => { nativeCalls.push('clipboard'); return { ok: true, value: { kind: 'empty' } } }, releaseMedia: () => { nativeCalls.push('release-media') } }, { span: (_name, run) => run(), operation: (_name, run) => run() }, value => reports.push(value))
    port.on('close', () => calls.close())
    windows.push({ server, calls })
    return { server, port, calls, frames, remoteFrames, nativeCalls,
      remoteAttach: (id = 'r1') => calls.call('remote', 'remote:terminal-attach', ['endpoint', id, { sessionId: 'remote-session', size: null }]),
      invoke: (method: string, ...args: unknown[]) => calls.call('terminal', method, args),
      attach: (id = 'a1', sessionId = 'session-1') => calls.call('terminal', 'terminal:attach', [id, { sessionId, size: null }]),
      acknowledge: (value: boolean) => { acknowledge = value }, holdReply: (value: boolean) => { holdReply = value },
      frame: (id: string, frame: TerminalFrame) => owners.get(id)!.onFrame(frame),
      received: (generation: number, frameSequence: number) => port.emit('message', { data: { type: 'frame-received', generation, sequence: frameSequence } }),
      reset: (generation: number) => port.emit('message', { data: { type: 'stream-reset', generation } }),
    }
  }
  return { window, state, records, owners, reports, remoteOwners,
    remoteId: () => String(records.filter(record => record.method === 'remote-attach').at(-1)!.args[1]),
    id: () => String(records.filter(record => record.method === 'attach').at(-1)!.args[0]) }
}

test('keeps window claims through a long renderer silence and tells the window it is alive every second', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let at = 0
  t.mock.method(performance, 'now', () => at)
  const h = fixture(t), window = h.window('window')
  await window.attach(); const id = h.id()
  const before = window.port.messages.filter(message => message.type === 'alive').length
  for (let second = 0; second < 90; second++) { at += 1_000; t.mock.timers.tick(1_000); await turn() }
  assert.equal(window.port.closed, false)
  assert.equal(window.port.messages.filter(message => message.type === 'alive').length - before, 90)
  await window.invoke('terminal:input', 'a1', 'after-silence')
  assert.ok(h.records.some(record => record.method === 'input' && record.args[0] === id))
  assert.equal(h.records.some(record => record.method === 'detach'), false)
})

test('rejects alive sent by a window', async t => {
  const h = fixture(t), window = h.window('window')
  window.port.emit('message', { data: { type: 'alive' } })
  assert.equal(window.port.closed, true)
  assert.ok(h.reports.some(report => report.includes('Unexpected window message: alive')))
})

test('routes authorized remote input through its window port to the peer without native callbacks', async t => {
  const h = fixture(t), owner = h.window('owner'), other = h.window('other')
  await owner.remoteAttach('external')
  const privateId = h.remoteId(), data = 'echo Příliš 🧪\r'
  assert.notEqual(privateId, 'external')
  assert.deepEqual(await owner.calls.call('remote', 'remote:terminal-input', ['endpoint', 'external', data]), { ok: true, value: {} })
  await assert.rejects(other.calls.call('remote', 'remote:terminal-input', ['endpoint', 'external', 'foreign']), /not owned by this renderer/)
  assert.deepEqual(h.records.filter(record => record.method === 'remote-input'), [{ method: 'remote-input', args: ['endpoint', privateId, data] }])
  assert.deepEqual(h.records.filter(record => record.method === 'input'), [])
  assert.deepEqual(owner.nativeCalls, [])
  assert.deepEqual(other.nativeCalls, [])
  assert.equal(owner.port.messages.some(message => message.type === 'call'), false)
  assert.equal(other.port.messages.some(message => message.type === 'call'), false)
  assert.deepEqual(h.reports, [])
})

test('uses one aggregate native output budget for local and remote attachments in each window', async t => {
  const h = fixture(t), slow = h.window('slow'), fast = h.window('fast')
  await slow.attach(); const local = h.id()
  await slow.remoteAttach(); const remote = h.remoteId()
  slow.acknowledge(false)
  const frame: TerminalFrame = { type: 'terminal.data', runtimeSessionId: 'r', generation: 1, outputEpoch: 1, outputSeq: 1, lastOutputAt: 1, delta: 'x'.repeat(1_100_000) }
  slow.frame(local, frame); h.remoteOwners.get(remote)!(frame)
  assert.equal(slow.frames.length, 1)
  assert.equal(slow.remoteFrames.length, 0)
  const truncated = slow.port.messages.find(message => message.type === 'stream-truncated')
  assert.ok(truncated && truncated.type === 'stream-truncated')
  assert.ok(h.records.some(record => record.method === 'detach' && record.args[0] === local))
  assert.ok(h.records.some(record => record.method === 'remote-detach' && record.args[1] === remote))
  await fast.remoteAttach(); h.remoteOwners.get(h.remoteId())!(frame)
  assert.equal(fast.remoteFrames.length, 1)
  slow.received(slow.frames[0]!.generation, slow.frames[0]!.sequence)
  slow.reset(truncated.generation); await turn()
  assert.equal(slow.port.closed, false)
  assert.equal(h.records.filter(record => record.method === 'attach').length, 2)
  assert.equal(h.records.filter(record => record.method === 'remote-attach').length, 3)
  assert.deepEqual(h.reports, [])
})

for (const family of ['local', 'remote'] as const) {
  for (const localCode of family === 'local' ? ['not-live', 'unknown-session', 'host-unreachable'] as const : ['unknown-session'] as const)
    test(`reports a fulfilled ${family} ${family === 'local' ? localCode : 'not-found'} recovery refusal to the owning renderer`, async t => {
      const h = fixture(t), window = h.window('window')
      await window.attach(); const local = h.id()
      await window.remoteAttach()
      window.acknowledge(false)
      const frame: TerminalFrame = { type: 'terminal.data', runtimeSessionId: 'r', generation: 1, outputEpoch: 1, outputSeq: 1, lastOutputAt: 1, delta: 'x'.repeat(1_100_000) }
      window.frame(local, frame); window.frame(local, frame)
      const truncated = window.port.messages.find(message => message.type === 'stream-truncated')
      assert.ok(truncated && truncated.type === 'stream-truncated')
      if (family === 'local') h.state.answer = { ok: false, code: localCode, detail: 'The local session disappeared' }
      else if (family === 'remote') h.state.remoteRefusal = true
      else throw new Error('Unknown family')
      window.received(window.frames[0]!.generation, window.frames[0]!.sequence)
      window.acknowledge(true)
      window.reset(truncated.generation); await turn()
      const frames = family === 'local' ? window.frames : window.remoteFrames
      assert.deepEqual(frames.at(-1)?.frame, { type: 'terminal.status', status: 'lost', detail: `The ${family} session disappeared`,
        ...(family === 'local' && localCode !== 'host-unreachable' ? { code: localCode } : {}) })
      assert.equal(window.port.closed, false)
      const input = family === 'local' ? window.invoke('terminal:input', 'a1', 'old')
        : window.calls.call('remote', 'remote:terminal-input', ['endpoint', 'r1', 'old'])
      await assert.rejects(input, /not owned/)
    })

  test(`closes the whole window on asynchronous ${family} native frame failure`, async t => {
    const h = fixture(t), window = h.window('window')
    await window.attach(); const local = h.id()
    await window.remoteAttach(); const remote = h.remoteId()
    window.port.consume = message => { if (message.type === 'terminal-frame' || message.type === 'remote-terminal-frame') throw new Error('native send failed') }
    const frame: TerminalFrame = { type: 'terminal.status', status: 'connecting', detail: null }
    if (family === 'local') window.frame(local, frame)
    else if (family === 'remote') h.remoteOwners.get(remote)!(frame)
    else throw new Error('Unknown family')
    await turn()
    assert.equal(window.port.closed, true)
    await assert.rejects(window.server.authorize('a1'), /not owned/)
    assert.ok(h.records.some(record => record.method === 'detach' && record.args[0] === local))
    assert.ok(h.records.some(record => record.method === 'remote-detach' && record.args[1] === remote))
    assert.ok(h.reports.some(value => value.includes('native send failed')))
  })

  test(`closes the whole window on asynchronous ${family} recovery failure`, async t => {
    const h = fixture(t), window = h.window('window')
    await window.attach(); const local = h.id()
    await window.remoteAttach()
    window.acknowledge(false)
    const frame: TerminalFrame = { type: 'terminal.data', runtimeSessionId: 'r', generation: 1, outputEpoch: 1, outputSeq: 1, lastOutputAt: 1, delta: 'x'.repeat(1_100_000) }
    window.frame(local, frame); window.frame(local, frame)
    const truncated = window.port.messages.find(message => message.type === 'stream-truncated')
    assert.ok(truncated && truncated.type === 'stream-truncated')
    if (family === 'local') h.state.attachError = new Error('recovery failed')
    else if (family === 'remote') h.state.remoteAttachError = new Error('recovery failed')
    else throw new Error('Unknown family')
    window.received(window.frames[0]!.generation, window.frames[0]!.sequence)
    window.reset(truncated.generation); await turn()
    assert.equal(window.port.closed, true)
    await assert.rejects(window.server.authorize('a1'), /not owned/)
    assert.ok(h.reports.some(value => value.includes('recovery failed')))
  })
}

test('retains a normal offline remote attachment without failing the window', async t => {
  const h = fixture(t), window = h.window('window')
  h.state.remoteUnavailable = true
  assert.partialDeepStrictEqual(await window.remoteAttach(), { ok: false, error: { code: 'unavailable' } })
  h.remoteOwners.get(h.remoteId())!({ type: 'terminal.status', status: 'connecting', detail: 'offline' })
  assert.equal(window.remoteFrames.length, 1)
  assert.equal(window.port.closed, false)
  assert.deepEqual(h.reports, [])
})

test('shares encoded native snapshot credit across many attaches while another window keeps consuming', async t => {
  const h = fixture(t, true), slow = h.window('slow'), fast = h.window('fast')
  slow.acknowledge(false)
  const tasks: Promise<void>[] = []
  for (let index = 0; index < 64; index++) {
    await slow.attach(`slow-${index}`)
    const owner = h.owners.get(h.id())!
    tasks.push(owner.snapshotFlow!.reserve(65_536, new AbortController().signal).then(slot => slot.send({
      type: 'terminal.snapshot-chunk', streamId: `stream-${index}`, index: 1, data: '\u001b'.repeat(8_192),
    })))
  }
  await turn()
  assert.ok(slow.frames.length < 64)
  await fast.attach('fast')
  const fastSlot = await h.owners.get(h.id())!.snapshotFlow!.reserve(65_536, new AbortController().signal)
  await fastSlot.send({ type: 'terminal.snapshot-chunk', streamId: 'independent', index: 1, data: 'fast output' })
  assert.equal(fast.frames.length, 1)
  let maximum = 0
  for (let index = 0; index < 64; index++) {
    const nativeBytes = slow.frames.slice(index).reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)), 0)
    maximum = Math.max(maximum, nativeBytes)
    assert.ok(nativeBytes <= 2 * 1024 * 1024)
    const frame = slow.frames[index]!
    assert.ok(frame)
    slow.received(frame.generation, frame.sequence)
    await turn()
  }
  await Promise.all(tasks)
  assert.ok(maximum > 1024 * 1024)
  assert.equal(slow.port.messages.some(message => message.type === 'stream-truncated'), false)
  assert.deepEqual(h.reports, [])
})

test('treats bounded legacy snapshot congestion as normal truncation, not an unsupported Host', async t => {
  const h = fixture(t), window = h.window('legacy')
  await window.attach('legacy')
  const id = h.id()
  window.acknowledge(false)
  window.frame(id, { type: 'terminal.data', runtimeSessionId: 'r', generation: 1, outputEpoch: 1,
    outputSeq: 1, lastOutputAt: 1, delta: 'x'.repeat(1_500_000) })
  window.frame(id, { type: 'terminal.snapshot', projection: { runtimeSessionId: 'r', generation: 1,
    outputEpoch: 1, outputSeq: 1, cols: 80, rows: 24, alive: true, lastOutputAt: 1, screen: 'y'.repeat(1_000_000) } })
  assert.equal(window.port.messages.filter(message => message.type === 'stream-truncated').length, 1)
  assert.equal(window.frames.some(message => message.frame.type === 'terminal.status' && message.frame.status === 'lost'), false)
})

test('cancels an oversized legacy status waiting for credit when its external attach id is reused', async t => {
  const h = fixture(t), window = h.window('legacy')
  await window.attach('fill')
  const fill = h.id()
  await window.attach('reused')
  const old = h.id()
  window.acknowledge(false)
  window.frame(fill, { type: 'terminal.data', runtimeSessionId: 'r', generation: 1, outputEpoch: 1,
    outputSeq: 1, lastOutputAt: 1, delta: 'x'.repeat(2 * 1024 * 1024 - 450) })
  window.frame(old, { type: 'terminal.snapshot', projection: { runtimeSessionId: 'r', generation: 1,
    outputEpoch: 1, outputSeq: 1, cols: 80, rows: 24, alive: true, lastOutputAt: 1, screen: 'y'.repeat(3 * 1024 * 1024) } })
  await window.invoke('terminal:detach', 'reused')
  await window.attach('reused', 'replacement')
  const first = window.frames[0]!
  window.received(first.generation, first.sequence)
  await turn()
  assert.equal(window.frames.some(message => message.attachId === 'reused' && message.frame.type === 'terminal.status'), false)
  assert.equal(window.port.messages.some(message => message.type === 'stream-truncated'), false)
  assert.deepEqual(h.reports, [])
})

for (const outcome of ['success', 'refusal', 'error'] as const)
  test(`isolates a late ${outcome} acknowledgement and old frames after reload and attach id reuse`, async t => {
    const h = fixture(t), first = h.window('window')
    let acknowledge!: () => void
    h.state.wait = new Promise(resolve => { acknowledge = resolve })
    const pending = first.attach('reused', 'old-session'), oldId = h.id()
    const cancelled = assert.rejects(pending, /closed/)
    first.port.close()
    await cancelled
    h.state.wait = null
    const second = h.window('window')
    await second.attach('reused', 'new-session')
    const replacement = h.id()
    if (outcome === 'success') h.state.answer = { ok: true }
    else if (outcome === 'refusal') h.state.answer = { ok: false, code: 'not-live', detail: 'old runtime gone' }
    else if (outcome === 'error') h.state.attachError = new Error('old attach failed')
    else throw new Error(`Unknown outcome: ${outcome}`)
    acknowledge(); await turn()
    first.frame(oldId, { type: 'terminal.status', status: 'lost', detail: 'old frame' })
    assert.deepEqual(second.frames, [])
    assert.equal(await second.server.authorize('reused'), 'new-session')
    assert.equal(h.records.some(record => record.method === 'detach' && record.args[0] === replacement), false)
  })

test('detaches an accepted attach whose acknowledgement rejects before releasing its claim', async t => {
  const h = fixture(t), window = h.window('window')
  let reject!: (error: Error) => void
  h.state.wait = new Promise((_resolve, fail) => { reject = fail })
  const pending = window.attach('accepted'), id = h.id()
  reject(new Error('acknowledgement lost'))
  await assert.rejects(pending, /acknowledgement lost/)
  assert.ok(h.records.some(record => record.method === 'detach' && record.args[0] === id))
  await assert.rejects(window.server.authorize('accepted'), /not owned/)
  h.records.length = 0; window.port.close(); assert.deepEqual(h.records, [])
})

test('detaches a destroyed sender before the pending attach acknowledgement returns', async t => {
  const h = fixture(t), window = h.window('window')
  let acknowledge!: () => void
  h.state.wait = new Promise(resolve => { acknowledge = resolve })
  const pending = window.attach('pending'), id = h.id(), rejected = assert.rejects(pending, /closed/)
  window.port.close(); await rejected
  assert.ok(h.records.some(record => record.method === 'detach' && record.args[0] === id))
  acknowledge(); await turn()
  await assert.rejects(window.server.authorize('pending'), /not owned/)
})

test('forwards each channel to the manager with the arguments it was given', async t => {
  const h = fixture(t), window = h.window('window'), spec = { sessionId: 'session-1', size: { cols: 100, rows: 30 } }
  await window.invoke('terminal:attach', 'a1', spec)
  const id = h.id()
  await window.invoke('terminal:input', 'a1', 'ls\r')
  await window.invoke('terminal:resize', 'a1', 120, 40)
  await window.invoke('terminal:detach', 'a1')
  assert.equal(h.records[0]!.method, 'attach')
  assert.deepEqual(h.records[0]!.args.slice(0, 2), [id, spec])
  assert.equal((h.records[0]!.args[2] as TerminalAttachOwner).source, 'local')
  assert.equal((h.records[0]!.args[2] as TerminalAttachOwner).windowId, 'window')
  assert.deepEqual(h.records.slice(1), [{ method: 'input', args: [id, 'ls\r'] },
    { method: 'resize', args: [id, 120, 40] }, { method: 'detach', args: [id] }])
})

test('carries a refusal through as data rather than as a failed channel', async t => {
  const h = fixture(t), window = h.window('window')
  h.state.answer = { ok: false, code: 'not-live', detail: 'session session-1 has no live runtime' }
  assert.deepEqual(await window.attach(), h.state.answer)
})

test('routes a frame only to the renderer that owns the attach', async t => {
  const h = fixture(t), owner = h.window('owner'), other = h.window('other')
  await owner.attach(); const id = h.id(); await other.attach('b1', 'session-2')
  const frame = { type: 'terminal.status', status: 'connecting', detail: null } as const
  owner.frame(id, frame)
  assert.deepEqual(owner.frames.map(value => [value.attachId, value.frame]), [['a1', frame]])
  assert.deepEqual(other.frames, [])
  await owner.invoke('terminal:detach', 'a1'); owner.frame(id, frame)
  assert.equal(owner.frames.length, 1)
})

test('rejects input, resize and detach from a renderer that does not own the attach', async t => {
  const h = fixture(t), owner = h.window('owner'), other = h.window('other')
  await owner.attach(); h.records.length = 0
  await assert.rejects(other.invoke('terminal:input', 'a1', 'whoami\r'), /not owned/)
  await assert.rejects(other.invoke('terminal:resize', 'a1', 120, 40), /not owned/)
  await assert.rejects(other.invoke('terminal:detach', 'a1'), /not owned/)
  await assert.rejects(other.server.authorize('a1'), /not owned/)
  assert.deepEqual(h.records, [])
})

test('refuses the geometry hand-over to a renderer that does not own the attach', async t => {
  const h = fixture(t), owner = h.window('owner'), other = h.window('other')
  await owner.attach(); const id = h.id()
  await assert.rejects(other.invoke('terminal:active', 'a1', false), /not owned/)
  assert.deepEqual(h.records.filter(record => record.method === 'active'), [])
  assert.equal(await owner.invoke('terminal:active', 'a1', false), undefined)
  assert.deepEqual(h.records.filter(record => record.method === 'active'), [{ method: 'active', args: [id, false] }])
})

test('refuses a second owner for the same attach id in one window and scopes other windows independently', async t => {
  const h = fixture(t), owner = h.window('owner'), other = h.window('other')
  await owner.attach(); const first = h.id()
  await assert.rejects(owner.attach('a1', 'session-2'), /already claimed/)
  assert.equal(h.records.filter(record => record.method === 'attach').length, 1)
  await other.attach('a1', 'session-2')
  assert.notEqual(h.id(), first)
  assert.equal(await owner.server.authorize('a1'), 'session-1')
  assert.equal(await other.server.authorize('a1'), 'session-2')
})

test('refuses a new attach from a closing renderer', async t => {
  const h = fixture(t), window = h.window('window')
  window.port.close()
  await assert.rejects(window.attach(), /closed/)
  assert.deepEqual(h.records, [])
})

test('a reversible close rejects new attaches, preserves existing traffic and accepts attaches after cancellation', async t => {
  const h = fixture(t), window = h.window('window')
  await window.attach(); const id = h.id()
  window.server.setAccepting(false)
  await assert.rejects(window.attach('a2'), /workspace window is closing/)
  await window.invoke('terminal:input', 'a1', 'still live')
  window.frame(id, { type: 'terminal.status', status: 'connecting', detail: null })
  assert.equal(window.frames.length, 1)
  assert.ok(h.records.some(record => record.method === 'input' && record.args[1] === 'still live'))
  window.server.setAccepting(true)
  assert.deepEqual(await window.attach('a2'), { ok: true })
})

test('releases a reservation after the manager refuses an attach', async t => {
  const h = fixture(t), window = h.window('window')
  h.state.answer = { ok: false, code: 'host-unreachable', detail: 'no Host descriptor is published' }
  await window.attach()
  h.state.answer = { ok: true }
  assert.deepEqual(await window.attach('a1', 'session-2'), { ok: true })
})

test('releases a reservation after the manager throws during attach', async t => {
  const h = fixture(t), window = h.window('window')
  h.state.attachError = new Error('attach failed')
  await assert.rejects(window.attach(), /attach failed/)
  h.state.attachError = null
  assert.deepEqual(await window.attach('a1', 'session-2'), { ok: true })
})

test('releases ownership even when the manager throws during detach', async t => {
  const h = fixture(t), window = h.window('window')
  await window.attach(); h.state.detachError = new Error('detach failed')
  await assert.rejects(window.invoke('terminal:detach', 'a1'), /detach failed/)
  h.state.detachError = null
  assert.deepEqual(await window.attach('a1', 'session-2'), { ok: true })
})

test('detaches everything a window held when its renderer goes, and nobody else\'s', async t => {
  const h = fixture(t), window = h.window('window'), other = h.window('other')
  await window.attach(); const a1 = h.id(); await window.attach('a2', 'session-2'); const a2 = h.id()
  await other.attach('b1', 'session-3'); const b1 = h.id(); h.records.length = 0
  window.port.close()
  assert.deepEqual(h.records, [{ method: 'detach', args: [a1] }, { method: 'detach', args: [a2] }])
  other.port.close(); assert.deepEqual(h.records.at(-1), { method: 'detach', args: [b1] })
})

test('drops frames after navigation and lets a later renderer reuse every released id', async t => {
  const h = fixture(t), first = h.window('window')
  await first.attach(); const id = h.id(); first.port.close()
  first.frame(id, { type: 'terminal.status', status: 'lost', detail: 'gone' })
  assert.deepEqual(first.frames, [])
  assert.deepEqual(await h.window('window').attach('a1', 'session-2'), { ok: true })
})

test('answers who owns an attach and which session it is showing', async t => {
  const h = fixture(t), owner = h.window('owner'), other = h.window('other')
  await owner.attach()
  assert.equal(await owner.server.authorize('a1'), 'session-1')
  await assert.rejects(other.server.authorize('a1'), /not owned/)
  await assert.rejects(owner.server.authorize('unknown'), /not owned/)
})

test('forgets which session an attach was showing once it is released', async t => {
  const h = fixture(t), window = h.window('window')
  await window.attach(); await window.attach('a2', 'session-2')
  await window.invoke('terminal:detach', 'a1')
  await assert.rejects(window.server.authorize('a1'), /not owned/)
  assert.equal(await window.server.authorize('a2'), 'session-2')
  window.port.close(); await assert.rejects(window.server.authorize('a2'), /not owned/)
})

test('forgets an attach that was detached, so a later teardown asks for nothing', async t => {
  const h = fixture(t), window = h.window('window')
  await window.attach(); await window.invoke('terminal:detach', 'a1'); h.records.length = 0
  window.port.close(); assert.deepEqual(h.records, [])
})

test('remembers only an attach that was accepted', async t => {
  const h = fixture(t), window = h.window('window')
  h.state.answer = { ok: false, code: 'host-unreachable', detail: 'no Host descriptor is published' }
  await window.attach(); h.records.length = 0
  window.port.close(); assert.deepEqual(h.records, [])
})

test('refuses private operations and targets on the renderer endpoint', async t => {
  const h = fixture(t), window = h.window('window')
  for (const method of ['inhibit', 'transaction', 'write', 'publishRefs', 'close', 'authorize', 'pendingInput'])
    await assert.rejects(window.invoke(method, 'a1'), /Unknown window terminal method/)
  await assert.rejects(window.calls.call('diagnostics', 'host-error', ['secret']), /Unknown window call target/)
  assert.deepEqual(h.records, [])
})

test('a stopped reader truncates once, reattaches after consumption, and an old cancel cannot detach the replacement', async t => {
  const h = fixture(t), slow = h.window('slow'), fast = h.window('fast')
  slow.holdReply(true)
  const pending = slow.attach(), old = h.id()
  void pending.catch(() => {})
  await turn()
  const reply = slow.port.messages.find(message => message.type === 'reply')!
  assert.equal(reply.type, 'reply')
  slow.holdReply(false)
  await fast.attach(); const flowing = h.id()
  slow.acknowledge(false)
  const frame = { type: 'terminal.data', delta: 'x'.repeat(512 * 1024) } as TerminalFrame
  for (let n = 0; n < 40; n++) { slow.frame(old, frame); fast.frame(flowing, frame) }
  assert.equal(slow.frames.length, 3)
  assert.equal(fast.frames.length, 40)
  assert.equal(slow.port.messages.filter(message => message.type === 'stream-truncated').length, 1)
  assert.ok(slow.frames.reduce((bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message)), 0) <= 2 * 1024 * 1024)
  await slow.invoke('terminal:active', 'a1', false)
  await slow.invoke('terminal:resize', 'a1', 99, 33)
  slow.reset(2); assert.equal(h.records.filter(record => record.method === 'attach').length, 2)
  for (const message of slow.frames) slow.received(message.generation, message.sequence)
  slow.reset(2); await turn(); const replacement = h.id()
  assert.notEqual(old, replacement)
  assert.deepEqual(h.records.filter(record => record.method === 'attach').at(-1)!.args[1], { sessionId: 'session-1', size: { cols: 99, rows: 33 } })
  assert.ok(h.records.some(record => record.method === 'active' && record.args[0] === replacement && record.args[1] === false))
  slow.port.emit('message', { data: { type: 'cancel', id: reply.id } })
  assert.equal(await slow.server.authorize('a1'), 'session-1')
  assert.equal(h.records.some(record => record.method === 'detach' && record.args[0] === replacement), false)
  slow.frame(replacement, { type: 'terminal.status', status: 'connecting', detail: null })
  assert.equal(slow.frames.at(-1)!.generation, 2)
})

test('healthy pending input survives 90 seconds while detach and ordinary deadlines remain independent', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const h = fixture(t), window = h.window('window')
  await window.attach()
  let release!: () => void
  h.state.inputWait = new Promise(resolve => { release = resolve })
  let settled = false
  const input = window.invoke('terminal:input', 'a1', 'retained').then(() => { settled = true })
  for (let seconds = 0; seconds < 90; seconds++) { now += 1_000; t.mock.timers.tick(1_000); await turn() }
  assert.equal(settled, false)
  release(); await input; assert.equal(settled, true)
  window.holdReply(true)
  const ordinary = assert.rejects(window.invoke('terminal:resize', 'a1', 120, 40), /30 seconds/)
  for (let seconds = 0; seconds < 30; seconds++) { now += 1_000; t.mock.timers.tick(1_000); await turn() }
  await ordinary
  window.holdReply(false)
  await window.invoke('terminal:detach', 'a1')
  await assert.rejects(window.server.authorize('a1'), /not owned/)
})
