import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteConnectionsSnapshot } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteTaskRequest } from '../../../lib-orchestrator/remoteControl/remoteTaskApi.types'
import { TerminalTargetCodec } from '../../shared/terminalTarget'
import { SnapshotStore } from '../ipc/snapshotStore'
import { SessionsFixtures } from './fixtures/sessionsFixtures'
import { RemoteSessionTasksStore } from './remoteSessionTasksStore'

function fixture() {
  let epoch = 'one', connected = true, revision = 1
  const session = { ...SessionsFixtures.mixed().sessions[0], sessionId: 'session', life: 'live' as const, activity: 'working' as const }
  const remote = new SnapshotStore<RemoteConnectionsSnapshot>('remote', { read: async () => ({ ok: true, value: { revision, inbound: [],
    outbound: ['first', 'second'].map((remoteEndpointId) => ({ remoteEndpointId, connectionId: connected ? epoch : null, status: connected ? 'connected' : 'disconnected',
      workspaceCapabilities: ['session-workspace.views', 'session-workspace.tasks'], sessions: { ...SessionsFixtures.mixed(), sessions: [session] } })),
  } as unknown as RemoteConnectionsSnapshot }), subscribe: () => () => {}, reportError: vi.fn() })
  const requestTasks = vi.fn(async (endpoint: string, _view: string, request: RemoteTaskRequest) => {
    const value = { sessionId: 'session', request, result: { ok: true, value: { listing: { kind: 'tasks', olderFinished: 0, catchingUp: false,
      rows: [{ kind: 'shell', shellId: 'same', command: `${endpoint}:${epoch}`, description: null, state: 'running', startedAt: 1, endedAt: null }] }, scripts: null } } }
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    return { ok: true, value: { ok: true, value: { transferId: 'transfer', version: 'version', offset: 0, totalBytes: bytes.length, base64: btoa(String.fromCharCode(...bytes)) } } }
  })
  const closeView = vi.fn(async () => ({ ok: true, value: { ok: true, value: null } }))
  vi.stubGlobal('appClient', { fileChanges: {}, fileViewer: {}, versioning: {}, remote: { requestTasks, closeView,
    openView: async () => ({ ok: true, value: { ok: true, value: { sessionId: 'session', viewId: 'same', viewerId: 'viewer', epoch } } }),
  } })
  const store = new RemoteSessionTasksStore(remote)
  return { remote, store, requestTasks, closeView,
    change: (online: boolean) => { connected = online; epoch = 'two'; revision++; remote.refresh() } }
}
const target = (remoteEndpointId: string) => ({ kind: 'remote' as const, remoteEndpointId, sessionId: 'session' })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('RemoteSessionTasksStore', () => {
  it('separates equal source IDs, coalesces repeated tree reads and releases hidden readers and cached snapshots', async () => {
    vi.useFakeTimers()
    const f = fixture(), stopRemote = f.remote.start()
    await vi.advanceTimersByTimeAsync(0)
    const stop = f.store.start()
    f.store.setDrawn([target('first'), target('second')])
    f.store.setDrawn([target('first'), target('second')])
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.requestTasks).toHaveBeenCalledTimes(2)
    expect(f.store.current().get(TerminalTargetCodec.key(target('first')))).toMatchObject({ listing: { rows: [{ command: 'first:one' }] } })
    expect(f.store.current().get(TerminalTargetCodec.key(target('second')))).toMatchObject({ listing: { rows: [{ command: 'second:one' }] } })
    f.store.setWindowVisible(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.requestTasks).toHaveBeenCalledTimes(2)
    f.store.setDrawn([])
    expect(f.store.current().size).toBe(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.closeView).toHaveBeenCalledTimes(2)
    stop(); stopRemote()
  })
  it('publishes nothing when a drawn target stays offline, so a view that redraws on every publish settles', async () => {
    vi.useFakeTimers()
    const f = fixture(), stopRemote = f.remote.start()
    await vi.advanceTimersByTimeAsync(0)
    const stop = f.store.start()
    f.store.setDrawn([target('first')])
    await vi.advanceTimersByTimeAsync(1000)
    f.change(false)
    await vi.advanceTimersByTimeAsync(0)
    let publishes = 0
    const unsubscribe = f.store.subscribe(() => { if (++publishes < 50) f.store.setDrawn([target('first')]) })
    f.store.setDrawn([target('first')])
    f.store.setDrawn([target('first'), target('second')])
    expect(publishes).toBe(0)
    expect(f.store.current().size).toBe(0)
    unsubscribe(); stop(); stopRemote()
  })
  it('resumes the same visible target after reconnect without replacing the run', async () => {
    vi.useFakeTimers()
    const f = fixture(), stopRemote = f.remote.start()
    await vi.advanceTimersByTimeAsync(0)
    const stop = f.store.start()
    f.store.setDrawn([target('first')])
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.requestTasks).toHaveBeenCalledTimes(1)
    f.change(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.store.current().size).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.requestTasks).toHaveBeenCalledTimes(1)
    f.change(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.requestTasks).toHaveBeenCalledTimes(2)
    expect(f.store.current().get(TerminalTargetCodec.key(target('first')))).toMatchObject({ listing: { rows: [{ shellId: 'same', command: 'first:two' }] } })
    stop(); stopRemote()
    expect(f.store.current().size).toBe(0)
  })
})
