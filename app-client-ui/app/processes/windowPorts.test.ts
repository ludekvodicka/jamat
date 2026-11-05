import { EventEmitter } from 'node:events'
import type { MessagePortMain, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowPorts } from './windowPorts'

const { channels } = vi.hoisted(() => ({ channels: [] as { port1: { close: ReturnType<typeof vi.fn> }; port2: { close: ReturnType<typeof vi.fn> } }[] }))
vi.mock('electron', () => ({ MessageChannelMain: class {
  port1 = { close: vi.fn() }
  port2 = { close: vi.fn() }
  constructor() { channels.push(this) }
} }))

class Contents extends EventEmitter {
  id: number
  destroyed = false
  postMessage = vi.fn()
  send = vi.fn()
  constructor(id: number) { super(); this.id = id }
  isDestroyed(): boolean { return this.destroyed }
  asContents(): WebContents { return this as unknown as WebContents }
}

describe('WindowPorts', () => {
  beforeEach(() => { channels.length = 0 })

  it('watches both ways a window can lose its renderer, and wires each of them once', () => {
    const open = vi.fn(), close = vi.fn(), report = vi.fn()
    const broker = new WindowPorts({ open, close, setAccepting: vi.fn(), acceptsRenderer: () => true, authorize: async () => 'session', report })
    const sender = new Contents(41)
    broker.watch(sender.asContents()); broker.watch(sender.asContents())
    expect(sender.listenerCount('destroyed')).toBe(1)
    expect(sender.listenerCount('did-start-navigation')).toBe(1)
    sender.emit('did-finish-load')
    const first = open.mock.calls[0]!
    expect(first).toEqual(['41', expect.any(String), channels[0]!.port1, true])
    expect(sender.postMessage).toHaveBeenCalledWith('jamat:gateway-port', { epoch: first[1] }, [channels[0]!.port2])
    sender.emit('did-start-navigation', {}, '', true, true)
    sender.emit('did-start-navigation', {}, '', false, false)
    expect(close).not.toHaveBeenCalled()
    sender.emit('did-start-navigation', {}, '', false, true)
    expect(close).toHaveBeenCalledWith('41', first[1])
    sender.emit('did-finish-load')
    const second = open.mock.calls[1]!
    expect(second[1]).not.toBe(first[1])
    sender.destroyed = true; sender.emit('destroyed')
    expect(close.mock.calls).toEqual([['41', first[1]], ['41', second[1]]])
    expect(report).not.toHaveBeenCalled()
  })

  it('delivers power directly to current documents and continues after a failed sender', () => {
    const broker = new WindowPorts({ open: vi.fn(), close: vi.fn(), setAccepting: vi.fn(), acceptsRenderer: () => true, authorize: async () => 'session', report: vi.fn() })
    const first = new Contents(1), second = new Contents(2)
    for (const sender of [first, second]) { broker.watch(sender.asContents()); sender.emit('did-finish-load') }
    first.send.mockImplementation(() => { throw new Error('document gone') })
    const message = { type: 'power' as const, epoch: 1, event: 'suspend' as const }
    broker.power(message)
    expect(second.send).toHaveBeenCalledExactlyOnceWith('jamat:power', message)
    expect(broker.identity(first.asContents())).toBeNull()
    broker.stop()
  })

  it('refuses late authorization after navigation and sends only the broker identity', async () => {
    let resolve!: (value: string) => void
    const authorize = vi.fn(() => new Promise<string>(done => { resolve = done }))
    const open = vi.fn(), broker = new WindowPorts({ open, close: vi.fn(), setAccepting: vi.fn(), acceptsRenderer: () => true, authorize, report: vi.fn() })
    const sender = new Contents(7), unknown = new Contents(8)
    broker.watch(sender.asContents()); sender.emit('did-finish-load')
    const pending = broker.authorize(sender.asContents(), 'attach')
    const identity = broker.identity(sender.asContents())!
    const lifetime = broker.signal(identity)!
    expect(broker.sender(identity)).toBe(sender)
    expect(lifetime.aborted).toBe(false)
    expect(authorize).toHaveBeenCalledWith('7', open.mock.calls[0]![1], 'attach')
    sender.emit('did-start-navigation', {}, '', false, true)
    sender.emit('did-finish-load')
    resolve('session')
    expect(lifetime.aborted).toBe(true)
    expect(broker.signal(identity)).toBeNull()
    expect(broker.sender(identity)).toBeNull()
    expect(broker.signal(broker.identity(sender.asContents())!)!.aborted).toBe(false)
    expect(await pending).toBeNull()
    expect(await broker.authorize(unknown.asContents(), 'attach')).toBeNull()
    broker.stop()
  })

  it('carries initial and reversible attach eligibility under the current document epoch', () => {
    const open = vi.fn(), setAccepting = vi.fn(), sender = new Contents(7)
    const broker = new WindowPorts({ open, close: vi.fn(), setAccepting, acceptsRenderer: () => false,
      authorize: async () => null, report: vi.fn() })
    broker.watch(sender.asContents()); sender.emit('did-finish-load')
    expect(open.mock.calls[0]![3]).toBe(false)
    const epoch = open.mock.calls[0]![1]
    broker.setAccepting(sender.asContents(), true)
    broker.setAccepting(sender.asContents(), false)
    expect(setAccepting.mock.calls).toEqual([['7', epoch, true], ['7', epoch, false]])
    sender.emit('did-start-navigation', {}, '', false, true)
    broker.setAccepting(sender.asContents(), true)
    expect(setAccepting).toHaveBeenCalledTimes(2)
    broker.stop()
  })

  it('revokes stopped and failed transfers, and never brokers a later load during quit', () => {
    const open = vi.fn((_id: string, _epoch: string, _port: MessagePortMain) => {}), close = vi.fn(), report = vi.fn()
    const broker = new WindowPorts({ open, close, setAccepting: vi.fn(), acceptsRenderer: () => true, authorize: async () => null, report })
    const first = new Contents(1), second = new Contents(2)
    broker.watch(first.asContents()); broker.watch(second.asContents())
    first.emit('did-finish-load')
    second.postMessage.mockImplementation(() => { throw new Error('destroyed during transfer') })
    second.emit('did-finish-load')
    expect(channels[1]!.port1.close).toHaveBeenCalledOnce()
    expect(channels[1]!.port2.close).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledWith('2', open.mock.calls[1]![1])
    expect(report).toHaveBeenCalledWith('Error: destroyed during transfer')
    broker.stop(); first.emit('did-finish-load')
    expect(open).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledWith('1', open.mock.calls[0]![1])
  })
  it('brokers trusted role/epoch identities to all windows and closes the final reload owner once', () => {
    const orchestration = { open: vi.fn(), close: vi.fn() }, gateway = vi.fn()
    const broker = new WindowPorts({ open: gateway, close: vi.fn(), orchestration, setAccepting: vi.fn(),
      acceptsRenderer: () => true, authorize: async () => null, report: vi.fn() })
    const debug = new Contents(9), main = new Contents(10)
    broker.watch(debug.asContents(), { windowId: 'holder', role: 'workspace' })
    broker.watch(main.asContents(), { windowId: 'main', role: 'main' })
    debug.emit('did-finish-load'); main.emit('did-finish-load')
    expect(gateway).toHaveBeenCalledTimes(2)
    expect(orchestration.open.mock.calls[0]![0]).toMatchObject({ windowId: 'holder', role: 'workspace', id: gateway.mock.calls[0]![1] })
    expect(orchestration.open.mock.calls[1]![0]).toMatchObject({ windowId: 'main', role: 'main', id: gateway.mock.calls[1]![1] })
    for (let i = 0; i < 10; i++) { debug.emit('did-start-navigation', {}, '', false, true); debug.emit('did-finish-load') }
    const last = orchestration.open.mock.calls.at(-1)![0]
    debug.emit('render-process-gone'); debug.emit('destroyed')
    expect(orchestration.close.mock.calls.filter(call => call[1] === 'closed')).toEqual([[last, 'closed', '9']])
    expect((broker as unknown as { lastCallers: Map<unknown, unknown> }).lastCallers.size).toBe(1)
    broker.stop()
  })

})
