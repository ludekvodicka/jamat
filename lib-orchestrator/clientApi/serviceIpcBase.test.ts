import type { ServiceCaller } from './serviceTransport.types'
import { describe, expect, it, vi } from 'vitest'
import { ServiceIpcBase } from './serviceIpcBase'
import type { PerfSpans } from '../perfMonitor/perfSpans'

const { register } = vi.hoisted(() => ({ register: vi.fn() }))

function bindService(service: Service): Service {
  return service.setTransport({ handle: register, publish: () => {}, isCurrent: () => true, onCaller: () => () => {} })
}

class Service extends ServiceIpcBase<{ 'clipboard:write-text': true }> {
  initialize(handler: (text: string) => void): void {
    this.register('clipboard:write-text', (_event, text) => handler(text))
  }
}

describe('IPC performance spans', () => {
  it('records a throwing handler and preserves its exception and arguments', () => {
    const service = bindService(new Service())
    const names: string[] = []
    const perf: PerfSpans = {
      span: (name, work) => { try { return work() } finally { names.push(name) } },
      operation: async (_name, work) => work(),
    }
    service.setPerfSpans(perf)
    service.initialize(text => { expect(text).toBe('private text'); throw new Error('original') })
    const handler = register.mock.lastCall![1] as (event: ServiceCaller, text: string) => void
    expect(() => handler({} as ServiceCaller, 'private text')).toThrow('original')
    expect(names).toEqual(['ipc:clipboard:write-text'])
  })

  it('calls the handler once with no monitor injected', () => {
    const service = bindService(new Service())
    const work = vi.fn()
    service.initialize(work)
    const handler = register.mock.lastCall![1] as (event: ServiceCaller, text: string) => void
    handler({} as ServiceCaller, 'text')
    expect(work).toHaveBeenCalledExactlyOnceWith('text')
  })
})
