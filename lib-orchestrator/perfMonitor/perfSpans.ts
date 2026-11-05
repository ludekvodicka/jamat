import type { PerfName } from './perfRecord.types'

export interface PerfSpans {
  span<T>(name: PerfName, work: () => T): T
  operation<T>(name: PerfName, work: () => Promise<T>): Promise<T>
}
