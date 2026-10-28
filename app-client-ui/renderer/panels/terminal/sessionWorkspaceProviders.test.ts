import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteConnectionsSnapshot } from '../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { SessionInfo, SessionWorkflowAction, SessionsSnapshot } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SnapshotStore } from '../../ipc/snapshotStore'
import { SessionWorkspaceProviders } from './sessionWorkspaceProviders'

const target = { kind: 'remote', remoteEndpointId: 'peer', sessionId: 'session' } as const
function info(summary: string): SessionInfo {
  return { sessionId: 'session', actions: { sections: [{ workflowId: 'workflow', summary, actions: [{ id: 'keep' }] }] } } as SessionInfo
}
function fixture() {
  let epoch = 'one'
  let serial = 1
  let session = info('First')
  let legacy = false
  const readView = vi.fn(async () => ({ ok: true, value: { ok: true, value: { revision: 1, session: structuredClone(session) } } }))
  const pressAction = vi.fn(async () => ({ ok: true, value: { ok: true, value: null } }))
  const closeView = vi.fn(async () => ({ ok: true, value: { ok: true, value: null } }))
  const openView = vi.fn(async () => ({ ok: true, value: { ok: true, value: { viewId: epoch, epoch, viewerId: epoch, sessionId: 'session' } } }))
  vi.stubGlobal('appClient', { remote: { readView, pressAction, closeView, openView } })
  const remote = new SnapshotStore<RemoteConnectionsSnapshot>('fixture', {
    read: async () => ({ ok: true, value: { revision: serial, inbound: [], outbound: [{ remoteEndpointId: 'peer', status: 'connected', connectionId: epoch,
      workspaceCapabilities: legacy ? [] : ['session-workspace.read', 'session-workspace.views', 'session-workspace.actions', 'session-workspace.files', 'session-workspace.tasks'],
      sessions: { revision: 1, sessions: [{ sessionId: 'session' }] } as SessionsSnapshot,
    }] } as unknown as RemoteConnectionsSnapshot }), subscribe: () => () => {}, reportError: vi.fn(),
  })
  return { remote, readView, pressAction, closeView, openView,
    change: () => { epoch = 'two'; serial++; session = info('Second'); remote.refresh() },
    legacy: () => { legacy = true; serial++; remote.refresh() },
  }
}

describe('remote workspace composition', () => {
  afterEach(() => vi.unstubAllGlobals())
  it.each(['timeout', 'unavailable', 'forbidden'] as const)('retains %s when opening a review view fails', async (code) => {
    const f = fixture(), stop = f.remote.start()
    await waitFor(() => expect(f.remote.current().snapshot).not.toBeNull())
    f.remote.current().snapshot!.outbound[0].workspaceCapabilities = ['session-workspace.views', 'session-workspace.reviews', 'session-workspace.changes']
    const requestReviews = vi.fn()
    Object.assign(window.appClient.remote, { openView: vi.fn(async () => ({ ok: true, value: { ok: false, error: { code, detail: 'Opening failed' } } })), requestReviews })
    const workspace = SessionWorkspaceProviders.forTarget(target, f.remote)
    try {
      const answer = await workspace.reviews!.versioning.openDraft('session', 'svn', 'Q:/source')
      expect(answer).toMatchObject({ ok: false })
      if (code === 'forbidden') expect(answer).not.toHaveProperty('channelLost')
      else expect(answer).toMatchObject({ channelLost: { accepted: false } })
      expect(requestReviews).not.toHaveBeenCalled()
    } finally { workspace.dispose(); stop() }
  })
  it('preserves displayed action identity across equal rereads and refreshes a new epoch at the same source revision', async () => {
    const f = fixture()
    const stopRemote = f.remote.start()
    await waitFor(() => expect(f.remote.current().snapshot).not.toBeNull())
    const workspace = SessionWorkspaceProviders.forTarget(target, f.remote)
    const stopWorkspace = workspace.start()
    const stop = workspace.sessions!.start()
    await waitFor(() => expect(workspace.sessions!.current().snapshot?.sessions[0]?.actions?.sections[0].summary).toBe('First'))
    const first = workspace.sessions!.current().snapshot!
    const action = first.sessions[0].actions!.sections[0].actions[0] as SessionWorkflowAction
    workspace.sessions!.refresh()
    await waitFor(() => expect(f.readView).toHaveBeenCalledTimes(2))
    expect(workspace.sessions!.current().snapshot).toBe(first)
    expect(await workspace.actions(vi.fn(), () => null).press(action, {})).toEqual({ kind: 'done' })
    expect(f.pressAction).toHaveBeenCalledWith('peer', 'one', expect.objectContaining({ revision: 1, workflowId: 'workflow', actionId: 'keep' }), expect.any(String))
    f.change()
    await waitFor(() => expect(workspace.sessions!.current().snapshot?.sessions[0]?.actions?.sections[0].summary).toBe('Second'))
    expect(workspace.sessions!.current().snapshot!.revision).toBeGreaterThan(first.revision)
    expect(f.openView).toHaveBeenCalledTimes(2)
    stop(); stopWorkspace(); stopRemote()
    await waitFor(() => expect(f.closeView).toHaveBeenCalledWith('peer', 'two'))
  })
  it('refuses unsupported workspace features without calling a local owner or opening a view', async () => {
    const f = fixture()
    const stopRemote = f.remote.start()
    await waitFor(() => expect(f.remote.current().snapshot).not.toBeNull())
    f.legacy()
    await waitFor(() => expect(f.remote.current().snapshot!.revision).toBe(2))
    const workspace = SessionWorkspaceProviders.forTarget(target, f.remote)
    expect(workspace.status()).toContain('does not support Session actions')
    expect(workspace.files).toBeNull()
    expect(workspace.tasks).toBeNull()
    expect(workspace.reviews).toBeNull()
    expect(await workspace.actions(vi.fn(), () => null).press({ id: 'keep' } as SessionWorkflowAction, {})).toMatchObject({ kind: 'refused' })
    expect(f.openView).not.toHaveBeenCalled()
    stopRemote()
  })

  it('reacquires file-only views on reconnect and holds them when action polling stops', async () => {
    const f = fixture()
    const stopRemote = f.remote.start()
    await waitFor(() => expect(f.remote.current().snapshot).not.toBeNull())
    const mediaResource = vi.fn(async () => ({ ok: true, value: { ok: false, code: 'not-found', detail: 'fixture' } }))
    Object.assign(window.appClient.remote, { mediaResource })
    const workspace = SessionWorkspaceProviders.forTarget(target, f.remote)
    const stopWorkspace = workspace.start()
    await workspace.files!.viewer.mediaResource('document')
    expect(f.openView).toHaveBeenCalledTimes(1)
    f.change()
    await waitFor(() => expect(workspace.contentRevision()).toBeGreaterThan(0))
    await workspace.files!.viewer.mediaResource('document')
    expect(f.openView).toHaveBeenCalledTimes(2)
    const stopActions = workspace.sessions!.start()
    await waitFor(() => expect(f.readView).toHaveBeenCalled())
    const before = f.closeView.mock.calls.length
    stopActions()
    expect(f.closeView.mock.calls.length).toBe(before)
    stopWorkspace()
    await waitFor(() => expect(f.closeView).toHaveBeenCalledWith('peer', 'two'))
    stopRemote()
  })
  it('isolates equal task IDs and retires held callbacks on reconnect and dispose', async () => {
    const f = fixture(), stopRemote = f.remote.start()
    await waitFor(() => expect(f.remote.current().snapshot).not.toBeNull())
    const requestTasks = vi.fn(async (_endpoint: string, viewId: string, request: unknown) => {
      const value = { sessionId: 'session', request, result: { ok: true, value: { state: 'succeeded', source: 'log', lines: [viewId], terminal: null } } }
      const bytes = new TextEncoder().encode(JSON.stringify(value))
      return { ok: true, value: { ok: true, value: { transferId: 'same', version: 'same', offset: 0, totalBytes: bytes.length,
        base64: btoa(String.fromCharCode(...bytes)) } } }
    })
    Object.assign(window.appClient.remote, { requestTasks })
    const workspace = SessionWorkspaceProviders.forTarget(target, f.remote), stop = workspace.start(), old = workspace.tasks!
    expect(await old.scriptOutput({ sessionId: 'session', runId: 'same-run' })).toMatchObject({ ok: true, value: { ok: true, value: { lines: ['one'] } } })
    f.change()
    await waitFor(() => expect(workspace.contentRevision()).toBe(1))
    const calls = requestTasks.mock.calls.length
    expect(await old.scriptOutput({ sessionId: 'session', runId: 'same-run' })).toMatchObject({ ok: false })
    expect(requestTasks).toHaveBeenCalledTimes(calls)
    const fresh = workspace.tasks!
    expect(await fresh.scriptOutput({ sessionId: 'session', runId: 'same-run' })).toMatchObject({ ok: true, value: { ok: true, value: { lines: ['two'] } } })
    expect(await fresh.scriptOutput({ sessionId: 'foreign', runId: 'same-run' })).toMatchObject({ ok: false })
    stop()
    expect(await fresh.scriptOutput({ sessionId: 'session', runId: 'same-run' })).toMatchObject({ ok: false })
    expect(requestTasks).toHaveBeenCalledTimes(2)
    stopRemote()
  })

})


it('opens a shared source review from the remote sidebar without the local commit bridge', async () => {
  const f = fixture()
  const stop = f.remote.start()
  await waitFor(() => expect(f.remote.current().snapshot).not.toBeNull())
  f.remote.current().snapshot!.outbound[0].workspaceCapabilities = [...f.remote.current().snapshot!.outbound[0].workspaceCapabilities!,
    'session-workspace.commands', 'session-workspace.reviews', 'session-workspace.changes']
  const requestReviews = vi.fn(async () => ({ ok: true, value: { ok: true, value: { transferId: 'transfer', version: 'v', offset: 0, eof: true,
    totalBytes: 1, base64: Buffer.from(JSON.stringify({ ok: true, value: { draftId: 'review', scopeRoot: 'Q:/source', title: 'Commit SVN' }, messageApplied: false })).toString('base64') } } }))
  const bytes = Buffer.from(JSON.stringify({ ok: true, value: { draftId: 'review', scopeRoot: 'Q:/source', title: 'Commit SVN' }, messageApplied: false }))
  requestReviews.mockResolvedValue({ ok: true, value: { ok: true, value: { transferId: 'transfer', version: 'v', offset: 0, eof: true, totalBytes: bytes.length, base64: bytes.toString('base64') } } })
  const local = vi.fn()
  Object.assign(window.appClient, { versioning: { openCommitTab: local } })
  Object.assign(window.appClient.remote, { requestReviews })
  const workspace = SessionWorkspaceProviders.forTarget(target, f.remote)
  expect(await workspace.openCommit('svn', '.')).toBeNull()
  expect(requestReviews).toHaveBeenCalledWith('peer', 'one', { kind: 'create', vcs: 'svn', openId: expect.any(String) })
  expect(local).not.toHaveBeenCalled()
  workspace.dispose(); stop()
})
