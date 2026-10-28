import { expect, it, vi } from 'vitest'

import type { AppClientUiBridge } from '../../shared/appClientUiIpc'

import { WorkflowPortsOf } from './workflowPorts'

// UA1-J12-3: an approval whose answer the channel lost kept "Committing" beside a bare timeout.
it('names an approval the channel left unanswered by what the source proved before the connection was lost', () => {
  const lost = (accepted: boolean) => ({ ok: false as const, error: 'Remote session view request timed out', channelLost: { computer: 'Peer PC', accepted } })
  expect(WorkflowPortsOf.reviewResult(lost(true))).toEqual({ kind: 'refused',
    sentence: 'The source accepted the approval; the outcome is unknown until the connection to Peer PC returns.' })
  expect(WorkflowPortsOf.reviewResult(lost(false))).toEqual({ kind: 'refused',
    sentence: 'No answer from Peer PC: the connection is lost, so whether the source accepted the approval is unknown until it returns.' })
  expect(WorkflowPortsOf.reviewResult({ ok: false, error: 'Shared Finish approval is unsupported by this peer' }))
    .toEqual({ kind: 'refused', sentence: 'Shared Finish approval is unsupported by this peer' })
})

// The worker-lost wait named Resume and offered no such press (UA1-J14R-3): Resume worker is the row's
// Resume session, the reopen and then the reattach of every panel that holds the session.
it('resumes the worker as the Resume session of the row does, and names a refused reopen', async () => {
  const call = vi.fn(async (operation: string, body: unknown) => ({ ok: true as const, value: { ok: true as const, value: { operation, body } } }))
  const publishTerminalRestarted = vi.fn(async () => ({ ok: true as const, value: undefined }))
  Object.defineProperty(window, 'appClient', { configurable: true, value: { control: { call }, tabs: { publishTerminalRestarted } } as unknown as AppClientUiBridge })
  const action = { id: 'resume-worker' as const, label: 'Resume worker', primary: true, command: { operation: 'sessions.reopen' as const, body: {} } }
  expect(await WorkflowPortsOf.press('w1', action, {})).toEqual({ kind: 'done' })
  expect(call).toHaveBeenCalledWith('sessions.reopen', { session: { kind: 'sessionId', sessionId: 'w1' } })
  expect(publishTerminalRestarted).toHaveBeenCalledWith('w1')
  call.mockImplementationOnce(async () => ({ ok: true as const, value: { ok: false as const, error: { code: 'invalid-spec', detail: 'cannot be reopened',
    data: { sourceCode: 'invalid-spec' } } } }) as never)
  publishTerminalRestarted.mockClear()
  expect(await WorkflowPortsOf.press('w1', action, {})).toMatchObject({ kind: 'refused', sentence: expect.stringContaining('cannot be reopened') })
  expect(publishTerminalRestarted).not.toHaveBeenCalled()
})
