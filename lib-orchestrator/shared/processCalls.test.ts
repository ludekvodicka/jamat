import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProcessCalls } from './processCalls'
import type { ProcessCallMessage } from './processWire.types'

describe('ProcessCalls', () => {
  const connections: ProcessCalls[] = []
  afterEach(() => { for (const connection of connections.splice(0)) connection.close(); vi.useRealTimers(); vi.restoreAllMocks() })

  function pair(invoke: ConstructorParameters<typeof ProcessCalls>[0]['invoke']) {
    const report = vi.fn()
    const client = new ProcessCalls({ send: value => server.receive(structuredClone(value)),
      invoke: async () => { throw new Error('not supported') }, event: vi.fn(), report })
    const server = new ProcessCalls({ send: value => client.receive(structuredClone(value)), invoke, event: vi.fn(), report })
    connections.push(client, server)
    return { client, server, report }
  }

  it('lets acknowledged intentional waits exceed 60 seconds while independent release is processed', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const { client } = pair(async (_target, method, _args, context) => {
      if (method === 'input') {
        context.pending()
        await new Promise<void>(resolve => { release = resolve })
        return { kind: 'sent' }
      } else if (method === 'release') { release(); return null }
      else throw new Error(method)
    })
    let settled = false
    const result = client.call('terminals', 'input', []).finally(() => { settled = true })
    for (let second = 0; second < 90; second++) { client.alive(); await vi.advanceTimersByTimeAsync(1_000) }
    expect(settled).toBe(false)
    await client.call('terminals', 'release', [])
    await expect(result).resolves.toEqual({ kind: 'sent' })
  })

  it('does not extend a lost ordinary reply and invalidates before sending cancellation', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const { client } = pair(async (_target, _method, _args, context) => {
      context.signal.addEventListener('abort', () => order.push('wire cancelled'))
      return new Promise(() => {})
    })
    const result = client.call('x', 'lost', [], { invalidate: () => order.push('invalidated') })
    const rejected = expect(result).rejects.toThrow('lost liveness')
    for (let second = 0; second < 30; second++) { client.alive(); await vi.advanceTimersByTimeAsync(1_000) }
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(order).toEqual(['invalidated', 'wire cancelled'])
  })

  it('bounds a pending wait with no heartbeats and rejects all calls on close', async () => {
    vi.useFakeTimers()
    const aborted = vi.fn()
    const { client, server } = pair(async (_target, _method, _args, context) => {
      context.pending()
      context.signal.addEventListener('abort', aborted)
      return new Promise(() => {})
    })
    const expired = expect(client.call('x', 'held', [])).rejects.toThrow('lost liveness')
    await vi.advanceTimersByTimeAsync(30_001)
    await expired
    expect(aborted).toHaveBeenCalledOnce()
    const first = expect(client.call('x', 'held', [])).rejects.toThrow('connection closed')
    const second = expect(client.call('x', 'held', [])).rejects.toThrow('connection closed')
    client.close()
    server.close()
    await Promise.all([first, second])
    expect(aborted).toHaveBeenCalledTimes(3)
  })

  it.each(['before-timer', 'after-timer'] as const)('keeps started, accepted and replied timestamps on the awake clock with power %s', async order => {
    vi.useFakeTimers()
    let at = 0
    vi.spyOn(performance, 'now').mockImplementation(() => at)
    let finish!: () => void
    const { client, server } = pair(async (_target, method, _args, context) => {
      if (method === 'held') {
        context.pending()
        await new Promise<void>(resolve => { finish = resolve })
      } else if (method !== 'ordinary') throw new Error(method)
      return method
    })
    const held = client.call('x', 'held', [])
    if (order === 'before-timer') {
      client.power({ type: 'power', epoch: 1, event: 'suspend' })
      server.power({ type: 'power', epoch: 1, event: 'suspend' })
    } else if (order !== 'after-timer') throw new Error('Unknown power ordering')
    at = 1_000
    await vi.advanceTimersByTimeAsync(1_001)
    at = 91_000
    vi.advanceTimersByTime(999)
    if (order === 'after-timer') {
      client.power({ type: 'power', epoch: 1, event: 'suspend' })
      server.power({ type: 'power', epoch: 1, event: 'suspend' })
    }
    client.alive()
    expect(await client.call('x', 'ordinary', [])).toBe('ordinary')
    client.power({ type: 'power', epoch: 2, event: 'resume' })
    server.power({ type: 'power', epoch: 2, event: 'resume' })
    await vi.advanceTimersByTimeAsync(1)
    finish()
    expect(await held).toBe('held')
    const expired = expect(client.call('x', 'held', [])).rejects.toThrow('lost liveness')
    at += 30_000
    await vi.advanceTimersByTimeAsync(1_000)
    await expired
    vi.restoreAllMocks()
  })

  it('renews existing ordinary, pending and unreceived replies once for heartbeat-before-delayed-suspend', async () => {
    vi.useFakeTimers()
    let at = 0
    vi.spyOn(performance, 'now').mockImplementation(() => at)
    const aborted: string[] = []
    const { client, server } = pair(async (_target, method, _args, context) => {
      if (method === 'pending') context.pending()
      else if (method !== 'ordinary') throw new Error(method)
      context.signal.addEventListener('abort', () => aborted.push(method))
      return new Promise(() => {})
    })
    const ordinary = expect(client.call('x', 'ordinary', [])).rejects.toThrow('lost liveness')
    const pending = expect(client.call('x', 'pending', [])).rejects.toThrow('lost liveness')
    const receipt = new ProcessCalls({ send() {}, event() {}, report: vi.fn(),
      invoke: async (_target, _method, _args, context) => {
        context.signal.addEventListener('abort', () => aborted.push('receipt'))
        return 'grant'
      } })
    connections.push(receipt)
    receipt.receive({ type: 'call', id: 1, target: 'x', method: 'grant', args: [] })
    await Promise.resolve()
    at = 91_000
    for (const calls of [client, server, receipt]) calls.alive()
    for (const calls of [client, server, receipt]) calls.power({ type: 'power', epoch: 1, event: 'suspend' })
    await vi.advanceTimersByTimeAsync(1_001)
    expect(aborted).toEqual([])
    at += 29_999
    await vi.advanceTimersByTimeAsync(1_000)
    for (const calls of [client, server, receipt]) calls.power({ type: 'power', epoch: 1, event: 'suspend' })
    expect(aborted).toEqual([])
    at += 1
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.all([ordinary, pending])
    expect(aborted.sort()).toEqual(['ordinary', 'pending', 'receipt'])
  })

  it('reports unknown replies without settling another request', async () => {
    const { client, report } = pair(async () => 42)
    client.receive({ type: 'reply', id: 9876, ok: true, value: 0 })
    expect(report).toHaveBeenCalledWith('Unknown private reply id 9876')
    await expect(client.call('x', 'value', [])).resolves.toBe(42)
  })

  it('retains reply cleanup until receipt, including a late grant and a missing receipt', async () => {
    vi.useFakeTimers()
    const replies: ProcessCallMessage[] = [], cancelled = vi.fn()
    const client = new ProcessCalls({ send: value => server.receive(value), invoke: async () => null, event: vi.fn(), report: vi.fn() })
    const server = new ProcessCalls({ send: value => replies.push(value), event: vi.fn(), report: vi.fn(),
      invoke: async (_target, _method, _args, context) => {
        context.signal.addEventListener('abort', cancelled)
        return { token: 'grant' }
      } })
    connections.push(client, server)
    const controller = new AbortController()
    const rejected = expect(client.call('x', 'grant', [], { signal: controller.signal })).rejects.toThrow('cancelled')
    await Promise.resolve()
    expect(replies).toHaveLength(1)
    controller.abort()
    await rejected
    expect(cancelled).toHaveBeenCalledOnce()
    client.receive(replies.shift()!)
    expect(cancelled).toHaveBeenCalledOnce()

    server.receive({ type: 'call', id: 99, target: 'x', method: 'grant', args: [] })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(30_001)
    expect(cancelled).toHaveBeenCalledTimes(2)
  })

  it('rejects before resolving a grant when sending its receipt fails', async () => {
    vi.useFakeTimers()
    const released = vi.fn()
    const client = new ProcessCalls({ send: message => {
      if (message.type === 'received') throw new Error('receipt failed')
      server.receive(message)
    }, invoke: async () => null, event: vi.fn(), report: vi.fn() })
    const server = new ProcessCalls({ send: message => client.receive(message), event: vi.fn(), report: vi.fn(),
      invoke: async (_target, _method, _args, context) => {
        context.signal.addEventListener('abort', released)
        return { token: 'grant' }
      } })
    connections.push(client, server)
    await expect(client.call('x', 'grant', [])).rejects.toThrow('receipt failed')
    await vi.advanceTimersByTimeAsync(30_001)
    expect(released).toHaveBeenCalledOnce()
  })
})
