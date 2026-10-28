import { describe, expect, it, vi } from 'vitest'
import { TokenUsageWorker } from './tokenUsageWorker'
import type { TokenUsageWorkerRequest } from './tokenUsageWorker.types'

const { threads } = vi.hoisted(() => ({ threads: [] as { handlers: Record<string, (...args: any[]) => void>; sent: unknown[]; terminate: ReturnType<typeof vi.fn> }[] }))
vi.mock('node:worker_threads', () => ({ Worker: class {
  handlers: Record<string, (...args: any[]) => void> = {}
  sent: unknown[] = []
  terminate = vi.fn(async () => 0)
  constructor() { threads.push(this) }
  on(event: string, handler: (...args: any[]) => void) { this.handlers[event] = handler }
  postMessage(value: unknown) { this.sent.push(value) }
} }))
const request: TokenUsageWorkerRequest = { kind: 'scan', cacheFile: 'fixture', configDir: 'fixture', claudeHome: 'fixture', codexHome: 'fixture', records: [], accounts: [], rescan: false }
describe('TokenUsageWorker', () => {
  it('coalesces refresh, publishes progress, retains results and terminates its thread', async () => {
    threads.length = 0
    const changed = vi.fn(), worker = new TokenUsageWorker('fixture.js', async rescan => ({ ...request, rescan }), changed)
    const one = worker.refresh(), two = worker.refresh()
    expect(two).toBe(one)
    await vi.waitFor(() => expect(threads).toHaveLength(1))
    threads[0].handlers.message({ kind: 'progress', progress: { running: true, completed: 1, total: 2, error: null, scannedAt: null } })
    expect(worker.snapshot().progress.completed).toBe(1)
    threads[0].handlers.message({ kind: 'result', buckets: [], accountLabels: {}, labels: { a: 'A' } })
    await one
    await worker.stop()
    expect(worker.snapshot().labels).toEqual({ a: 'A' })
    expect(threads[0].terminate).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalled()
  })
  it('settles an in-flight read at stop and ignores late worker messages', async () => {
    threads.length = 0
    const worker = new TokenUsageWorker('fixture.js', async () => request, () => {})
    const pending = worker.refresh()
    await vi.waitFor(() => expect(threads).toHaveLength(1))
    await worker.stop()
    await pending
    threads[0].handlers.message({ kind: 'result', buckets: [], accountLabels: {}, labels: { late: 'ignored' } })
    expect(worker.snapshot().labels).toEqual({})
    await worker.refresh()
    expect(threads).toHaveLength(1)
  })
  it('never starts a timed-out request after a newer refresh has started', async () => {
    vi.useFakeTimers()
    threads.length = 0
    let late: (value: TokenUsageWorkerRequest) => void = () => {}
    const delayed = new Promise<TokenUsageWorkerRequest>(resolve => { late = resolve })
    let calls = 0
    const worker = new TokenUsageWorker('fixture.js', () => ++calls === 1 ? delayed : Promise.resolve(request), () => {})
    try {
      const old = worker.refresh()
      await vi.advanceTimersByTimeAsync(900_000)
      await old
      const fresh = worker.refresh()
      await vi.advanceTimersByTimeAsync(0)
      expect(threads).toHaveLength(1)
      late(request)
      await vi.advanceTimersByTimeAsync(0)
      expect(threads).toHaveLength(1)
      threads[0].handlers.message({ kind: 'result', buckets: [], accountLabels: {}, labels: {} })
      await fresh
    } finally { await worker.stop(); vi.useRealTimers() }
  })
})
