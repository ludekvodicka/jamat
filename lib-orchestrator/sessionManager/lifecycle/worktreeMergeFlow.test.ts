import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { GitResult, VersioningMode } from '../../git/git.types'
import type { MergeStatus } from '../../git/gitMergeManager'
import type { SessionLife, SessionRecord } from '../records/sessionRecord.types'
import { SessionRecordsStore } from '../records/sessionRecordsStore'
import type { SessionCreateSpec, SessionsOpResult } from '../sessionManagerApi.types'
import type { SessionMergePort } from './worktreeMergeFlow'
import { WorktreeMergeFlow } from './worktreeMergeFlow'

describe('lib-orchestrator/sessionManager/lifecycle/worktreeMergeFlow', () => {
  const rootConst = 'C:\\Projects\\NodeJs\\AppJamatV3'
  const worktreeConst = `${rootConst}\\.worktrees\\015-wizard`
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  /**
   * Every call recorded WITH ITS ARGUMENTS, every answer scriptable: what the flow decides is what
   * is under test, and which path it decides it about is half of that. A fake that took no
   * parameters could not tell `mergeStatus(worktreePath)` from `mergeStatus(repositoryRoot)`, and
   * that swap makes the dirty check read the main copy while the worktree is force-removed.
   */
  class FakeMerge implements SessionMergePort {
    readonly calls: (readonly string[])[] = []
    branch: string | null = 'main'
    status: MergeStatus = { inProgress: false, dirty: false, dirtyTracked: false, unresolved: false }
    merged = false
    conflict = false
    mainConflict = false
    /** Set only by the checkpoints-mode landing: the main copy took a commit of its own. */
    mainDiverged = false
    /** What the MAIN copy answers, when a case needs it to differ from the worktree's. */
    mainStatus: MergeStatus | null = null
    failures = new Map<string, string>()

    /** The call order alone, for the tests that are about order and nothing else. */
    get names(): string[] {
      return this.calls.map((call) => call[0])
    }

    currentBranch(repositoryRoot: string): Promise<GitResult<{ branch: string | null }>> {
      this.calls.push(['currentBranch', repositoryRoot])
      return this.answer('currentBranch', { branch: this.branch })
    }

    mergeStatus(path: string): Promise<GitResult<MergeStatus>> {
      this.calls.push(['mergeStatus', path])
      const status = path === rootConst && this.mainStatus !== null
        ? this.mainStatus
        : this.status
      return this.answer('mergeStatus', status)
    }

    /** Committing clears the tree, exactly as the real one does, so the merge that follows may run. */
    commitAll(worktreePath: string, message: string): Promise<GitResult<void>> {
      this.calls.push(['commitAll', worktreePath, message])
      if (!this.failures.has('commitAll'))
        this.status = { ...this.status, dirty: false, dirtyTracked: false }
      return this.answer('commitAll', undefined)
    }

    mergeIntoWorktree(worktreePath: string, baseBranch: string): Promise<GitResult<{ conflict: boolean }>> {
      this.calls.push(['mergeIntoWorktree', worktreePath, baseBranch])
      return this.answer('mergeIntoWorktree', { conflict: this.conflict })
    }

    isMerged(repositoryRoot: string, branch: string): Promise<GitResult<boolean>> {
      this.calls.push(['isMerged', repositoryRoot, branch])
      return this.answer('isMerged', this.merged)
    }

    /** Like the real one, this commits the WORKTREE's own tree, so it is clean from here on. */
    checkpointWorktree(worktreePath: string, message: string): Promise<GitResult<void>> {
      this.calls.push(['checkpointWorktree', worktreePath, message])
      if (!this.failures.has('checkpointWorktree'))
        this.status = { ...this.status, dirty: false, dirtyTracked: false }
      return this.answer('checkpointWorktree', undefined)
    }

    /** Like the real one, a checkpoint takes the main copy's uncommitted work into the store. */
    checkpointMain(repositoryRoot: string, message: string): Promise<GitResult<void>> {
      this.calls.push(['checkpointMain', repositoryRoot, message])
      if (!this.failures.has('checkpointMain') && this.mainStatus !== null)
        this.mainStatus = { ...this.mainStatus, dirty: false, dirtyTracked: false }
      return this.answer('checkpointMain', undefined)
    }

    mergeToMain(
      repositoryRoot: string,
      branch: string,
    ): Promise<GitResult<{ conflict: boolean; diverged?: boolean }>> {
      this.calls.push(['mergeToMain', repositoryRoot, branch])
      return this.answer('mergeToMain', {
        conflict: this.mainConflict,
        diverged: this.mainDiverged,
      })
    }

    removeWorktreeForced(repositoryRoot: string, worktreePath: string): Promise<GitResult<void>> {
      this.calls.push(['removeWorktreeForced', repositoryRoot, worktreePath])
      return this.answer('removeWorktreeForced', undefined)
    }

    deleteBranch(
      repositoryRoot: string,
      branch: string,
      force: boolean,
      _worktreePath: string,
    ): Promise<GitResult<void>> {
      this.calls.push([`deleteBranch:${force ? 'force' : 'safe'}`, repositoryRoot, branch])
      return this.answer('deleteBranch', undefined)
    }

    fails(call: string, detail: string): this {
      this.failures.set(call, detail)
      return this
    }

    private answer<T>(call: string, value: T): Promise<GitResult<T>> {
      const failure = this.failures.get(call)
      if (failure) return Promise.resolve({ ok: false, code: 'git-failed', detail: failure })
      return Promise.resolve({ ok: true, value })
    }
  }

  interface Harness {
    flow: WorktreeMergeFlow
    merge: FakeMerge
    store: SessionRecordsStore
    reports: string[]
    record: () => SessionRecord | null
  }

  async function harness(
    overrides: Partial<SessionRecord> = {},
    mode: VersioningMode = 'git',
  ): Promise<Harness> {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-merge-flow-'))
    created.push(root)
    const reports: string[] = []
    const store = await SessionRecordsStore.load(join(root, 'session-records.json'), {
      snapshotsDirectory: join(root, 'snapshots'),
      report: (message) => reports.push(message),
    })
    await store.put(recordOf(overrides))
    const merge = new FakeMerge()
    return {
      merge,
      store,
      reports,
      record: () => store.get('s1'),
      flow: new WorktreeMergeFlow({
        records: store,
        merge,
        report: (message) => reports.push(message),
        modeOf: () => mode,
        newId: () => 'op-1',
        now: () => 1_000,
      }),
    }
  }

  function recordOf(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      sessionId: 's1',
      kind: 'agent',
      title: '015 - wizard',
      createdAt: 0,
      life: 'ended' as SessionLife,
      directory: { mode: 'project', categoryId: 'nodejs', projectPath: rootConst },
      binding: null,
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
      worktree: {
        worktreePath: worktreeConst,
        branch: 'jamat/015-wizard',
        baseCommit: 'abc1234',
        repositoryRoot: rootConst,
      },
      ...overrides,
    }
  }

  function refusalOf(result: SessionsOpResult): { code: string; detail: string } {
    if (result.ok) throw new Error('expected a refusal')
    return { code: result.code, detail: result.detail }
  }

  it('merges base into the worktree first, then the branch into the main copy', async () => {
    const it_ = await harness()

    expect(await it_.flow.mergeSession('s1')).toEqual({ ok: true, value: undefined })
    // Asserted with the arguments, not just the order: which copy each question is asked about is
    // the difference between a refusal and a forced remove over uncommitted work.
    expect(it_.merge.calls).toEqual([
      ['currentBranch', rootConst],
      ['mergeStatus', worktreeConst],
      ['isMerged', rootConst, 'jamat/015-wizard'],
      ['mergeIntoWorktree', worktreeConst, 'main'],
      // The main copy is asked about ITSELF before anything is written into it.
      ['mergeStatus', rootConst],
      ['mergeToMain', rootConst, 'jamat/015-wizard'],
      ['removeWorktreeForced', rootConst, worktreeConst],
      ['deleteBranch:safe', rootConst, 'jamat/015-wizard'],
    ])
  })

  it('takes the worktree and the branch off the record when it is done', async () => {
    const it_ = await harness()
    await it_.flow.mergeSession('s1')

    expect(it_.record()?.worktree).toBeUndefined()
    expect(it_.record()?.worktreeMerge).toBeUndefined()
    // And the session is finished with. Stopping it was the person saying so; this is the after-step
    // that was still waiting, so this is the moment it becomes true.
    expect(it_.record()?.completed).toBe(true)
    // Nothing is reported: `report` reaches the user as an app error, and a merge that worked is
    // not one. The worktree leaving the row is what says it is done.
    expect(it_.reports).toEqual([])
  })

  /** The teardown removes the directory a live session is standing in. */
  it('refuses a session that is still running, and says to stop it', async () => {
    for (const life of ['live', 'starting'] as const) {
      const it_ = await harness({ life })
      const refusal = refusalOf(await it_.flow.mergeSession('s1'))

      expect(refusal.code).toBe('live-refused')
      expect(refusal.detail).toMatch(/stop it first/)
      expect(it_.merge.names).toEqual([])
    }
  })

  it('refuses a session that never had a worktree, and one that does not exist', async () => {
    const without = await harness({ worktree: undefined })
    expect(refusalOf(await without.flow.mergeSession('s1')).code).toBe('invalid-spec')
    expect(refusalOf(await without.flow.mergeSession('nope')).code).toBe('not-found')
  })

  it('refuses a detached main copy, because there is no branch to merge into', async () => {
    const it_ = await harness()
    it_.merge.branch = null

    expect(refusalOf(await it_.flow.mergeSession('s1')).detail).toMatch(/detached HEAD/)
    expect(it_.merge.names).toEqual(['currentBranch'])
  })

  it('refuses uncommitted work in the worktree rather than merging around it', async () => {
    const it_ = await harness()
    it_.merge.status = { inProgress: false, dirty: true, dirtyTracked: true, unresolved: false }

    const refusal = refusalOf(await it_.flow.mergeSession('s1'))
    expect(refusal.code).toBe('dirty')
    expect(refusal.detail).toMatch(/commit it first/)
    expect(it_.merge.names).not.toContain('mergeIntoWorktree')
  })

  describe('finishing with the session', () => {
    /** The refusal above is what Finish exists to get past: an agent leaves work uncommitted. */
    it('commits what the worktree was holding and then merges it home', async () => {
      const it_ = await harness({ title: '007 - fix' })
      it_.merge.status = { inProgress: false, dirty: true, dirtyTracked: true, unresolved: false }

      expect(await it_.flow.commitAndMerge('s1')).toEqual({ ok: true, value: undefined })
      expect(it_.merge.calls[1]).toEqual(['commitAll', worktreeConst, 'Finalize session 007 - fix'])
      expect(it_.merge.names).toContain('mergeToMain')
      expect(it_.record()?.worktree).toBeUndefined()
      expect(it_.record()?.completed).toBe(true)
    })

    it('commits nothing when the worktree was already clean', async () => {
      const it_ = await harness()

      expect(await it_.flow.commitAndMerge('s1')).toEqual({ ok: true, value: undefined })
      expect(it_.merge.names).not.toContain('commitAll')
      expect(it_.merge.names).toContain('mergeToMain')
    })

    /**
     * The one case where committing would do damage: a tree mid-merge can be holding conflict
     * markers, and `add --all` would commit them and then merge them home. It is answered as the
     * conflict it is, with resolve, commit and Finish again still open.
     */
    it('never commits over a merge that is still in progress', async () => {
      const it_ = await harness()
      it_.merge.status = { inProgress: true, dirty: true, dirtyTracked: true, unresolved: true }

      const refusal = refusalOf(await it_.flow.commitAndMerge('s1'))
      expect(refusal.code).toBe('merge-conflict')
      expect(it_.merge.names).not.toContain('commitAll')
      expect(it_.record()?.worktreeMerge?.phase).toBe('resolving')
    })

    /**
     * The case `inProgress` alone does not see. A conflicted rebase, cherry-pick, revert or `am`
     * leaves the same markers in the same files behind a different ref, and `add --all` would resolve
     * every one of them by staging what is on disk and then merge it home.
     */
    it('never commits over unmerged files, whatever left them unmerged', async () => {
      const it_ = await harness()
      it_.merge.status = { inProgress: false, dirty: true, dirtyTracked: true, unresolved: true }

      const refusal = refusalOf(await it_.flow.commitAndMerge('s1'))
      expect(refusal.code).toBe('dirty')
      expect(it_.merge.names).not.toContain('commitAll')
      expect(it_.merge.names).not.toContain('mergeToMain')
    })

    // Without a phase behind it the failure has nowhere to be written, and the row would go on
    // looking like a session nobody had tried to finish.
    it('leaves the failed commit on the record, where the row can say so', async () => {
      const it_ = await harness()
      it_.merge.status = { inProgress: false, dirty: true, dirtyTracked: true, unresolved: false }
      it_.merge.fails('commitAll', 'pre-commit hook refused')

      await it_.flow.commitAndMerge('s1')

      expect(it_.record()?.worktreeMerge?.failure).toMatch(/pre-commit hook refused/)
    })

    it('says what git said when the commit itself failed, and merges nothing', async () => {
      const it_ = await harness()
      it_.merge.status = { inProgress: false, dirty: true, dirtyTracked: true, unresolved: false }
      it_.merge.fails('commitAll', 'pre-commit hook refused')

      const refusal = refusalOf(await it_.flow.commitAndMerge('s1'))
      expect(refusal.detail).toMatch(/pre-commit hook refused/)
      expect(it_.merge.names).not.toContain('mergeIntoWorktree')
      expect(it_.record()?.worktree).toBeDefined()
    })

    // Pressing it again on a session that is already home does nothing destructive: the teardown
    // is idempotent and the record has no worktree left to act on.
    it('refuses a second press once the worktree is gone', async () => {
      const it_ = await harness()
      await it_.flow.commitAndMerge('s1')

      expect(refusalOf(await it_.flow.commitAndMerge('s1')).code).toBe('invalid-spec')
    })

    it('refuses a session that is still running, as the merge does', async () => {
      const it_ = await harness({ life: 'live' })

      expect(refusalOf(await it_.flow.commitAndMerge('s1')).code).toBe('live-refused')
      expect(it_.merge.names).toEqual([])
    })
  })

  /**
   * Conflicts are a state to be in. The phase is recorded so the tree can say so, and the worktree
   * is left as git left it, because that is what whoever resolves them has to look at.
   */
  describe("the user's own checkout", () => {
    /*
     * Plan 013e specified this guard and the code did not have it: the main merge ran into whatever
     * state that copy happened to be in, and reported git's own words afterwards. Everything here is
     * asked BEFORE `main-merging` is written, so a refusal costs the copy nothing.
     */
    it('refuses before the main merge when the copy holds uncommitted work', async () => {
      const it_ = await harness()
      it_.merge.mainStatus = { inProgress: false, dirty: true, dirtyTracked: true, unresolved: false }

      const refusal = refusalOf(await it_.flow.mergeSession('s1'))

      expect(refusal.code).toBe('dirty')
      expect(refusal.detail).toContain(rootConst)
      expect(it_.merge.names).not.toContain('mergeToMain')
      expect(it_.merge.names).not.toContain('removeWorktreeForced')
    })

    // Never aborted, ever: it is somebody's unfinished work in their own directory.
    it('refuses a copy that is already mid-merge, and touches nothing of it', async () => {
      const it_ = await harness()
      it_.merge.mainStatus = { inProgress: true, dirty: true, dirtyTracked: true, unresolved: true }

      const refusal = refusalOf(await it_.flow.mergeSession('s1'))

      expect(refusal.code).toBe('merge-pending')
      expect(refusal.detail).toContain(rootConst)
      expect(it_.merge.names).not.toContain('mergeToMain')
      expect(it_.merge.names).not.toContain('removeWorktreeForced')
      expect(it_.merge.names).not.toContain('deleteBranch:force')
    })

    // The one the whole design exists to prevent: git's conflict text matches no failure signature,
    // so this used to fall through as `git-failed` while the copy kept MERGE_HEAD and the markers.
    it('names a conflict in the main copy instead of calling it a git failure', async () => {
      const it_ = await harness()
      it_.merge.mainConflict = true

      const refusal = refusalOf(await it_.flow.mergeSession('s1'))

      expect(refusal.code).toBe('merge-pending')
      expect(refusal.detail).toContain('jamat/015-wizard')
      expect(refusal.detail).toContain(rootConst)
      expect(it_.merge.names).not.toContain('removeWorktreeForced')
      expect(it_.merge.names).not.toContain('deleteBranch:force')
    })

    // The guard asks the main copy and the worktree separately, and the two answers are different
    // questions: a clean main copy must not excuse a dirty worktree, or the force-remove that ends
    // every merge would take an afternoon's uncommitted work with it.
    it('asks the worktree and the main copy each about itself', async () => {
      const it_ = await harness()
      await it_.flow.mergeSession('s1')

      const asked = it_.merge.calls.filter((call) => call[0] === 'mergeStatus').map((call) => call[1])
      expect(asked).toEqual([worktreeConst, rootConst])
    })
  })

  it('stops at resolving on a conflict, keeping the phase and the reason', async () => {
    const it_ = await harness()
    it_.merge.conflict = true

    const refusal = refusalOf(await it_.flow.mergeSession('s1'))
    expect(refusal.code).toBe('merge-conflict')
    expect(refusal.detail).toMatch(/run Merge again/)
    expect(it_.record()?.worktreeMerge?.phase).toBe('resolving')
    expect(it_.record()?.worktree).toBeTruthy()
  })

  it('finds a merge already in progress and goes straight back to resolving', async () => {
    const it_ = await harness()
    it_.merge.status = { inProgress: true, dirty: true, dirtyTracked: true, unresolved: true }

    expect(refusalOf(await it_.flow.mergeSession('s1')).code).toBe('merge-conflict')
    // It did not try to merge again on top of the half-finished one.
    expect(it_.merge.names).not.toContain('mergeIntoWorktree')
  })

  /**
   * The crash case the write-ahead phase exists for: the main merge landed and the client died
   * before the teardown. Merging again would make an empty commit; what is left is the teardown.
   */
  it('skips the two merge steps when the branch is already contained', async () => {
    const it_ = await harness()
    it_.merge.merged = true

    expect(await it_.flow.mergeSession('s1')).toEqual({ ok: true, value: undefined })
    // The worktree is still asked about first. The shortcut skips the merging, never the question
    // that decides whether anything may be force-removed.
    expect(it_.merge.names).toEqual([
      'currentBranch',
      'mergeStatus',
      'isMerged',
      'removeWorktreeForced',
      'deleteBranch:safe',
    ])
  })

  /**
   * The one that costs an afternoon if it regresses. A branch is contained in HEAD from the moment
   * it is cut until its first commit, so `isMerged` answers true for every session whose agent has
   * not committed - no crash needed. If that answer were consulted before the worktree was asked
   * about, the teardown would run `worktree remove --force` over the work and report success.
   */
  it('refuses a dirty worktree even when the branch is already contained', async () => {
    const it_ = await harness()
    it_.merge.merged = true
    it_.merge.status = { inProgress: false, dirty: true, dirtyTracked: true, unresolved: false }

    const refusal = refusalOf(await it_.flow.mergeSession('s1'))
    expect(refusal.code).toBe('dirty')
    expect(refusal.detail).toMatch(/commit it first/)
    expect(it_.merge.names).not.toContain('removeWorktreeForced')
    expect(it_.record()?.worktree).toBeTruthy()
  })

  it('keeps the phase and writes the reason beside it when a step fails', async () => {
    const it_ = await harness()
    it_.merge.fails('mergeToMain', 'main is locked')

    const refusal = refusalOf(await it_.flow.mergeSession('s1'))
    expect(refusal.detail).toBe('main is locked')
    expect(it_.record()?.worktreeMerge?.phase).toBe('main-merging')
    expect(it_.record()?.worktreeMerge?.failure).toBe('main is locked')
    // And the worktree is still there, because nothing was torn down.
    expect(it_.record()?.worktree).toBeTruthy()
  })

  it('clears a previous failure when the same phase is attempted again', async () => {
    const it_ = await harness()
    it_.merge.fails('mergeToMain', 'main is locked')
    await it_.flow.mergeSession('s1')
    it_.merge.failures.clear()

    expect(await it_.flow.mergeSession('s1')).toEqual({ ok: true, value: undefined })
    expect(it_.record()?.worktreeMerge).toBeUndefined()
  })

  /** Two worktrees of one repository merging into the same HEAD is what git does not guard. */
  it('refuses a second merge into the same repository while one is running', async () => {
    const it_ = await harness()
    let release = (): void => {}
    it_.merge.mergeToMain = () => new Promise((resolve) => {
      release = () => resolve({ ok: true, value: { conflict: false } })
    })

    const first = it_.flow.mergeSession('s1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(refusalOf(await it_.flow.mergeSession('s1')).code).toBe('merge-pending')

    release()
    expect((await first).ok).toBe(true)
    // The lock is given back rather than held for ever: the next call gets past it and is refused
    // for the honest reason, which is that the merge it just finished took the worktree away.
    expect(refusalOf(await it_.flow.mergeSession('s1')).code).toBe('invalid-spec')
  })

  describe('the automatic resolver', () => {
    interface Launched {
      spec: SessionCreateSpec
      marks: { sessionId: string; oneShot: true; resolveFor: string }
    }

    /**
     * `false` launches; `'undecided'` and `'decided'` are the two ways `SessionLifecycle.create`
     * refuses, and the difference is what it leaves on disk. An undecided refusal - unreachable
     * Host, no lease, a 409/429/5xx - keeps the resolver's record `starting` under its pending pair
     * for the reconciler to replay; a decided one ends it. The fake writes what the real one writes,
     * because that record IS the question the flow asks.
     */
    async function withResolver(
      overrides: Partial<SessionRecord> = {},
      refuse: false | 'undecided' | 'decided' = false,
    ): Promise<Harness & { launched: Launched[] }> {
      const base = await harness(overrides)
      const launched: Launched[] = []
      const flow = new WorktreeMergeFlow({
        records: base.store,
        merge: base.merge,
        report: (message) => base.reports.push(message),
        newId: () => 'resolve-1',
        now: () => 1_000,
        launchResolve: async (spec, marks) => {
          launched.push({ spec, marks })
          if (refuse === false)
            return { ok: true as const, value: { sessionId: marks.sessionId } }
          await base.store.put({
            sessionId: marks.sessionId,
            kind: 'agent',
            title: 'Resolve merge',
            createdAt: 0,
            directory: { mode: 'adHoc', path: worktreeConst },
            binding: null,
            agent: { agentId: 'claude', launchMode: 'fork', oneShot: true },
            resolveFor: marks.resolveFor,
            ...(refuse === 'undecided'
              ? {
                life: 'starting' as SessionLife,
                pendingOperationId: 'op-r',
                pendingOperationKind: 'create' as const,
              }
              : { life: 'ended' as SessionLife, endedReason: 'the Host refused it' }),
          })
          return refuse === 'undecided'
            ? { ok: false as const, code: 'host-unreachable' as const, detail: 'no descriptor' }
            : { ok: false as const, code: 'invalid-spec' as const, detail: 'the Host refused it' }
        },
      })
      base.merge.conflict = true
      return { ...base, flow, launched }
    }

    /**
     * The conflict goes back to the conversation that caused it, forked, inside the worktree, in
     * print mode so the reconciler can judge it the way it judges an install.
     */
    it('forks the session own conversation into the worktree to resolve it', async () => {
      const it_ = await withResolver()

      const refusal = refusalOf(await it_.flow.mergeSession('s1'))
      expect(refusal.code).toBe('merge-conflict')
      expect(refusal.detail).toMatch(/being resolved/)

      expect(it_.launched).toHaveLength(1)
      const { spec, marks } = it_.launched[0]
      expect(spec.directory).toEqual({ mode: 'adHoc', path: worktreeConst })
      expect(spec.agent?.mode).toBe('fork')
      expect(spec.agent?.forkParentId).toBe('native-1')
      expect(spec.agent?.initialPrompt).toMatch(/Resolve every conflict/)
      expect(marks).toEqual({ sessionId: 'resolve-1', oneShot: true, resolveFor: 's1' })
    })

    /** Write-ahead: a crash between the pointer and the launch reads as a resolver that is gone. */
    it('writes the pointer to the resolver before it launches it', async () => {
      const it_ = await withResolver()
      await it_.flow.mergeSession('s1')

      expect(it_.record()?.worktreeMerge?.resolveSessionId).toBe('resolve-1')
      expect(it_.record()?.worktreeMerge?.phase).toBe('resolving')
    })

    it('takes the pointer back when the resolver was refused for good', async () => {
      const it_ = await withResolver({}, 'decided')

      const refusal = refusalOf(await it_.flow.mergeSession('s1'))
      // The manual path is what is left, and it is worded as such rather than as a launch failure.
      expect(refusal.detail).toMatch(/Resolve it in/)
      expect(it_.record()?.worktreeMerge?.resolveSessionId).toBeUndefined()
    })

    /*
     * The launch the Host never decided. `create` has already written the resolver's record under
     * its pending pair, so the reconciler replays it and an agent WILL run in that worktree. Taking
     * the pointer back would leave that agent named by nothing, and the next Merge would mint a
     * second resolver into the same conflict, both of them committing.
     */
    it('keeps the pointer while a refused launch is still going to be replayed', async () => {
      const it_ = await withResolver({}, 'undecided')

      const refusal = refusalOf(await it_.flow.mergeSession('s1'))

      expect(it_.record()?.worktreeMerge?.resolveSessionId).toBe('resolve-1')
      expect(refusal.detail).toMatch(/being retried/)
      expect(refusal.detail).not.toMatch(/Resolve it in/)
    })

    it('does not mint a second resolver over a launch that is being replayed', async () => {
      const it_ = await withResolver({}, 'undecided')
      await it_.flow.mergeSession('s1')
      await it_.flow.mergeSession('s1')

      expect(it_.launched).toHaveLength(1)
    })

    it('launches nothing a second time while one is already resolving', async () => {
      const it_ = await withResolver()
      await it_.flow.mergeSession('s1')
      await it_.flow.mergeSession('s1')

      expect(it_.launched).toHaveLength(1)
    })

    /**
     * The loop this closes: `merge-resolve-succeeded` writes nothing of its own, so a record left
     * with a `resolving` phase, a pointer and no failure is one the reconciler reaches the same
     * verdict on for ever. The second pass is what a resumed merge looks like, and it must leave a
     * shape the judgement will not pick up again.
     */
    it('writes a failure when the resolver finished and the conflict is still there', async () => {
      const it_ = await withResolver()
      await it_.flow.mergeSession('s1')
      expect(it_.record()?.worktreeMerge?.failure).toBeUndefined()

      // What `resumeMerge` does after the reconciler judged the resolver a success.
      const refusal = refusalOf(await it_.flow.mergeSession('s1'))

      expect(refusal.code).toBe('merge-conflict')
      expect(refusal.detail).toMatch(/still conflicts .* after the resolver ran/)
      expect(it_.record()?.worktreeMerge?.failure)
        .toBe('the resolver finished and the conflict is still there')
      // The phase and the pointer both stay: the tree still says `conflict` and still nests the
      // resolver under the session it ran for.
      expect(it_.record()?.worktreeMerge?.phase).toBe('resolving')
      expect(it_.record()?.worktreeMerge?.resolveSessionId).toBe('resolve-1')
    })

    /**
     * The same loop reached the other way, and the reason the guard belongs to every ending of
     * `run` rather than to the conflict path alone. The resolver committed and the conflict is
     * gone, but it left an untracked file, so the merge stops on `dirty` - which used to write
     * nothing at all and leave exactly the shape the judgement fires on, every two seconds, for
     * ever.
     */
    it('writes a failure when the resumed merge stops on a dirty worktree', async () => {
      const it_ = await withResolver()
      await it_.flow.mergeSession('s1')
      it_.merge.conflict = false
      it_.merge.status = { inProgress: false, dirty: true, dirtyTracked: true, unresolved: false }

      const refusal = refusalOf(await it_.flow.mergeSession('s1'))

      expect(refusal.code).toBe('dirty')
      expect(it_.record()?.worktreeMerge?.failure).toMatch(/holds uncommitted work/)
      expect(it_.record()?.worktreeMerge?.phase).toBe('resolving')
      expect(it_.record()?.worktreeMerge?.resolveSessionId).toBe('resolve-1')
    })

    /** The main copy sitting on a tag while the resolver ran is the same shape again. */
    it('writes a failure when the resumed merge finds a detached main copy', async () => {
      const it_ = await withResolver()
      await it_.flow.mergeSession('s1')
      it_.merge.conflict = false
      it_.merge.branch = null

      const refusal = refusalOf(await it_.flow.mergeSession('s1'))

      expect(refusal.code).toBe('git-failed')
      expect(it_.record()?.worktreeMerge?.failure).toMatch(/detached HEAD/)
    })

    /** And a git call that simply fails, which is the third way out that wrote nothing. */
    it('writes a failure when a git call in the resumed merge fails', async () => {
      const it_ = await withResolver()
      await it_.flow.mergeSession('s1')
      it_.merge.conflict = false
      it_.merge.failures.set('mergeStatus', 'index.lock is held')

      const refusal = refusalOf(await it_.flow.mergeSession('s1'))

      expect(refusal.detail).toBe('index.lock is held')
      expect(it_.record()?.worktreeMerge?.failure).toBe('index.lock is held')
    })

    /** And once the human has resolved it, the same button finishes the merge. */
    it('carries on when the conflict is gone, clearing the failure with the next phase', async () => {
      const it_ = await withResolver()
      await it_.flow.mergeSession('s1')
      await it_.flow.mergeSession('s1')
      it_.merge.conflict = false

      expect(await it_.flow.mergeSession('s1')).toEqual({ ok: true, value: undefined })
      expect(it_.record()?.worktree).toBeUndefined()
      expect(it_.record()?.worktreeMerge).toBeUndefined()
    })

    it('takes the manual path for a shell session, which has no conversation to fork', async () => {
      const it_ = await withResolver({ kind: 'shell', agent: undefined })

      expect(refusalOf(await it_.flow.mergeSession('s1')).detail).toMatch(/Resolve it in/)
      expect(it_.launched).toEqual([])
    })

    it('takes the manual path for an agent whose conversation was never named', async () => {
      const it_ = await withResolver({ agent: { agentId: 'claude', launchMode: 'new' } })

      expect(refusalOf(await it_.flow.mergeSession('s1')).detail).toMatch(/Resolve it in/)
      expect(it_.launched).toEqual([])
    })

    /** Codex has no print mode this build can judge, so it never launches something nobody reads. */
    it('takes the manual path for an agent with no print mode', async () => {
      const it_ = await withResolver({
        agent: { agentId: 'codex', launchMode: 'new', nativeSessionId: 'native-1' },
      })

      expect(refusalOf(await it_.flow.mergeSession('s1')).detail).toMatch(/Resolve it in/)
      expect(it_.launched).toEqual([])
    })
  })

  it('discards the worktree and the branch, saying nothing was merged', async () => {
    const it_ = await harness()

    expect(await it_.flow.discardWorktree('s1')).toEqual({ ok: true, value: undefined })
    expect(it_.merge.names).toEqual(['removeWorktreeForced', 'deleteBranch:force'])
    expect(it_.record()?.worktree).toBeUndefined()
    expect(it_.reports).toEqual([])
  })

  it('names a branch it could not delete after the directory was already gone', async () => {
    const it_ = await harness()
    it_.merge.fails('deleteBranch', 'branch is checked out somewhere')

    expect((await it_.flow.discardWorktree('s1')).ok).toBe(false)
    expect(it_.reports.some((line) => line.includes('jamat/015-wizard'))).toBe(true)
  })

  it('refuses a discard on a live session, exactly as a merge is refused', async () => {
    const it_ = await harness({ life: 'live' })
    expect(refusalOf(await it_.flow.discardWorktree('s1')).code).toBe('live-refused')
  })

  /**
   * The resolver is a SECOND session standing in that directory, and the primary record's own life
   * says nothing about it: by the time conflicts are being resolved the primary is ended, and the
   * agent working in the worktree is not.
   */
  it('refuses while a resolver is still running in the worktree it would delete', async () => {
    for (const life of ['live', 'starting'] as const) {
      const it_ = await harness({
        worktreeMerge: {
          phase: 'resolving',
          resolveSessionId: 'r1',
          startedAt: 1_000,
        },
      })
      await it_.store.put({ ...recordOf(), sessionId: 'r1', life, resolveFor: 's1' })

      for (const answer of [
        await it_.flow.discardWorktree('s1'),
        await it_.flow.mergeSession('s1'),
      ]) {
        expect(refusalOf(answer).code).toBe('live-refused')
        expect(refusalOf(answer).detail).toMatch(/r1 is resolving/)
      }
      expect(it_.merge.names).toEqual([])
    }
  })

  /** Write-ahead, the same as the merge: two destructive commands with no trace between them. */
  it('says it is tearing down before it removes anything', async () => {
    const it_ = await harness()
    it_.merge.fails('removeWorktreeForced', 'the worktree is locked')

    expect((await it_.flow.discardWorktree('s1')).ok).toBe(false)
    expect(it_.record()?.worktreeMerge?.phase).toBe('tearing-down')
    expect(it_.record()?.worktreeMerge?.failure).toBe('the worktree is locked')
    expect(it_.record()?.worktree).toBeTruthy()
  })

  /**
   * A discard stopped between its two commands used to be stuck for good: the second attempt died
   * on a removal git answers with `is not a working tree`. That answer is a success now, so the
   * button that failed is the button that finishes it.
   */
  it('finishes on the second press when the branch delete was what failed', async () => {
    const it_ = await harness()
    it_.merge.fails('deleteBranch', 'branch is checked out somewhere')
    expect((await it_.flow.discardWorktree('s1')).ok).toBe(false)
    expect(it_.record()?.worktree).toBeTruthy()

    it_.merge.failures.clear()
    expect(await it_.flow.discardWorktree('s1')).toEqual({ ok: true, value: undefined })
    expect(it_.record()?.worktree).toBeUndefined()
    expect(it_.record()?.worktreeMerge).toBeUndefined()
  })

  describe('in checkpoints mode', () => {
    const cleanConst: MergeStatus =
      { inProgress: false, dirty: false, dirtyTracked: false, unresolved: false }

    /**
     * The checkpoint has to come BEFORE the base goes into the worktree. That merge is what makes
     * the landing a fast-forward, so a checkpoint taken after it would move the main copy out from
     * under the branch that had just absorbed it and every landing would come back diverged.
     */
    it('checkpoints the main copy before anything else moves', async () => {
      const it_ = await harness({}, 'checkpoints')

      expect(await it_.flow.mergeSession('s1')).toEqual({ ok: true, value: undefined })

      expect(it_.merge.names).toEqual([
        'currentBranch',
        'mergeStatus',
        'checkpointWorktree',
        'isMerged',
        'checkpointMain',
        'mergeIntoWorktree',
        'mergeStatus',
        'mergeToMain',
        'removeWorktreeForced',
        'deleteBranch:safe',
      ])
      expect(it_.merge.calls.find((call) => call[0] === 'checkpointMain'))
        .toEqual(['checkpointMain', rootConst, 'Checkpoint in the main copy before merging jamat/015-wizard home'])
    })

    /**
     * The other half of the same idea, and the one that was wrong until 2026-08-28: a session leaves
     * its work on DISK, not in a commit. Refusing here asked the user to do by hand the one thing
     * this mode exists to do for them, and the bash twin got it worse still - it merged nothing and
     * reported a landing anyway.
     */
    it('checkpoints a worktree holding uncommitted work instead of refusing it', async () => {
      const it_ = await harness({}, 'checkpoints')
      it_.merge.status = { inProgress: false, dirty: true, dirtyTracked: true, unresolved: false }

      expect(await it_.flow.mergeSession('s1')).toEqual({ ok: true, value: undefined })
      expect(it_.merge.calls.find((call) => call[0] === 'checkpointWorktree'))
        .toEqual(['checkpointWorktree', worktreeConst, 'Checkpoint in the worktree on jamat/015-wizard before merging it home'])
      expect(it_.merge.names).toContain('mergeToMain')
    })

    /**
     * The shortcut reads a BRANCH, and a branch is contained in the main line from the moment it is
     * cut until its first commit lands. Asking it before the checkpoint is how a directory full of
     * work gets torn down as "already merged".
     */
    it('checkpoints the worktree before asking whether the branch is already merged', async () => {
      const it_ = await harness({}, 'checkpoints')
      it_.merge.status = { inProgress: false, dirty: true, dirtyTracked: true, unresolved: false }
      it_.merge.merged = true

      expect(await it_.flow.mergeSession('s1')).toEqual({ ok: true, value: undefined })
      expect(it_.merge.names.indexOf('checkpointWorktree'))
        .toBeLessThan(it_.merge.names.indexOf('isMerged'))
    })

    /** A checkpoint that cannot be written stops the run; nothing is torn down on a guess. */
    it('stops when the worktree cannot be checkpointed', async () => {
      const it_ = await harness({}, 'checkpoints')
      it_.merge.fails('checkpointWorktree', 'the store is locked')

      expect(refusalOf(await it_.flow.mergeSession('s1')).detail).toMatch(/the store is locked/)
      expect(it_.merge.names).not.toContain('mergeIntoWorktree')
      expect(it_.merge.names).not.toContain('removeWorktreeForced')
    })

    /**
     * The refusal this mode exists to remove. The user's own uncommitted work is a side of the merge
     * now, not an obstacle, so a dirty main copy no longer stops a merge.
     */
    it('merges over a main copy holding uncommitted tracked work', async () => {
      const it_ = await harness({}, 'checkpoints')
      it_.merge.mainStatus = { ...cleanConst, dirty: true, dirtyTracked: true }

      expect(await it_.flow.mergeSession('s1')).toEqual({ ok: true, value: undefined })

      expect(it_.merge.names).toContain('mergeToMain')
      expect(it_.record()?.worktree).toBeUndefined()
    })

    /** The same state in git mode is still a refusal, which is what keeps that mode unchanged. */
    it('still refuses a dirty main copy in git mode', async () => {
      const it_ = await harness({}, 'git')
      it_.merge.mainStatus = { ...cleanConst, dirty: true, dirtyTracked: true }

      const refused = await it_.flow.mergeSession('s1')

      expect(refused).toMatchObject({ ok: false, code: 'dirty' })
      expect(it_.merge.names).not.toContain('checkpointMain')
      expect(it_.merge.names).not.toContain('mergeToMain')
    })

    /** Nothing was written and nothing is broken: checkpoint the new state and land on top of it. */
    it('answers a main copy that moved on with run Merge again', async () => {
      const it_ = await harness({}, 'checkpoints')
      it_.merge.mainDiverged = true

      const stopped = await it_.flow.mergeSession('s1')

      expect(stopped).toMatchObject({ ok: false, code: 'merge-pending' })
      if (stopped.ok) return
      expect(stopped.detail).toContain('moved on while this merge ran')
      expect(stopped.detail).toContain('run Merge again')
      // The worktree is still there, because the second run is what finishes this.
      expect(it_.record()?.worktree).toBeDefined()
      expect(it_.merge.names).not.toContain('removeWorktreeForced')
    })

    /** A second run over the settled state converges, which is what makes that message true. */
    it('converges on the next run once the main copy stands still', async () => {
      const it_ = await harness({}, 'checkpoints')
      it_.merge.mainDiverged = true
      expect((await it_.flow.mergeSession('s1')).ok).toBe(false)

      it_.merge.mainDiverged = false
      expect(await it_.flow.mergeSession('s1')).toEqual({ ok: true, value: undefined })
      expect(it_.record()?.worktree).toBeUndefined()
    })

    /** Conflicts still live in the worktree, where the agent that made them can be asked. */
    it('leaves a conflict in the worktree exactly as git mode does', async () => {
      const it_ = await harness({}, 'checkpoints')
      it_.merge.conflict = true

      const stopped = await it_.flow.mergeSession('s1')

      expect(stopped.ok).toBe(false)
      expect(it_.merge.names).toContain('checkpointMain')
      expect(it_.merge.names).not.toContain('mergeToMain')
      expect(it_.record()?.worktree).toBeDefined()
    })

    /** A checkpoint that could not be taken stops the run before the worktree is touched. */
    it('stops when the main copy could not be checkpointed', async () => {
      const it_ = await harness({}, 'checkpoints')
      it_.merge.fails('checkpointMain', 'the store is locked')

      const failed = await it_.flow.mergeSession('s1')

      expect(failed.ok).toBe(false)
      if (failed.ok) return
      expect(failed.detail).toBe('the store is locked')
      expect(it_.merge.names).not.toContain('mergeIntoWorktree')
    })
  })
})
