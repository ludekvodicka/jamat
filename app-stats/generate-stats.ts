import { loadDailyUsageData, loadSessionData, globUsageFiles, getClaudePaths } from 'ccusage/data-loader';
import { calculateTotals, createTotalsObject } from 'ccusage/calculate-cost';
import { writeFileSync, mkdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { resolveConfigDir } from '../core/config-dir.js';
import { costForTokens } from '../core/pricing.js';

// Stats live under the portable config-dir (--config-dir from the electron handler / JAMAT_CONFIG_DIR;
// default ~/.jamat) so electron + the standalone stats generator agree on one dir.
const cdIdx = process.argv.indexOf('--config-dir');
const STATS_DIR = join(resolveConfigDir({ explicit: cdIdx !== -1 ? process.argv[cdIdx + 1] : (process.env['JAMAT_CONFIG_DIR'] ?? null) }), 'stats');
const DATA_DIR = STATS_DIR;
const CACHE_FILE = join(DATA_DIR, 'historical-cache.json');

// Cache stores daily + session data that doesn't change for past days
interface HistoricalCache {
  cachedAt: string
  cachedDate: string // YYYY-MM-DD of the day cache was built
  daily: any[]
  sessions: any[]
}

function loadCache(): HistoricalCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as HistoricalCache
    const today = new Date().toISOString().slice(0, 10)
    // Cache is valid if it was built today (historical data doesn't change within the same day)
    if (raw.cachedDate === today) return raw
    return null
  } catch {
    return null
  }
}

function saveCache(cache: HistoricalCache) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(CACHE_FILE, JSON.stringify(cache))
}

async function generateStats() {
  const startTime = Date.now()
  const now = new Date()
  const todayStr = now.toISOString().slice(0, 10)
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000)

  // Try to use cached historical data
  let dailyData: any[]
  let sessionData: any[]

  const cache = loadCache()
  if (cache) {
    console.log('Using cached historical data (same-day cache)')
    dailyData = cache.daily
    sessionData = cache.sessions
    console.log(`  Cached: ${dailyData.length} days, ${sessionData.length} sessions`)
  } else {
    console.log('Loading daily usage data (full scan)...')
    dailyData = await loadDailyUsageData({ mode: 'calculate', order: 'asc' })

    console.log('Loading session data (full scan)...')
    sessionData = await loadSessionData({ mode: 'calculate' })

    // Save cache for next run today
    saveCache({ cachedAt: now.toISOString(), cachedDate: todayStr, daily: dailyData, sessions: sessionData })
    console.log(`  Cached ${dailyData.length} days + ${sessionData.length} sessions for reuse today`)
  }

  const cacheLoadTime = Date.now() - startTime

  // Per-request cost using ccusage-equivalent per-token-type Anthropic pricing.
  // (A single blended rate over all four token types mis-prices cache-heavy or
  // output-heavy requests — see app-stats/pricing.ts.) Falls back to a coarse
  // blended estimate only for models the price table doesn't know.
  const FALLBACK_RATE = 3 / 1e6
  function estimateCost(model: string, input: number, output: number, cacheCreate: number, cacheRead: number): number {
    const priced = costForTokens(model, { input, output, cacheCreate, cacheRead })
    if (priced != null) return priced
    return (input + output + cacheCreate + cacheRead) * FALLBACK_RATE
  }

  // Find JSONL files modified recently for rolling windows
  console.log('Scanning JSONL files for detailed breakdown...')
  const claudePaths = await getClaudePaths()
  const allFiles = await globUsageFiles(claudePaths)

  const recentFiles: Array<{ file: string; project: string; sessionId: string }> = []
  for (const f of allFiles) {
    try {
      const stat = statSync(f.file)
      if (stat.mtimeMs >= twentyFourHoursAgo.getTime()) {
        const relPath = f.file.replace(/\\/g, '/')
        const match = relPath.match(/\/projects\/([^/]+)\/([^/]+)/)
        if (match) {
          const projectEncoded = match[1]
          const sessionId = match[2].replace('.jsonl', '')
          const projectName = projectEncoded
            .replace(/^[A-Za-z]--/, '')
            .split('-')
            .pop() || projectEncoded
          recentFiles.push({ file: f.file, project: projectName, sessionId })
        }
      }
    } catch {}
  }

  console.log(`Loading detailed data from ${recentFiles.length} recent files...`)

  // All the rolling-window data structures (same as before)
  const detailedRequests: Array<{
    timestamp: string; model: string;
    inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number;
    totalTokens: number; cost: number; durationMs: number; project: string; sessionId: string;
  }> = []

  const projectMap24h: Record<string, {
    inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number;
    cost: number; durationMs: number; requestCount: number; models: Set<string>; sessions: Set<string>;
  }> = {}

  // Per-model totals over the last 24h — drives the Last-24h "Per-Model Breakdown" table + filter.
  const modelMap24h: Record<string, {
    inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number;
    cost: number; durationMs: number; requestCount: number; sessions: Set<string>;
  }> = {}

  // Per-(project × model) 24h cross-breakdown — lets the dashboard's 24h tab show per-project rows
  // filtered to ONE model (and per-model rows filtered to one project) instead of blanking the table.
  const projectModelMap24h: Record<string, Record<string, {
    inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number;
    cost: number; durationMs: number; requestCount: number; sessions: Set<string>;
  }>> = {}

  const projectMap: Record<string, {
    inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number;
    cost: number; durationMs: number; requestCount: number; models: Set<string>; sessions: Set<string>;
  }> = {}

  const hourlyMap: Record<number, { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; cost: number; durationMs: number; models: Set<string> }> = {}
  for (let h = 0; h < 24; h++) {
    hourlyMap[h] = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, durationMs: 0, models: new Set() }
  }

  type ProjectBucket = { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; cost: number; durationMs: number }
  type HourlyBucket = { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; cost: number; durationMs: number; models: Set<string>; projects: Set<string>; byProject: Record<string, ProjectBucket>; byModel: Record<string, ProjectBucket> }
  const hourly24hMap: Record<string, HourlyBucket> = {}
  for (let i = 23; i >= 0; i--) {
    const slotTime = new Date(now.getTime() - i * 60 * 60 * 1000)
    const key = slotTime.toISOString().slice(0, 10) + ' ' + String(slotTime.getHours()).padStart(2, '0') + ':00'
    hourly24hMap[key] = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, durationMs: 0, models: new Set(), projects: new Set(), byProject: {}, byModel: {} }
  }

  // Dedup + collect entries from recent files
  const globalEntries: Array<{ entry: any; project: string; sessionId: string }> = []
  const seenRequestIds = new Map<string, number>()
  const requestTimestamps = new Map<string, { first: number; last: number }>()

  for (const rf of recentFiles) {
    try {
      const content = readFileSync(rf.file, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())

      for (const line of lines) {
        let entry: any
        try { entry = JSON.parse(line) } catch { continue }
        if (!entry.message?.usage?.input_tokens && !entry.message?.usage?.output_tokens) continue
        const reqId = entry.requestId || entry.uuid || line

        const tsMs = new Date(entry.timestamp).getTime()
        if (!isNaN(tsMs)) {
          const existing = requestTimestamps.get(reqId)
          if (existing) {
            existing.first = Math.min(existing.first, tsMs)
            existing.last = Math.max(existing.last, tsMs)
          } else {
            requestTimestamps.set(reqId, { first: tsMs, last: tsMs })
          }
        }

        const existingIdx = seenRequestIds.get(reqId)
        if (existingIdx !== undefined) {
          globalEntries[existingIdx] = { entry, project: rf.project, sessionId: rf.sessionId }
        } else {
          seenRequestIds.set(reqId, globalEntries.length)
          globalEntries.push({ entry, project: rf.project, sessionId: rf.sessionId })
        }
      }
    } catch {}
  }

  function getRequestDurationMs(entry: any): number {
    const reqId = entry.requestId || entry.uuid || ''
    const ts = requestTimestamps.get(reqId)
    if (!ts) return 0
    return ts.last - ts.first
  }

  // Today's per-model totals, rebuilt fresh from the JSONL scan. The same-day historical
  // cache freezes the daily/all-time data at first-run time, so today's usage (e.g. a model
  // used after the cache was built) would otherwise never grow on the dashboard. We overwrite
  // today's daily entry below from these live counts.
  type ModelAgg = { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; cost: number }
  const todayModelAgg: Record<string, ModelAgg> = {}

  // Process deduplicated entries into rolling-window aggregations
  for (const { entry, project, sessionId } of globalEntries) {
    const ts = new Date(entry.timestamp)
    if (isNaN(ts.getTime())) continue

    const usage = entry.message.usage
    const input = usage.input_tokens ?? 0
    const output = usage.output_tokens ?? 0
    const cacheCreate = usage.cache_creation_input_tokens ?? 0
    const cacheRead = usage.cache_read_input_tokens ?? 0
    const model = entry.message?.model ?? 'unknown'
    // Always compute from tokens (ccusage 'calculate' mode) so the rolling windows
    // reconcile with the daily/all-time totals, which are loaded the same way.
    const cost = estimateCost(model, input, output, cacheCreate, cacheRead)
    const durationMs = getRequestDurationMs(entry)

    if (ts.toISOString().slice(0, 10) === todayStr) {
      const hour = ts.getHours()
      hourlyMap[hour].inputTokens += input
      hourlyMap[hour].outputTokens += output
      hourlyMap[hour].cacheCreationTokens += cacheCreate
      hourlyMap[hour].cacheReadTokens += cacheRead
      hourlyMap[hour].cost += cost
      hourlyMap[hour].durationMs += durationMs
      if (model) hourlyMap[hour].models.add(model)

      const ma = todayModelAgg[model] || (todayModelAgg[model] = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0 })
      ma.inputTokens += input; ma.outputTokens += output
      ma.cacheCreationTokens += cacheCreate; ma.cacheReadTokens += cacheRead; ma.cost += cost
    }

    if (ts >= twentyFourHoursAgo) {
      const key = ts.toISOString().slice(0, 10) + ' ' + String(ts.getHours()).padStart(2, '0') + ':00'
      if (hourly24hMap[key]) {
        const bucket = hourly24hMap[key]
        bucket.inputTokens += input
        bucket.outputTokens += output
        bucket.cacheCreationTokens += cacheCreate
        bucket.cacheReadTokens += cacheRead
        bucket.cost += cost
        bucket.durationMs += durationMs
        if (model) bucket.models.add(model)
        bucket.projects.add(project)
        if (!bucket.byProject[project]) {
          bucket.byProject[project] = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, durationMs: 0 }
        }
        const bp = bucket.byProject[project]
        bp.inputTokens += input; bp.outputTokens += output
        bp.cacheCreationTokens += cacheCreate; bp.cacheReadTokens += cacheRead
        bp.cost += cost; bp.durationMs += durationMs
        if (!bucket.byModel[model]) {
          bucket.byModel[model] = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, durationMs: 0 }
        }
        const bm = bucket.byModel[model]
        bm.inputTokens += input; bm.outputTokens += output
        bm.cacheCreationTokens += cacheCreate; bm.cacheReadTokens += cacheRead
        bm.cost += cost; bm.durationMs += durationMs
      }

      if (!projectMap24h[project]) {
        projectMap24h[project] = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, durationMs: 0, requestCount: 0, models: new Set(), sessions: new Set() }
      }
      const p24 = projectMap24h[project]
      p24.inputTokens += input; p24.outputTokens += output
      p24.cacheCreationTokens += cacheCreate; p24.cacheReadTokens += cacheRead
      p24.cost += cost; p24.durationMs += durationMs; p24.requestCount++
      if (model) p24.models.add(model); p24.sessions.add(sessionId)

      if (!modelMap24h[model]) {
        modelMap24h[model] = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, durationMs: 0, requestCount: 0, sessions: new Set() }
      }
      const m24 = modelMap24h[model]
      m24.inputTokens += input; m24.outputTokens += output
      m24.cacheCreationTokens += cacheCreate; m24.cacheReadTokens += cacheRead
      m24.cost += cost; m24.durationMs += durationMs; m24.requestCount++
      m24.sessions.add(sessionId)

      if (!projectModelMap24h[project]) projectModelMap24h[project] = {}
      const pmRow = projectModelMap24h[project]
      if (!pmRow[model]) {
        pmRow[model] = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, durationMs: 0, requestCount: 0, sessions: new Set() }
      }
      const pm = pmRow[model]
      pm.inputTokens += input; pm.outputTokens += output
      pm.cacheCreationTokens += cacheCreate; pm.cacheReadTokens += cacheRead
      pm.cost += cost; pm.durationMs += durationMs; pm.requestCount++
      pm.sessions.add(sessionId)
    }

    if (ts >= fiveHoursAgo) {
      const totalTokens = input + output + cacheCreate + cacheRead
      detailedRequests.push({ timestamp: ts.toISOString(), model, inputTokens: input, outputTokens: output, cacheCreationTokens: cacheCreate, cacheReadTokens: cacheRead, totalTokens, cost, durationMs, project, sessionId })
      if (!projectMap[project]) {
        projectMap[project] = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, durationMs: 0, requestCount: 0, models: new Set(), sessions: new Set() }
      }
      const p = projectMap[project]
      p.inputTokens += input; p.outputTokens += output
      p.cacheCreationTokens += cacheCreate; p.cacheReadTokens += cacheRead
      p.cost += cost; p.durationMs += durationMs; p.requestCount++
      if (model) p.models.add(model); p.sessions.add(sessionId)
    }
  }

  const hourly = Object.entries(hourlyMap).map(([hour, data]) => ({
    hour: Number(hour), inputTokens: data.inputTokens, outputTokens: data.outputTokens,
    cacheCreationTokens: data.cacheCreationTokens, cacheReadTokens: data.cacheReadTokens,
    cost: data.cost, durationMs: data.durationMs, modelsUsed: Array.from(data.models),
  }))

  const hourly24h = Object.entries(hourly24hMap).map(([label, data]) => ({
    label, inputTokens: data.inputTokens, outputTokens: data.outputTokens,
    cacheCreationTokens: data.cacheCreationTokens, cacheReadTokens: data.cacheReadTokens,
    cost: data.cost, durationMs: data.durationMs, modelsUsed: Array.from(data.models),
    projects: Array.from(data.projects), byProject: data.byProject, byModel: data.byModel,
  }))

  const projects24h = Object.entries(projectMap24h)
    .map(([name, data]) => ({
      project: name, inputTokens: data.inputTokens, outputTokens: data.outputTokens,
      cacheCreationTokens: data.cacheCreationTokens, cacheReadTokens: data.cacheReadTokens,
      totalTokens: data.inputTokens + data.outputTokens + data.cacheCreationTokens + data.cacheReadTokens,
      cost: data.cost, durationMs: data.durationMs, requestCount: data.requestCount,
      sessionCount: data.sessions.size, modelsUsed: Array.from(data.models),
    }))
    .sort((a, b) => b.cost - a.cost)

  const models24h = Object.entries(modelMap24h)
    .map(([name, data]) => ({
      model: name, inputTokens: data.inputTokens, outputTokens: data.outputTokens,
      cacheCreationTokens: data.cacheCreationTokens, cacheReadTokens: data.cacheReadTokens,
      totalTokens: data.inputTokens + data.outputTokens + data.cacheCreationTokens + data.cacheReadTokens,
      cost: data.cost, durationMs: data.durationMs, requestCount: data.requestCount,
      sessionCount: data.sessions.size,
    }))
    .sort((a, b) => b.cost - a.cost)

  // Flatten the project×model cross-map (Set → count) for the client. Small (projects × models).
  const projectModels24h: Record<string, Record<string, {
    inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number;
    totalTokens: number; cost: number; durationMs: number; requestCount: number; sessionCount: number;
  }>> = {}
  for (const [proj, models] of Object.entries(projectModelMap24h)) {
    projectModels24h[proj] = {}
    for (const [mdl, c] of Object.entries(models)) {
      projectModels24h[proj][mdl] = {
        inputTokens: c.inputTokens, outputTokens: c.outputTokens,
        cacheCreationTokens: c.cacheCreationTokens, cacheReadTokens: c.cacheReadTokens,
        totalTokens: c.inputTokens + c.outputTokens + c.cacheCreationTokens + c.cacheReadTokens,
        cost: c.cost, durationMs: c.durationMs, requestCount: c.requestCount, sessionCount: c.sessions.size,
      }
    }
  }

  detailedRequests.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  const projectSummary = Object.entries(projectMap)
    .map(([name, data]) => ({
      project: name, inputTokens: data.inputTokens, outputTokens: data.outputTokens,
      cacheCreationTokens: data.cacheCreationTokens, cacheReadTokens: data.cacheReadTokens,
      totalTokens: data.inputTokens + data.outputTokens + data.cacheCreationTokens + data.cacheReadTokens,
      cost: data.cost, durationMs: data.durationMs, requestCount: data.requestCount,
      sessionCount: data.sessions.size, modelsUsed: Array.from(data.models),
    }))
    .sort((a, b) => b.cost - a.cost)

  // Overwrite today's daily entry with the freshly-scanned per-model totals so the dashboard's
  // all-time/today/Model-Breakdown numbers grow live instead of being frozen by the same-day cache.
  if (Object.keys(todayModelAgg).length > 0) {
    const modelBreakdowns = Object.entries(todayModelAgg).map(([modelName, m]) => ({
      modelName,
      inputTokens: m.inputTokens, outputTokens: m.outputTokens,
      cacheCreationTokens: m.cacheCreationTokens, cacheReadTokens: m.cacheReadTokens,
      cost: m.cost,
    }))
    const todayEntry = {
      date: todayStr,
      inputTokens: modelBreakdowns.reduce((s, b) => s + b.inputTokens, 0),
      outputTokens: modelBreakdowns.reduce((s, b) => s + b.outputTokens, 0),
      cacheCreationTokens: modelBreakdowns.reduce((s, b) => s + b.cacheCreationTokens, 0),
      cacheReadTokens: modelBreakdowns.reduce((s, b) => s + b.cacheReadTokens, 0),
      totalCost: modelBreakdowns.reduce((s, b) => s + b.cost, 0),
      modelsUsed: modelBreakdowns.map(b => b.modelName),
      modelBreakdowns,
    }
    const idx = dailyData.findIndex((d: any) => d.date === todayStr)
    if (idx >= 0) dailyData[idx] = todayEntry
    else dailyData.push(todayEntry)
  }

  const totals = createTotalsObject(calculateTotals(dailyData))

  const stats = {
    generatedAt: new Date().toISOString(),
    daily: dailyData,
    sessions: sessionData,
    hourly,
    hourly24h,
    projects24h,
    models24h,
    projectModels24h,
    detailed: {
      windowStart: fiveHoursAgo.toISOString(),
      windowEnd: now.toISOString(),
      requests: detailedRequests,
      projects: projectSummary,
    },
    totals,
  }

  mkdirSync(DATA_DIR, { recursive: true })
  const outPath = join(DATA_DIR, 'stats.json')
  writeFileSync(outPath, JSON.stringify(stats, null, 2))
  const totalTime = Date.now() - startTime
  console.log(`Stats saved to ${outPath}`)
  console.log(`  Days: ${dailyData.length}`)
  console.log(`  Sessions: ${sessionData.length}`)
  console.log(`  Total tokens: ${formatNumber(totals.totalTokens)}`)
  console.log(`  Total cost: $${totals.totalCost.toFixed(2)}`)
  console.log(`  Detailed (5h): ${detailedRequests.length} requests, ${projectSummary.length} projects`)
  console.log(`  Time: ${totalTime}ms (historical load: ${cacheLoadTime}ms)`)
}

function formatNumber(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return n.toString()
}

generateStats().catch(err => {
  console.error('Failed to generate stats:', err)
  process.exit(1)
})
