import { describe, expect, it, vi } from 'vitest'

import type { SessionRecord, SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import { SvnWorktreeSession } from './svnWorktreeSession'

describe('lib-orchestrator/worktrees/removal/svnWorktreeSession', () => {
  const ownerConst = 'Q:\\Work\\App'
  const worktreeConst = `${ownerConst}\\.worktrees\\005-j11-w5`
  const receiptConst = { repository: 'https://svn.test/repos/app', revision: 7, label: 'receipt' as const }

  const ended: SessionRecord = {
    sessionId: 's1', kind: 'agent', title: '005 - j11 w5', createdAt: 0, life: 'ended', binding: null,
    directory: { mode: 'project', categoryId: 'work', projectPath: ownerConst },
    worktree: { worktreePath: worktreeConst, branch: 'https://svn.test/repos/app/trunk', baseCommit: 'r6', repositoryRoot: ownerConst, kind: 'svn' },
    worktreeCleanup: { phase: 'pending', trigger: 'requested', requestedAt: 1, attempts: 0 },
  }

  function sessionOf(after: SessionRecord | null) {
    let current: SessionRecord | null = ended
    const remove = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const session = new SvnWorktreeSession({
      records: () => ({ get: () => current }) as unknown as SessionRecordsStore,
      commitHashes: async () => ({ ok: true, value: {} }),
      requestCleanup: async () => ({ ok: true, value: undefined }),
      clean: async () => { current = after },
      remove,
    })
    return { session, remove }
  }

  it('keeps the landed row its cleanup left, so the UPDATE of the main copy stays offered (UA1-J11-3)', async () => {
    const { worktree: _, worktreeCleanup: __, ...rest } = ended
    const landed: SessionRecord = { ...rest,
      retiredWorktree: { worktreePath: worktreeConst, kind: 'svn', revisions: ['https://svn.test/repos/app:r7'], removedAt: 2, ownerDir: ownerConst, landed: [receiptConst] } }
    const { session, remove } = sessionOf(landed)

    expect(await session.removeWithSession(ended)).toEqual({ ok: true, value: undefined })
    expect(remove).not.toHaveBeenCalled()
  })

  it('removes the session whose cleanup removed a worktree that landed nothing', async () => {
    const { worktree: _, worktreeCleanup: __, ...rest } = ended
    const { session, remove } = sessionOf({ ...rest,
      retiredWorktree: { worktreePath: worktreeConst, kind: 'svn', revisions: [], removedAt: 2, ownerDir: ownerConst }, completed: true })

    expect(await session.removeWithSession(ended)).toEqual({ ok: true, value: undefined })
    expect(remove).toHaveBeenCalledWith('s1')
  })
})
