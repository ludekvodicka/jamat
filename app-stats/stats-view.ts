import type { AgentId } from '../core/types/contracts.js'
import type {
  DailyUsage,
  DetailedRequest,
  Hourly24hEntry,
  Hourly24hProjectBreakdown,
  HourlyUsage,
  MetricCoverage,
  ModelBreakdown,
  ModelSummary24h,
  ProjectModelCell,
  ProjectSummary,
  SessionUsage,
  StatsTotals,
  StatsView,
} from '../core/types/stats.js'

export interface NormalizedUsageRecord {
  agent: AgentId
  timestamp: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  cost: number
  durationMs: number
  project: string
  projectPath: string
  sessionId: string
}

interface Metrics {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  cost: number
  durationMs: number
}

interface SummaryBucket extends Metrics {
  requestCount: number
  models: Set<string>
  sessions: Set<string>
}

interface ModelBucket extends Metrics {
  requestCount: number
  sessions: Set<string>
}

interface SessionBucket extends Metrics {
  agent: AgentId
  projectPath: string
  lastActivity: string
  models: Map<string, Metrics>
}

interface HourBucket extends Metrics {
  models: Set<string>
  projects: Set<string>
  byProject: Record<string, Metrics>
  byModel: Record<string, Metrics>
}

interface DailyBucket extends Metrics {
  models: Map<string, Metrics>
}

export class StatsViewBuilder {
  static build(
    records: NormalizedUsageRecord[],
    now: Date,
    costCoverage: MetricCoverage,
    durationCoverage: MetricCoverage,
  ): StatsView {
    const valid = records.filter((record) => Number.isFinite(new Date(record.timestamp).getTime()))
    const today = now.toISOString().slice(0, 10)
    const cutoff24h = now.getTime() - 24 * 60 * 60 * 1000
    const cutoff5h = now.getTime() - 5 * 60 * 60 * 1000
    const daily = new Map<string, DailyBucket>()
    const sessions = new Map<string, SessionBucket>()
    const projects24h = new Map<string, SummaryBucket>()
    const models24h = new Map<string, ModelBucket>()
    const projectModels24h = new Map<string, Map<string, ModelBucket>>()
    const detailedProjects = new Map<string, SummaryBucket>()
    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, ...StatsViewBuilder.emptyMetrics(), models: new Set<string>() }))
    const hourly24h = new Map<string, HourBucket>()
    const detailedRequests: DetailedRequest[] = []

    for (let i = 23; i >= 0; i--) {
      const slot = new Date(now.getTime() - i * 60 * 60 * 1000)
      hourly24h.set(StatsViewBuilder.hourKey(slot), StatsViewBuilder.emptyHourBucket())
    }

    for (const record of valid) {
      const ts = new Date(record.timestamp)
      const tsMs = ts.getTime()
      const date = ts.toISOString().slice(0, 10)
      const day = daily.get(date) ?? StatsViewBuilder.emptyDailyBucket()
      StatsViewBuilder.addRecord(day, record)
      const dayModel = day.models.get(record.model) ?? StatsViewBuilder.emptyMetrics()
      StatsViewBuilder.addRecord(dayModel, record)
      day.models.set(record.model, dayModel)
      daily.set(date, day)

      const sessionKey = `${record.agent}:${record.sessionId}`
      const session = sessions.get(sessionKey) ?? {
        ...StatsViewBuilder.emptyMetrics(),
        agent: record.agent,
        projectPath: record.projectPath,
        lastActivity: record.timestamp,
        models: new Map<string, Metrics>(),
      }
      StatsViewBuilder.addRecord(session, record)
      if (record.timestamp > session.lastActivity) session.lastActivity = record.timestamp
      const sessionModel = session.models.get(record.model) ?? StatsViewBuilder.emptyMetrics()
      StatsViewBuilder.addRecord(sessionModel, record)
      session.models.set(record.model, sessionModel)
      sessions.set(sessionKey, session)

      if (date === today) {
        StatsViewBuilder.addRecord(hourly[ts.getHours()], record)
        hourly[ts.getHours()].models.add(record.model)
      }

      if (tsMs >= cutoff24h) {
        const hour = hourly24h.get(StatsViewBuilder.hourKey(ts))
        if (hour) {
          StatsViewBuilder.addRecord(hour, record)
          hour.models.add(record.model)
          hour.projects.add(record.project)
          StatsViewBuilder.addRecordToMap(hour.byProject, record.project, record)
          StatsViewBuilder.addRecordToMap(hour.byModel, record.model, record)
        }

        const project = projects24h.get(record.project) ?? StatsViewBuilder.emptySummaryBucket()
        StatsViewBuilder.addSummaryRecord(project, record)
        projects24h.set(record.project, project)

        const model = models24h.get(record.model) ?? StatsViewBuilder.emptyModelBucket()
        StatsViewBuilder.addModelRecord(model, record)
        models24h.set(record.model, model)

        const projectModels = projectModels24h.get(record.project) ?? new Map<string, ModelBucket>()
        const projectModel = projectModels.get(record.model) ?? StatsViewBuilder.emptyModelBucket()
        StatsViewBuilder.addModelRecord(projectModel, record)
        projectModels.set(record.model, projectModel)
        projectModels24h.set(record.project, projectModels)
      }

      if (tsMs >= cutoff5h) {
        detailedRequests.push(StatsViewBuilder.toDetailedRequest(record))
        const project = detailedProjects.get(record.project) ?? StatsViewBuilder.emptySummaryBucket()
        StatsViewBuilder.addSummaryRecord(project, record)
        detailedProjects.set(record.project, project)
      }
    }

    const dailyRows = [...daily.entries()].map(([date, bucket]) => StatsViewBuilder.toDailyUsage(date, bucket)).sort((a, b) => a.date.localeCompare(b.date))
    const sessionRows = [...sessions.entries()].map(([key, bucket]) => StatsViewBuilder.toSessionUsage(key.slice(key.indexOf(':') + 1), bucket)).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
    const projectRows24h = [...projects24h.entries()].map(([project, bucket]) => StatsViewBuilder.toProjectSummary(project, bucket)).sort(StatsViewBuilder.summarySort)
    const modelRows24h = [...models24h.entries()].map(([model, bucket]) => StatsViewBuilder.toModelSummary(model, bucket)).sort(StatsViewBuilder.summarySort)
    const detailedProjectRows = [...detailedProjects.entries()].map(([project, bucket]) => StatsViewBuilder.toProjectSummary(project, bucket)).sort(StatsViewBuilder.summarySort)
    detailedRequests.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

    return {
      daily: dailyRows,
      sessions: sessionRows,
      hourly: hourly.map(({ models, ...entry }) => ({ ...entry, modelsUsed: [...models] })),
      hourly24h: [...hourly24h.entries()].map(([label, bucket]) => StatsViewBuilder.toHourly24h(label, bucket)),
      projects24h: projectRows24h,
      models24h: modelRows24h,
      projectModels24h: StatsViewBuilder.toProjectModelMap(projectModels24h),
      detailed: {
        windowStart: new Date(cutoff5h).toISOString(),
        windowEnd: now.toISOString(),
        requests: detailedRequests,
        projects: detailedProjectRows,
      },
      totals: StatsViewBuilder.calculateTotals(dailyRows),
      costCoverage,
      durationCoverage,
    }
  }

  static merge(left: StatsView, right: StatsView): StatsView {
    const daily = StatsViewBuilder.mergeDaily(left.daily, right.daily)
    const sessions = [...left.sessions, ...right.sessions].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
    const hourly = StatsViewBuilder.mergeHourly(left.hourly, right.hourly)
    const hourly24h = StatsViewBuilder.mergeHourly24h(left.hourly24h, right.hourly24h)
    const projects24h = StatsViewBuilder.mergeProjectSummaries(left.projects24h, right.projects24h)
    const models24h = StatsViewBuilder.mergeModelSummaries(left.models24h, right.models24h)
    const projectModels24h = StatsViewBuilder.mergeProjectModelMaps(left.projectModels24h, right.projectModels24h)
    const requests = [...left.detailed.requests, ...right.detailed.requests].sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    const detailedProjects = StatsViewBuilder.mergeProjectSummaries(left.detailed.projects, right.detailed.projects)

    return {
      daily,
      sessions,
      hourly,
      hourly24h,
      projects24h,
      models24h,
      projectModels24h,
      detailed: {
        windowStart: left.detailed.windowStart < right.detailed.windowStart ? left.detailed.windowStart : right.detailed.windowStart,
        windowEnd: left.detailed.windowEnd > right.detailed.windowEnd ? left.detailed.windowEnd : right.detailed.windowEnd,
        requests,
        projects: detailedProjects,
      },
      totals: StatsViewBuilder.mergeTotals(left.totals, right.totals),
      costCoverage: StatsViewBuilder.mergeCoverage(left.costCoverage, right.costCoverage, StatsViewBuilder.hasUsage(left), StatsViewBuilder.hasUsage(right)),
      durationCoverage: StatsViewBuilder.mergeCoverage(left.durationCoverage, right.durationCoverage, StatsViewBuilder.hasUsage(left), StatsViewBuilder.hasUsage(right)),
    }
  }

  private static emptyMetrics(): Metrics {
    return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, cost: 0, durationMs: 0 }
  }

  private static emptySummaryBucket(): SummaryBucket {
    return { ...StatsViewBuilder.emptyMetrics(), requestCount: 0, models: new Set(), sessions: new Set() }
  }

  private static emptyModelBucket(): ModelBucket {
    return { ...StatsViewBuilder.emptyMetrics(), requestCount: 0, sessions: new Set() }
  }

  private static emptyDailyBucket(): DailyBucket {
    return { ...StatsViewBuilder.emptyMetrics(), models: new Map() }
  }

  private static emptyHourBucket(): HourBucket {
    return { ...StatsViewBuilder.emptyMetrics(), models: new Set(), projects: new Set(), byProject: {}, byModel: {} }
  }

  private static addRecord(target: Metrics, record: NormalizedUsageRecord): void {
    target.inputTokens += record.inputTokens
    target.outputTokens += record.outputTokens
    target.cacheCreationTokens += record.cacheCreationTokens
    target.cacheReadTokens += record.cacheReadTokens
    target.reasoningTokens += record.reasoningTokens
    target.cost += record.cost
    target.durationMs += record.durationMs
  }

  private static addMetrics(target: Metrics, source: Metrics): void {
    target.inputTokens += source.inputTokens
    target.outputTokens += source.outputTokens
    target.cacheCreationTokens += source.cacheCreationTokens
    target.cacheReadTokens += source.cacheReadTokens
    target.reasoningTokens += source.reasoningTokens
    target.cost += source.cost
    target.durationMs += source.durationMs
  }

  private static addSummaryRecord(target: SummaryBucket, record: NormalizedUsageRecord): void {
    StatsViewBuilder.addRecord(target, record)
    target.requestCount++
    target.models.add(record.model)
    target.sessions.add(`${record.agent}:${record.sessionId}`)
  }

  private static addModelRecord(target: ModelBucket, record: NormalizedUsageRecord): void {
    StatsViewBuilder.addRecord(target, record)
    target.requestCount++
    target.sessions.add(`${record.agent}:${record.sessionId}`)
  }

  private static addRecordToMap(target: Record<string, Metrics>, key: string, record: NormalizedUsageRecord): void {
    const bucket = target[key] ?? StatsViewBuilder.emptyMetrics()
    StatsViewBuilder.addRecord(bucket, record)
    target[key] = bucket
  }

  private static hourKey(date: Date): string {
    return `${date.toISOString().slice(0, 10)} ${String(date.getHours()).padStart(2, '0')}:00`
  }

  private static total(metrics: Pick<Metrics, 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'>): number {
    return metrics.inputTokens + metrics.outputTokens + metrics.cacheCreationTokens + metrics.cacheReadTokens
  }

  private static toModelBreakdown(modelName: string, metrics: Metrics): ModelBreakdown {
    return { modelName, inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens, cacheCreationTokens: metrics.cacheCreationTokens, cacheReadTokens: metrics.cacheReadTokens, reasoningTokens: metrics.reasoningTokens, cost: metrics.cost }
  }

  private static toDailyUsage(date: string, bucket: DailyBucket): DailyUsage {
    return {
      date,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheCreationTokens: bucket.cacheCreationTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      reasoningTokens: bucket.reasoningTokens,
      totalCost: bucket.cost,
      modelsUsed: [...bucket.models.keys()],
      modelBreakdowns: [...bucket.models.entries()].map(([model, metrics]) => StatsViewBuilder.toModelBreakdown(model, metrics)),
    }
  }

  private static toSessionUsage(sessionId: string, bucket: SessionBucket): SessionUsage {
    return {
      agent: bucket.agent,
      sessionId,
      projectPath: bucket.projectPath,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheCreationTokens: bucket.cacheCreationTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      reasoningTokens: bucket.reasoningTokens,
      totalCost: bucket.cost,
      lastActivity: bucket.lastActivity,
      modelsUsed: [...bucket.models.keys()],
      modelBreakdowns: [...bucket.models.entries()].map(([model, metrics]) => StatsViewBuilder.toModelBreakdown(model, metrics)),
    }
  }

  private static toDetailedRequest(record: NormalizedUsageRecord): DetailedRequest {
    return {
      agent: record.agent,
      timestamp: record.timestamp,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheCreationTokens: record.cacheCreationTokens,
      cacheReadTokens: record.cacheReadTokens,
      reasoningTokens: record.reasoningTokens,
      totalTokens: StatsViewBuilder.total(record),
      cost: record.cost,
      durationMs: record.durationMs,
      project: record.project,
      sessionId: record.sessionId,
    }
  }

  private static toProjectSummary(project: string, bucket: SummaryBucket): ProjectSummary {
    return {
      project,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheCreationTokens: bucket.cacheCreationTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      reasoningTokens: bucket.reasoningTokens,
      totalTokens: StatsViewBuilder.total(bucket),
      cost: bucket.cost,
      durationMs: bucket.durationMs,
      requestCount: bucket.requestCount,
      sessionCount: bucket.sessions.size,
      modelsUsed: [...bucket.models],
    }
  }

  private static toModelSummary(model: string, bucket: ModelBucket): ModelSummary24h {
    return {
      model,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheCreationTokens: bucket.cacheCreationTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      reasoningTokens: bucket.reasoningTokens,
      totalTokens: StatsViewBuilder.total(bucket),
      cost: bucket.cost,
      durationMs: bucket.durationMs,
      requestCount: bucket.requestCount,
      sessionCount: bucket.sessions.size,
    }
  }

  private static toHourly24h(label: string, bucket: HourBucket): Hourly24hEntry {
    return {
      label,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheCreationTokens: bucket.cacheCreationTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      reasoningTokens: bucket.reasoningTokens,
      cost: bucket.cost,
      durationMs: bucket.durationMs,
      modelsUsed: [...bucket.models],
      projects: [...bucket.projects],
      byProject: StatsViewBuilder.toHourlyBreakdownMap(bucket.byProject),
      byModel: StatsViewBuilder.toHourlyBreakdownMap(bucket.byModel),
    }
  }

  private static toHourlyBreakdownMap(source: Record<string, Metrics>): Record<string, Hourly24hProjectBreakdown> {
    return Object.fromEntries(Object.entries(source).map(([key, metrics]) => [key, { ...metrics }]))
  }

  private static toProjectModelMap(source: Map<string, Map<string, ModelBucket>>): Record<string, Record<string, ProjectModelCell>> {
    const result: Record<string, Record<string, ProjectModelCell>> = {}
    for (const [project, models] of source) {
      result[project] = {}
      for (const [model, bucket] of models) {
        result[project][model] = {
          inputTokens: bucket.inputTokens,
          outputTokens: bucket.outputTokens,
          cacheCreationTokens: bucket.cacheCreationTokens,
          cacheReadTokens: bucket.cacheReadTokens,
          reasoningTokens: bucket.reasoningTokens,
          totalTokens: StatsViewBuilder.total(bucket),
          cost: bucket.cost,
          durationMs: bucket.durationMs,
          requestCount: bucket.requestCount,
          sessionCount: bucket.sessions.size,
        }
      }
    }
    return result
  }

  static calculateTotals(rows: DailyUsage[]): StatsTotals {
    const totals: StatsTotals = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalCost: 0, totalTokens: 0 }
    for (const row of rows) {
      totals.inputTokens += row.inputTokens
      totals.outputTokens += row.outputTokens
      totals.cacheCreationTokens += row.cacheCreationTokens
      totals.cacheReadTokens += row.cacheReadTokens
      totals.reasoningTokens += row.reasoningTokens
      totals.totalCost += row.totalCost
    }
    totals.totalTokens = StatsViewBuilder.total(totals)
    return totals
  }

  private static summarySort(left: { cost: number; totalTokens: number }, right: { cost: number; totalTokens: number }): number {
    return right.cost - left.cost || right.totalTokens - left.totalTokens
  }

  private static mergeDaily(left: DailyUsage[], right: DailyUsage[]): DailyUsage[] {
    const result = new Map<string, DailyUsage>()
    for (const row of [...left, ...right]) {
      const current = result.get(row.date)
      if (!current) {
        result.set(row.date, { ...row, modelsUsed: [...row.modelsUsed], modelBreakdowns: row.modelBreakdowns.map((model) => ({ ...model })) })
        continue
      }
      current.inputTokens += row.inputTokens
      current.outputTokens += row.outputTokens
      current.cacheCreationTokens += row.cacheCreationTokens
      current.cacheReadTokens += row.cacheReadTokens
      current.reasoningTokens += row.reasoningTokens
      current.totalCost += row.totalCost
      current.modelsUsed = [...new Set([...current.modelsUsed, ...row.modelsUsed])]
      current.modelBreakdowns = StatsViewBuilder.mergeModelBreakdowns(current.modelBreakdowns, row.modelBreakdowns)
    }
    return [...result.values()].sort((a, b) => a.date.localeCompare(b.date))
  }

  private static mergeModelBreakdowns(left: ModelBreakdown[], right: ModelBreakdown[]): ModelBreakdown[] {
    const result = new Map<string, ModelBreakdown>()
    for (const row of [...left, ...right]) {
      const current = result.get(row.modelName)
      if (!current) {
        result.set(row.modelName, { ...row })
        continue
      }
      current.inputTokens += row.inputTokens
      current.outputTokens += row.outputTokens
      current.cacheCreationTokens += row.cacheCreationTokens
      current.cacheReadTokens += row.cacheReadTokens
      current.reasoningTokens += row.reasoningTokens
      current.cost += row.cost
    }
    return [...result.values()]
  }

  private static mergeHourly(left: HourlyUsage[], right: HourlyUsage[]): HourlyUsage[] {
    const result = new Map<number, HourlyUsage>()
    for (const row of [...left, ...right]) {
      const current = result.get(row.hour)
      if (!current) {
        result.set(row.hour, { ...row, modelsUsed: [...row.modelsUsed] })
        continue
      }
      StatsViewBuilder.addMetrics(current, row)
      current.modelsUsed = [...new Set([...current.modelsUsed, ...row.modelsUsed])]
    }
    return [...result.values()].sort((a, b) => a.hour - b.hour)
  }

  private static mergeHourly24h(left: Hourly24hEntry[], right: Hourly24hEntry[]): Hourly24hEntry[] {
    const result = new Map<string, Hourly24hEntry>()
    for (const row of [...left, ...right]) {
      const current = result.get(row.label)
      if (!current) {
        result.set(row.label, { ...row, modelsUsed: [...row.modelsUsed], projects: [...row.projects], byProject: StatsViewBuilder.cloneBreakdownMap(row.byProject), byModel: StatsViewBuilder.cloneBreakdownMap(row.byModel) })
        continue
      }
      StatsViewBuilder.addMetrics(current, row)
      current.modelsUsed = [...new Set([...current.modelsUsed, ...row.modelsUsed])]
      current.projects = [...new Set([...current.projects, ...row.projects])]
      current.byProject = StatsViewBuilder.mergeBreakdownMaps(current.byProject, row.byProject)
      current.byModel = StatsViewBuilder.mergeBreakdownMaps(current.byModel, row.byModel)
    }
    return [...result.values()].sort((a, b) => a.label.localeCompare(b.label))
  }

  private static cloneBreakdownMap(source: Record<string, Hourly24hProjectBreakdown>): Record<string, Hourly24hProjectBreakdown> {
    return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, { ...value }]))
  }

  private static mergeBreakdownMaps(left: Record<string, Hourly24hProjectBreakdown>, right: Record<string, Hourly24hProjectBreakdown>): Record<string, Hourly24hProjectBreakdown> {
    const result = StatsViewBuilder.cloneBreakdownMap(left)
    for (const [key, value] of Object.entries(right)) {
      const current = result[key]
      if (!current) result[key] = { ...value }
      else StatsViewBuilder.addMetrics(current, value)
    }
    return result
  }

  private static mergeProjectSummaries(left: ProjectSummary[], right: ProjectSummary[]): ProjectSummary[] {
    const result = new Map<string, ProjectSummary>()
    for (const row of [...left, ...right]) {
      const current = result.get(row.project)
      if (!current) {
        result.set(row.project, { ...row, modelsUsed: [...row.modelsUsed] })
        continue
      }
      StatsViewBuilder.addMetrics(current, row)
      current.totalTokens = StatsViewBuilder.total(current)
      current.requestCount += row.requestCount
      current.sessionCount += row.sessionCount
      current.modelsUsed = [...new Set([...current.modelsUsed, ...row.modelsUsed])]
    }
    return [...result.values()].sort(StatsViewBuilder.summarySort)
  }

  private static mergeModelSummaries(left: ModelSummary24h[], right: ModelSummary24h[]): ModelSummary24h[] {
    const result = new Map<string, ModelSummary24h>()
    for (const row of [...left, ...right]) {
      const current = result.get(row.model)
      if (!current) {
        result.set(row.model, { ...row })
        continue
      }
      StatsViewBuilder.addMetrics(current, row)
      current.totalTokens = StatsViewBuilder.total(current)
      current.requestCount += row.requestCount
      current.sessionCount += row.sessionCount
    }
    return [...result.values()].sort(StatsViewBuilder.summarySort)
  }

  private static mergeProjectModelMaps(left: Record<string, Record<string, ProjectModelCell>>, right: Record<string, Record<string, ProjectModelCell>>): Record<string, Record<string, ProjectModelCell>> {
    const result: Record<string, Record<string, ProjectModelCell>> = {}
    for (const [project, models] of Object.entries(left)) result[project] = Object.fromEntries(Object.entries(models).map(([model, cell]) => [model, { ...cell }]))
    for (const [project, models] of Object.entries(right)) {
      const target = result[project] ?? (result[project] = {})
      for (const [model, cell] of Object.entries(models)) {
        const current = target[model]
        if (!current) target[model] = { ...cell }
        else {
          StatsViewBuilder.addMetrics(current, cell)
          current.totalTokens = StatsViewBuilder.total(current)
          current.requestCount += cell.requestCount
          current.sessionCount += cell.sessionCount
        }
      }
    }
    return result
  }

  private static mergeTotals(left: StatsTotals, right: StatsTotals): StatsTotals {
    const result: StatsTotals = {
      inputTokens: left.inputTokens + right.inputTokens,
      outputTokens: left.outputTokens + right.outputTokens,
      cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
      cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
      reasoningTokens: left.reasoningTokens + right.reasoningTokens,
      totalCost: left.totalCost + right.totalCost,
      totalTokens: 0,
    }
    result.totalTokens = StatsViewBuilder.total(result)
    return result
  }

  private static mergeCoverage(left: MetricCoverage, right: MetricCoverage, leftHasUsage: boolean, rightHasUsage: boolean): MetricCoverage {
    if (!leftHasUsage && !rightHasUsage) return left === right ? left : 'none'
    if (!leftHasUsage) return right
    if (!rightHasUsage) return left
    if (left === right) return left
    return 'partial'
  }

  private static hasUsage(view: StatsView): boolean {
    return view.totals.totalTokens > 0 || view.sessions.length > 0
  }
}
