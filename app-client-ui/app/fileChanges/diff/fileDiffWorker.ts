import { Worker } from 'node:worker_threads'

import type {
  FileDiffComputeInput,
  FileDiffExecutionContext,
  FileDiffExecutionResult,
  FileDiffExecutor,
} from '../../../../lib-orchestrator/fileChangesManager/diff/fileDiffExecutor'
import { FileDiffLimitsConst } from '../../../../lib-orchestrator/fileChangesManager/diff/fileDiffLimits'
import { ErrorText } from '../../../shared/errorText'
import type {
  FileDiffWorkerFactory,
  FileDiffWorkerResponse,
  FileDiffWorkerThread,
} from './fileDiffWorker.types'

interface FileDiffWorkerJob {
  requestId: number
  input: FileDiffComputeInput
  resolve(result: FileDiffExecutionResult): void
  reject(error: Error): void
  promise: Promise<FileDiffExecutionResult>
  context: FileDiffExecutionContext | undefined
  abort: (() => void) | null
}

export class FileDiffWorker implements FileDiffExecutor {
  static readonly jobsGlobalMaxConst = 8
  static readonly jobsPerOwnerMaxConst = 2
  private static readonly responseGraceMillisecondsConst = 250
  private static readonly watchdogMillisecondsConst =
    FileDiffLimitsConst.timeoutMilliseconds + FileDiffWorker.responseGraceMillisecondsConst

  private readonly queue: FileDiffWorkerJob[] = []
  private readonly jobsByKey = new Map<string, FileDiffWorkerJob>()
  private worker: FileDiffWorkerThread | null = null
  private active: FileDiffWorkerJob | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private termination: Promise<void> = Promise.resolve()
  private nextRequestId = 1
  private ready = false
  private stopping = false

  constructor(
    private readonly workerPath: string,
    private readonly factory: FileDiffWorkerFactory = FileDiffWorker.createThread,
  ) {}

  execute(
    input: FileDiffComputeInput,
    context?: FileDiffExecutionContext,
  ): Promise<FileDiffExecutionResult> {
    if (this.stopping)
      return Promise.reject(new Error('The file diff worker is stopping'))
    if (context?.signal?.aborted)
      return Promise.resolve({ kind: 'refused', detail: 'The file diff request was cancelled' })
    const shared = context === undefined ? undefined : this.jobsByKey.get(context.jobKey)
    if (shared !== undefined) return shared.promise
    const jobs = this.queue.length + (this.active === null ? 0 : 1)
    const ownerJobs = context === undefined ? 0 : [this.active, ...this.queue]
      .filter((job) => job?.context?.ownerId === context.ownerId).length
    if (jobs >= FileDiffWorker.jobsGlobalMaxConst)
      return Promise.resolve({ kind: 'refused', detail: 'The file diff queue is full' })
    if (context !== undefined && ownerJobs >= FileDiffWorker.jobsPerOwnerMaxConst)
      return Promise.resolve({ kind: 'refused', detail: 'This window has too many file diffs in flight' })
    let resolveJob: (result: FileDiffExecutionResult) => void = () => {}
    let rejectJob: (error: Error) => void = () => {}
    const promise = new Promise<FileDiffExecutionResult>((resolve, reject) => {
      resolveJob = resolve
      rejectJob = reject
    })
    const job: FileDiffWorkerJob = {
      requestId: this.nextRequestId++,
      input,
      resolve: resolveJob,
      reject: rejectJob,
      promise,
      context,
      abort: null,
    }
    if (context !== undefined) this.jobsByKey.set(context.jobKey, job)
    if (context?.signal !== undefined) {
      job.abort = () => this.cancel(job)
      context.signal.addEventListener('abort', job.abort, { once: true })
    }
    this.queue.push(job)
    this.pump()
    return promise
  }

  beginStop(): void {
    if (this.stopping) return
    this.stopping = true
    this.clearTimer()
    const error = new Error('The file diff worker stopped')
    if (this.active !== null) this.rejectJob(this.active, error)
    this.active = null
    for (const job of this.queue.splice(0)) this.rejectJob(job, error)
    const worker = this.worker
    this.worker = null
    this.ready = false
    if (worker === null) return
    this.trackTermination(worker)
  }

  async stop(): Promise<void> {
    this.beginStop()
    await this.termination
  }

  private pump(): void {
    if (this.stopping || this.active !== null || this.queue.length === 0) return
    if (this.worker === null) {
      this.startWorker()
      return
    }
    if (!this.ready) return
    const job = this.queue.shift()
    if (job === undefined) return
    this.active = job
    this.worker.postMessage({ kind: 'compute', requestId: job.requestId, ...job.input })
    const worker = this.worker
    this.timer = setTimeout(
      () => this.workTimedOut(worker, job.requestId),
      FileDiffWorker.watchdogMillisecondsConst,
    )
  }

  private startWorker(): void {
    let worker: FileDiffWorkerThread
    try { worker = this.factory(this.workerPath) }
    catch (error) {
      this.rejectNext(new Error(`The file diff worker could not start: ${ErrorText.of(error)}`))
      return
    }
    this.worker = worker
    this.ready = false
    worker.on('message', (message) => this.message(worker, message))
    worker.on('error', (error) => this.failed(worker, error))
    worker.on('exit', (code) => this.exited(worker, code))
    this.timer = setTimeout(
      () => this.failed(worker, new Error('The file diff worker did not become ready')),
      FileDiffWorker.watchdogMillisecondsConst,
    )
  }

  private message(worker: FileDiffWorkerThread, message: FileDiffWorkerResponse): void {
    if (worker !== this.worker) return
    if (message.kind === 'ready') {
      if (this.ready) {
        this.failed(worker, new Error('The file diff worker became ready twice'))
        return
      }
      this.clearTimer()
      this.ready = true
      this.pump()
    }
    else if (message.kind === 'result') {
      const job = this.active
      if (job === null || job.requestId !== message.requestId) {
        this.failed(worker, new Error(`The file diff worker answered an unknown request: ${
          message.requestId}`))
        return
      }
      this.clearTimer()
      this.active = null
      this.resolveJob(job, message.result)
      this.pump()
    }
    else
      this.failed(worker, new Error(`Unknown file diff worker response: ${JSON.stringify(message)}`))
  }

  private workTimedOut(worker: FileDiffWorkerThread, requestId: number): void {
    if (worker !== this.worker || this.active?.requestId !== requestId) return
    const job = this.active
    this.detach(worker)
    this.resolveJob(job, { kind: 'work-limit' })
    this.terminateDetached(worker)
    this.pump()
  }

  private failed(worker: FileDiffWorkerThread, error: Error): void {
    if (worker !== this.worker) return
    const detail = new Error(`The file diff worker failed: ${ErrorText.of(error)}`)
    const job = this.active ?? this.queue.shift() ?? null
    this.detach(worker)
    if (job !== null) this.rejectJob(job, detail)
    this.terminateDetached(worker)
    this.pump()
  }

  private exited(worker: FileDiffWorkerThread, code: number): void {
    if (worker !== this.worker) return
    this.failed(worker, new Error(`The file diff worker exited with code ${code}`))
  }

  private rejectNext(error: Error): void {
    const job = this.queue.shift()
    if (job !== undefined) this.rejectJob(job, error)
    this.pump()
  }

  private detach(worker: FileDiffWorkerThread): void {
    if (worker !== this.worker) return
    this.clearTimer()
    this.worker = null
    this.active = null
    this.ready = false
  }

  private terminateDetached(worker: FileDiffWorkerThread): void {
    this.trackTermination(worker)
  }

  private trackTermination(worker: FileDiffWorkerThread): void {
    const next = worker.terminate()
    this.termination = Promise.allSettled([this.termination, next]).then((results) => {
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
    void this.termination.catch(() => undefined)
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private cancel(job: FileDiffWorkerJob): void {
    if (this.active === job) {
      const worker = this.worker
      if (worker === null) return
      this.detach(worker)
      this.resolveJob(job, { kind: 'refused', detail: 'The file diff request was cancelled' })
      this.terminateDetached(worker)
      this.pump()
      return
    }
    const at = this.queue.indexOf(job)
    if (at < 0) return
    this.queue.splice(at, 1)
    this.resolveJob(job, { kind: 'refused', detail: 'The file diff request was cancelled' })
    this.pump()
  }

  private resolveJob(job: FileDiffWorkerJob, result: FileDiffExecutionResult): void {
    this.releaseJob(job)
    job.resolve(result)
  }

  private rejectJob(job: FileDiffWorkerJob, error: Error): void {
    this.releaseJob(job)
    job.reject(error)
  }

  private releaseJob(job: FileDiffWorkerJob): void {
    if (job.context !== undefined && this.jobsByKey.get(job.context.jobKey) === job)
      this.jobsByKey.delete(job.context.jobKey)
    if (job.abort !== null && job.context?.signal !== undefined)
      job.context.signal.removeEventListener('abort', job.abort)
    job.abort = null
  }

  private static createThread(path: string): FileDiffWorkerThread {
    return new Worker(path)
  }
}
