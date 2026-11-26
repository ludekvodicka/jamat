import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionUncommittedCandidate } from '../../../lib-orchestrator/sessionManager/sessionUncommittedView'
import { SessionUncommittedWorker } from './sessionUncommittedWorker'
import type {
  SessionUncommittedWorkerRequest,
  SessionUncommittedWorkerResponse,
  SessionUncommittedWorkerStart,
  SessionUncommittedWorkerThread,
} from './sessionUncommittedWorker.types'

class FakeSessionUncommittedThread extends EventEmitter implements SessionUncommittedWorkerThread {
  readonly performance: SessionUncommittedWorkerThread['performance']
  readonly sent: SessionUncommittedWorkerRequest[] = []
  readonly events: string[]
  terminations = 0

  constructor(events: string[]) {
    super()
    this.events = events
    this.performance = { eventLoopUtilization: () => ({ idle: 60, active: 40, utilization: 0.4 }) }
  }

  override on(event: 'message', listener: (message: SessionUncommittedWorkerResponse) => void): this
  override on(event: 'error', listener: (error: Error) => void): this
  override on(event: 'exit', listener: (code: number) => void): this
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener)
  }

  postMessage(message: SessionUncommittedWorkerRequest): void {
    this.sent.push(message)
    this.events.push(`post:${message.kind}`)
  }

  terminate(): Promise<number> {
    this.terminations += 1
    this.events.push('terminate')
    return Promise.resolve(0)
  }

  answer(message: SessionUncommittedWorkerResponse): void {
    this.emit('message', message)
  }
}

const candidate: SessionUncommittedCandidate = {
  sessionId: 'session-1', agentId: 'claude', nativeSessionId: 'native-1', cwd: 'Q:/wc', transcriptCwd: 'Q:/wc', life: 'live',
}
const start: SessionUncommittedWorkerStart = { cacheFile: 'Q:/state/session-claims.json' }

function workerUnderTest(): { worker: SessionUncommittedWorker; threads: FakeSessionUncommittedThread[]; events: string[]; starts: SessionUncommittedWorkerStart[] } {
  const threads: FakeSessionUncommittedThread[] = []
  const events: string[] = []
  const starts: SessionUncommittedWorkerStart[] = []
  const worker = new SessionUncommittedWorker('sessionUncommittedWorker.cjs', start, (_path, given) => {
    starts.push(given)
    const thread = new FakeSessionUncommittedThread(events)
    threads.push(thread)
    return thread
  })
  return { worker, threads, events, starts }
}

describe('app/sessionUncommitted/sessionUncommittedWorker', () => {
  afterEach(() => { vi.useRealTimers() })

  it('starts the thread on the first scan and answers after its ready', async () => {
    const { worker, threads, starts } = workerUnderTest()
    const scan = worker.scan([candidate], 'visible')
    expect(threads).toHaveLength(1)
    expect(starts).toEqual([start])
    expect(threads[0].sent).toEqual([])

    threads[0].answer({ kind: 'ready' })
    expect(threads[0].sent).toEqual([{ kind: 'scan', requestId: 1, sessions: [candidate], reason: 'visible' }])
    const entry = { files: 2, sample: ['app/a.ts', 'docs/b.md'] }
    threads[0].answer({ kind: 'result', requestId: 1, sessions: { 'session-1': entry } })
    await expect(scan).resolves.toEqual({ 'session-1': entry })

    const limited = worker.scan([candidate], 'stamp', ['Q:/wc'])
    expect(threads).toHaveLength(1)
    expect(threads[0].sent.at(-1)).toEqual({ kind: 'scan', requestId: 2, sessions: [candidate], reason: 'stamp', roots: ['Q:/wc'] })
    threads[0].answer({ kind: 'result', requestId: 2, sessions: {} })
    await expect(limited).resolves.toEqual({})
  })

  it('relays status observations and the claims of a session', async () => {
    const { worker, threads } = workerUnderTest()
    const observed = worker.observeStatus('Q:/wc', [{ absolutePath: 'Q:/wc/a.ts', nodeKind: 'file' }])
    threads[0].answer({ kind: 'ready' })
    threads[0].answer({ kind: 'done', requestId: 1 })
    await expect(observed).resolves.toBeUndefined()
    const unknown = worker.claims('never-scanned')
    threads[0].answer({ kind: 'claims', requestId: 2, touched: null })
    await expect(unknown).resolves.toBeNull()
    const known = worker.claims('session-1')
    const shellRuns = [{ command: 'node gen.js', startedAt: 1, endedAt: 2 }]
    threads[0].answer({ kind: 'claims', requestId: 3, touched: ['Q:/wc/a.ts'], shellRuns })
    await expect(known).resolves.toEqual({ touched: ['Q:/wc/a.ts'], shellRuns })
  })

  it('fails the pending request of a broken thread and starts a new thread for the next request', async () => {
    const { worker, threads } = workerUnderTest()
    const held = worker.scan([candidate], 'tick')
    threads[0].answer({ kind: 'ready' })
    threads[0].emit('error', new Error('SQLITE_CANTOPEN'))

    await expect(held).rejects.toThrow('The session uncommitted worker failed: SQLITE_CANTOPEN')
    expect(threads[0].terminations).toBe(1)
    const next = worker.scan([candidate], 'tick')
    expect(threads).toHaveLength(2)
    threads[1].answer({ kind: 'ready' })
    threads[1].answer({ kind: 'result', requestId: 2, sessions: {} })
    await expect(next).resolves.toEqual({})
  })

  it('rejects a failed request and keeps the thread', async () => {
    const { worker, threads } = workerUnderTest()
    const scan = worker.scan([candidate], 'tick')
    threads[0].answer({ kind: 'ready' })
    threads[0].answer({ kind: 'failed', requestId: 1, detail: 'database is locked' })
    await expect(scan).rejects.toThrow('database is locked')
    expect(threads[0].terminations).toBe(0)
  })

  it('treats an answer of the wrong kind as a broken thread', async () => {
    const { worker, threads } = workerUnderTest()
    const scan = worker.scan([candidate], 'tick')
    threads[0].answer({ kind: 'ready' })
    threads[0].answer({ kind: 'done', requestId: 1 })
    await expect(scan).rejects.toThrow('answered an unknown request: 1 (done)')
    expect(threads[0].terminations).toBe(1)
  })

  it('fails a request with a named detail when the thread is not ready in time', async () => {
    vi.useFakeTimers()
    const { worker, threads } = workerUnderTest()
    const scan = worker.scan([candidate], 'visible')
    const failed = expect(scan).rejects.toThrow('The session uncommitted worker failed: did not become ready within 10000 ms')
    await vi.advanceTimersByTimeAsync(10_000)
    await failed
    expect(threads[0].terminations).toBe(1)
  })

  it('flushes the cache before the thread ends, then refuses every request', async () => {
    const { worker, threads, events } = workerUnderTest()
    const scan = worker.scan([candidate], 'visible')
    threads[0].answer({ kind: 'ready' })
    threads[0].answer({ kind: 'result', requestId: 1, sessions: {} })
    await scan

    const stopped = worker.stop()
    expect(threads[0].sent.at(-1)).toEqual({ kind: 'stop', requestId: 2 })
    expect(threads[0].terminations).toBe(0)
    threads[0].answer({ kind: 'done', requestId: 2 })
    await stopped
    expect(events).toEqual(['post:scan', 'post:stop', 'terminate'])
    await expect(worker.scan([candidate], 'tick')).rejects.toThrow('stopping')
    expect(threads).toHaveLength(1)
  })

  it('ends a thread that does not answer the stop within its wait', async () => {
    vi.useFakeTimers()
    const { worker, threads } = workerUnderTest()
    void worker.observeStatus('Q:/wc', []).catch(() => undefined)
    threads[0].answer({ kind: 'ready' })
    const stopped = worker.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    await stopped
    expect(threads[0].terminations).toBe(1)
  })

  it('answers no claims without a running thread and starts none for them', async () => {
    const { worker, threads } = workerUnderTest()
    await expect(worker.claims('session-1')).resolves.toBeNull()
    expect(threads).toHaveLength(0)
  })

  it('stops without a thread when none ever started', async () => {
    const { worker, threads } = workerUnderTest()
    worker.beginStop()
    await expect(worker.claims('session-1')).rejects.toThrow('stopping')
    await worker.stop()
    expect(threads).toHaveLength(0)
  })
})
