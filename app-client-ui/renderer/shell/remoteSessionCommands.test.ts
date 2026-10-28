import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteConnectionsSnapshot } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import { CommandRegistry } from '../commands/commandRegistry'
import { SessionsFixtures } from '../sessions/fixtures/sessionsFixtures'
import { RemoteSessionCommands } from './remoteSessionCommands'

describe('source session commands', () => {
  afterEach(() => { vi.restoreAllMocks(); delete (window as unknown as { appClient?: unknown }).appClient })

  function fixture() {
    const info = SessionsFixtures.mixed().sessions[0]
    const target = { kind: 'remote' as const, remoteEndpointId: 'source', sessionId: info.sessionId }
    const endpoint = { remoteEndpointId: 'source', displayName: 'Source PC', status: 'connected',
      sessions: { ...SessionsFixtures.mixed(), sessions: [info] }, workspaceCapabilities: ['session-workspace.commands'] }
    const snapshot = { revision: 1, inbound: [], outbound: [endpoint] } as unknown as RemoteConnectionsSnapshot
    const command = vi.fn(async () => ({ ok: true, value: { ok: true, value: { sessionId: info.sessionId } } }))
    const report = vi.spyOn(AppClientUiReport, 'error').mockImplementation(() => {})
    ;(window as unknown as { appClient: Partial<AppClientUiBridge> }).appClient = {
      remote: { sessionCommand: command,
        selectSession: vi.fn(async () => ({ ok: true, value: { ok: true } })),
        openView: vi.fn(async () => ({ ok: true, value: { ok: true, value: { viewId: 'details-view' } } })),
        readView: vi.fn(async () => ({ ok: true, value: { ok: true, value: { session: { ...info, note: 'Full source note' } } } })),
        closeView: vi.fn(async () => ({ ok: true })),
      } as unknown as AppClientUiBridge['remote'],
    }
    const ports = { active: () => target, snapshot: () => snapshot, details: vi.fn(), launch: vi.fn(),
      open: vi.fn(async () => {}), folder: vi.fn(), compact: vi.fn(), review: vi.fn(async () => {}) }
    const dispatcher = new RemoteSessionCommands(ports)
    const commands = new CommandRegistry((id, arg) => dispatcher.dispatch(id, arg))
    const local = vi.fn()
    commands.register('session.details', local)
    commands.register('session.setColor', local)
    commands.register('session.compact', local)
    return { info, target, endpoint, commands, ports, local, report, command }
  }

  it('keeps identical local and source IDs separate for explicit and active targets', async () => {
    const f = fixture()
    f.commands.execute('session.details', { sessionId: f.info.sessionId })
    expect(f.local).toHaveBeenCalledOnce()
    f.commands.execute('session.details', { sessionId: f.info.sessionId, remoteEndpointId: 'source' })
    await vi.waitFor(() => expect(f.ports.details).toHaveBeenCalledWith(f.target, expect.objectContaining({ note: 'Full source note' })))
    f.commands.execute('session.compact')
    expect(f.ports.compact).toHaveBeenCalledWith(f.target)
    expect(f.local).toHaveBeenCalledOnce()
    f.commands.execute('session.setColor', { sessionId: f.info.sessionId, remoteEndpointId: 'source', color: null })
    await vi.waitFor(() => expect(f.command).toHaveBeenCalledOnce())
    expect(f.command.mock.calls[0]).toEqual(['source', expect.objectContaining({ operation: 'sessions.color', body: {
      session: { kind: 'sessionId', sessionId: f.info.sessionId }, color: null } })])
  })

  it('refuses disconnected and old sources without invoking the local handler', async () => {
    const f = fixture()
    f.endpoint.status = 'disconnected'
    f.commands.execute('session.details')
    await vi.waitFor(() => expect(f.report).toHaveBeenCalledWith(expect.stringContaining('disconnected')))
    f.endpoint.status = 'connected'; f.endpoint.workspaceCapabilities = []
    f.commands.execute('session.details')
    await vi.waitFor(() => expect(f.report).toHaveBeenCalledWith(expect.stringContaining('update that computer')))
    expect(f.local).not.toHaveBeenCalled()
    expect(f.ports.details).not.toHaveBeenCalled()
  })

  it('reuses the accepted operation identity after a lost response', async () => {
    const f = fixture()
    f.command.mockResolvedValueOnce({ ok: false, error: 'Connection lost' } as never)
    const args = { sessionId: f.info.sessionId, remoteEndpointId: 'source', color: null }
    f.commands.execute('session.setColor', args)
    await vi.waitFor(() => expect(f.report).toHaveBeenCalled())
    f.commands.execute('session.setColor', args)
    await vi.waitFor(() => expect(f.command).toHaveBeenCalledTimes(2))
    expect(f.command.mock.calls[1]).toEqual(f.command.mock.calls[0])
    expect(f.local).not.toHaveBeenCalled()
  })
})
