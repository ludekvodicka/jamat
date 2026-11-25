import { describe, expect, it, vi } from 'vitest'
import type { SessionInfo, SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SnapinsPorts } from './snapinsPorts'

describe('SnapinsPorts', () => {
  it('writes the automation state and the note and adapts their refusals', async () => {
    type Sessions = Parameters<typeof SnapinsPorts.presentation>[0]['sessions']
    const setAutomationState = vi.fn<Sessions['setAutomationState']>().mockResolvedValue({ ok: true, value: { changed: true } })
    const setSessionDetails = vi.fn<Sessions['setSessionDetails']>()
      .mockResolvedValue({ ok: false, code: 'not-found', detail: 'gone' })
    const port = SnapinsPorts.presentation({ sessions: { setAutomationState, setSessionDetails } })
    expect(Object.keys(port).sort()).toEqual(['setNote', 'setState'])
    expect(await port.setState('worker', 'waiting')).toBe('ok')
    expect(setAutomationState).toHaveBeenCalledWith('worker', 'waiting')
    setAutomationState.mockResolvedValueOnce({ ok: true, value: { changed: false } })
    expect(await port.setState('worker', 'waiting')).toBe('ok')
    setAutomationState.mockResolvedValueOnce({ ok: false, code: 'not-found', detail: 'gone' })
    expect(await port.setState('missing', 'blocked')).toBe('missing-session')
    setAutomationState.mockResolvedValueOnce({ ok: false, code: 'invalid-spec', detail: 'records latched' })
    expect(await port.setState('worker', 'completed')).toBe('failed')
    expect(await port.setNote('worker', 'Working')).toBe('missing-session')
    expect(setSessionDetails).toHaveBeenCalledWith('worker', { note: 'Working' })
  })
  it('opens a known session by its tab title and preserves broker refusals', async () => {
    const snapshot: SessionsSnapshot = { revision: 0, reconciled: true, categories: [], orphans: [],
      sessions: [{ sessionId: 'worker', tabTitle: 'r900: Todo' } as SessionInfo],
      host: { presence: 'running', hostVersion: null, hostInstanceId: null, liveCount: 1, lastStartError: null } }
    const open = vi.fn<Parameters<typeof SnapinsPorts.of>[0]['tabs']['openTab']>()
      .mockResolvedValue({ ok: true, value: { kind: 'opened', panelId: 'worker', windowId: 'main' } } as Awaited<ReturnType<Parameters<typeof SnapinsPorts.of>[0]['tabs']['openTab']>>)
    const ports = SnapinsPorts.of({ sessions: { snapshot: () => snapshot,
      createSession: async () => ({ ok: true, value: { sessionId: 'worker', tabTitle: 'r900' } }),
      worktreeResults: async () => ({ ok: true, value: { results: [] } }),
      acknowledgeWorktreeResult: async (actionId) => ({ ok: true, value: { actionId } }) },
      svn: { urlOf: async () => ({ ok: true, value: 'file:///test' }), listAtHead: async () => ({ ok: true, value: [] }),
        changedNames: async () => ({ ok: true, value: [] }) },
      projects: { listCategories: async () => [], listProjects: async () => { throw new Error('unexpected') } },
      tabs: { openTab: open }, versioningMode: () => 'checkpoints' })
    expect(await ports.sessions.openTerminal('missing')).toBe('missing-session')
    expect(open).not.toHaveBeenCalled()
    expect(await ports.sessions.openTerminal('worker')).toBe('ok')
    expect(open).toHaveBeenCalledWith('worker', 'r900: Todo', { activate: true })
    open.mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', detail: 'window gone' } })
    expect(await ports.sessions.openTerminal('worker')).toEqual({ error: 'window gone' })
    open.mockRejectedValueOnce(new Error('IPC failed'))
    expect(await ports.sessions.openTerminal('worker')).toEqual({ error: 'IPC failed' })
  })
})
