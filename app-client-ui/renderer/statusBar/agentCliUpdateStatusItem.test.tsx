import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentCliUpdatesSnapshot } from '../../../lib-orchestrator/agentCliUpdates/agentCliUpdatesApi.types'
import { AgentCliUpdateStatusItem, type AgentCliUpdatePorts } from './agentCliUpdateStatusItem'

function fixture() {
  let snapshot: AgentCliUpdatesSnapshot = { revision: 1, agents: [{
    id: 'codex', label: 'Codex', activity: 'idle', installedVersion: '1.0.0', latestVersion: '1.1.0',
    channel: 'latest', path: '/bin/codex', available: true, canUpdate: true, detail: null,
    error: null, output: '', checkedAt: 1000,
  }] }
  let changed: () => void = () => {}
  const ports: AgentCliUpdatePorts = {
    read: async () => ({ ok: true, value: snapshot }),
    subscribe: callback => { changed = callback; return () => { changed = () => {} } },
    reportError: vi.fn(), check: vi.fn(async () => ({ ok: true as const, value: undefined })),
    install: vi.fn(async () => ({ ok: true as const, value: undefined })),
  }
  return { ports, push: async (row: Partial<AgentCliUpdatesSnapshot['agents'][number]>) => {
    snapshot = { revision: snapshot.revision + 1, agents: [{ ...snapshot.agents[0], ...row }] }
    await act(async () => changed())
  } }
}

describe('AgentCliUpdateStatusItem', () => {
  it('opens a focused panel from the status bar and installs only the selected CLI on click', async () => {
    const { ports } = fixture()
    render(<AgentCliUpdateStatusItem ports={ports} />)
    const trigger = await screen.findByRole('button', { name: 'CLI: 1 update' })
    expect(ports.install).not.toHaveBeenCalled()
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Agent CLI updates' })
    expect(dialog).toHaveFocus()
    expect(dialog).toHaveTextContent('Installed: 1.0.0 · Available: 1.1.0')
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Update Codex' })))
    expect(ports.install).toHaveBeenCalledExactlyOnceWith('codex')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('shows live output, disables duplicate actions, and keeps failures visible for retry', async () => {
    const { ports, push } = fixture()
    render(<AgentCliUpdateStatusItem ports={ports} />)
    fireEvent.click(await screen.findByRole('button', { name: 'CLI: 1 update' }))
    await push({ activity: 'updating', output: 'Downloading…' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled()
    expect(screen.getByText('Downloading…')).toBeInTheDocument()
    await push({ activity: 'idle', error: 'Executable is locked' })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Executable is locked'))
    expect(screen.getByRole('button', { name: 'Update Codex' })).toBeEnabled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Check now' })))
    expect(ports.check).toHaveBeenCalledTimes(1)
  })
})
