import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WindowMessage } from '../../lib-orchestrator/shared/windowWire.types'
import { WindowGateway } from './windowGateway'

const { receiver } = vi.hoisted(() => ({ receiver: { current: null as ((event: { ports: unknown[] }) => void) | null, power: null as ((event: unknown, message: unknown) => void) | null } }))
vi.mock('electron', () => ({ ipcRenderer: { on: (channel: string, listener: unknown) => {
  if (channel === 'jamat:gateway-port') receiver.current = listener as typeof receiver.current
  else if (channel === 'jamat:power') receiver.power = listener as typeof receiver.power
  else throw new Error(channel)
} } }))
class Port {
  onmessage: ((event: { data: WindowMessage }) => void) | null = null
  onmessageerror: (() => void) | null = null
  messages: WindowMessage[] = []
  consume: (message: WindowMessage) => void = () => {}
  private closing: (() => void) | null = null
  closed = false
  postMessage(message: WindowMessage): void { this.messages.push(message); this.consume(message) }
  start(): void {}
  addEventListener(_event: string, listener: () => void): void { this.closing = listener }
  close(): void { if (!this.closed) { this.closed = true; this.closing?.() } }
  receive(message: WindowMessage): void { this.onmessage?.({ data: message }) }
}
const flush = async (): Promise<void> => { for (let n = 0; n < 12; n++) await Promise.resolve() }
const frame = (sequence: number): WindowMessage => ({ type: 'terminal-frame', attachId: 'a1', generation: 1, sequence,
  frame: { type: 'terminal.status', status: 'connecting', detail: null } })

describe('WindowGateway', () => {
  beforeEach(() => { vi.useFakeTimers(); receiver.current = null })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

  it('keeps the port open across a throttled renderer timer gap and retains accepted work while the gateway is alive', async () => {
    let at = 0
    vi.spyOn(performance, 'now').mockImplementation(() => at)
    const gateway = new WindowGateway(), port = new Port()
    receiver.current!({ ports: [port] })
    port.consume = message => { if (message.type === 'call') port.receive({ type: 'pending', id: message.id }) }
    const pending = gateway.invoke('terminal:input', 'a1', 'held')
    await flush()
    // A hidden window runs its timers once a minute; the gateway's alive messages still arrive.
    for (let second = 1; second <= 90; second++) { at = second * 1_000; port.receive({ type: 'alive' }) }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(port.closed).toBe(false)
    expect(port.messages.filter(message => message.type !== 'call')).toEqual([])
    const call = port.messages.find(message => message.type === 'call')!
    if (call.type !== 'call') throw new Error('Missing call')
    port.receive({ type: 'reply', id: call.id, ok: true, value: 'resumed' })
    expect(await pending).toEqual({ ok: true, value: 'resumed' })
  })

  it('bounds accepted work when the gateway stops sending alive, without closing the port', async () => {
    let at = 0
    vi.spyOn(performance, 'now').mockImplementation(() => at)
    const gateway = new WindowGateway(), port = new Port()
    receiver.current!({ ports: [port] })
    port.consume = message => { if (message.type === 'call') port.receive({ type: 'pending', id: message.id }) }
    const pending = gateway.invoke('terminal:input', 'a1', 'never')
    await flush()
    at = 31_000
    await vi.advanceTimersByTimeAsync(1_001)
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('30 seconds') })
    expect(port.closed).toBe(false)
    port.consume = message => { if (message.type === 'call') port.receive({ type: 'reply', id: message.id, ok: true, value: 'later' }) }
    expect(await gateway.invoke('terminal:resize', 'a1', 120, 40)).toEqual({ ok: true, value: 'later' })
  })

  it('routes remote calls and change events directly through the window port', async () => {
    const gateway = new WindowGateway(), port = new Port(), changed = vi.fn()
    gateway.subscribe('remote:changed', changed)
    receiver.current!({ ports: [port] })
    port.consume = message => { if (message.type === 'call') port.receive({ type: 'reply', id: message.id, ok: true, value: 'remote-answer' }) }
    expect(await gateway.invoke('remote:terminal-input', 'endpoint', 'attach', 'typed')).toEqual({ ok: true, value: 'remote-answer' })
    expect(port.messages[0]).toMatchObject({ target: 'remote', method: 'remote:terminal-input', args: ['endpoint', 'attach', 'typed'] })
    port.receive({ type: 'event', target: 'window', name: 'remote:changed', payload: [] }); await flush()
    expect(changed).toHaveBeenCalledExactlyOnceWith()
    port.close()
  })

  it('waits for local and remote consumers before acknowledging the shared reset generation', async () => {
    const gateway = new WindowGateway(), port = new Port()
    receiver.current!({ ports: [port] })
    let localDone!: () => void, remoteDone!: () => void
    gateway.subscribe('terminal:frame', () => new Promise<void>(resolve => { localDone = resolve }))
    const remote = vi.fn(() => new Promise<void>(resolve => { remoteDone = resolve }))
    gateway.subscribe('remote:terminal-frame', remote)
    const value = { type: 'terminal.status' as const, status: 'connecting' as const, detail: null }
    port.receive(frame(1))
    port.receive({ type: 'remote-terminal-frame', endpointId: 'peer', attachId: 'same', generation: 1, sequence: 2, frame: value })
    port.receive({ type: 'stream-truncated', generation: 2 })
    await flush()
    expect(remote).toHaveBeenCalledWith('peer', 'same', value)
    localDone(); await flush()
    expect(port.messages).toEqual([{ type: 'frame-received', generation: 1, sequence: 1 }])
    remoteDone(); await flush()
    expect(port.messages).toEqual([{ type: 'frame-received', generation: 1, sequence: 1 }, { type: 'frame-received', generation: 1, sequence: 2 }, { type: 'stream-reset', generation: 2 }])
    port.close()
  })

  it('preserves the call envelope and waits for the actual port without using main invoke', async () => {
    const gateway = new WindowGateway(), port = new Port()
    const answer = gateway.invoke('terminal:attach', 'a1', { sessionId: 'session', size: null })
    port.consume = message => {
      if (message.type === 'call') port.receive({ type: 'reply', id: message.id, ok: true, value: { ok: true } })
    }
    receiver.current!({ ports: [port] })
    expect(await answer).toEqual({ ok: true, value: { ok: true } })
    expect(port.messages[0]).toMatchObject({ type: 'call', target: 'terminal', method: 'terminal:attach', args: ['a1', { sessionId: 'session', size: null }] })
    expect(port.messages[1]).toEqual({ type: 'received', id: 1 })
    port.close()
  })

  it('retires frame credit only after all listeners settle, including a rejected listener, then acknowledges reset', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const gateway = new WindowGateway(), port = new Port()
    receiver.current!({ ports: [port] })
    let release!: () => void
    const listener = vi.fn(() => new Promise<void>(done => { release = done }))
    gateway.subscribe('terminal:frame', listener)
    gateway.subscribe('terminal:frame', () => { throw new Error('listener failed') })
    port.receive(frame(1)); port.receive({ type: 'stream-truncated', generation: 2 }); await flush()
    expect(listener).toHaveBeenCalledWith('a1', { type: 'terminal.status', status: 'connecting', detail: null })
    expect(port.messages).toEqual([])
    release(); await flush()
    expect(port.messages).toEqual([{ type: 'frame-received', generation: 1, sequence: 1, failed: true }, { type: 'stream-reset', generation: 2 }])
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'listener failed' }))
    port.close()
  })

  it('does not recredit a closed generation or close its replacement from an old callback', async () => {
    const gateway = new WindowGateway(), old = new Port(), replacement = new Port()
    receiver.current!({ ports: [old] })
    let release!: () => void
    const unsubscribe = gateway.subscribe('terminal:frame', () => new Promise<void>(done => { release = done }))
    old.receive(frame(1)); old.receive({ type: 'stream-truncated', generation: 2 })
    receiver.current!({ ports: [replacement] })
    unsubscribe(); release(); old.onmessageerror?.(); await flush()
    expect(old.messages).toEqual([])
    expect(replacement.closed).toBe(false)
    replacement.receive(frame(1)); await flush()
    expect(replacement.messages).toEqual([{ type: 'frame-received', generation: 1, sequence: 1 }])
    replacement.close()
  })

  it('keeps acknowledged input for 90 seconds, but bounds ordinary replies and disconnected calls', async () => {
    const gateway = new WindowGateway(), port = new Port()
    receiver.current!({ ports: [port] })
    let callId = 0
    port.consume = message => {
      if (message.type === 'call' && message.method === 'terminal:input') {
        callId = message.id; port.receive({ type: 'pending', id: message.id })
      }
    }
    setInterval(() => port.receive({ type: 'alive' }), 1_000)
    let settled = false
    const input = gateway.invoke('terminal:input', 'a1', 'retained').then(value => { settled = true; return value })
    await vi.advanceTimersByTimeAsync(90_000)
    expect(settled).toBe(false)
    port.receive({ type: 'reply', id: callId, ok: true, value: undefined })
    expect(await input).toEqual({ ok: true, value: undefined })
    const ordinary = gateway.invoke('terminal:resize', 'a1', 120, 40)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(await ordinary).toMatchObject({ ok: false, error: expect.stringContaining('30 seconds') })
    const disconnected = gateway.invoke('terminal:input', 'a1', 'never')
    await flush(); port.close()
    expect(await disconnected).toMatchObject({ ok: false, error: expect.stringContaining('closed') })
  })

  it('bounds a missing initial port', async () => {
    const missing = new WindowGateway(), waiting = missing.invoke('terminal:attach', 'a1', {})
    await vi.advanceTimersByTimeAsync(30_001)
    expect(await waiting).toMatchObject({ ok: false, error: expect.stringContaining('did not arrive') })
  })
})
