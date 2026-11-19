import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallersTab } from './callersTab'

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../ipc/appControl', () => ({ AppControl: { value: read } }))

const now = Date.parse('2026-11-19T12:00:00Z')
const minute = 60_000
const view = {
  capturedAt: now, windowDays: 30, command: null,
  callers: [
    { caller: 'assistant', lastAt: now - 5 * minute, calls: 4, fallbacks: 1, purposes: { interactive: 3, background: 1 },
      accounts: [{ accountId: 'work', label: 'Work', calls: 3 }, { accountId: 'main', label: 'Main', calls: 1 }] },
    { caller: 'indexer', lastAt: now - 90 * minute, calls: 2, fallbacks: 0, purposes: { interactive: 0, background: 2 },
      accounts: [{ accountId: 'work', label: 'Work', calls: 2 }] },
  ],
  recent: [
    { at: now - 5 * minute, caller: 'assistant', purpose: 'interactive', accountId: 'main', accountLabel: 'Main', fallback: true,
      reason: 'no-eligible-account', durationMs: 31 },
    { at: now - 6 * minute, caller: 'assistant', purpose: 'interactive', accountId: 'work', accountLabel: 'Work', fallback: false,
      reason: 'chosen', durationMs: 840 },
  ],
}
const empty = { ...view, callers: [], recent: [] }
const note = /Calls that did not reach this Jamat are not listed/

const command = 'node "C:/Users/Jane Doe/.claude/skills/appjamat-v3/scripts/jamat-v3.mjs" --config-identity id-1 --channel development accounts pick --caller {caller} --purpose {purpose}'
const { writeText } = vi.hoisted(() => ({ writeText: vi.fn() }))

let callersChanged: (() => void) | null = null
let usageChanged: (() => void) | null = null

describe('CallersTab', () => {
  beforeEach(() => {
    read.mockReset()
    writeText.mockReset()
    callersChanged = null
    usageChanged = null
    Object.defineProperty(window, 'appClient', { configurable: true, value: {
      onUsageCallersChanged: (listener: () => void) => { callersChanged = listener; return () => { callersChanged = null } },
      onUsageChanged: (listener: () => void) => { usageChanged = listener; return () => { usageChanged = null } },
      clipboard: { writeText },
    } })
  })
  afterEach(cleanup)

  it('says it is reading, then draws one row per caller with its figures', async () => {
    read.mockResolvedValue({ ok: true, value: view })
    render(<CallersTab />)
    expect(screen.getByRole('status')).toHaveTextContent('Reading callers…')
    const table = await screen.findByRole('table', { name: 'Callers by last call' })
    const rows = within(table).getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell').map(cell => cell.textContent))
    expect(rows).toEqual([
      ['assistant', '5m ago', '4', '1', 'interactive 3 · background 1', 'Work 3 · Main 1'],
      ['indexer', '1h 30m ago', '2', '0', 'interactive 0 · background 2', 'Work 2'],
    ])
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith('usage.callers', {})
    expect(screen.getByText(note)).toBeTruthy()
  })

  it('shows the reason of a fallback call in the recent list', async () => {
    read.mockResolvedValue({ ok: true, value: view })
    render(<CallersTab />)
    const recent = await screen.findByRole('table', { name: 'Recent calls' })
    expect(within(recent).getByText('Fallback: no-eligible-account')).toBeTruthy()
    expect(within(recent).getByText('Chosen')).toBeTruthy()
    expect(within(recent).getByText('840 ms')).toBeTruthy()
  })

  it('says how a caller appears when nobody asked, and keeps the note', async () => {
    read.mockResolvedValue({ ok: true, value: empty })
    render(<CallersTab />)
    expect(await screen.findByText(/No caller asked the account broker in the last 30 days/)).toHaveTextContent('accounts pick')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText(note)).toBeTruthy()
  })

  it('shows a failed read as an alert', async () => {
    read.mockResolvedValue({ ok: false, error: 'control endpoint is unavailable' })
    render(<CallersTab />)
    expect(await screen.findByRole('alert')).toHaveTextContent('control endpoint is unavailable')
    expect(screen.getByText(note)).toBeTruthy()
  })

  it('reads again on usage:callers-changed and not on usage:changed', async () => {
    read.mockResolvedValueOnce({ ok: true, value: empty }).mockResolvedValue({ ok: true, value: view })
    render(<CallersTab />)
    await screen.findByText(/No caller asked/)
    expect(usageChanged).toBeNull()
    expect(callersChanged).not.toBeNull()
    act(() => callersChanged!())
    expect(await screen.findByText('indexer')).toBeTruthy()
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  })

  it('shows the broker command of this instance and copies the exact line', async () => {
    read.mockResolvedValue({ ok: true, value: { ...view, command } })
    writeText.mockResolvedValue({ ok: true, value: undefined })
    render(<CallersTab />)
    expect(await screen.findByText(command)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByText('Copied')).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith(command)
  })

  it('shows the error text when the clipboard refuses the write', async () => {
    read.mockResolvedValue({ ok: true, value: { ...empty, command } })
    writeText.mockResolvedValue({ ok: false, error: 'clipboard is busy' })
    render(<CallersTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Copying the broker command failed: clipboard is busy')
    expect(screen.queryByText('Copied')).toBeNull()
  })

  it('says that the skill link is missing when there is no command', async () => {
    read.mockResolvedValue({ ok: true, value: view })
    render(<CallersTab />)
    expect(await screen.findByText(/The Jamat CLI skill link is missing/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
  })
})
