/** Last24hTab: project/model filters are mutually exclusive and hide the matching breakdown table. */
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Last24hTab } from './Last24hTab'
import type { Stats, ProjectSummary, ModelSummary24h, ProjectModelCell } from '../../../../../../core/types/stats'

const proj = (project: string, cost: number): ProjectSummary => ({
  project, inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 150,
  cost, durationMs: 1000, requestCount: 5, sessionCount: 1, modelsUsed: ['claude-opus-4-8'],
})
const model = (m: string, cost: number): ModelSummary24h => ({
  model: m, inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 150,
  cost, durationMs: 1000, requestCount: 5, sessionCount: 1,
})
const cell = (cost: number): ProjectModelCell => ({
  inputTokens: 50, outputTokens: 25, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 75,
  cost, durationMs: 500, requestCount: 2, sessionCount: 1,
})

const STATS: Stats = {
  generatedAt: '2026-06-27T12:00:00.000Z',
  daily: [], sessions: [], hourly: [],
  hourly24h: [{
    label: '2026-06-27 11:00', inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0,
    cost: 0.5, durationMs: 1000, modelsUsed: ['claude-opus-4-8'], projects: ['A'],
    byProject: { A: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.5, durationMs: 1000 } },
    byModel: { 'claude-opus-4-8': { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.5, durationMs: 1000 } },
  }],
  projects24h: [proj('A', 0.6), proj('B', 0.3)],
  models24h: [model('claude-opus-4-8', 0.7), model('claude-haiku-4-5', 0.2)],
  projectModels24h: { A: { 'claude-opus-4-8': cell(0.4), 'claude-haiku-4-5': cell(0.2) }, B: { 'claude-opus-4-8': cell(0.3) } },
  detailed: { windowStart: '', windowEnd: '', requests: [], projects: [] },
  totals: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0, totalTokens: 0 },
}

const selects = (c: HTMLElement) => c.querySelectorAll('select')

describe('Last24hTab', () => {
  it('shows both breakdown tables with no filter', () => {
    render(<Last24hTab stats={STATS} />)
    expect(screen.getByText('By project')).toBeTruthy()
    expect(screen.getByText('By model')).toBeTruthy()
  })

  it('selecting a project hides the project table and scopes the model table', () => {
    const { container } = render(<Last24hTab stats={STATS} />)
    fireEvent.change(selects(container)[0], { target: { value: 'A' } })
    expect(screen.queryByText('By project')).toBeNull()
    expect(screen.getByText('By model · A')).toBeTruthy()
  })

  it('selecting a model hides the model table and scopes the project table; clears any project filter', () => {
    const { container } = render(<Last24hTab stats={STATS} />)
    // first pick a project, then a model — model selection must reset the project filter
    fireEvent.change(selects(container)[0], { target: { value: 'A' } })
    fireEvent.change(selects(container)[1], { target: { value: 'claude-opus-4-8' } })
    expect(screen.queryByText('By model')).toBeNull()
    expect(screen.getByText('By project · claude-opus-4-8')).toBeTruthy()
  })
})
