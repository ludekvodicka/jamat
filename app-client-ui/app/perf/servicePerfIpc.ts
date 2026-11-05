import type { PerfBuild } from '../../../lib-orchestrator/perfMonitor/perfRecord.types'
import type { PerfMonitor } from '../../../lib-orchestrator/perfMonitor/perfMonitor'
import { PerfNames } from '../../../lib-orchestrator/perfMonitor/perfNames'
import { ElectronServiceIpcBase } from '../shell/electronServiceIpcBase'

export class ServicePerfIpc extends ElectronServiceIpcBase<typeof ServicePerfIpc.channelsConst> {
  static readonly channelsConst = { 'perf:batch': true } as const
  private readonly writer: Pick<PerfMonitor, 'record'>
  private readonly build: PerfBuild
  private readonly names: PerfNames

  constructor(writer: Pick<PerfMonitor, 'record'>, build: PerfBuild) {
    super()
    this.writer = writer
    this.build = build
    this.names = new PerfNames()
  }

  initialize(): void {
    this.register('perf:batch', (event, batch) => this.accept(this.sender(event).getOSProcessId(), batch))
    this.assertComplete(ServicePerfIpc.channelsConst)
  }

  accept(pid: number, batch: unknown): void {
    if (!Array.isArray(batch) || batch.length > 258) return
    const records = []
    const now = Date.now()
    for (const value of batch) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || ['v', 'process', 'pid', 'build'].some(key => key in value)) continue
      const record = this.names.record({ ...value, v: 1, process: 'renderer', pid, build: this.build })
      if (!record || record.at > now + 5_000 || record.at < now - 300_000) continue
      if (record.kind === 'sample') {
        if (record.elu !== null || record.heapMb !== null) continue
      } else if (record.kind === 'stall') {
        if (record.covered.length !== 0) continue
      } else if (record.kind === 'inputToFrame') {
        if (record.count === 0 || record.p99 < record.p50) continue
      } else continue
      records.push(record)
    }
    this.writer.record(records)
  }
}
