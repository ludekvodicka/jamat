import { describe, expect, it, vi } from 'vitest'
import type { SessionInfo, SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SnapinsPorts } from './snapinsPorts'

describe('SnapinsPorts', () => {
  it('ensures default automation groups and adapts assignment and note refusals', async () => {
    const ensure = vi.fn<Parameters<typeof SnapinsPorts.presentation>[0]['groupsOperations']['ensure']>(() => ({ ok: true as const }))
    const assign = vi.fn<Parameters<typeof SnapinsPorts.presentation>[0]['groups']['assign']>(() => ({ ok: true, value: { group: 'waiting' } }))
    const setSessionDetails = vi.fn<Parameters<typeof SnapinsPorts.presentation>[0]['sessions']['setSessionDetails']>()
      .mockResolvedValue({ ok: false, code: 'not-found', detail: 'gone' })
    const port = SnapinsPorts.presentation({ groups: { assign }, groupsOperations: { ensure }, sessions: {
      snapshot: () => ({ sessions: [{ sessionId: 'worker' }] } as SessionsSnapshot), setSessionDetails } })
    expect(await port.ensureGroups()).toBe(true)
    expect(ensure.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([{ id: 'waiting', title: 'Waiting' }, { id: 'automation', title: 'Automation' }]))
    expect(port.assign('missing', 'waiting')).toBe('missing-session')
    expect(port.assign('worker', 'waiting')).toBe('ok')
    assign.mockReturnValueOnce({ ok: false, error: { code: 'invalid-request', detail: 'gone group' } })
    expect(port.assign('worker', 'waiting')).toBe('missing-group')
    expect(await port.setNote('worker', 'Working')).toBe('missing-session')
    expect(setSessionDetails).toHaveBeenCalledWith('worker', { note: 'Working' })
  })
  it('opens a known session by its tab title and preserves broker refusals', async () => {
    const snapshot: SessionsSnapshot = { revision: 0, reconciled: true, categories: [], orphans: [],
      sessions: [{ sessionId: 'worker', tabTitle: 'r900: Todo' } as SessionInfo],
      host: { presence: 'running', hostVersion: null, hostInstanceId: null, liveCount: 1, lastStartError: null } }
    const open = vi.fn<Parameters<typeof SnapinsPorts.of>[0]['tabs']['open']>()
      .mockResolvedValue({ ok: true, value: { kind: 'opened', panelId: 'worker', windowId: 'main' } } as Awaited<ReturnType<Parameters<typeof SnapinsPorts.of>[0]['tabs']['open']>>)
    const ports = SnapinsPorts.of({ sessions: { snapshot: () => snapshot,
      createSession: async () => ({ ok: true, value: { sessionId: 'worker', tabTitle: 'r900' } }),
      worktreeResults: async () => ({ ok: true, value: { results: [] } }),
      acknowledgeWorktreeResult: async (actionId) => ({ ok: true, value: { actionId } }) },
      svn: { urlOf: async () => ({ ok: true, value: 'file:///test' }), listAtHead: async () => ({ ok: true, value: [] }),
        changedNames: async () => ({ ok: true, value: [] }) },
      projects: { listCategories: async () => [], listProjects: async () => { throw new Error('unexpected') } },
      tabs: { open }, versioningMode: () => 'checkpoints' })
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
