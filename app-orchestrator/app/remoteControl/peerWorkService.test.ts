import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PeerAuthority } from '../../../lib-orchestrator/remoteControl/peerProcess.types'
import type { RemoteControlCallContext } from '../../../lib-orchestrator/remoteControl/remoteControl'
import type { RemoteControlResponse } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteControlPeerConst } from '../../../lib-orchestrator/remoteControl/remoteControlPeerProtocol'
import { RemoteControlAuditRows } from '../../../lib-orchestrator/remoteControl/remoteControlAuditRows'
import { RemoteControlAudit } from './remoteControlAudit'
import { PeerWorkService, type PeerWorkServiceDeps } from './peerWorkService'

const peer: PeerAuthority = { connectionId: 'connection', capabilities: RemoteControlPeerConst.capabilities,
  remoteIdentity: { remoteComputerId: 'computer', remoteEndpointId: 'endpoint', configIdentity: 'config', runtimeChannel: 'development',
    displayName: 'fixture', signing: { algorithm: 'ed25519', publicKey: 'public', fingerprint: 'fingerprint' } } }
const request = { protocol: RemoteControlConst.protocol, requestId: 'request', operation: 'sessions.list', body: {} } as const
function fixture(overrides?: Partial<PeerWorkServiceDeps>) {
  const contexts: RemoteControlCallContext[] = []
  const releaseConnection = vi.fn()
  const deps: PeerWorkServiceDeps = {
    control: { execute: async (_request, context) => {
      contexts.push(context)
      return { ...request, operationId: null, ok: true, value: {} } as RemoteControlResponse
    } },
    views: { request: async () => ({ ok: true, value: null }), releaseConnection },
    snapshots: { page: () => ({ ok: false, error: { code: 'unavailable', detail: 'fixture' } }) },
    files: { saveImage: async () => ({ ok: true, path: '/image' }), receive: async () => ({ ok: true, kind: 'partial', received: 0 }) },
    audit: { append: vi.fn(), flush: vi.fn() }, unknownPeer: vi.fn(), bound: () => null,
    ...overrides,
  }
  return { service: new PeerWorkService(deps), contexts, releaseConnection, deps }
}

describe('main peer work ownership', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  it('dispatches only remote capabilities and admits explicit source file opens', async () => {
    const h = fixture()
    await h.service.execute(peer, request, new AbortController().signal)
    expect(h.contexts[0]?.callerKind).toBe('remote-peer')
    expect(h.contexts[0]?.allowedOperations).not.toContain('tabs.open')
    expect(h.contexts[0]?.allowedOperations).toContain('tabs.openFile')
    expect(h.contexts[0]?.allowedOperations).toEqual(RemoteControlPeerConst.controlOperations)
  })

  it('holds a peer to the capabilities it negotiated, on both transports', async () => {
    const h = fixture()
    await h.service.execute({ ...peer, capabilities: ['control:sessions.list'] }, request, new AbortController().signal)
    expect(h.contexts[0]?.allowedOperations).toEqual(['sessions.list'])
  })

  it('does not start cancelled work and releases grants if cancellation crosses a view result', async () => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const releaseConnection = vi.fn()
    const h = fixture({ views: { request: async () => { await pending; return { ok: true, value: null } }, releaseConnection } })
    const abort = new AbortController()
    const work = h.service.view(peer, { requestId: 'view', operation: 'views.open', epoch: peer.connectionId,
      body: { sessionId: 'session', viewerId: 'viewer' } }, abort.signal)
    abort.abort()
    expect(releaseConnection).toHaveBeenCalledWith(peer)
    finish(); await work
    expect(releaseConnection).toHaveBeenCalledTimes(2)
    await expect(h.service.execute(peer, request, abort.signal)).rejects.toThrow()
    expect(h.contexts).toEqual([])
  })

  it('persists the gateway-captured redacted audit row and flushes the final batch', () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-peer-work-'))
    roots.push(root)
    const path = join(root, 'audit.jsonl'), audit = new RemoteControlAudit(path, message => { throw new Error(message) })
    const h = fixture({ audit })
    const input = { protocol: RemoteControlConst.protocol, requestId: 'input', operationId: 'operation',
      operation: 'terminal.input', attachId: 'attach', data: 'SECRET-TERMINAL-TEXT' } as const
    const row = RemoteControlAuditRows.socket(123, 'peer-socket', input,
      { protocol: RemoteControlConst.protocol, type: 'response', requestId: 'input', operation: 'terminal.input', operationId: 'operation', ok: true, value: {} },
      { callerId: 'peer', callerKind: 'remote-peer' })
    h.service.event('audit', row)
    h.service.flush()
    const saved = readFileSync(path, 'utf8')
    expect(JSON.parse(saved).at).toBe(123)
    expect(saved).toContain('peer-socket')
    expect(saved).toContain('"characterCount":20')
    expect(saved).not.toContain('SECRET-TERMINAL-TEXT')
  })

  it('drains an accepted execution and its audit after the gateway has cancelled its wait', async () => {
    let finish!: () => void
    const accepted = new Promise<void>(resolve => { finish = resolve })
    const order: string[] = []
    const h = fixture({
      control: { execute: async () => { await accepted; return { ...request, operationId: null, ok: true, value: {} } as RemoteControlResponse } },
      audit: { append: row => { expect(row.transport).toBe('peer-control'); order.push('audit') }, flush: () => { order.push('flush') } },
    })
    const abort = new AbortController(), running = h.service.execute(peer, request, abort.signal)
    abort.abort()
    const stopped = h.service.stop().then(() => { order.push('stopped') })
    h.service.event('unknown-peer', { claimant: peer.remoteIdentity, remoteAddress: '127.0.0.1' })
    expect(h.deps.unknownPeer).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(order).toEqual([])
    await expect(h.service.execute(peer, request, new AbortController().signal)).rejects.toThrow('stopping')
    finish(); await running; await stopped
    expect(order).toEqual(['audit', 'flush', 'stopped'])
  })
})
