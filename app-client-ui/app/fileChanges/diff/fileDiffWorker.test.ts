import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FileDiffExecutionResult } from '../../../../lib-orchestrator/fileChangesManager/diff/fileDiffExecutor'
import { FileDiffWorker } from './fileDiffWorker'
import type {
  FileDiffWorkerRequest,
  FileDiffWorkerResponse,
  FileDiffWorkerThread,
} from './fileDiffWorker.types'

class FakeFileDiffWorkerThread extends EventEmitter implements FileDiffWorkerThread {
  readonly sent: FileDiffWorkerRequest[] = []
  terminations = 0

  override on(event: 'message', listener: (message: FileDiffWorkerResponse) => void): this
  override on(event: 'error', listener: (error: Error) => void): this
  override on(event: 'exit', listener: (code: number) => void): this
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener)
  }

  postMessage(message: FileDiffWorkerRequest): void {
    this.sent.push(message)
  }

  terminate(): Promise<number> {
    this.terminations += 1
    return Promise.resolve(0)
  }

  ready(): void {
    this.emit('message', { kind: 'ready' } satisfies FileDiffWorkerResponse)
  }

  respond(result: FileDiffExecutionResult, requestId?: number): void {
    const id = requestId ?? this.sent.at(-1)?.requestId
    if (id === undefined) throw new Error('The fake worker has no request to answer')
    this.emit('message', {
      kind: 'result',
      requestId: id,
      result,
    } satisfies FileDiffWorkerResponse)
  }

  fail(error: Error): void {
    this.emit('error', error)
  }

  finish(code: number): void {
    this.emit('exit', code)
  }
}

describe('app/fileChanges/diff/fileDiffWorker', () => {
  afterEach(() => { vi.useRealTimers() })

  it('starts lazily and runs one queued request at a time', async () => {
    const threads: FakeFileDiffWorkerThread[] = []
    const worker = new FileDiffWorker('fileDiffWorker.js', () => {
      const thread = new FakeFileDiffWorkerThread()
      threads.push(thread)
      return thread
    })

    const first = worker.execute({ before: 'one', after: 'two' })
    const second = worker.execute({ before: 'three', after: 'four' })
    expect(threads).toHaveLength(1)
    expect(threads[0].sent).toEqual([])
    threads[0].ready()
    expect(threads[0].sent).toEqual([expect.objectContaining({
      kind: 'compute', before: 'one', after: 'two', requestId: 1,
    })])

    threads[0].respond({ kind: 'computed', hunks: [] })
    await expect(first).resolves.toEqual({ kind: 'computed', hunks: [] })
    expect(threads[0].sent).toEqual([
      expect.objectContaining({ requestId: 1 }),
      expect.objectContaining({ before: 'three', after: 'four', requestId: 2 }),
    ])
    threads[0].respond({ kind: 'work-limit' })
    await expect(second).resolves.toEqual({ kind: 'work-limit' })
    await worker.stop()
  })

  it('deduplicates work, bounds each owner and still admits another owner', async () => {
    const threads: FakeFileDiffWorkerThread[] = []
    const worker = new FileDiffWorker('fileDiffWorker.js', () => {
      const thread = new FakeFileDiffWorkerThread()
      threads.push(thread)
      return thread
    })
    const input = { before: 'one', after: 'two' }
    const first = worker.execute(input, {
      ownerId: 'window-1', snapshotId: 'snapshot-1', jobKey: 'job-1',
    })
    const duplicate = worker.execute(input, {
      ownerId: 'window-1', snapshotId: 'snapshot-1', jobKey: 'job-1',
    })
    const second = worker.execute(input, {
      ownerId: 'window-1', snapshotId: 'snapshot-1', jobKey: 'job-2',
    })
    expect(duplicate).toBe(first)
    await expect(worker.execute(input, {
      ownerId: 'window-1', snapshotId: 'snapshot-1', jobKey: 'job-3',
    })).resolves.toEqual({
      kind: 'refused',
      detail: 'This window has too many file diffs in flight',
    })
    const other = worker.execute(input, {
      ownerId: 'window-2', snapshotId: 'snapshot-1', jobKey: 'job-4',
    })

    threads[0].ready()
    for (const pending of [first, second, other]) {
      threads[0].respond({ kind: 'computed', hunks: [] })
      await expect(pending).resolves.toEqual({ kind: 'computed', hunks: [] })
    }
    const recovered = worker.execute(input, {
      ownerId: 'window-1', snapshotId: 'snapshot-1', jobKey: 'job-5',
    })
    threads[0].respond({ kind: 'computed', hunks: [] })
    await expect(recovered).resolves.toEqual({ kind: 'computed', hunks: [] })
    await worker.stop()
  })

  it('bounds the global queue and releases the capacity on cancellation', async () => {
    const threads: FakeFileDiffWorkerThread[] = []
    const worker = new FileDiffWorker('fileDiffWorker.js', () => {
      const thread = new FakeFileDiffWorkerThread()
      threads.push(thread)
      return thread
    })
    const controllers = Array.from(
      { length: FileDiffWorker.jobsGlobalMaxConst },
      () => new AbortController(),
    )
    const admitted = controllers.map((controller, index) => worker.execute(
      { before: `${index}`, after: `${index + 1}` },
      {
        ownerId: `window-${index}`,
        snapshotId: 'snapshot-1',
        jobKey: `job-${index}`,
        signal: controller.signal,
      },
    ))
    await expect(worker.execute({ before: 'full', after: 'fuller' }, {
      ownerId: 'window-extra', snapshotId: 'snapshot-1', jobKey: 'job-extra',
    })).resolves.toEqual({ kind: 'refused', detail: 'The file diff queue is full' })

    const settled = admitted.map((promise) => promise.catch(() => ({ kind: 'stopped' as const })))
    worker.beginStop()
    await Promise.all(settled)
    await worker.stop()
  })

  it('cancels active and queued jobs and runs later work on a fresh worker', async () => {
    const threads: FakeFileDiffWorkerThread[] = []
    const worker = new FileDiffWorker('fileDiffWorker.js', () => {
      const thread = new FakeFileDiffWorkerThread()
      threads.push(thread)
      return thread
    })
    const activeController = new AbortController()
    const queuedController = new AbortController()
    const active = worker.execute({ before: 'one', after: 'two' }, {
      ownerId: 'window-1', snapshotId: 'snapshot-1', jobKey: 'active',
      signal: activeController.signal,
    })
    const queued = worker.execute({ before: 'three', after: 'four' }, {
      ownerId: 'window-2', snapshotId: 'snapshot-1', jobKey: 'queued',
      signal: queuedController.signal,
    })
    threads[0].ready()
    queuedController.abort()
    await expect(queued).resolves.toMatchObject({ kind: 'refused' })
    activeController.abort()
    await expect(active).resolves.toMatchObject({ kind: 'refused' })
    expect(threads[0].terminations).toBe(1)

    const recovered = worker.execute({ before: 'five', after: 'six' }, {
      ownerId: 'window-3', snapshotId: 'snapshot-1', jobKey: 'recovered',
    })
    expect(threads).toHaveLength(2)
    threads[1].ready()
    threads[1].respond({ kind: 'computed', hunks: [] })
    await expect(recovered).resolves.toEqual({ kind: 'computed', hunks: [] })
    await worker.stop()
  })

  it('turns a watchdog expiry into a work limit and ignores the retired worker', async () => {
    vi.useFakeTimers()
    const threads: FakeFileDiffWorkerThread[] = []
    const worker = new FileDiffWorker('fileDiffWorker.js', () => {
      const thread = new FakeFileDiffWorkerThread()
      threads.push(thread)
      return thread
    })

    const timed = worker.execute({ before: 'one', after: 'two' })
    threads[0].ready()
    await vi.advanceTimersByTimeAsync(15_250)
    await expect(timed).resolves.toEqual({ kind: 'work-limit' })
    expect(threads[0].terminations).toBe(1)
    threads[0].respond({ kind: 'computed', hunks: [] }, 1)

    const recovered = worker.execute({ before: 'three', after: 'four' })
    expect(threads).toHaveLength(2)
    threads[1].ready()
    threads[1].respond({ kind: 'computed', hunks: [] })
    await expect(recovered).resolves.toEqual({ kind: 'computed', hunks: [] })
    await worker.stop()
  })

  it('rejects a crashed request and continues the queue on a fresh worker', async () => {
    const threads: FakeFileDiffWorkerThread[] = []
    const worker = new FileDiffWorker('fileDiffWorker.js', () => {
      const thread = new FakeFileDiffWorkerThread()
      threads.push(thread)
      return thread
    })
    const first = worker.execute({ before: 'one', after: 'two' })
    const second = worker.execute({ before: 'three', after: 'four' })
    threads[0].ready()
    const rejected = expect(first).rejects.toThrow('worker failed: broken')
    threads[0].fail(new Error('broken'))
    await rejected
    expect(threads[0].terminations).toBe(1)
    expect(threads).toHaveLength(2)
    threads[1].ready()
    threads[1].respond({ kind: 'computed', hunks: [] })
    await expect(second).resolves.toEqual({ kind: 'computed', hunks: [] })
    await worker.stop()
  })

  it('rejects a startup failure and an unexpected exit without leaving promises pending', async () => {
    const missing = new FileDiffWorker('missing.js', () => { throw new Error('not found') })
    await expect(missing.execute({ before: 'one', after: 'two' }))
      .rejects.toThrow('could not start: not found')

    const thread = new FakeFileDiffWorkerThread()
    const worker = new FileDiffWorker('fileDiffWorker.js', () => thread)
    const pending = worker.execute({ before: 'one', after: 'two' })
    thread.ready()
    const rejected = expect(pending).rejects.toThrow('exited with code 7')
    thread.finish(7)
    await rejected
    await worker.stop()
  })

  it('rejects active, queued and future work when stopping', async () => {
    const thread = new FakeFileDiffWorkerThread()
    const worker = new FileDiffWorker('fileDiffWorker.js', () => thread)
    const active = worker.execute({ before: 'one', after: 'two' })
    const queued = worker.execute({ before: 'three', after: 'four' })
    thread.ready()
    const activeRejected = expect(active).rejects.toThrow('worker stopped')
    const queuedRejected = expect(queued).rejects.toThrow('worker stopped')
    worker.beginStop()
    await Promise.all([activeRejected, queuedRejected])
    expect(thread.terminations).toBe(1)
    await expect(worker.execute({ before: 'five', after: 'six' }))
      .rejects.toThrow('worker is stopping')
    await worker.stop()
  })
})
