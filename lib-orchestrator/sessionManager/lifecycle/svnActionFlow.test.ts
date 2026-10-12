import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  SvnBounds,
  SvnResult,
  SvnReviewRoot,
  SvnRoot,
  SvnStatusRow,
  SvnWorktreeLocation,
  SvnWorktreeStatus,
} from '../../svn/svn.types'
import type { SessionRecord, SessionRecordScriptStep } from '../records/sessionRecord.types'
import { SessionRecordsStore } from '../records/sessionRecordsStore'
import { WorktreeResultsStore } from '../results/worktreeResultsStore'
import { ScriptChain } from '../scripts/scriptChain'
import { ScriptLogStore } from '../scripts/scriptLogStore'
import { ReviewRunExit } from '../../shared/reviewRunExit'
import type {
  SessionActivity,
  SessionCreateSpec,
  SessionFinishPress,
  SessionsOpResult,
  SvnFinishWorktreeResult,
  SvnLabelledRevision,
} from '../sessionManagerApi.types'
import type { SessionInternalMarks } from './sessionLifecycle'
import { type SvnActionPort, SvnActionFlow } from './svnActionFlow'
import type { SvnWorktreeRemoved } from './svnWorktreeRemoval'

describe('lib-orchestrator/sessionManager/lifecycle/svnActionFlow', () => {
  const ownerConst = 'Q:\\Work\\App'
  const worktreeConst = `${ownerConst}\\.worktrees\\014-fix-login`
  const mountConst = `${worktreeConst}\\lib`
  const repositoryConst = 'https://svn.test/repos/app'
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  const ok = <T>(value: T): SvnResult<T> => ({ ok: true, value })
  const receipt = (revision: number): SvnLabelledRevision => ({ repository: repositoryConst, revision, label: 'receipt' })
  const proof = (revision: number): SvnLabelledRevision => ({ repository: repositoryConst, revision, label: 'base-proof' })
  const root = (changed: string[], own = '', pinned = false): SvnReviewRoot => ({
    path: own === '' ? worktreeConst : mountConst,
    own,
    changed: changed.map((path) => ({ kind: 'item', conflict: false, path })),
    pinned,
  })

  /** The svn reads of an action; each answers what its field says, and every call is logged. */
  class FakeSvn {
    readonly log: string[]
    ownerRefusal: string | null = null
    revision = 41
    statusValue: SvnWorktreeStatus = { textConflicts: [], otherConflicts: [], changed: ['a.txt'] }
    /** One answer per incoming read; the last repeats. */
    incomingAnswers: string[][] = [[]]
    lockedValue = false
    /** One answer per review-roots read; the last repeats. */
    rootsAnswers: SvnReviewRoot[][] = [[root(['a.txt'])]]
    fingerprintValue = 'fp-1'
    /** Every changed path `changes` reads after a resolver. */
    changesValue: string[] = ['a.txt']
    resolveAnswer: SvnResult<void> = ok(undefined)
    /** One answer per status read after a resolve; empty: `statusValue`. */
    statusAfterResolve: SvnWorktreeStatus[] = []

    constructor(log: string[]) {
      this.log = log
    }

    ownerCheck(location: SvnWorktreeLocation): Promise<SvnResult<void>> {
      this.log.push(`ownerCheck ${location.worktreePath}`)
      return Promise.resolve(this.ownerRefusal === null ? ok(undefined) : { ok: false, code: 'refused', detail: this.ownerRefusal })
    }

    scheduleMissing(path: string): Promise<SvnResult<void>> {
      this.log.push(`scheduleMissing ${path}`)
      return Promise.resolve(ok(undefined))
    }

    revisionOf(path: string): Promise<SvnResult<number>> {
      this.log.push(`revisionOf ${path}`)
      return Promise.resolve(ok(this.revision))
    }

    incoming(path: string, base: number, changed: readonly string[], own: readonly number[]): Promise<SvnResult<string[]>> {
      this.log.push(`incoming ${path} r${base} [${changed.join(',')}] own [${own.join(',')}]`)
      const next = this.incomingAnswers.length > 1 ? this.incomingAnswers.shift()! : this.incomingAnswers[0]
      return Promise.resolve(ok(next))
    }

    locked(path: string): Promise<boolean> {
      this.log.push(`locked ${path}`)
      return Promise.resolve(this.lockedValue)
    }

    reviewRoots(path: string): Promise<SvnResult<SvnReviewRoot[]>> {
      this.log.push(`reviewRoots ${path}`)
      const next = this.rootsAnswers.length > 1 ? this.rootsAnswers.shift()! : this.rootsAnswers[0]
      return Promise.resolve(ok(next))
    }

    fingerprint(path: string): Promise<SvnResult<string>> {
      this.log.push(`fingerprint ${path}`)
      return Promise.resolve(ok(this.fingerprintValue))
    }

    changes(path: string): Promise<SvnResult<SvnStatusRow[]>> {
      this.log.push(`changes ${path}`)
      return Promise.resolve(ok(this.changesValue.map((changed): SvnStatusRow => ({ kind: 'item', conflict: false, path: changed }))))
    }

    resolveWorking(path: string, paths: readonly string[]): Promise<SvnResult<void>> {
      this.log.push(`resolve ${path} [${paths.join(',')}]`)
      if (this.resolveAnswer.ok && this.statusAfterResolve.length > 0) this.statusValue = this.statusAfterResolve.shift()!
      return Promise.resolve(this.resolveAnswer)
    }

    lowerBounds(roots: readonly SvnRoot[]): Promise<SvnResult<SvnBounds>> {
      this.log.push(`lowerBounds ${roots.map((entry) => entry.own || '.').join(',')}`)
      return Promise.resolve(ok(Object.fromEntries(roots.map((entry) =>
        [entry.own, { repository: repositoryConst, base: '/trunk', rootBase: this.revision, since: 50 }]))))
    }
  }

  class FakeLabels {
    own: SvnLabelledRevision[] = []
    /** One answer per review; the last repeats. */
    afterReviews: SvnLabelledRevision[][] = [[]]
    inferredValue: SvnLabelledRevision[] = []
    ownCommits(): Promise<SvnResult<SvnLabelledRevision[]>> {
      return Promise.resolve(ok(this.own))
    }

    afterReview(): Promise<SvnLabelledRevision[]> {
      return Promise.resolve(this.afterReviews.length > 1 ? this.afterReviews.shift()! : this.afterReviews[0])
    }

    inferred(): Promise<SvnLabelledRevision[]> {
      return Promise.resolve(this.inferredValue)
    }
  }

  interface Harness {
    flow: SvnActionFlow
    store: SessionRecordsStore
    svn: FakeSvn
    labels: FakeLabels
    log: string[]
    launched: SessionRecord[]
    stops: string[]
    ended: string[]
    /** The main copies an ending asked the manager to read again. */
    landedDue: string[]
    /** The worker's commit message proposals a committed Finish used, by session and roots. */
    spent: [string, readonly string[]][]
    reports: string[]
    clock: { now: number }
    removal: { state: SvnFinishWorktreeResult }
    checks: { steps: SessionRecordScriptStep[]; refusal: SessionsOpResult<never> | null }
    activity: Map<string, SessionActivity>
    refusal: { value: SessionsOpResult<never> | null }
    record: () => SessionRecord | null
    results: WorktreeResultsStore
    resultsDirectory: string
    logs: ScriptLogStore
    press: (choice: SessionFinishPress['choice'], extra?: Partial<SessionFinishPress>) => Promise<SessionsOpResult<{ actionId: string | null }>>
    /** Until every drive the flow detached has ended. */
    settled: () => Promise<void>
    /** The last launched run ends with this exit code, the reconcile pass judges it, and the next client step runs. */
    endRun: (exitCode: number | undefined, life?: 'ended' | 'lost') => Promise<void>
    /** A client process that starts on the same records, as after a restart. */
    restart: () => SvnActionFlow
    resolver: {
      unavailable: string | null
      markers: string[]
      briefs: Map<string, string>
      created: { spec: SessionCreateSpec; marks: SessionInternalMarks }[]
      /** What the create answers, and the record it leaves: the resolver runs, waits for a replay, ended refused, or none. */
      answer: SessionsOpResult<{ sessionId: string }>
      leaves: 'live' | 'pending' | 'ended' | 'none'
      /** Runs inside the create, before it answers. */
      onCreate: (() => Promise<void>) | null
      stopped: string[]
    }
  }

  async function harness(overrides: Partial<SessionRecord> = {}): Promise<Harness> {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-svn-action-flow-'))
    created.push(directory)
    const store = await SessionRecordsStore.load(join(directory, 'session-records.json'), {
      snapshotsDirectory: join(directory, 'snapshots'),
      report: () => undefined,
    })
    await store.put(recordOf(overrides))
    const log: string[] = []
    const svn = new FakeSvn(log)
    const labels = new FakeLabels()
    const launched: SessionRecord[] = []
    const stops: string[] = []
    const ended: string[] = []
    const landedDue: string[] = []
    const spent: Harness['spent'] = []
    const reports: string[] = []
    const detached: Promise<unknown>[] = []
    const clock = { now: 1_000 }
    const removal = { state: 'removed' as SvnFinishWorktreeResult }
    const checks: Harness['checks'] = { steps: [], refusal: null }
    const activity = new Map<string, SessionActivity>()
    const refusal: Harness['refusal'] = { value: null }
    const resolver: Harness['resolver'] = {
      unavailable: null, markers: [], briefs: new Map(), created: [], answer: { ok: true, value: { sessionId: '' } }, leaves: 'live', onCreate: null, stopped: [],
    }
    let minted = 0
    const resultsDirectory = join(directory, 'results')
    const logs = new ScriptLogStore(join(directory, 'logs'))
    const results = new WorktreeResultsStore(resultsDirectory, { now: () => clock.now, logs, report: (message) => { reports.push(message) } })
    const port: SvnActionPort = {
        ownerCheck: (location) => svn.ownerCheck(location),
        scheduleMissing: (path) => svn.scheduleMissing(path),
        revisionOf: (path) => svn.revisionOf(path),
        status: async (path) => {
          log.push(`status ${path}`)
          return ok(svn.statusValue)
        },
        changes: (path) => svn.changes(path),
        resolveWorking: (path, paths) => svn.resolveWorking(path, paths),
        incoming: (path, base, changed, own) => svn.incoming(path, base, changed, own),
        locked: (path) => svn.locked(path),
        reviewRoots: (path) => svn.reviewRoots(path),
        fingerprint: (path) => svn.fingerprint(path),
        lowerBounds: (roots) => svn.lowerBounds(roots),
    }
    const build = (): SvnActionFlow => new SvnActionFlow({
      records: store,
      svn: port,
      labels,
      removal: {
        remove: async (sessionId, location, revisions): Promise<SvnWorktreeRemoved> => {
          log.push(`remove ${location.worktreePath} [${revisions.join(',')}]`)
          if (removal.state === 'removed') {
            const current = store.get(sessionId)
            if (current) {
              const caller = current.worktree?.caller
              const next: SessionRecord = { ...current, completed: true,
                retiredWorktree: { worktreePath: location.worktreePath, kind: 'svn', revisions: [...revisions], removedAt: clock.now,
                  ...location.directoryId === undefined ? {} : { directoryId: location.directoryId }, ...caller === undefined ? {} : { caller } } }
              delete next.worktree
              delete next.worktreeCleanup
              await store.put(next)
            }
          }
          return { state: removal.state, lines: [] }
        },
      },
      resolver: {
        unavailable: () => resolver.unavailable,
        briefs: {
          briefPathOf: (parentId, actionId) => `L:\\logs\\${parentId}\\${actionId}-conflicts.txt`,
          writeBrief: async (parentId, actionId, text) => {
            resolver.briefs.set(`${parentId}/${actionId}`, text)
            return { ok: true, bytes: text.length }
          },
        },
        withMarkers: async () => resolver.markers,
      },
      results,
      createResolver: async (spec, marks) => {
        resolver.created.push({ spec, marks })
        await resolver.onCreate?.()
        const run: SessionRecord = {
          sessionId: marks.sessionId, kind: 'agent', title: spec.title ?? 'resolver', directory: spec.directory, createdAt: clock.now,
          agent: { agentId: 'claude', launchMode: spec.agent?.mode ?? 'new', oneShot: true, permission: marks.permission },
          scriptOf: marks.scriptOf, binding: null, life: 'starting', pendingOperationId: `op-${marks.sessionId}`, pendingOperationKind: 'create',
        }
        const leaves = resolver.leaves
        if (leaves === 'live') await store.put({ ...run, life: 'live', binding: { hostInstanceId: 'h', generation: 1 },
          pendingOperationId: undefined, pendingOperationKind: undefined })
        else if (leaves === 'pending') await store.put(run)
        else if (leaves === 'ended') await store.put({ ...run, life: 'ended', pendingOperationId: undefined, pendingOperationKind: undefined, endedReason: 'refused' })
        else if (leaves !== 'none') throw new Error(`Unknown resolver record: ${JSON.stringify(leaves satisfies never)}`)
        if (leaves !== 'none') launched.push(store.get(marks.sessionId)!)
        return resolver.answer.ok ? { ok: true, value: { sessionId: marks.sessionId } } : resolver.answer
      },
      stopRun: async (runId) => {
        resolver.stopped.push(runId)
        return true
      },
      finishRefusal: () => refusal.value,
      activityOf: (sessionId) => activity.get(sessionId) ?? null,
      ended: (sessionId) => { ended.push(sessionId) },
      landedDue: (mainCopy) => { landedDue.push(mainCopy) },
      proposalsSpent: (sessionId, scopeRoots) => { spent.push([sessionId, scopeRoots]) },
      detach: (work) => { detached.push(work) },
      changed: () => undefined,
      runs: {
        launch: async (run) => {
          launched.push(run)
          return { ok: true, value: undefined }
        },
      },
      checks: {
        declaredAfter: async () => checks.refusal === null ? { ok: true, steps: checks.steps } : { ok: false, result: checks.refusal },
      },
      stop: async (sessionId) => {
        stops.push(sessionId)
        return { ok: true, value: undefined }
      },
      report: (message) => { reports.push(message) },
      newId: () => `id-${++minted}`,
      now: () => clock.now,
    })
    let flow = build()
    const settled = async (): Promise<void> => {
      for (let round = 0; round < 50 && detached.length > 0; round += 1) await Promise.all(detached.splice(0))
    }
    const it_: Harness = {
      flow, store, svn, labels, log, launched, stops, ended, landedDue, spent, reports, clock, removal, checks, activity, refusal, resolver,
      results, resultsDirectory, logs,
      record: () => store.get('s1'),
      press: async (choice, extra) => {
        const answer = await it_.flow.start('s1', { choice, requestedBy: 'window', ...extra })
        await settled()
        return answer
      },
      settled,
      endRun: async (exitCode, life = 'ended') => {
        const run = launched.at(-1)
        if (run === undefined) throw new Error('no run was launched')
        await store.put({ ...store.get(run.sessionId) ?? run, life, binding: null, pendingOperationId: undefined,
          pendingOperationKind: undefined, ...exitCode === undefined ? {} : { exitCode }, endedAt: clock.now })
        await it_.flow.noteVerdict('s1', exitCode === 0 ? { kind: 'succeeded' } : { kind: 'failed', reason: `the run ended with ${exitCode ?? 'no exit code'}` })
        await settled()
      },
      restart: () => {
        flow = build()
        it_.flow = flow
        return flow
      },
    }
    return it_
  }

  function recordOf(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      sessionId: 's1',
      kind: 'agent',
      title: '014 - fix login',
      createdAt: 0,
      life: 'ended',
      exitReason: 'stopped',
      directory: { mode: 'project', categoryId: 'work', projectPath: ownerConst },
      binding: null,
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
      worktree: {
        worktreePath: worktreeConst,
        branch: `${repositoryConst}/trunk`,
        baseCommit: 'r10',
        repositoryRoot: ownerConst,
        kind: 'svn',
        directoryId: '1:2:3',
      },
      ...overrides,
    }
  }

  function declared(name: string, command: string): SessionRecordScriptStep {
    const step = { scriptId: 'declared' as const, name, commands: [{ command, cwd: worktreeConst }] }
    return { ...step, key: ScriptChain.keyOf(step) }
  }

  const stageOf = (it_: Harness) => it_.record()?.svnAction?.stage
  const needsOf = (it_: Harness) => it_.record()?.svnAction?.needs
  const lastRun = (it_: Harness) => it_.launched.at(-1)

  it('commits a live session: stops it, runs the frozen checks, updates, reviews, removes by identity and stays as a landed row', async () => {
    const live = { life: 'live' as const, binding: { hostInstanceId: 'h', generation: 1 }, exitReason: undefined }
    const it_ = await harness(live)
    it_.activity.set('s1', 'waiting')
    it_.checks.steps = [declared('lint', 'pnpm lint'), declared('tests', 'pnpm test')]

    expect(await it_.press('commit')).toEqual({ ok: true, value: { actionId: 'id-1' } })
    expect(it_.stops).toEqual(['s1'])
    expect(stageOf(it_)).toBe('stopping')
    expect(it_.launched).toEqual([])
    // A press after the first reads a newer `.worktree.json`; the action keeps the steps it froze.
    it_.checks.steps = [declared('other', 'rm -rf /')]

    await it_.store.put({ ...it_.record()!, life: 'ended', exitReason: 'stopped', binding: null })
    await it_.flow.drive('s1')
    expect(it_.log.slice(0, 1)).toEqual([`ownerCheck ${worktreeConst}`])
    expect(lastRun(it_)).toMatchObject({
      kind: 'shell', title: 'lint 014-fix-login', commands: [{ command: 'pnpm lint', cwd: worktreeConst }],
      scriptOf: { sessionId: 's1', phase: 'after', scriptId: 'checks', name: 'lint' },
    })
    await it_.endRun(0)
    expect(lastRun(it_)?.scriptOf).toMatchObject({ scriptId: 'checks', name: 'tests' })
    await it_.endRun(0)
    expect(lastRun(it_)).toMatchObject({
      title: 'svn update 014-fix-login',
      process: { tool: 'svn', args: ['--non-interactive', 'update', '--accept', 'postpone', '--', '.'] },
      directory: { mode: 'adHoc', path: worktreeConst },
      scriptOf: { phase: 'after', scriptId: 'svn', name: 'update' },
    })
    expect(it_.record()?.svnAction?.baseRevision).toBe(41)
    expect(it_.log).toContain(`scheduleMissing ${worktreeConst}`)

    it_.svn.rootsAnswers = [[root(['a.txt'])], [root([])]]
    await it_.endRun(0)
    expect(lastRun(it_)).toMatchObject({
      title: 'Review 014-fix-login',
      process: { tool: 'jamat-cli', args: ['sessions', 'worktree-review', '--self', '--wait'] },
      directory: { mode: 'adHoc', path: worktreeConst },
      scriptOf: { phase: 'after', scriptId: 'review', name: '.' },
    })
    expect(it_.record()?.svnAction?.roots?.[0]?.bounds).toEqual({ repository: repositoryConst, base: '/trunk', rootBase: 41, since: 50 })
    expect(it_.record()?.svnAction?.checksPassed).toEqual({ fingerprint: 'fp-1', at: 1_000 })

    it_.labels.afterReviews = [[receipt(51)]]
    await it_.endRun(0)
    expect(it_.log).toContain(`remove ${worktreeConst} [${repositoryConst}:r51]`)
    expect(it_.record()?.svnAction).toBeUndefined()
    expect(it_.record()?.worktreeOutcome).toMatchObject({
      result: 'committed', main: 'none', worktree: 'removed', revisions: [`${repositoryConst}:r51`],
      labelled: [receipt(51)], lines: [`-> committed app:r51 from ${worktreeConst}`, '   worktree removed'],
    })
    // The main copy lacks r51 until somebody updates it, so the session stays, not completed.
    expect(it_.record()?.completed).toBeUndefined()
    expect(it_.record()?.retiredWorktree).toMatchObject({ worktreePath: worktreeConst, ownerDir: ownerConst, landed: [receipt(51)] })
    expect(it_.ended).toEqual([])
    expect(it_.landedDue).toEqual([ownerConst])
    expect(it_.launched).toHaveLength(4)
    // The worker's proposal for the worktree served its review, so it goes.
    expect(it_.spent).toEqual([['s1', [worktreeConst]]])
  })

  it('refuses a session that still works until the person confirms it, naming its note', async () => {
    const it_ = await harness({ life: 'live', binding: { hostInstanceId: 'h', generation: 1 }, note: 'ready for review soon' })
    it_.activity.set('s1', 'working')

    expect(await it_.press('commit')).toEqual({
      ok: false,
      code: 'session-working',
      detail: 'Session s1 is still working (ready for review soon); finish it anyway, or wait until it is ready',
    })
    expect(it_.record()?.svnAction).toBeUndefined()
    expect(it_.stops).toEqual([])

    expect(await it_.press('commit', { confirmWorking: true })).toMatchObject({ ok: true })
    expect(stageOf(it_)).toBe('stopping')
    expect(it_.stops).toEqual(['s1'])
  })

  it('waits for the person when the session does not stop within a minute', async () => {
    const it_ = await harness({ life: 'live', binding: { hostInstanceId: 'h', generation: 1 } })
    await it_.press('commit')

    it_.clock.now += 60_000
    await it_.flow.drive('s1')
    expect(stageOf(it_)).toBe('stopping')
    it_.clock.now += 1
    await it_.flow.drive('s1')
    expect(needsOf(it_)).toMatchObject({ kind: 'not-stopped' })
  })

  it('refuses Commit before any stage without its review, while Keep and Discard still work', async () => {
    const it_ = await harness()
    it_.refusal.value = { ok: false, code: 'review-unavailable', detail: 'no commit dialog' }

    expect(await it_.press('commit')).toEqual({ ok: false, code: 'review-unavailable', detail: 'no commit dialog' })
    expect(it_.record()?.svnAction).toBeUndefined()
    expect(await it_.press('keep')).toEqual({ ok: true, value: { actionId: null } })
    expect(await it_.press('discard')).toMatchObject({ ok: true })
    expect(it_.ended).toEqual(['s1'])
  })

  it('answers merge-pending to a second press while the action runs', async () => {
    const it_ = await harness()
    await it_.press('commit')

    for (const choice of ['commit', 'keep', 'discard'] as const)
      expect(await it_.press(choice)).toMatchObject({ ok: false, code: 'merge-pending' })
  })

  it('waits on a failed check with its run named, and runs every check again on Finish again', async () => {
    const it_ = await harness()
    it_.checks.steps = [declared('lint', 'pnpm lint'), declared('tests', 'pnpm test')]
    await it_.press('commit')
    await it_.endRun(0)
    const failedRun = lastRun(it_)!

    await it_.endRun(1)
    expect(needsOf(it_)).toMatchObject({ kind: 'check-failed', reason: 'the check tests failed (the run ended with 1); its output is under Scripts' })
    expect(it_.record()?.svnAction?.runId).toBe(failedRun.sessionId)
    expect(it_.launched).toHaveLength(2)
    expect(it_.log.some((entry) => entry.startsWith('reviewRoots'))).toBe(false)
    expect(it_.reports.join('\n')).toMatch(/waits for you \(check-failed\)/)

    expect(await it_.press('commit')).toMatchObject({ ok: true, value: { actionId: 'id-1' } })
    expect(lastRun(it_)?.scriptOf).toMatchObject({ scriptId: 'checks', name: 'lint' })
    expect(needsOf(it_)).toBeUndefined()
  })

  it('runs the checks again for incoming commits twice, then waits; without checks it waits at once', async () => {
    const it_ = await harness()
    it_.checks.steps = [declared('tests', 'pnpm test')]
    it_.svn.incomingAnswers = [['src/b.txt']]
    await it_.press('commit')
    for (let round = 1; round <= 2; round += 1) {
      await it_.endRun(0)
      expect(lastRun(it_)?.scriptOf?.scriptId).toBe('svn')
      await it_.endRun(0)
      expect(lastRun(it_)?.scriptOf?.scriptId).toBe('checks')
      expect(it_.record()?.svnAction?.rounds.incoming).toBe(round)
    }
    await it_.endRun(0)
    await it_.endRun(0)
    expect(needsOf(it_)).toMatchObject({ kind: 'incoming', reason: 'other commits changed this project: src/b.txt' })

    const bare = await harness()
    bare.svn.incomingAnswers = [['src/b.txt']]
    await bare.press('commit')
    await bare.endRun(0)
    expect(needsOf(bare)).toMatchObject({ kind: 'incoming' })
    expect(bare.launched).toHaveLength(1)
  })

  it('never counts the commits of the worktree itself as incoming', async () => {
    const it_ = await harness({ commitReceipts: [{ scopeRoot: worktreeConst, revision: 44, paths: [], at: 5 }] })
    it_.labels.own = [proof(43)]
    await it_.press('commit')
    await it_.endRun(0)

    expect(it_.log).toContain(`incoming ${worktreeConst} r41 [a.txt] own [43,44]`)
  })

  it('waits for the person on a tree conflict after the update, and starts no resolver for it', async () => {
    const it_ = await harness()
    it_.svn.statusValue = { textConflicts: ['a.txt'], otherConflicts: ['tree.txt'], changed: ['a.txt'] }
    await it_.press('commit')
    await it_.endRun(0)
    expect(needsOf(it_)).toMatchObject({ kind: 'conflict', reason: 'tree or property conflicts after the update: tree.txt' })
    expect(it_.launched).toHaveLength(1)
    expect(it_.resolver.created).toEqual([])
  })

  const conflicted: SvnWorktreeStatus = { textConflicts: ['a.txt'], otherConflicts: [], changed: ['a.txt', 'notes.md'] }
  const clean: SvnWorktreeStatus = { textConflicts: [], otherConflicts: [], changed: ['a.txt', 'notes.md'] }

  /** A press whose update conflicts, so the resolver is started; answers the harness. */
  async function resolving(overrides: Partial<SessionRecord> = {}): Promise<Harness> {
    const it_ = await harness(overrides)
    it_.svn.statusValue = conflicted
    it_.svn.statusAfterResolve = [clean]
    it_.svn.changesValue = ['a.txt', 'notes.md']
    await it_.press('commit')
    await it_.endRun(0)
    return it_
  }

  it('forks the conversation of a Claude worker into a one-shot resolver in accept-edits mode, pointer first', async () => {
    const it_ = await resolving({ transcriptCwd: worktreeConst })

    expect(it_.resolver.created).toHaveLength(1)
    const { spec, marks } = it_.resolver.created[0]
    expect(spec).toMatchObject({
      kind: 'agent',
      directory: { mode: 'adHoc', path: worktreeConst },
      agent: { agentId: 'claude', mode: 'fork', forkParentId: 'native-1' },
      title: 'Resolve conflicts 014-fix-login',
    })
    expect(spec.agent?.initialPrompt).toContain('L:\\logs\\s1\\id-1-conflicts.txt')
    expect(marks).toEqual({ sessionId: 'id-4', oneShot: true, permission: 'accept-edits',
      scriptOf: { sessionId: 's1', phase: 'after', scriptId: 'svn-resolve', name: 'resolver' } })
    expect(it_.record()?.svnAction).toMatchObject({
      stage: 'resolving', runId: 'id-4', resolverSpent: true, conflicts: { paths: ['a.txt'], before: ['a.txt', 'notes.md'], at: 1_000 },
    })
  })

  it('starts a fresh Claude one-shot for a Codex worker, whose brief lists the conflicts and the session', async () => {
    const it_ = await resolving({ agent: { agentId: 'codex', launchMode: 'new', nativeSessionId: 'codex-1' } })

    const { spec } = it_.resolver.created[0]
    expect(spec.agent).toMatchObject({ agentId: 'claude', mode: 'new' })
    expect(spec.agent?.forkParentId).toBeUndefined()
    expect(spec.agent?.initialPrompt).toContain('id-1-conflicts.txt')
    const brief = it_.resolver.briefs.get('s1/id-1') ?? ''
    expect(brief).toContain('Session: 014 - fix login')
    expect(brief).toContain(`Working copy: ${worktreeConst}`)
    expect(brief).toContain('- a.txt')
    expect(brief).not.toContain('- notes.md')
  })

  it('waits for the person when no headless Claude can resolve the conflicts here', async () => {
    const it_ = await harness()
    it_.resolver.unavailable = 'claude was not found on PATH'
    it_.svn.statusValue = conflicted
    await it_.press('commit')
    await it_.endRun(0)

    expect(needsOf(it_)).toMatchObject({ kind: 'conflict', reason: 'conflicts after the update: a.txt; nobody can resolve them here (claude was not found on PATH)' })
    expect(it_.resolver.created).toEqual([])
  })

  it('waits on a conflicted name svn cannot take, without a resolver and without svn resolve', async () => {
    const it_ = await harness()
    it_.svn.statusValue = { textConflicts: ['ř.txt'], otherConflicts: [], changed: ['ř.txt'] }
    await it_.press('commit')
    await it_.endRun(0)

    expect(needsOf(it_)).toMatchObject({ kind: 'conflict' })
    expect(needsOf(it_)?.reason).toContain('ř.txt')
    expect(it_.resolver.created).toEqual([])
    expect(it_.log.some((entry) => entry.startsWith('resolve'))).toBe(false)
  })

  it('needs resolver-failed when the resolver exits 0 and leaves markers, and marks nothing resolved', async () => {
    const it_ = await resolving()
    it_.resolver.markers = ['a.txt']
    await it_.endRun(0)

    expect(needsOf(it_)).toMatchObject({ kind: 'resolver-failed', reason: 'the resolver left conflicts in: a.txt; resolve them by hand, then press Finish again' })
    expect(it_.log.some((entry) => entry.startsWith('resolve'))).toBe(false)
  })

  it('needs resolver-failed naming a file the resolver changed outside the conflicts', async () => {
    const it_ = await resolving()
    it_.svn.changesValue = ['a.txt', 'notes.md', 'src/other.ts']
    await it_.endRun(0)

    expect(needsOf(it_)).toMatchObject({ kind: 'resolver-failed' })
    expect(needsOf(it_)?.reason).toContain('outside the conflicts: src/other.ts')
    expect(it_.log.some((entry) => entry.startsWith('resolve'))).toBe(false)
  })

  it('verifies a resolver that exited 1 with clean files, marks them resolved and runs the checks again', async () => {
    const it_ = await harness()
    it_.checks.steps = [declared('tests', 'pnpm test')]
    it_.svn.statusValue = conflicted
    it_.svn.statusAfterResolve = [clean]
    it_.svn.changesValue = ['a.txt', 'notes.md']
    await it_.press('commit')
    await it_.endRun(0)
    await it_.endRun(0)
    expect(stageOf(it_)).toBe('resolving')

    await it_.endRun(1)
    expect(it_.log).toContain(`resolve ${worktreeConst} [a.txt]`)
    expect(lastRun(it_)?.scriptOf).toMatchObject({ scriptId: 'checks', name: 'tests' })
    expect(needsOf(it_)).toBeUndefined()
    await it_.endRun(0)
    expect(lastRun(it_)?.scriptOf).toMatchObject({ scriptId: 'svn', name: 'update' })
    await it_.endRun(0)
    expect(lastRun(it_)?.scriptOf?.scriptId).toBe('review')
  })

  it('needs conflict when svn still marks a conflict after the resolve', async () => {
    const it_ = await resolving()
    it_.svn.statusAfterResolve = [{ textConflicts: [], otherConflicts: ['a.txt'], changed: ['a.txt'] }]
    await it_.endRun(0)

    expect(needsOf(it_)).toMatchObject({ kind: 'conflict', reason: 'conflicts are still marked after the resolver: a.txt' })
  })

  it('runs one resolver per press: a second conflict needs the person, and Finish again allows a new resolver', async () => {
    const it_ = await resolving()
    await it_.endRun(0)
    expect(lastRun(it_)?.scriptOf?.name).toBe('update')
    it_.svn.statusValue = conflicted
    await it_.endRun(0)

    expect(needsOf(it_)).toMatchObject({ kind: 'conflict' })
    expect(needsOf(it_)?.reason).toContain('one resolver runs per press; resolve them by hand or press Finish again')
    expect(it_.resolver.created).toHaveLength(1)

    await it_.press('commit')
    expect(it_.record()?.svnAction?.resolverSpent).toBeUndefined()
    await it_.endRun(0)
    expect(it_.resolver.created).toHaveLength(2)
    expect(stageOf(it_)).toBe('resolving')
  })

  it('stops a resolver that runs past 20 minutes and waits for the person', async () => {
    const it_ = await resolving()
    const runId = it_.record()?.svnAction?.runId
    it_.clock.now += 20 * 60_000
    await it_.flow.drive('s1')
    expect(stageOf(it_)).toBe('resolving')
    expect(it_.resolver.stopped).toEqual([])

    it_.clock.now += 1
    await it_.flow.drive('s1')
    expect(it_.resolver.stopped).toEqual([runId])
    expect(needsOf(it_)).toMatchObject({ kind: 'resolver-failed' })
    expect(needsOf(it_)?.reason).toContain('longer than 20 minutes')
  })

  it('keeps the pointer of a refused create whose record stays pending, and starts no second resolver', async () => {
    const it_ = await harness()
    it_.svn.statusValue = conflicted
    it_.resolver.answer = { ok: false, code: 'host-unreachable', detail: 'the Host did not answer' }
    it_.resolver.leaves = 'pending'
    await it_.press('commit')
    await it_.endRun(0)

    expect(it_.record()?.svnAction).toMatchObject({ stage: 'resolving', runId: 'id-4' })
    expect(needsOf(it_)).toBeUndefined()
    expect(it_.reports.join('\n')).toMatch(/could not be started yet/)
    await it_.flow.drive('s1')
    expect(it_.resolver.created).toHaveLength(1)

    const decided = await harness()
    decided.svn.statusValue = conflicted
    decided.resolver.answer = { ok: false, code: 'spawn-failed', detail: 'the Host refused' }
    decided.resolver.leaves = 'ended'
    await decided.press('commit')
    await decided.endRun(0)
    expect(needsOf(decided)).toMatchObject({ kind: 'resolver-failed' })
    expect(needsOf(decided)?.reason).toContain('the Host refused')
  })

  it('leaves a resolver whose record the create has not written yet to the next pass while it drives', async () => {
    const it_ = await harness()
    it_.svn.statusValue = conflicted
    it_.resolver.leaves = 'none'
    const early: boolean[] = []
    it_.resolver.onCreate = async () => { early.push(await it_.flow.noteVerdict('s1', { kind: 'failed', reason: 'its record is gone' })) }
    await it_.press('commit')
    await it_.endRun(0)
    expect(early).toEqual([false])
    expect(stageOf(it_)).toBe('resolving')

    it_.resolver.markers = ['a.txt']
    expect(await it_.flow.noteVerdict('s1', { kind: 'failed', reason: 'its record is gone' })).toBe(true)
    await it_.settled()
    expect(needsOf(it_)).toMatchObject({ kind: 'resolver-failed' })
  })

  it('relaunches an update a lock stopped after 1, 2 and 2 seconds, runs svn cleanup once, and then waits', async () => {
    const it_ = await harness()
    it_.svn.lockedValue = true
    await it_.press('commit')
    for (const delay of [1_000, 2_000, 2_000]) {
      const runs = it_.launched.length
      await it_.endRun(1)
      expect(it_.record()?.svnAction?.retryAt).toBe(it_.clock.now + delay)
      await it_.flow.drive('s1')
      expect(it_.launched).toHaveLength(runs)
      it_.clock.now += delay
      await it_.flow.drive('s1')
      expect(it_.launched).toHaveLength(runs + 1)
      expect(lastRun(it_)?.scriptOf?.name).toBe('update')
    }
    await it_.endRun(1)
    expect(lastRun(it_)).toMatchObject({ title: 'svn cleanup 014-fix-login', process: { args: ['--non-interactive', 'cleanup', '--', '.'] } })
    await it_.endRun(0)
    expect(lastRun(it_)?.scriptOf?.name).toBe('update')
    await it_.endRun(1)
    expect(needsOf(it_)).toMatchObject({ kind: 'locked' })

    const failed = await harness()
    await failed.press('commit')
    await failed.endRun(1)
    expect(needsOf(failed)).toMatchObject({ kind: 'svn-failed' })
  })

  it('only removes when everything was committed from the split before Finish, and carries the receipt', async () => {
    const it_ = await harness()
    it_.labels.own = [receipt(44)]
    it_.svn.rootsAnswers = [[root([])]]
    await it_.press('commit')
    await it_.endRun(0)

    expect(it_.launched).toHaveLength(1)
    expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'committed', labelled: [receipt(44)], worktree: 'removed' })
    expect(it_.record()?.retiredWorktree?.landed).toEqual([receipt(44)])
    expect(it_.ended).toEqual([])
  })

  it('goes on to the removal when the root is clean after a review run that ended cancelled', async () => {
    const it_ = await harness()
    it_.svn.rootsAnswers = [[root(['a.txt'])], [root([])]]
    it_.labels.afterReviews = [[]]
    it_.labels.inferredValue = [{ repository: repositoryConst, revision: 52, label: 'inferred' }]
    await it_.press('commit')
    await it_.endRun(0)

    await it_.endRun(10)
    expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'committed', labelled: [{ revision: 52, label: 'inferred' }] })
    expect(it_.record()?.retiredWorktree?.landed).toEqual([{ repository: repositoryConst, revision: 52, label: 'inferred' }])
    expect(it_.ended).toEqual([])
  })

  it('waits after a cancelled review, and Finish again reviews without the checks while nothing changed', async () => {
    const it_ = await harness()
    it_.checks.steps = [declared('tests', 'pnpm test')]
    await it_.press('commit')
    await it_.endRun(0)
    await it_.endRun(0)
    expect(lastRun(it_)?.scriptOf?.scriptId).toBe('review')

    await it_.endRun(10)
    expect(needsOf(it_)).toMatchObject({ kind: 'review-cancelled', reason: `the review of ${worktreeConst} ended without a commit; 1 change left` })
    expect(it_.reports).toEqual([])

    await it_.press('commit')
    expect(lastRun(it_)?.scriptOf?.scriptId).toBe('review')
    expect(it_.launched).toHaveLength(4)

    await it_.endRun(10)
    it_.svn.fingerprintValue = 'fp-2'
    await it_.press('commit')
    expect(lastRun(it_)?.scriptOf?.scriptId).toBe('checks')
  })

  it('waits on a partial commit, and Keep ends the action with the worktree kept', async () => {
    const it_ = await harness()
    it_.labels.afterReviews = [[receipt(51)]]
    await it_.press('commit')
    await it_.endRun(0)
    await it_.endRun(0)

    expect(needsOf(it_)).toMatchObject({ kind: 'partial' })
    expect(it_.record()?.svnAction?.evidence).toEqual([receipt(51)])
    expect(await it_.press('keep')).toEqual({ ok: true, value: { actionId: 'id-1' } })
    expect(it_.record()?.svnAction).toBeUndefined()
    expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'partial', worktree: 'kept', revisions: [`${repositoryConst}:r51`] })
    expect(it_.record()?.worktree).toBeDefined()
    expect(it_.ended).toEqual([])
    // Kept work is reviewed again later, with the same proposal.
    expect(it_.spent).toEqual([])
  })

  it('updates again after an out-of-date review twice, each time with a new review, and waits the third time', async () => {
    const it_ = await harness()
    await it_.press('commit')
    await it_.endRun(0)
    for (let round = 1; round <= 2; round += 1) {
      await it_.endRun(12)
      expect(lastRun(it_)?.scriptOf?.name).toBe('update')
      await it_.endRun(0)
      expect(lastRun(it_)?.scriptOf?.scriptId).toBe('review')
    }
    await it_.endRun(12)
    expect(needsOf(it_)).toMatchObject({ kind: 'out-of-date' })
  })

  it('reviews a changed mount before the worktree, and waits on a pinned one before any review', async () => {
    const it_ = await harness()
    it_.svn.rootsAnswers = [[root(['lib/l.txt'], 'lib'), root(['a.txt'])], [root([], 'lib'), root(['a.txt'])]]
    await it_.press('commit')
    await it_.endRun(0)
    expect(lastRun(it_)).toMatchObject({ title: 'Review 014-fix-login (lib)', directory: { path: mountConst }, scriptOf: { name: 'lib' } })
    await it_.endRun(0)
    expect(lastRun(it_)).toMatchObject({ title: 'Review 014-fix-login', directory: { path: worktreeConst } })

    const pinned = await harness()
    pinned.svn.rootsAnswers = [[root(['lib/l.txt'], 'lib', true), root(['a.txt'])]]
    await pinned.press('commit')
    await pinned.endRun(0)
    expect(needsOf(pinned)).toMatchObject({ kind: 'pinned-external' })
    expect(pinned.launched).toHaveLength(1)
  })

  it('judges a check that ended while no client ran, and launches the update without a press', async () => {
    const it_ = await harness()
    it_.checks.steps = [declared('tests', 'pnpm test')]
    await it_.press('commit')
    const restarted = it_.restart()

    await it_.endRun(0)
    expect(lastRun(it_)?.scriptOf?.name).toBe('update')
    expect(restarted).toBe(it_.flow)
  })

  it('waits after a review the client lost, and opens no review by itself', async () => {
    const it_ = await harness()
    await it_.press('commit')
    await it_.endRun(0)
    it_.restart()

    await it_.endRun(14)
    expect(needsOf(it_)).toMatchObject({ kind: 'review-interrupted' })
    await it_.flow.drive('s1')
    expect(it_.launched).toHaveLength(2)

    const lost = await harness()
    await lost.press('commit')
    await lost.endRun(0)
    await lost.endRun(undefined, 'lost')
    expect(needsOf(lost)).toMatchObject({ kind: 'review-interrupted' })
  })

  it('finishes a removal a restart cut short: a worktree already gone is success, recorded once', async () => {
    const it_ = await harness()
    await it_.press('commit')
    const action = it_.record()!.svnAction!
    const gone: SessionRecord = { ...it_.record()!, completed: true, svnAction: { ...action, stage: 'removing', evidence: [receipt(51)] },
      retiredWorktree: { worktreePath: worktreeConst, kind: 'svn', revisions: [], removedAt: 2 } }
    delete gone.worktree
    await it_.store.put(gone)
    it_.restart()

    await it_.flow.drive('s1')
    await it_.flow.drive('s1')
    expect(it_.log.some((entry) => entry.startsWith('remove'))).toBe(false)
    expect(it_.record()?.svnAction).toBeUndefined()
    expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'committed', worktree: 'removed' })
    expect(it_.record()?.retiredWorktree).toMatchObject({ ownerDir: ownerConst, landed: [receipt(51)] })
    expect(it_.ended).toEqual([])
    expect(it_.landedDue).toEqual([ownerConst])
  })

  it('discards a live session: stops it, reads its own commits, removes and goes without an outcome', async () => {
    const it_ = await harness({ life: 'live', binding: { hostInstanceId: 'h', generation: 1 } })
    it_.labels.own = [proof(43)]
    await it_.press('discard')
    expect(it_.stops).toEqual(['s1'])
    await it_.store.put({ ...it_.record()!, life: 'ended', binding: null })

    await it_.flow.drive('s1')

    expect(it_.log).toContain(`remove ${worktreeConst} [${repositoryConst}:r43]`)
    expect(it_.log.some((entry) => entry.startsWith('ownerCheck'))).toBe(false)
    expect(it_.launched).toEqual([])
    expect(it_.record()?.worktreeOutcome).toBeUndefined()
    expect(it_.ended).toEqual(['s1'])
  })

  it('discards the worktree of an action that waits for the person', async () => {
    const it_ = await harness()
    await it_.press('commit')
    await it_.endRun(0)
    await it_.endRun(10)
    expect(needsOf(it_)).toMatchObject({ kind: 'review-cancelled' })

    const discarded = await it_.press('discard')
    if (!discarded.ok || discarded.value.actionId === null) throw new Error('the Discard was not taken')
    expect(discarded.value.actionId).not.toBe('id-1')
    expect(it_.flow.endingOf(discarded.value.actionId)).toBe('removed')
    expect(it_.ended).toEqual(['s1'])
  })

  it('records a removal a holder stopped as committed, and asks the cleanup to finish it', async () => {
    const it_ = await harness()
    it_.removal.state = 'in-use'
    it_.labels.afterReviews = [[receipt(51)]]
    it_.svn.rootsAnswers = [[root(['a.txt'])], [root([])]]
    await it_.press('commit')
    await it_.endRun(0)
    await it_.endRun(0)

    expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'committed', worktree: 'in-use' })
    expect(it_.record()?.worktreeCleanup).toEqual({ phase: 'pending', trigger: 'removal-unfinished', requestedAt: 1_000, attempts: 0 })
    expect(it_.ended).toEqual([])

    const discarded = await harness()
    discarded.removal.state = 'undeleted'
    await discarded.press('discard')
    expect(discarded.record()?.worktreeCleanup).toMatchObject({ phase: 'pending', trigger: 'discard-unfinished' })
  })

  it('keeps the worktree when a reopen won the race with the removal', async () => {
    const it_ = await harness()
    it_.removal.state = 'kept'
    it_.svn.rootsAnswers = [[root([])]]
    await it_.press('commit')
    await it_.endRun(0)

    expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'nothing', worktree: 'kept', lines: expect.arrayContaining([`KEPT: ${worktreeConst} stays`]) })
    expect(it_.record()?.worktree).toBeDefined()
    expect(it_.record()?.worktreeCleanup).toBeUndefined()
    expect(it_.ended).toEqual([])
  })

  it('waits for the person when the owner no longer checks out the worktree, and touches nothing', async () => {
    const it_ = await harness()
    it_.svn.ownerRefusal = `The owner ${ownerConst} is gone`
    await it_.press('commit')

    expect(needsOf(it_)).toMatchObject({ kind: 'svn-failed', reason: `REFUSED: The owner ${ownerConst} is gone` })
    expect(it_.launched).toEqual([])
  })

  it('ends the action as failed on an unexpected throw, keeping the worktree', async () => {
    const it_ = await harness()
    it_.svn.reviewRoots = () => Promise.reject(new Error('the disk went away'))
    await it_.press('commit')
    await it_.endRun(0)

    expect(it_.record()?.svnAction).toBeUndefined()
    expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'failed', worktree: 'kept' })
    expect(it_.record()?.worktreeOutcome?.lines[0]).toMatch(/the disk went away/)
    expect(it_.record()?.worktree).toBeDefined()
  })

  it('clears a Finish checks chain a 3.10 build left on an SVN record with its first press', async () => {
    const step = declared('tests', 'pnpm test')
    const it_ = await harness({ finishChecks: { runId: 'old', steps: [step], cursor: 0, startedAt: 1, result: { kind: 'failed', reason: 'x', at: 2 } } })

    await it_.press('commit')
    expect(it_.record()?.finishChecks).toBeUndefined()
    expect(it_.record()?.svnAction).toBeDefined()
  })

  it('refuses what the agreement over the checks refuses, before anything is written', async () => {
    const it_ = await harness()
    it_.checks.refusal = { ok: false, code: 'setup-not-acknowledged', detail: 'agree first' }

    expect(await it_.press('commit')).toEqual({ ok: false, code: 'setup-not-acknowledged', detail: 'agree first' })
    expect(it_.record()?.svnAction).toBeUndefined()
  })

  describe('UPDATE of a main copy', () => {
    /** A landed row: the worktree went after r51, which the main copy lacks. */
    const landedRow = (): Partial<SessionRecord> => ({
      worktree: undefined,
      transcriptCwd: worktreeConst,
      retiredWorktree: { worktreePath: worktreeConst, kind: 'svn', revisions: [], removedAt: 1, ownerDir: ownerConst, landed: [receipt(51)] },
    })
    const update = (it_: Harness) => it_.flow.startUpdate('s1', ownerConst, 'window').then(async (answer) => {
      await it_.settled()
      return answer
    })

    it('updates the main copy as a run of the session, never schedules a deletion there, writes no result and reads the landed rows', async () => {
      const it_ = await harness(landedRow())
      it_.svn.statusValue = { textConflicts: [], otherConflicts: [], changed: ['local.txt'] }

      expect(await update(it_)).toEqual({ ok: true, value: { actionId: 'id-1' } })
      expect(it_.stops).toEqual([])
      expect(lastRun(it_)).toMatchObject({
        title: 'svn update App',
        process: { tool: 'svn', args: ['--non-interactive', 'update', '--accept', 'postpone', '--', '.'] },
        directory: { mode: 'adHoc', path: ownerConst },
        scriptOf: { sessionId: 's1', phase: 'after', scriptId: 'svn', name: 'update' },
      })
      expect(it_.record()?.svnAction).toMatchObject({ kind: 'update-main', stage: 'updating', root: ownerConst, baseRevision: 41 })
      expect(it_.log.some((entry) => entry.startsWith('scheduleMissing'))).toBe(false)

      await it_.endRun(0)
      expect(it_.record()?.svnAction).toBeUndefined()
      expect(it_.record()?.retiredWorktree?.landed).toEqual([receipt(51)])
      expect(it_.landedDue).toEqual([ownerConst])
      expect(it_.ended).toEqual([])
      expect(existsSync(it_.resultsDirectory)).toBe(false)
    })

    it('relaunches an update a lock stopped on the lock pace, then waits for the person and never cleans a main copy up', async () => {
      const it_ = await harness(landedRow())
      it_.svn.lockedValue = true
      await update(it_)
      for (const delay of [1_000, 2_000, 2_000]) {
        const runs = it_.launched.length
        await it_.endRun(1)
        expect(it_.record()?.svnAction?.retryAt).toBe(it_.clock.now + delay)
        it_.clock.now += delay
        await it_.flow.drive('s1')
        expect(it_.launched).toHaveLength(runs + 1)
        expect(lastRun(it_)?.scriptOf?.name).toBe('update')
      }
      await it_.endRun(1)
      expect(needsOf(it_)).toMatchObject({ kind: 'locked' })
      expect(needsOf(it_)?.reason).toContain('press UPDATE again')
      expect(it_.launched.every((run) => run.process?.args.includes('cleanup') !== true)).toBe(true)
      expect(it_.launched).toHaveLength(4)

      // UPDATE again replaces the waiting one.
      it_.svn.lockedValue = false
      expect(await update(it_)).toMatchObject({ ok: true })
      expect(it_.record()?.svnAction).toMatchObject({ kind: 'update-main', stage: 'updating', rounds: { lock: 0 } })
      expect(it_.record()?.svnAction?.needs).toBeUndefined()
    })

    it('names a failed update, refuses a second one while one runs, and refuses one beside a Finish', async () => {
      const it_ = await harness(landedRow())
      await update(it_)
      expect(await it_.flow.startUpdate('s1', ownerConst, 'cli')).toMatchObject({ ok: false, code: 'merge-pending' })
      await it_.endRun(1)
      expect(needsOf(it_)).toMatchObject({ kind: 'svn-failed' })

      const finishing = await harness()
      await finishing.press('commit')
      expect(await finishing.flow.startUpdate('s1', ownerConst, 'cli')).toMatchObject({ ok: false, code: 'merge-pending' })
    })

    it('resolves a text conflict in the main copy with a fresh resolver, checks only the markers, and shows the merge as a diff run', async () => {
      const it_ = await harness(landedRow())
      it_.svn.statusValue = { textConflicts: ['src/a.ts'], otherConflicts: [], changed: ['src/a.ts'] }
      it_.svn.statusAfterResolve = [{ textConflicts: [], otherConflicts: [], changed: ['src/a.ts'] }]
      // Another session changed a file meanwhile: in a main copy that proves nothing about the resolver.
      it_.svn.changesValue = ['src/a.ts', 'other.txt']
      await update(it_)
      await it_.endRun(0)

      const { spec } = it_.resolver.created[0]
      // The worker's conversation ran in the worktree, which is gone: a fresh one-shot in the main copy.
      expect(spec).toMatchObject({ directory: { mode: 'adHoc', path: ownerConst }, agent: { agentId: 'claude', mode: 'new' } })
      const brief = it_.resolver.briefs.get('s1/id-1') ?? ''
      expect(brief).toContain(`Main copy: ${ownerConst}`)
      expect(brief).toContain('- src/a.ts')

      await it_.endRun(0)
      expect(it_.log).toContain(`resolve ${ownerConst} [src/a.ts]`)
      expect(it_.log.some((entry) => entry.startsWith('changes'))).toBe(false)
      expect(lastRun(it_)).toMatchObject({
        title: 'svn diff App',
        process: { tool: 'svn', args: ['--non-interactive', 'diff', '--', 'src/a.ts@'] },
        directory: { mode: 'adHoc', path: ownerConst },
        scriptOf: { phase: 'after', scriptId: 'svn', name: 'diff' },
      })
      expect(stageOf(it_)).toBe('diffing')

      await it_.endRun(1)
      expect(it_.record()?.svnAction).toBeUndefined()
      expect(it_.landedDue).toEqual([ownerConst])
    })

    it('waits for the person on a tree conflict, and on markers the resolver left', async () => {
      const tree = await harness(landedRow())
      tree.svn.statusValue = { textConflicts: [], otherConflicts: ['gone'], changed: [] }
      await update(tree)
      await tree.endRun(0)
      expect(needsOf(tree)).toMatchObject({ kind: 'conflict' })

      const marked = await harness(landedRow())
      marked.svn.statusValue = { textConflicts: ['a.txt'], otherConflicts: [], changed: ['a.txt'] }
      marked.resolver.markers = ['a.txt']
      await update(marked)
      await marked.endRun(0)
      await marked.endRun(0)
      expect(needsOf(marked)).toMatchObject({ kind: 'resolver-failed' })
      expect(needsOf(marked)?.reason).toContain('press UPDATE again')
    })
  })

  describe('results', () => {
    const caller = { tag: 'run-7', notify: { sessionId: 'coordinator', text: '$pp:work-tickets watch' } }
    const historyOf = (runId: string, startedAt: number): NonNullable<SessionRecord['scriptRuns']>[number] => ({
      runId, phase: 'after', scriptId: 'svn', name: 'update', title: `svn update ${runId}`, commands: [], startedAt, endedAt: startedAt + 1,
      exitCode: 0, outcome: 'succeeded', log: { state: 'saved', bytes: 1, truncated: false },
    })

    it('writes a committed Finish with its tag, labelled revisions, lines, removal and log copies; a resumed recording rewrites it', async () => {
      const it_ = await harness({ worktree: { ...recordOf().worktree!, caller } })
      it_.labels.afterReviews = [[receipt(51)]]
      it_.svn.rootsAnswers = [[root(['a.txt'])], [root([])]]
      await it_.press('commit')
      const pressed = it_.record()!.svnAction!
      await it_.endRun(0)
      await it_.logs.write('s1', 'old-run', 'an earlier Finish')
      await it_.logs.write('s1', 'update-run', 'Updated to revision 50.')
      await it_.store.put({ ...it_.record()!, scriptRuns: [historyOf('old-run', 10), historyOf('update-run', 1_000)] })
      await it_.endRun(0)

      const copy = join(it_.resultsDirectory, 'id-1', 'update-run.log')
      expect(readdirSync(it_.resultsDirectory).filter((name) => name.endsWith('.json'))).toEqual(['id-1.json'])
      expect(it_.results.list({ tag: 'run-7' })).toEqual([{
        actionId: 'id-1', action: 'finish', result: 'committed', sessionId: 's1', title: '014 - fix login', tag: 'run-7',
        worktreePath: worktreeConst, mainCopy: ownerConst, directoryId: '1:2:3', removal: 'removed', revisions: [receipt(51)],
        lines: [`-> committed app:r51 from ${worktreeConst}`, '   worktree removed'],
        logs: [{ runId: 'update-run', title: 'svn update update-run', path: copy }],
        notify: { sessionId: 'coordinator', text: '$pp:work-tickets watch', state: 'pending', at: null, attempts: 0 },
        at: 1_000, acknowledgedAt: null,
      }])
      expect(readFileSync(copy, 'utf8')).toBe('Updated to revision 50.')
      expect(existsSync(join(it_.resultsDirectory, 'id-1', 'old-run.log'))).toBe(false)

      // The client died after the result and before the record: the next client records again.
      await it_.results.noteNotify(['id-1'], 'delivered', 2_000)
      await it_.store.put({ ...it_.record()!, svnAction: { ...pressed, stage: 'recording', removal: 'removed', evidence: [receipt(51)] } })
      it_.restart()
      await it_.flow.drive('s1')
      expect(readdirSync(it_.resultsDirectory).filter((name) => name.endsWith('.json'))).toEqual(['id-1.json'])
      expect(it_.results.list({})).toHaveLength(1)
      expect(it_.results.list({})[0].notify).toMatchObject({ state: 'delivered', at: 2_000 })
    })

    it('writes kept for a Keep without commits, discarded for a Discard, and answers tag null without a caller', async () => {
      const kept = await harness()
      await kept.press('commit')
      await kept.endRun(0)
      await kept.endRun(ReviewRunExit.cancelledConst)
      await kept.press('keep')
      expect(kept.results.list({})).toEqual([expect.objectContaining({
        actionId: 'id-1', action: 'finish', result: 'kept', removal: 'kept', tag: null, notify: null,
      })])

      const discarded = await harness({ worktree: { ...recordOf().worktree!, caller: { tag: 'run-8' } } })
      await discarded.press('discard')
      expect(discarded.results.list({ tag: 'run-8' })).toEqual([expect.objectContaining({
        action: 'discard', result: 'discarded', removal: 'removed', lines: [`DISCARDED: ${worktreeConst}`, '   worktree removed'],
      })])
    })

    it('writes partial for a Keep after a partial commit, and pending for a removal a holder stopped', async () => {
      const partial = await harness()
      partial.labels.afterReviews = [[receipt(51)]]
      partial.svn.rootsAnswers = [[root(['a.txt', 'b.txt'])], [root(['b.txt'])]]
      await partial.press('commit')
      await partial.endRun(0)
      await partial.endRun(0)
      expect(needsOf(partial)).toMatchObject({ kind: 'partial' })
      await partial.press('keep')
      expect(partial.results.list({})[0]).toMatchObject({ result: 'partial', removal: 'kept', revisions: [receipt(51)] })

      const held = await harness()
      held.removal.state = 'in-use'
      held.labels.afterReviews = [[receipt(51)]]
      held.svn.rootsAnswers = [[root(['a.txt'])], [root([])]]
      await held.press('commit')
      await held.endRun(0)
      await held.endRun(0)
      expect(held.results.list({})[0]).toMatchObject({ result: 'committed', removal: 'pending' })
      expect(held.results.pendingRemovalsOf('s1')).toEqual(['id-1'])
    })

    it('writes failed on an unexpected throw, and a result that cannot be written never stops the ending', async () => {
      const it_ = await harness()
      it_.svn.reviewRoots = () => Promise.reject(new Error('the disk went away'))
      await it_.press('commit')
      await it_.endRun(0)
      expect(it_.results.list({})[0]).toMatchObject({ result: 'failed', removal: 'kept' })

      const blocked = await harness()
      blocked.results.put = () => Promise.reject(new Error('disk full'))
      await blocked.press('discard')
      expect(blocked.ended).toEqual(['s1'])
      expect(blocked.reports.join('\n')).toMatch(/the result of its SVN discard was not written: disk full/)
    })
  })
})
