import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowOrchestrator } from './windowOrchestrator'
import type { ProcessMessage } from '../../lib-orchestrator/shared/processWire.types'

const receiver = vi.hoisted(() => ({ port: null as ((event: { ports: unknown[] }) => void) | null,
  power: null as ((event: unknown, message: unknown) => void) | null }))
vi.mock('electron', () => ({ ipcRenderer: { on: (channel: string, listener: unknown) => {
  if (channel === 'jamat:orchestrator-port') receiver.port = listener as typeof receiver.port
  else if (channel === 'jamat:power') receiver.power = listener as typeof receiver.power
  else throw new Error(channel)
} } }))
class Port {
  onmessage: ((event: { data: ProcessMessage }) => void) | null = null
  onmessageerror: (() => void) | null = null
  readonly messages: ProcessMessage[] = []
  consume: (message: ProcessMessage) => void = () => {}
  closing: (() => void) | null = null
  closed = false
  postMessage(message: ProcessMessage): void { this.messages.push(message); this.consume(message) }
  start(): void {}
  addEventListener(_event: string, listener: () => void): void { this.closing = listener }
  close(): void { if (!this.closed) { this.closed = true; this.closing?.() } }
  receive(data: ProcessMessage): void { this.onmessage?.({ data }) }
}
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve() }

describe('WindowOrchestrator', () => {
  beforeEach(() => { vi.useFakeTimers(); receiver.port = null; receiver.power = null })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

  it('queues the first call until the broker endpoint arrives and preserves args, result and event envelopes', async () => {
    const owner = new WindowOrchestrator(), changed = vi.fn()
    owner.subscribe('rate:changed', changed)
    const pending = owner.invoke('control:call', 'host.status', { fixture: true })
    const port = new Port()
    port.consume = message => { if (message.type === 'call') port.receive({ type: 'reply', id: message.id, ok: true, value: { ok: true, value: 'answer' } }) }
    receiver.port!({ ports: [port] })
    await expect(pending).resolves.toEqual({ ok: true, value: { ok: true, value: 'answer' } })
    expect(port.messages[0]).toMatchObject({ type: 'call', target: 'service', method: 'control:call', args: ['host.status', { fixture: true }] })
    port.receive({ type: 'event', target: 'window', name: 'rate:changed', payload: [] }); await flush()
    expect(changed).toHaveBeenCalledExactlyOnceWith()
    expect(() => owner.subscribe('remote:changed', vi.fn())).toThrow('Unknown orchestration event')
    port.close()
    await expect(owner.invoke('control:call', 'host.status', {})).resolves.toMatchObject({ ok: false })
  })

  it('rejects a missing endpoint and closes a late transferred port', async () => {
    const owner = new WindowOrchestrator()
    const pending = owner.invoke('control:call', 'host.status', {})
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(pending).resolves.toEqual({ ok: false, error: 'Orchestrator window port did not arrive within 30 seconds' })
    const port = new Port(); receiver.port!({ ports: [port] })
    expect(port.closed).toBe(true)
    expect(port.messages).toEqual([])
  })

  it('keeps the port open across a throttled renderer timer gap and retains accepted work while the orchestrator is alive', async () => {
    let at = 0
    vi.spyOn(performance, 'now').mockImplementation(() => at)
    const owner = new WindowOrchestrator(), port = new Port()
    receiver.port!({ ports: [port] })
    port.consume = message => { if (message.type === 'call') port.receive({ type: 'pending', id: message.id }) }
    const pending = owner.invoke('control:call', 'sessions.finish', {})
    await flush()
    // A hidden window runs its timers once a minute; the orchestrator's alive messages still arrive.
    for (let second = 1; second <= 90; second++) { at = second * 1_000; port.receive({ type: 'alive' }) }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(port.closed).toBe(false)
    expect(port.messages.filter(message => message.type !== 'call')).toEqual([])
    const call = port.messages.find(message => message.type === 'call')!
    if (call.type !== 'call') throw new Error('Missing call')
    port.receive({ type: 'reply', id: call.id, ok: true, value: 'settled' })
    await expect(pending).resolves.toEqual({ ok: true, value: 'settled' })
  })

  it('bounds accepted work when the orchestrator stops sending alive, without closing the port', async () => {
    let at = 0
    vi.spyOn(performance, 'now').mockImplementation(() => at)
    const owner = new WindowOrchestrator(), port = new Port()
    receiver.port!({ ports: [port] })
    port.consume = message => { if (message.type === 'call') port.receive({ type: 'pending', id: message.id }) }
    const pending = owner.invoke('control:call', 'sessions.finish', {})
    await flush()
    at = 31_000
    await vi.advanceTimersByTimeAsync(1_001)
    await expect(pending).resolves.toMatchObject({ ok: false, error: expect.stringContaining('30 seconds') })
    expect(port.closed).toBe(false)
    port.consume = message => { if (message.type === 'call') port.receive({ type: 'reply', id: message.id, ok: true, value: 'later' }) }
    await expect(owner.invoke('control:call', 'host.status', {})).resolves.toEqual({ ok: true, value: 'later' })
  })
})
