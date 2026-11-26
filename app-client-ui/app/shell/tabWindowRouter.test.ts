import { describe, expect, it, vi } from 'vitest'
import type { TabControlCommand } from '../../../lib-orchestrator/shared/tabRequestPort.types'
import { WorkspacePanelIndex } from '../tabs/workspacePanelIndex'
import type { WorkspaceWindows } from './workspaceWindows'
import { TabWindowRouter } from './tabWindowRouter'

function fixture() {
  let ready!: () => void
  const waiting = new Promise<void>(resolve => { ready = resolve })
  const focus = vi.fn(), publish = vi.fn()
  const acceptsWindow = vi.fn(() => true)
  const router = new TabWindowRouter({ focusOrRecreate: focus, publishTo: publish, acceptsWindow,
    whenRendererReady: () => waiting } as unknown as WorkspaceWindows, new WorkspacePanelIndex())
  return { router, ready, focus, publish, acceptsWindow }
}

describe('TabWindowRouter', () => {
  const command: TabControlCommand = { kind: 'open-session', requestId: 'request', sessionId: 'session', tabTitle: 'Session' }

  it('registers focus and pending work together so reload cancels before readiness', async () => {
    const rig = fixture()
    const pending = rig.router.request('main', command)
    expect(rig.focus).toHaveBeenCalledExactlyOnceWith('main')
    rig.router.rendererGone('main')
    expect(await pending).toEqual({ ok: false, error: { code: 'unavailable', detail: 'The workspace renderer was reloaded' } })
    rig.ready()
    await Promise.resolve()
    expect(rig.publish).not.toHaveBeenCalled()
    rig.router.cancelAll()
  })

  it('refuses a closing window after readiness and a foreign acknowledgement', async () => {
    const rig = fixture()
    const pending = rig.router.request('main', command)
    expect(() => rig.router.acknowledge('other', { requestId: command.requestId, result: { kind: 'opened', panelId: 'panel' } }))
      .toThrow('wrong window')
    rig.acceptsWindow.mockReturnValue(false)
    rig.ready()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(rig.publish).not.toHaveBeenCalled()
    rig.router.cancelAll()
  })

  it('cancels pending requests on shutdown and never focuses subsequent requests', async () => {
    const rig = fixture()
    const pending = rig.router.request('main', { ...command, activate: false })
    rig.router.cancelAll()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(await rig.router.request('main', command)).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    rig.ready()
    await Promise.resolve()
    expect(rig.focus).not.toHaveBeenCalled()
    expect(rig.publish).not.toHaveBeenCalled()
  })

  it('accepts a processes-opened acknowledgement and refuses a mismatched one', async () => {
    const rig = fixture()
    rig.ready()
    const openProcesses: Extract<TabControlCommand, { kind: 'open-processes' }> = {
      kind: 'open-processes', requestId: 'req-proc', panelId: 'terminal:s1', sessionId: 's1',
    }
    const pending = rig.router.request('main', openProcesses)
    expect(rig.focus).toHaveBeenCalledExactlyOnceWith('main')
    rig.router.acknowledge('main', { requestId: 'req-proc', result: { kind: 'processes-opened', panelId: 'terminal:s1' } })
    expect(await pending).toEqual({ ok: true, value: { kind: 'processes-opened', panelId: 'terminal:s1', windowId: 'main' } })

    const mismatch = rig.router.request('main', { ...openProcesses, requestId: 'req-mismatch' })
    rig.router.acknowledge('main', { requestId: 'req-mismatch', result: { kind: 'todos-opened', panelId: 'terminal:s1' } })
    expect(await mismatch).toEqual({ ok: false, error: { code: 'operation-failed', detail: 'The workspace renderer returned an invalid tab result' } })

    const wrongPanel = rig.router.request('main', { ...openProcesses, requestId: 'req-wrong-panel' })
    rig.router.acknowledge('main', { requestId: 'req-wrong-panel', result: { kind: 'processes-opened', panelId: 'terminal:other' } })
    expect(await wrongPanel).toEqual({ ok: false, error: { code: 'operation-failed', detail: 'The workspace renderer returned an invalid tab result' } })
    rig.router.cancelAll()
  })
})
