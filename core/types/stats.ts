import type { AgentId } from './contracts.js'

export type StatsAgentFilter = 'all' | AgentId
export type MetricCoverage = 'full' | 'partial' | 'none'

export interface ModelBreakdown {
  modelName: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  cost: number
}

export interface DailyUsage {
  date: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  totalCost: number
  modelsUsed: string[]
  modelBreakdowns: ModelBreakdown[]
}

export interface SessionUsage {
  agent: AgentId
  sessionId: string
  projectPath: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  reasoningTokens: number
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
  reasoningTokens: number
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
  reasoningTokens: number
  cost: number
  durationMs: number
}

export interface Hourly24hEntry {
  label: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  reasoningTokens: number
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
  reasoningTokens: number
  totalTokens: number
  cost: number
  durationMs: number
  requestCount: number
  sessionCount: number
}

export interface DetailedRequest {
  agent: AgentId
  timestamp: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  reasoningTokens: number
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
  reasoningTokens: number
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
  reasoningTokens: number
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
  reasoningTokens: number
  totalCost: number
  totalTokens: number
}

export interface StatsView {
  daily: DailyUsage[]
  sessions: SessionUsage[]
  hourly: HourlyUsage[]
  hourly24h: Hourly24hEntry[]
  projects24h: ProjectSummary[]
  models24h: ModelSummary24h[]
  projectModels24h: Record<string, Record<string, ProjectModelCell>>
  detailed: DetailedData
  totals: StatsTotals
  costCoverage: MetricCoverage
  durationCoverage: MetricCoverage
}

export interface Stats extends StatsView {
  generatedAt: string
  byAgent: Record<AgentId, StatsView>
}

/** Result of the `stats:data` IPC channel — the native tab's data fetch. */
export type StatsDataResult = { ok: true; data: Stats } | { ok: false; error: string }
