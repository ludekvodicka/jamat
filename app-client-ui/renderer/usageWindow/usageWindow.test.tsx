import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsageWindow } from './usageWindow'

vi.mock('./poolGraph', () => ({ PoolGraph: () => <div>Pool graph</div> }))
vi.mock('./tokensSection', () => ({ TokensSection: () => <section>Tokens</section> }))
vi.mock('../ipc/appControl', () => ({ AppControl: { value: async () => ({ ok: true, value: {
  capturedAt: 1, pools: [{ agentId: 'claude', weeklyRemaining: 155, weeklyCapacity: 200, sessionRemaining: 0, sessionCapacity: 200, weeklyKnown: 2, sessionKnown: 0 }],
  accounts: [{ key: { agentId: 'claude', accountId: 'work' }, label: 'Work', enabled: true, accountState: 'active', source: 'poll',
    state: { kind: 'stale', windows: [], fetchedAt: 1, reason: 'old' }, estimated: { estimated: true, ageMilliseconds: 7_200_000, sampleAt: 1,
      windows: [{ durationMinutes: 10080, usedPercent: 45, resetsAt: '2026-10-29T12:00:00Z' }] } }],
} }) } }))
describe('UsageWindow', () => {
  afterEach(cleanup)
  it('renders the pool, account estimate and explicitly unknown missing readings', async () => {
    Object.defineProperty(window, 'appClient', { configurable: true, value: { onUsageChanged: () => () => undefined } })
    render(<UsageWindow />)
    expect(await screen.findByText('155% of 200%')).toBeTruthy()
    expect(screen.getByText('Work')).toBeTruthy()
    expect(screen.getByText(/estimate from 2h ago/)).toBeTruthy()
    expect(screen.getByText(/Missing readings are unknown/)).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'Work weekly used' })).toHaveAttribute('value', '45')
  })
})
