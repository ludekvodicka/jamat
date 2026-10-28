import { describe, expect, it, vi } from 'vitest'
import { RemoteSessionActions } from './remoteSessionActions'

import type { SessionInfo, SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { RemoteSessionRevision, RemoteSessionStateRequest } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import { RemoteSessionSchemas } from '../../../lib-orchestrator/remoteControl/remoteSessionSchemas'
import { RemoteSessionSnapshots } from './remoteSessionSnapshots'

function session(sessionId: string): SessionInfo {
  return {
    sessionId, kind: 'shell', title: 'unicode 見える🙂'.repeat(30), titleParts: { number: null, name: 'visible' },
    tabTitle: sessionId, directory: { mode: 'adHoc', path: 'C:/source' }, project: { kind: 'none' },
    life: 'live', activity: null, admits: [],
  }
}

function snapshot(sessions: SessionInfo[]): SessionsSnapshot {
  return { revision: 1, reconciled: true, host: { presence: 'running', hostVersion: 'test', hostInstanceId: 'host', liveCount: 1, lastStartError: null }, categories: [], sessions, orphans: [] }
}

describe('RemoteSessionSnapshots', () => {
  it('bounds Unicode pages, retains ended pending/results and keeps workflow bodies out of discovery', () => {
    const waiting = { ...session('waiting'), life: 'ended' as const, workflow: {
      kind: 'update-main' as const, workflowId: 'update', title: 'Update', badge: 'waits', summary: 'needs person',
      open: true, rounds: [], actions: [],
    } }
    const result = { ...session('result'), life: 'ended' as const, retiredWorktree: { worktreePath: 'C:/removed', revisions: ['r1'] } }
    const rows = [...Array.from({ length: 1000 }, (_, i) => session(`live-${i}`)), waiting, result, { ...session('history'), life: 'ended' as const }]
    const owner = new RemoteSessionSnapshots(() => snapshot(rows))
    const received: SessionInfo[] = []
    let offset = 0
    let expected: RemoteSessionRevision | null = null
    let pages = 0
    do {
      const answer = owner.page({ requestId: 'test', kind: 'sessions', expected, offset })
      expect(answer.ok).toBe(true)
      if (!answer.ok || answer.value.kind !== 'sessions') throw new Error('No session page')
      const envelope = { requestId: 'test', result: answer }
      expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThanOrEqual(256 * 1024)
      expect(RemoteSessionSchemas.stateResponse(envelope)).not.toBeNull()
      received.push(...answer.value.snapshot.sessions)
      expected = answer.value
      offset = answer.value.next ?? -1
      pages++
    } while (offset !== -1)
    expect(pages).toBeGreaterThan(1)
    expect(received).toHaveLength(1002)
    expect(received.find((row) => row.sessionId === 'waiting')).toMatchObject({ pending: true })
    expect(received.find((row) => row.sessionId === 'result')).toMatchObject({ hasResult: true })
    expect(received.some((row) => row.workflow !== undefined)).toBe(false)
    expect(received.some((row) => row.sessionId === 'history')).toBe(false)
  })

  it('rejects a changed revision or epoch instead of mixing pages', () => {
    const state = snapshot([session('a')])
    const owner = new RemoteSessionSnapshots(() => state)
    const first = owner.page({ requestId: 'one', kind: 'sessions', expected: null, offset: 0 })
    if (!first.ok) throw new Error(first.error.detail)
    state.revision++
    expect(owner.page({ requestId: 'next', kind: 'categories', expected: first.value, offset: 0 }))
      .toMatchObject({ ok: false, error: { code: 'conflict' } })
    state.revision--
    expect(new RemoteSessionSnapshots(() => state).page({ requestId: 'restart', kind: 'sessions', expected: first.value, offset: 0 }))
      .toMatchObject({ ok: false, error: { code: 'conflict' } })
  })

  it('pages exact detail bytes without splitting Unicode text or accepting an invalid cursor', () => {
    const row = { ...session('a'), note: '🙂'.repeat(60_000) }
    const state = snapshot([row])
    const owner = new RemoteSessionSnapshots(() => state)
    const parts: Buffer[] = []
    let expected: RemoteSessionRevision | null = null
    let offset = 0
    do {
      const result = owner.page({ requestId: 'detail', kind: 'detail', sessionId: 'a', expected, offset })
      if (!result.ok || result.value.kind !== 'detail') throw new Error('No detail page')
      expect(RemoteSessionSchemas.stateResponse({ requestId: 'detail', result })).not.toBeNull()
      parts.push(Buffer.from(result.value.base64, 'base64'))
      expected = result.value
      offset = result.value.next ?? -1
    } while (offset !== -1)
    expect(JSON.parse(Buffer.concat(parts).toString('utf8'))).toEqual(row)
    const request: RemoteSessionStateRequest = { requestId: 'bad', kind: 'sessions', expected: null, offset: 0 }
    expect(RemoteSessionSchemas.stateRequest({ ...request, caller: 'window' })).toBeNull()
    expect(RemoteSessionSchemas.stateRequest({ ...request, offset: 1 })).toBeNull()
    expect(owner.page({ ...request, expected, offset: 99 })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })
})

it('retains ended standalone reviews and keeps workflow action revision separate from review-only discovery edits', async () => {
  const state = snapshot([{ ...session('pending'), life: 'ended' }, { ...session('settled'), life: 'ended' }])
  state.revision = 30
  let revision = 1
  const owner = new RemoteSessionSnapshots(() => state, () => ({ revision, pending: ['pending'], results: ['settled'] }))
  const first = owner.page({ requestId: 'first', kind: 'sessions', offset: 0, expected: null })
  expect(first).toMatchObject({ ok: true, value: { snapshot: { sessions: [
    { sessionId: 'pending', reviewPending: true, pending: true }, { sessionId: 'settled', hasResult: true },
  ] } } })
  revision++
  const second = owner.page({ requestId: 'second', kind: 'sessions', offset: 0, expected: null })
  if (!first.ok || !second.ok) throw new Error('Discovery failed')
  expect(second.value.revision).toBeGreaterThan(first.value.revision)
  const detail = owner.page({ requestId: 'detail', kind: 'detail', sessionId: 'pending', offset: 0, expected: second.value })
  expect(detail).toMatchObject({ ok: true, value: { sourceRevision: 30 } })
  if (!detail.ok || detail.value.kind !== 'detail') throw new Error('No detail')
  const execute = vi.fn(async () => ({ ok: true as const, value: {} }))
  state.sessions[0].workflow = { workflowId: 'workflow', actions: [{ id: 'keep', command: { operation: 'sessions.finishWorktree', body: { choice: 'keep' } } }] } as never
  const actions = new RemoteSessionActions(() => state, { execute: execute as never })
  expect(await actions.press({ peerId: 'peer', viewId: 'view', viewerId: 'viewer', epoch: 'epoch', sessionId: 'pending' },
    { revision: detail.value.sourceRevision!, workflowId: 'workflow', actionId: 'keep', agreement: {} }, 'operation')).toEqual({ ok: true, value: null })
  expect(execute).toHaveBeenCalledTimes(1)
})
