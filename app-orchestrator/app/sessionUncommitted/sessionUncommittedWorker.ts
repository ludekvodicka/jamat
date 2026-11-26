import { Worker } from 'node:worker_threads'
import { WorkerPerfSampler, type WorkerPerfSample } from '../perf/workerPerfSampler'

import type { SessionUncommittedCandidate } from '../../../lib-orchestrator/sessionManager/sessionUncommittedView'
import type { SessionUncommittedEntry } from '../../../lib-orchestrator/sessionUncommitted/sessionUncommitted.types'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import type {
  SessionUncommittedClaims,
  SessionUncommittedScanReason,
  SessionUncommittedStatusEntry,
  SessionUncommittedWorkerFactory,
  SessionUncommittedWorkerRequest,
  SessionUncommittedWorkerResponse,
  SessionUncommittedWorkerStart,
  SessionUncommittedWorkerThread,
} from './sessionUncommittedWorker.types'

type Answered = Exclude<SessionUncommittedWorkerResponse, { kind: 'ready' } | { kind: 'failed' }>

interface SessionUncommittedJob {
  request: SessionUncommittedWorkerRequest
  expected: Answered['kind']
  resolve(response: Answered): void
  reject(error: Error): void
  sent: boolean
}

/**
 * The thread of the uncommitted mark (D10): its tracker, claim cache and hash cache stay in the
 * thread between scans, because the `.svn/wc.db` reads, transcript parsing and hashing they do held
 * the orchestrator main thread for seconds. Nothing runs on its own: the first request starts the
 * thread, and a request waits for its `ready`. A thread that fails, exits or is not ready in time
 * fails the requests it holds, and the next request starts a new one.
 */
export class SessionUncommittedWorker {
  private static readonly readyMillisecondsConst = 10_000
  /** How long `stop` waits for the cache to be written before it ends the thread anyway. */
  private static readonly flushMillisecondsConst = 5_000

  private readonly workerPath: string
  private readonly start: SessionUncommittedWorkerStart
  private readonly factory: SessionUncommittedWorkerFactory
  private readonly onPerf: ((sample: WorkerPerfSample) => void) | undefined
  private perfSampler: WorkerPerfSampler | null
  private readonly jobs = new Map<number, SessionUncommittedJob>()
  private worker: SessionUncommittedWorkerThread | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private termination: Promise<void> = Promise.resolve()
  private stopped: Promise<void> | null = null
  private nextRequestId = 1
  private ready = false
  private refusing = false

  constructor(workerPath: string, start: SessionUncommittedWorkerStart,
    factory: SessionUncommittedWorkerFactory = SessionUncommittedWorker.createThread,
    onPerf?: (sample: WorkerPerfSample) => void) {
    this.workerPath = workerPath
    this.start = start
    this.factory = factory
    this.onPerf = onPerf
    this.perfSampler = null
  }

  async scan(sessions: readonly SessionUncommittedCandidate[], reason: SessionUncommittedScanReason,
    roots?: readonly string[]): Promise<Record<string, SessionUncommittedEntry>> {
    const answer = await this.ask((requestId) => ({ kind: 'scan', requestId, sessions, reason, ...roots === undefined ? {} : { roots } }), 'result')
    if (answer.kind !== 'result') throw new Error(`Unexpected session uncommitted answer: ${answer.kind}`)
    return answer.sessions
  }

  async observeStatus(root: string, entries: readonly SessionUncommittedStatusEntry[]): Promise<void> {
    await this.ask((requestId) => ({ kind: 'observeStatus', requestId, root, entries }), 'done')
  }

  /**
   * For Finish (D15): null for a session the thread never scanned, and without a running thread,
   * whose new tracker would have scanned nothing: Finish then reads the transcript itself.
   */
  async claims(sessionId: string): Promise<SessionUncommittedClaims | null> {
    if (this.worker === null && !this.refusing) return null
    const answer = await this.ask((requestId) => ({ kind: 'claims', requestId, sessionId }), 'claims')
    if (answer.kind !== 'claims') throw new Error(`Unexpected session uncommitted answer: ${answer.kind}`)
    return answer.touched === null ? null : { touched: answer.touched, shellRuns: answer.shellRuns }
  }

  /** Refuses every later request; what the thread holds still finishes. */
  beginStop(): void {
    this.refusing = true
  }

  /** Writes the claim cache, then ends the thread. Later requests are refused. */
  stop(): Promise<void> {
    this.refusing = true
    return this.stopped ??= this.flushAndEnd()
  }

  private async flushAndEnd(): Promise<void> {
    const worker = this.worker
    if (worker !== null && this.ready) {
      const flushed = this.send(worker, (requestId) => ({ kind: 'stop', requestId }), 'done')
      let timer: ReturnType<typeof setTimeout> | null = null
      const late = new Promise<void>((resolve) => { timer = setTimeout(resolve, SessionUncommittedWorker.flushMillisecondsConst) })
      // A thread that fails while flushing ends below like one that answered.
      try { await Promise.race([flushed.then(() => undefined, () => undefined), late]) }
      finally { if (timer !== null) clearTimeout(timer) }
    }
    const current = this.worker
    this.detach(new Error('The session uncommitted worker stopped'))
    if (current !== null) this.trackTermination(current)
    await this.termination
  }

  private ask(build: (requestId: number) => SessionUncommittedWorkerRequest, expected: Answered['kind']): Promise<Answered> {
    if (this.refusing) return Promise.reject(new Error('The session uncommitted worker is stopping'))
    if (this.worker === null) this.startWorker()
    const worker = this.worker
    if (worker === null) return Promise.reject(new Error('The session uncommitted worker could not start'))
    return this.send(worker, build, expected)
  }

  private send(worker: SessionUncommittedWorkerThread, build: (requestId: number) => SessionUncommittedWorkerRequest,
    expected: Answered['kind']): Promise<Answered> {
    return new Promise<Answered>((resolve, reject) => {
      const request = build(this.nextRequestId++)
      const job: SessionUncommittedJob = { request, expected, resolve, reject, sent: false }
      this.jobs.set(request.requestId, job)
      if (this.ready) this.post(worker, job)
    })
  }

  private startWorker(): void {
    let worker: SessionUncommittedWorkerThread
    try { worker = this.factory(this.workerPath, this.start) }
    catch (error) {
      this.detach(new Error(`The session uncommitted worker could not start: ${ErrorText.of(error)}`))
      return
    }
    this.worker = worker
    this.ready = false
    worker.on('message', (message) => this.message(worker, message))
    worker.on('error', (error) => this.failed(worker, error))
    worker.on('exit', (code) => this.failed(worker, new Error(`exited with code ${code}`)))
    this.readyTimer = setTimeout(() => this.failed(worker,
      new Error(`did not become ready within ${SessionUncommittedWorker.readyMillisecondsConst} ms`)), SessionUncommittedWorker.readyMillisecondsConst)
  }

  private message(worker: SessionUncommittedWorkerThread, message: SessionUncommittedWorkerResponse): void {
    if (worker !== this.worker) return
    switch (message.kind) {
      case 'ready':
        if (this.ready) {
          this.failed(worker, new Error('became ready twice'))
          return
        }
        this.clearReadyTimer()
        this.ready = true
        if (this.onPerf) this.perfSampler = new WorkerPerfSampler(worker, this.onPerf)
        for (const job of this.jobs.values()) if (!job.sent) this.post(worker, job)
        return
      case 'result':
      case 'claims':
      case 'done':
      case 'failed': {
        const job = this.jobs.get(message.requestId)
        if (job === undefined || !job.sent || message.kind !== 'failed' && message.kind !== job.expected) {
          this.failed(worker, new Error(`answered an unknown request: ${message.requestId} (${message.kind})`))
          return
        }
        this.jobs.delete(message.requestId)
        if (message.kind === 'failed') job.reject(new Error(message.detail))
        else job.resolve(message)
        return
      }
      default:
        this.failed(worker, new Error(`sent an unknown response: ${JSON.stringify(message satisfies never)}`))
    }
  }

  private post(worker: SessionUncommittedWorkerThread, job: SessionUncommittedJob): void {
    job.sent = true
    worker.postMessage(job.request)
  }

  private failed(worker: SessionUncommittedWorkerThread, error: Error): void {
    if (worker !== this.worker) return
    this.detach(new Error(`The session uncommitted worker failed: ${ErrorText.of(error)}`))
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

  private trackTermination(worker: SessionUncommittedWorkerThread): void {
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

  private static createThread(path: string, start: SessionUncommittedWorkerStart): SessionUncommittedWorkerThread {
    return new Worker(path, { workerData: start })
  }
}
