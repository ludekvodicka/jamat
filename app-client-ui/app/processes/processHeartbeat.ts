import { AwakeClock } from '../../../lib-orchestrator/shared/awakeClock'
import type { ProcessPowerMessage } from '../../../lib-orchestrator/shared/processWire.types'
import type { PerfEvent, PerfProcess } from '../../../lib-orchestrator/perfMonitor/perfRecord.types'

export class ProcessHeartbeat {
  private readonly clock: AwakeClock
  private readonly target: PerfProcess
  private readonly record: (event: PerfEvent) => void
  private readonly now: () => number
  private readonly pending: Map<number, number>
  private sequence: number
  private hung: boolean

  constructor(target: PerfProcess, record: (event: PerfEvent) => void, now: () => number = () => performance.now()) {
    this.target = target
    this.record = record
    this.clock = new AwakeClock(now)
    this.now = () => this.clock.now()
    this.pending = new Map()
    this.sequence = 0
    this.hung = false
  }

  power(message: ProcessPowerMessage): void {
    if (!this.clock.power(message.epoch, message.event).changed) return
    this.pending.clear()
    this.hung = false
  }

  send(): number {
    this.clock.tick()
    const sequence = ++this.sequence
    this.pending.set(sequence, this.now())
    this.check()
    return sequence
  }

  reply(sequence: number): boolean {
    const sent = this.pending.get(sequence)
    if (sent === undefined) return false
    const ms = this.now() - sent
    if (ms > 1_000) this.record({ kind: 'unresponsive', target: this.target, ms })
    for (const key of this.pending.keys())
      if (key <= sequence) this.pending.delete(key)
    this.hung = false
    return true
  }

  check(): boolean {
    const oldest = this.pending.values().next().value
    if (oldest === undefined || this.now() - oldest < 30_000) return false
    if (!this.hung) this.record({ kind: 'hang', target: this.target, ms: this.now() - oldest })
    this.hung = true
    // Retain only the oldest deadline while a target is hung.
    const first = this.pending.keys().next().value!
    for (const key of this.pending.keys())
      if (key !== first) this.pending.delete(key)
    return true
  }
}
