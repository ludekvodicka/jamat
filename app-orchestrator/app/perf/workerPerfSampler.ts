import type { Worker } from 'node:worker_threads'
import type { PerfEvent } from '../../../lib-orchestrator/perfMonitor/perfRecord.types'

export type WorkerPerfSample = Extract<PerfEvent, { kind: 'sample' }>

export class WorkerPerfSampler {
  private readonly timer: ReturnType<typeof setInterval>

  constructor(worker: Pick<Worker, 'performance'>, emit: (sample: WorkerPerfSample) => void) {
    let previous = worker.performance.eventLoopUtilization()
    this.timer = setInterval(() => {
      const current = worker.performance.eventLoopUtilization()
      const delta = worker.performance.eventLoopUtilization(current, previous)
      previous = current
      emit({ kind: 'sample', elu: Number.isFinite(delta.utilization) ? delta.utilization : null,
        loopP50: null, loopP99: null, loopMax: null, heapMb: null })
    }, 60_000)
    this.timer.unref()
  }

  stop(): void { clearInterval(this.timer) }
}
