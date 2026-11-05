import type { RemoteControlAnswer } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { WindowServiceTransport } from './windowServiceTransport'
import { ProcessCalls } from '../../../lib-orchestrator/shared/processCalls'
import type { ProcessMessage } from '../../../lib-orchestrator/shared/processWire.types'
import type { ServiceCaller } from '../../../lib-orchestrator/clientApi/serviceTransport.types'

class Port extends EventEmitter {
  readonly send: (message: ProcessMessage) => void
  constructor(send: Port['send']) { super(); this.send = send }
  postMessage(message: ProcessMessage): void { this.send(message) }
  start(): void {}
  close(): void { this.emit('close') }
}

describe('window orchestration transport', () => {
  it('uses the broker caller, refuses other owners and suppresses departed replies/events', async () => {
    const native = vi.fn(), transport = new WindowServiceTransport(native)
    const caller: ServiceCaller = { id: 'epoch', windowId: 'workspace-1', role: 'workspace' }
    let finish!: (value: RemoteControlAnswer) => void
    const observed: ServiceCaller[] = [], events: unknown[] = []
    transport.handle('control:call', owner => { observed.push(owner); return new Promise(resolve => { finish = resolve }) })
    expect(() => transport.handle('shell:platform' as never, (() => {}) as never)).toThrow('Invalid orchestration channel')
    const port = new Port(message => client.receive(message as Parameters<ProcessCalls['receive']>[0]))
    const client = new ProcessCalls({ send: message => port.emit('message', { data: message }), invoke: async () => {},
      event: (...args) => events.push(args), report: message => { throw new Error(message) } })
    transport.open(caller, port)
    try {
      const result = client.call('service', 'control:call', ['host.status', {}])
      void result.catch(() => {})
      expect(observed).toEqual([caller])
      await expect(client.call('service', 'remote:connect', [])).rejects.toThrow('Unknown orchestration channel')
      transport.publish('rate:changed', { ...caller, role: 'main' })
      expect(events).toEqual([])
      transport.publish('rate:changed', caller)
      expect(events).toEqual([['window', 'rate:changed', []]])
      transport.close(caller, 'reload')
      transport.publish('rate:changed', caller)
      finish({ protocol: 'appjamat-v3-control.v1', requestId: null, operation: null, operationId: null, ok: true, value: {} })
      expect(events).toHaveLength(1)
      expect(transport.isCurrent(caller)).toBe(false)
      expect(transport.isCurrent({ ...caller, role: 'main' })).toBe(false)
      client.close()
      await expect(result).rejects.toThrow()
      expect(native).not.toHaveBeenCalled()
    } finally { client.close(); transport.stop() }
  })

  it('renews an admitted long operation with its own alive messages while the renderer sends nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
    const transport = new WindowServiceTransport(() => {})
    let finish!: (value: RemoteControlAnswer) => void
    transport.handle('control:call', () => new Promise(resolve => { finish = resolve }))
    const port = new Port(message => {
      if (message.type === 'alive') client.alive()
      else client.receive(message as Parameters<ProcessCalls['receive']>[0])
    })
    const client = new ProcessCalls({ send: message => port.emit('message', { data: message }), invoke: async () => {}, event() {}, report: vi.fn() })
    transport.open({ id: 'epoch', windowId: 'main', role: 'main' }, port)
    try {
      const result = client.call('service', 'control:call', ['sessions.finish', {}])
      await vi.advanceTimersByTimeAsync(45_000)
      finish({ protocol: 'appjamat-v3-control.v1', requestId: null, operation: null, operationId: null, ok: true, value: 'settled' })
      await expect(result).resolves.toEqual({ protocol: 'appjamat-v3-control.v1', requestId: null, operation: null, operationId: null, ok: true, value: 'settled' })
    } finally { client.close(); transport.stop(); vi.useRealTimers() }
  })
})
