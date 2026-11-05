import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChildProcessSupervisor, type SupervisedChild } from './childProcessSupervisor'
import type { ProcessMessage } from '../../../lib-orchestrator/shared/processWire.types'
import type { PerfEvent } from '../../../lib-orchestrator/perfMonitor/perfRecord.types'

const build = { version: 'test', inputHash: 'a'.repeat(64), builtAt: '2026-11-03T00:00:00.000Z' }
class Child extends EventEmitter {
  messages: ProcessMessage[] = []
  kills = 0
  postMessage(message: ProcessMessage): void {
    this.messages.push(message)
    if (message.type === 'stop') this.emit('exit', 0)
  }
  kill(): boolean { this.kills++; this.emit('exit', 1); return true }
}
function harness(smoke?: boolean) {
  const children: Child[] = [], events: PerfEvent[] = [], onExit = vi.fn(), onHeartbeat = vi.fn(), report = vi.fn()
  const supervisor = new ChildProcessSupervisor({ build, smoke,
    identity: { configIdentity: 'test', channel: 'development', stateDirectory: 'unused' },
    fork: () => { const child = new Child(); children.push(child); return child as unknown as SupervisedChild },
    record: value => events.push(value), onExit, onMessage: vi.fn(), onHeartbeat, onClosed: vi.fn(), report })
  return { children, events, onExit, onHeartbeat, report, supervisor }
}

describe('ChildProcessSupervisor', () => {
  afterEach(() => vi.useRealTimers())
  it.each([false, true])('sends the private smoke flag only when enabled: %s', async smoke => {
    const h = harness(smoke), starting = h.supervisor.start('gateway'), child = h.children[0]
    child.emit('message', { type: 'hello', process: 'gateway', build })
    child.emit('message', { type: 'ready' })
    await starting
    expect(child.messages[0]).toEqual({ type: 'initialize',
      identity: { configIdentity: 'test', channel: 'development', stateDirectory: 'unused' },
      ...(smoke ? { smoke: true } : {}) })
    await h.supervisor.stopAll()
  })
  async function drainingChildren() {
    const h = harness()
    for (const kind of ['orchestrator', 'gateway'] as const) {
      const starting = h.supervisor.start(kind), child = h.children.at(-1)!
      child.emit('message', { type: 'hello', process: kind, build })
      child.emit('message', { type: 'ready' })
      await starting
      child.postMessage = message => { child.messages.push(message) }
    }
    return { ...h, orchestrator: h.children[0]!, gateway: h.children[1]! }
  }

  it('awaits stopped in orchestration then gateway order and joins both actual exits', async () => {
    vi.useFakeTimers()
    const h = await drainingChildren()
    let done = false
    const work = h.supervisor.stopAll().then(() => { done = true })
    expect(h.orchestrator.messages.at(-1)).toEqual({ type: 'stop' })
    expect(h.gateway.messages.some(message => message.type === 'stop')).toBe(false)
    h.orchestrator.emit('message', { type: 'stopped', process: 'orchestrator', recordsSettled: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.gateway.messages.at(-1)).toEqual({ type: 'stop' })
    h.gateway.emit('message', { type: 'stopped', process: 'gateway', leaseRelease: 'released' })
    h.gateway.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    h.orchestrator.emit('exit', 0)
    await work
    expect(done).toBe(true)
    expect(h.report).not.toHaveBeenCalled()
    expect(h.onExit).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts gateway stop at fifteen seconds without an orchestration receipt and finishes at eighteen', async () => {
    vi.useFakeTimers()
    const h = await drainingChildren()
    for (const child of h.children) child.kill = () => { child.kills++; return true }
    let done = false
    const work = h.supervisor.stopAll().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(h.gateway.messages.some(message => message.type === 'stop')).toBe(false)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.orchestrator.kills).toBe(1)
    expect(h.gateway.messages.at(-1)).toEqual({ type: 'stop' })
    await vi.advanceTimersByTimeAsync(2_999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await work
    expect(h.gateway.kills).toBe(1)
    expect(h.report.mock.calls.flat().filter(message => message.includes('without a stopped receipt'))).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the original exit deadline after a stopped acknowledgement and reports failed settlement', async () => {
    vi.useFakeTimers()
    const h = await drainingChildren()
    const work = h.supervisor.stopAll()
    await vi.advanceTimersByTimeAsync(1_000)
    h.orchestrator.emit('message', { type: 'stopped', process: 'orchestrator', recordsSettled: false })
    await vi.advanceTimersByTimeAsync(0)
    h.gateway.emit('message', { type: 'stopped', process: 'gateway', leaseRelease: 'failed' })
    h.gateway.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(13_999)
    expect(h.orchestrator.kills).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    await work
    expect(h.orchestrator.kills).toBe(1)
    expect(h.report).toHaveBeenCalledWith('Orchestrator stopped without confirmed records settlement')
    expect(h.report).toHaveBeenCalledWith('Gateway stopped without confirmed Host lease release')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses a mismatched build and stops an already ready sibling', async () => {
    const h = harness()
    const first = h.supervisor.start('orchestrator')
    h.children[0].emit('message', { type: 'hello', process: 'orchestrator', build })
    h.children[0].emit('message', { type: 'ready' })
    await first
    const second = h.supervisor.start('gateway')
    h.children[1].emit('message', { type: 'hello', process: 'gateway', build: { ...build, inputHash: 'wrong' } })
    await expect(second).rejects.toThrow('build identity mismatch')
    expect(h.children.every(child => child.messages.some(value => value.type === 'stop'))).toBe(true)
    expect(h.onExit).not.toHaveBeenCalled()
  })
  it('records one late reply at 1500 ms and one hang without relaunching', async () => {
    vi.useFakeTimers()
    const h = harness(), start = h.supervisor.start('gateway'), child = h.children[0]
    child.emit('message', { type: 'hello', process: 'gateway', build })
    child.emit('message', { type: 'ready' })
    await start
    await vi.advanceTimersByTimeAsync(2500)
    child.emit('message', { type: 'heartbeat-reply', seq: 1 })
    expect(h.events).toEqual([{ kind: 'unresponsive', target: 'gateway', ms: 1500 }])
    await vi.advanceTimersByTimeAsync(31500)
    expect(h.events.filter(value => value.kind === 'hang')).toEqual([{ kind: 'hang', target: 'gateway', ms: 30000 }])
    expect(h.onExit).not.toHaveBeenCalled()
    await h.supervisor.stopAll()
  })
  it('cancels startup during quit without accepting a later hello', async () => {
    const h = harness(), start = h.supervisor.start('gateway')
    h.supervisor.beginQuit()
    h.children[0].emit('message', { type: 'hello', process: 'gateway', build })
    await expect(start).rejects.toThrow('startup cancelled')
    expect(h.children[0].messages.some(value => value.type === 'initialize')).toBe(false)
    expect(h.onExit).not.toHaveBeenCalled()
  })
  it('bounds a silent startup and kills a child that ignores stop', async () => {
    vi.useFakeTimers()
    const h = harness(), start = h.supervisor.start('gateway')
    h.children[0].postMessage = message => { h.children[0].messages.push(message) }
    const failed = expect(start).rejects.toThrow('startup timed out')
    await vi.advanceTimersByTimeAsync(23000)
    await failed
    expect(h.children[0].kills).toBe(1)
  })
  it('returns at three seconds even when a killed gateway emits no exit', async () => {
    vi.useFakeTimers()
    const h = harness(), starting = h.supervisor.start('gateway'), child = h.children[0]!
    child.emit('message', { type: 'hello', process: 'gateway', build })
    child.emit('message', { type: 'ready' })
    await starting
    child.postMessage = message => { child.messages.push(message) }
    child.kill = () => { child.kills++; return true }
    let stopped = false
    const work = h.supervisor.stopAll().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(2_999)
    expect(stopped).toBe(false)
    expect(child.kills).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    await work
    expect(stopped).toBe(true)
    expect(child.kills).toBe(1)
  })

  it('still kills and stops the sibling when sending stop throws', async () => {
    const h = harness()
    for (const kind of ['gateway', 'orchestrator'] as const) {
      const starting = h.supervisor.start(kind), child = h.children.at(-1)!
      child.emit('message', { type: 'hello', process: kind, build })
      child.emit('message', { type: 'ready' })
      await starting
    }
    h.children[1].postMessage = () => { throw new Error('closed port') }
    await h.supervisor.stopAll()
    expect(h.children[1].kills).toBe(1)
    expect(h.children[0].messages.at(-1)).toEqual({ type: 'stop' })
    expect(h.onExit).not.toHaveBeenCalled()
  })
  it('reports one fatal failure when a heartbeat send fails and the child exits', async () => {
    vi.useFakeTimers()
    const h = harness(), starting = h.supervisor.start('gateway'), child = h.children[0]
    child.emit('message', { type: 'hello', process: 'gateway', build })
    child.emit('message', { type: 'ready' })
    await starting
    child.postMessage = () => { throw new Error('closed port') }
    await vi.advanceTimersByTimeAsync(1000)
    child.emit('exit', 1)
    expect(h.onExit).toHaveBeenCalledTimes(1)
    await h.supervisor.stopAll()
  })
  it('keeps outstanding observations when a stale native power epoch is repeated', async () => {
    vi.useFakeTimers()
    const h = harness(), starting = h.supervisor.start('gateway'), child = h.children[0]!
    child.emit('message', { type: 'hello', process: 'gateway', build })
    child.emit('message', { type: 'ready' })
    await starting
    await vi.advanceTimersByTimeAsync(1_000)
    h.supervisor.power({ type: 'power', epoch: 1, event: 'suspend' })
    await vi.advanceTimersByTimeAsync(10_000)
    h.supervisor.power({ type: 'power', epoch: 1, event: 'suspend' })
    await vi.advanceTimersByTimeAsync(21_000)
    expect(h.events.filter(event => event.kind === 'hang')).toEqual([{ kind: 'hang', target: 'gateway', ms: 30_000 }])
    await h.supervisor.stopAll()
  })

  it('forwards native power to a surviving child when another child port throws', async () => {
    const h = harness()
    for (const kind of ['gateway', 'orchestrator'] as const) {
      const starting = h.supervisor.start(kind), child = h.children.at(-1)!
      child.emit('message', { type: 'hello', process: kind, build })
      child.emit('message', { type: 'ready' })
      await starting
    }
    const broken = h.children[0]!, original = broken.postMessage.bind(broken)
    broken.postMessage = message => { if (message.type === 'power') throw new Error('power port closed'); original(message) }
    h.supervisor.power({ type: 'power', epoch: 1, event: 'suspend' })
    expect(h.children[1]!.messages.at(-1)).toEqual({ type: 'power', epoch: 1, event: 'suspend' })
    await h.supervisor.stopAll()
  })

  it('does not report a ready child exit once quitting starts', async () => {
    const h = harness(), starting = h.supervisor.start('gateway'), child = h.children[0]
    child.emit('message', { type: 'hello', process: 'gateway', build })
    child.emit('message', { type: 'ready' })
    await starting
    h.supervisor.beginQuit()
    child.emit('exit', 1)
    expect(h.onExit).not.toHaveBeenCalled()
    await h.supervisor.stopAll()
  })
  it('renews private-call liveness only for an actual outstanding heartbeat reply', async () => {
    vi.useFakeTimers()
    const h = harness(), starting = h.supervisor.start('gateway'), child = h.children[0]
    child.emit('message', { type: 'hello', process: 'gateway', build })
    child.emit('message', { type: 'ready' })
    await starting
    child.emit('message', { type: 'heartbeat-reply', seq: 999 })
    expect(h.onHeartbeat).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    child.emit('message', { type: 'heartbeat-reply', seq: 1 })
    child.emit('message', { type: 'heartbeat-reply', seq: 1 })
    expect(h.onHeartbeat).toHaveBeenCalledExactlyOnceWith('gateway')
    await h.supervisor.stopAll()
  })
})
