import { describe, expect, it, vi } from 'vitest'

import type { RemoteControlPeerTransport } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteSessionView } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import { RemoteSessionSchemas } from '../../../lib-orchestrator/remoteControl/remoteSessionSchemas'
import { RemoteSessionViews } from './remoteSessionViews'

const peer = {
  connectionId: 'epoch', capabilities: ['session-workspace.views', 'session-workspace.actions'],
  remoteIdentity: { remoteComputerId: 'computer', remoteEndpointId: 'endpoint', displayName: 'Peer', configIdentity: 'config', runtimeChannel: 'development', signing: { algorithm: 'ed25519', publicKey: 'key', fingerprint: 'pin' } },
} satisfies Pick<RemoteControlPeerTransport, 'connectionId' | 'capabilities' | 'remoteIdentity'>
const body = { revision: 1, workflowId: 'workflow', actionId: 'keep', agreement: {} }
async function opened(views: RemoteSessionViews): Promise<RemoteSessionView> {
  const answer = await views.request(peer, { requestId: 'open', epoch: 'epoch', operation: 'views.open', body: { sessionId: 'session', viewerId: 'viewer' } })
  if (!answer.ok || !answer.value || !('viewId' in answer.value)) throw new Error('No view')
  return answer.value
}

describe('authenticated session views', () => {
  it('binds requests to peer, epoch, session and viewer and rejects caller fields', async () => {
    const press = vi.fn(async () => ({ ok: true as const, value: null }))
    const views = new RemoteSessionViews({ exists: () => true, press })
    const view = await opened(views)
    const request = { ...view, requestId: 'press', operationId: 'operation', operation: 'actions.press', body }
    for (const field of ['epoch', 'sessionId', 'viewerId', 'viewId'])
      expect(await views.request(peer, { ...request, [field]: 'foreign' })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(await views.request({ ...peer, remoteIdentity: { ...peer.remoteIdentity, remoteEndpointId: 'foreign' } }, request)).toMatchObject({ ok: false })
    expect(await views.request(peer, { ...request, callerKind: 'window' })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(await views.request(peer, { ...request, body: { ...body, callerKind: 'window' } })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    views.releaseConnection({ ...peer, remoteIdentity: { ...peer.remoteIdentity, remoteEndpointId: 'foreign' } })
    expect(press).not.toHaveBeenCalled()
    expect(await views.request(peer, request)).toEqual({ ok: true, value: null })
    expect(press).toHaveBeenCalledOnce()
  })

  it('replays identical operations and refuses changed payloads', async () => {
    const press = vi.fn(async () => ({ ok: true as const, value: null }))
    const views = new RemoteSessionViews({ exists: () => true, press })
    const view = await opened(views)
    const request = { ...view, requestId: 'press', operationId: 'operation', operation: 'actions.press', body }
    expect(await views.request(peer, request)).toEqual({ ok: true, value: null })
    expect(await views.request(peer, { ...request, requestId: 'retry' })).toEqual({ ok: true, value: null })
    expect(await views.request(peer, { ...request, body: { ...body, actionId: 'discard' } })).toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(press).toHaveBeenCalledOnce()
  })

  it('replays a lost acknowledgement through a new admitted lease and connection epoch', async () => {
    const press = vi.fn(async () => ({ ok: true as const, value: null }))
    const views = new RemoteSessionViews({ exists: () => true, press })
    const view = await opened(views)
    const request = { ...view, requestId: 'press', operationId: 'operation', operation: 'actions.press', body }
    await views.request(peer, request)
    views.releaseConnection(peer)
    const reconnected = { ...peer, connectionId: 'next-epoch' }
    const next = await views.request(reconnected, { requestId: 'open2', epoch: 'next-epoch', operation: 'views.open', body: { sessionId: 'session', viewerId: 'next-viewer' } })
    if (!next.ok || !next.value) throw new Error('No replacement view')
    expect(await views.request(reconnected, { ...request, ...next.value })).toEqual({ ok: true, value: null })
    expect(await views.request(reconnected, { ...request, ...next.value, body: { ...body, actionId: 'discard' } })).toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(press).toHaveBeenCalledOnce()
  })

  it('revokes grants on disconnect without cancelling accepted execution', async () => {
    let finish!: () => void
    const accepted = new Promise<void>((resolve) => { finish = resolve })
    const release = vi.fn()
    const views = new RemoteSessionViews({ exists: () => true, release, press: async () => { await accepted; return { ok: true, value: null } } })
    const view = await opened(views)
    const request = { ...view, requestId: 'press', operationId: 'operation', operation: 'actions.press', body }
    const pending = views.request(peer, request)
    await Promise.resolve()
    views.releaseConnection(peer)
    expect(release).toHaveBeenCalledWith(expect.objectContaining(view))
    expect(await views.request(peer, request)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    finish()
    expect(await pending).toEqual({ ok: true, value: null })
  })

  it('requires the negotiated tasks group and strict run/cursor requests', async () => {
    const read = vi.fn(async () => ({ ok: true as const, value: { transferId: 'transfer', version: 'version', offset: 0, totalBytes: 2, base64: 'e30=' } }))
    const views = new RemoteSessionViews({ exists: () => true, press: vi.fn(), read }), view = await opened(views)
    const request = { ...view, requestId: 'task', operation: 'tasks.request', body: { kind: 'script', runId: 'run' } }
    expect(await views.request(peer, request)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(read).not.toHaveBeenCalled()
    const taskPeer = { ...peer, capabilities: [...peer.capabilities, 'session-workspace.tasks' as const] }
    expect(await views.request(taskPeer, { ...request, body: { ...request.body, sessionId: 'foreign' } })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    const result = await views.request(taskPeer, request)
    expect(result.ok).toBe(true)
    expect(RemoteSessionSchemas.viewResponse({ requestId: 'task', operation: 'tasks.request', result })).not.toBeNull()
    expect(read).toHaveBeenCalledOnce()
  })

  it('requires negotiated views and actions and an existing source session', async () => {
    const views = new RemoteSessionViews({ exists: () => false, press: vi.fn() })
    const request = { requestId: 'open', epoch: 'epoch', operation: 'views.open', body: { sessionId: 'session', viewerId: 'viewer' } }
    expect(await views.request(peer, request)).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(await views.request({ ...peer, capabilities: [] }, request)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })
  it('returns bounded typed read failures while the admitted view stays usable', async () => {
    const read = vi.fn(async () => { throw new Error('x'.repeat(10_000)) })
    const press = vi.fn(async () => ({ ok: true as const, value: null }))
    const views = new RemoteSessionViews({ exists: () => true, press, read })
    const view = await opened(views)
    const request = { ...view, requestId: 'read', operation: 'changes.request', body: { kind: 'list', preferredVcs: null } }
    expect(await views.request(peer, request)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(read).not.toHaveBeenCalled()
    const result = await views.request({ ...peer, capabilities: [...peer.capabilities, 'session-workspace.changes'] }, request)
    expect(result).toMatchObject({ ok: false, error: { code: 'operation-failed' } })
    expect(RemoteSessionSchemas.viewResponse({ requestId: 'read', operation: 'changes.request', result })).not.toBeNull()
    expect(await views.request(peer, { ...view, requestId: 'press', operationId: 'operation', operation: 'actions.press', body })).toEqual({ ok: true, value: null })
  })

})
