import { Worker } from 'node:worker_threads'
import type { TokenBucket, TokenScanProgress } from '../../../lib-orchestrator/tokenUsage/tokenUsageApi.types'
import type { TokenUsageWorkerRequest, TokenUsageWorkerResponse } from './tokenUsageWorker.types'

export class TokenUsageWorker {
  private readonly path: string
  private readonly request: (rescan: boolean) => Promise<TokenUsageWorkerRequest>
  private readonly changed: () => void
  private worker: Worker | null = null
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

  constructor(path: string, request: (rescan: boolean) => Promise<TokenUsageWorkerRequest>, changed: () => void) {
    this.path = path
    this.request = request
    this.changed = changed
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
    this.watchdog = setTimeout(() => { if (this.active === job) this.finish('Token scan exceeded fifteen minutes') }, 900_000)
    void this.request(rescan).then(async request => {
      await this.termination
      if (this.stopping || this.active !== job) return
      const worker = new Worker(this.path)
      this.worker = worker
      worker.on('message', (message: TokenUsageWorkerResponse) => {
        if (worker !== this.worker) return
        if (message.kind === 'progress') { this.progress = message.progress; this.changed() }
        else if (message.kind === 'result') {
          this.buckets = message.buckets
          this.labels = message.labels
          this.accountLabels = message.accountLabels
          this.finish(null)
        } else if (message.kind === 'error') this.finish(message.detail)
        else this.finish(`Unknown token worker response: ${JSON.stringify(message)}`)
      })
      worker.on('error', error => { if (worker === this.worker) this.finish(error.message) })
      worker.on('exit', code => { if (worker === this.worker) this.finish(`Token worker exited before answering (${code})`) })
      worker.postMessage(request)
    }).catch(error => { if (!this.stopping && this.active === job) this.finish(String(error)) })
    return job
  }

  beginStop(): void {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.finish(null)
  }

  async stop(): Promise<void> { this.beginStop(); await this.termination }

  private finish(error: string | null): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
    const worker = this.worker
    this.worker = null
    if (worker) this.termination = this.termination.then(() => worker.terminate())
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
