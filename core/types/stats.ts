/**
 * Canonical shape of the usage-statistics report (`stats.json`).
 *
 * Produced by `app-stats/generate-stats.ts`; consumed by the native-React
 * Usage Stats tab (`stats:data` IPC channel) and — historically — by the
 * legacy HTML dashboard (`app-stats/generate-html.ts`, which still keeps its
 * own local copy of these interfaces). This is the single source of truth for
 * the new code path; lives in `core/` (the zero-dep boundary) so the producer,
 * the IPC contract, the main handler, and the renderer all share one type.
 */

export interface ModelBreakdown {
  modelName: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  cost: number
}

export interface DailyUsage {
  date: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalCost: number
  modelsUsed: string[]
  modelBreakdowns: ModelBreakdown[]
}

export interface SessionUsage {
  sessionId: string
  projectPath: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalCost: number
  lastActivity: string
  modelsUsed: string[]
  modelBreakdowns: ModelBreakdown[]
}

export interface HourlyUsage {
  hour: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  cost: number
  durationMs: number
  modelsUsed: string[]
}

/** One project's (or model's) slice of a 24h hourly bucket. */
export interface Hourly24hProjectBreakdown {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  cost: number
  durationMs: number
}

export interface Hourly24hEntry {
  label: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  cost: number
  durationMs: number
  modelsUsed: string[]
  projects: string[]
  byProject: Record<string, Hourly24hProjectBreakdown>
  byModel: Record<string, Hourly24hProjectBreakdown>
}

export interface ModelSummary24h {
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  cost: number
  durationMs: number
  requestCount: number
  sessionCount: number
}

export interface DetailedRequest {
  timestamp: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  cost: number
  durationMs: number
  project: string
  sessionId: string
}

export interface ProjectSummary {
  project: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  cost: number
  durationMs: number
  requestCount: number
  sessionCount: number
  modelsUsed: string[]
}

export interface DetailedData {
  windowStart: string
  windowEnd: string
  requests: DetailedRequest[]
  projects: ProjectSummary[]
}

/** One cell of the 24h project × model cross-breakdown (a project's usage of a single model). */
export interface ProjectModelCell {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  cost: number
  durationMs: number
  requestCount: number
  sessionCount: number
}

export interface StatsTotals {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalCost: number
  totalTokens: number
}

export interface Stats {
  generatedAt: string
  daily: DailyUsage[]
  sessions: SessionUsage[]
  hourly: HourlyUsage[]
  hourly24h: Hourly24hEntry[]
  projects24h: ProjectSummary[]
  models24h: ModelSummary24h[]
  projectModels24h: Record<string, Record<string, ProjectModelCell>>
  detailed: DetailedData
  totals: StatsTotals
}

/** Result of the `stats:data` IPC channel — the native tab's data fetch. */
export type StatsDataResult = { ok: true; data: Stats } | { ok: false; error: string }
