import { existsSync,mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename,join } from 'node:path'
import type { SvnCommitHistory } from '../../svn/svn.types'
import { SvnFailures } from '../../svn/svnFailures'
import { SessionScriptsManager } from '../../sessionManager/worktreeSessionScripts'
import type { SvnStepResult } from '../svnStepRunner'
import { SvnStepRunner } from '../svnStepRunner'

import { afterEach,describe,expect,it } from 'vitest'

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
import { SessionStepWords } from '../../sessionManager/worktreeSessionRuntime'
import type { SessionRecord,SessionRecordScriptStep } from '../../sessionManager/worktreeSessionRecords'
import { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import { ScriptLogStore } from '../../sessionManager/worktreeSessionScripts'
import type {
SessionActivity,
SessionCreateSpec,
SessionsOpResult,
SvnFinishWorktreeResult,
SvnLabelledRevision
} from '../../sessionManager/sessionManagerApi.types'
import { MainCopyUpdate as SvnActionFlow } from '../landing/mainCopyUpdate'
import type { SvnWorktreeRemoved } from '../removal/svnWorktreeRemoval'
import { WorktreeResultsStore } from '../results/worktreeResultsStore'
import type { SessionInternalMarks } from '../worktreeLifecycle.types'
import type { SvnActionPort } from './svnActionFlow'
import type { SvnLabelsRead } from './svnRevisionLabels'
import { emptyUpdateTargets, testAssembly } from './finishTestRecords'

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
    recoveryHistory: SvnCommitHistory[] = []
    localFailure: string | null = null
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
    /** Until every drive the flow detached has ended. */
    settled: () => Promise<void>
    /** The last launched run ends with this exit code, the reconcile pass judges it, and the next client step runs. */
    endRun: (exitCode: number | undefined, life?: 'ended' | 'lost', output?: string) => Promise<void>
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

  async function harness(overrides: Partial<SessionRecord> = {}, recoverOutOfDate = true, direct = false): Promise<Harness> {
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
    const local = new Map<string, (result: SvnStepResult) => void>()
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
        updateTargets: emptyUpdateTargets,
        assembly: async () => ok(testAssembly()),
        present: async () => true,
        publicationRows: async () => ok({ changed: [], items: [] }),
        advancePublished: async () => ok(undefined),
        revertSetup: async (root, paths, baseline, saved) => {
          log.push(`revertSetup ${root} [${paths.join(',')}] ${saved}`)
          svn.changesValue = svn.changesValue.filter((path) => !paths.includes(path) || (svn.contents.get(path) ?? 'same') !== baseline[path])
          return ok(undefined)
        },
        commitHashes: (root, paths) => svn.hashes(root, paths),
        publicationHashes: (root, paths) => svn.hashes(root, paths),
        logSince: async () => ok(svn.recoveryHistory),
        prepareCommit: async (_root, paths) => ok({ targets: [...paths], added: [] }),
        unprepareCommit: async () => ok(undefined),
        landingPaths: async () => ({ ok: true, value: [] }),
        landingProof: async () => ({ ok: true, value: { holds: true } }),
        saveLocalPaths: async () => ({ ok: true, value: 'saved' }),
        ownerCheck: (location) => svn.ownerCheck(location),
        scheduleMissing: (path, victims) => svn.scheduleMissing(path, victims),
        headRevisionOf: async () => ok(42),
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
    const unreachable = async (): Promise<never> => { throw new Error('The Host is stopped') }
    const directRunner = new SvnStepRunner({ records: store,
      scripts: new SessionScriptsManager({ records: store, logs, now: () => clock.now, onCollapsed: () => {}, report: () => {},
        host: { runtimeInspect: unreachable, runtimeStop: unreachable, runtimeRemove: unreachable } }),
      svn: { run: async (_cwd, args, options) => {
        log.push(`local svn ${args.join(' ')}`)
        options?.onStdout?.(svn.localFailure ?? 'Updated to revision 42.')
        return { code: svn.localFailure === null ? 0 : 1, stdout: svn.localFailure ?? 'Updated to revision 42.', stderr: '', failure: null }
      } }, now: () => clock.now, newId: () => `local-${++minted}`, changed: () => {} })
    const build = (): SvnActionFlow => new SvnActionFlow({
      commands: { accept: async () => {} },
      lease: { within: async (_root, _purpose, work) => work(), checkAndRelease: async () => {} },
      records: store,
      runner: direct ? directRunner : { run: async (sessionId, kind, cwd, args) => {
        const runId = `id-${++minted}`
        minted += 1
        const run: SessionRecord = { sessionId: runId, kind: 'shell', title: `svn ${kind} ${basename(cwd)}`, directory: { mode: 'adHoc', path: cwd },
          binding: null, life: 'starting', createdAt: clock.now, process: { tool: 'svn', args },
          scriptOf: { sessionId, phase: 'after', scriptId: 'svn', name: kind } }
        await store.put(run)
        await store.update(sessionId, (record) => ({ ...record, svnAction: { ...record.svnAction!, runId } }))
        launched.push(run)
        return new Promise<SvnStepResult>((resolve) => { local.set(runId, resolve) })
      } },
      logs,
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
        cli: () => ({ ok: true as const, command: 'node "C:/Jamat/skills/claude/appjamat-v3/scripts/jamat-v3.mjs"' }), instance: { configIdentity: 'cfg-test', channel: 'development' as const },
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
          helpBriefPathOf: (parentId, actionId) => `L:/logs/${parentId}/${actionId}-help.md`,
          writeHelpBrief: async (parentId, actionId, text) => {
            resolver.briefs.set(`${parentId}/${actionId}-help`, text)
            return { ok: true, bytes: text.length }
          },
          pathOf: (parentId, runId) => `L:/logs/${parentId}/${runId}.log`,
        },
        withMarkers: async (_root, paths) => paths.filter((path) => resolver.markers.includes(path)),
      },
      resolutions: {
        recoverLocked: async () => ({ ok: true, value: undefined }),
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
    let failedFirstCommit = false
    const saveCommit = async (run: SessionRecord, exitCode: number | undefined, text: string): Promise<void> => {
      const saved = await logs.write('s1', run.sessionId, text)
      if (!saved.ok) throw new Error(saved.detail)
      await store.update('s1', (parent) => ({ ...parent, scriptRuns: [...parent.scriptRuns ?? [], {
        runId: run.sessionId, phase: run.scriptOf?.phase ?? 'after', scriptId: run.scriptOf?.scriptId ?? 'svn', name: run.scriptOf?.name ?? 'commit', title: run.title, commands: [],
        startedAt: run.createdAt, endedAt: clock.now, outcome: exitCode === 0 ? 'succeeded' : 'failed',
        log: { state: 'saved', bytes: saved.bytes, truncated: false }, ...exitCode === undefined ? {} : { exitCode },
      }] }))
    }
    const settled = async (): Promise<void> => {
      for (let round = 0; round < 50; round += 1) {
        if (local.size === 0) {
          const batch = detached.slice()
          const pending = Promise.all(batch).then(() => { for (const work of batch) { const index = detached.indexOf(work); if (index >= 0) detached.splice(index, 1) } })
          await Promise.race([pending, new Promise<void>((resolve) => {
            let ended = false
            const poll = (): void => { if (ended || local.size > 0) resolve(); else setTimeout(poll, 1) }
            void pending.finally(() => { ended = true; resolve() })
            poll()
          })])
        }
        const action = store.get('s1')?.svnAction
        // Recovery scenarios start with one real commit verdict reporting out of date.
        if (recoverOutOfDate && !failedFirstCommit && action?.stage === 'committing' && action.runId !== undefined && action.needs === undefined) {
          failedFirstCommit = true
          const run = store.get(action.runId)!
          await saveCommit(run, 1, 'svn: E155011: File is out of date')
          await store.put({ ...run, life: 'ended', exitCode: 1, binding: null, pendingOperationId: undefined, pendingOperationKind: undefined })
          const finish = local.get(run.sessionId)
          if (finish) {
            local.delete(run.sessionId)
            finish({ ok: false, failure: 'out-of-date', runId: run.sessionId, exitCode: 1, output: 'svn: E155011: File is out of date' })
            } else await it_.flow.noteVerdict('s1', { kind: 'failed', reason: 'out of date' })
        }
        else if (local.size > 0 || detached.length === 0) return
      }
      throw new Error('The fixture did not settle')
    }
    const it_: Harness = {
      flow, store, svn, labels, log, launched, stops, ended, landedDue, spent, reports, clock, removal, checks, activity, refusal, resolver,
      results, resultsDirectory, logs, stepTexts, stepDetails, steps,
      record: () => store.get('s1'),
      settled,
      endRun: async (exitCode, life = 'ended', output) => {
        await settled()
        const run = launched.at(-1)
        if (run === undefined) throw new Error('no run was launched')
        await saveCommit(run, exitCode, output ?? (exitCode === 0 ? 'Committed revision 51.' : exitCode === 12 ? 'svn: E160028: out of date' : 'svn commit failed'))
        await store.put({ ...store.get(run.sessionId) ?? run, life, binding: null, pendingOperationId: undefined,
          pendingOperationKind: undefined, ...exitCode === undefined ? {} : { exitCode }, endedAt: clock.now })
        const finish = local.get(run.sessionId)
        if (finish !== undefined) {
          local.delete(run.sessionId)
          const text = output ?? (exitCode === 0 ? 'Committed revision 51.' : exitCode === 12 ? 'svn: E160028: out of date' : 'svn commit failed')
          finish(exitCode === 0 ? { ok: true, runId: run.sessionId, exitCode, output: text }
            : { ok: false, runId: run.sessionId, exitCode: exitCode ?? -1, output: text, failure: SvnFailures.classify(text, exitCode ?? null) })
        } else await it_.flow.noteVerdict('s1', exitCode === 0 ? { kind: 'succeeded' } : { kind: 'failed', reason: `the run ended with ${exitCode ?? 'no exit code'}` })
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
        agentStartedAt: 1,
      },
      ...overrides,
    }
  }

  const stageOf = (it_: Harness) => it_.record()?.svnAction?.stage
  const needsOf = (it_: Harness) => it_.record()?.svnAction?.needs
  const lastRun = (it_: Harness) => it_.launched.at(-1)

  it('updates a coordinator main copy even when the session never owned a worktree', async () => {
    const h = await harness({ worktree: undefined }, false, true)
    expect(await h.flow.startUpdate('s1', ownerConst, 'window')).toMatchObject({ ok: true })
    await h.settled()
    expect(h.record()?.scriptRuns?.at(-1)?.outcome).toBe('succeeded')
  })

  it('updates a landed main copy with the Host stopped and saves a journaled log', async () => {
    const h = await harness({ worktree: undefined, retiredWorktree: { kind: 'svn', worktreePath: worktreeConst, ownerDir: ownerConst, revisions: ['r51'], removedAt: 1, landed: [{ repository: repositoryConst, revision: 51, label: 'receipt' }] } }, false, true)
    await h.flow.startUpdate('s1', ownerConst, 'window')
    await h.settled()
    expect(h.launched).toEqual([])
    expect(h.record()?.scriptRuns?.at(-1)).toMatchObject({ scriptId: 'svn', outcome: 'succeeded', log: { state: 'saved' } })
    expect(h.record()?.worktreeLifecycle?.journal.at(-1)).toMatchObject({ kind: 'update', targetRevision: 42, outcome: 'ok' })
    expect(h.log).toContain('local svn update -r 42 --ignore-externals --accept postpone -- .')
  })





  describe('UPDATE of a main copy', () => {
    it('continues a migrated clean landed row through UPDATE before ending it', async () => {
      const h = await harness({ worktree: undefined, retiredWorktree: { kind: 'svn', worktreePath: worktreeConst, ownerDir: ownerConst, removedAt: 1, revisions: [], landed: [] },
        svnAction: { kind: 'finish', actionId: 'old', stage: 'main-update', root: worktreeConst, checks: [], checkCursor: 0, rootCursor: 0,
          rounds: { incoming: 0, lock: 0, outOfDate: 0 }, evidence: [], requestedBy: 'window', startedAt: 1 } })
      expect(await h.flow.startUpdate('s1', ownerConst, 'window')).toMatchObject({ ok: true })
      await h.endRun(0)
      expect(h.record()?.svnAction).toBeUndefined()
      expect(h.record()?.completed).toBe(true)
      expect(h.ended).toEqual(['s1'])
    })

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
        process: { tool: 'svn', args: ['update', '-r', '42', '--ignore-externals', '--accept', 'postpone', '--', '.'] },
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

    it('records in each result the revision of the repository it published to, not only of the main copy root (UA1-J13-7)', async () => {
      const it_ = await harness(landedRow())
      await it_.results.put(WorktreeResultsStore.recordOf({ actionId: 'ea-only', action: 'finish', result: 'committed', sessionId: 's1', title: 'EA',
        worktreePath: worktreeConst, mainCopy: ownerConst, directoryId: null, removal: 'removed',
        revisions: [{ repository: 'https://svn.test', revision: 40, label: 'receipt' }], lines: [], logs: [], at: 1, caller: undefined }))
      await update(it_)
      await it_.endRun(0)
      expect(it_.results.list({ sessionId: 's1' })[0].main?.repositories).toEqual([{ repository: 'https://svn.test', revision: 42 }])
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
        it_.flow.due('s1')
        await it_.settled()
        expect(it_.launched).toHaveLength(runs + 1)
        expect(lastRun(it_)?.scriptOf?.name).toBe('update')
      }
      await it_.endRun(1)
      expect(needsOf(it_)).toMatchObject({ kind: 'locked' })
      expect(needsOf(it_)?.reason).toContain('press UPDATE again')
      expect(it_.launched.every((run) => run.process?.args.includes('cleanup') !== true)).toBe(true)
      expect(it_.launched).toHaveLength(4)

      // UPDATE again keeps the history and resets the retry pace.
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
      await finishing.store.update('s1', record => ({ ...record, svnAction: { kind: 'finish', actionId: 'active-finish', stage: 'checks', root: worktreeConst, checks: [], checkCursor: 0, rootCursor: 0, rounds: { incoming: 0, lock: 0, outOfDate: 0 }, evidence: [], requestedBy: 'window', startedAt: 1 } }))
      expect(await finishing.flow.startUpdate('s1', ownerConst, 'cli')).toMatchObject({ ok: false, code: 'merge-pending' })
    })

    it('resolves a text conflict in the main copy with a fresh resolver, checks only the markers, and shows the merge as a diff run', async () => {
      const it_ = await harness(landedRow())
      it_.svn.statusAfterResolve = [{ textConflicts: [], otherConflicts: [], changed: ['src/a.ts'] }]
      // Another session changed a file meanwhile: in a main copy that proves nothing about the resolver.
      it_.svn.changesValue = ['src/a.ts', 'other.txt']
      await update(it_)
      it_.svn.statusValue = { textConflicts: ['src/a.ts'], otherConflicts: [], changed: ['src/a.ts'] }
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
        process: { tool: 'svn', args: ['diff', '--old', '.@BASE', '--new', '.', '--', 'src/a.ts'] },
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
      await update(tree)
      tree.svn.statusValue = { textConflicts: ['a.txt'], otherConflicts: ['gone'], changed: [] }
      await tree.endRun(0)
      expect(needsOf(tree)).toMatchObject({ kind: 'conflict', reason: '2 conflicts need you: a.txt, gone (tree); settle them, then press UPDATE again' })
      // The same read-only list, and no write beside the resolver's: no resolve, no resolver.
      expect(tree.record()?.svnAction?.conflictSet?.entries.map((entry) => entry.path)).toEqual(['a.txt', 'gone'])
      expect(tree.log.some((entry) => entry.startsWith('resolve'))).toBe(false)
      expect(tree.resolver.created).toEqual([])

      const marked = await harness(landedRow())
      marked.resolver.markers = ['a.txt']
      await update(marked)
      marked.svn.statusValue = { textConflicts: ['a.txt'], otherConflicts: [], changed: ['a.txt'] }
      await marked.endRun(0)
      await marked.endRun(0)
      expect(needsOf(marked)).toMatchObject({ kind: 'resolver-failed' })
      // A hand edit alone leaves svn marking the file: the wait names the list whose options settle it (UA1-J13-4).
      expect(needsOf(marked)?.reason).toBe('the resolver left conflicts in: a.txt; settle each one in the conflict list below '
        + '(edit the file and press Merge, or take one side), then press UPDATE again')
      expect(marked.record()?.svnAction?.conflictSet?.entries.map((entry) => `${entry.path} ${entry.state}`)).toEqual(['a.txt person'])
    })
  })
})
