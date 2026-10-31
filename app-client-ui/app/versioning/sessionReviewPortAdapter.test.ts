import { describe, expect, it } from 'vitest'

import { SessionReviewPortAdapter } from './sessionReviewPortAdapter'
import type { VersioningCommitProposeResult } from './versioningCommitManager'

describe('app-client-ui/app/versioning/sessionReviewPortAdapter', () => {
  const scopeConst = 'Q:/Work/App/.worktrees/014-fix'

  function adapterOf(answer: VersioningCommitProposeResult = { ok: true, scopeRoot: scopeConst }) {
    const calls: unknown[][] = []
    const adapter = new SessionReviewPortAdapter({
      propose: async (...args) => { calls.push(['propose', ...args]); return answer },
      forgetProposal: (...args) => { calls.push(['forget', ...args]) },
      proposalOf: (...args) => { calls.push(['read', ...args]); return '[library] Fix parsing' },
    })
    return { adapter, calls }
  }

  it('stores and forgets a proposal without a dialog or tab broker', async () => {
    const { adapter, calls } = adapterOf()
    expect(await adapter.propose({ sessionId: 's1', directory: scopeConst, message: 'Fix login' }))
      .toEqual({ ok: true, value: { scopeRoot: scopeConst } })
    adapter.forgetProposal('s1', scopeConst)
    expect(adapter.proposalOf('s1', scopeConst)).toBe('[library] Fix parsing')
    expect(calls).toEqual([['propose', 's1', scopeConst, 'Fix login'], ['forget', 's1', scopeConst], ['read', 's1', scopeConst]])
  })

  it.each([
    ['message-empty', 'invalid-spec'], ['message-too-long', 'invalid-spec'], ['no-working-copy', 'not-a-repo'],
    ['message-edited', 'message-edited'], ['message-prefix', 'message-unchecked'], ['busy', 'already-running'],
  ] as const)('names a %s proposal as %s', async (code, expected) => {
    const { adapter } = adapterOf({ ok: false, code, detail: 'refused' })
    expect(await adapter.propose({ sessionId: 's1', directory: scopeConst, message: 'x' }))
      .toEqual({ ok: false, code: expected, detail: 'refused' })
  })
})
