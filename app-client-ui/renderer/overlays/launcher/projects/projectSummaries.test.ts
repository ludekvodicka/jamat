import { describe, expect, it } from 'vitest'

import type {
  ProjectSessionsResult,
  ProviderSessionSummary,
} from '../../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import {
  ProjectSummaryLoader,
  type ProjectSummary,
  type SummaryRequest,
} from './projectSummaries'

describe('app-client-ui/renderer/overlays/launcher/projectSummaries', () => {
  /** Hands out answers only when a test says so, which is what makes concurrency observable. */
  class Source {
    readonly asked: string[] = []
    private readonly pending = new Map<string, (result: ProjectSessionsResult | null) => void>()
    inFlight = 0
    peak = 0

    fetch = (categoryId: string, name: string): Promise<ProjectSessionsResult | null> => {
      this.asked.push(`${categoryId}/${name}`)
      this.inFlight += 1
      this.peak = Math.max(this.peak, this.inFlight)
      return new Promise((settle) => {
        this.pending.set(`${categoryId}/${name}`, (result) => {
          this.inFlight -= 1
          settle(result)
        })
      })
    }

    async answer(key: string, result: ProjectSessionsResult | null): Promise<void> {
      const settle = this.pending.get(key)
      if (!settle)
        throw new Error(`Nothing asked for ${key}`)
      this.pending.delete(key)
      settle(result)
      await Promise.resolve()
      await Promise.resolve()
    }

    async answerAll(result: ProjectSessionsResult | null): Promise<void> {
      for (const key of [...this.pending.keys()])
        await this.answer(key, result)
    }
  }

  function sessions(...agents: readonly ('claude' | 'codex')[]): ProjectSessionsResult {
    const merged: ProviderSessionSummary[] = agents.map((agentId, index) => ({
      agentId,
      nativeSessionId: `s-${index}`,
      title: null,
      firstUserMessage: null,
      createdAt: 0,
      lastActivity: 1000 - index,
      active: false,
    }))
    return { claude: [], codex: [], merged }
  }

  function requests(...names: readonly string[]): SummaryRequest[] {
    return names.map((name) => ({ categoryId: 'nodejs', name }))
  }

  function collector() {
    const seen: { name: string; summary: ProjectSummary }[] = []
    return {
      seen,
      onSummary: (request: SummaryRequest, summary: ProjectSummary) =>
        void seen.push({ name: request.name, summary }),
    }
  }

  it('reads the count and the agent of the newest session', async () => {
    const source = new Source()
    const loader = new ProjectSummaryLoader(source.fetch)
    const sink = collector()

    loader.load(requests('AppJamat'), sink.onSummary)
    await source.answer('nodejs/AppJamat', sessions('codex', 'claude'))

    expect(sink.seen).toEqual([{
      name: 'AppJamat',
      summary: { sessionCount: 2, lastAgentId: 'codex' },
    }])
  })

  it('reads a project with no sessions as zero rather than as unknown', async () => {
    const source = new Source()
    const loader = new ProjectSummaryLoader(source.fetch)
    const sink = collector()

    loader.load(requests('AppJamat'), sink.onSummary)
    await source.answer('nodejs/AppJamat', sessions())

    expect(sink.seen[0].summary).toEqual({ sessionCount: 0, lastAgentId: null })
  })

  it('keeps at most four reads in the air at once', async () => {
    const source = new Source()
    const loader = new ProjectSummaryLoader(source.fetch)

    loader.load(requests('a', 'b', 'c', 'd', 'e', 'f'), collector().onSummary)

    expect(source.peak).toBe(4)
    expect(source.asked).toEqual(['nodejs/a', 'nodejs/b', 'nodejs/c', 'nodejs/d'])
  })

  // The category the user left must not fill in over the one they opened.
  it('drops the answers of a batch that was superseded', async () => {
    const source = new Source()
    const loader = new ProjectSummaryLoader(source.fetch)
    const sink = collector()

    loader.load(requests('a', 'b', 'c', 'd', 'e'), sink.onSummary)
    loader.load([{ categoryId: 'web', name: 'z' }], sink.onSummary)
    await source.answer('nodejs/a', sessions('claude'))

    expect(sink.seen.map((entry) => entry.name)).not.toContain('a')

    await source.answer('web/z', sessions('claude'))
    expect(sink.seen.map((entry) => entry.name)).toEqual(['z'])
  })

  it('starts nothing further once a batch is superseded', async () => {
    const source = new Source()
    const loader = new ProjectSummaryLoader(source.fetch)

    loader.load(requests('a', 'b', 'c', 'd', 'e', 'f'), collector().onSummary)
    loader.load([], collector().onSummary)
    await source.answerAll(sessions('claude'))

    expect(source.asked).toEqual(['nodejs/a', 'nodejs/b', 'nodejs/c', 'nodejs/d'])
  })

  it('answers a second look from what it already knows', async () => {
    const source = new Source()
    const loader = new ProjectSummaryLoader(source.fetch)
    const first = collector()

    loader.load(requests('AppJamat'), first.onSummary)
    await source.answer('nodejs/AppJamat', sessions('claude'))

    const second = collector()
    loader.load(requests('AppJamat'), second.onSummary)

    expect(second.seen).toHaveLength(1)
    expect(source.asked).toEqual(['nodejs/AppJamat'])
  })

  it('asks again for a row whose counts were invalidated', async () => {
    const source = new Source()
    const loader = new ProjectSummaryLoader(source.fetch)

    loader.load(requests('AppJamat'), collector().onSummary)
    await source.answer('nodejs/AppJamat', sessions('claude'))
    loader.invalidate({ categoryId: 'nodejs', name: 'AppJamat' })
    loader.load(requests('AppJamat'), collector().onSummary)

    expect(source.asked).toEqual(['nodejs/AppJamat', 'nodejs/AppJamat'])
  })

  // One unreadable project is not worth a banner over a listing that is otherwise fine.
  it('leaves a row that could not be read empty, uncached, and the rest running', async () => {
    const source = new Source()
    const loader = new ProjectSummaryLoader(source.fetch)
    const sink = collector()

    loader.load(requests('a', 'b'), sink.onSummary)
    await source.answer('nodejs/a', null)
    await source.answer('nodejs/b', sessions('claude'))

    expect(sink.seen.map((entry) => entry.name)).toEqual(['b'])

    loader.load(requests('a'), collector().onSummary)
    expect(source.asked.filter((key) => key === 'nodejs/a')).toHaveLength(2)
  })
})
