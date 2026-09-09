import type { SessionAgentId } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { ProjectSessionsResult } from '../../../../../lib-orchestrator/projectManager/projectManagerApi.types'

export interface ProjectSummary {
  /** As many as the library was willing to enumerate; it caps a history of its own accord. */
  sessionCount: number
  lastAgentId: SessionAgentId | null
}

export interface SummaryRequest {
  categoryId: string
  name: string
}

/**
 * The two columns the listing cannot answer: how many sessions a project has had, and which agent
 * ran the last one. Both come from one `projects:sessions` call per row.
 *
 * The first look at a project is the expensive one - the library reads transcripts to title them and
 * memoizes each file by mtime and size - so this asks for the rows on screen, four at a time, and
 * remembers what it learned. It cannot cancel a call already in the main process: the channel takes
 * no signal. What it does is stop starting new ones and drop answers to questions nobody is looking
 * at any more, which is what keeps a category the user left from filling in over the one they opened.
 */
export class ProjectSummaryLoader {
  private static readonly concurrencyConst = 4
  private readonly cache = new Map<string, ProjectSummary>()
  private generation = 0

  constructor(
    private readonly fetch: (categoryId: string, name: string) => Promise<ProjectSessionsResult | null>,
  ) {}

  /** Supersedes the batch before it. Anything already known is handed back before anything is asked. */
  load(requests: readonly SummaryRequest[], onSummary: (request: SummaryRequest, summary: ProjectSummary) => void): void {
    this.generation += 1
    const generation = this.generation
    const queue: SummaryRequest[] = []
    for (const request of requests) {
      const known = this.cache.get(ProjectSummaryLoader.keyOf(request))
      if (known)
        onSummary(request, known)
      else
        queue.push(request)
    }
    const workers = Math.min(ProjectSummaryLoader.concurrencyConst, queue.length)
    for (let worker = 0; worker < workers; worker += 1)
      void this.drain(generation, queue, onSummary)
  }

  /** Called after a mutation moved a project: its counts are about a path that no longer holds. */
  invalidate(request: SummaryRequest): void {
    this.cache.delete(ProjectSummaryLoader.keyOf(request))
  }

  private async drain(
    generation: number,
    queue: SummaryRequest[],
    onSummary: (request: SummaryRequest, summary: ProjectSummary) => void,
  ): Promise<void> {
    for (;;) {
      const request = queue.shift()
      if (!request || generation !== this.generation)
        return
      const result = await this.fetch(request.categoryId, request.name)
      if (generation !== this.generation)
        return
      // A row that could not be read keeps an empty column and stays uncached, so coming back to it
      // asks again. One unreadable project is not worth a banner over a listing that is fine.
      if (result === null)
        continue
      const summary = ProjectSummaryLoader.summaryOf(result)
      this.cache.set(ProjectSummaryLoader.keyOf(request), summary)
      onSummary(request, summary)
    }
  }

  /** `merged` arrives newest first, so the agent of the last session is the first row of it. */
  private static summaryOf(result: ProjectSessionsResult): ProjectSummary {
    return {
      sessionCount: result.merged.length,
      lastAgentId: result.merged[0]?.agentId ?? null,
    }
  }

  private static keyOf(request: SummaryRequest): string {
    return `${request.categoryId}/${request.name}`
  }
}
