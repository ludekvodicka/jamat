import { AntigravityConfigHome } from '../../../shared/antigravityConfigHome'
import { PathCompare } from '../../../shared/pathCompare'
import type { ProviderSessionSummary } from '../../projectManagerApi.types'
import type { ProviderSessionSource } from '../providerContract.types'
import { type AntigravityConversationSummary, AntigravitySummariesDb } from './antigravitySummariesDb'

export interface AntigravitySessionSourceOptions {
  antigravityHome?: string
}

/**
 * Lists top-level Antigravity CLI conversations for a project and reports its latest activity from
 * `<antigravityHome>/conversation_summaries.db`.
 */
export class AntigravitySessionSource implements ProviderSessionSource {
  readonly agentId = 'antigravity' as const

  private readonly antigravityHome: string
  private cachedKey: string | null = null
  private cachedRows: readonly AntigravityConversationSummary[] = []
  private cachedActivity: Map<string, number> | null = null

  constructor(options?: AntigravitySessionSourceOptions) {
    this.antigravityHome = AntigravityConfigHome.resolve(options?.antigravityHome)
  }

  async listProjectSessions(
    projectDir: string,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<ProviderSessionSummary[]> {
    if (options.signal?.aborted) return []
    const target = PathCompare.comparable(projectDir)
    const rows = this.rows()
    const matching: ProviderSessionSummary[] = []
    for (const row of rows) {
      if (options.signal?.aborted) break
      if (row.parentConversationId !== null || row.nestingDepth > 0) continue
      if (!row.workspacePaths.some((path) => PathCompare.comparable(path) === target)) continue
      matching.push({
        agentId: 'antigravity',
        nativeSessionId: row.conversationId,
        title: row.title,
        firstUserMessage: row.preview,
        createdAt: row.createdAt,
        lastActivity: row.lastModifiedAt,
        active: row.active,
      })
    }
    return matching
      .sort((left, right) => right.lastActivity - left.lastActivity)
      .slice(0, options.limit)
  }

  async latestActivity(projectDir: string): Promise<number | null> {
    this.rows()
    return this.cachedActivity?.get(PathCompare.comparable(projectDir)) ?? null
  }

  invalidate(): void {
    this.cachedKey = null
    this.cachedRows = []
    this.cachedActivity = null
  }

  private rows(): readonly AntigravityConversationSummary[] {
    const key = AntigravitySummariesDb.statKey(this.antigravityHome)
    if (key === null) {
      this.cachedKey = null
      this.cachedRows = []
      this.cachedActivity = new Map()
      return this.cachedRows
    }
    if (key === this.cachedKey && this.cachedActivity !== null) return this.cachedRows
    const rows = AntigravitySummariesDb.readAll(this.antigravityHome)
    const activity = new Map<string, number>()
    for (const row of rows) {
      if (row.parentConversationId !== null || row.nestingDepth > 0) continue
      for (const path of row.workspacePaths) {
        const keyPath = PathCompare.comparable(path)
        const previous = activity.get(keyPath) ?? 0
        if (row.lastModifiedAt > previous) activity.set(keyPath, row.lastModifiedAt)
      }
    }
    this.cachedKey = key
    this.cachedRows = rows
    this.cachedActivity = activity
    return rows
  }
}
