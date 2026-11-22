import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TokensSection } from './tokensSection'

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../ipc/appControl', () => ({ AppControl: { value: read } }))
vi.mock('./usageChart', () => ({ usageChartTheme: () => ({ text: '', grid: '', accent: '', series: [] }),
  UsageChart: ({ label }: { label: string }) => <div role="img" aria-label={label} /> }))
describe('TokensSection', () => {
  beforeEach(() => {
    read.mockReset()
    Object.defineProperty(window, 'appClient', { configurable: true, value: { onUsageChanged: () => () => undefined } })
  })
  afterEach(cleanup)
  it('shows an empty period and sends a rescan only after the button is pressed', async () => {
    read.mockResolvedValue({ ok: true, value: { rows: [], progress: { running: false, completed: 2, total: 2, error: null, scannedAt: 1 } } })
    render(<TokensSection />)
    expect(await screen.findByText('No usage in this period')).toBeTruthy()
    expect(read).toHaveBeenCalledTimes(5)
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }))
    await waitFor(() => expect(read).toHaveBeenCalledWith('usage.rescan', {}))
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
    await waitFor(() => expect(read).toHaveBeenCalledWith('usage.tokens', expect.objectContaining({ agentId: 'codex', groupBy: 'project' })))
    fireEvent.click(screen.getByRole('button', { name: 'Antigravity' }))
    await waitFor(() => expect(read).toHaveBeenCalledWith('usage.tokens', expect.objectContaining({ agentId: 'antigravity', groupBy: 'session' })))
  })
  it('asks for both sources by default, then only the chosen source', async () => {
    read.mockResolvedValue({ ok: true, value: { rows: [], progress: { running: false, completed: 0, total: 0, error: null, scannedAt: 1 } } })
    render(<TokensSection />)
    await screen.findByText('No usage in this period')
    expect(read.mock.calls.every(([, query]) => !('origin' in query))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '3rd party' }))
    await waitFor(() => expect(read).toHaveBeenCalledWith('usage.tokens', expect.objectContaining({ origin: 'thirdParty', groupBy: 'project' })))
    fireEvent.click(screen.getByRole('button', { name: 'Jamat' }))
    await waitFor(() => expect(read).toHaveBeenCalledWith('usage.tokens', expect.objectContaining({ origin: 'jamat', groupBy: 'day' })))
  })
  it('asks for whole days of the chosen period', async () => {
    read.mockResolvedValue({ ok: true, value: { rows: [], progress: { running: false, completed: 0, total: 0, error: null, scannedAt: 1 } } })
    render(<TokensSection />)
    await screen.findByText('No usage in this period')
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    const today = new Date()
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    await waitFor(() => expect(read).toHaveBeenCalledWith('usage.tokens', expect.objectContaining({ from: day, to: day })))
    expect(screen.queryByLabelText('Period from')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    expect(screen.getByLabelText('Period from')).toBeTruthy()
  })
  it('keeps totals, charts, agent legend and project/account/session tables visible during a refresh', async () => {
    read.mockImplementation(async (_operation, query) => ({ ok: true, value: {
      rows: [
        {
          key: 'a',
          label: query.groupBy === 'project' ? 'Jamat' : query.groupBy === 'session' ? '147 - agy' : 'Main',
          agentId: 'antigravity',
          input: 10,
          output: 3,
          cacheRead: 5_000,
          cacheWrite: 2,
        },
        ...(query.groupBy === 'day' ? [{ key: 'b', label: 'Main', agentId: 'claude', input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }] : []),
      ],
      progress: { running: true, completed: 3, total: 9, error: null, scannedAt: 1 },
    } }))
    render(<TokensSection />)
    expect(await screen.findByText('Jamat')).toBeTruthy()
    expect(screen.getByText('147 - agy')).toBeTruthy()
    expect(screen.getByLabelText('Agents in charts')).toBeTruthy()
    expect(screen.getByText(/3 \/ 9 files/)).toBeTruthy()
    expect(screen.getAllByText('5.0k').length).toBeGreaterThan(0)
    expect(screen.getByRole('img', { name: 'Token usage per day' })).toBeTruthy()
    expect(screen.getByRole('img', { name: /local time/ })).toBeTruthy()
    expect(screen.getAllByRole('table')).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Rescan' })).toBeDisabled()
  })
})
