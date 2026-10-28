import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TokensSection } from './tokensSection'

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../ipc/appControl', () => ({ AppControl: { value: read } }))
vi.mock('./usageChart', () => ({ usageChartTheme: () => ({ text: '', grid: '', accent: '' }),
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
    expect(read).toHaveBeenCalledTimes(4)
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }))
    await waitFor(() => expect(read).toHaveBeenCalledWith('usage.rescan', {}))
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'codex' } })
    await waitFor(() => expect(read).toHaveBeenCalledWith('usage.tokens', expect.objectContaining({ agentId: 'codex', groupBy: 'project' })))
  })
  it('keeps charts and project/account tables visible during a refresh', async () => {
    read.mockImplementation(async (_operation, query) => ({ ok: true, value: {
      rows: [{ key: 'a', label: query.groupBy === 'project' ? 'Jamat' : 'Main', agentId: 'claude', input: 10, output: 3, cacheRead: 5, cacheWrite: 2 }],
      progress: { running: true, completed: 3, total: 9, error: null, scannedAt: 1 },
    } }))
    render(<TokensSection />)
    expect(await screen.findByText('Jamat')).toBeTruthy()
    expect(screen.getByText(/3 \/ 9 files/)).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Token usage per day' })).toBeTruthy()
    expect(screen.getByRole('img', { name: /local time/ })).toBeTruthy()
    expect(screen.getAllByRole('table')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Rescan' })).toBeDisabled()
  })
})
