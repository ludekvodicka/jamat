import { describe, expect, it } from 'vitest'

import type { RemoteControlCommitStatusDto } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { TabControlBroker } from '../tabs/tabControlBroker'
import { SessionReviewPortAdapter } from './sessionReviewPortAdapter'
import type { VersioningCommitProposeResult } from './versioningCommitManager'

describe('app-client-ui/app/versioning/sessionReviewPortAdapter', () => {
  const scopeConst = 'Q:/Work/App/.worktrees/014-fix'

  function statusOf(state: RemoteControlCommitStatusDto['state'], extra: Partial<RemoteControlCommitStatusDto> = {}): RemoteControlCommitStatusDto {
    return {
      kind: 'commit-status', commitSessionId: 'c1', sessionId: 's1', vcs: 'svn', scopeRoot: scopeConst,
      state, closed: false, revision: null, detail: null, ...extra,
    }
  }

  /** Each status read takes the next answer; the last one repeats. */
  function adapterOf(answers: (RemoteControlCommitStatusDto | null)[], opened?: Awaited<ReturnType<TabControlBroker['openCommit']>>,
    proposeAnswer: VersioningCommitProposeResult = { ok: true, scopeRoot: scopeConst }) {
    const calls: unknown[][] = []
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
      {
        status: () => answers[Math.min(read++, answers.length - 1)],
        propose: async (...args) => {
          calls.push(['propose', ...args])
          return proposeAnswer
        },
        proposalOf: (sessionId, scopeRoot) => sessionId === 's1' && scopeRoot === scopeConst ? 'Fix login' : null,
        forgetProposal: (...args) => { calls.push(['forget', ...args]) },
      },
      (sessionId) => sessionId === 's1' ? 'App - 014 - fix login' : sessionId === 'parent' ? 'App - 013 - parent' : null,
    )
    return { adapter, calls }
  }

  it('opens an SVN review of the scope in the session tab with the proposal', async () => {
    const { adapter, calls } = adapterOf([])

    expect(await adapter.open({ sessionId: 's1', parentId: 'gone-parent', scopeRoot: scopeConst, proposal: 'fix login' }))
      .toEqual({ ok: true, value: { commitSessionId: 'c1' } })
    expect(calls).toEqual([['s1', 'App - 014 - fix login', 'svn', scopeConst, 'fix login', { fresh: true }]])
  })

  it("hands the broker the parent's workflow to return to once the review settles", async () => {
    const { adapter, calls } = adapterOf([])

    expect(await adapter.open({ sessionId: 's1', parentId: 'parent', scopeRoot: scopeConst, proposal: 'fix login' }))
      .toEqual({ ok: true, value: { commitSessionId: 'c1' } })
    expect(calls).toEqual([['s1', 'App - 014 - fix login', 'svn', scopeConst, 'fix login',
      { fresh: true, returnToWorkflow: { sessionId: 'parent', tabTitle: 'App - 013 - parent' } }]])
  })

  it('accepts the review of the same scope spelled another way and refuses a review of another scope', async () => {
    const opened = (scopeRoot: string): Awaited<ReturnType<TabControlBroker['openCommit']>> => ({
      ok: true,
      value: { kind: 'commit-opened', commitSessionId: 'c1', panelId: 'p1', windowId: 'main', scopeRoot, messageApplied: true },
    })
    const respelled = process.platform === 'win32' ? scopeConst.toLowerCase().replaceAll('/', '\\') : `${scopeConst}/`
    expect(await adapterOf([], opened(respelled)).adapter.open({ sessionId: 's1', parentId: 'gone-parent', scopeRoot: scopeConst, proposal: 'x' }))
      .toEqual({ ok: true, value: { commitSessionId: 'c1' } })

    expect(await adapterOf([], opened('Q:/Work/App')).adapter.open({ sessionId: 's1', parentId: 'gone-parent', scopeRoot: scopeConst, proposal: 'x' }))
      .toEqual({
        ok: false,
        code: 'review-unavailable',
        detail: `The commit dialog reviews Q:/Work/App, not ${scopeConst}; nothing it commits counts for this finish`,
      })
  })

  it('names why a review could not be opened', async () => {
    const refused = adapterOf([], { ok: false, error: { code: 'operation-failed', detail: 'not inside an SVN working copy' } })
    expect(await refused.adapter.open({ sessionId: 's1', parentId: 'gone-parent', scopeRoot: scopeConst, proposal: 'x' }))
      .toEqual({ ok: false, code: 'review-unavailable', detail: 'not inside an SVN working copy' })

    const unknown = adapterOf([])
    expect(await unknown.adapter.open({ sessionId: 'gone', parentId: 'gone-parent', scopeRoot: scopeConst, proposal: 'x' }))
      .toMatchObject({ ok: false, code: 'not-found' })
    expect(unknown.calls).toEqual([])
  })

  // The review run waits for the status itself; the library only asks whether the dialog still knows it.
  it('knows a review the commit dialog holds and forgets one it lost with a restart', () => {
    expect(adapterOf([statusOf('editing')]).adapter.known('c1')).toBe(true)
    expect(adapterOf([null]).adapter.known('c1')).toBe(false)
  })

  it('keeps a proposal through the commit dialog without opening a review, and reads it back', async () => {
    const { adapter, calls } = adapterOf([])
    expect(await adapter.propose({ sessionId: 's1', directory: scopeConst, message: 'Fix login' }))
      .toEqual({ ok: true, value: { scopeRoot: scopeConst } })
    expect(calls).toEqual([['propose', 's1', scopeConst, 'Fix login']])
    expect(adapter.proposalOf('s1', scopeConst)).toBe('Fix login')
    expect(adapter.proposalOf('s1', 'Q:/Work/App')).toBeNull()
    adapter.forgetProposal('s1', scopeConst)
    expect(calls.at(-1)).toEqual(['forget', 's1', scopeConst])
  })

  it.each([
    ['message-empty', 'invalid-spec'], ['message-too-long', 'invalid-spec'], ['no-working-copy', 'not-a-repo'],
    ['message-edited', 'message-edited'], ['busy', 'already-running'],
  ] as const)('names a %s proposal as %s', async (code, expected) => {
    const { adapter } = adapterOf([], undefined, { ok: false, code, detail: 'refused' })
    expect(await adapter.propose({ sessionId: 's1', directory: scopeConst, message: 'x' }))
      .toEqual({ ok: false, code: expected, detail: 'refused' })
  })
})
