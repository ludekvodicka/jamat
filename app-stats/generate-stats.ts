import { mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { resolveConfigDir } from '../core/config-dir.js'
import type { DailyUsage, Stats, StatsView } from '../core/types/stats.js'
import { ClaudeUsageLoader } from './claudeUsageLoader.js'
import { CodexUsageLoader } from './codex-usage-loader.js'
import { StatsProgressReporter } from './statsProgressReporter.js'
import { StatsViewBuilder } from './stats-view.js'

export class StatsGenerator {
  static async run(): Promise<void> {
    const startedAt = Date.now()
    const now = new Date()
    const configDir = StatsGenerator.configDir()
    const statsDir = join(configDir, 'stats')
    const claudeCacheFile = join(statsDir, 'claude-usage-cache.json')
    const codexCacheFile = join(statsDir, 'codex-usage-cache.json')
    StatsProgressReporter.report({ phase: 'starting' })

    console.log('Loading Claude usage statistics...')
    const claudeLoad = await ClaudeUsageLoader.load({
      cacheFile: claudeCacheFile,
      onProgress: (progress) => {
        let phase: 'claudeDiscover' | 'claudeCheck' | 'claudeParse'
        if (progress.kind === 'discover') phase = 'claudeDiscover'
        else if (progress.kind === 'check') phase = 'claudeCheck'
        else if (progress.kind === 'parse') phase = 'claudeParse'
        else
          throw new Error(`Unknown Claude loader phase: ${JSON.stringify(progress.kind)}`)
        StatsProgressReporter.report({ phase, current: progress.current, total: progress.total, cacheHits: progress.cacheHits, changedFiles: progress.changedFiles })
      },
    })
    StatsProgressReporter.report({ phase: 'claudeBuild', current: 0, total: claudeLoad.rollingRecords.length })
    const claudeRolling = StatsViewBuilder.build(claudeLoad.rollingRecords, now, 'full', 'full')
    const claudeDaily = StatsGenerator.withLiveToday(claudeLoad.daily, claudeRolling.daily, now)
    const claudeView: StatsView = {
      ...claudeRolling,
      daily: claudeDaily,
      sessions: claudeLoad.sessions,
      totals: StatsViewBuilder.calculateTotals(claudeDaily),
    }
    StatsProgressReporter.report({ phase: 'claudeBuild', current: claudeLoad.rollingRecords.length, total: claudeLoad.rollingRecords.length })

    console.log('Loading Codex usage statistics...')
    const codexLoad = await CodexUsageLoader.load({
      cacheFile: codexCacheFile,
      onProgress: (progress) => {
        let phase: 'codexDiscover' | 'codexCheck' | 'codexParse'
        if (progress.kind === 'discover') phase = 'codexDiscover'
        else if (progress.kind === 'check') phase = 'codexCheck'
        else if (progress.kind === 'parse') phase = 'codexParse'
        else
          throw new Error(`Unknown Codex loader phase: ${JSON.stringify(progress.kind)}`)
        StatsProgressReporter.report({ phase, current: progress.current, total: progress.total, cacheHits: progress.cacheHits, changedFiles: progress.changedFiles })
      },
    })
    StatsProgressReporter.report({ phase: 'codexBuild', current: 0, total: codexLoad.records.length })
    const codexView = StatsViewBuilder.build(codexLoad.records, now, codexLoad.costCoverage, 'none')
    StatsProgressReporter.report({ phase: 'codexBuild', current: codexLoad.records.length, total: codexLoad.records.length })

    StatsProgressReporter.report({ phase: 'merge' })
    const combined = StatsViewBuilder.merge(claudeView, codexView)
    const stats: Stats = { generatedAt: new Date().toISOString(), ...combined, byAgent: { claude: claudeView, codex: codexView } }
    const outPath = join(statsDir, 'stats.json')
    StatsProgressReporter.report({ phase: 'write' })
    StatsGenerator.writeJsonAtomic(outPath, stats)
    StatsProgressReporter.report({ phase: 'complete' })

    console.log(`Stats saved to ${outPath}`)
    console.log(`  Days: ${stats.daily.length}`)
    console.log(`  Sessions: ${stats.sessions.length} (${claudeView.sessions.length} Claude, ${codexView.sessions.length} Codex)`)
    console.log(`  Total tokens: ${StatsGenerator.formatNumber(stats.totals.totalTokens)}`)
    console.log(`  Claude cache: ${claudeLoad.filesScanned} files, ${claudeLoad.filesParsed} parsed, ${claudeLoad.cacheHits} cache hits`)
    console.log(`  Codex cache: ${codexLoad.filesScanned} files, ${codexLoad.filesParsed} parsed, ${codexLoad.cacheHits} cache hits`)
    console.log(`  Time: ${Date.now() - startedAt}ms`)
  }

  private static configDir(): string {
    const index = process.argv.indexOf('--config-dir')
    return resolveConfigDir({ explicit: index !== -1 ? process.argv[index + 1] : (process.env['JAMAT_CONFIG_DIR'] ?? null) })
  }

  private static withLiveToday(historical: DailyUsage[], rolling: DailyUsage[], now: Date): DailyUsage[] {
    const today = now.toISOString().slice(0, 10)
    const live = rolling.find((row) => row.date === today)
    if (!live) return historical
    const result = historical.filter((row) => row.date !== today)
    result.push(live)
    return result.sort((left, right) => left.date.localeCompare(right.date))
  }

  private static writeJsonAtomic(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(value, null, 2))
      renameSync(temp, file)
    } finally {
      rmSync(temp, { force: true })
    }
  }

  private static formatNumber(value: number): string {
    if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
    return value.toString()
  }
}

void StatsGenerator.run().catch((error: unknown) => {
  console.error('Failed to generate stats:', error)
  process.exitCode = 1
})
