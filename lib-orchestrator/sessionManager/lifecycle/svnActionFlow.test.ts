import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  SvnBounds,
  SvnConflictFact,
  SvnConflictRead,
  SvnLogEntry,
  SvnResult,
  SvnReviewRoot,
  SvnRoot,
  SvnStatusRow,
  SvnWorktreeLocation,
  SvnWorktreeStatus,
} from '../../svn/svn.types'
import type { SessionRecord, SessionRecordScriptStep } from '../records/sessionRecord.types'
import { SvnWaitNotices } from '../notifies/svnWaitNotices'
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
import { SessionStepWords } from './sessionStepWords'
import { type SvnActionPort, SvnActionFlow } from './svnActionFlow'
import { SvnActionStages } from './svnActionStages'
import { SvnActionWorkflow } from './svnActionWorkflow'
import type { SvnLabelsRead } from './svnRevisionLabels'
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

  const textFact = (path: string): SvnConflictFact => ({
    path, kind: 'text', takesArgument: /^[ -~]*$/.test(path), tree: null, sidecars: [], properties: [],
    content: { binary: false, unreadable: false, equal: 'differs' },
  })
  const treeFact = (path: string, tree: Partial<NonNullable<SvnConflictFact['tree']>> = {}): SvnConflictFact => ({
    path, kind: 'tree', takesArgument: true, sidecars: [], properties: [], content: null,
    tree: { reason: 'edited', action: 'deleted', localKind: 'file', incomingKind: 'none', incomingRevision: 42, localHistory: false, ...tree },
  })

  /** The svn reads of an action; each answers what its field says, and every call is logged. */
  class FakeSvn {
    readonly log: string[]
    ownerRefusal: string | null = null
    revision = 41
    /** How the BASE read goes: an answer, a failed read, or a throw. */
    revisionRead: 'ok' | 'fails' | 'throws' = 'ok'
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
    /** The facts of the conflict set; null: a text fact per text conflict and a tree fact per other conflict of `statusValue`. */
    conflictFacts: SvnConflictFact[] | null = null
    /** The conflict set read fails with this detail. */
    conflictSetFailure: string | null = null

    constructor(log: string[]) {
      this.log = log
    }

    ownerCheck(location: SvnWorktreeLocation): Promise<SvnResult<void>> {
      this.log.push(`ownerCheck ${location.worktreePath}`)
      return Promise.resolve(this.ownerRefusal === null ? ok(undefined) : { ok: false, code: 'refused', detail: this.ownerRefusal })
    }

    scheduleMissing(path: string, victims: readonly string[] = []): Promise<SvnResult<void>> {
      this.log.push(`scheduleMissing ${path}${victims.length === 0 ? '' : ` except [${victims.join(',')}]`}`)
      return Promise.resolve(ok(undefined))
    }

    revisionOf(path: string): Promise<SvnResult<number>> {
      this.log.push(`revisionOf ${path}`)
      const read = this.revisionRead
      if (read === 'ok') return Promise.resolve(ok(this.revision))
      else if (read === 'fails') return Promise.resolve({ ok: false, code: 'svn-failed', detail: 'E155007: not a working copy' })
      else if (read === 'throws') return Promise.reject(new Error('the disk went away'))
      else throw new Error(`Unknown revision read: ${JSON.stringify(read satisfies never)}`)
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

    conflictSet(path: string, base: number): Promise<SvnResult<SvnConflictRead>> {
      this.log.push(`conflictSet ${path} r${base}`)
      if (this.conflictSetFailure !== null) return Promise.resolve({ ok: false, code: 'svn-failed', detail: this.conflictSetFailure })
      const facts = this.conflictFacts ?? [...this.statusValue.textConflicts.map((conflicted) => textFact(conflicted)),
        ...this.statusValue.otherConflicts.map((conflicted) => treeFact(conflicted))]
      return Promise.resolve(ok({ revision: 42, facts, rows: [] }))
    }

    /** The commits the brief quotes. */
    logEntries: SvnLogEntry[] = [{ revision: 42, author: 'ana', message: 'Add the r42 trail' }]
    /** The content of each path as its hash; a path not named hashes as `same`. */
    contents = new Map<string, string>()
    /** The highest BASE past the update, or null. */
    baseAboveValue: number | null = null

    hashes(path: string, paths: readonly string[]): Promise<SvnResult<Record<string, string>>> {
      this.log.push(`hashes ${path} [${paths.join(',')}]`)
      return Promise.resolve(ok(Object.fromEntries(paths.map((entry) => [entry, this.contents.get(entry) ?? 'same']))))
    }

    baseAbove(path: string, revision: number): Promise<SvnResult<number | null>> {
      this.log.push(`baseAbove ${path} r${revision}`)
      return Promise.resolve(ok(this.baseAboveValue))
    }

    logOf(path: string, from: number, to: number): Promise<SvnResult<SvnLogEntry[]>> {
      this.log.push(`logOf ${path} r${from}:${to}`)
      return Promise.resolve(ok(this.logEntries))
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
    /** The reads `ownCommits` reports before it answers. */
    reads: SvnLabelsRead[] = []
    ownCommits(_path: string, _receipts: unknown, _since: number, onRead?: (read: SvnLabelsRead) => void): Promise<SvnResult<SvnLabelledRevision[]>> {
      for (const read of this.reads) onRead?.(read)
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
    /** Every step text the flow set, in order, a repeat of the same text once. */
    stepTexts: string[]
    /** Every step the flow set, as `text | detail`. */
    stepDetails: string[]
    /** The step each session holds now, by its text. */
    steps: Map<string, string>
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
    const stepTexts: string[] = []
    const stepDetails: string[] = []
    const steps = new Map<string, string>()
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
        scheduleMissing: (path, victims) => svn.scheduleMissing(path, victims),
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
        conflictSet: (path, base) => svn.conflictSet(path, base),
        logOf: (path, from, to) => svn.logOf(path, from, to),
        hashes: (path, paths) => svn.hashes(path, paths),
        baseAbove: (path, revision) => svn.baseAbove(path, revision),
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
          mergeBriefPathOf: (parentId, actionId) => `L:/logs/${parentId}/${actionId}-merge.md`,
          writeMergeBrief: async (parentId, actionId, text) => {
            resolver.briefs.set(`${parentId}/${actionId}-merge`, text)
            return { ok: true, bytes: text.length }
          },
        },
        withMarkers: async (_root, paths) => paths.filter((path) => resolver.markers.includes(path)),
      },
      resolutions: {
        apply: async (input) => {
          log.push(`apply ${input.path} ${input.option}`)
          await input.onStep({ option: input.option, done: 1 }, [])
          return ok(undefined)
        },
      },
      results,
      createResolver: async (spec, marks) => {
        resolver.created.push({ spec, marks })
        await resolver.onCreate?.()
        const run: SessionRecord = {
          sessionId: marks.sessionId, kind: 'agent', title: spec.title ?? 'resolver', directory: spec.directory, createdAt: clock.now,
          agent: { agentId: 'claude', launchMode: spec.agent?.mode ?? 'new', ...marks.oneShot ? { oneShot: true as const } : {}, permission: marks.permission },
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
      steps: {
        at: (sessionId, facts, progress) => {
          const { text, detail } = SessionStepWords.of(facts, progress ?? null)
          if (stepTexts.at(-1) !== text) stepTexts.push(text)
          stepDetails.push(`${text} | ${detail}`)
          steps.set(sessionId, text)
        },
        clear: (sessionId) => steps.delete(sessionId),
      },
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
      results, resultsDirectory, logs, stepTexts, stepDetails, steps,
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

  const incidentFacts = (): SvnConflictFact[] => [
    { ...treeFact('.aidocs/engines', { reason: 'unversioned', action: 'added', localKind: 'dir', incomingKind: 'dir' }),
      content: { binary: false, unreadable: false, equal: null, files: { local: 2, incoming: 3, same: 0, differing: 0 } } },
    textFact('src/catalog.ts'),
    textFact('src/wallets.ts'),
  ]

  /** The incident's update, with no Claude to resolve the text conflicts, so the Finish waits after the rules. */
  async function incidentWait(): Promise<Harness> {
    const it_ = await harness()
    it_.svn.conflictFacts = incidentFacts()
    it_.svn.statusValue = { textConflicts: ['src/catalog.ts', 'src/wallets.ts'], otherConflicts: [], changed: ['src/catalog.ts', 'src/wallets.ts'] }
    it_.resolver.unavailable = 'claude was not found on PATH'
    await it_.press('commit')
    await it_.endRun(0)
    return it_
  }

  it('reads the incident as one set: Jamat settles the folder with keep-both, and the text files wait when no Claude can resolve them', async () => {
    const it_ = await incidentWait()

    expect(it_.log.filter((entry) => entry.startsWith('apply'))).toEqual(['apply .aidocs/engines keep-both'])
    expect(it_.stepTexts).toContain('Fixing .aidocs/engines (keep both), 1 of 1')
    expect(needsOf(it_)).toMatchObject({ kind: 'conflict',
      reason: '3 conflicts: Jamat fixed 1, 2 need you: .aidocs/engines (tree), src/catalog.ts, src/wallets.ts; settle them, then press Check again '
        + '(no merger runs here: claude was not found on PATH)' })
    const action = it_.record()?.svnAction
    expect(action?.stage).toBe('fixing')
    expect(action?.conflictSet).toMatchObject({ readAt: 1_000, baseRevision: 41, revision: 42, more: 0, waited: true })
    expect(action?.conflictSet?.entries.map(({ path, shape, state, by, rule }) => ({ path, shape, state, by, rule }))).toEqual([
      { path: '.aidocs/engines', shape: 'obstructed-dir', state: 'settled', by: 'jamat', rule: 'keep-both' },
      { path: 'src/catalog.ts', shape: 'text-overlap', state: 'person', by: undefined, rule: undefined },
      { path: 'src/wallets.ts', shape: 'text-overlap', state: 'person', by: undefined, rule: undefined },
    ])
    expect(action?.fixed).toEqual([{ path: '.aidocs/engines', option: 'keep-both' }])
    expect(it_.launched).toHaveLength(1)
    expect(it_.resolver.created).toEqual([])

    const info = SvnActionStages.infoOf(action!)
    expect(info.summary).toBe('3 conflicts: Jamat fixed 1, 2 need you')
    expect(info.conflicts?.more).toBe(0)
    expect(info.conflicts?.entries[0]).toMatchObject({
      path: '.aidocs/engines', kind: 'tree', state: 'settled', by: 'jamat',
      description: 'Your session added this folder with 2 files; r42 added it with 3 files.',
    })
    expect(info.conflicts?.entries[0]?.saved).toMatch(/[\\/]id-1[\\/]saved[\\/]\.aidocs[\\/]engines$/)
    const workflow = SvnActionWorkflow.of(it_.record()!, action!, (runId) => it_.store.get(runId))
    expect(workflow.badge).toBe('3 conflicts: Jamat fixed 1, 2 need you')
    expect(workflow.rounds[0].steps.filter((step) => step.title === 'svn update' || step.title === 'Check the conflicts')
      .map(({ title, state, detail, target }) => ({ title, state, detail, target }))).toEqual([
      { title: 'svn update', state: 'done', detail: 'svn update left 3 conflicts', target: { kind: 'run', runId: lastRun(it_)?.sessionId } },
      { title: 'Check the conflicts', state: 'waits', detail: '3 conflicts: Jamat fixed 1, 2 need you', target: { kind: 'conflicts' } },
    ])

    // Check again moves the wait on: the update pass carries the conflicts it read, the check what Jamat fixed.
    expect(workflow.actions[0]).toEqual({ id: 'finish-again', label: 'Check again', primary: true })
    it_.clock.now = 2_000
    it_.svn.conflictFacts = []
    await it_.press('commit')
    expect(it_.record()?.svnAction?.passes?.find((pass) => pass.stage === 'updating')).toMatchObject({ result: 'done', facts: { conflicts: 3 } })
    expect(it_.record()?.svnAction?.passes?.find((pass) => pass.stage === 'fixing'))
      .toMatchObject({ result: 'waited', facts: { conflicts: 3, fixed: 1, left: 2 } })
  })

  it('goes back to the conflicts at Check again, keeping the action, its evidence and its set, and updates again in a new round', async () => {
    const it_ = await harness()
    it_.labels.own = [proof(43)]
    it_.svn.conflictFacts = incidentFacts()
    it_.resolver.unavailable = 'claude was not found on PATH'
    await it_.press('commit')
    await it_.endRun(0)
    const before = it_.record()!.svnAction!
    const update = lastRun(it_)!

    // Jamat fixed the folder; both text files still hold their markers.
    it_.svn.conflictFacts = incidentFacts().slice(1)
    it_.resolver.markers = ['src/catalog.ts', 'src/wallets.ts']
    it_.log.length = 0
    expect(await it_.press('commit')).toEqual({ ok: true, value: { actionId: before.actionId } })
    // The wait hands the person the merger's brief: the other commits' messages are read for it.
    expect(it_.log).toEqual([`conflictSet ${worktreeConst} r41`, `logOf ${worktreeConst} r42:42`])
    expect(it_.record()?.svnAction).toMatchObject({ actionId: 'id-1', stage: 'fixing', evidence: [proof(43)], needs: { kind: 'conflict' },
      mergeBrief: 'L:/logs/s1/id-1-merge.md' })
    expect(it_.resolver.briefs.get('s1/id-1-merge')).toContain('--path src/catalog.ts --option merged')
    expect(SvnActionStages.infoOf(it_.record()!.svnAction!).mergeBrief).toBe('L:/logs/s1/id-1-merge.md')
    expect(it_.record()?.svnAction?.conflictSet?.entries.map(({ path, state, by }) => ({ path, state, by }))).toEqual([
      { path: '.aidocs/engines', state: 'settled', by: 'jamat' },
      { path: 'src/catalog.ts', state: 'person', by: undefined },
      { path: 'src/wallets.ts', state: 'person', by: undefined },
    ])
    expect(needsOf(it_)?.reason).toBe('3 conflicts: Jamat fixed 1, 2 need you: .aidocs/engines (tree), src/catalog.ts, src/wallets.ts; settle them, then press Check again')
    const waiting = SvnActionWorkflow.of(it_.record()!, it_.record()!.svnAction!, (runId) => it_.store.get(runId))
    expect(waiting.rounds[0].steps.at(-1)).toMatchObject({ title: 'Check the conflicts', state: 'waits', target: { kind: 'conflicts' } })

    // The markers are gone: both files settle through merged, and the update runs again.
    it_.resolver.markers = []
    await it_.press('commit')
    expect(it_.log.filter((entry) => entry.startsWith('apply'))).toEqual(['apply src/catalog.ts merged', 'apply src/wallets.ts merged'])
    expect(lastRun(it_)).toMatchObject({ scriptOf: { scriptId: 'svn', name: 'update' } })
    expect(lastRun(it_)?.sessionId).not.toBe(update.sessionId)
    expect(it_.record()?.svnAction?.conflictSet?.entries.map((entry) => `${entry.state} ${entry.by}`)).toEqual(['settled jamat', 'settled person', 'settled person'])
    const workflow = SvnActionWorkflow.of(it_.record()!, it_.record()!.svnAction!, (runId) => it_.store.get(runId))
    expect(workflow.rounds.map((round) => round.title)).toEqual(['Finish', 'Update 2'])
    expect(workflow.rounds[0].steps.map(({ title, state }) => `${title}: ${state}`)).toEqual([
      'Read what the worktree committed: done', 'svn update: done', 'Check the conflicts: waits', 'Check the conflicts: waits', 'Check the conflicts: done',
    ])
    expect(workflow.rounds[1].steps[0]).toMatchObject({ title: 'svn update', state: 'running' })

    it_.svn.conflictFacts = []
    await it_.endRun(0)
    expect(lastRun(it_)?.scriptOf?.scriptId).toBe('review')
    expect(it_.record()?.svnAction?.conflictSet).toBeUndefined()
  })

  it('settles one path of a waiting Finish on the record, which keeps waiting until Check again', async () => {
    const it_ = await harness()
    expect(await it_.flow.resolveConflict('s1', { path: 'a', option: 'merged', confirm: false, requestedBy: 'cli', by: 'person' }))
      .toMatchObject({ ok: false, code: 'not-found' })
    it_.svn.conflictFacts = incidentFacts()
    it_.resolver.unavailable = 'claude was not found on PATH'
    await it_.press('commit')
    await it_.endRun(0)
    it_.log.length = 0

    expect(await it_.flow.resolveConflict('s1', { path: '.aidocs/engines', option: 'keep-both', confirm: false, requestedBy: 'cli', by: 'person' }))
      .toMatchObject({ ok: false, code: 'invalid-spec', detail: '.aidocs/engines is settled already' })
    expect(await it_.flow.resolveConflict('s1', { path: 'src/catalog.ts', option: 'merged', confirm: false, requestedBy: 'cli', by: 'person' }))
      .toEqual({ ok: true, value: { sessionId: 's1', path: 'src/catalog.ts', state: 'settled', left: 1 } })
    expect(it_.log.filter((entry) => entry.startsWith('apply'))).toEqual(['apply src/catalog.ts merged'])
    const action = it_.record()?.svnAction
    expect(action).toMatchObject({ stage: 'fixing', needs: { kind: 'conflict' } })
    expect(action?.conflictSet?.entries[1]).toMatchObject({ state: 'settled', by: 'person', settledWith: 'merged', journal: { option: 'merged', done: 1 } })
    expect(SvnActionStages.infoOf(action!).summary).toBe('3 conflicts: Jamat fixed 1, you fixed 1, 1 needs you')
    expect(it_.launched).toHaveLength(1)
    expect(await it_.flow.resolveConflict('s1', { path: 'src/wallets.ts', option: 'keep-mine', confirm: false, requestedBy: 'cli', by: 'person' }))
      .toMatchObject({ ok: false, code: 'person-only' })
  })

  it('stops a live session at a conflict wait first, then checks the conflicts; any other wait starts at the evidence and drops the set', async () => {
    const it_ = await harness()
    it_.svn.conflictFacts = incidentFacts()
    it_.resolver.unavailable = 'claude was not found on PATH'
    await it_.press('commit')
    await it_.endRun(0)
    await it_.store.put({ ...it_.record()!, life: 'live', binding: { hostInstanceId: 'h', generation: 1 } })
    it_.activity.set('s1', 'waiting')

    await it_.press('commit')
    expect(it_.stops).toEqual(['s1'])
    expect(stageOf(it_)).toBe('stopping')
    expect(it_.record()?.svnAction?.conflictSet?.entries).toHaveLength(3)
    await it_.store.put({ ...it_.record()!, life: 'ended', binding: null })
    it_.svn.conflictFacts = []
    await it_.flow.drive('s1')
    expect(it_.record()?.svnAction?.passes?.slice(-2).map((pass) => pass.stage)).toEqual(['stopping', 'fixing'])
    expect(lastRun(it_)?.scriptOf).toMatchObject({ scriptId: 'svn', name: 'update' })

    const other = await harness()
    other.checks.steps = [declared('tests', 'pnpm test')]
    await other.press('commit')
    await other.endRun(1)
    await other.store.put({ ...other.record()!, svnAction: { ...other.record()!.svnAction!,
      conflictSet: { readAt: 1, baseRevision: 41, revision: 42, entries: [], more: 3 } } })
    await other.press('commit')
    expect(other.record()?.svnAction?.conflictSet).toBeUndefined()
    expect(lastRun(other)?.scriptOf).toMatchObject({ scriptId: 'checks', name: 'tests' })
  })

  it('reads the conflicts a failed update left and waits on them; a failed update without conflicts needs svn-failed', async () => {
    const it_ = await harness()
    it_.svn.conflictFacts = incidentFacts()
    it_.resolver.unavailable = 'claude was not found on PATH'
    await it_.press('commit')
    await it_.endRun(1)
    expect(needsOf(it_)).toMatchObject({ kind: 'conflict' })
    expect(it_.record()?.svnAction?.conflictSet?.entries).toHaveLength(3)

    const unread = await harness()
    unread.svn.conflictSetFailure = 'E155007: not a working copy'
    await unread.press('commit')
    await unread.endRun(0)
    expect(needsOf(unread)).toMatchObject({ kind: 'svn-failed', reason: `svn cannot report the conflicts of ${worktreeConst}: E155007: not a working copy` })
  })

  it('keeps 200 conflicts on the record and 50 on the wire, and counts the rest', async () => {
    const it_ = await harness()
    it_.svn.conflictFacts = Array.from({ length: 250 }, (_, index) => treeFact(`src/f${index}.ts`))
    await it_.press('commit')
    await it_.endRun(0)
    const action = it_.record()!.svnAction!
    expect(action.conflictSet?.entries).toHaveLength(200)
    expect(action.conflictSet?.more).toBe(50)
    const info = SvnActionStages.infoOf(action)
    expect(info.conflicts?.entries).toHaveLength(50)
    expect(info.conflicts?.more).toBe(200)
    expect(info.summary).toBe('250 conflicts need you')
    expect(needsOf(it_)?.reason).toMatch(/^250 conflicts need you: src\/f0.ts \(tree\), .* and 230 more; settle them/)
  })

  const conflicted: SvnWorktreeStatus = { textConflicts: ['a.txt'], otherConflicts: [], changed: ['a.txt', 'notes.md'] }

  /** A press whose update conflicts, so the merger is started on the set; answers the harness. */
  async function merging(overrides: Partial<SessionRecord> = {}): Promise<Harness> {
    const it_ = await harness(overrides)
    it_.svn.statusValue = conflicted
    await it_.press('commit')
    await it_.endRun(0)
    return it_
  }

  /** The merger's `resolve-conflict --self` call, which the manager hands the parent's action as `agent`. */
  const mergerSettles = (it_: Harness, path: string, option: 'merged' | 'take-incoming' | 'keep-both' = 'merged') =>
    it_.flow.resolveConflict('s1', { path, option, confirm: false, requestedBy: 'cli', by: 'agent' })

  it('forks the conversation of a Claude worker into an interactive merger with its rights, brief and pointer first', async () => {
    const it_ = await merging({ transcriptCwd: worktreeConst })

    expect(it_.resolver.created).toHaveLength(1)
    const { spec, marks } = it_.resolver.created[0]
    expect(spec).toMatchObject({
      kind: 'agent',
      directory: { mode: 'adHoc', path: worktreeConst },
      agent: { agentId: 'claude', mode: 'fork', forkParentId: 'native-1' },
      title: 'Merge conflicts 014-fix-login',
    })
    expect(spec.agent?.initialPrompt).toContain('L:/logs/s1/id-1-merge.md')
    expect(marks).toEqual({ sessionId: 'id-4', permission: 'merger', scriptOf: { sessionId: 's1', phase: 'after', scriptId: 'svn-merge', name: 'merger' } })
    expect(it_.record()?.svnAction).toMatchObject({
      stage: 'merging', runId: 'id-4', merger: { runId: 'id-4', setAt: 1_000, startedAt: 1_000 }, mergeBrief: 'L:/logs/s1/id-1-merge.md',
    })
    expect(it_.record()?.svnAction?.conflicts).toBeUndefined()
    expect(it_.resolver.briefs.get('s1/id-1-merge')).toContain('--path a.txt --option merged')
    expect(it_.record()?.svnAction?.conflictSet?.entries.map(({ path, state }) => ({ path, state }))).toEqual([{ path: 'a.txt', state: 'agent' }])
    const info = SvnActionStages.infoOf(it_.record()!.svnAction!)
    expect(info).toMatchObject({ stage: 'merging', summary: '1 conflict: merger on 1', mergerRunId: 'id-4' })
    expect(SvnActionStages.agentRunOf(it_.record()!.svnAction!)).toBe('id-4')
    expect(it_.record()?.svnAction?.passes?.slice(-2)).toMatchObject([
      { stage: 'updating', result: 'done', facts: { conflicts: 1 } },
      { stage: 'fixing', result: 'done', facts: { conflicts: 1, fixed: 0, left: 1 } },
    ])
    const workflow = SvnActionWorkflow.of(it_.record()!, it_.record()!.svnAction!, (runId) => it_.store.get(runId))
    expect(workflow.rounds[0].steps.find((step) => step.title === 'Merger')).toMatchObject({ state: 'running', target: { kind: 'agent', runId: 'id-4' } })
    expect(workflow.actions.map((action) => action.id)).toEqual(['finish-again', 'open-merger', 'stop-agent', 'open-in-vscode', 'keep', 'discard'])
  })

  it('starts a fresh Claude merger for a Codex worker', async () => {
    const it_ = await merging({ agent: { agentId: 'codex', launchMode: 'new', nativeSessionId: 'codex-1' } })

    const { spec } = it_.resolver.created[0]
    expect(spec.agent).toMatchObject({ agentId: 'claude', mode: 'new' })
    expect(spec.agent?.forkParentId).toBeUndefined()
    expect(it_.resolver.briefs.get('s1/id-1-merge')).toContain('# Merge the conflicts of 014 - fix login')
  })

  it('gives the agent paths to the person at once when no Claude merger can run here', async () => {
    const it_ = await harness()
    it_.resolver.unavailable = 'claude was not found on PATH'
    it_.svn.statusValue = conflicted
    await it_.press('commit')
    await it_.endRun(0)

    expect(needsOf(it_)).toMatchObject({ kind: 'conflict',
      reason: '1 conflict needs you: a.txt; settle them, then press Check again (no merger runs here: claude was not found on PATH)' })
    expect(it_.record()?.svnAction?.conflictSet?.entries[0]?.state).toBe('person')
    expect(it_.resolver.created).toEqual([])
  })

  it('waits on a conflicted name svn cannot take, with no merger for it and without svn resolve', async () => {
    const it_ = await harness()
    it_.svn.statusValue = { textConflicts: ['ř.txt'], otherConflicts: [], changed: ['ř.txt'] }
    await it_.press('commit')
    await it_.endRun(0)

    expect(needsOf(it_)).toMatchObject({ kind: 'conflict' })
    expect(needsOf(it_)?.reason).toContain('ř.txt')
    expect(it_.resolver.created).toEqual([])
    expect(it_.log.some((entry) => entry.startsWith('resolve'))).toBe(false)
  })

  it('stops the merger after its last settlement, and its verdict updates again in a round after the merger', async () => {
    const it_ = await harness()
    it_.checks.steps = []
    it_.svn.conflictFacts = incidentFacts()
    await it_.press('commit')
    await it_.endRun(0)
    expect(stageOf(it_)).toBe('merging')
    const runId = it_.record()!.svnAction!.runId!
    expect(it_.record()?.svnAction?.conflictSet?.entries.map(({ path, state }) => `${path} ${state}`))
      .toEqual(['.aidocs/engines settled', 'src/catalog.ts agent', 'src/wallets.ts agent'])

    expect(await mergerSettles(it_, 'src/catalog.ts')).toEqual({ ok: true, value: { sessionId: 's1', path: 'src/catalog.ts', state: 'settled', left: 1 } })
    await it_.settled()
    expect(it_.resolver.stopped).toEqual([])
    expect(stageOf(it_)).toBe('merging')
    expect(await mergerSettles(it_, 'src/wallets.ts')).toMatchObject({ ok: true, value: { left: 0 } })
    await it_.settled()
    expect(it_.resolver.stopped).toEqual([runId])
    expect(it_.record()?.svnAction?.conflictSet?.entries.map(({ state, by }) => `${state} ${by}`)).toEqual(['settled jamat', 'settled agent', 'settled agent'])

    // Its run ends, whatever its exit code: the set is read again, nothing is open, the update runs again.
    it_.svn.conflictFacts = []
    await it_.endRun(1)
    expect(lastRun(it_)?.scriptOf).toMatchObject({ scriptId: 'svn', name: 'update' })
    expect(it_.record()?.svnAction?.merger).toMatchObject({ runId, endedAt: 1_000, checkedAt: 1_000 })
    const workflow = SvnActionWorkflow.of(it_.record()!, it_.record()!.svnAction!, (id) => it_.store.get(id))
    expect(workflow.rounds.map((round) => round.title)).toEqual(['Finish', 'Update 2, after the merger'])
    expect(workflow.rounds[0].steps.find((step) => step.title === 'Merger')).toMatchObject({ state: 'done', target: { kind: 'agent', runId } })

    it_.svn.rootsAnswers = [[root(['src/catalog.ts'])], [root([])]]
    it_.labels.afterReviews = [[receipt(51)]]
    await it_.endRun(0)
    expect(lastRun(it_)?.scriptOf?.scriptId).toBe('review')
    await it_.endRun(0)
    expect(it_.record()?.svnAction).toBeUndefined()
    const lines = it_.record()?.worktreeOutcome?.lines ?? []
    expect(lines).toContain('FIXED: .aidocs/engines (keep both)')
  })

  it('waits after the merger for a file changed outside the conflicts while it ran, and Check again goes on to the update', async () => {
    const it_ = await harness()
    it_.svn.statusValue = { textConflicts: ['a.txt'], otherConflicts: [], changed: ['a.txt', 'src/wallets.ts'] }
    it_.svn.changesValue = ['a.txt', 'src/wallets.ts']
    it_.svn.contents = new Map([['src/wallets.ts', 'w1']])
    await it_.press('commit')
    await it_.endRun(0)
    expect(stageOf(it_)).toBe('merging')
    expect(JSON.parse(readFileSync(it_.results.handoverPathOf('id-1'), 'utf8')).hashes).toEqual({ 'a.txt': 'same', 'src/wallets.ts': 'w1' })

    // The person edits src/wallets.ts while the merger works; the merger settles a.txt.
    it_.svn.contents = new Map([['src/wallets.ts', 'w2']])
    await mergerSettles(it_, 'a.txt')
    await it_.settled()
    await it_.endRun(0)
    expect(needsOf(it_)).toMatchObject({ kind: 'conflict',
      reason: 'changed outside the conflicts while the merger ran: src/wallets.ts; 1 conflict: merger fixed 1; press Check again' })
    const waiting = SvnActionWorkflow.of(it_.record()!, it_.record()!.svnAction!, (id) => it_.store.get(id))
    expect(waiting.actions[0]).toEqual({ id: 'finish-again', label: 'Check again', primary: true })

    await it_.press('commit')
    expect(lastRun(it_)?.scriptOf).toMatchObject({ scriptId: 'svn', name: 'update' })
  })

  it('needs the person when the merger ends with paths left, and starts no second merger on the same set', async () => {
    const it_ = await merging()
    it_.resolver.markers = ['a.txt']
    await it_.endRun(0)

    expect(needsOf(it_)).toMatchObject({ kind: 'conflict' })
    expect(needsOf(it_)?.reason).toMatch(/^the merger ended with 1 left; 1 conflict needs you: a.txt; settle them, then press Check again/)
    expect(it_.record()?.svnAction?.conflictSet?.entries[0]?.state).toBe('person')
    expect(it_.resolver.created).toHaveLength(1)

    // Check again re-reads the same set: no merger starts by itself on it again.
    await it_.press('commit')
    expect(needsOf(it_)).toMatchObject({ kind: 'conflict' })
    expect(it_.resolver.created).toHaveLength(1)
  })

  it('settles a text file the merger left without markers as merged by the agent, and one svn no longer marks', async () => {
    const it_ = await merging()
    it_.svn.statusValue = { textConflicts: ['a.txt'], otherConflicts: [], changed: ['a.txt'] }
    await it_.endRun(0)

    expect(it_.log.filter((entry) => entry.startsWith('apply'))).toEqual(['apply a.txt merged'])
    expect(it_.record()?.svnAction?.conflictSet?.entries[0]).toMatchObject({ state: 'settled', by: 'agent', settledWith: 'merged' })
    expect(lastRun(it_)?.scriptOf).toMatchObject({ scriptId: 'svn', name: 'update' })
  })

  it('a new update after the merger brings a new set, which gets its own merger', async () => {
    const it_ = await merging()
    await mergerSettles(it_, 'a.txt')
    await it_.settled()
    it_.clock.now = 2_000
    await it_.endRun(0)
    expect(lastRun(it_)?.scriptOf?.name).toBe('update')
    it_.clock.now = 3_000
    await it_.endRun(0)

    expect(stageOf(it_)).toBe('merging')
    expect(it_.resolver.created).toHaveLength(2)
    expect(it_.record()?.svnAction?.merger).toMatchObject({ setAt: 3_000 })
  })

  it('keeps the worktree during the merger: stops its run once, writes kept, and its late verdict changes nothing', async () => {
    const it_ = await merging()
    const runId = it_.record()?.svnAction?.runId

    expect(await it_.press('keep')).toEqual({ ok: true, value: { actionId: 'id-1' } })
    expect(it_.resolver.stopped).toEqual([runId])
    expect(it_.record()?.svnAction).toBeUndefined()
    expect(it_.record()?.worktreeOutcome).toMatchObject({ result: 'not-committed', worktree: 'kept' })

    const launched = it_.launched.length
    await it_.endRun(0)
    expect(it_.record()?.svnAction).toBeUndefined()
    expect(it_.launched).toHaveLength(launched)
    expect(it_.resolver.stopped).toEqual([runId])
  })

  it('discards during the merger: stops its run and removes the worktree', async () => {
    const it_ = await merging()
    const runId = it_.record()?.svnAction?.runId
    it_.resolver.markers = ['a.txt']

    expect(await it_.press('discard')).toMatchObject({ ok: true, value: { actionId: 'id-5' } })
    expect(it_.resolver.stopped).toEqual([runId])
    expect(it_.log).toContain(`remove ${worktreeConst} []`)
    expect(it_.record()?.svnAction).toBeUndefined()
    expect(it_.ended).toEqual(['s1'])
  })

  it('takes Commit during the merger as Check again: settles what the person fixed, and stops the merger once nothing is left', async () => {
    const it_ = await harness()
    it_.svn.conflictFacts = [textFact('src/catalog.ts'), textFact('src/wallets.ts')]
    it_.resolver.markers = ['src/catalog.ts', 'src/wallets.ts']
    await it_.press('commit')
    await it_.endRun(0)
    const runId = it_.record()!.svnAction!.runId!
    expect(stageOf(it_)).toBe('merging')

    // The person removes the markers of src/catalog.ts by hand and presses Check again.
    it_.resolver.markers = ['src/wallets.ts']
    expect(await it_.press('commit')).toEqual({ ok: true, value: { actionId: 'id-1' } })
    expect(stageOf(it_)).toBe('merging')
    expect(it_.record()?.svnAction?.conflictSet?.entries.map(({ path, state, by }) => `${path} ${state} ${by}`))
      .toEqual(['src/catalog.ts settled person', 'src/wallets.ts agent undefined'])
    expect(it_.resolver.stopped).toEqual([])

    it_.resolver.markers = []
    await it_.press('commit')
    expect(it_.resolver.stopped).toEqual([runId])
    expect(it_.record()?.svnAction?.conflictSet?.entries.every((entry) => entry.state === 'settled')).toBe(true)
  })

  it('starts a merger again on a conflict wait for Resolve with agent, also on the same set and for the person\'s paths', async () => {
    const it_ = await merging()
    it_.resolver.markers = ['a.txt']
    await it_.endRun(0)
    expect(needsOf(it_)?.reason).toMatch(/^the merger ended with 1 left/)
    const waiting = SvnActionWorkflow.of(it_.record()!, it_.record()!.svnAction!, (id) => it_.store.get(id))
    expect(waiting.actions.map((action) => action.id)).toEqual(['finish-again', 'resolve-with-agent', 'open-in-vscode', 'keep', 'discard'])

    expect(await it_.press('commit', { agent: true })).toEqual({ ok: true, value: { actionId: 'id-1' } })
    expect(it_.resolver.created).toHaveLength(2)
    expect(stageOf(it_)).toBe('merging')
    expect(it_.record()?.svnAction?.merger).toMatchObject({ runId: it_.record()?.svnAction?.runId, setAt: 1_000 })
    expect(it_.record()?.svnAction?.conflictSet?.entries[0]?.state).toBe('agent')
  })

  it('refuses Resolve with agent without a conflict wait, without a path for an agent, or without Claude', async () => {
    const it_ = await harness()
    expect(await it_.press('commit', { agent: true })).toMatchObject({ ok: false, code: 'invalid-spec',
      detail: 'Resolve with agent needs a Finish of session s1 that waits on its conflicts' })

    const none = await harness()
    none.resolver.unavailable = 'claude was not found on PATH'
    none.svn.statusValue = conflicted
    await none.press('commit')
    await none.endRun(0)
    expect(await none.press('commit', { agent: true })).toMatchObject({ ok: false, code: 'invalid-spec', detail: 'No merger runs here: claude was not found on PATH' })
    expect(none.resolver.created).toEqual([])

    const unsafe = await harness()
    unsafe.svn.statusValue = { textConflicts: ['ř.txt'], otherConflicts: [], changed: ['ř.txt'] }
    await unsafe.press('commit')
    await unsafe.endRun(0)
    expect(await unsafe.press('commit', { agent: true })).toMatchObject({ ok: false, code: 'invalid-spec' })
  })

  it('runs no time limit on the merger', async () => {
    const it_ = await merging()
    it_.clock.now += 120 * 60_000
    await it_.flow.drive('s1')
    expect(stageOf(it_)).toBe('merging')
    expect(it_.resolver.stopped).toEqual([])
  })

  it('keeps the pointer of a refused create whose record stays pending, and a decided refusal needs the person', async () => {
    const it_ = await harness()
    it_.svn.statusValue = conflicted
    it_.resolver.answer = { ok: false, code: 'host-unreachable', detail: 'the Host did not answer' }
    it_.resolver.leaves = 'pending'
    await it_.press('commit')
    await it_.endRun(0)

    expect(it_.record()?.svnAction).toMatchObject({ stage: 'merging', runId: 'id-4' })
    expect(needsOf(it_)).toBeUndefined()
    expect(it_.reports.join('\n')).toMatch(/merger could not be started yet/)
    await it_.flow.drive('s1')
    expect(it_.resolver.created).toHaveLength(1)

    const decided = await harness()
    decided.svn.statusValue = conflicted
    decided.resolver.answer = { ok: false, code: 'spawn-failed', detail: 'the Host refused' }
    decided.resolver.leaves = 'ended'
    await decided.press('commit')
    await decided.endRun(0)
    expect(needsOf(decided)).toMatchObject({ kind: 'conflict' })
    expect(needsOf(decided)?.reason).toMatch(/^the merger could not start \(the Host refused\); 1 conflict needs you: a.txt/)
    expect(decided.record()?.svnAction?.conflictSet?.entries[0]?.state).toBe('person')
  })

  it('leaves a merger whose record the create has not written yet to the next pass while it drives', async () => {
    const it_ = await harness()
    it_.svn.statusValue = conflicted
    it_.resolver.leaves = 'none'
    const early: boolean[] = []
    it_.resolver.onCreate = async () => { early.push(await it_.flow.noteVerdict('s1', { kind: 'failed', reason: 'its record is gone' })) }
    await it_.press('commit')
    await it_.endRun(0)
    expect(early).toEqual([false])
    expect(stageOf(it_)).toBe('merging')

    it_.resolver.markers = ['a.txt']
    expect(await it_.flow.noteVerdict('s1', { kind: 'failed', reason: 'its record is gone' })).toBe(true)
    await it_.settled()
    expect(needsOf(it_)).toMatchObject({ kind: 'conflict' })
    expect(needsOf(it_)?.reason).toMatch(/^the merger ended with 1 left/)
  })

  it('never creates a resolver for a worktree Finish', async () => {
    const it_ = await merging()
    expect(it_.resolver.created.map(({ marks }) => marks.scriptOf.scriptId)).toEqual(['svn-merge'])
    expect(it_.resolver.briefs.has('s1/id-1')).toBe(false)
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

  it('writes one pass per stage it leaves with the move, and Finish again keeps them with a waited pass', async () => {
    const it_ = await harness()
    it_.checks.steps = [declared('lint', 'pnpm lint')]
    await it_.press('commit')
    const lint = lastRun(it_)!
    expect(it_.record()?.svnAction?.passes).toEqual([{ stage: 'evidence', startedAt: 1_000, endedAt: 1_000, result: 'done' }])
    it_.clock.now = 2_000
    await it_.endRun(0)
    const update = lastRun(it_)!
    expect(it_.record()?.svnAction?.stageAt).toBe(2_000)
    it_.clock.now = 3_000
    it_.svn.rootsAnswers = [[root(['a.txt'])], [root(['a.txt'])]]
    await it_.endRun(0)
    await it_.endRun(ReviewRunExit.cancelledConst)
    expect(needsOf(it_)).toMatchObject({ kind: 'review-cancelled' })
    expect(it_.record()?.svnAction?.passes?.map(({ stage, runId, result }) => ({ stage, runId, result }))).toEqual([
      { stage: 'evidence', runId: undefined, result: 'done' },
      { stage: 'checks', runId: lint.sessionId, result: 'done' },
      { stage: 'updating', runId: update.sessionId, result: 'done' },
    ])

    it_.clock.now = 4_000
    await it_.press('commit')
    const passes = it_.record()?.svnAction?.passes ?? []
    expect(passes.slice(3).map(({ stage, result }) => ({ stage, result }))).toEqual([
      { stage: 'reviewing', result: 'waited' }, { stage: 'evidence', result: 'done' },
    ])
    expect(passes[3]).toMatchObject({ startedAt: 3_000, endedAt: 4_000 })
  })

  it('writes a failed pass for each update a lock stopped and a done one for the cleanup', async () => {
    const it_ = await harness()
    it_.svn.lockedValue = true
    await it_.press('commit')
    for (const delay of [1_000, 2_000, 2_000]) {
      await it_.endRun(1)
      it_.clock.now += delay
      await it_.flow.drive('s1')
    }
    await it_.endRun(1)
    await it_.endRun(0)
    expect(it_.record()?.svnAction?.passes?.map(({ stage, result }) => `${stage} ${result}`)).toEqual([
      'evidence done', 'updating failed', 'updating failed', 'updating failed', 'updating failed', 'cleaning done',
    ])
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

  describe('the caller\'s line on a wait', () => {
    const called = (): Partial<SessionRecord> => ({ worktree: { ...recordOf().worktree!, caller: { notify: { sessionId: 'coordinator', text: 'status t1' } } } })

    it('writes one pending notice with the wait, a new one with the next wait, keeps what the notifier wrote, and Keep takes it', async () => {
      const it_ = await harness(called())
      it_.checks.steps = [declared('tests', 'pnpm test')]
      await it_.press('commit')
      await it_.endRun(1)
      const first = it_.record()?.svnAction?.notice
      expect(first).toEqual({ id: expect.any(String), at: 1_000, attempts: 0, state: 'pending' })
      expect(new SvnWaitNotices(() => it_.store).pending()).toEqual([{ id: first?.id, sessionId: 'coordinator', text: 'status t1', at: 1_000, attempts: 0 }])

      // The notifier delivers it; the flow's next writes keep that.
      await new SvnWaitNotices(() => it_.store).note([first!.id], 'delivered', 1_500)
      it_.clock.now = 2_000
      await it_.press('commit')
      expect(it_.record()?.svnAction?.notice).toMatchObject({ id: first?.id, state: 'delivered' })
      await it_.endRun(1)
      const second = it_.record()?.svnAction?.notice
      expect(second).toMatchObject({ at: 2_000, attempts: 0, state: 'pending' })
      expect(second?.id).not.toBe(first?.id)

      await it_.press('keep')
      expect(it_.record()?.svnAction).toBeUndefined()
      expect(new SvnWaitNotices(() => it_.store).pending()).toEqual([])
    })

    it('writes none for a review the person cancelled, for a worktree without a caller, or for an UPDATE', async () => {
      const it_ = await harness(called())
      await it_.press('commit')
      await it_.endRun(0)
      await it_.endRun(10)
      expect(needsOf(it_)).toMatchObject({ kind: 'review-cancelled' })
      expect(it_.record()?.svnAction?.notice).toBeUndefined()

      const plain = await harness()
      plain.checks.steps = [declared('tests', 'pnpm test')]
      await plain.press('commit')
      await plain.endRun(1)
      expect(needsOf(plain)).toMatchObject({ kind: 'check-failed' })
      expect(plain.record()?.svnAction?.notice).toBeUndefined()

      const update = await harness(called())
      expect(await update.flow.startUpdate('s1', ownerConst, 'cli')).toMatchObject({ ok: true })
      update.svn.lockedValue = true
      for (let round = 0; round < 4; round += 1) {
        await update.endRun(1)
        update.clock.now += 10_000
        await update.flow.drive('s1')
      }
      expect(needsOf(update)).toMatchObject({ kind: 'locked' })
      expect(update.record()?.svnAction?.notice).toBeUndefined()
    })
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
      expect(it_.record()?.svnAction?.conflictSet?.entries).toMatchObject([{ path: 'src/a.ts', state: 'agent' }])

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
      tree.svn.statusValue = { textConflicts: ['a.txt'], otherConflicts: ['gone'], changed: [] }
      await update(tree)
      await tree.endRun(0)
      expect(needsOf(tree)).toMatchObject({ kind: 'conflict', reason: '2 conflicts need you: a.txt, gone (tree); settle them, then press UPDATE again' })
      // The same read-only list, and no write beside the resolver's: no resolve, no resolver.
      expect(tree.record()?.svnAction?.conflictSet?.entries.map((entry) => entry.path)).toEqual(['a.txt', 'gone'])
      expect(tree.log.some((entry) => entry.startsWith('resolve'))).toBe(false)
      expect(tree.resolver.created).toEqual([])

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

  describe('client steps', () => {
    it('says which of how many revisions the evidence reads, and gives the receipts their own step', async () => {
      const it_ = await harness()
      it_.svn.rootsAnswers = [[root(['a.txt'])], [root([])]]
      const svnRoot = { path: worktreeConst, own: '', changed: [] }
      it_.labels.reads = [{ kind: 'status', root: svnRoot },
        { kind: 'own-commit', root: svnRoot, revision: 4_512, index: 1, count: 2 },
        { kind: 'own-commit', root: svnRoot, revision: 4_513, index: 2, count: 2 },
        { kind: 'receipt', root: { ...svnRoot, path: `${worktreeConst}/shared/clients`, own: 'shared/clients' }, revision: 4_514 }]

      await it_.press('commit')
      expect(it_.stepDetails.slice(1, 6)).toEqual([
        'Reading what the worktree committed | svn status -v --xml',
        'Reading what the worktree committed | svn status -v --xml',
        'Reading what the worktree committed | svn log -v -r4512 (1 of 2 revisions)',
        'Reading what the worktree committed | svn log -v -r4513 (2 of 2 revisions)',
        'Confirming the commits from the session\'s split | svn log -v -r4514 in shared/clients',
      ])
    })

    it('names each client read of a Finish in order, and leaves no step once the drive ends or a run launched', async () => {
      const it_ = await harness()
      it_.svn.rootsAnswers = [[root(['a.txt'])], [root([])]]

      await it_.press('commit')
      expect(it_.stepTexts).toEqual([
        'Checking the worktree\'s owner',
        'Reading what the worktree committed',
        'Scheduling the files deleted from disk',
        'Reading the revision the update starts from',
      ])
      // The update run row speaks now, in the same snapshot that ends the step.
      expect(it_.record()?.svnAction?.runId).toBe(lastRun(it_)?.sessionId)
      expect(it_.steps.size).toBe(0)

      await it_.endRun(0)
      expect(it_.stepTexts.slice(4)).toEqual([
        'Reading conflicts after the update',
        'Reading what the update brought in',
        'Finding what is left to review',
        'Checking whether the passed checks still hold',
        'Reading the bounds of the review',
      ])
      expect(it_.steps.size).toBe(0)

      await it_.endRun(0)
      expect(it_.stepTexts.slice(9)).toEqual([
        'Finding what is left to review',
        'Confirming the commits from the session\'s split',
        'Reading what the review committed',
        // The removal names its own phases (svnWorktreeRemoval.test.ts); this fake removal names none.
        'Recording the result',
      ])
      expect(it_.record()?.svnAction).toBeUndefined()
      expect(it_.steps.size).toBe(0)
    })

    it('leaves no step when the action waits for the person or stops on an unexpected throw', async () => {
      const refused = await harness()
      refused.svn.ownerRefusal = 'The owner is gone'
      await refused.press('commit')
      expect(needsOf(refused)).toMatchObject({ kind: 'svn-failed' })
      expect(refused.stepTexts).toEqual(['Checking the worktree\'s owner'])
      expect(refused.steps.size).toBe(0)

      const thrown = await harness()
      thrown.labels.ownCommits = () => Promise.reject(new Error('the disk went away'))
      await thrown.press('commit')
      expect(thrown.record()?.worktreeOutcome).toMatchObject({ result: 'failed' })
      expect(thrown.stepTexts.at(-1)).toBe('Reading what the worktree committed')
      expect(thrown.steps.size).toBe(0)
    })

    it('leaves no step after an UPDATE whose BASE read fails or throws, though its launch runs outside a drive', async () => {
      const landed: Partial<SessionRecord> = {
        worktree: undefined,
        retiredWorktree: { worktreePath: worktreeConst, kind: 'svn', revisions: [], removedAt: 1, ownerDir: ownerConst, landed: [receipt(51)] },
      }
      const failing = await harness(landed)
      failing.svn.revisionRead = 'fails'
      expect(await failing.flow.startUpdate('s1', ownerConst, 'window')).toMatchObject({ ok: true })
      expect(needsOf(failing)).toMatchObject({ kind: 'svn-failed' })
      expect(failing.stepTexts).toEqual(['Reading the revision the update starts from'])
      expect(failing.steps.size).toBe(0)

      const throwing = await harness(landed)
      throwing.svn.revisionRead = 'throws'
      await expect(throwing.flow.startUpdate('s1', ownerConst, 'window')).rejects.toThrow('the disk went away')
      expect(throwing.stepTexts).toEqual(['Reading the revision the update starts from'])
      expect(throwing.steps.size).toBe(0)
    })
  })
})
