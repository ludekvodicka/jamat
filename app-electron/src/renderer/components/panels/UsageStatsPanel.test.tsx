/**
 * UsageStatsPanel: fetches stats over `stats:data` and renders the 4-tab shell.
 * Covers the two key states — ready (tabs + summary render) and error (retry view).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, render, waitFor, screen } from '@testing-library/react'
import { UsageStatsPanel } from './UsageStatsPanel'
import type { MetricCoverage, Stats, StatsView } from '../../../../../core/types/stats'

const view = (tokens: number, cost: number, costCoverage: MetricCoverage, durationCoverage: MetricCoverage = costCoverage): StatsView => ({
  daily: [{
    date: '2026-06-27', inputTokens: tokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
    totalCost: cost, modelsUsed: ['model'],
    modelBreakdowns: [{ modelName: 'model', inputTokens: tokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, cost }],
  }],
  sessions: [], hourly: [], hourly24h: [], projects24h: [], models24h: [], projectModels24h: {},
  detailed: { windowStart: '2026-06-27T07:00:00.000Z', windowEnd: '2026-06-27T12:00:00.000Z', requests: [], projects: [] },
  totals: { inputTokens: tokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalCost: cost, totalTokens: tokens },
  costCoverage,
  durationCoverage,
})

const CLAUDE = view(150, 1.5, 'full')
const CODEX = view(300, 2.5, 'full', 'none')
const STATS: Stats = { generatedAt: '2026-06-27T12:00:00.000Z', ...view(450, 4, 'full', 'partial'), byAgent: { claude: CLAUDE, codex: CODEX } }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mount = () => render(<UsageStatsPanel {...({ api: { setTitle: () => {} } } as any)} />)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
afterEach(() => { delete (window as any).electronAPI })

describe('UsageStatsPanel', () => {
  it('renders the 4-tab shell and summary when stats resolve', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electronAPI = { getStatsData: async () => ({ ok: true, data: STATS }), onStatsProgress: () => () => {} }
    const { container } = mount()
    await waitFor(() => expect(container.querySelectorAll('.usage-stats-tab').length).toBe(4))
    expect(screen.getByText('Overview')).toBeTruthy()
    expect(screen.getByText('All-time tokens')).toBeTruthy()
    expect(screen.getAllByText('450').length).toBeGreaterThan(0)
    const agents = container.querySelectorAll<HTMLButtonElement>('.usage-agent-option')
    expect([...agents].map((button) => button.textContent)).toEqual(['All', 'Claude', 'Codex'])
    fireEvent.click(agents[1])
    expect(screen.getAllByText('150').length).toBeGreaterThan(0)
    fireEvent.click(agents[2])
    expect(screen.getAllByText('300').length).toBeGreaterThan(0)
    expect(screen.queryByText('API time today')).toBeNull()
  })

  it('shows an error + retry when the fetch fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electronAPI = { getStatsData: async () => ({ ok: false, error: 'boom' }), onStatsProgress: () => () => {} }
    mount()
    await waitFor(() => expect(screen.getByText('Failed to load usage stats')).toBeTruthy())
    expect(screen.getByText('boom')).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()
  })
})
