import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  SvnBounds,
  SvnLoggedRow,
  SvnMainUpdate,
  SvnResult,
  SvnRoot,
  SvnStatusRow,
  SvnUnlanded,
  SvnWorktreeFacts,
  SvnWorktreeLocation,
  SvnWorktreeUpdate,
} from '../../svn/svn.types'
import type { SessionRecord } from '../records/sessionRecord.types'
import { SessionRecordsStore } from '../records/sessionRecordsStore'
import type { SessionsOpResult } from '../sessionManagerApi.types'
import type { SessionReviewPort, SessionReviewSettled } from '../sessionReviewPort.types'
import { type SvnFinishPort, SvnWorktreeFinishFlow } from './svnWorktreeFinishFlow'
import { WorktreeCleanupPacing } from './worktreeCleanupPacing'

describe('lib-orchestrator/sessionManager/lifecycle/svnWorktreeFinishFlow', () => {
  const ownerConst = 'Q:\\Work\\App'
  const worktreeConst = `${ownerConst}\\.worktrees\\014-fix-login`
  const mountConst = `${worktreeConst}\\lib`
  const urlConst = 'https://svn.test/repos/app/trunk'
  const repositoryConst = 'https://svn.test/repos/app'
  const sharedConst = 'https://svn.test/repos/shared'
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  const row = (path: string, kind: SvnStatusRow['kind'] = 'item'): SvnStatusRow => ({ kind, conflict: false, path })
  const logged = (revision: number, path: string, action: SvnLoggedRow['action'] = 'M'): SvnLoggedRow => ({ revision, action, path })
  const worktreeRoot = (changed: SvnStatusRow[]): SvnRoot => ({ path: worktreeConst, own: '', changed })
  const mountRoot = (changed: SvnStatusRow[]): SvnRoot => ({ path: mountConst, own: 'lib', changed })
  const ok = <T>(value: T): SvnResult<T> => ({ ok: true, value })

  /** Every call in order, the shared log of the svn fake, the holders and the review port. */
  class FakeSvn implements SvnFinishPort {
    readonly log: string[]
    ownerRefusal: string | null = null
    rootsValue: SvnRoot[] = [worktreeRoot([])]
    recoverableByOwn: Record<string, SvnLoggedRow[]> = {}
    updates: SvnWorktreeUpdate[] = []
    bounds: SvnBounds = { '': { repository: repositoryConst, base: '/trunk', rootBase: 10, since: 11 } }
    reviewedByRevision: Record<number, SvnLoggedRow[]> = {}
    provenByOwn: Record<string, SvnLoggedRow[] | string> = {}
    changesByPath: Record<string, SvnStatusRow[]> = {}
    main: SvnMainUpdate = { main: 'updated', lines: [] }
    readonly mainRows: SvnLoggedRow[][] = []
    rename: 'renamed' | 'in-use' | 'absent' | Error = 'renamed'
    purge: 'removed' | 'undeleted' = 'removed'
    unlandedValue: SvnUnlanded[] | string = []
    presentValue = true

    constructor(log: string[]) {
      this.log = log
    }

    ownerCheck(): Promise<SvnResult<void>> {
      this.log.push('ownerCheck')
      return Promise.resolve(this.ownerRefusal === null ? ok(undefined) : { ok: false, code: 'refused', detail: this.ownerRefusal })
    }

    roots(): Promise<SvnResult<SvnRoot[]>> {
      this.log.push('roots')
      return Promise.resolve(ok(this.rootsValue))
    }

    recoverable(root: SvnRoot): Promise<SvnResult<SvnLoggedRow[]>> {
      this.log.push(`recoverable ${root.own}`)
      return Promise.resolve(ok(this.recoverableByOwn[root.own] ?? []))
    }

    updateWorktree(): Promise<SvnResult<SvnWorktreeUpdate>> {
      this.log.push('updateWorktree')
      const next = this.updates.length > 1 ? this.updates.shift() : this.updates[0]
      if (next === undefined) throw new Error('no update scripted')
      return Promise.resolve(ok(next))
    }

    lowerBounds(roots: readonly SvnRoot[]): Promise<SvnResult<SvnBounds>> {
      this.log.push(`lowerBounds ${roots.map((root) => root.own || '.').join(',')}`)
      return Promise.resolve(ok(this.bounds))
    }

    proven(root: SvnRoot): Promise<SvnResult<SvnLoggedRow[]>> {
      this.log.push(`proven ${root.own}`)
      const proof = this.provenByOwn[root.own] ?? []
      return Promise.resolve(typeof proof === 'string' ? { ok: false, code: 'refused', detail: proof } : ok(proof))
    }

    reviewed(root: SvnRoot, _bounds: SvnBounds, revision: number): Promise<SvnResult<SvnLoggedRow[]>> {
      this.log.push(`reviewed ${root.own} r${revision}`)
      const rows = this.reviewedByRevision[revision]
      return Promise.resolve(rows === undefined
        ? { ok: false, code: 'refused', detail: `SVN history does not confirm review revision r${revision}` }
        : ok(rows))
    }

    changes(path: string): Promise<SvnResult<SvnStatusRow[]>> {
      this.log.push(`changes ${path}`)
      return Promise.resolve(ok(this.changesByPath[path] ?? []))
    }

    updateMain(mainCopy: string, landed: readonly SvnLoggedRow[]): Promise<SvnResult<SvnMainUpdate>> {
      this.log.push(`updateMain ${mainCopy}`)
      this.mainRows.push([...landed])
      return Promise.resolve(ok(this.main))
    }

    renameAside(location: SvnWorktreeLocation): Promise<SvnResult<'renamed' | 'in-use' | 'absent'>> {
      this.log.push(`renameAside ${location.worktreePath} ${location.directoryId ?? '-'}`)
      return this.rename instanceof Error ? Promise.reject(this.rename) : Promise.resolve(ok(this.rename))
    }

    purgeAside(): Promise<SvnResult<'removed' | 'undeleted'>> {
      this.log.push('purgeAside')
      return Promise.resolve(ok(this.purge))
    }

    removeEmptyWorktreesDir(ownerDir: string): Promise<void> {
      this.log.push(`removeEmptyWorktreesDir ${ownerDir}`)
      return Promise.resolve()
    }

    facts(): Promise<SvnResult<SvnWorktreeFacts>> {
      return Promise.resolve(ok({ added: 3, removed: 1, changedFiles: 2 }))
    }

    unlanded(worktreePath: string, mainCopy: string): Promise<SvnResult<SvnUnlanded[]>> {
      this.log.push(`unlanded ${worktreePath} ${mainCopy}`)
      const value = this.unlandedValue
      return Promise.resolve(typeof value === 'string' ? { ok: false, code: 'svn-failed', detail: value } : ok(value))
    }

    present(worktreePath: string): Promise<boolean> {
      this.log.push(`present ${worktreePath}`)
      return Promise.resolve(this.presentValue)
    }
  }

  /** Reviews open as c1, c2, ...; each settles when the test says so, or at once when scripted. */
  class FakeReview implements SessionReviewPort {
    readonly log: string[]
    readonly opened: { sessionId: string; scopeRoot: string; proposal: string }[] = []
    readonly scripted = new Map<string, SessionReviewSettled>()
    private readonly waiting = new Map<string, (settled: SessionReviewSettled) => void>()

    constructor(log: string[]) {
      this.log = log
    }

    open(input: { sessionId: string; scopeRoot: string; proposal: string }): Promise<SessionsOpResult<{ commitSessionId: string }>> {
      this.opened.push(input)
      const commitSessionId = `c${this.opened.length}`
      this.log.push(`open ${commitSessionId} ${input.scopeRoot}`)
      return Promise.resolve({ ok: true, value: { commitSessionId } })
    }

    settled(commitSessionId: string, signal: AbortSignal): Promise<SessionReviewSettled> {
      const answer = this.scripted.get(commitSessionId)
      if (answer !== undefined) return Promise.resolve(answer)
      return new Promise((resolve, reject) => {
        this.waiting.set(commitSessionId, resolve)
        signal.addEventListener('abort', () => reject(new Error('stopped waiting')))
      })
    }

    isWaiting(commitSessionId: string): boolean {
      return this.waiting.has(commitSessionId)
    }

    settle(commitSessionId: string, settled: SessionReviewSettled): void {
      const resolve = this.waiting.get(commitSessionId)
      if (resolve === undefined) throw new Error(`nobody waits for ${commitSessionId}`)
      this.waiting.delete(commitSessionId)
      resolve(settled)
    }
  }

  interface Harness {
    flow: SvnWorktreeFinishFlow
    store: SessionRecordsStore
    svn: FakeSvn
    review: FakeReview
    log: string[]
    reports: string[]
    /** Each call of `ended`, with the outcome the record held at that moment. */
    ended: { sessionId: string; outcome: string | null }[]
    record: () => SessionRecord | null
    /** Until every detached finish has ended. */
    settled: () => Promise<void>
  }

  async function harness(options: {
    overrides?: Partial<SessionRecord>
    withoutReview?: true
    /** Runs before each step on the operation queue, the way a reopen queued ahead of it would. */
    beforeQueue?: (store: SessionRecordsStore) => Promise<void>
  } = {}): Promise<Harness> {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-svn-finish-flow-'))
    created.push(root)
    const reports: string[] = []
    const log: string[] = []
    const store = await SessionRecordsStore.load(join(root, 'session-records.json'), {
      snapshotsDirectory: join(root, 'snapshots'),
      report: (message) => reports.push(message),
    })
    await store.put(recordOf(options.overrides))
    const svn = new FakeSvn(log)
    const review = new FakeReview(log)
    const detached: Promise<unknown>[] = []
    const ended: Harness['ended'] = []
    const flow = new SvnWorktreeFinishFlow({
      records: store,
      svn,
      reviewOf: () => options.withoutReview ? null : review,
      releaseBelow: (path) => { log.push(`releaseBelow ${path}`); return Promise.resolve() },
      onQueue: async (work) => {
        await options.beforeQueue?.(store)
        return work()
      },
      detach: (work) => { detached.push(work) },
      report: (message) => reports.push(message),
      changed: () => undefined,
      ended: (sessionId) => { ended.push({ sessionId, outcome: store.get(sessionId)?.worktreeOutcome?.result ?? null }) },
      now: () => 5_000,
    })
    return {
      flow, store, svn, review, log, reports, ended,
      record: () => store.get('s1'),
      settled: async () => { await Promise.all(detached) },
    }
  }

  function recordOf(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      sessionId: 's1',
      kind: 'agent',
      title: '014 - fix login',
      createdAt: 0,
      life: 'ended',
      directory: { mode: 'project', categoryId: 'work', projectPath: ownerConst },
      binding: null,
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
      worktree: {
        worktreePath: worktreeConst,
        branch: urlConst,
        baseCommit: 'r10',
        repositoryRoot: ownerConst,
        kind: 'svn',
        directoryId: '1:2:3',
      },
      ...overrides,
    }
  }

  /** One changed file in the worktree itself, which a review commits as r12 unless a case says otherwise. */
  function oneChange(it_: Harness, changed = [row('a.txt')]): void {
    it_.svn.rootsValue = [worktreeRoot([])]
    it_.svn.updates = [{ kind: 'current', changed, roots: [worktreeRoot(changed)] }]
    it_.svn.reviewedByRevision[12] = [logged(12, 'a.txt')]
  }

  function refusalOf(result: SessionsOpResult): { code: string; detail: string } {
    if (result.ok) throw new Error('expected a refusal')
    return { code: result.code, detail: result.detail }
  }

  async function until(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (predicate()) return
      await new Promise((resolve) => setImmediate(resolve))
    }
    throw new Error('the condition never held')
  }

  it('commits through the receipt, updates the main copy and removes the worktree', async () => {
    const it_ = await harness()
    oneChange(it_)

    // The answer comes while the person is still in the review.
    expect(await it_.flow.finish('s1')).toEqual({ ok: true, value: undefined })
    expect(it_.review.opened).toEqual([{ sessionId: 's1', scopeRoot: worktreeConst, proposal: 'fix login' }])
    expect(it_.record()?.worktreeFinish).toMatchObject({ phase: 'reviewing', scopeRoot: worktreeConst, commitSessionId: 'c1' })
    await until(() => it_.review.isWaiting('c1'))

    it_.review.settle('c1', { state: 'committed', revision: '12' })
    await it_.settled()

    const record = it_.record()
    expect(record?.worktreeOutcome).toEqual({
      result: 'committed',
      revisions: [`${repositoryConst}:r12`],
      main: 'updated',
      worktree: 'removed',
      lines: [`-> committed app:r12 from ${worktreeConst}`, '   worktree removed'],
      at: 5_000,
    })
    expect(it_.svn.mainRows).toEqual([[logged(12, 'a.txt')]])
    expect(record?.worktree).toBeUndefined()
    expect(record?.worktreeFinish).toBeUndefined()
    expect(record?.completed).toBe(true)
    expect(record?.retiredWorktree).toEqual({ worktreePath: worktreeConst, kind: 'svn', revisions: [`${repositoryConst}:r12`], removedAt: 5_000 })
    expect(it_.log.indexOf(`releaseBelow ${worktreeConst}`)).toBeLessThan(it_.log.indexOf(`renameAside ${worktreeConst} 1:2:3`))
    expect(it_.reports).toEqual([])
    // Only at the end of the detached part, once the outcome is on the record.
    expect(it_.ended).toEqual([{ sessionId: 's1', outcome: 'committed' }])
  })

  it('keeps the worktree and the main copy when the review was cancelled', async () => {
    const it_ = await harness()
    oneChange(it_)
    it_.svn.changesByPath[worktreeConst] = [row('a.txt')]
    it_.review.scripted.set('c1', { state: 'cancelled' })

    await it_.flow.finish('s1')
    await it_.settled()

    expect(it_.record()?.worktreeOutcome).toMatchObject({
      result: 'not-committed', worktree: 'kept', main: 'none',
      lines: [`NOT COMMITTED: the review ended without a commit; ${worktreeConst} is kept`],
    })
    expect(it_.log.some((entry) => entry.startsWith('updateMain'))).toBe(false)
    expect(it_.log.some((entry) => entry.startsWith('renameAside'))).toBe(false)
    expect(it_.record()?.worktree).toBeDefined()
    expect(it_.record()?.worktreeFinish).toBeUndefined()
    expect(it_.ended).toEqual([])
  })

  it('lands what the receipt names and keeps the rest as partial', async () => {
    const it_ = await harness()
    oneChange(it_, [row('a.txt'), row('b.txt')])
    it_.svn.changesByPath[worktreeConst] = [row('b.txt')]
    it_.review.scripted.set('c1', { state: 'committed', revision: '12' })

    await it_.flow.finish('s1')
    await it_.settled()

    expect(it_.record()?.worktreeOutcome).toMatchObject({
      result: 'partial', worktree: 'kept', main: 'updated', revisions: [`${repositoryConst}:r12`],
      lines: [`PARTIAL: app:r12 left 1 change(s) in ${worktreeConst}; the worktree is kept`, '  b.txt'],
    })
    expect(it_.svn.mainRows).toEqual([[logged(12, 'a.txt')]])
    expect(it_.reports).toHaveLength(1)
    expect(it_.ended).toEqual([])
  })

  it('stops on an update conflict before any review, naming at most twenty paths', async () => {
    const it_ = await harness()
    const paths = Array.from({ length: 25 }, (_, index) => `src/file${index}.ts`)
    it_.svn.updates = [{ kind: 'conflict', paths }]

    const refusal = refusalOf(await it_.flow.finish('s1'))

    expect(refusal.code).toBe('worktree-conflict')
    const lines = refusal.detail.split('\n')
    expect(lines[0]).toBe(`CONFLICT: ${worktreeConst}`)
    expect(lines.filter((line) => line.startsWith('  src/'))).toHaveLength(20)
    expect(it_.review.opened).toEqual([])
    expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'conflict', worktree: 'kept' })
    expect(it_.record()?.worktreeFinish).toBeUndefined()
    expect(it_.ended).toEqual([])
  })

  it('stops after taking in other commits, and the next press opens the review', async () => {
    const it_ = await harness()
    oneChange(it_)
    it_.svn.updates = [{ kind: 'updated', toRevision: 15, paths: ['src/shared.ts'] }, ...it_.svn.updates]

    const refusal = refusalOf(await it_.flow.finish('s1'))
    expect(refusal.code).toBe('worktree-updated')
    expect(refusal.detail).toContain('UPDATED to r15: other commits changed the project of this change set:')
    expect(refusal.detail).toContain('Reopen the session to rerun the tests, or press Finish again to commit as it is')
    expect(it_.review.opened).toEqual([])
    expect(it_.ended).toEqual([])

    expect(await it_.flow.finish('s1')).toEqual({ ok: true, value: undefined })
    expect(it_.review.opened).toHaveLength(1)
  })

  it('removes the worktree after a main-copy conflict and says so', async () => {
    const it_ = await harness()
    oneChange(it_)
    it_.svn.main = { main: 'conflict:1', lines: ['MAIN CONFLICT a.txt'] }
    it_.review.scripted.set('c1', { state: 'committed', revision: '12' })

    await it_.flow.finish('s1')
    await it_.settled()

    expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'committed', main: 'conflict:1', worktree: 'removed' })
    expect(it_.record()?.worktreeOutcome?.lines).toContain('MAIN CONFLICT a.txt')
    expect(it_.reports.join('\n')).toContain('MAIN CONFLICT a.txt')
    expect(it_.ended).toEqual([])
  })

  describe('external mounts', () => {
    function withMount(it_: Harness): void {
      const mounted = [row('lib/x.txt')]
      const own = [row('a.txt')]
      it_.svn.rootsValue = [mountRoot([]), worktreeRoot([])]
      it_.svn.updates = [{ kind: 'current', changed: [...mounted, ...own], roots: [mountRoot(mounted), worktreeRoot(own)] }]
      it_.svn.bounds = {
        lib: { repository: sharedConst, base: '/lib', rootBase: 30, since: 31 },
        '': { repository: repositoryConst, base: '/trunk', rootBase: 10, since: 11 },
      }
      it_.svn.reviewedByRevision[32] = [logged(32, 'lib/x.txt')]
      it_.svn.reviewedByRevision[12] = [logged(12, 'a.txt')]
    }

    it('reviews a changed mount first and stops before the parent when it was not committed', async () => {
      const it_ = await harness()
      withMount(it_)
      it_.svn.changesByPath[mountConst] = [row('lib/x.txt')]
      it_.svn.changesByPath[worktreeConst] = [row('lib/x.txt'), row('a.txt')]
      it_.review.scripted.set('c1', { state: 'cancelled' })

      await it_.flow.finish('s1')
      await it_.settled()

      expect(it_.review.opened.map((opened) => opened.scopeRoot)).toEqual([mountConst])
      expect(it_.record()?.worktreeOutcome).toMatchObject({
        result: 'not-committed', worktree: 'kept',
        lines: [`NOT COMMITTED: external lib; ${worktreeConst} is kept and nothing outside that mount was reviewed`],
      })
    })

    it('publishes a clean mount, then reviews the parent', async () => {
      const it_ = await harness()
      withMount(it_)
      it_.review.scripted.set('c1', { state: 'committed', revision: '32' })
      it_.review.scripted.set('c2', { state: 'committed', revision: '12' })

      await it_.flow.finish('s1')
      await it_.settled()

      expect(it_.review.opened.map((opened) => opened.scopeRoot)).toEqual([mountConst, worktreeConst])
      expect(it_.record()?.worktreeOutcome).toMatchObject({
        result: 'committed', worktree: 'removed',
        revisions: [`${repositoryConst}:r12`, `${sharedConst}:r32`],
      })
      expect(it_.record()?.worktreeOutcome?.lines).toContain('EXTERNAL PUBLISHED r32 shared lib/x.txt')
    })
  })

  describe('a review without a receipt', () => {
    it('commits on the BASE proof after an external client closed', async () => {
      const it_ = await harness()
      oneChange(it_)
      it_.svn.provenByOwn[''] = [logged(13, 'a.txt')]
      it_.review.scripted.set('c1', { state: 'external-closed' })

      await it_.flow.finish('s1')
      await it_.settled()

      expect(it_.log).toContain('proven ')
      expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'committed', revisions: [`${repositoryConst}:r13`] })
    })

    it('stops UNVERIFIED without a proof, and keeps the worktree', async () => {
      const it_ = await harness()
      oneChange(it_)
      it_.svn.provenByOwn[''] = 'a.txt left BASE r10 for r14 during the review; no proof without a review receipt'
      it_.svn.changesByPath[worktreeConst] = [row('a.txt')]
      it_.review.scripted.set('c1', { state: 'external-closed' })

      await it_.flow.finish('s1')
      await it_.settled()

      const outcome = it_.record()?.worktreeOutcome
      expect(outcome).toMatchObject({ result: 'failed', worktree: 'kept' })
      expect(outcome?.lines[0]).toMatch(/^UNVERIFIED: the review of /)
      expect(outcome?.lines).toContain('ERROR: no verified revision can be attributed to this review')
    })

    it('reads a comma list of several scopes as no receipt', async () => {
      const it_ = await harness()
      oneChange(it_)
      it_.svn.provenByOwn[''] = [logged(12, 'a.txt')]
      it_.review.scripted.set('c1', { state: 'committed', revision: '12, 13' })

      await it_.flow.finish('s1')
      await it_.settled()

      expect(it_.log.some((entry) => entry.startsWith('reviewed'))).toBe(false)
      expect(it_.record()?.worktreeOutcome?.result).toBe('committed')
    })
  })

  it('recovers a commit the main copy lacks and finishes without a review', async () => {
    const it_ = await harness()
    it_.svn.recoverableByOwn[''] = [logged(11, 'a.txt')]
    it_.svn.updates = [{ kind: 'current', changed: [], roots: [] }]

    expect(await it_.flow.finish('s1')).toEqual({ ok: true, value: undefined })

    expect(it_.review.opened).toEqual([])
    expect(it_.svn.mainRows).toEqual([[logged(11, 'a.txt')]])
    expect(it_.record()?.worktreeOutcome).toMatchObject({
      result: 'committed', main: 'updated', worktree: 'removed', revisions: [`${repositoryConst}:r11`],
      lines: ['RECOVERED app:r11 a.txt', `-> committed app:r11 from ${worktreeConst}`, '   worktree removed'],
    })
    expect(it_.ended).toEqual([{ sessionId: 's1', outcome: 'committed' }])
  })

  it('finishes a worktree with nothing to commit by removing it', async () => {
    const it_ = await harness()
    it_.svn.updates = [{ kind: 'current', changed: [], roots: [] }]

    expect(await it_.flow.finish('s1')).toEqual({ ok: true, value: undefined })

    expect(it_.record()?.worktreeOutcome).toMatchObject({
      result: 'nothing', worktree: 'removed', lines: [`NOTHING TO COMMIT: ${worktreeConst} matches ${urlConst}`, '   worktree removed'],
    })
    expect(it_.ended).toEqual([{ sessionId: 's1', outcome: 'nothing' }])
  })

  it('keeps a worktree something holds, after releasing its own handles first, and answers locked', async () => {
    const it_ = await harness()
    it_.svn.updates = [{ kind: 'current', changed: [], roots: [] }]
    it_.svn.rename = 'in-use'

    const refusal = refusalOf(await it_.flow.finish('s1'))

    expect(refusal.code).toBe('locked')
    expect(refusal.detail).toContain(`IN USE: ${worktreeConst}`)
    expect(it_.reports.join('\n')).toContain(`IN USE: ${worktreeConst}`)
    expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'nothing', worktree: 'in-use' })
    expect(it_.record()?.worktree).toBeDefined()
    expect(it_.log.slice(-2)).toEqual([`releaseBelow ${worktreeConst}`, `renameAside ${worktreeConst} 1:2:3`])
    expect(it_.ended).toEqual([])
  })

  it('answers a failure when a finish without a review leaves the main copy in conflict', async () => {
    const it_ = await harness()
    it_.svn.recoverableByOwn[''] = [logged(11, 'a.txt')]
    it_.svn.updates = [{ kind: 'current', changed: [], roots: [] }]
    it_.svn.main = { main: 'conflict:1', lines: ['MAIN CONFLICT a.txt'] }

    const refusal = refusalOf(await it_.flow.finish('s1'))

    expect(refusal.code).toBe('svn-failed')
    expect(refusal.detail).toContain('MAIN CONFLICT a.txt')
    expect(it_.reports.join('\n')).toContain('MAIN CONFLICT a.txt')
    expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'committed', main: 'conflict:1', worktree: 'removed' })
    expect(it_.ended).toEqual([])
  })

  it('keeps the revisions of an earlier committed finish whose removal found the worktree in use', async () => {
    const it_ = await harness({
      overrides: {
        worktreeOutcome: {
          result: 'committed', revisions: [`${repositoryConst}:r12`], main: 'updated', worktree: 'in-use', lines: [], at: 1,
        },
      },
    })
    it_.svn.updates = [{ kind: 'current', changed: [], roots: [] }]

    expect(await it_.flow.finish('s1')).toEqual({ ok: true, value: undefined })

    expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'nothing', worktree: 'removed', revisions: [`${repositoryConst}:r12`] })
    expect(it_.record()?.retiredWorktree?.revisions).toEqual([`${repositoryConst}:r12`])
  })

  it('names what reviews and the recovery landed when a finish then throws', async () => {
    const it_ = await harness()
    oneChange(it_)
    it_.svn.recoverableByOwn[''] = [logged(11, 'b.txt')]
    it_.svn.rename = new Error('disk gone')
    it_.review.scripted.set('c1', { state: 'committed', revision: '12' })

    await it_.flow.finish('s1')
    await expect(it_.settled()).rejects.toThrow('disk gone')

    expect(it_.record()?.worktreeOutcome).toMatchObject({
      result: 'failed', main: 'updated', worktree: 'kept',
      revisions: [`${repositoryConst}:r11`, `${repositoryConst}:r12`],
    })
    expect(it_.record()?.worktreeFinish).toBeUndefined()
    expect(it_.ended).toEqual([])
  })

  describe('a closing write that does not land', () => {
    /** Every write without a finish phase fails, which is the closing write of a finish or a Discard. */
    function failClosingWrites(it_: Harness): SessionRecord[] {
      const refused: SessionRecord[] = []
      const put = it_.store.put.bind(it_.store)
      it_.store.put = (record) => {
        if (record.worktreeFinish !== undefined) return put(record)
        refused.push(record)
        return Promise.resolve(false)
      }
      return refused
    }

    it('is tried twice, then frees the session in memory and reports what the records lack', async () => {
      const it_ = await harness()
      it_.svn.updates = [{ kind: 'current', changed: [], roots: [] }]
      it_.svn.rename = 'in-use'
      const refused = failClosingWrites(it_)

      expect(refusalOf(await it_.flow.finish('s1')).code).toBe('locked')

      expect(refused).toHaveLength(2)
      expect(it_.record()?.worktreeFinish).toBeUndefined()
      expect(it_.reports.join('\n')).toContain('the session records could not be written, so they do not hold the end of the finish (nothing)')
      expect(refusalOf(await it_.flow.finish('s1')).code).toBe('locked')
    })

    it('frees the session after a Discard the same way', async () => {
      const it_ = await harness()
      it_.svn.rename = 'in-use'
      const refused = failClosingWrites(it_)

      expect(refusalOf(await it_.flow.discard('s1')).code).toBe('locked')

      expect(refused).toHaveLength(2)
      expect(it_.record()?.worktreeFinish).toBeUndefined()
      expect(it_.reports.join('\n')).toContain('do not hold the end of the Discard')
      expect(refusalOf(await it_.flow.discard('s1')).code).toBe('locked')
    })
  })

  it('holds the session against a second Finish, a Discard and a running session while it reviews', async () => {
    const it_ = await harness()
    oneChange(it_)

    await it_.flow.finish('s1')

    expect(refusalOf(await it_.flow.finish('s1')).code).toBe('merge-pending')
    expect(refusalOf(await it_.flow.discard('s1')).code).toBe('merge-pending')
    expect(it_.review.opened).toHaveLength(1)
    await until(() => it_.review.isWaiting('c1'))
    it_.review.settle('c1', { state: 'cancelled' })
    await it_.settled()
  })

  it('refuses Commit by name without a commit dialog, while Discard still works', async () => {
    const it_ = await harness({ withoutReview: true })

    expect(refusalOf(await it_.flow.finish('s1')).code).toBe('review-unavailable')
    expect(it_.log).toEqual([])

    expect(await it_.flow.discard('s1')).toEqual({ ok: true, value: undefined })
    expect(it_.record()?.retiredWorktree?.worktreePath).toBe(worktreeConst)
    expect(it_.record()?.worktreeFinish).toBeUndefined()
    expect(it_.ended).toEqual([{ sessionId: 's1', outcome: null }])
  })

  it('refuses a Discard of a running session and names a holder', async () => {
    const live = await harness({ overrides: { life: 'live', binding: { hostInstanceId: 'h', generation: 1 } } })
    expect(refusalOf(await live.flow.discard('s1')).code).toBe('live-refused')
    expect(live.log).toEqual([])

    const held = await harness()
    held.svn.rename = 'in-use'
    expect(refusalOf(await held.flow.discard('s1')).code).toBe('locked')
    expect(held.record()?.worktree).toBeDefined()
    expect(held.record()?.worktreeFinish).toBeUndefined()
    expect([...live.ended, ...held.ended]).toEqual([])
  })

  it('carries the earlier revisions into the tombstone of a Discard', async () => {
    const it_ = await harness({
      overrides: {
        worktreeOutcome: {
          result: 'partial', revisions: [`${repositoryConst}:r12`], main: 'updated', worktree: 'kept', lines: [], at: 1,
        },
      },
    })

    await it_.flow.discard('s1')

    expect(it_.record()?.retiredWorktree?.revisions).toEqual([`${repositoryConst}:r12`])
  })

  it('stops waiting when the client stops, leaving the phase for the next load to read', async () => {
    const it_ = await harness()
    oneChange(it_)

    await it_.flow.finish('s1')
    await until(() => it_.review.isWaiting('c1'))
    it_.flow.stop()
    await it_.settled()

    expect(it_.record()?.worktreeFinish?.phase).toBe('reviewing')
    expect(it_.record()?.worktreeOutcome).toBeUndefined()
  })

  it('fails without touching anything when the owner no longer checks out the worktree URL', async () => {
    const it_ = await harness()
    it_.svn.ownerRefusal = `The owner ${ownerConst} checks out ${repositoryConst}/branches/x, not ${urlConst}`

    expect(refusalOf(await it_.flow.finish('s1')).code).toBe('invalid-spec')
    expect(it_.log).toEqual(['ownerCheck'])
    expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'failed', worktree: 'kept' })
  })

  it('offers Commit, Keep and Discard and measures against BASE', async () => {
    const it_ = await harness()

    expect(it_.flow.choicesOf()).toEqual(['commit', 'keep', 'discard'])
    expect(await it_.flow.facts(it_.record()!.worktree!))
      .toEqual({ diff: { added: 3, removed: 1, changedFiles: 2, capturedAt: 5_000 }, baseMoved: false })
  })

  describe('the cleanup after the session ended', () => {
    const pending = (trigger: NonNullable<SessionRecord['worktreeCleanup']>['trigger'] = 'committed') =>
      ({ worktreeCleanup: { phase: 'pending' as const, trigger, requestedAt: 1, attempts: 1, lastAttemptAt: 2 } })

    it('removes a clean worktree with nothing unlanded, leaves a tombstone and ends the session', async () => {
      const it_ = await harness({ overrides: pending() })

      await it_.flow.cleanUp('s1')

      const record = it_.record()
      expect(record?.worktree).toBeUndefined()
      expect(record?.worktreeCleanup).toBeUndefined()
      expect(record?.worktreeFinish).toBeUndefined()
      expect(record?.completed).toBe(true)
      expect(record?.retiredWorktree).toEqual({ worktreePath: worktreeConst, kind: 'svn', revisions: [], removedAt: 5_000 })
      expect(it_.log).toEqual([
        `present ${worktreeConst}`,
        `changes ${worktreeConst}`,
        `unlanded ${worktreeConst} ${ownerConst}`,
        `releaseBelow ${worktreeConst}`,
        `renameAside ${worktreeConst} 1:2:3`,
        'purgeAside',
        `removeEmptyWorktreesDir ${ownerConst}`,
      ])
      expect(it_.ended).toEqual([{ sessionId: 's1', outcome: null }])
    })

    it('keeps a worktree with one unversioned file for good, and never writes the main copy', async () => {
      const it_ = await harness({ overrides: pending() })
      it_.svn.changesByPath[worktreeConst] = [row('notes.txt')]

      await it_.flow.cleanUp('s1')

      expect(it_.record()?.worktreeCleanup).toMatchObject({ phase: 'kept', reason: '1 change', trigger: 'committed' })
      expect(it_.record()?.worktree).toBeDefined()
      expect(it_.log.some((entry) => entry.startsWith('renameAside') || entry.startsWith('updateMain'))).toBe(false)
      expect(it_.ended).toEqual([])

      // Terminal: a second apply finds nothing pending and reads nothing.
      it_.log.length = 0
      await it_.flow.cleanUp('s1')
      expect(it_.log).toEqual([])
    })

    it('waits while the main copy lacks a commit of the worktree, and removes it once the main copy holds it', async () => {
      const it_ = await harness({ overrides: pending() })
      it_.svn.unlandedValue = [{ path: 'src/a.txt', revision: 12 }, { path: 'src/b.txt', revision: 11 }]

      await it_.flow.cleanUp('s1')

      expect(it_.record()?.worktreeCleanup).toMatchObject({ phase: 'pending', reason: 'unlanded r12: src/a.txt src/b.txt' })
      expect(it_.record()?.worktree).toBeDefined()
      expect(it_.log.some((entry) => entry.startsWith('updateMain'))).toBe(false)

      it_.svn.unlandedValue = []
      await it_.flow.cleanUp('s1')

      expect(it_.record()?.retiredWorktree?.worktreePath).toBe(worktreeConst)
      expect(it_.ended).toEqual([{ sessionId: 's1', outcome: null }])
    })

    it('stays pending when svn cannot read the worktree', async () => {
      const it_ = await harness({ overrides: pending() })
      it_.svn.unlandedValue = 'E155037: previous operation has not finished'

      await it_.flow.cleanUp('s1')

      expect(it_.record()?.worktreeCleanup).toMatchObject({
        phase: 'pending', reason: 'svn status failed: E155037: previous operation has not finished',
      })
    })

    it('stays pending as in use while a process holds the directory, and lets the finish phase go', async () => {
      const it_ = await harness({ overrides: pending() })
      it_.svn.rename = 'in-use'

      await it_.flow.cleanUp('s1')

      expect(it_.record()?.worktreeCleanup).toMatchObject({ phase: 'pending', reason: 'in use', attempts: 1 })
      expect(it_.record()?.worktreeFinish).toBeUndefined()
      expect(it_.record()?.worktree).toBeDefined()
      expect(it_.ended).toEqual([])
    })

    it('does nothing when a reopen took the queue first', async () => {
      const it_ = await harness({
        overrides: pending(),
        beforeQueue: async (store) => {
          const current = store.get('s1')
          if (current?.life === 'ended') await store.put({ ...current, life: 'starting', pendingOperationId: 'op-1', pendingOperationKind: 'reopen' })
        },
      })

      await it_.flow.cleanUp('s1')

      expect(it_.log.some((entry) => entry.startsWith('renameAside'))).toBe(false)
      expect(it_.record()?.worktree).toBeDefined()
      expect(it_.record()?.worktreeCleanup).toEqual(pending().worktreeCleanup)
      expect(it_.record()?.worktreeFinish).toBeUndefined()
      expect(it_.ended).toEqual([])
    })

    it('removes after an unfinished Discard without asking about changes', async () => {
      const it_ = await harness({ overrides: pending('discard-unfinished') })
      it_.svn.changesByPath[worktreeConst] = [row('a.txt')]

      await it_.flow.cleanUp('s1')

      expect(it_.log.some((entry) => entry.startsWith('changes') || entry.startsWith('unlanded'))).toBe(false)
      expect(it_.record()?.retiredWorktree).toBeDefined()
      expect(it_.ended).toEqual([{ sessionId: 's1', outcome: null }])
    })

    it('counts a worktree already gone as removed', async () => {
      const it_ = await harness({ overrides: pending() })
      it_.svn.presentValue = false
      it_.svn.rename = 'absent'

      await it_.flow.cleanUp('s1')

      expect(it_.log.some((entry) => entry.startsWith('changes'))).toBe(false)
      expect(it_.record()?.retiredWorktree).toBeDefined()
      expect(it_.ended).toEqual([{ sessionId: 's1', outcome: null }])
    })

    it('asks for the cleanup after a Finish Commit whose removal found the worktree in use, which removes it once free', async () => {
      const it_ = await harness()
      oneChange(it_)
      it_.review.scripted.set('c1', { state: 'committed', revision: '12' })
      it_.svn.rename = 'in-use'

      await it_.flow.finish('s1')
      await it_.settled()

      expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'committed', worktree: 'in-use' })
      expect(it_.record()?.worktreeCleanup)
        .toEqual({ phase: 'pending', trigger: 'removal-unfinished', requestedAt: 5_000, attempts: 0 })
      expect(it_.ended).toEqual([])

      it_.svn.rename = 'renamed'
      await it_.flow.cleanUp('s1')

      expect(it_.record()?.retiredWorktree?.revisions).toEqual([`${repositoryConst}:r12`])
      expect(it_.record()?.worktreeCleanup).toBeUndefined()
      expect(it_.ended).toEqual([{ sessionId: 's1', outcome: 'committed' }])
    })

    it('asks for the cleanup after a half-purged Finish removal, and for none after one that kept the worktree', async () => {
      const undeleted = await harness()
      undeleted.svn.updates = [{ kind: 'current', changed: [], roots: [] }]
      undeleted.svn.purge = 'undeleted'
      await undeleted.flow.finish('s1')
      expect(undeleted.record()?.worktreeCleanup).toMatchObject({ phase: 'pending', trigger: 'removal-unfinished' })

      const cancelled = await harness()
      oneChange(cancelled)
      cancelled.review.scripted.set('c1', { state: 'cancelled' })
      cancelled.svn.changesByPath[worktreeConst] = [row('a.txt')]
      await cancelled.flow.finish('s1')
      await cancelled.settled()
      expect(cancelled.record()?.worktreeOutcome).toMatchObject({ result: 'not-committed', worktree: 'kept' })
      expect(cancelled.record()?.worktreeCleanup).toBeUndefined()
    })

    it('asks for the cleanup after a Discard whose rename was refused, which removes it although it has changes', async () => {
      const it_ = await harness()
      it_.svn.rename = 'in-use'
      it_.svn.changesByPath[worktreeConst] = [row('a.txt')]

      expect(refusalOf(await it_.flow.discard('s1')).code).toBe('locked')
      expect(it_.record()?.worktreeCleanup)
        .toEqual({ phase: 'pending', trigger: 'discard-unfinished', requestedAt: 5_000, attempts: 0 })

      it_.svn.rename = 'renamed'
      it_.log.length = 0
      await it_.flow.cleanUp('s1')

      expect(it_.log.some((entry) => entry.startsWith('changes'))).toBe(false)
      expect(it_.record()?.retiredWorktree).toBeDefined()
      expect(it_.ended).toEqual([{ sessionId: 's1', outcome: null }])
    })

    it('checks the changes of an unfinished Discard once the session ran after it, and keeps the new work', async () => {
      const it_ = await harness({ overrides: { ...pending('discard-unfinished'), endedAt: 3 } })
      it_.svn.changesByPath[worktreeConst] = [row('after-reopen.txt')]

      await it_.flow.cleanUp('s1')

      expect(it_.record()?.worktreeCleanup).toMatchObject({ phase: 'kept', reason: '1 change', trigger: 'discard-unfinished' })
      expect(it_.record()?.worktree).toBeDefined()
      expect(it_.log.some((entry) => entry.startsWith('renameAside'))).toBe(false)
      expect(it_.ended).toEqual([])
    })

    it('keeps a changed worktree after Discard IN USE, a reopen and a stop', async () => {
      const it_ = await harness()
      it_.svn.rename = 'in-use'
      expect(refusalOf(await it_.flow.discard('s1')).code).toBe('locked')
      expect(it_.record()?.worktreeCleanup?.trigger).toBe('discard-unfinished')

      // What the lifecycle writes for the reopen, and then for the stop that ends the new run.
      const discarded = it_.record()
      if (discarded === null) throw new Error('the record is gone')
      await it_.store.put(WorktreeCleanupPacing.relaunched({ ...discarded, life: 'starting', pendingOperationId: 'op-1', pendingOperationKind: 'reopen' }, 6_000))
      const reopened = it_.record()
      if (reopened === null) throw new Error('the record is gone')
      await it_.store.put({ ...reopened, life: 'ended', exitReason: 'stopped', pendingOperationId: undefined, pendingOperationKind: undefined })
      it_.svn.rename = 'renamed'
      it_.svn.changesByPath[worktreeConst] = [row('after-reopen.txt')]

      await it_.flow.cleanUp('s1')

      expect(it_.record()?.worktreeCleanup).toMatchObject({ phase: 'kept', reason: '1 change', trigger: 'removal-unfinished' })
      expect(it_.record()?.worktree).toBeDefined()
      expect(it_.ended).toEqual([])
    })

    for (const main of ['conflict:1', 'failed'] as const)
      it(`removes the worktree after a Finish whose main copy ended ${main}, and keeps the session`, async () => {
        const it_ = await harness()
        oneChange(it_)
        it_.svn.main = { main, lines: [`MAIN ${main}`] }
        it_.review.scripted.set('c1', { state: 'committed', revision: '12' })
        it_.svn.rename = 'in-use'
        await it_.flow.finish('s1')
        await it_.settled()
        expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'committed', main, worktree: 'in-use' })

        it_.svn.rename = 'renamed'
        await it_.flow.cleanUp('s1')

        expect(it_.record()?.worktree).toBeUndefined()
        expect(it_.record()?.retiredWorktree?.worktreePath).toBe(worktreeConst)
        expect(it_.record()?.worktreeOutcome?.main).toBe(main)
        expect(it_.ended).toEqual([])
      })

    it('lets the cleanup phase go when the removal throws, so the session is not held', async () => {
      const it_ = await harness({ overrides: pending() })
      it_.svn.rename = new Error('EBUSY: the disk went away')

      await expect(it_.flow.cleanUp('s1')).rejects.toThrow(/the disk went away/)

      expect(it_.record()?.worktreeFinish).toBeUndefined()
      expect(it_.record()?.worktree).toBeDefined()
      expect(it_.ended).toEqual([])

      it_.svn.rename = 'renamed'
      await it_.flow.cleanUp('s1')
      expect(it_.record()?.retiredWorktree).toBeDefined()
      expect(it_.ended).toEqual([{ sessionId: 's1', outcome: null }])
    })

    it('leaves a running session, a running finish and a kept or missing cleanup alone', async () => {
      for (const overrides of [
        { ...pending(), life: 'live' as const },
        { ...pending(), worktreeFinish: { phase: 'reviewing' as const, startedAt: 1 } },
        { worktreeCleanup: { ...pending().worktreeCleanup, phase: 'kept' as const } },
        {},
      ]) {
        const it_ = await harness({ overrides })
        await it_.flow.cleanUp('s1')
        expect(it_.log).toEqual([])
      }
    })
  })

  it('ranks main-copy states the way the bash helper does', () => {
    expect(SvnWorktreeFinishFlow.worse('none', 'updated')).toBe('updated')
    expect(SvnWorktreeFinishFlow.worse('merged:1', 'conflict:2')).toBe('conflict:2')
    expect(SvnWorktreeFinishFlow.worse('conflict:1', 'conflict:2')).toBe('conflict:3')
    expect(SvnWorktreeFinishFlow.worse('failed', 'merged:4')).toBe('failed')
  })

  it('classifies with the v2 precedence', () => {
    const of = (input: Partial<Parameters<typeof SvnWorktreeFinishFlow.classify>[0]>) =>
      SvnWorktreeFinishFlow.classify({ proofFailure: false, outdated: false, landed: 0, remaining: 0, ...input })
    expect(of({ proofFailure: true, landed: 1, remaining: 1 })).toBe('partial')
    expect(of({ proofFailure: true, outdated: true })).toBe('out-of-date')
    expect(of({ proofFailure: true })).toBe('failed')
    expect(of({ outdated: true, remaining: 1 })).toBe('out-of-date')
    expect(of({ remaining: 1 })).toBe('not-committed')
    expect(of({ landed: 1, remaining: 1 })).toBe('partial')
    expect(of({ landed: 1 })).toBe('committed')
    expect(of({})).toBe('failed')
  })
})
