import { describe, expect, it, vi } from 'vitest'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import type { RemoteSidebarRequest } from '../../../lib-orchestrator/remoteControl/remoteSidebarApi.types'
import { RemoteSidebarResults } from '../../shared/remoteSidebarResults'
import { RemoteSidebarAccess } from './remoteSidebarAccess'

const view = { peerId: 'source-peer', epoch: 'epoch', viewId: 'view', viewerId: 'window', sessionId: 'source-session' }

describe('source sidebar access', () => {
  it('derives the session from the admitted view and validates its response provenance', async () => {
    const execute = vi.fn<RemoteControlRegistry['execute']>(async () => ({ ok: true, value: { directory: 'S:/source', notes: [{ text: 'Source note' }] } } as never))
    const transcript = { read: vi.fn(async () => ({ kind: 'none' as const, code: 'transcript-not-found' as const, reason: 'Missing at source' })) }
    const compact = { claimAutomatic: vi.fn(), noteManual: vi.fn(), cooldown: vi.fn(), deliver: vi.fn() }
    let active = true
    const source = new RemoteSidebarAccess({ execute }, transcript, () => active, compact)
    const read = async (request: RemoteSidebarRequest) => {
      const answer = await source.request(view, request)
      if (!answer.ok) throw new Error(answer.error.detail)
      return JSON.parse(Buffer.from(answer.value.base64, 'base64').toString('utf8')) as unknown
    }
    const reply = await read({ kind: 'notes' })
    expect(RemoteSidebarResults.parse(view.sessionId, { kind: 'notes' }, reply)).toMatchObject({ ok: true, value: { directory: 'S:/source' } })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ operation: 'directoryNotes.get', body: { sessionId: 'source-session' } }), expect.objectContaining({ allowedOperations: ['directoryNotes.get'] }))
    expect(() => RemoteSidebarResults.parse('local-session', { kind: 'notes' }, reply)).toThrow('another request')
    expect(() => RemoteSidebarResults.parse(view.sessionId, { kind: 'model' }, reply)).toThrow('another request')
    expect(RemoteSidebarResults.parse(view.sessionId, { kind: 'transcript' }, await read({ kind: 'transcript' })))
      .toMatchObject({ ok: true, value: { reason: 'Missing at source' } })
    expect(transcript.read).toHaveBeenCalledWith('source-session')
    active = false
    expect(await source.request(view, { kind: 'notes' })).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('runs one compact operation per source session and refuses a changed replay', async () => {
    const compact = { claimAutomatic: vi.fn(), noteManual: vi.fn(), cooldown: vi.fn(), deliver: vi.fn(async () => ({ kind: 'delivered' as const, proof: 'transcript' as const })) }
    const source = new RemoteSidebarAccess({ execute: vi.fn() }, { read: vi.fn() }, () => true, compact)
    const request = { kind: 'compact' as const, action: 'deliver' as const, operationId: 'operation' }
    await Promise.all([source.request(view, request), source.request({ ...view, viewId: 'other' }, request)])
    expect(compact.deliver).toHaveBeenCalledTimes(1)
    expect(compact.deliver).toHaveBeenCalledWith('source-session')
    const conflict = await source.request(view, { ...request, action: 'note' })
    expect(compact.noteManual).not.toHaveBeenCalled()
    if (!conflict.ok) throw new Error(conflict.error.detail)
    expect(RemoteSidebarResults.parse(view.sessionId, { ...request, action: 'note' }, JSON.parse(Buffer.from(conflict.value.base64, 'base64').toString('utf8'))))
      .toMatchObject({ ok: false, error: { code: 'conflict' } })
  })
})
