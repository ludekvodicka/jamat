import { describe, expect, it } from 'vitest'

import type { RemoteControlCommitStatusDto } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { TabControlBroker } from '../tabs/tabControlBroker'
import { SessionReviewPortAdapter } from './sessionReviewPortAdapter'

describe('app-client-ui/app/versioning/sessionReviewPortAdapter', () => {
  const scopeConst = 'Q:/Work/App/.worktrees/014-fix'

  function statusOf(state: RemoteControlCommitStatusDto['state'], extra: Partial<RemoteControlCommitStatusDto> = {}): RemoteControlCommitStatusDto {
    return {
      kind: 'commit-status', commitSessionId: 'c1', sessionId: 's1', vcs: 'svn', scopeRoot: scopeConst,
      state, closed: false, revision: null, detail: null, ...extra,
    }
  }

  /** Each status read takes the next answer; the last one repeats. */
  function adapterOf(answers: (RemoteControlCommitStatusDto | null)[], opened?: Awaited<ReturnType<TabControlBroker['openCommit']>>) {
    const calls: unknown[][] = []
    let pauses = 0
    let read = 0
    const adapter = new SessionReviewPortAdapter(
      {
        openCommit: (...args) => {
          calls.push(args)
          return Promise.resolve(opened ?? {
            ok: true,
            value: { kind: 'commit-opened', commitSessionId: 'c1', panelId: 'p1', windowId: 'main', scopeRoot: scopeConst, messageApplied: true },
          })
        },
      },
      { status: () => answers[Math.min(read++, answers.length - 1)] },
      (sessionId) => sessionId === 's1' ? 'App - 014 - fix login' : null,
      () => { pauses += 1; return Promise.resolve() },
    )
    return { adapter, calls, pauses: () => pauses }
  }

  it('opens an SVN review of the scope in the session tab with the proposal', async () => {
    const { adapter, calls } = adapterOf([])

    expect(await adapter.open({ sessionId: 's1', scopeRoot: scopeConst, proposal: 'fix login' }))
      .toEqual({ ok: true, value: { commitSessionId: 'c1' } })
    expect(calls).toEqual([['s1', 'App - 014 - fix login', 'svn', scopeConst, 'fix login', { fresh: true }]])
  })

  it('accepts the review of the same scope spelled another way and refuses a review of another scope', async () => {
    const opened = (scopeRoot: string): Awaited<ReturnType<TabControlBroker['openCommit']>> => ({
      ok: true,
      value: { kind: 'commit-opened', commitSessionId: 'c1', panelId: 'p1', windowId: 'main', scopeRoot, messageApplied: true },
    })
    const respelled = process.platform === 'win32' ? scopeConst.toLowerCase().replaceAll('/', '\\') : `${scopeConst}/`
    expect(await adapterOf([], opened(respelled)).adapter.open({ sessionId: 's1', scopeRoot: scopeConst, proposal: 'x' }))
      .toEqual({ ok: true, value: { commitSessionId: 'c1' } })

    expect(await adapterOf([], opened('Q:/Work/App')).adapter.open({ sessionId: 's1', scopeRoot: scopeConst, proposal: 'x' }))
      .toEqual({
        ok: false,
        code: 'review-unavailable',
        detail: `The commit dialog reviews Q:/Work/App, not ${scopeConst}; nothing it commits counts for this finish`,
      })
  })

  it('names why a review could not be opened', async () => {
    const refused = adapterOf([], { ok: false, error: { code: 'operation-failed', detail: 'not inside an SVN working copy' } })
    expect(await refused.adapter.open({ sessionId: 's1', scopeRoot: scopeConst, proposal: 'x' }))
      .toEqual({ ok: false, code: 'review-unavailable', detail: 'not inside an SVN working copy' })

    const unknown = adapterOf([])
    expect(await unknown.adapter.open({ sessionId: 'gone', scopeRoot: scopeConst, proposal: 'x' }))
      .toMatchObject({ ok: false, code: 'not-found' })
    expect(unknown.calls).toEqual([])
  })

  // A failed attempt with the pane still open is a step of the review, never its outcome.
  it('waits through editing, running and an open failure for the commit and its revision', async () => {
    const { adapter, pauses } = adapterOf([
      statusOf('editing'), statusOf('running'), statusOf('failed', { detail: 'File is locked' }),
      statusOf('committed', { revision: '4127', closed: true }),
    ])

    expect(await adapter.settled('c1', new AbortController().signal)).toEqual({ state: 'committed', revision: '4127' })
    expect(pauses()).toBe(3)
  })

  it('reads a closed review as cancelled, failed, external or lost', async () => {
    const signal = new AbortController().signal
    expect(await adapterOf([statusOf('cancelled', { closed: true })]).adapter.settled('c1', signal)).toEqual({ state: 'cancelled' })
    expect(await adapterOf([statusOf('external-closed')]).adapter.settled('c1', signal)).toEqual({ state: 'external-closed' })
    expect(await adapterOf([null]).adapter.settled('c1', signal)).toEqual({ state: 'lost' })
    expect(await adapterOf([statusOf('failed', { closed: true, detail: 'svn: E155011: File is out of date' })]).adapter.settled('c1', signal))
      .toEqual({ state: 'failed', reason: 'svn: E155011: File is out of date', outOfDate: true })
    expect(await adapterOf([statusOf('failed', { closed: true, detail: 'File is locked' })]).adapter.settled('c1', signal))
      .toEqual({ state: 'failed', reason: 'File is locked', outOfDate: false })
  })

  it('stops waiting once the client stops', async () => {
    const stopping = new AbortController()
    stopping.abort()

    await expect(adapterOf([statusOf('editing')]).adapter.settled('c1', stopping.signal)).rejects.toThrow()
  })
})
