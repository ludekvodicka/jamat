import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsagePanel } from './usagePanel'

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./tokensSection', () => ({ TokensSection: () => <section>Tokens</section> }))
vi.mock('./usageChart', () => ({ usageChartTheme: () => ({ text: '', grid: '', accent: '' }),
  UsageChart: ({ label }: { label: string }) => <div role="img" aria-label={label} /> }))
vi.mock('../ipc/appControl', () => ({ AppControl: { value: read } }))

const now = Date.parse('2026-11-04T18:00:00Z')
const hour = 3_600_000
const snapshot = {
  capturedAt: now,
  pools: [
    { agentId: 'claude', weeklyRemaining: 155, weeklyCapacity: 200, sessionRemaining: 0, sessionCapacity: 200, weeklyKnown: 2, sessionKnown: 0 },
    { agentId: 'codex', weeklyRemaining: 0, weeklyCapacity: 0, sessionRemaining: 0, sessionCapacity: 0, weeklyKnown: 0, sessionKnown: 0 },
  ],
  accounts: [
    { key: { agentId: 'claude', accountId: 'work' }, label: 'Work', enabled: true, accountState: 'active', source: 'poll',
      state: { kind: 'stale', windows: [], fetchedAt: 1, reason: 'old' }, estimated: { estimated: true, ageMilliseconds: 2 * hour, sampleAt: 1,
        windows: [{ durationMinutes: 10080, usedPercent: 45, resetsAt: '2026-11-08T15:00:00Z' }] } },
    { key: { agentId: 'claude', accountId: 'main' }, label: 'Main', enabled: true, accountState: 'active', source: 'poll', estimated: null,
      state: { kind: 'ok', fetchedAt: 1, windows: [{ durationMinutes: 10080, usedPercent: 0, resetsAt: null }] } },
  ],
}
const series = { recorded: [{ at: now - hour, remaining: 160 }], projected: [{ at: now, remaining: 155 }], burnPerHour: 0.7,
  poolEmptyAt: now + 46 * hour, firstEmpty: { accountId: 'work', at: now + 30 * hour }, nextReset: { accountId: 'main', at: now + 94 * hour, gain: 100 },
  now, until: now + 7 * 24 * hour, knownAccounts: 2, totalAccounts: 2 }

describe('UsagePanel', () => {
  beforeEach(() => {
    read.mockReset()
    read.mockImplementation(async (operation: string) => ({ ok: true, value: operation === 'usage.get' ? snapshot : series }))
    Object.defineProperty(window, 'appClient', { configurable: true, value: { onUsageChanged: () => () => undefined } })
  })
  afterEach(cleanup)

  it('draws the pool as figures, one row per account and no card for an agent without accounts', async () => {
    render(<UsagePanel />)
    expect(await screen.findByText('78%')).toBeTruthy()
    expect(screen.getByText('155 of 200%')).toBeTruthy()
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
})
