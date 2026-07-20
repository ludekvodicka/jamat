import type { StatsGenerationPhase, StatsGenerationProgressUpdate } from '../../../core/types/stats.js'

export type StatsProgressStreamItem =
  | { kind: 'progress'; progress: StatsGenerationProgressUpdate }
  | { kind: 'diagnostic'; line: string }

export class StatsProgressStreamParser {
  private static readonly PREFIX = '__JAMAT_STATS_PROGRESS__:'
  private static readonly PHASES: readonly StatsGenerationPhase[] = [
    'starting',
    'claudeDiscover',
    'claudeCheck',
    'claudeParse',
    'claudeBuild',
    'codexDiscover',
    'codexCheck',
    'codexParse',
    'codexBuild',
    'merge',
    'write',
    'complete',
  ]
  private buffer = ''

  push(chunk: Buffer | string): StatsProgressStreamItem[] {
    this.buffer += chunk.toString()
    const items: StatsProgressStreamItem[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      items.push(StatsProgressStreamParser.parseLine(this.buffer.slice(0, newline).replace(/\r$/, '')))
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
    }
    return items
  }

  finish(): StatsProgressStreamItem[] {
    if (!this.buffer) return []
    const line = this.buffer.replace(/\r$/, '')
    this.buffer = ''
    return [StatsProgressStreamParser.parseLine(line)]
  }

  private static parseLine(line: string): StatsProgressStreamItem {
    if (!line.startsWith(StatsProgressStreamParser.PREFIX)) return { kind: 'diagnostic', line }
    try {
      const value = JSON.parse(line.slice(StatsProgressStreamParser.PREFIX.length)) as Record<string, unknown>
      if (!StatsProgressStreamParser.PHASES.includes(value['phase'] as StatsGenerationPhase)) return { kind: 'diagnostic', line }
      for (const key of ['current', 'total', 'cacheHits', 'changedFiles'])
        if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return { kind: 'diagnostic', line }
      return { kind: 'progress', progress: value as unknown as StatsGenerationProgressUpdate }
    } catch {
      return { kind: 'diagnostic', line }
    }
  }
}
