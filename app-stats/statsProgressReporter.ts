import type { StatsGenerationProgressUpdate } from '../core/types/stats.js'

export class StatsProgressReporter {
  static readonly PREFIX = '__JAMAT_STATS_PROGRESS__:'

  static report(progress: StatsGenerationProgressUpdate): void {
    process.stdout.write(`${StatsProgressReporter.PREFIX}${JSON.stringify(progress)}\n`)
  }
}
