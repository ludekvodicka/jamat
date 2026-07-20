/** OverviewTab: 5 summary cards, 4 insight cards, model breakdown table, and chart sub-tab/toggle state. */
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { OverviewTab } from './OverviewTab'
import type { StatsView, DailyUsage } from '../../../../../../core/types/stats'

const mb = (modelName: string, i: number, o: number) => ({ modelName, inputTokens: i, outputTokens: o, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, cost: i * 1e-5 })
const day = (date: string, opus: number, haiku: number): DailyUsage => ({
  date, inputTokens: opus + haiku, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
  reasoningTokens: 0,
  totalCost: (opus + haiku) * 1e-5, modelsUsed: ['claude-opus-4-8', 'claude-haiku-4-5'],
  modelBreakdowns: [mb('claude-opus-4-8', opus, 0), mb('claude-haiku-4-5', haiku, 0)],
})

const STATS: StatsView = {
  daily: [day('2026-06-26', 100, 20), day('2026-06-27', 80, 40)],
  sessions: [{ sessionId: 's1' } as never], hourly: [], hourly24h: [], projects24h: [], models24h: [], projectModels24h: {},
  detailed: { windowStart: '', windowEnd: '', requests: [], projects: [] },
  totals: { inputTokens: 240, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalCost: 0.0024, totalTokens: 240 },
  costCoverage: 'full', durationCoverage: 'full',
}

describe('OverviewTab', () => {
  it('renders 5 summary cards and 4 insight cards', () => {
    const { container } = render(<OverviewTab stats={STATS} />)
    expect(container.querySelectorAll('.usage-stat-card').length).toBe(5)
    expect(container.querySelectorAll('.usage-insight-card').length).toBe(4)
  })

  it('lists models in the breakdown table', () => {
    render(<OverviewTab stats={STATS} />)
    expect(screen.getAllByText('opus-4-8').length).toBeGreaterThan(0)
    expect(screen.getAllByText('haiku-4-5').length).toBeGreaterThan(0)
  })

  it('In/Out toggle shows on Tokens tab and hides on API cost tab', () => {
    render(<OverviewTab stats={STATS} />)
    expect(screen.queryByText('In/Out')).toBeTruthy()
    fireEvent.click(screen.getByText('API cost est.'))
    expect(screen.queryByText('In/Out')).toBeNull()
    expect(screen.getByText('API cost est.').className).toContain('active')
  })

  it('model filter scopes the breakdown to the chosen model', () => {
    const { container } = render(<OverviewTab stats={STATS} />)
    expect(screen.getAllByText('opus-4-8').length).toBeGreaterThan(0)
    fireEvent.change(container.querySelector('select')!, { target: { value: 'claude-haiku-4-5' } })
    expect(screen.queryByText('opus-4-8')).toBeNull() // opus chips gone after filtering to haiku
    expect(screen.getAllByText('haiku-4-5').length).toBeGreaterThan(0)
  })

  it('hides the API-time insight when duration is unavailable', () => {
    const { container } = render(<OverviewTab stats={{ ...STATS, durationCoverage: 'none' }} />)
    expect(container.querySelectorAll('.usage-insight-card').length).toBe(3)
    expect(container.textContent).not.toContain('API time today')
  })
})
