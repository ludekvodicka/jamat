/**
 * UsageStatsNativePanel: fetches stats over `stats:data` and renders the 4-tab shell.
 * Covers the two key states — ready (tabs + summary render) and error (retry view).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { render, waitFor, screen } from '@testing-library/react'
import { UsageStatsNativePanel } from './UsageStatsNativePanel'
import type { Stats } from '../../../../../core/types/stats'

const STATS: Stats = {
  generatedAt: '2026-06-27T12:00:00.000Z',
  daily: [{
    date: '2026-06-27', inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0,
    totalCost: 1.5, modelsUsed: ['claude-opus-4-8'],
    modelBreakdowns: [{ modelName: 'claude-opus-4-8', inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 1.5 }],
  }],
  sessions: [], hourly: [], hourly24h: [], projects24h: [], models24h: [], projectModels24h: {},
  detailed: { windowStart: '2026-06-27T07:00:00.000Z', windowEnd: '2026-06-27T12:00:00.000Z', requests: [], projects: [] },
  totals: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 1.5, totalTokens: 150 },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mount = () => render(<UsageStatsNativePanel {...({ api: { setTitle: () => {} } } as any)} />)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
afterEach(() => { delete (window as any).electronAPI })

describe('UsageStatsNativePanel', () => {
  it('renders the 4-tab shell and summary when stats resolve', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electronAPI = { getStatsData: async () => ({ ok: true, data: STATS }) }
    const { container } = mount()
    await waitFor(() => expect(container.querySelectorAll('.usage-stats-tab').length).toBe(4))
    expect(screen.getByText('Overview')).toBeTruthy()
    expect(screen.getByText('All-time tokens')).toBeTruthy()
    expect(screen.getAllByText('150').length).toBeGreaterThan(0) // all-time tokens (fmtNum 150)
  })

  it('shows an error + retry when the fetch fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electronAPI = { getStatsData: async () => ({ ok: false, error: 'boom' }) }
    mount()
    await waitFor(() => expect(screen.getByText('Failed to load usage stats')).toBeTruthy())
    expect(screen.getByText('boom')).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()
  })
})
