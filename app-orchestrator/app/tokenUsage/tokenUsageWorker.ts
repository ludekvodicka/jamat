import { Worker } from 'node:worker_threads'
import { WorkerPerfSampler, type WorkerPerfSample } from '../perf/workerPerfSampler'
import type { TokenBucket, TokenScanProgress } from '../../../lib-orchestrator/tokenUsage/tokenUsageApi.types'
import type { TokenUsageWorkerRequest, TokenUsageWorkerResponse } from './tokenUsageWorker.types'

/**
 * One long-lived token scan thread, the way `FileDiffWorker` keeps its own: the scanner and its cache
 * stay in the thread between the minute scans, so a scan reads only what moved. A request waits for
 * the thread's `ready`. The watchdog, a thread error or an exit ends the thread, and the next refresh
 * starts a fresh one.
 */
export class TokenUsageWorker {
  private static readonly watchdogMillisecondsConst = 900_000
  private readonly path: string
  private readonly request: (rescan: boolean) => Promise<TokenUsageWorkerRequest>
  private readonly changed: () => void
  private readonly onPerf: ((sample: WorkerPerfSample) => void) | undefined
  private perfSampler: WorkerPerfSampler | null
  private worker: Worker | null = null
  private ready = false
  private queued: TokenUsageWorkerRequest | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private active: Promise<void> | null = null
  private stopping = false
  private rescanPending = false
  private settle: (() => void) | null = null
  private termination: Promise<unknown> = Promise.resolve()
  private buckets: readonly TokenBucket[] = []
  private labels: Readonly<Record<string, string>> = {}
  private accountLabels: Readonly<Record<string, string>> = {}
  private progress: TokenScanProgress = { running: false, completed: 0, total: 0, error: null, scannedAt: null }

  constructor(path: string, request: (rescan: boolean) => Promise<TokenUsageWorkerRequest>, changed: () => void,
    onPerf?: (sample: WorkerPerfSample) => void) {
    this.path = path
    this.request = request
    this.changed = changed
    this.onPerf = onPerf
    this.perfSampler = null
  }

  snapshot() { return { buckets: this.buckets, labels: this.labels, accountLabels: this.accountLabels, progress: this.progress } }

  start(): void {
    if (this.stopping || this.timer) return
    this.timer = setInterval(() => { void this.refresh() }, 60_000)
    this.timer.unref()
    void this.refresh()
  }

  refresh(rescan = false): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (this.active) {
      this.rescanPending ||= rescan
      return this.active
    }
    this.progress = { ...this.progress, running: true, completed: 0, total: 0, error: null }
    this.changed()
    const job = new Promise<void>(resolve => { this.settle = resolve })
    this.active = job
    this.watchdog = setTimeout(() => { if (this.active === job) this.fail('Token scan exceeded fifteen minutes') },
      TokenUsageWorker.watchdogMillisecondsConst)
    void this.request(rescan).then(async request => {
      await this.termination
      if (this.stopping || this.active !== job) return
      this.send(request)
    }).catch(error => { if (!this.stopping && this.active === job) this.finish(String(error)) })
    return job
  }

  beginStop(): void {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.detach()
    this.finish(null)
  }

  async stop(): Promise<void> { this.beginStop(); await this.termination }

  private send(request: TokenUsageWorkerRequest): void {
    if (this.worker === null) this.startThread()
    if (this.ready) this.worker!.postMessage(request)
    else this.queued = request
  }

  private startThread(): void {
    const worker = new Worker(this.path)
    this.worker = worker
    this.ready = false
    worker.on('message', (message: TokenUsageWorkerResponse) => this.message(worker, message))
    worker.on('error', error => { if (worker === this.worker) this.fail(error.message) })
    worker.on('exit', code => { if (worker === this.worker) this.fail(`Token worker exited before answering (${code})`) })
  }

  private message(worker: Worker, message: TokenUsageWorkerResponse): void {
    if (worker !== this.worker) return
    if (message.kind === 'ready') {
      if (this.ready) {
        this.fail('The token worker became ready twice')
        return
      }
      this.ready = true
      if (this.onPerf) this.perfSampler = new WorkerPerfSampler(worker, this.onPerf)
      const queued = this.queued
      this.queued = null
      if (queued !== null) worker.postMessage(queued)
    }
    else if (message.kind === 'progress') {
      if (this.active === null) return
      this.progress = message.progress
      this.changed()
    }
    else if (message.kind === 'result') {
      if (this.active === null) return
      this.buckets = message.buckets
      this.labels = message.labels
      this.accountLabels = message.accountLabels
      this.finish(null)
    }
    else if (message.kind === 'error') { if (this.active !== null) this.finish(message.detail) }
    else this.fail(`Unknown token worker response: ${JSON.stringify(message)}`)
  }

  /** Ends the job together with its thread, whose state can no longer be trusted. */
  private fail(error: string): void {
    this.detach()
    this.finish(error)
  }

  private detach(): void {
    this.perfSampler?.stop()
    this.perfSampler = null
    const worker = this.worker
    this.worker = null
    this.ready = false
    this.queued = null
    if (worker) this.termination = this.termination.then(() => worker.terminate())
  }

  private finish(error: string | null): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
    this.progress = { ...this.progress, running: false, error,
      scannedAt: error === null && !this.stopping ? Date.now() : this.progress.scannedAt }
    this.settle?.()
    this.settle = null
    this.active = null
    if (this.stopping) return
    this.changed()
    if (this.rescanPending) {
      this.rescanPending = false
      void this.termination.then(() => this.refresh(true))
    }
  }
}
