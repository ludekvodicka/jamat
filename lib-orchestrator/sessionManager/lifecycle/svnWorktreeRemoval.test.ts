import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SvnResult, SvnWorktreeLocation } from '../../svn/svn.types'
import type { SessionRecord } from '../records/sessionRecord.types'
import { SessionRecordsStore } from '../records/sessionRecordsStore'
import { type SvnRemovalPort, SvnWorktreeRemoval } from './svnWorktreeRemoval'

describe('lib-orchestrator/sessionManager/lifecycle/svnWorktreeRemoval', () => {
  const ownerConst = 'Q:\\Work\\App'
  const worktreeConst = `${ownerConst}\\.worktrees\\014-fix`
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  class FakeSvn implements SvnRemovalPort {
    readonly log: string[] = []
    rename: 'renamed' | 'in-use' | 'absent' | { ok: false; detail: string } = 'renamed'
    purge: 'removed' | 'undeleted' = 'removed'

    renameAside(location: SvnWorktreeLocation): Promise<SvnResult<'renamed' | 'in-use' | 'absent'>> {
      this.log.push(`renameAside ${location.worktreePath} ${location.directoryId ?? '-'}`)
      return Promise.resolve(typeof this.rename === 'string'
        ? { ok: true, value: this.rename }
        : { ok: false, code: 'refused', detail: this.rename.detail })
    }

    purgeAside(): Promise<SvnResult<'removed' | 'undeleted'>> {
      this.log.push('purgeAside')
      return Promise.resolve({ ok: true, value: this.purge })
    }

    removeEmptyWorktreesDir(ownerDir: string): Promise<void> {
      this.log.push(`removeEmptyWorktreesDir ${ownerDir}`)
      return Promise.resolve()
    }
  }

  async function harness(overrides: Partial<SessionRecord> = {}, beforeQueue?: (store: SessionRecordsStore) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-svn-removal-'))
    created.push(root)
    const store = await SessionRecordsStore.load(join(root, 'session-records.json'), { snapshotsDirectory: join(root, 'snapshots') })
    const worktree = { worktreePath: worktreeConst, branch: 'https://svn.test/app/trunk', baseCommit: 'r10', repositoryRoot: ownerConst, kind: 'svn' as const, directoryId: '1:2:3' }
    await store.put({
      sessionId: 's1', kind: 'shell', title: 't', createdAt: 0, life: 'ended', binding: null, directory: { mode: 'default' },
      worktree, worktreeCleanup: { phase: 'pending', trigger: 'committed', requestedAt: 1, attempts: 1 }, ...overrides,
    })
    const svn = new FakeSvn()
    const removal = new SvnWorktreeRemoval({
      records: store,
      svn,
      releaseBelow: (path) => { svn.log.push(`releaseBelow ${path}`); return Promise.resolve() },
      onQueue: async (work) => {
        await beforeQueue?.(store)
        return work()
      },
      changed: () => undefined,
      now: () => 7_000,
    })
    return { store, svn, removal, location: SvnWorktreeRemoval.locationOf(worktree) }
  }

  it('releases its own handles, renames aside by identity, purges and leaves a tombstone with every revision', async () => {
    const it_ = await harness({
      worktreeOutcome: { result: 'partial', revisions: ['https://svn.test/app:r12'], main: 'none', worktree: 'kept', lines: [], at: 1 },
    })

    expect(await it_.removal.remove('s1', it_.location, ['https://svn.test/app:r14', 'https://svn.test/app:r12']))
      .toEqual({ state: 'removed', lines: ['   worktree removed'] })
    expect(it_.svn.log).toEqual([
      `releaseBelow ${worktreeConst}`, `renameAside ${worktreeConst} 1:2:3`, 'purgeAside', `removeEmptyWorktreesDir ${ownerConst}`,
    ])
    const record = it_.store.get('s1')
    expect(record?.worktree).toBeUndefined()
    expect(record?.worktreeCleanup).toBeUndefined()
    expect(record?.completed).toBe(true)
    expect(record?.retiredWorktree).toEqual({
      worktreePath: worktreeConst, kind: 'svn', revisions: ['https://svn.test/app:r12', 'https://svn.test/app:r14'], removedAt: 7_000,
      ownerDir: ownerConst, directoryId: '1:2:3',
    })
  })

  it('keeps the caller of the worktree on the tombstone, so a later result still carries its tag', async () => {
    const caller = { tag: 'run-7', notify: { sessionId: 'coordinator', text: 'wake' } }
    const it_ = await harness()
    await it_.store.put({ ...it_.store.get('s1')!, worktree: { ...it_.store.get('s1')!.worktree!, caller } })

    await it_.removal.remove('s1', it_.location, [])

    expect(it_.store.get('s1')?.retiredWorktree?.caller).toEqual(caller)
  })

  it('counts a worktree already renamed aside or gone as removed', async () => {
    const it_ = await harness()
    it_.svn.rename = 'absent'

    expect(await it_.removal.remove('s1', it_.location, [])).toMatchObject({ state: 'removed' })
  })

  it('keeps the worktree whole when a process holds it, a purge leaves a rest, or another directory stands there', async () => {
    const held = await harness()
    held.svn.rename = 'in-use'
    expect(await held.removal.remove('s1', held.location, [])).toMatchObject({ state: 'in-use', lines: [expect.stringMatching(/^IN USE: /)] })
    expect(held.store.get('s1')?.worktree).toBeDefined()

    const half = await harness()
    half.svn.purge = 'undeleted'
    expect(await half.removal.remove('s1', half.location, [])).toMatchObject({ state: 'undeleted' })

    const foreign = await harness()
    foreign.svn.rename = { ok: false, detail: `${worktreeConst} is another directory than the worktree this session created` }
    expect(await foreign.removal.remove('s1', foreign.location, [])).toEqual({
      state: 'kept', lines: [`ERROR: ${worktreeConst} is another directory than the worktree this session created; the worktree is kept`],
    })
  })

  it('touches nothing when a reopen won the queue', async () => {
    const it_ = await harness({}, async (store) => {
      const current = store.get('s1')
      if (current?.life === 'ended') await store.put({ ...current, life: 'starting', pendingOperationId: 'op', pendingOperationKind: 'reopen' })
    })

    expect(await it_.removal.remove('s1', it_.location, [])).toEqual({ state: 'kept', lines: [`KEPT: session s1 runs again, so ${worktreeConst} stays`] })
    expect(it_.svn.log).toEqual([])
  })

  it('joins revision lists once each, by repository and number', () => {
    expect(SvnWorktreeRemoval.joined(['b:r2', 'a:r10'], ['a:r9', 'b:r2', 'hand-edited'])).toEqual(['a:r9', 'a:r10', 'b:r2', 'hand-edited'])
  })
})
