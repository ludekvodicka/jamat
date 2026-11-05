import { Worker } from 'node:worker_threads'
import { WorkerPerfSampler, type WorkerPerfSample } from '../perf/workerPerfSampler'

import type { SvnAssembly } from '../../../lib-orchestrator/svn/svnAssembly'
import type { SvnAssemblyExecutor } from '../../../lib-orchestrator/svn/svnAssemblyExecutor'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import type {
  SvnAssemblyWorkerFactory,
  SvnAssemblyWorkerResponse,
  SvnAssemblyWorkerThread,
} from './svnAssemblyWorker.types'

interface SvnAssemblyJob {
  requestId: number
  root: string
  freshness: boolean
  progress: ((mount: string, files: number) => void) | undefined
  resolve(assembly: SvnAssembly): void
  reject(error: Error): void
  sent: boolean
}

/**
 * One long-lived thread for every assembly read. A Finish reads the whole worktree several times;
 * spawning svn (about 40 ms each while other svn processes run) and hashing every file held the main
 * thread for 11 s per read of the Mirabia product. Reads run concurrently in the thread, as they did
 * in the main thread. A thread that fails fails the reads it holds; the next read starts a new one.
 */
export class SvnAssemblyWorker implements SvnAssemblyExecutor {
  private static readonly readyMillisecondsConst = 10_000

  private readonly workerPath: string
  private readonly factory: SvnAssemblyWorkerFactory
  private readonly onPerf: ((sample: WorkerPerfSample) => void) | undefined
  private perfSampler: WorkerPerfSampler | null
  private readonly jobs = new Map<number, SvnAssemblyJob>()
  private worker: SvnAssemblyWorkerThread | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private termination: Promise<void> = Promise.resolve()
  private nextRequestId = 1
  private ready = false
  private stopping = false

  constructor(workerPath: string, factory: SvnAssemblyWorkerFactory = SvnAssemblyWorker.createThread,
    onPerf?: (sample: WorkerPerfSample) => void) {
    this.workerPath = workerPath
    this.factory = factory
    this.onPerf = onPerf
    this.perfSampler = null
  }

  read(root: string, freshness: boolean, progress?: (mount: string, files: number) => void): Promise<SvnAssembly> {
    if (this.stopping) return Promise.reject(new Error('The svn assembly worker is stopping'))
    return new Promise<SvnAssembly>((resolve, reject) => {
      const job: SvnAssemblyJob = { requestId: this.nextRequestId++, root, freshness, progress, resolve, reject, sent: false }
      this.jobs.set(job.requestId, job)
      if (this.worker === null) this.startWorker()
      else if (this.ready) this.send(this.worker, job)
    })
  }

  /** Called after the session manager stopped, so no Finish is left to record a read cut short. */
  async stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true
      const worker = this.worker
      this.detach(new Error('The svn assembly worker stopped'))
      if (worker !== null) this.trackTermination(worker)
    }
    await this.termination
  }

  private startWorker(): void {
    let worker: SvnAssemblyWorkerThread
    try { worker = this.factory(this.workerPath) }
    catch (error) {
      this.detach(new Error(`The svn assembly worker could not start: ${ErrorText.of(error)}`))
      return
    }
    this.worker = worker
    this.ready = false
    worker.on('message', (message) => this.message(worker, message))
    worker.on('error', (error) => this.failed(worker, error))
    worker.on('exit', (code) => this.failed(worker, new Error(`exited with code ${code}`)))
    this.readyTimer = setTimeout(() => this.failed(worker, new Error('did not become ready')), SvnAssemblyWorker.readyMillisecondsConst)
  }

  private message(worker: SvnAssemblyWorkerThread, message: SvnAssemblyWorkerResponse): void {
    if (worker !== this.worker) return
    if (message.kind === 'ready') {
      if (this.ready) {
        this.failed(worker, new Error('became ready twice'))
        return
      }
      this.clearReadyTimer()
      this.ready = true
      if (this.onPerf) this.perfSampler = new WorkerPerfSampler(worker, this.onPerf)
      for (const job of this.jobs.values()) if (!job.sent) this.send(worker, job)
    }
    else if (message.kind === 'progress') this.jobs.get(message.requestId)?.progress?.(message.mount, message.files)
    else if (message.kind === 'result' || message.kind === 'failed') {
      const job = this.jobs.get(message.requestId)
      if (job === undefined || !job.sent) {
        this.failed(worker, new Error(`answered an unknown request: ${message.requestId}`))
        return
      }
      this.jobs.delete(message.requestId)
      if (message.kind === 'result') job.resolve(message.assembly)
      else job.reject(new Error(message.detail))
    }
    else this.failed(worker, new Error(`sent an unknown response: ${JSON.stringify(message satisfies never)}`))
  }

  private send(worker: SvnAssemblyWorkerThread, job: SvnAssemblyJob): void {
    job.sent = true
    worker.postMessage({ kind: 'read', requestId: job.requestId, root: job.root, freshness: job.freshness })
  }

  private failed(worker: SvnAssemblyWorkerThread, error: Error): void {
    if (worker !== this.worker) return
    this.detach(new Error(`The svn assembly worker failed: ${ErrorText.of(error)}`))
    this.trackTermination(worker)
  }

  private detach(error: Error): void {
    this.perfSampler?.stop()
    this.perfSampler = null
    this.clearReadyTimer()
    this.worker = null
    this.ready = false
    const jobs = [...this.jobs.values()]
    this.jobs.clear()
    for (const job of jobs) job.reject(error)
  }

  private trackTermination(worker: SvnAssemblyWorkerThread): void {
    const next = worker.terminate()
    this.termination = Promise.allSettled([this.termination, next]).then((results) => {
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
    void this.termination.catch(() => undefined)
  }

  private clearReadyTimer(): void {
    if (this.readyTimer === null) return
    clearTimeout(this.readyTimer)
    this.readyTimer = null
  }

  private static createThread(path: string): SvnAssemblyWorkerThread {
    return new Worker(path)
  }
}
