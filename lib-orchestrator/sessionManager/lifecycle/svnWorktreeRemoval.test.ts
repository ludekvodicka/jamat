import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { TreeRemovalListener } from '../../shared/treeRemoval'
import type { SvnResult, SvnWorktreeLocation } from '../../svn/svn.types'
import type { SessionRecord } from '../records/sessionRecord.types'
import { SessionRecordsStore } from '../records/sessionRecordsStore'
import type { SessionStepProgress } from '../sessionManagerApi.types'
import { type SessionStepFacts, SessionStepWords } from './sessionStepWords'
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

    purgeAside(_location: SvnWorktreeLocation, onProgress?: TreeRemovalListener): Promise<SvnResult<'removed' | 'undeleted'>> {
      this.log.push('purgeAside')
      onProgress?.({ phase: 'counting', done: 2, total: null })
      onProgress?.({ phase: 'counting', done: 3, total: null })
      onProgress?.({ phase: 'deleting', done: 2, total: 3 })
      onProgress?.({ phase: 'deleting', done: 3, total: 3 })
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
    const steps: { sessionId: string; facts: SessionStepFacts; progress: SessionStepProgress | null }[] = []
    const removal = new SvnWorktreeRemoval({
      records: store,
      svn,
      releaseBelow: (path) => { svn.log.push(`releaseBelow ${path}`); return Promise.resolve() },
      onQueue: async (work) => {
        await beforeQueue?.(store)
        return work()
      },
      changed: () => undefined,
      steps: { at: (sessionId, facts, progress = null) => { steps.push({ sessionId, facts, progress }) } },
      now: () => 7_000,
    })
    return { store, svn, removal, steps, location: SvnWorktreeRemoval.locationOf(worktree) }
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

  it('reports waiting, letting go, moving aside, counting, deleting and recording into the step, in order', async () => {
    const it_ = await harness()

    await it_.removal.remove('s1', it_.location, [])

    expect(it_.steps.every((step) => step.sessionId === 's1')).toBe(true)
    expect(it_.steps.map((step) => step.facts)).toEqual([
      'queue', 'release', 'rename', 'count', 'count', 'delete', 'delete', 'tombstone',
    ].map((phase) => ({ kind: 'removal', phase, path: worktreeConst })))
    expect(it_.steps.map((step) => step.progress)).toEqual([
      null, null, null, { done: 2, total: null }, { done: 3, total: null }, { done: 2, total: 3 }, { done: 3, total: 3 }, null,
    ])
    expect(it_.steps.map((step) => SessionStepWords.of(step.facts, step.progress))).toEqual([
      { text: 'Waiting for other operations', detail: worktreeConst },
      { text: 'Letting go of this client\'s reads', detail: worktreeConst },
      { text: 'Moving the worktree aside', detail: `${worktreeConst}.deleting` },
      { text: 'Counting the files to delete', detail: '2 files so far' },
      { text: 'Counting the files to delete', detail: '3 files so far' },
      { text: 'Removing the worktree', detail: '2 of 3 files' },
      { text: 'Removing the worktree', detail: '3 of 3 files' },
      { text: 'Recording the removal', detail: 'session record' },
    ])
  })

  it('names the count in the words of the step with grouped numbers', () => {
    const facts = (phase: 'count' | 'delete'): SessionStepFacts => ({ kind: 'removal', phase, path: worktreeConst })
    expect(SessionStepWords.of(facts('count'), { done: 23_000, total: null }).detail).toBe('23,000 files so far')
    expect(SessionStepWords.of(facts('count'), { done: 1, total: null }).detail).toBe('1 file so far')
    expect(SessionStepWords.of(facts('delete'), { done: 12_000, total: 30_001 }).detail).toBe('12,000 of 30,001 files')
    expect(SessionStepWords.of(facts('delete'), { done: 0, total: null }).detail).toBe(worktreeConst)
  })

  it('stops the step after the rename when a process holds the worktree, and before the rename when a reopen won', async () => {
    const held = await harness()
    held.svn.rename = 'in-use'
    await held.removal.remove('s1', held.location, [])
    expect(held.steps.map((step) => step.facts.kind === 'removal' ? step.facts.phase : step.facts.kind)).toEqual(['queue', 'release', 'rename'])

    const reopened = await harness({}, async (store) => {
      const current = store.get('s1')
      if (current?.life === 'ended') await store.put({ ...current, life: 'starting', pendingOperationId: 'op', pendingOperationKind: 'reopen' })
    })
    await reopened.removal.remove('s1', reopened.location, [])
    expect(reopened.steps.map((step) => step.facts.kind === 'removal' ? step.facts.phase : step.facts.kind)).toEqual(['queue'])
  })

  it('joins revision lists once each, by repository and number', () => {
    expect(SvnWorktreeRemoval.joined(['b:r2', 'a:r10'], ['a:r9', 'b:r2', 'hand-edited'])).toEqual(['a:r9', 'a:r10', 'b:r2', 'hand-edited'])
  })
})
