import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProcessCalls } from '../../shared/processCalls'
import type { TerminalAttachResult } from '../sessionManagerApi.types'
import type { TerminalProcessEvent } from '../terminalProcess.types'
import { TerminalPortClient } from './terminalPortClient'

describe('TerminalPortClient', () => {
  const connections: ProcessCalls[] = []
  afterEach(() => { for (const connection of connections.splice(0)) connection.close(); vi.useRealTimers() })

  function fixture(invoke: ConstructorParameters<typeof ProcessCalls>[0]['invoke']) {
    const controls: { name: string; payload: unknown }[] = []
    const calls = new ProcessCalls({ send: message => server.receive(structuredClone(message)),
      invoke: async () => { throw new Error('not supported') },
      event: (_target, name, payload) => client.receive({ name, payload } as TerminalProcessEvent), report: vi.fn() })
    const server = new ProcessCalls({ send: message => calls.receive(structuredClone(message)), invoke,
      event: (_target, name, payload) => controls.push({ name, payload }), report: vi.fn() })
    const activity = { userInput: vi.fn(), pendingInputHint: vi.fn() }
    const client = new TerminalPortClient(calls, activity)
    connections.push(calls, server)
    return { client, calls, server, controls, activity }
  }

  it('advertises atomic-only transport and refuses streaming rather than dropping its credit contract', async () => {
    const invoke = vi.fn(async () => ({ ok: true }))
    const h = fixture(invoke)
    expect(h.client.capabilities).toEqual({ snapshotStreaming: false })
    await expect(h.client.attach('stream', { sessionId: 'one', size: null }, { source: 'local', onFrame() {},
      snapshotFlow: { reserve: async () => { throw new Error('must not reserve') } } })).rejects.toThrow('does not support snapshot streaming')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('never lets a late attach result or frame detach or reach a replacement external id', async () => {
    const attaches: { id: string; resolve(value: TerminalAttachResult): void }[] = []
    const h = fixture(async (_target, method, args) => {
      if (method !== 'attach') throw new Error(method)
      return new Promise<TerminalAttachResult>(resolve => attaches.push({ id: args[0] as string, resolve }))
    })
    const oldFrame = vi.fn(), newFrame = vi.fn()
    const first = h.client.attach('reused', { sessionId: 'one', size: null }, { source: 'local', onFrame: oldFrame })
    const second = h.client.attach('reused', { sessionId: 'two', size: null }, { source: 'local', onFrame: newFrame })
    expect(attaches[0].id).not.toBe(attaches[1].id)
    attaches[1].resolve({ ok: true })
    await second
    attaches[0].resolve({ ok: true })
    await first
    const frame = { type: 'terminal.status', status: 'connecting', detail: null }
    h.server.emit('terminals', 'frame', { attachId: attaches[0].id, frame })
    h.server.emit('terminals', 'frame', { attachId: attaches[1].id, frame })
    expect(oldFrame).not.toHaveBeenCalled()
    expect(newFrame).toHaveBeenCalledOnce()
    expect(h.controls.filter(control => control.name === 'detach').every(control => control.payload === attaches[0].id)).toBe(true)
  })

  it('invalidates a timed-out input locally before wire cancellation and ignores its late frames', async () => {
    vi.useFakeTimers()
    let id = '', afterCancel: Promise<unknown> | undefined
    const h = fixture(async (_target, method, args, context) => {
      if (method === 'attach') { id = args[0] as string; return { ok: true } }
      else if (method === 'input') {
        context.pending()
        context.signal.addEventListener('abort', () => { afterCancel = h.client.input('attach', 'late') })
        return new Promise(() => {})
      } else throw new Error(method)
    })
    const onFrame = vi.fn()
    await h.client.attach('attach', { sessionId: 'one', size: null }, { source: 'local', onFrame })
    const timedOut = expect(h.client.input('attach', 'held')).rejects.toThrow('lost liveness')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(afterCancel).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await timedOut
    await expect(afterCancel).resolves.toEqual({ kind: 'unknown-attach' })
    h.server.emit('terminals', 'frame', { attachId: id, frame: { type: 'terminal.status', status: 'connecting', detail: null } })
    expect(onFrame).not.toHaveBeenCalled()
  })

  it('uses authoritative pending counts and scopes transaction writes and releases', async () => {
    const h = fixture(async (_target, method) => {
      switch (method) {
        case 'attach': return { ok: true }
        case 'inhibit': return { token: 'hold' }
        case 'transaction': return { token: 'edit' }
        case 'write': return { kind: 'sent' }
        case 'pendingInput': return 7
        default: throw new Error(method)
      }
    })
    h.server.emit('terminals', 'pendingInputHint', [['one', 0]])
    await expect(h.client.pendingInput('one')).resolves.toBe(7)
    expect(h.activity.pendingInputHint).toHaveBeenCalledWith(new Map([['one', 0]]))
    const inhibit = await h.client.inhibit('one')
    inhibit.release(); inhibit.release()
    await h.client.attach('attach', { sessionId: 'one', size: null }, { source: 'local', onFrame() {} })
    const transaction = await h.client.transaction('attach')
    if ('refused' in transaction) throw new Error(transaction.refused)
    await expect(transaction.write('first')).resolves.toEqual({ kind: 'sent' })
    h.client.detach('attach')
    await expect(transaction.write('late')).resolves.toEqual({ refused: 'disconnected' })
    transaction.end(); transaction.end()
    expect(h.controls.filter(control => control.name === 'release')).toEqual([{ name: 'release', payload: 'hold' }])
    expect(h.controls.filter(control => control.name === 'end')).toEqual([{ name: 'end', payload: 'edit' }])
  })
})
