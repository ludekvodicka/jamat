import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { VersioningCommitPhase } from '../../shared/versioningCommit'
import { CommitProgress } from './commitProgress'

describe('app-client-ui/renderer/versioning/commitProgress', () => {
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('shows a measured stage estimate, updates elapsed time, and withdraws a stalled estimate', () => {
    vi.useFakeTimers()
    vi.setSystemTime(20_000)
    const phase: Extract<VersioningCommitPhase, { kind: 'running' }> = {
      kind: 'running', startedAt: 1_000,
      progress: { stage: 'sending', completed: 25, total: 100, stageStartedAt: 10_000,
        updatedAt: 20_000, groupIndex: 2, groupCount: 3 },
    }
    const view = render(<CommitProgress phase={phase} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '25')
    expect(screen.getByText('About 30s left in this step')).toBeInTheDocument()
    expect(screen.getByText('1 / 3 repositories committed')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(11_000))
    expect(screen.getByText('Elapsed 30s')).toBeInTheDocument()
    expect(screen.queryByText(/left in this step/)).not.toBeInTheDocument()
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps file transmission and server confirmation indeterminate until the actual result', () => {
    const phase: Extract<VersioningCommitPhase, { kind: 'running' }> = {
      kind: 'running', startedAt: Date.now(),
      progress: { stage: 'transmitting', completed: 10, total: null, stageStartedAt: Date.now(),
        updatedAt: Date.now(), groupIndex: 1, groupCount: 1 },
    }
    const view = render(<CommitProgress phase={phase} />)
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('value')
    expect(screen.getByText('10 files transmitted')).toBeInTheDocument()
    view.rerender(<CommitProgress phase={{ ...phase, progress: { ...phase.progress!, stage: 'committing', completed: 0 } }} />)
    expect(screen.getByRole('progressbar', { name: 'Waiting for commit confirmation' })).not.toHaveAttribute('value')
    expect(screen.queryByText(/files transmitted/)).not.toBeInTheDocument()
  })
})
