/** DetailedTab: the 1h view is derived from the 5h request set; request rows get cost-intensity classes. */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DetailedTab } from './DetailedTab'
import type { StatsView, DetailedRequest } from '../../../../../../core/types/stats'

const req = (project: string, ts: string, cost: number): DetailedRequest => ({
  agent: 'claude', timestamp: ts, model: 'claude-opus-4-8', inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
  totalTokens: 150, cost, durationMs: 1000, project, sessionId: 'sess1234abcd',
})

const STATS: StatsView = {
  daily: [], sessions: [], hourly: [], hourly24h: [], projects24h: [], models24h: [], projectModels24h: {},
  detailed: {
    windowStart: '2026-06-27T07:00:00.000Z', windowEnd: '2026-06-27T12:00:00.000Z',
    requests: [req('recent', '2026-06-27T11:30:00.000Z', 1.0), req('older', '2026-06-27T09:00:00.000Z', 0.1)],
    projects: [],
  },
  totals: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalCost: 0, totalTokens: 0 },
  costCoverage: 'full', durationCoverage: 'full',
}

describe('DetailedTab', () => {
  it('5h view shows all requests and tags high-cost rows', () => {
    const { container } = render(<DetailedTab stats={STATS} windowHours={5} />)
    expect(screen.getAllByText('recent').length).toBeGreaterThan(0)
    expect(screen.getAllByText('older').length).toBeGreaterThan(0)
    expect(container.querySelector('.usage-row-cost-hi')).toBeTruthy()
  })

  it('1h view derives from the 5h set and drops requests older than an hour', () => {
    render(<DetailedTab stats={STATS} windowHours={1} />)
    expect(screen.getAllByText('recent').length).toBeGreaterThan(0)
    expect(screen.queryByText('older')).toBeNull()
  })

  it('hides API-time cards and duration columns when duration is unavailable', () => {
    const { container } = render(<DetailedTab stats={{ ...STATS, durationCoverage: 'none' }} windowHours={5} />)
    expect(container.textContent).not.toContain('API time')
    expect(container.textContent).not.toContain('Duration')
  })
})
