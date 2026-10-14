import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionLiveBrief } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { UpdateMainAsks, UpdateMainOverlay, type UpdateMainPorts } from './updateMainOverlay'

describe('app-client-ui/renderer/overlays/updateMain/updateMainOverlay', () => {
  afterEach(() => cleanup())

  const coordinator: SessionLiveBrief = { sessionId: 's-coordinator', title: '020 - coordinator', number: '020' }
  const late: SessionLiveBrief = { sessionId: 's-late', title: 'late shell', number: null }

  it('names the live sessions, asks again with exactly them, and shows a session started meanwhile', async () => {
    const calls: (readonly string[] | undefined)[] = []
    const started: string[] = []
    const ports: UpdateMainPorts = {
      started: (sessionId) => { started.push(sessionId) },
      updateMain: async (_sessionId, confirmLive) => {
        calls.push(confirmLive)
        return calls.length === 1
          ? { ok: true, value: { ok: false, code: 'live-sessions', detail: 'two now', liveSessions: [coordinator, late] } }
          : { ok: true, value: { ok: true, value: { sessionId: 's-landed', actionId: 'update-1' } } }
      },
    }
    const onClose = vi.fn()
    const view = render(<UpdateMainOverlay
      request={{ requestId: 1, ask: { sessionId: 's-landed', sessionTitle: '016 - landed', live: [coordinator] } }}
      ports={ports}
      onClose={onClose}
    />)
    expect(view.container.querySelector('.jamat-update-main__live')?.textContent).toBe('020020 - coordinator')

    fireEvent.click(view.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('changed; confirm the list again'))
    expect(view.container.querySelector('.jamat-update-main__live')?.textContent).toBe('020020 - coordinatorlate shell')
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(view.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(calls).toEqual([['s-coordinator'], ['s-coordinator', 's-late']])
    // The UPDATE this window started brings its session's workflow forward, once.
    expect(started).toEqual(['s-landed'])
  })

  it('shows any other refusal and closes on Cancel or Escape', async () => {
    const started: string[] = []
    const ports: UpdateMainPorts = {
      started: (sessionId) => { started.push(sessionId) },
      updateMain: async () => ({ ok: true, value: { ok: false, code: 'merge-pending', detail: 'An UPDATE of C:/w runs' } }),
    }
    const onClose = vi.fn()
    const view = render(<UpdateMainOverlay
      request={{ requestId: 1, ask: { sessionId: 's-landed', sessionTitle: '016 - landed', live: [coordinator] } }}
      ports={ports}
      onClose={onClose}
    />)

    fireEvent.click(view.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('Update main copy failed: merge-pending: An UPDATE of C:/w runs'))
    fireEvent.keyDown(view.getByRole('dialog'), { key: 'Escape' })
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(started).toEqual([])
  })

  it('reads the live sessions off a live-sessions refusal and nothing else', () => {
    expect(UpdateMainAsks.liveOf({ ok: true, value: { ok: false, code: 'live-sessions', detail: 'x', liveSessions: [late] } })).toEqual([late])
    expect(UpdateMainAsks.liveOf({ ok: true, value: { ok: false, code: 'live-sessions', detail: 'x' } })).toEqual([])
    expect(UpdateMainAsks.liveOf({ ok: true, value: { ok: false, code: 'merge-pending', detail: 'x' } })).toBeNull()
    expect(UpdateMainAsks.liveOf({ ok: true, value: { ok: true, value: undefined } })).toBeNull()
    expect(UpdateMainAsks.liveOf({ ok: false, error: 'channel' })).toBeNull()
  })
})
