import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsagePanel } from './usagePanel'

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./tokensSection', () => ({ TokensSection: () => <section>Tokens</section> }))
vi.mock('./usageChart', () => ({ usageChartTheme: () => ({ text: '', grid: '', accent: '', series: [] }),
  UsageChart: ({ label }: { label: string }) => <div role="img" aria-label={label} /> }))
vi.mock('../ipc/appControl', () => ({ AppControl: { value: read } }))

const now = Date.parse('2026-11-04T18:00:00Z')
const hour = 3_600_000
const snapshot = {
  capturedAt: now,
  pools: [
    { agentId: 'claude', weeklyRemaining: 155, weeklyCapacity: 200, sessionRemaining: 0, sessionCapacity: 200, weeklyKnown: 2, sessionKnown: 0, accountCount: 2, weeklyLeftPercent: 85 },
    { agentId: 'codex', weeklyRemaining: 0, weeklyCapacity: 0, sessionRemaining: 0, sessionCapacity: 0, weeklyKnown: 0, sessionKnown: 0, accountCount: 0, weeklyLeftPercent: null },
  ],
  accounts: [
    { key: { agentId: 'claude', accountId: 'work' }, label: 'Work', enabled: true, accountState: 'active', source: 'poll', capacity: { weight: 5, tier: 'default_claude_max_5x' },
      state: { kind: 'stale', windows: [], fetchedAt: 1, reason: 'old' }, estimated: { estimated: true, ageMilliseconds: 2 * hour, sampleAt: 1,
        windows: [{ durationMinutes: 10080, usedPercent: 45, resetsAt: '2026-11-08T15:00:00Z' }] } },
    { key: { agentId: 'claude', accountId: 'main' }, label: 'Main', enabled: true, accountState: 'active', source: 'poll', estimated: null, capacity: { weight: 10, tier: 'default_claude_max_20x' },
      state: { kind: 'ok', fetchedAt: 1, windows: [{ durationMinutes: 10080, usedPercent: 0, resetsAt: null }] } },
  ],
}
const series = { recorded: [{ at: now - hour, remaining: 160 }], projected: [{ at: now, remaining: 155 }], burnPerHour: 0.7,
  poolEmptyAt: now + 46 * hour, firstEmpty: { accountId: 'work', at: now + 30 * hour }, nextReset: { accountId: 'main', at: now + 94 * hour, gain: 100 },
  now, until: now + 7 * 24 * hour, knownAccounts: 2, totalAccounts: 2, accounts: [] }

const callers = { capturedAt: now, windowDays: 30, command: null, recent: [],
  callers: [{ caller: 'indexer', lastAt: now - hour, calls: 3, fallbacks: 1, purposes: { interactive: 0, background: 3 },
    accounts: [{ accountId: 'work', label: 'Work', calls: 3 }] }] }

describe('UsagePanel', () => {
  beforeEach(() => {
    read.mockReset()
    read.mockImplementation(async (operation: string) => ({ ok: true, value: operation === 'usage.get' ? snapshot : operation === 'usage.callers' ? callers : series }))
    Object.defineProperty(window, 'appClient', { configurable: true, value: { onUsageChanged: () => () => undefined, onUsageCallersChanged: () => () => undefined } })
  })
  afterEach(cleanup)

  it('draws the pool as figures, one row per account and no card for an agent without accounts', async () => {
    render(<UsagePanel />)
    expect(await screen.findByText('85%')).toBeTruthy()
    expect(screen.getByText('weighted by plan')).toBeTruthy()
    expect(screen.getByText('×10')).toHaveAttribute('title', 'default_claude_max_20x: weight 10 in the weekly pool and the account choice')
    expect(screen.getByText('×5')).toBeTruthy()
    expect(await screen.findByText('0.7%/h')).toBeTruthy()
    expect(screen.getByText('in 1d 22h')).toBeTruthy()
    expect(screen.getByText(/Work · in 1d 6h/)).toBeTruthy()
    expect(screen.getByText(/Main · in 3d 22h · \+100%/)).toBeTruthy()
    expect(screen.getByText('estimate, 2h old')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'Work weekly used' })).toHaveAttribute('aria-valuenow', '45')
    expect(screen.getByRole('img', { name: /Claude recorded and projected/ })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Codex quota' })).toBeNull()
  })

  it('leaves out figures it has no reading for', async () => {
    render(<UsagePanel />)
    await screen.findByText('0.7%/h')
    expect(screen.queryByText('5-hour left')).toBeNull()
    expect(screen.queryByRole('progressbar', { name: /5-hour/ })).toBeNull()
    expect(screen.queryByText(/Unknown|No reading|measured/)).toBeNull()
  })

  it('opens on Quota with both tabs in the strip and switches to Callers on a click', async () => {
    render(<UsagePanel />)
    expect(await screen.findByText('85%')).toBeTruthy()
    const strip = screen.getByRole('tablist', { name: 'Usage' })
    expect([...strip.querySelectorAll('[role="tab"]')].map(tab => [tab.textContent, tab.getAttribute('aria-selected')]))
      .toEqual([['Quota', 'true'], ['Callers', 'false']])
    expect(screen.getByText('Tokens')).toBeTruthy()
    expect(read).not.toHaveBeenCalledWith('usage.callers', {})
    fireEvent.click(screen.getByRole('tab', { name: 'Callers' }))
    expect(screen.getByRole('tab', { name: 'Callers' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('indexer')).toBeTruthy()
    expect(screen.queryByText('85%')).toBeNull()
    expect(screen.queryByText('Tokens')).toBeNull()
    await waitFor(() => expect(read.mock.calls.filter(([operation]) => operation === 'usage.callers')).toHaveLength(1))
    fireEvent.click(screen.getByRole('tab', { name: 'Quota' }))
    expect(await screen.findByText('85%')).toBeTruthy()
  })
})
