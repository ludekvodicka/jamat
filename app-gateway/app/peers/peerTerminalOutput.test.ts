import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RemoteControlLiveTerminal } from '../../../lib-orchestrator/remoteControl/remoteControlLiveTerminal'
import type { TerminalFrame } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { PeerTerminalOutput } from './peerTerminalOutput'

const turn = async (): Promise<void> => { for (let n = 0; n < 8; n++) await Promise.resolve() }
function fixture(automatic = false) {
  const frames = new Map<string, (frame: TerminalFrame) => void>()
  const attached: { id: string; spec: unknown }[] = [], detached: string[] = [], active: [string, boolean][] = []
  const writes: { value: unknown; done: (error?: Error) => void }[] = []
  const state = { attach: 'ok' as 'ok' | 'refused' | 'throw' }
  let closed = 0, sendResult = true
  const terminal: Pick<RemoteControlLiveTerminal, 'attachLive' | 'inputLive' | 'resizeLive' | 'setLiveActive' | 'detachLive' | 'detachOwner' | 'pasteImageLive' | 'pasteFileLive'> = {
    attachLive: async (_owner, id, spec, frame) => {
      attached.push({ id, spec }); frames.set(id, frame)
      if (state.attach === 'refused') return { ok: false, error: { code: 'unavailable', detail: 'runtime ended' } }
      else if (state.attach === 'throw') throw new Error('attach failed')
      else if (state.attach !== 'ok') throw new Error(`Unknown attach result: ${state.attach}`)
      return { ok: true, value: { attachId: id, sessionId: spec.sessionId } }
    },
    inputLive: async (_owner, id) => ({ ok: true, value: { attachId: id, accepted: true, characterCount: 0 } }),
    resizeLive: async (_owner, id) => ({ ok: true, value: { attachId: id, accepted: true, applied: true } }),
    setLiveActive: async (_owner, id, value) => {
      active.push([id, value]); return { ok: true, value: { attachId: id, accepted: true, applied: true } }
    },
    detachLive: (_owner, id) => { detached.push(id); return { ok: true, value: { attachId: id } } },
    detachOwner: () => { for (const id of frames.keys()) if (!detached.includes(id)) detached.push(id) },
    pasteImageLive: async () => ({ ok: false, error: { code: 'unavailable', detail: 'fixture' } }),
    pasteFileLive: async () => ({ ok: false, error: { code: 'unavailable', detail: 'fixture' } }),
  }
  const output = new PeerTerminalOutput('peer', terminal, {
    send: (value, done) => { writes.push({ value, done: done! }); if (automatic) done?.(); return sendResult },
    close: () => { closed++ },
  }, { span: (_name, run) => run() })
  return { output, attached, detached, active, writes, frames, state, closed: () => closed,
    refuse: () => { sendResult = false },
    attach: (id: string) => output.attachLive('peer', id, { sessionId: id, size: null }, () => {}),
    emit: (id: string, frame: TerminalFrame) => frames.get(id)!(frame),
  }
}

test('one peer shares its two MiB credit across attachments while another peer keeps flowing', async () => {
  const slow = fixture(), fast = fixture(true)
  await slow.attach('a'); await slow.attach('b'); await fast.attach('a')
  const [a, b] = slow.attached.map(value => value.id), flowing = fast.attached[0]!.id
  const frame: TerminalFrame = { type: 'terminal.data', runtimeSessionId: 'runtime', generation: 1, outputEpoch: 1, outputSeq: 1, lastOutputAt: 1, delta: 'x'.repeat(512 * 1024) }
  for (let n = 0; n < 40; n++) { slow.emit(n % 2 ? b! : a!, frame); fast.emit(flowing, frame) }
  assert.equal(slow.writes.length, 3)
  assert.equal(fast.writes.length, 40)
  assert.deepEqual(slow.detached, [a, b])
  assert.ok(slow.writes.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value.value)), 0) <= 2 * 1024 * 1024)
  await slow.output.resizeLive('peer', 'a', 99, 33)
  await slow.output.setLiveActive('peer', 'a', false)
  slow.writes[0]!.done(); slow.writes[1]!.done(); await turn()
  assert.equal(slow.attached.length, 2)
  slow.writes[2]!.done(); await turn()
  assert.equal(slow.attached.length, 4)
  const next = slow.attached[2]!
  assert.notEqual(next.id, a)
  assert.deepEqual(next.spec, { sessionId: 'a', size: { cols: 99, rows: 33 } })
  assert.deepEqual(slow.active, [[next.id, false]])
  slow.emit(a!, frame); slow.writes[0]!.done()
  assert.equal(slow.writes.length, 3)
  slow.emit(next.id, frame)
  assert.equal(slow.writes.length, 4)
  slow.output.detachOwner('peer'); fast.output.detachOwner('peer')
})

for (const frame of [{ type: 'terminal.exit', exitCode: 0 } as TerminalFrame,
  { type: 'terminal.status', status: 'lost', detail: 'gone' } as TerminalFrame])
  test(`${frame.type} retires the public claim without retiring submitted native bytes`, async () => {
    const h = fixture()
    await h.attach('reuse'); const old = h.attached[0]!.id
    const data: TerminalFrame = { type: 'terminal.data', runtimeSessionId: 'runtime', generation: 1, outputEpoch: 1, outputSeq: 1, lastOutputAt: 1, delta: 'x'.repeat(512 * 1024) }
    h.emit(old, data); h.emit(old, data); h.emit(old, frame)
    assert.equal((await h.attach('reuse')).ok, true)
    const next = h.attached[1]!.id
    h.emit(next, data); h.emit(next, data)
    assert.equal(h.writes.length, 4)
    assert.deepEqual(h.detached, [next])
    h.writes[0]!.done(); h.writes[1]!.done(); h.writes[2]!.done()
    assert.equal(h.attached.length, 2)
    h.writes[3]!.done(); await turn()
    const replacement = h.attached[2]!.id
    h.emit(old, frame); h.writes[2]!.done()
    assert.equal((await h.output.inputLive('peer', 'reuse', 'still live')).ok, true)
    assert.equal(h.detached.includes(replacement), false)
    h.output.detachOwner('peer')
  })

for (const failure of ['refused', 'throw'] as const)
  test(`a ${failure} recovery attach tells the peer that its connection was lost`, async () => {
    const h = fixture()
    await h.attach('a'); const id = h.attached[0]!.id
    const frame: TerminalFrame = { type: 'terminal.data', runtimeSessionId: 'runtime', generation: 1,
      outputEpoch: 1, outputSeq: 1, lastOutputAt: 1, delta: 'x'.repeat(512 * 1024) }
    for (let n = 0; n < 4; n++) h.emit(id, frame)
    h.state.attach = failure
    for (const write of h.writes) write.done()
    await turn()
    assert.equal(h.closed(), 1)
    assert.equal((await h.output.inputLive('peer', 'a', 'late')).ok, false)
    for (const write of h.writes) write.done()
    assert.equal(h.attached.length, 2)
  })

for (const ending of [{ type: 'terminal.exit', exitCode: 0 } as TerminalFrame,
  { type: 'terminal.status', status: 'lost', detail: 'ended' } as TerminalFrame])
  test(`an overflowing ${ending.type} reports connection loss instead of silently losing terminal end`, async () => {
    const h = fixture()
    await h.attach('a'); const id = h.attached[0]!.id
    const frame: TerminalFrame = { type: 'terminal.data', runtimeSessionId: 'runtime', generation: 1,
      outputEpoch: 1, outputSeq: 1, lastOutputAt: 1, delta: 'x'.repeat(512 * 1024) }
    h.emit(id, frame); h.emit(id, frame)
    const used = h.writes.reduce((sum, write) => sum + Buffer.byteLength(JSON.stringify(write.value)), 0)
    const envelope = Buffer.byteLength(JSON.stringify(h.writes[0]!.value)) - frame.delta.length
    h.emit(id, { ...frame, delta: 'x'.repeat(2 * 1024 * 1024 - used - envelope - 1) })
    assert.equal(h.writes.length, 3)
    h.emit(id, ending)
    assert.equal(h.closed(), 1)
    for (const write of h.writes) write.done()
    await turn()
    assert.equal(h.attached.length, 1)
    assert.equal((await h.output.inputLive('peer', 'a', 'late')).ok, false)
  })

for (const failure of ['callback', 'refused', 'oversized'] as const)
  test(`a ${failure} send failure closes the peer once and retires its claims`, async () => {
    const h = fixture()
    await h.attach('a'); const id = h.attached[0]!.id
    if (failure === 'refused') h.refuse()
    else if (failure === 'callback' || failure === 'oversized') {}
    else throw new Error(`Unknown failure: ${failure}`)
    h.emit(id, { type: 'terminal.data', runtimeSessionId: 'runtime', generation: 1, outputEpoch: 1, outputSeq: 1, lastOutputAt: 1, delta: 'x'.repeat(failure === 'oversized' ? 1024 * 1024 : 1) })
    if (failure === 'callback') { h.writes[0]!.done(new Error('closed')); h.writes[0]!.done() }
    assert.equal(h.closed(), 1)
    assert.deepEqual(h.detached, [id])
    assert.equal((await h.output.inputLive('peer', 'a', 'late')).ok, false)
    h.emit(id, { type: 'terminal.data', runtimeSessionId: 'runtime', generation: 1, outputEpoch: 1, outputSeq: 1, lastOutputAt: 1, delta: 'late' })
    assert.equal(h.closed(), 1)
  })
