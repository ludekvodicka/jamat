import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowPorts } from '../workflow/workflowPane'
import { WorktreeValidation } from './worktreeValidation'

afterEach(cleanup)

describe('Worktree validation', () => {
  it('starts the requested command in the prepared worktree without treating start as approval', async () => {
    const requestRun = vi.fn(async () => null)
    render(<WorktreeValidation value={{ cwd: 'Q:/app/.worktrees/001', checks: 'none', canRun: true }} ports={{ requestRun } as unknown as WorkflowPorts} />)
    expect(screen.getByText(/No automated checks are configured/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Application command'), { target: { value: 'pnpm dev' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run in worktree' }))
    await waitFor(() => expect(requestRun).toHaveBeenCalledExactlyOnceWith('pnpm dev', 'Q:/app/.worktrees/001'))
    expect(screen.queryByRole('button', { name: /Publish/ })).toBeNull()
    expect(await screen.findByRole('status')).toHaveTextContent('Started')
  })

  it.each(['pending', 'passed', 'overridden'] as const)('explains %s checks and offers no unsupported peer shell command', (checks) => {
    render(<WorktreeValidation value={{ cwd: 'Q:/wt', checks, canRun: true }} ports={{} as WorkflowPorts} />)
    expect(screen.queryByLabelText('Application command')).toBeNull()
    expect(screen.getByText('Run the application from a terminal on the source computer.')).toBeTruthy()
  })

  it('shows the exact refused run result and preserves the command for correction', async () => {
    render(<WorktreeValidation value={{ cwd: 'Q:/wt', checks: 'pending', canRun: true, environmentInputs: ['package.json'] }}
      ports={{ requestRun: async () => 'Host unavailable' } as unknown as WorkflowPorts} />)
    fireEvent.change(screen.getByLabelText('Application command'), { target: { value: 'pnpm install' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run in worktree' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Host unavailable')
    expect(screen.getByLabelText('Application command')).toHaveValue('pnpm install')
  })

  it('keeps the typed command when the review remounts it, as Recheck does', () => {
    const ports = { requestRun: async () => null } as unknown as WorkflowPorts
    const first = render(<WorktreeValidation value={{ cwd: 'Q:/wt-keep', checks: 'passed', canRun: true }} ports={ports} />)
    fireEvent.change(screen.getByLabelText('Application command'), { target: { value: 'node server.js 47301' } })
    first.unmount()
    render(<WorktreeValidation value={{ cwd: 'Q:/wt-keep', checks: 'passed', canRun: true }} ports={ports} />)
    expect(screen.getByLabelText('Application command')).toHaveValue('node server.js 47301')
  })

  it('shows each live run with a Stop that presses the stop of that run, and its refusal', async () => {
    const stop = { id: 'stop-run' as const, label: 'Stop', primary: false, runId: 'v1' }
    const press = vi.fn<WorkflowPorts['press']>(async () => ({ kind: 'refused' as const, sentence: 'Stop failed: Host unavailable' }))
    render(<WorktreeValidation value={{ cwd: 'Q:/wt', checks: 'passed', canRun: true, runs: [{ runId: 'v1', title: 'Worktree validation', startedAt: 5, stop }] }}
      ports={{ requestRun: async () => null, press } as unknown as WorkflowPorts} />)
    expect(screen.getByRole('list', { name: 'Running in this worktree' })).toHaveTextContent('Worktree validation is running')
    fireEvent.click(screen.getByRole('button', { name: 'Stop Worktree validation' }))
    await waitFor(() => expect(press).toHaveBeenCalledExactlyOnceWith(stop, {}))
    expect(await screen.findByRole('alert')).toHaveTextContent('Stop failed: Host unavailable')
  })
})
