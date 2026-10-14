import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { SessionRecord, SessionRecordSvnAction } from '../records/sessionRecord.types'
import { SessionRecordsStore } from '../records/sessionRecordsStore'
import { SvnWaitNotices } from './svnWaitNotices'

describe('lib-orchestrator/sessionManager/notifies/svnWaitNotices', () => {
  const created: string[] = []
  afterAll(() => { for (const directory of created) rmSync(directory, { recursive: true, force: true }) })

  const action = (notice?: SessionRecordSvnAction['notice']): SessionRecordSvnAction => ({
    kind: 'finish', actionId: 'a1', stage: 'updating', root: 'Q:/w/.worktrees/014', checks: [], checkCursor: 0, rootCursor: 0,
    rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'cli', startedAt: 1,
    needs: { kind: 'incoming', reason: 'other commits changed this project: a.txt', at: 5 },
    ...notice === undefined ? {} : { notice },
  })
  const record = (sessionId: string, svnAction: SessionRecordSvnAction, notify = true): SessionRecord => ({
    sessionId, kind: 'shell', title: sessionId, createdAt: 0, life: 'ended', binding: null, directory: { mode: 'adHoc', path: 'Q:/w' },
    worktree: {
      worktreePath: 'Q:/w/.worktrees/014', branch: 'file:///r/trunk', baseCommit: 'r4', repositoryRoot: 'Q:/w', kind: 'svn',
      ...notify ? { caller: { notify: { sessionId: 'coordinator', text: 'status t1' } } } : {},
    },
    svnAction,
  })
  const storeOver = async (directory: string): Promise<SessionRecordsStore> =>
    SessionRecordsStore.load(join(directory, 'session-records.json'), { snapshotsDirectory: join(directory, 'snapshots'), report: () => undefined })

  it('lists the pending notice of a waiting worktree action whose caller named a line, and none other', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-wait-notices-'))
    created.push(directory)
    const store = await storeOver(directory)
    await store.put(record('w1', action({ id: 'n1', at: 5, attempts: 0, state: 'pending' })))
    await store.put(record('w2', action({ id: 'n2', at: 6, attempts: 0, state: 'delivered', settledAt: 7 })))
    await store.put(record('w3', action({ id: 'n3', at: 6, attempts: 0, state: 'pending' }), false))
    await store.put(record('w4', action()))
    expect(new SvnWaitNotices(() => store).pending()).toEqual([{ id: 'n1', sessionId: 'coordinator', text: 'status t1', at: 5, attempts: 0 }])
    expect(new SvnWaitNotices(() => null).pending()).toEqual([])
  })

  it('writes attempted, delivered and expired back on the notice, read again by a new store over the same records', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-wait-notices-'))
    created.push(directory)
    const store = await storeOver(directory)
    await store.put(record('w1', action({ id: 'n1', at: 5, attempts: 0, state: 'pending' })))
    await store.put(record('w2', action({ id: 'n2', at: 5, attempts: 0, state: 'pending' })))
    const notices = new SvnWaitNotices(() => store)
    await notices.note(['n1'], 'attempted', 9)
    await notices.note(['n2'], 'expired', 10)

    const later = await storeOver(directory)
    expect(later.get('w1')?.svnAction?.notice).toEqual({ id: 'n1', at: 5, attempts: 1, state: 'pending' })
    expect(later.get('w2')?.svnAction?.notice).toEqual({ id: 'n2', at: 5, attempts: 0, state: 'expired', settledAt: 10 })
    await new SvnWaitNotices(() => later).note(['n1'], 'delivered', 11)
    expect((await storeOver(directory)).get('w1')?.svnAction?.notice).toEqual({ id: 'n1', at: 5, attempts: 1, state: 'delivered', settledAt: 11 })
    // A settled notice is never written again; an unknown id touches nothing.
    await new SvnWaitNotices(() => later).note(['n1', 'nobody'], 'attempted', 12)
    expect(later.get('w1')?.svnAction?.notice?.attempts).toBe(1)
  })
})
