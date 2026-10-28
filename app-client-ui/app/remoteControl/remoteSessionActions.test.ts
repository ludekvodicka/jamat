import { WorktreeWords } from '../../../lib-orchestrator/worktrees/worktreeViews'
import { describe, expect, it, vi } from 'vitest'
import type { SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { RemoteControlAnswer } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteSessionActions } from './remoteSessionActions'

const view = { peerId: 'peer', viewId: 'view', viewerId: 'viewer', epoch: 'epoch', sessionId: 'session' }
const request = { revision: 7, workflowId: 'workflow', actionId: 'keep', agreement: {} }
function fixture() {
  const snapshot = { revision: 7, sessions: [{ sessionId: 'session', actions: { sections: [{ workflowId: 'workflow', actions: [
    { id: 'keep' }, { id: 'finish-again', requiresCommit: true }, { id: 'update-main', confirmLive: ['source-session'] },
  ] }] } }] } as unknown as SessionsSnapshot
  WorktreeWords.decorate(snapshot.sessions[0])
  const execute = vi.fn(async () => ({ ok: true, value: {} }) as RemoteControlAnswer)
  return { owner: new RemoteSessionActions(() => snapshot, { execute }), snapshot, execute }
}

describe('source-owned session actions', () => {
  it('routes an admitted view to the existing owner with derived human context', async () => {
    const f = fixture()
    expect(await f.owner.press(view, request, 'op')).toEqual({ ok: true, value: null })
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ operation: 'sessions.finishWorktree', body: { session: { kind: 'sessionId', sessionId: 'session' }, choice: 'keep' } }),
      expect.objectContaining({ callerKind: 'window', allowedOperations: ['sessions.finishWorktree'] }))
  })
  it('refuses stale, foreign and unclaimed commit actions before any owner call', async () => {
    const f = fixture()
    for (const changed of [{ ...request, revision: 6 }, { ...request, workflowId: 'other' }, { ...request, actionId: 'discard' }, { ...request, actionId: 'finish-again' }])
      expect(await f.owner.press(view, changed, 'op')).toMatchObject({ ok: false })
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('takes live-session confirmations from the current source action', async () => {
    const f = fixture()
    await f.owner.press(view, { ...request, actionId: 'update-main' }, 'op')
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ operation: 'sessions.updateMain', body: { session: { kind: 'sessionId', sessionId: 'session' }, confirmLive: ['source-session'] } }), expect.anything())
    f.snapshot.revision++
    expect(await f.owner.press(view, { ...request, actionId: 'update-main' }, 'next')).toMatchObject({ ok: false })
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('binds clearing and conflict choices to the source revision and currently offered path options', async () => {
    const f = fixture()
    const conflict = { path: 'file', state: 'person', options: [{ id: 'keep-mine' }] }
    f.snapshot.sessions[0].svnAction = { conflicts: { entries: [conflict], more: 0 } } as never
    expect(await f.owner.press(view, { kind: 'clear-history', revision: 6 }, 'old')).toMatchObject({ ok: false })
    const resolve = { kind: 'resolve-conflict' as const, revision: 7, path: 'file', option: 'keep-mine' as const, confirm: true as const }
    expect(await f.owner.press(view, { ...resolve, path: 'other' }, 'foreign')).toMatchObject({ ok: false })
    expect(await f.owner.press(view, { ...resolve, option: 'union' }, 'unoffered')).toMatchObject({ ok: false })
    expect(f.execute).not.toHaveBeenCalled()
    await f.owner.press(view, resolve, 'resolve')
    expect(f.execute).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'sessions.resolveConflict',
      body: { session: { kind: 'sessionId', sessionId: 'session' }, path: 'file', option: 'keep-mine', confirm: true } }), expect.objectContaining({ callerKind: 'window' }))
    conflict.state = 'settled'
    expect(await f.owner.press(view, resolve, 'settled')).toMatchObject({ ok: false })
    await f.owner.press(view, { kind: 'clear-history', revision: 7 }, 'clear')
    expect(f.execute).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'sessions.clearActions',
      body: { session: { kind: 'sessionId', sessionId: 'session' } } }), expect.anything())
  })
})
