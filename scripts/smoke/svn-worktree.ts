import { SvnAuditScenarios } from './svnAuditScenarios.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { WorktreeRecovery } from '../../lib-orchestrator/worktrees/worktreeRecovery.js'
import { WorktreeTransitions } from '../../lib-orchestrator/worktrees/worktreeTransitions.js'
import { SvnScriptedWorker } from './svnScriptedWorker.js'
import { WorkerHandoffs } from '../../lib-orchestrator/sessionManager/notifies/workerHandoffs.js'
import { WorkerReady } from '../../lib-orchestrator/worktrees/worktreeFinish.js'
import { SvnWriterCrash } from './svnWriterCrash.js'
import { SvnUpdateScenarios } from './svnUpdateScenarios.js'
import { SvnPreparationScenarios } from './svnPreparationScenarios.js'
import { SetupInputs } from '../../lib-orchestrator/projectSetup/setupInputs.js'
import { SvnBranchConflicts } from './svnBranchConflicts.js'
import { SvnFinishContractCases } from './svnFinishContractCases.js'
import { SvnStepRunner } from '../../lib-orchestrator/worktrees/svnStepRunner.js'
import { SessionScriptsManager } from '../../lib-orchestrator/sessionManager/scripts/sessionScriptsManager.js'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { hostname, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { FileDiffComputer } from '../../lib-orchestrator/fileChangesManager/diff/fileDiffComputer.js'
import { FileChangesManager } from '../../lib-orchestrator/fileChangesManager/fileChangesManager.js'
import type { FileChangeEntry } from '../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types.js'
import { LandedRows } from '../../lib-orchestrator/worktrees/worktreeLanding.js'
import { Reconciler } from '../../lib-orchestrator/sessionManager/lifecycle/reconciler.js'
import type { SessionInternalMarks, WorktreePlaceRequest } from '../../lib-orchestrator/worktrees/worktreeLifecycle.types.js'
import { SessionSteps } from '../../lib-orchestrator/sessionManager/lifecycle/sessionSteps.js'
import { SessionWorkflows } from '../../lib-orchestrator/sessionManager/lifecycle/sessionWorkflows.js'
import type { SvnActionFlowDeps } from '../../lib-orchestrator/worktrees/worktreeFinish.js'
import { FinishDriver } from '../../lib-orchestrator/worktrees/worktreeFinish.js'
import { FinishProjection } from '../../lib-orchestrator/worktrees/worktreeFinish.js'
import { MainCopyUpdate } from '../../lib-orchestrator/worktrees/worktreeLanding.js'
import { SyncStep } from '../../lib-orchestrator/worktrees/worktreeFinish.js'
import { SvnConflictFlow } from '../../lib-orchestrator/worktrees/worktreeConflicts.js'
import { WorktreeLease } from '../../lib-orchestrator/worktrees/worktreeLease.js'
import { WorktreeSvnCommands } from '../../lib-orchestrator/worktrees/worktreeSvnCommands.js'
import { SvnActionStages } from '../../lib-orchestrator/worktrees/worktreeFinish.js'
import { SvnResolverLauncher } from '../../lib-orchestrator/worktrees/worktreeConflicts.js'
import { SvnRevisionLabels } from '../../lib-orchestrator/worktrees/worktreeFinish.js'
import { SvnWorktreeFinishFlow } from '../../lib-orchestrator/worktrees/worktreeFinish.js'
import { SvnWorktreeRemoval } from '../../lib-orchestrator/worktrees/worktreeRemoval.js'
import { WorktreeCleanupPacing } from '../../lib-orchestrator/worktrees/worktreeRemoval.js'
import { SvnWorktreeProvisioner } from '../../lib-orchestrator/worktrees/worktreeProvision.js'
import type { WorktreeOwnerDeps } from '../../lib-orchestrator/worktrees/worktreeProvision.js'
import type { SessionRecord, SessionRecordProcess, SessionRecordScriptStep, SessionRecordWorktree } from '../../lib-orchestrator/sessionManager/records/sessionRecord.types.js'
import { SessionRecordsStore } from '../../lib-orchestrator/sessionManager/records/sessionRecordsStore.js'
import { WorktreeResultsStore } from '../../lib-orchestrator/worktrees/worktreeResults.js'
import { ScriptChain } from '../../lib-orchestrator/sessionManager/scripts/scriptChain.js'
import { ScriptLogStore } from '../../lib-orchestrator/sessionManager/scripts/scriptLogStore.js'
import type { SessionCreateSpec, SessionFinishPress, SessionsOpResult, SvnLabelledRevision } from '../../lib-orchestrator/sessionManager/sessionManagerApi.types.js'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { ErrorText } from '../../lib-orchestrator/shared/errorText.js'
import { PathCompare } from '../../lib-orchestrator/shared/pathCompare.js'
import { ProductGroup } from '../../lib-orchestrator/shared/productGroup.js'
import { SvnConflictFacts } from '../../lib-orchestrator/svn/svnConflictFacts.js'
import { SvnConflictResolutions } from '../../lib-orchestrator/svn/svnConflictResolutions.js'
import { SvnCommitGate } from '../../lib-orchestrator/svn/svnCommitGate.js'
import { SvnCommitMessageCheck } from '../../lib-orchestrator/svn/svnCommitMessageCheck.js'
import { SvnInvoker } from '../../lib-orchestrator/svn/svnInvoker.js'
import { SvnWorktreeEvidence } from '../../lib-orchestrator/svn/svnWorktreeEvidence.js'
import { SvnWorktreeManager } from '../../lib-orchestrator/svn/svnWorktreeManager.js'
import { ConflictTestbed } from '../dev/make-conflict-testbed.js'
import { SmokeHarness, SmokeRun } from './smokeHarness.js'
import { SvnSmokeIsolation } from './svnSmokeIsolation.js'
import { type ConflictSpikeCapture, ConflictShapesSpike } from './svnConflictShapes.js'

const fixtureDirectory = join(import.meta.dirname, '..', '..', 'lib-orchestrator', 'svn', 'fixtures', 'worktree')
const conflictFixtureDirectory = join(fixtureDirectory, 'conflicts')

/**
 * A disposable svnadmin repository below one temporary directory, and the working copies a case
 * checks out of it. Nothing here reaches a working copy outside that directory, and the root sets
 * `svn:global-ignores` itself, so no case depends on the SVN config of the PC.
 */
class SvnFixtureRepository {
  readonly directory: string
  readonly url: string
  private readonly svn: SvnInvoker

  private constructor(directory: string, svn: SvnInvoker) {
    this.directory = directory
    this.url = pathToFileURL(directory).href
    this.svn = svn
  }

  /** A repository something else made, such as the conflict testbed's. */
  static at(directory: string, svn: SvnInvoker): SvnFixtureRepository {
    return new SvnFixtureRepository(directory, svn)
  }

  static async create(directory: string, svn: SvnInvoker): Promise<SvnFixtureRepository> {
    const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', directory], cwd: join(directory, '..'), env: process.env })
    if (created.failure !== null || created.code !== 0) throw new Error(created.stderr || JSON.stringify(created))
    return new SvnFixtureRepository(directory, svn)
  }

  /** stdout of a command that must succeed. Commits carry a fixed author, so no fixture names the PC's user. */
  async run(cwd: string, args: string[]): Promise<string> {
    const author = args[0] === 'commit' || args[0] === 'mkdir' ? ['--username', 'fixture'] : []
    const result = await this.svn.run(cwd, [args[0], '--non-interactive', ...author, ...args.slice(1)])
    if (result.failure !== null || result.code !== 0)
      throw new Error(`svn ${args.join(' ')}: ${result.stderr || result.failure || result.code}`)
    return result.stdout
  }
}

interface Capture {
  name: string
  text: string
}

/** Real SVN writes use the same leased lifecycle as production; only checks and agent delivery are scripted. */
class SmokeSvnActions {
  /** Every harness of this process, so the test root outlives the detached work that writes into it. */
  private static readonly instances = new Set<SmokeSvnActions>()
  readonly flow: FinishDriver
  readonly commands: WorktreeSvnCommands
  readonly finisher: SvnWorktreeFinishFlow
  /** Where every ending of this harness writes its durable result. */
  readonly results: WorktreeResultsStore
  /** The roots actually published, in order. */
  readonly opened: string[] = []
  /** The workflow of the parent as each run starts: its badge, then each step as `title: state`. */
  readonly workflows: string[][] = []
  readonly ended = new Set<string>()
  /** The main copies a committed ending or an UPDATE asked the manager to read again. */
  readonly landedDue: string[] = []
  decision: { of: (scopeRoot: string) => 'commit' | 'cancel' } = { of: () => 'commit' }
  /** What the resolver does in the directory it runs in; null: no Claude can run here. */
  resolve: ((cwd: string) => Promise<void>) | null = null
  /** The prompt of every resolver started, in order. */
  readonly prompts: string[] = []
  /** The agreed install a Finish runs by itself when dependency inputs changed (`after/setup`); null: none. */
  install: SessionRecordScriptStep | null = null
  /** The `scripts.after` checks a press freezes, as name and one shell command in the worktree. */
  checksOf: () => { name: string; command: string }[] = () => []
  /** Runs inside each check before its command, with the count of checks run so far. */
  onCheck: ((count: number) => Promise<void>) | null = null
  onCheckEnded: ((parentId: string) => Promise<void>) | null = null
  /** How many check runs ended. */
  checkRuns = 0
  idleFallback = false
  private clockOffset = 0
  private readonly pendingMergers: (() => Promise<void>)[] = []
  beforePublication: ((cwd: string) => Promise<void>) | null = null
  lostPublicationResponse = false
  afterPublication: ((cwd: string) => Promise<void>) | null = null
  private readonly records: SessionRecordsStore
  private readonly manager: SvnWorktreeManager
  private readonly logs: ScriptLogStore
  private readonly svn: SvnInvoker
  /** Each detached continuation, handled when it is detached: a failure lands in `failures`, never unhandled. */
  private readonly detached: Promise<void>[] = []
  private readonly failures: string[] = []
  private readonly pendingRuns: SessionRecord[] = []
  private minted = 0
  private readonly runPrefix = randomUUID()

  constructor(records: SessionRecordsStore, manager: SvnWorktreeManager, svn: SvnInvoker, logs: string) {
    this.records = records
    this.manager = manager
    this.logs = new ScriptLogStore(logs)
    this.svn = svn
    SmokeSvnActions.instances.add(this)
    this.results = new WorktreeResultsStore(`${logs}-results`, { now: () => Date.now(), logs: new ScriptLogStore(logs), report: () => undefined })
    const steps = new SessionSteps({ changed: () => undefined, now: () => Date.now() })
    const removal = new SvnWorktreeRemoval({ records, skillRoots: [], svn: manager, onQueue: (work) => work(), changed: () => undefined, steps })
    const ended = (sessionId: string): void => { this.ended.add(sessionId) }
    const unavailable = async (): Promise<never> => { throw new Error('SVN smoke does not use the Host') }
    const scripts = new SessionScriptsManager({ records, logs: this.logs,
      host: { runtimeInspect: unavailable, runtimeRemove: unavailable, runtimeStop: unavailable },
      onCollapsed: () => {}, report: () => {}, now: () => Date.now() })
    const lease = new WorktreeLease('svn-smoke', () => [])
    const commands = new WorktreeSvnCommands(svn, lease, async (root, reason) => {
      for (const record of records.list())
        if (record.worktreeLifecycle !== undefined && record.worktree?.worktreePath === root)
          await records.update(record.sessionId, (latest) => ({ ...latest, worktreeLifecycle: { ...latest.worktreeLifecycle!, phase: 'waiting',
            version: latest.worktreeLifecycle!.version + 1, wait: { kind: 'changed-outside', reason, at: Date.now() } } }))
      return 'stop'
    })
    this.commands = commands
    manager = new SvnWorktreeManager(commands)
    const deps: SvnActionFlowDeps = {
      runner: new SvnStepRunner({ records, scripts, lease, svn: { run: async (cwd, args, options) => { if (args[0] === 'commit') await this.beforePublication?.(cwd); const result = await commands.run(cwd, args, options); if (args[0] === 'commit' && result.code === 0) { this.opened.push(cwd); await this.afterPublication?.(cwd); if (this.lostPublicationResponse) { this.lostPublicationResponse = false; return { ...result, code: 1, stdout: '', stderr: 'SVN E170013: fixture lost response after server publication' } } } return result } }, now: () => Date.now(), newId: () => `smoke-${this.runPrefix}-${++this.minted}`, changed: () => {} }),
      logs: new ScriptLogStore(logs),
      records,
      svn: manager,
      labels: new SvnRevisionLabels(manager),
      removal,
      resolver: {
        unavailable: () => this.resolve === null ? 'no Claude runs in this smoke' : null,
        briefs: new ScriptLogStore(logs),
        withMarkers: (root, paths) => SvnResolverLauncher.markersIn(root, paths),
        cli: () => ({ ok: true as const, command: 'jamat-v3' }),
        instance: { configIdentity: 'smoke', channel: 'development' },
      },
      resolutions: new SvnConflictResolutions({ svn: commands, afterFilesChanged: (root) => commands.accept(root), markersIn: (root, paths) => SvnResolverLauncher.markersIn(root, paths), now: () => Date.now() }),
      results: this.results,
      createResolver: (spec, marks) => this.resolver(spec, marks),
      stopRun: (id) => scripts.confirmStopped(id),

      ended,
      landedDue: (mainCopy) => { this.landedDue.push(mainCopy) },
      proposalsSpent: () => undefined,
      detach: (work, what) => { this.detached.push(work.then(() => undefined, (error: unknown) => { this.failures.push(`${what}: ${ErrorText.of(error)}`) })) },
      changed: () => undefined,
      steps,
      runs: { launch: async (run) => { this.pendingRuns.push(run); return { ok: true, value: undefined } } },
      checks: { declaredAfter: async (record) => ({ ok: true, steps: this.checkStepsOf(record), ...this.install === null ? {} : { install: this.install } }) },
      stop: async (id) => { await records.update(id, (record) => ({ ...record, life: 'ended', exitReason: 'stopped', endedAt: Date.now() })); return { ok: true, value: undefined } },
      report: () => undefined,
      newId: () => `smoke-${this.runPrefix}-${++this.minted}`,
      now: () => Date.now() + this.clockOffset,
    }
    const conflicts = new SvnConflictFlow({ svn: manager, briefs: this.logs, handover: this.results, resolutions: deps.resolutions,
      savedDirectoryOf: (id) => this.results.savedDirectoryOf(id), withMarkers: deps.resolver.withMarkers, unavailable: deps.resolver.unavailable, cli: deps.resolver.cli, now: deps.now })
    const handoffs = new WorkerHandoffs(() => records, (_record, args) => WorkerHandoffs.lineOf('jamat-v3', [], args, 'posix'))
    const sync = new SyncStep({ records, svn: manager, runner: deps.runner, commands, conflicts, handoffs, ready: { current: async () => true },
      busyReason: () => null, holdInput: () => () => {}, changed: () => {} })
    this.flow = new FinishDriver({ ...deps, commands, sync, update: new MainCopyUpdate({ ...deps, lease, commands }),
      handoffs,
      idle: () => true, busyReason: () => null, holdInput: () => () => {}, awaitExit: async () => true, liveness: async () => {} })
    // A press answers before its steps run (2026-10-30); the scenarios judge what the steps left behind.
    const press = this.flow.start.bind(this.flow)
    this.flow.start = async (sessionId, finishPress) => {
      const answer = await press(sessionId, finishPress)
      await this.flow.settled(sessionId)
      return answer
    }
    this.finisher = new SvnWorktreeFinishFlow({
      records,
      svn: manager,
      removal,
      actions: { start: (sessionId, press) => this.flow.start(sessionId, press), settled: (sessionId) => this.flow.settled(sessionId) },
      labels: new SvnRevisionLabels(manager),
      results: this.results,
      changed: () => undefined,
      steps,
      ended,
      landedDue: (mainCopy) => { this.landedDue.push(mainCopy) },
      report: () => undefined,
    })
  }

  /** A landed row: the worktree went after a commit, the session stays, not completed, and nothing removed it. */
  landed(sessionId: string, mainCopy: string): boolean {
    const record = this.records.get(sessionId)
    const landing = record === null ? null : LandedRows.landingOf(record)
    return record !== null && record.worktree === undefined && record.completed === undefined && landing !== null
      && landing.mainCopy === mainCopy && !this.ended.has(sessionId) && this.landedDue.includes(mainCopy)
  }

  /** A press of Commit, answered once the action is written, then every stage until it waits or ended. */
  async finish(sessionId: string, options: { select?: (rows: FileChangeEntry[]) => readonly FileChangeEntry[]; message?: string;
    messageSource?: SessionFinishPress['messageSource']; acknowledgedFindings?: SessionFinishPress['acknowledgedFindings'] } = {}): Promise<{ answer: SessionsOpResult<{ actionId: string | null }>; outcome: SessionRecord['worktreeOutcome']; action: SessionRecord['svnAction'] }> {
    const resolving = this.records.get(sessionId)?.worktreeLifecycle?.step === 'worker-resolving'
    const started = await this.flow.start(sessionId, { choice: 'commit', requestedBy: 'window' })
    await this.settled()
    if (this.idleFallback && (await this.fallback(sessionId) || resolving && this.records.get(sessionId)?.worktreeLifecycle?.step === 'reviewing')) {
      const record = this.records.get(sessionId)
      return { answer: started, outcome: record?.worktreeOutcome, action: record === null ? undefined : FinishProjection.action(record) }
    }
    const before = this.records.get(sessionId)
    const root = before?.worktree?.worktreePath
    if (!started.ok || root === undefined)
      return { answer: started, outcome: before?.worktreeOutcome, action: before === null ? undefined : FinishProjection.action(before) }
    const changes = root === undefined ? null : await this.manager.reviewRoots(root)
    if (changes !== null && !changes.ok) throw new Error(changes.detail)
    const selection: string[] = []
    const baseline = before?.worktree?.setupBaseline
    const hashes = root !== undefined && baseline !== undefined ? await this.manager.commitHashes(root, Object.keys(baseline.hashes)) : null
    const setup = new Set(hashes?.ok && baseline !== undefined ? Object.keys(baseline.hashes)
      .filter((path) => hashes.value[path] === baseline.hashes[path]).map((path) => join(root!, path)) : [])
    for (const scope of changes?.value ?? []) {
      if (this.decision.of(scope.path) === 'cancel') continue
      const view = await new FileChangesManager({ diffExecutor: new FileDiffComputer() }).workingTree({ sessionId, cwd: scope.path, agent: null, worktree: null }, 'svn', true)
      if (!view.ok) throw new Error(view.detail)
      const rows = view.value.entries.filter((entry) => entry.status !== 'conflicted' && entry.status !== 'obstructed'
        && !(changes?.value ?? []).some((other) => other.path.startsWith(scope.path + sep)
          && (entry.path === other.path || entry.path.startsWith(other.path + sep))))
        .map((entry) => setup.has(entry.path) ? { ...entry, origin: 'setup' as const } : entry)
      selection.push(...(options.select?.(rows) ?? rows.filter((row) => !SvnCommitGate.sidecarPattern.test(row.displayPath)))
        .map((entry) => entry.path))
    }
    const state = this.records.get(sessionId)?.worktreeLifecycle
    const approve = state?.step === 'reviewing'
    const answer = await this.finisher.finish(sessionId, { choice: 'commit', requestedBy: 'window', reviewVersion: state?.version,
      ...approve && selection.length > 0 ? { selection, message: options.message ?? '[Smoke] Apply selected changes',
        messageSource: options.messageSource ?? 'person-local', acknowledgedFindings: options.acknowledgedFindings,
        ...state?.review?.repositories && state.review.repositories.length > 1 ? { repositories: state.review.repositories.map((row) => ({ ...row, message: `${row.expectedPrefix} Apply selected changes`, source: options.messageSource ?? 'person-local', acknowledged: options.acknowledgedFindings ?? [] })) } : {} }
        : approve && (changes?.value.every((scope) => scope.changed.length === 0) ?? false) ? { selection: [], message: '' } : {} })
    await this.settled()
    const record = this.records.get(sessionId)
    return { answer, outcome: record?.worktreeOutcome, action: record === null ? undefined : FinishProjection.action(record) }
  }

  async discard(sessionId: string) {
    const result = await this.flow.start(sessionId, { choice: 'discard', requestedBy: 'window' })
    await this.settled()
    return result
  }

  async settled(): Promise<void> {
    for (let round = 0; round < 100; round += 1) {
      if (this.detached.length === 0 && this.pendingRuns.length === 0 && this.pendingMergers.length === 0) return
      await this.joined()
      for (const run of this.pendingRuns.splice(0)) await this.launch(run)
      for (const merger of this.pendingMergers.splice(0)) await merger()
    }
    throw new Error('The smoke action did not settle within 100 continuations')
  }

  /**
   * Awaits the detached work of every harness, including what a scenario left running when it threw,
   * and names each failure. The runner calls this before it removes the test root.
   */
  static async drained(): Promise<string[]> {
    const failures: string[] = []
    for (const actions of SmokeSvnActions.instances) {
      for (let round = 0; round < 100 && actions.detached.length > 0; round += 1) await Promise.all(actions.detached.splice(0))
      if (actions.detached.length > 0) failures.push('Detached work did not settle within 100 continuations')
      failures.push(...actions.failures.splice(0))
    }
    return failures
  }

  private async joined(): Promise<void> {
    await Promise.all(this.detached.splice(0))
    if (this.failures.length > 0) throw new Error(`FAILED: detached work: ${this.failures.splice(0).join('; ')}`)
  }

  private async fallback(sessionId: string): Promise<boolean> {
    const state = this.records.get(sessionId)?.worktreeLifecycle
    if (state?.step !== 'worker-resolving' || state.wait !== undefined || state.execution?.merger !== undefined) return false
    // Each observation is fresh; a single twenty-minute clock jump is intentionally not idle proof.
    for (let round = 0; round < 140; round += 1) {
      this.clockOffset += 9_000
      await this.flow.drive(sessionId)
      await this.settled()
      const current = this.records.get(sessionId)?.worktreeLifecycle
      if (current?.step !== 'worker-resolving' || current.wait !== undefined || current.execution?.merger !== undefined) return true
    }
    throw new Error('The worker idle fallback did not settle within twenty-one simulated minutes')
  }

  /**
   * What the reconcile pass does for a relaunch on the lock pace: once its wait is over, the action
   * is driven again, until it no longer waits for one.
   */
  async relaunches(sessionId: string): Promise<number> {
    let relaunched = 0
    for (let round = 0; round < 10; round += 1) {
      const retryAt = this.records.get(sessionId)?.svnAction?.retryAt
      if (retryAt === undefined) return relaunched
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, retryAt - Date.now()) + 50))
      await this.flow.drive(sessionId)
      await this.settled()
      relaunched += 1
    }
    throw new Error(`The action of ${sessionId} kept waiting for a relaunch`)
  }

  private checkStepsOf(record: SessionRecord): SessionRecordScriptStep[] {
    const cwd = record.worktree?.worktreePath ?? ''
    return this.checksOf().map(({ name, command }) => {
      const step = { scriptId: 'declared' as const, name, commands: [{ command, cwd }] }
      return { ...step, key: ScriptChain.keyOf(step) }
    })
  }

  private async launch(run: SessionRecord): Promise<SessionsOpResult> {
    const cwd = run.directory.mode === 'adHoc' ? run.directory.path : ''
    const parent = this.records.get(run.scriptOf?.sessionId ?? '')
    const workflow = parent === null ? null : SessionWorkflows.of(parent, (runId) => this.records.get(runId))
    if (workflow !== null)
      this.workflows.push([workflow.badge, ...workflow.rounds.flatMap((round) => round.steps.map((step) => `${step.title}: ${step.state}`))])
    const process = run.process
    let exitCode: number
    if (process === undefined) {
      exitCode = await this.check(run)
      await this.saveRun(run, exitCode, `Declared check exited with ${exitCode}`)
    }
    else if (process.tool === 'svn') {
      const outcome = await this.svn.run(cwd, process.args)
      exitCode = outcome.failure === null ? outcome.code ?? 1 : 1
      await this.saveRun(run, exitCode, outcome.stdout + outcome.stderr)
      if (process.args[0] === 'commit' && exitCode === 0) this.opened.push(cwd)
    }
    else if (process.tool === 'jamat-cli') throw new Error('Retired review runs must not be launched')
    else throw new Error(`Unknown run tool: ${JSON.stringify(process.tool satisfies never)}`)
    const parentId = run.scriptOf?.sessionId ?? ''
    await this.records.put({ ...this.records.get(run.sessionId) ?? run, life: 'ended', binding: null, pendingOperationId: undefined,
      pendingOperationKind: undefined, exitCode, exitReason: 'process-exit', endedAt: Date.now() })
    if (process === undefined) await this.onCheckEnded?.(parentId)
    await this.flow.noteVerdict(parentId, exitCode === 0 ? { kind: 'succeeded' } : { kind: 'failed', reason: `the run exited with ${exitCode}` })
    return { ok: true, value: undefined }
  }

  /** A declared check: each command in a shell in its own directory, as the Host runs it through cmd.exe. */
  private async check(run: SessionRecord): Promise<number> {
    const commands = run.commands ?? []
    if (commands.length === 0) throw new Error(`The smoke runs no run without a command: ${run.title}`)
    this.checkRuns += 1
    await this.onCheck?.(this.checkRuns)
    for (const { command, cwd } of commands) {
      const outcome = spawnSync(command, { cwd, shell: true, stdio: 'ignore' })
      if (outcome.status !== 0) return outcome.status ?? 1
    }
    return 0
  }

  private async saveRun(run: SessionRecord, exitCode: number, text: string): Promise<void> {
    const saved = await this.logs.write(run.scriptOf!.sessionId, run.sessionId, text)
    if (!saved.ok) throw new Error(saved.detail)
    await this.records.update(run.scriptOf!.sessionId, (parent) => ({ ...parent, scriptRuns: [...parent.scriptRuns ?? [], {
      runId: run.sessionId, phase: run.scriptOf!.phase, scriptId: run.scriptOf!.scriptId, name: run.scriptOf!.name,
      title: run.title, commands: [], startedAt: run.createdAt, endedAt: Date.now(),
      outcome: exitCode === 0 ? 'succeeded' : 'failed', exitCode, log: { state: 'saved', bytes: saved.bytes, truncated: false },
    }] }))
  }

  /**
   * The create of the resolver (an UPDATE) or the merger (a worktree Finish): its record, the scripted
   * edit in its directory, then its end with exit 0. The merger here ends without a call, so the
   * check after it settles what it merged.
   */
  private async resolver(spec: SessionCreateSpec, marks: SessionInternalMarks): Promise<SessionsOpResult<{ sessionId: string }>> {
    const resolve = this.resolve
    if (resolve === null) throw new Error('A resolver was started with no Claude')
    const cwd = spec.directory.mode === 'adHoc' ? spec.directory.path : ''
    this.prompts.push(spec.agent?.initialPrompt ?? '')
    const run: SessionRecord = {
      sessionId: marks.sessionId, kind: 'agent', title: spec.title ?? 'resolver', directory: spec.directory, createdAt: Date.now(),
      agent: { agentId: 'claude', launchMode: spec.agent?.mode ?? 'new', ...marks.oneShot ? { oneShot: true as const } : {}, permission: marks.permission },
      scriptOf: marks.scriptOf, binding: null, life: 'live',
    }
    await this.records.put(run)
    if (marks.scriptOf.scriptId === 'svn-merge') {
      this.pendingMergers.push(async () => {
        await resolve(cwd)
        const set = this.records.get(marks.scriptOf.sessionId)?.worktreeLifecycle?.syncConflictSet
        for (const entry of set?.entries ?? []) {
          if (entry.state === 'settled' || entry.kind !== 'text' || (await SvnResolverLauncher.markersIn(cwd, [entry.path])).length > 0) continue
          const settled = await this.flow.resolveConflict(marks.scriptOf.sessionId, { path: entry.path, option: 'merged', confirm: false, requestedBy: 'cli', by: 'agent' })
          if (!settled.ok) throw new Error(`The scripted merger could not settle ${entry.path}: ${settled.detail}`)
        }
        await this.saveRun(run, 0, 'Scripted merger completed')
        await this.records.put({ ...run, life: 'ended', exitCode: 0, exitReason: 'process-exit', endedAt: Date.now() })
        await this.flow.noteVerdict(marks.scriptOf.sessionId, { kind: 'succeeded' })
        await this.flow.drive(marks.scriptOf.sessionId)
      })
      return { ok: true, value: { sessionId: marks.sessionId } }
    }
    await resolve(cwd)
    await this.saveRun(run, 0, 'Scripted resolver completed')
    await this.records.put({ ...run, life: 'ended', exitCode: 0, exitReason: 'process-exit', endedAt: Date.now() })
    await this.flow.noteVerdict(marks.scriptOf.sessionId, { kind: 'succeeded' })
    return { ok: true, value: { sessionId: marks.sessionId } }
  }

}

class SmokeSvnWorktree extends SmokeHarness {
  private readonly svn = new SvnInvoker()
  private readonly root: string
  private readonly capture: boolean
  private readonly counts: Map<string, number>

  private constructor(root: string, capture: boolean) {
    super()
    this.root = root
    this.capture = capture
    this.counts = new Map()
    const run = this.svn.run.bind(this.svn)
    this.svn.run = (cwd, args, options) => {
      this.counts.set(args[0], (this.counts.get(args[0]) ?? 0) + 1)
      return run(cwd, args, options)
    }
  }

  static async run(): Promise<void> {
    const rootOption = process.argv.indexOf('--test-root')
    const requested = rootOption === -1 ? tmpdir() : process.argv[rootOption + 1]
    if (requested === undefined || requested.startsWith('--')) throw new Error('--test-root needs a directory')
    const parent = await SvnSmokeIsolation.parent(requested)
    const root = await realpath(await mkdtemp(join(parent, 'jamat-v3-svn-worktree-smoke-')))
    if (dirname(root) !== parent) throw new Error('The smoke directory escaped its test root')
    console.log(`Test directory: ${root}`)
    const failure = await new SmokeSvnWorktree(root, process.argv.includes('--capture')).execute().then(() => null, (error: unknown) => ({ error }))
    // A scenario that threw may leave a Finish drive running; removing the root under it fails that drive.
    const late = await SmokeSvnActions.drained()
    if (process.argv.includes('--keep')) console.log(`Retained test directory: ${root}`)
    else {
      if (await realpath(root) !== root || dirname(root) !== parent) throw new Error('The smoke directory changed before cleanup')
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
    if (failure !== null) {
      if (late.length > 0) console.error(`Detached work also failed: ${late.join('; ')}`)
      throw failure.error
    }
    if (late.length > 0) throw new Error(`FAILED: detached work ended after its scenario: ${late.join('; ')}`)
  }

  private async checkExternalCarrier(): Promise<void> {
    const id = 'external-carrier', owner = join(this.root, id)
    const repository = await SvnFixtureRepository.create(join(this.root, `${id}-repository`), this.svn)
    const library = await SvnFixtureRepository.create(join(this.root, `${id}-library`), this.svn)
    const seed = join(this.root, `${id}-seed`)
    await repository.run(this.root, ['checkout', repository.url, owner])
    await library.run(this.root, ['checkout', library.url, seed])
    await writeFile(join(seed, 'file.txt'), 'library before\n')
    await writeFile(join(seed, 'unselected.txt'), 'unselected before\n')
    await library.run(seed, ['add', 'file.txt', 'unselected.txt'])
    await library.run(seed, ['commit', '-m', 'Seed external'])
    await mkdir(join(owner, 'modules'))
    await writeFile(join(owner, 'app.txt'), 'app before\n')
    await repository.run(owner, ['add', 'modules', 'app.txt'])
    await repository.run(owner, ['commit', '-m', 'Seed application'])
    const manager = new SvnWorktreeManager(this.svn)
    const made = await manager.create({ ownerDir: owner, folder: id })
    if (!made.ok) throw new Error(made.detail)
    const tree = made.value.worktreePath, carrier = join(tree, 'modules'), mount = join(carrier, 'Library')
    await repository.run(carrier, ['propset', 'svn:externals', `${library.url} Library`, '.'])
    await repository.run(carrier, ['update'])
    await writeFile(join(tree, 'app.txt'), 'app after\n')
    await writeFile(join(mount, 'file.txt'), 'library after\n')
    await writeFile(join(mount, 'unselected.txt'), 'unselected worker\n')
    await library.run(mount, ['propset', 'jamat:test', 'reviewed', 'file.txt'])
    await library.run(mount, ['propset', 'jamat:module', 'reviewed root', '.'])
    const rooted = await manager.commitHashes(tree, ['modules/Library', 'modules/Library/file.txt'])
    const local = await manager.commitHashes(mount, ['.', 'file.txt'])
    if (!rooted.ok || !local.ok) throw new Error('External hash proof failed')
    this.check('external root and file properties have the same proof from app and mount scope',
      rooted.value['modules/Library'] === local.value['.'] && rooted.value['modules/Library/file.txt'] === local.value['file.txt'])
    const records = await SessionRecordsStore.load(join(this.root, `${id}-records.json`), { snapshotsDirectory: join(this.root, `${id}-snapshots`) })
    await records.put({ sessionId: id, kind: 'agent', title: id, createdAt: Date.now(), life: 'ended', binding: null,
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: id }, directory: { mode: 'adHoc', path: owner },
      worktree: { kind: 'svn', worktreePath: tree, repositoryRoot: owner, branch: made.value.url, baseCommit: `r${made.value.baseRevision}`,
        agentStartedAt: Date.now(), ...(made.value.directoryId === null ? {} : { directoryId: made.value.directoryId }) },
      worktreeLifecycle: { version: 0, actionId: null, phase: 'active', outOfDate: 0, journal: [], facts: { worker: { liveness: 'stopped', resumeFailures: 0 } } } })
    const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, `${id}-logs`))
    const ready = new WorkerReady(records, manager, actions.commands)
    await ready.propose(id)
    this.check('carrier proposal retains a complete ready proof across application and external scopes', await ready.current(id))
    actions.checksOf = () => [{ name: 'external bytes', command: 'node -e "require(\'node:assert/strict\').equal(require(\'node:fs\').readFileSync(\'modules/Library/file.txt\',\'utf8\'),\'library after\\n\')"' }]
    const selected = [join(tree, 'app.txt'), carrier, mount, join(mount, 'file.txt')]
    for (const change of ['carrier', 'external'] as const) {
      await actions.flow.start(id, { choice: 'commit', requestedBy: 'window' }); await actions.settled()
      const state = records.get(id)!.worktreeLifecycle!
      this.check(`${change} mutation starts from a completed check and human review`, state.step === 'reviewing')
      if (change === 'carrier') await repository.run(carrier, ['propset', 'svn:externals', `# changed after review\n${library.url} Library`, '.'])
      else if (change === 'external') await writeFile(join(mount, 'file.txt'), 'changed after review\n')
      else throw new Error(`Unknown change: ${change}`)
      const refused = await actions.flow.start(id, { choice: 'commit', requestedBy: 'window', reviewVersion: state.version,
        selection: selected, message: '[Smoke] Publish reviewed carrier', messageSource: 'person-local',
        repositories: state.review!.repositories!.map((row) => ({ ...row, message: `${row.expectedPrefix} Publish reviewed carrier`, source: 'person-local', acknowledged: [] })) })
      this.check(`${change} mutation invalidates approval without publication`, !refused.ok && actions.opened.length === 0)
      assert.equal((await actions.flow.backToWork(id, 'person')).ok, true)
      await repository.run(carrier, ['propset', 'svn:externals', `${library.url} Library`, '.'])
      await writeFile(join(mount, 'file.txt'), 'library after\n')
      await ready.propose(id)
    }
    const partial = await actions.finish(id, { select: (rows) => rows.filter((row) => selected.includes(row.path)) })
    this.check('carrier subset approval refuses publication and keeps the excluded source', !partial.answer.ok && actions.opened.length === 0
      && await readFile(join(mount, 'unselected.txt'), 'utf8') === 'unselected worker\n')
    const result = await actions.finish(id)
    if (actions.opened.length !== 2)
      console.log(`  carrier publication: ${JSON.stringify({ opened: actions.opened, result, state: records.get(id)?.worktreeLifecycle })}`)
    this.check('carrier Finish publishes the external before the application', actions.opened.length === 2
      && actions.opened[0] === mount && actions.opened[1] === tree)
    this.check('carrier publication verifies both repositories before removal', records.get(id)?.worktreeLifecycle?.verified?.length === 2 && !existsSync(tree))
    this.check('carrier property and selected external content are published at the intended URLs',
      (await repository.run(owner, ['propget', 'svn:externals', `${repository.url}/modules@HEAD`])).trim() === `${library.url} Library`
      && await library.run(seed, ['cat', `${library.url}/file.txt@HEAD`]) === 'library after\n'
      && await library.run(seed, ['cat', `${library.url}/unselected.txt@HEAD`]) === 'unselected worker\n')
    console.log(`  carrier outcome: ${JSON.stringify(result.outcome)}`)
  }

  private async checkPreparationFlow(): Promise<void> {
    const repository = await SvnFixtureRepository.create(join(this.root, 'two-phase-repo'), this.svn)
    const library = await SvnFixtureRepository.create(join(this.root, 'two-phase-lib'), this.svn)
    const owner = join(this.root, 'two-phase-owner'), seed = join(this.root, 'two-phase-lib-seed')
    const message = join(this.root, 'two-phase-message.txt')
    const commit = async (cwd: string, text: string) => {
      await writeFile(message, `[Fixture] ${text}`)
      await repository.run(cwd, ['commit', '-F', message])
      await repository.run(cwd, ['update'])
    }
    await repository.run(this.root, ['checkout', repository.url, owner])
    await library.run(this.root, ['checkout', library.url, seed])
    await writeFile(join(seed, 'library.txt'), 'original library\n')
    await library.run(seed, ['add', 'library.txt'])
    await commit(seed, 'Seed library')
    await writeFile(join(owner, 'app.txt'), 'original app\n')
    await writeFile(join(owner, 'clean.txt'), 'original clean\n')
    await repository.run(owner, ['add', 'app.txt', 'clean.txt'])
    await repository.run(owner, ['propset', 'svn:global-ignores', '.worktrees', '.'])
    await repository.run(owner, ['propset', 'svn:auto-props', '*.ts = svn:eol-style=native', '.'])
    await repository.run(owner, ['propset', 'svn:externals', `${library.url} shared`, '.'])
    await commit(owner, 'Seed application')
    const manager = new SvnWorktreeManager(this.svn)
    const records = await SessionRecordsStore.load(join(this.root, 'two-phase-records.json'), { snapshotsDirectory: join(this.root, 'two-phase-snapshots') })
    const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, 'two-phase-logs'))
    const made = await manager.create({ ownerDir: owner, folder: '001-two-phase' })
    assert(made.ok, JSON.stringify(made))
    const tree = made.value.worktreePath, id = 'two-phase'
    await records.put({ sessionId: id, kind: 'agent', title: id, createdAt: Date.now(), life: 'ended', binding: null,
      agent: { agentId: 'claude', launchMode: 'new' }, directory: { mode: 'adHoc', path: owner },
      worktree: { kind: 'svn', worktreePath: tree, repositoryRoot: owner, branch: made.value.url, baseCommit: `r${made.value.baseRevision}`,
        agentStartedAt: Date.now(), ...(made.value.directoryId === null ? {} : { directoryId: made.value.directoryId }) } })
    actions.checksOf = () => [{ name: 'Read actual assembly', command: 'node -e "require(\'fs\').readFileSync(\'clean.txt\'); require(\'fs\').readFileSync(\'shared/library.txt\'); console.log(\'checked\')"' }]
    await writeFile(join(tree, 'app.txt'), 'worktree app\n')
    await mkdir(join(tree, 'new', 'nested'), { recursive: true })
    await mkdir(join(tree, 'empty'))
    await writeFile(join(tree, 'new', 'nested', 'added.ts'), 'export const answer = 42;\n')
    const prepare = async (local = false) => {
      const answer = await actions.flow.start(id, { choice: 'commit', requestedBy: 'window', ...(local ? { refreshPreparation: true } : {}) })
      assert(answer.ok, JSON.stringify(answer))
      await actions.settled()
      assert.equal(records.get(id)?.worktreeLifecycle?.step, 'reviewing', JSON.stringify(records.get(id)?.worktreeLifecycle?.wait))
    }
    const approve = async () => {
      const state = records.get(id)!.worktreeLifecycle!
      const answer = await actions.flow.start(id, { choice: 'commit', requestedBy: 'window', reviewVersion: state.version,
        selection: state.review!.selection.map((path) => resolve(tree, path)), message: '[two-phase-repo] Publish verified changes', messageSource: 'person-local' })
      await actions.settled()
      return answer
    }
    await prepare()
    this.check('T01/T04 preparation stages nested additions, empty directories and autoprops before checks and publishes nothing',
      actions.opened.length === 0 && actions.checkRuns === 1 && existsSync(tree)
      && (await repository.run(tree, ['propget', 'svn:eol-style', 'new/nested/added.ts'])).trim() === 'native')
    await writeFile(join(tree, 'clean.txt'), 'manual validation edit\n')
    this.check('T06 an originally clean source invalidates approval of the prepared assembly', !(await approve()).ok && actions.opened.length === 0)
    const beforeLocal = this.counts.get('update') ?? 0
    await prepare(true)
    this.check('T07 local revalidation reruns checks without updating SVN', actions.checkRuns === 2 && this.counts.get('update') === beforeLocal)
    await writeFile(join(seed, 'library.txt'), 'incoming external only\n')
    await commit(seed, 'Advance library after validation')
    this.check('T02 external-only incoming revisions block approval without silently updating the mount', !(await approve()).ok
      && (await readFile(join(tree, 'shared/library.txt'), 'utf8')).replace(/\r\n/g, '\n') === 'original library\n' && actions.opened.length === 0)
    await prepare()
    this.check('T08 a fresh preparation includes incoming externals and reruns all checks', actions.checkRuns === 3
      && (await readFile(join(tree, 'shared/library.txt'), 'utf8')).replace(/\r\n/g, '\n') === 'incoming external only\n')
    const state = records.get(id)!.worktreeLifecycle!
    const subset = state.review!.selection.filter((path) => path !== 'clean.txt').map((path) => resolve(tree, path))
    const refused = await actions.flow.start(id, { choice: 'commit', requestedBy: 'window', selection: subset, reviewVersion: state.version,
      message: '[two-phase-repo] Subset', messageSource: 'person-local' })
    this.check('T09 an excluded source blocks publication of the otherwise tested selection', !refused.ok && actions.opened.length === 0)
    if (process.platform === 'win32') {
      const file = join(tree, 'clean.txt').replaceAll("'", "''")
      const script = `$held = [IO.File]::Open('${file}', [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); [Console]::WriteLine('ready'); try { [Threading.Thread]::Sleep(60000) } finally { $held.Dispose() }`
      const holder = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { cwd: this.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      try {
        await new Promise<void>((resolve, reject) => {
          holder.once('error', reject)
          holder.once('exit', (code) => reject(new Error(`File-lock helper exited before readiness: ${code}`)))
          holder.stdout!.once('data', () => resolve())
        })
        assert((await approve()).ok)
        const blocked = records.get(id)!.worktreeLifecycle!
        this.check('T24 Windows file without delete sharing retains the verified receipt and reports the exact OS lock',
          actions.opened.length === 1 && blocked.wait?.kind === 'removal-blocked'
          && /EPERM|EBUSY|EACCES/.test(blocked.wait.reason) && (blocked.verified?.length ?? 0) === 1 && existsSync(tree))
      } finally { await SmokeSvnWorktree.release(holder) }
      assert((await actions.flow.start(id, { choice: 'commit', requestedBy: 'window' })).ok)
      await actions.settled()
    } else assert((await approve()).ok)
    this.check('T10 native publication preserves prepared bytes/properties and removes only after verification',
      actions.opened.length === 1 && records.get(id)?.worktreeLifecycle?.phase === 'landed' && !existsSync(tree))
    this.check('T10 repository contains the manually validated clean-file edit and native autoprops',
      (await repository.run(owner, ['cat', `${repository.url}/clean.txt@HEAD`])).trim() === 'manual validation edit'
      && (await repository.run(owner, ['propget', 'svn:eol-style', `${repository.url}/new/nested/added.ts@HEAD`])).trim() === 'native')
  }

  private async execute(): Promise<void> {
    if (process.argv.includes('--matrix-audit')) { await SvnAuditScenarios.run(this.root); return }
    if (process.argv.includes('--matrix-preparation')) { await SvnPreparationScenarios.run(this.root); await this.checkPreparationFlow(); return }
    if (process.argv.includes('--matrix-update')) { await SvnUpdateScenarios.run(this.root); return }
    if (process.argv.includes('--matrix-branches')) { await SvnBranchConflicts.run(this.root, this.svn); return }
    if (process.argv.includes('--matrix-changes')) { await this.checkChangeMatrix(); return }
    if (process.argv.includes('--matrix-externals')) { await this.checkExternalCarrier(); await this.checkNestedPins(); return }
    if (process.argv.includes('--external-carrier')) { await this.checkExternalCarrier(); return }
    if (process.argv.includes('--matrix-conflicts')) { await this.checkTextAndProperty(); await this.checkNewFlow(['NF02'], 60); await this.checkIncidentSameName(); return }
    if (process.argv.includes('--matrix-moves')) {
      await new ConflictShapesSpike({ root: join(this.root, 'conflict-moves'), svn: this.svn, check: (description, condition) => this.check(description, condition),
        anonymized: (text, placeholders) => this.anonymized(text, placeholders) }).moves()
      return
    }
    if (process.argv.includes('--matrix-scope')) { await this.checkCreateOwners(); return }
    if (process.argv.includes('--matrix-recovery')) { await this.checkNewFlow(['E07', 'E08']); return }
    if (process.argv.includes('--matrix-incident')) { await this.checkIncident072(); return }
    if (process.argv.includes('--incident-rule')) { await this.checkIncidentRule(); await this.checkIncidentSameName(); return }
    if (process.argv.includes('--legacy-regressions')) { await this.checkRegressions(); return }
    if (process.argv.includes('--legacy-finish')) { await this.checkFinishFlow(); return }
    const contracts = process.argv.indexOf('--legacy-contracts')
    if (contracts >= 0) {
      const selected = (process.argv[contracts + 1] ?? 'worktree,owners,cleanup,testbed,wait,resolve,guard').split(',')
      for (const name of selected) {
        if (name === 'worktree') await this.checkWorktreeContract()
        else if (name === 'owners') await this.checkCreateOwners()
        else if (name === 'cleanup') await this.checkCleanup()
        else if (name === 'testbed') await this.checkConflictTestbed()
        else if (name === 'wait') await this.checkIncidentWait()
        else if (name === 'resolve') await this.checkIncidentResolve()
        else if (name === 'guard') await this.checkIncidentGuard()
        else throw new Error(`Unknown legacy contract: ${name}`)
      }
      console.log(`\nsmoke-svn-worktree: ${this.passed} legacy contract checks passed`)
      return
    }
    if (process.argv.includes('--legacy-held')) { await this.checkWorktreeContract(true); return }
    if (process.argv.includes('--legacy-rules')) { await this.checkLosslessRules(); return }
    if (process.argv.includes('--legacy-landed')) { await this.checkLandedRows(); return }
    const selected = process.argv.indexOf('--nf')
    if (selected >= 0) {
      const ids = process.argv[selected + 1].split(',')
      if (ids.includes('NF12')) await SvnWriterCrash.run(this.root)
      await this.checkNewFlow(ids)
      await SvnFinishContractCases.run(ids, this.root)
      return
    }
    if (!process.argv.includes('--legacy-tail')) {
      await SvnAuditScenarios.run(this.root)
      await SvnPreparationScenarios.run(this.root)
      await this.checkPreparationFlow()
      await SvnUpdateScenarios.run(this.root)
      await this.checkNewFlow()
      await SvnWriterCrash.run(this.root)
      await SvnFinishContractCases.run(undefined, this.root)
      await this.checkRegressions()
      await this.checkIncidentRule()
      await this.checkIncidentSameName()
    }
    await this.checkLosslessRules()
    await this.checkNonAsciiSpike()
    const conflictCaptures = await new ConflictShapesSpike({
      root: join(this.root, 'conflict-shapes'),
      svn: this.svn,
      check: (description, condition) => this.check(description, condition),
      anonymized: (text, placeholders) => this.anonymized(text, placeholders),
    }).run()
    const captures = await this.checkFinishEvidence()
    if (this.capture) {
      await mkdir(conflictFixtureDirectory, { recursive: true })
      let written = 0
      for (const { name, text } of captures) written += await SmokeSvnWorktree.writeFixture(join(fixtureDirectory, name), text)
      for (const { name, text } of conflictCaptures) written += await SmokeSvnWorktree.writeFixture(join(conflictFixtureDirectory, name), text)
      console.log(`  wrote ${written} of ${captures.length + conflictCaptures.length} fixtures to ${fixtureDirectory}`)
    }
    else {
      await this.checkFixturesCurrent(captures)
      await this.checkConflictFixturesCurrent(conflictCaptures)
    }
    await this.checkFinishFlow()
    await this.checkLandedRows()
    await this.checkIncident072()
    await this.checkWorktreeContract()
    await this.checkCreateOwners()
    await this.checkCleanup()
    await this.checkConflictTestbed()
    await this.checkIncidentWait()
    await this.checkIncidentResolve()
    await this.checkIncidentGuard()
    console.log(`\nsmoke-svn-worktree: ${this.passed} checks passed`)
  }

  private async checkNewFlow(selected?: readonly string[], conflicts = 22): Promise<void> {
    for (const id of ['NF01', 'NF02', 'NF03', 'NF04', 'NF05', 'NF06', 'NF07', 'NF10', 'NF11', 'NF12', 'NF18', 'NF25', 'NF27', 'NF31', 'NF32', 'NF33', 'NF34', 'NF35', 'NF36', 'E07', 'E08']) {
      if (selected === undefined && id.startsWith('E')) continue
      if (selected !== undefined && !selected.includes(id)) continue
      const multiRepository = ['NF18', 'NF31', 'NF32', 'NF33', 'NF34', 'E07', 'E08'].includes(id)
      const externalNames = id === 'NF31' ? Array.from({ length: 18 }, (_, index) => `library-${index}`) : ['front', 'back']
      const repository = await SvnFixtureRepository.create(join(this.root, `${id}-repository`), this.svn)
      const owner = join(this.root, `${id}-main`)
      await repository.run(this.root, ['checkout', repository.url, owner])
      const names = id === 'NF02' || id === 'NF03' ? conflicts === 22 ? ConflictShapesSpike.incidentEolPaths
        : Array.from({ length: conflicts }, (_, n) => `conflict-${String(n).padStart(3, '0')}.txt`) : ['a.txt', 'delete.txt']
      for (const name of names) await writeFile(join(owner, name), id === 'NF18' && name === 'a.txt' ? 'one\ntwo\nthree\nfour\n' : 'base\n')
      await repository.run(owner, ['add', '--', ...names])
      await repository.run(owner, ['propset', 'svn:global-ignores', '.worktrees', '.'])
      await repository.run(owner, ['propset', 'svn:eol-style', 'native', ...(id === 'NF02' || id === 'NF03' ? names : [names[0]])])
      if (multiRepository) {
        const mounts: string[] = []
        for (const name of externalNames) {
          const external = await SvnFixtureRepository.create(join(this.root, `${id}-${name}-repository`), this.svn), checkout = join(this.root, `${id}-${name}-seed`)
          await external.run(this.root, ['checkout', external.url, checkout])
          await writeFile(join(checkout, 'external.txt'), 'base\n')
          await external.run(checkout, ['add', 'external.txt']); await external.run(checkout, ['commit', '-m', 'external seed'])
          mounts.push(`${external.url} ${name}`)
        }
        await repository.run(owner, ['propset', 'svn:externals', mounts.join('\n'), '.'])
      }
      await repository.run(owner, ['commit', '-m', 'seed'])
      await repository.run(owner, ['update'])
      const manager = new SvnWorktreeManager(this.svn)
      const records = await SessionRecordsStore.load(join(this.root, `${id}-records.json`), { snapshotsDirectory: join(this.root, `${id}-snapshots`) })
      const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, `${id}-logs`))
      const made = await manager.create({ ownerDir: owner, folder: `001-${id.toLowerCase()}` })
      if (!made.ok) throw new Error(made.detail)
      const tree = made.value.worktreePath
      await records.put({ sessionId: id, kind: 'agent', title: id, createdAt: Date.now(), life: 'ended', binding: null,
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: `fixture-${id}` }, directory: { mode: 'adHoc', path: owner },
        worktree: { kind: 'svn', worktreePath: tree, repositoryRoot: owner, branch: made.value.url, baseCommit: `r${made.value.baseRevision}`,
          agentStartedAt: Date.now(), ...(made.value.directoryId === null ? {} : { directoryId: made.value.directoryId }) } })
      if (id === 'NF02' || id === 'NF03') {
        for (const name of names) { await writeFile(join(tree, name), 'worker\r\n'); await writeFile(join(owner, name), 'incoming\n') }
        await repository.run(owner, ['commit', '-m', 'incoming conflict set'])
        await actions.flow.start(id, { choice: 'commit', requestedBy: 'window' })
        this.check(`${id} real SVN retains all ${names.length} native-EOL conflicts`, records.get(id)?.worktreeLifecycle?.syncConflictSet?.entries.length === names.length)
        this.check(`${id} agent Keep cannot replace the person Finish`, !(await actions.flow.start(id, { choice: 'keep', requestedBy: 'cli' })).ok)
        await actions.flow.start(id, { choice: 'keep', requestedBy: 'window' })
        await actions.flow.start(id, { choice: 'commit', requestedBy: 'window' })
        this.check(`${id} Keep and Finish again retain ${names.length} conflicts and publish nothing`, records.get(id)?.worktreeLifecycle?.syncConflictSet?.entries.length === names.length && actions.opened.length === 0)
        if (id === 'NF02') {
          this.check('NF02 durable worker handoff includes the complete conflict set', records.get(id)?.worktreeLifecycle?.handoff?.text.includes(`${names.length} conflicts`) === true)
          await SvnScriptedWorker.settle(this.root, tree, id, names, actions.flow)
          await actions.settled()
          const resolved = await actions.finish(id)
          this.check(`NF02 scripted worker settles all ${names.length} paths through the CLI and person review publishes once`, resolved.outcome?.result === 'committed' && actions.opened.length === 1)
          this.check('NF02 repository retains both worker and incoming lines', (await repository.run(owner, ['cat', `${repository.url}/${names[0]}@HEAD`])).replace(/\r\n/g, '\n') === 'incoming\nworker\n')
        }
        continue
      }
      await writeFile(join(tree, 'a.txt'), id === 'NF18' ? 'worker\r\ntwo\r\nthree\r\nfour\r\n' : 'worker\r\n')
      if (id === 'NF36') {
        actions.checksOf = () => [{ name: 'ended check', command: 'node -e "process.exit(0)"' }]
        actions.onCheckEnded = async (parentId) => {
          assert.equal(records.get(parentId)?.worktreeLifecycle?.step, 'checking')
          assert((await actions.flow.backToWork(parentId, 'person')).ok)
        }
        await actions.flow.start(id, { choice: 'commit', requestedBy: 'window' })
        await actions.settled()
        this.check('NF36 an ended real check returns to work through SessionScriptsManager before its late verdict',
          actions.checkRuns === 1 && records.get(id)?.worktreeLifecycle?.phase === 'active' && actions.opened.length === 0)
        continue
      }
      if (id === 'NF12') {
        await writeFile(join(owner, 'delete.txt'), 'incoming target\n')
        await repository.run(owner, ['commit', '-m', 'recovery target'])
        await actions.flow.start(id, { choice: 'commit', requestedBy: 'window' })
        const original = records.get(id)!.worktreeLifecycle!.journal.find((row) => row.kind === 'update')!
        await records.update(id, (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, step: 'syncing',
          journal: record.worktreeLifecycle!.journal.map((row) => row.runId === original.runId ? { ...row, endedAt: undefined, outcome: undefined } : row) } }))
        await repository.run(owner, ['update'])
        await writeFile(join(owner, 'delete.txt'), 'newer incoming after crash\n')
        await repository.run(owner, ['commit', '-m', 'newer head'])
        const recover = async () => {
          const loaded = await SessionRecordsStore.load(join(this.root, `${id}-records.json`), { snapshotsDirectory: join(this.root, `${id}-snapshots`) })
          const restored = new SmokeSvnActions(loaded, manager, this.svn, join(this.root, `${id}-logs`))
          await new WorktreeRecovery({ records: loaded, commit: (session, entry) => restored.flow.recoverCommit(session, entry),
            step: (session, entry) => restored.flow.recoverStep(session, entry), before: async () => false, resume: () => {},
            report: (message) => { throw new Error(message) }, now: Date.now }).run()
          return loaded
        }
        const first = await recover()
        this.check('NF12 interrupted real UPDATE recovers its saved target despite a newer HEAD',
          (await repository.run(tree, ['info', '--show-item', 'revision'])).trim() === String(original.targetRevision)
          && await readFile(join(tree, 'delete.txt'), 'utf8') === 'incoming target\n')
        const count = first.get(id)!.worktreeLifecycle!.journal.length
        const second = await recover()
        this.check('NF12 second startup closes old intent without replaying UPDATE', WorktreeRecovery.pending(second.get(id)!).length === 0
          && second.get(id)!.worktreeLifecycle!.journal.length === count)
        continue
      }
      if (id === 'NF07') { await repository.run(tree, ['propset', 'jamat:approval', 'yes', 'a.txt']); await repository.run(tree, ['delete', 'delete.txt']) }
      if (id === 'NF04' || id === 'NF05') {
        await actions.flow.start(id, { choice: 'commit', requestedBy: 'window' })
        const version = records.get(id)!.worktreeLifecycle!.version
        if (id === 'NF05') await writeFile(join(tree, 'a.txt'), 'edited after review\r\n')
        const press: SessionFinishPress = { choice: 'commit', requestedBy: 'window', selection: [join(tree, 'a.txt')], message: '[Smoke] Reviewed bytes', messageSource: 'person-local', reviewVersion: version }
        const first = await actions.flow.start(id, press)
        if (id === 'NF05') this.check(`${id} real selected-byte edit prevents publication`, !first.ok && actions.opened.length === 0)
        else {
          const second = await actions.flow.start(id, press)
          this.check(`${id} second window approval cannot publish twice`, first.ok && !second.ok && actions.opened.length === 1)
        }
        continue
      }
      if (id === 'NF10') actions.lostPublicationResponse = true
      const hook = join(repository.directory, 'hooks', process.platform === 'win32' ? 'pre-commit.bat' : 'pre-commit')
      if (id === 'NF33' || id === 'NF34') {
        for (const name of externalNames) await writeFile(join(tree, name, 'external.txt'), `${name} worker\n`)
        await writeFile(hook, process.platform === 'win32' ? '@echo off\r\necho fixture owner rejected 1>&2\r\nexit /b 1\r\n'
          : '#!/bin/sh\necho fixture owner rejected >&2\nexit 1\n', { mode: 0o755 })
        await actions.finish(id)
        assert.equal(actions.opened.length, 2)
        assert.equal(records.get(id)?.worktreeLifecycle?.wait?.kind, 'partially-landed')
        assert((await actions.flow.start(id, { choice: id === 'NF33' ? 'keep' : 'discard', requestedBy: 'window' })).ok)
        await actions.settled()
        this.check(`${id} two published externals plus a rejected owner remain partial after ${id === 'NF33' ? 'Keep' : 'Discard'}`,
          records.get(id)?.worktreeOutcome?.result === 'partial' && actions.results.list({ sessionId: id }).every((row) => row.result === 'partial')
          && LandedRows.landingOf(records.get(id)!)?.landed.length === 2)
        continue
      }
      if (id === 'NF11') await writeFile(hook, process.platform === 'win32' ? '@echo off\r\necho SVN E170013 fixture rejected before publication 1>&2\r\nexit /b 1\r\n' : '#!/bin/sh\necho fixture rejected >&2\nexit 1\n', { mode: 0o755 })
      if (id === 'E07' || id === 'E08') {
        for (const name of externalNames) await writeFile(join(tree, name, 'external.txt'), `${name} worker\n`)
        const roots = await manager.reviewRoots(tree)
        if (!roots.ok) throw new Error(roots.detail)
        const mounts = roots.value.filter((row) => row.own !== '')
        assert.equal(mounts.length, 2)
        const rejectedHook = join(this.root, `${id}-${mounts[1].own}-repository`, 'hooks', process.platform === 'win32' ? 'pre-commit.bat' : 'pre-commit')
        if (id === 'E07') await writeFile(rejectedHook, process.platform === 'win32'
          ? '@echo off\r\necho SVN E170013 fixture external hook rejected 1>&2\r\nexit /b 1\r\n'
          : '#!/bin/sh\necho fixture external hook rejected >&2\nexit 1\n', { mode: 0o755 })
        else {
          actions.lostPublicationResponse = true
          actions.afterPublication = async (cwd) => {
            assert.equal(cwd, mounts[0].path)
            actions.afterPublication = null
            const consumer = join(owner, mounts[0].own)
            await repository.run(consumer, ['update'])
            await writeFile(join(consumer, 'external.txt'), 'later consumer content\n')
            await repository.run(consumer, ['commit', '-m', 'Third party after accepted external commit'])
          }
        }
        await actions.finish(id)
        this.check(`${id} initial interruption preserves one accepted mount and the worktree`, actions.opened.length === 1
          && actions.opened[0] === mounts[0].path && existsSync(tree))
        if (id === 'E07') await rm(rejectedHook)
        await records.settled()
        const reloaded = await SessionRecordsStore.load(join(this.root, `${id}-records.json`), { snapshotsDirectory: join(this.root, `${id}-snapshots`) })
        const resumed = new SmokeSvnActions(reloaded, manager, this.svn, join(this.root, `${id}-logs`))
        let final = await resumed.finish(id)
        if (id === 'E08') {
          this.check('E08 a later consumer revision requires fresh preparation and confirmation after recovery', resumed.opened.length === 0
            && reloaded.get(id)?.worktreeLifecycle?.step === 'reviewing' && reloaded.get(id)?.worktreeLifecycle?.approvedAt === undefined)
          final = await resumed.finish(id)
        }
        console.log(`  state ${id}: ${JSON.stringify({ outcome: final.outcome, needs: final.action?.needs, published: resumed.opened })}`)
        this.check(`${id} restart publishes only the remaining mount and owner`, final.outcome?.result === 'committed'
          && resumed.opened.length === 2 && !resumed.opened.includes(mounts[0].path))
        const saved = resumed.results.list({ sessionId: id }).find((row) => row.result === 'committed')
        this.check(`${id} result retains exactly three publication receipts`, saved?.revisions.length === 3
          && reloaded.get(id)?.commitReceipts?.length === 3)
        const firstConsumer = join(owner, mounts[0].own)
        this.check(`${id} accepted external is not committed twice`, (await repository.run(firstConsumer, ['log', '--xml', '-r', '1:HEAD'])).match(/<logentry/g)?.length === (id === 'E08' ? 3 : 2))
        if (id === 'E08') {
          const externalUrl = (await repository.run(firstConsumer, ['info', '--show-item', 'url'])).trim()
          this.check('E08 receipt identifies our r2 while the same path at HEAD belongs to the later consumer', final.outcome?.revisions.includes(`${externalUrl}:r2`) === true
            && !final.outcome.revisions.includes(`${externalUrl}:r3`)
            && (await repository.run(firstConsumer, ['cat', '-r', '2', `${externalUrl}/external.txt`])) === `${mounts[0].own} worker\n`
            && (await repository.run(firstConsumer, ['cat', `${externalUrl}/external.txt`])) === 'later consumer content\n')
        }
        continue
      }
      if (id === 'NF18') {
        for (const name of externalNames) await writeFile(join(tree, name, 'external.txt'), `${name} worker\n`)
        actions.beforePublication = async (cwd) => {
          if (cwd !== tree) return
          actions.beforePublication = null
          await writeFile(join(owner, 'a.txt'), 'one\ntwo\nthree\nincoming\n')
          await repository.run(owner, ['commit', '-m', 'Concurrent owner edit'])
        }
      }
      if (id === 'NF32') {
        actions.checksOf = () => [{ name: 'external check', command: 'node -e "process.exit(0)"' }]
        await actions.flow.start(id, { choice: 'commit', requestedBy: 'window' }); await actions.settled()
        const initialHead = records.get(id)!.worktreeLifecycle!.facts.syncedAt!.revision
        const external = join(owner, 'front')
        await writeFile(join(external, 'external.txt'), 'external advanced independently\n')
        await repository.run(external, ['commit', '-m', 'Advance only the external repository'])
        const currentHead = await manager.headRevisionOf(tree)
        assert(currentHead.ok, 'Read current owner revision')
        assert.equal(currentHead.value, initialHead)
        actions.onCheck = async () => { assert.equal(await readFile(join(tree, 'front/external.txt'), 'utf8'), 'external advanced independently\n') }
      }
      if (id === 'NF31')
        for (const name of externalNames) await writeFile(join(tree, name, 'external.txt'), `${name} worker\n`)
      if (id === 'NF35') await writeFile(join(tree, 'delete.txt'), 'second file published\n')
      if (id === 'NF27' || id === 'NF35') actions.afterPublication = async (cwd) => { await writeFile(join(cwd, 'a.txt'), 'corrective worker change\r\n'); actions.afterPublication = null }
      // The person's local edit is there before the Finish, whose UPDATE then runs by itself (Finish 072).
      if (id === 'NF25') {
        await writeFile(join(owner, 'a.txt'), 'person local overlap\r\n')
        await repository.run(owner, ['propset', 'jamat:local', 'personal property', 'a.txt'])
      }
      const result = await actions.finish(id)
      if (id === 'NF10' || id === 'NF11') {
        this.check(`${id} initial failure waits with durable commit intent`, records.get(id)?.worktreeLifecycle?.journal.some((row) => row.kind === 'commit') === true && existsSync(tree))
        if (id === 'NF11') await rm(hook)
        await records.settled()
        const reloaded = await SessionRecordsStore.load(join(this.root, `${id}-records.json`), { snapshotsDirectory: join(this.root, `${id}-snapshots`) })
        const restarted = new SmokeSvnActions(reloaded, manager, this.svn, join(this.root, `${id}-logs`))
        await restarted.flow.start(id, { choice: 'commit', requestedBy: 'window' }); await restarted.settled()
        if (id === 'NF11') {
          this.check('NF11 real repository absence requires fresh review and no replay', reloaded.get(id)?.worktreeLifecycle?.wait?.kind === 'review' && restarted.opened.length === 0 && (await repository.run(owner, ['log', '--xml', '-r', '1:HEAD'])).match(/<logentry/g)?.length === 1)
          await restarted.finish(id)
        }
        this.check(`${id} recovery and second startup publish exactly once`, (await repository.run(owner, ['log', '--xml', '-r', '1:HEAD'])).match(/<logentry/g)?.length === 2 && reloaded.get(id)?.worktreeOutcome?.result === 'committed')
        const twice = await SessionRecordsStore.load(join(this.root, `${id}-records.json`), { snapshotsDirectory: join(this.root, `${id}-snapshots`) })
        const second = new SmokeSvnActions(twice, manager, this.svn, join(this.root, `${id}-logs`))
        await second.flow.drive(id); await second.settled()
        this.check(`${id} another startup preserves one receipt and launches no commit`, second.opened.length === 0 && twice.get(id)?.commitReceipts?.length === 1)
        continue
      }
      if (id === 'NF18') {
        this.check('NF18 two real external publications survive owner out-of-date', actions.opened.length === 2 && records.get(id)?.worktreeLifecycle?.execution?.evidence.length === 2 && existsSync(tree))
        await records.settled()
        const reloaded = await SessionRecordsStore.load(join(this.root, `${id}-records.json`), { snapshotsDirectory: join(this.root, `${id}-snapshots`) })
        const resumed = new SmokeSvnActions(reloaded, manager, this.svn, join(this.root, `${id}-logs`))
        const final = await resumed.finish(id)
        this.check('NF18 restart and reapproval publish only the pending owner', final.outcome?.result === 'committed' && resumed.opened.length === 1 && resumed.opened[0] === tree)
        const saved = resumed.results.list({ sessionId: id }).find((row) => row.result === 'committed')
        this.check('NF18 result retains all three repositories and their revision/path obligations', saved?.revisions.length === 3 && LandedRows.landingOf(reloaded.get(id)!)?.landed.length === 3)
        continue
      }
      if (id === 'NF27' || id === 'NF35') {
        this.check('NF27 publication differences retain the original revision', records.get(id)?.worktreeLifecycle?.wait?.kind === 'published-with-differences' && actions.opened.length === 1)
        await actions.flow.start(id, { choice: 'commit', requestedBy: 'window' })
        this.check('NF27 ordinary Retry only re-verifies', actions.opened.length === 1)
        await actions.flow.start(id, { choice: 'commit', requestedBy: 'window', reviewCorrection: true })
        if (id === 'NF35') assert.deepEqual(records.get(id)?.worktreeLifecycle?.review?.selection, ['a.txt'])
        await actions.finish(id)
        const final = actions.results.list({ sessionId: id }).find((row) => row.result === 'committed')
        this.check('NF27 explicit corrective publication keeps both revisions in one Jamat result', actions.opened.length === 2 && final?.revisions.length === 2)
        if (id === 'NF35') this.check('NF35 correction of one of two published files completes both per-path obligations',
          final?.revisions[0].paths?.length === 2 && final?.revisions[1].paths?.length === 1 && records.get(id)?.worktreeOutcome?.result === 'committed')
        continue
      }
      this.check(`${id} real SVN publication verifies native bytes/properties/deletions before removal`, result.outcome?.result === 'committed' && !existsSync(tree))
      if (id === 'NF32')
        this.check('NF32 unchanged owner HEAD still refreshes the external before declared checks and publication',
          actions.checkRuns > 1 && result.outcome?.result === 'committed' && actions.opened.length === 1)
      if (id === 'NF31') {
        await actions.flow.settled(id)
        this.check('NF31 nineteen repositories pass the scheduler budget and publish exactly once',
          actions.opened.length === 19 && new Set(actions.opened).size === 19 && records.get(id)?.commitReceipts?.length === 19
          && records.get(id)?.worktreeLifecycle?.verified?.length === 19 && result.outcome?.result === 'committed')
      }
      await actions.flow.startUpdate(id, owner, 'window'); await actions.settled()
      if (id === 'NF25') {
        const protectedCopy = records.get(id)?.svnAction?.updateProtection?.saved[0]
        this.check('NF25 real UPDATE saves overlapping local bytes/properties before creating a conflict', protectedCopy !== undefined && existsSync(protectedCopy))
        const files = protectedCopy === undefined ? [] : await readdir(protectedCopy, { recursive: true })
        const contents = await Promise.all(files.map((file) => readFile(join(protectedCopy!, file), 'utf8').catch(() => '')))
        this.check('NF25 immutable overlap copy contains personal bytes and property value', contents.some((text) => text.includes('person local overlap')) && contents.some((text) => text.includes('personal property')))
        continue
      }
      this.check(`${id} main-copy UPDATE includes the reviewed publication`, (await readFile(join(owner, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n') === 'worker\n')
      if (id === 'NF07') this.check('NF07 property value and deletion remain proven after UPDATE', !existsSync(join(owner, 'delete.txt')) && (await repository.run(owner, ['propget', 'jamat:approval', 'a.txt'])).trim() === 'yes')
    }
  }

  private async checkNestedPins(): Promise<void> {
    const repository = await SvnFixtureRepository.create(join(this.root, 'pins-app-repository'), this.svn)
    const outer = await SvnFixtureRepository.create(join(this.root, 'pins-outer-repository'), this.svn)
    const inner = await SvnFixtureRepository.create(join(this.root, 'pins-inner-repository'), this.svn)
    const owner = join(this.root, 'pins-app')
    await repository.run(this.root, ['checkout', repository.url, owner])
    await repository.run(owner, ['propset', 'svn:global-ignores', '.worktrees', '.'])
    await repository.run(owner, ['propset', 'svn:externals', `${outer.url} outer\n${inner.url} seed`, '.'])
    await repository.run(owner, ['commit', '-m', 'mounts']); await repository.run(owner, ['update'])
    await writeFile(join(owner, 'seed/lib.txt'), 'inner base\n')
    await repository.run(join(owner, 'seed'), ['add', 'lib.txt']); await repository.run(join(owner, 'seed'), ['commit', '-m', 'inner seed'])
    const manager = new SvnWorktreeManager(this.svn)
    for (const [name, definition] of [['operative', `-r1 ${inner.url} nested`], ['peg', `${inner.url}@1 nested`], ['both', `-r1 ${inner.url}@1 nested`], ['floating', `${inner.url} nested`]] as const) {
      await repository.run(join(owner, 'outer'), ['propset', 'svn:externals', '--', definition, '.'])
      await repository.run(join(owner, 'outer'), ['commit', '-m', `Nested ${name} definition`]); await repository.run(owner, ['update'])
      const made = await manager.create({ ownerDir: owner, folder: `pin-${name}` })
      if (!made.ok) throw new Error(made.detail)
      const tree = made.value.worktreePath, id = `E04-E06-${name}`
      await writeFile(join(tree, 'outer/nested/lib.txt'), `${name} worker\n`)
      const roots = await manager.reviewRoots(tree)
      this.check(`${id} nested carrier pin is read from its own WC`, roots.ok && roots.value.find((row) => row.own === 'outer/nested')?.pinned === (name !== 'floating'))
      const records = await SessionRecordsStore.load(join(this.root, `${id}-records.json`), { snapshotsDirectory: join(this.root, `${id}-snapshots`) })
      const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, `${id}-logs`))
      await records.put({ sessionId: id, kind: 'agent', title: id, createdAt: Date.now(), life: 'ended', binding: null,
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: `fixture-${id}` }, directory: { mode: 'adHoc', path: owner },
        worktree: { kind: 'svn', worktreePath: tree, repositoryRoot: owner, branch: made.value.url, baseCommit: `r${made.value.baseRevision}`,
          agentStartedAt: Date.now(), ...(made.value.directoryId === null ? {} : { directoryId: made.value.directoryId }) } })
      const result = await actions.finish(id)
      if (name === 'floating')
        this.check(`${id} floating nested change publishes only its repository`, result.outcome?.result === 'committed' && actions.opened.length === 1
          && actions.opened[0] === join(tree, 'outer/nested') && await repository.run(owner, ['cat', `${inner.url}/lib.txt@HEAD`]) === 'floating worker\n')
      else
        this.check(`${id} pinned nested change waits without publication or lost bytes`, actions.opened.length === 0 && existsSync(tree)
          && result.action?.needs?.reason.includes('pinned') === true && await readFile(join(tree, 'outer/nested/lib.txt'), 'utf8') === `${name} worker\n`)
    }
    console.log(`\nsmoke-svn-worktree nested externals: ${this.passed} checks passed`)
  }

  private async checkChangeMatrix(): Promise<void> {
    const cases = ['D01-clean', 'D02-many', 'D02-500', 'D03-nested', 'D04-partial', 'D05-missing', 'D05-delete', 'D06-move',
      'D07-replace', 'D07-kind', 'D08-root', 'D08-file', 'D09-bytes', 'D10-spaces', 'D10-at', 'D10-unicode', 'D10-case', 'D10-case-dir'] as const
    const requested = process.argv[process.argv.indexOf('--matrix-changes') + 1]
    const selected = requested?.startsWith('D') ? requested.split(',') : cases
    for (const id of selected) if (!(cases as readonly string[]).includes(id)) throw new Error(`Unknown change matrix case: ${id}`)
    for (const id of cases.filter((id) => selected.includes(id))) {
      if (id === 'D10-unicode' && process.argv.includes('--skip-known-limits')) {
        console.log('  SKIP D10-unicode: known unsupported Windows path operation, explicitly excluded from this run')
        continue
      }
      const repository = await SvnFixtureRepository.create(join(this.root, `${id}-repository`), this.svn)
      const owner = join(this.root, `${id}-main`)
      await repository.run(this.root, ['checkout', repository.url, owner])
      await mkdir(join(owner, 'old'))
      await writeFile(join(owner, 'old', 'child.txt'), 'child base\n')
      await writeFile(join(owner, 'a.txt'), 'base\n')
      await writeFile(join(owner, 'control.txt'), 'unchanged\n')
      await repository.run(owner, ['add', 'a.txt', 'control.txt', 'old'])
      await repository.run(owner, ['propset', 'svn:global-ignores', '.worktrees', '.'])
      await repository.run(owner, ['commit', '-m', 'seed change matrix'])
      await repository.run(owner, ['update'])
      const manager = new SvnWorktreeManager(this.svn)
      const records = await SessionRecordsStore.load(join(this.root, `${id}-records.json`), { snapshotsDirectory: join(this.root, `${id}-snapshots`) })
      const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, `${id}-logs`))
      const made = await manager.create({ ownerDir: owner, folder: id.toLowerCase() })
      if (!made.ok) throw new Error(made.detail)
      const tree = made.value.worktreePath
      await records.put({ sessionId: id, kind: 'agent', title: id, createdAt: Date.now(), life: 'ended', binding: null,
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: `fixture-${id}` }, directory: { mode: 'adHoc', path: owner },
        worktree: { kind: 'svn', worktreePath: tree, repositoryRoot: owner, branch: made.value.url, baseCommit: `r${made.value.baseRevision}`,
          agentStartedAt: Date.now(), ...(made.value.directoryId === null ? {} : { directoryId: made.value.directoryId }) } })
      const expected = new Map<string, Buffer>(), absent: string[] = [], directories: string[] = []
      const put = async (path: string, value: string | Buffer) => {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
        await mkdir(join(tree, path, '..'), { recursive: true })
        await writeFile(join(tree, path), bytes)
        expected.set(path, bytes)
      }
      switch (id) {
        case 'D01-clean': break
        case 'D02-many': case 'D02-500':
          for (let n = 0; n < (id === 'D02-500' ? 500 : 100); n++) await put(`src/group-${n % 5}/file-${n}.txt`, `change ${n}\n`)
          break
        case 'D03-nested':
          await put('new-dir/nested/a.txt', 'new child\n'); await mkdir(join(tree, 'empty')); directories.push('empty')
          break
        case 'D04-partial':
          await put('new-dir/selected.txt', 'selected\n'); await put('new-dir/kept.txt', 'unselected\n')
          break
        case 'D05-missing': await rm(join(tree, 'a.txt')); absent.push('a.txt'); break
        case 'D05-delete': await repository.run(tree, ['delete', 'a.txt', 'old']); absent.push('a.txt', 'old'); break
        case 'D06-move':
          await repository.run(tree, ['move', 'old', 'moved']); await repository.run(tree, ['move', 'a.txt', 'renamed.txt'])
          await put('moved/child.txt', 'moved edit\n'); expected.set('renamed.txt', Buffer.from('base\n')); absent.push('a.txt', 'old')
          break
        case 'D07-replace':
          await repository.run(tree, ['delete', 'a.txt']); await put('a.txt', 'replacement\n'); await repository.run(tree, ['add', 'a.txt'])
          break
        case 'D07-kind':
          await repository.run(tree, ['delete', 'a.txt']); await put('a.txt/child.txt', 'file became directory\n'); await repository.run(tree, ['add', 'a.txt'])
          break
        case 'D08-root': await repository.run(tree, ['propset', 'jamat:test', 'root value', '.']); break
        case 'D08-file': await repository.run(tree, ['propset', 'jamat:test', 'file value', 'a.txt']); break
        case 'D09-bytes':
          for (const [path, bytes] of [['lf.txt', Buffer.from('one\ntwo\n')], ['crlf.txt', Buffer.from('one\r\ntwo\r\n')],
            ['bom.txt', Buffer.from('\ufeffPříliš žluťoučký\n')], ['no-newline.txt', Buffer.from('last line')], ['binary.bin', Buffer.from([0, 255, 1, 128, 13, 10])]] as const)
            await put(path, bytes)
          break
        case 'D10-spaces': await put('directory with spaces/file name.txt', 'spaces\n'); break
        case 'D10-at': await put('user@host.txt', 'literal at\n'); break
        case 'D10-unicode': await put('žluťoučký/ř.txt', 'Unicode identity\n'); break
        case 'D10-case':
          await repository.run(tree, ['move', 'a.txt', 'temporary.txt']); await repository.run(tree, ['move', 'temporary.txt', 'A.txt'])
          expected.set('A.txt', Buffer.from('base\n'))
          break
        case 'D10-case-dir':
          await repository.run(tree, ['move', 'old', 'temporary']); await repository.run(tree, ['move', 'temporary', 'Old'])
          await put('Old/child.txt', 'case directory edit\n')
          break
        default: throw new Error(`Unknown matrix case ${id satisfies never}`)
      }
      this.counts.clear()
      const start = Date.now()
      let result = await actions.finish(id, id === 'D04-partial' ? { select: (rows) => rows.filter((row) => row.displayPath === 'new-dir/selected.txt') } : {})
      if (id === 'D04-partial') {
        this.check(`${id} partial selection refuses publication and preserves every source`, actions.opened.length === 0
          && result.answer.ok === false && records.get(id)?.worktreeLifecycle?.approvedAt === undefined
          && await readFile(join(tree, 'new-dir/kept.txt'), 'utf8') === 'unselected\n')
        result = await actions.finish(id)
      }
      console.log(`  timing ${id}: Finish ${Date.now() - start} ms; SVN calls ${JSON.stringify(Object.fromEntries(this.counts))}`)
      if (id === 'D02-many' || id === 'D02-500')
        this.check(`${id} metadata and staging use bounded batches`, [...this.counts.values()].reduce((sum, count) => sum + count, 0) < 250)
      console.log(`  state ${id}: ${JSON.stringify({ answer: result.answer, outcome: result.outcome, needs: result.action?.needs, opened: actions.opened.length })}`)
      if (id === 'D10-unicode') {
        this.check(`${id} unsupported path operation publishes nothing and retains all local bytes`, actions.opened.length === 0
          && result.action?.needs?.kind === 'svn-failed' && result.outcome === undefined && existsSync(tree)
          && [...expected].every(([path, bytes]) => existsSync(join(tree, path)) && bytes.length > 0))
        for (const [path, bytes] of expected) this.check(`${id} retained bytes: ${path}`, (await readFile(join(tree, path))).equals(bytes))
        this.check(`${id} repository has no accidental publication`, (await repository.run(owner, ['log', '--xml', '-r', '1:HEAD'])).match(/<logentry/g)?.length === 1)
        console.log(`  GAP  ${id}: safe refusal, operation remains unsupported: ${result.action?.needs?.reason}`)
        continue
      }
      this.check(`${id} Finish records ${id === 'D01-clean' ? 'nothing without publication' : 'one verified publication'} and removes the worktree`,
        result.outcome?.result === (id === 'D01-clean' ? 'nothing' : 'committed') && actions.opened.length === (id === 'D01-clean' ? 0 : 1) && !existsSync(tree))
      const verified = join(this.root, `${id}-verified`)
      await repository.run(this.root, ['checkout', repository.url, verified])
      for (const [path, bytes] of expected)
        this.check(`${id} published exact bytes: ${path}`, (await readFile(join(verified, path))).equals(bytes))
      for (const path of absent) this.check(`${id} repository omits ${path}`, !existsSync(join(verified, path)))
      for (const path of directories) this.check(`${id} repository retains empty directory ${path}`, existsSync(join(verified, path)) && (await readdir(join(verified, path))).length === 0)
      if (id === 'D08-root' || id === 'D08-file')
        this.check(`${id} published property`, (await repository.run(verified, ['propget', 'jamat:test', id === 'D08-root' ? '.' : 'a.txt'])).trim() === (id === 'D08-root' ? 'root value' : 'file value'))
      if (id === 'D06-move')
        this.check(`${id} both move destinations retain copy history`, (await repository.run(verified, ['log', '--xml', '-v', '-r', '2'])).match(/copyfrom-path=/g)?.length === 2)
      if (id === 'D10-case' || id === 'D10-case-dir') {
        const [before, after] = id === 'D10-case' ? ['a.txt', 'A.txt'] : ['old', 'Old']
        const listed = await repository.run(verified, ['list', '--xml'])
        this.check(`${id} repository preserves exact case and move history`, listed.includes(`<name>${after}</name>`) && !listed.includes(`<name>${before}</name>`)
          && (await repository.run(verified, ['log', '--xml', '-v', '-r', '2'])).includes(`copyfrom-path="/${before}"`))
      }
      this.check(`${id} control bytes and revision count are unchanged outside approval`, await readFile(join(verified, 'control.txt'), 'utf8') === 'unchanged\n'
        && (await repository.run(verified, ['log', '--xml', '-r', '1:HEAD'])).match(/<logentry/g)?.length === (id === 'D01-clean' ? 1 : 2))
      console.log(`  time ${id}: ${Date.now() - start} ms including independent checkout verification`)
    }
    console.log(`\nsmoke-svn-worktree matrix changes: ${this.passed} checks passed`)
  }

  private async checkRegressions(): Promise<void> {
    const repository = await SvnFixtureRepository.create(join(this.root, 'regression-repository'), this.svn)
    await repository.run(this.root, ['mkdir', '-m', 'layout', `${repository.url}/Project`])
    const owner = join(this.root, 'regression-owner')
    await repository.run(this.root, ['checkout', `${repository.url}/Project`, owner])
    await writeFile(join(owner, 'a.txt'), 'base\n')
    await writeFile(join(owner, 'pnpm-lock.yaml'), 'base lock\n')
    await repository.run(owner, ['add', 'a.txt', 'pnpm-lock.yaml'])
    await repository.run(owner, ['propset', 'svn:global-ignores', '.worktrees\n.checkpoints', '.'])
    await repository.run(owner, ['commit', '-m', 'fixture'])
    await repository.run(owner, ['update'])
    const manager = new SvnWorktreeManager(this.svn)
    const records = await SessionRecordsStore.load(join(this.root, 'regression-records.json'), { snapshotsDirectory: join(this.root, 'regression-snapshots') })
    const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, 'regression-logs'))
    const session = async (id: string): Promise<string> => {
      const made = await manager.create({ ownerDir: owner, folder: `001-${id.toLowerCase()}` })
      if (!made.ok) throw new Error(made.detail)
      const assembly = await manager.assembly(made.value.worktreePath)
      if (!assembly.ok) throw new Error(assembly.detail)
      await records.put({ sessionId: id, kind: 'agent', title: id, createdAt: Date.now(), life: 'ended', binding: null,
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: `fixture-${id}` }, directory: { mode: 'adHoc', path: owner },
        worktree: { worktreePath: made.value.worktreePath, branch: made.value.url, baseCommit: `r${made.value.baseRevision}`,
          repositoryRoot: owner, kind: 'svn', setupBaseline: { at: Date.now(), hashes: {}, inputs: SetupInputs.of(assembly.value.nodes).digest },
          agentStartedAt: Date.now(), ...made.value.directoryId === null ? {} : { directoryId: made.value.directoryId } } })
      return made.value.worktreePath
    }
    const foreign = async (text: string): Promise<void> => {
      await repository.run(owner, ['update'])
      await writeFile(join(owner, 'a.txt'), text)
      await repository.run(owner, ['commit', '-m', 'foreign', 'a.txt'])
    }

    const stale = await session('rg01')
    await writeFile(join(stale, 'a.txt'), 'session\n')
    await foreign('incoming\n')
    const conflicted = await actions.finish('rg01')
    await actions.flow.start('rg01', { choice: 'keep', requestedBy: 'window' })
    const again = await actions.finish('rg01')
    this.check('RG01 r486: out-of-date, conflicts, Keep, Finish again refuses publication',
      conflicted.action?.conflictSet?.entries.some((entry) => entry.path === 'a.txt' && entry.state !== 'settled') === true
      && again.action?.conflictSet?.entries.some((entry) => entry.path === 'a.txt' && entry.state !== 'settled') === true
      && actions.opened.length === 0 && existsSync(stale))

    const sidecar = await session('rg02')
    await writeFile(join(sidecar, 'orphan.r42'), 'orphaned incoming content\n')
    const orphan = await actions.finish('rg02', { select: (rows) => rows, message: '[Smoke] Review orphan' })
    const forbiddenSidecar = await manager.prepareCommit(sidecar, [join(sidecar, 'orphan.r42')])
    console.log(`  state RG02: ${JSON.stringify({ needs: orphan.action?.needs, answer: orphan.answer, gate: forbiddenSidecar.ok ? 'ok' : forbiddenSidecar.detail, opened: actions.opened.length })}`)
    this.check('RG02 an orphan SVN sidecar cannot be published even when selected',
      !forbiddenSidecar.ok && forbiddenSidecar.detail.includes('svn conflict file')
      && orphan.action?.needs?.reason.includes('svn conflict file') === true && actions.opened.length === 0
      && await readFile(join(sidecar, 'orphan.r42'), 'utf8') === 'orphaned incoming content\n')

    const markers = await session('rg03')
    await writeFile(join(markers, 'a.txt'), 'mine after incoming\n')
    await foreign('new incoming\n')
    await repository.run(markers, ['update', '--accept', 'postpone'])
    await repository.run(markers, ['resolve', '--accept', 'working', 'a.txt'])
    const marked = await actions.finish('rg03')
    this.check('RG03 markers left after resolve --accept working refuse publication',
      marked.action?.needs?.reason.includes('conflict markers') === true && actions.opened.length === 0)

    const setup = await session('rg04')
    await writeFile(join(setup, 'pnpm-lock.yaml'), 'setup lock\n')
    const hashes = await manager.commitHashes(setup, ['pnpm-lock.yaml'])
    if (!hashes.ok) throw new Error(hashes.detail)
    const setupAssembly = await manager.assembly(setup)
    if (!setupAssembly.ok) throw new Error(setupAssembly.detail)
    await records.update('rg04', (record) => ({ ...record, worktree: { ...record.worktree!, setupBaseline: { at: Date.now(), hashes: hashes.value,
      inputs: SetupInputs.of(setupAssembly.value.nodes).digest } } }))
    await writeFile(join(setup, 'a.txt'), 'worker change\n')
    const finished = await actions.finish('rg04')
    this.check('RG04 setup lockfile is part of the prepared and published whole assembly',
      finished.outcome?.result === 'committed' && !existsSync(setup)
      && await repository.run(owner, ['cat', `${repository.url}/Project/pnpm-lock.yaml`]) === 'setup lock\n')

    const placed = await this.provisionerOf(manager).place({ directory: owner, projectRoot: owner })
    if (!placed.ok) throw new Error(placed.detail)
    await SvnSmokeIsolation.owner(this.root, placed.value.ownerDir)
    const reserved = await this.provisionerOf(manager).create({ placement: placed.value, folder: '005-rg05' })
    if (!reserved.ok || reserved.value.checkout === null) throw new Error('RG05 did not reserve a checkout')
    const failed = await this.svn.run(reserved.value.checkout.cwd, ['checkout', `${repository.url}/missing`, '.'])
    await records.put({ sessionId: 'rg05', kind: 'agent', title: 'rg05', createdAt: Date.now(), life: 'ended', binding: null,
      agent: { agentId: 'claude', launchMode: 'new' }, directory: { mode: 'adHoc', path: owner }, worktree: reserved.value.worktree,
      endedReason: 'checkout failed' })
    const refused = await actions.flow.start('rg05', { choice: 'commit', requestedBy: 'window' })
    await actions.discard('rg05')
    this.check('RG05 063: failed checkout refuses Commit and Discard records never-started',
      failed.code !== 0 && !refused.ok && refused.code === 'never-started'
      && actions.results.list({ sessionId: 'rg05' })[0]?.result === 'never-started')

    const ignored = await session('rg06')
    await mkdir(join(ignored, '.checkpoints/store.git'), { recursive: true })
    await writeFile(join(ignored, '.checkpoints/store.git/HEAD'), 'checkpoint evidence\n')
    const clean = await actions.finish('rg06')
    const ignoredResult = actions.results.list({ sessionId: 'rg06' })[0]
    const result = dirname(actions.results.savedDirectoryOf(ignoredResult.actionId))
    this.check('RG06 a clean Finish removes ignored checkpoints with the worktree and saves no copy of them',
      clean.outcome?.result === 'nothing' && !existsSync(ignored) && !existsSync(join(result, 'ignored')))

    const chat = await session('rg07')
    await writeFile(join(chat, 'a.txt'), 'reviewed message\n')
    const message = 'Summary: **changed the file**'
    const unchecked = await actions.finish('rg07', { message, messageSource: 'agent-proposal' })
    const approved = await actions.finish('rg07', { message, messageSource: 'agent-proposal', acknowledgedFindings: SvnCommitMessageCheck.findings(message, 'agent-proposal') })
    this.check('RG07 a proposed chat-shaped message requires acknowledgement of the current text',
      !unchecked.answer.ok && unchecked.answer.code === 'message-unchecked' && approved.outcome?.result === 'committed'
      && actions.results.list({ sessionId: 'rg07' })[0]?.acknowledgedFindings?.includes('chat-opening') === true)
  }

  /**
   * Whether Node's UTF-16 command line reaches svn.exe intact. It does not: svn 1.14 reads its
   * arguments in the ANSI code page, so a character outside it arrives best-fit mapped (`ř` as `r`)
   * and names another file, silently. What stays intact is the working directory, a walk of the tree
   * and every XML answer, so those are the checks; the argument itself is only reported, because
   * which names survive depends on the code page of the machine.
   */
  private async checkNonAsciiSpike(): Promise<void> {
    const repository = await SvnFixtureRepository.create(join(this.root, 'spike-repository'), this.svn)
    const a = join(this.root, 'spike-a')
    const b = join(this.root, 'spike-b')
    await repository.run(this.root, ['checkout', repository.url, a])
    await writeFile(join(a, 'ř.txt'), 'one\n')
    await writeFile(join(a, 'r.txt'), 'ascii twin\n')
    await mkdir(join(a, 'složka'))
    await writeFile(join(a, 'složka', 'soubor ž.txt'), 'one\n')
    await writeFile(join(a, 'složka', 'plain.txt'), 'one\n')
    await repository.run(a, ['add', '--force', '--', '.'])
    const added = SvnWorktreeEvidence.statusRows(await repository.run(a, ['status', '--xml', '--', '.']), a)
    this.check('spike: a walk adds non-ASCII files and directories, and status XML returns their names intact',
      ['ř.txt', 'složka', 'složka/soubor ž.txt'].every((path) => added.some((row) => row.kind === 'item' && row.path === path)))
    await repository.run(a, ['commit', '-m', 'spike add', '--', '.'])
    await repository.run(this.root, ['checkout', repository.url, b])
    this.check('spike: a checkout writes the non-ASCII names to disk',
      (await readdir(b)).includes('ř.txt') && (await readdir(join(b, 'složka'))).includes('soubor ž.txt'))

    await writeFile(join(a, 'ř.txt'), 'two\n')
    await writeFile(join(a, 'složka', 'soubor ž.txt'), 'two\n')
    await writeFile(join(a, 'složka', 'plain.txt'), 'two\n')
    await repository.run(a, ['commit', '-m', 'spike edit', '--', '.'])
    const nested = join(b, 'složka')
    await repository.run(nested, ['update', '--depth', 'empty', '--accept', 'postpone', '--', 'plain.txt@'])
    this.check('spike: an ASCII target below a non-ASCII working directory updates', await readFile(join(nested, 'plain.txt'), 'utf8') === 'two\n')
    const walked = await repository.run(b, ['update', '--accept', 'postpone', '--', '.'])
    this.check('spike: an update of the whole tree updates the non-ASCII files',
      await readFile(join(b, 'ř.txt'), 'utf8') === 'two\n' && await readFile(join(nested, 'soubor ž.txt'), 'utf8') === 'two\n')
    console.log(`  info: plain-text update output keeps ř: ${walked.includes('ř.txt')}, keeps ž: ${walked.includes('soubor ž.txt')}`)

    const asked = await this.svn.run(b, ['info', '--xml', '--non-interactive', '--', 'ř.txt@'])
    const answered = asked.code === 0 ? SvnWorktreeEvidence.infoEntries(asked.stdout).map((entry) => entry.path) : []
    const intact = answered.length === 1 && answered[0] === 'ř.txt'
    console.log(`  info: svn.exe received the argument ř.txt ${intact ? 'intact' : `as ${JSON.stringify(answered[0] ?? asked.stderr.trim())}`}`)
    this.check('spike: a name svn.exe may not receive intact is refused before it is passed',
      !SvnWorktreeEvidence.takesArgument('ř.txt') && !SvnWorktreeEvidence.takesArgument('složka/soubor ž.txt')
      && SvnWorktreeEvidence.takesArgument('src/a b@.txt'))

    await repository.run(nested, ['delete', '--force', '--', 'plain.txt@'])
    await rm(join(b, 'ř.txt'))
    const rows = SvnWorktreeEvidence.statusRows(await repository.run(b, ['status', '--xml', '--', '.']), b)
    this.check('spike: a non-ASCII file deleted from disk reads as missing under its own name, beside a scheduled delete',
      rows.some((row) => row.kind === 'missing' && row.path === 'ř.txt')
      && rows.some((row) => row.kind === 'item' && row.path === 'složka/plain.txt'))
  }

  /**
   * One owner with an external mount and two worktrees in its ignored `.worktrees`: the first takes
   * foreign commits into local changes (every update column, every status kind), the second commits
   * from itself and then takes a foreign revision by a single-path update.
   */
  private async checkFinishEvidence(): Promise<Capture[]> {
    const repository = await SvnFixtureRepository.create(join(this.root, 'repository'), this.svn)
    const url = repository.url
    await repository.run(this.root, ['mkdir', '--parents', '-m', 'layout', `${url}/Project/src`, `${url}/Lib`])
    const lib = join(this.root, 'lib')
    await repository.run(this.root, ['checkout', `${url}/Lib`, lib])
    await writeFile(join(lib, 'l.txt'), 'lib\n')
    await repository.run(lib, ['add', '--', 'l.txt'])
    await repository.run(lib, ['commit', '-m', 'lib'])

    const main = join(this.root, 'main')
    await repository.run(this.root, ['checkout', `${url}/Project`, main])
    const files: Record<string, string> = {
      'src/a.txt': 'one\ntwo\nthree\nfour\nfive\n', 'src/b.txt': 'b\n', 'src/c.txt': 'c\n', 'keep.txt': 'keep\n',
      'gone.txt': 'gone\n', 'props.txt': 'props\n', 'tree.txt': 'tree\n', 'conflict.txt': 'base\n', 'missing.txt': 'missing\n',
      '.aidocs/note.md': 'note\n',
    }
    await mkdir(join(main, '.aidocs'))
    for (const [path, text] of Object.entries(files)) await writeFile(join(main, ...path.split('/')), text)
    await repository.run(main, ['add', '--force', '--', '.'])
    await repository.run(main, ['propset', 'svn:global-ignores', '.worktrees', '--', '.'])
    await repository.run(main, ['propset', 'svn:externals', '^/Lib mount', '--', '.'])
    await repository.run(main, ['commit', '-m', 'project'])
    await repository.run(main, ['update'])

    await mkdir(join(main, '.worktrees'))
    const ignored = await repository.run(main, ['status', '--no-ignore', '--depth', 'immediates', '--', '.worktrees'])
    this.check('The fixture root ignores .worktrees through its own svn:global-ignores', ignored.trimStart().startsWith('I'))
    const worktree = join(main, '.worktrees', '001-fixture')
    await repository.run(main, ['checkout', `${url}/Project@HEAD`, worktree])

    await writeFile(join(main, 'src', 'b.txt'), 'b theirs\n')
    await writeFile(join(main, 'src', 'new.txt'), 'new\n')
    await writeFile(join(main, 'conflict.txt'), 'theirs\n')
    await writeFile(join(main, 'src', 'a.txt'), 'one\ntwo\nthree\nfour\nfive theirs\n')
    await writeFile(join(main, '.aidocs', 'note.md'), 'note theirs\n')
    await repository.run(main, ['add', '--', 'src/new.txt'])
    await repository.run(main, ['delete', '--', 'gone.txt', 'tree.txt'])
    await repository.run(main, ['propset', 'p', 'theirs', '--', 'props.txt'])
    await repository.run(main, ['propset', 'q', 'value', '--', 'keep.txt'])
    await repository.run(main, ['propset', 'y', 'theirs', '--', 'src'])
    await repository.run(main, ['commit', '-m', 'foreign changes', '--', '.'])
    await writeFile(join(lib, 'l.txt'), 'lib theirs\n')
    await repository.run(lib, ['commit', '-m', 'lib theirs'])

    await writeFile(join(worktree, 'src', 'a.txt'), 'one mine\ntwo\nthree\nfour\nfive\n')
    await writeFile(join(worktree, 'conflict.txt'), 'mine\n')
    await writeFile(join(worktree, 'tree.txt'), 'tree mine\n')
    await writeFile(join(worktree, 'src', 'added.txt'), 'added\n')
    await writeFile(join(worktree, 'src', 'loose.txt'), 'loose\n')
    await writeFile(join(worktree, 'src', 'přehled.md'), 'unversioned\n')
    await repository.run(worktree, ['add', '--', 'src/added.txt'])
    await repository.run(worktree, ['delete', '--', 'src/c.txt'])
    await repository.run(worktree, ['propset', 'p', 'mine', '--', 'props.txt'])
    await repository.run(worktree, ['propset', 'y', 'theirs', '--', 'src'])
    await rm(join(worktree, 'missing.txt'))

    const before = await repository.run(worktree, ['status', '--xml', '--', `${worktree}@`])
    const beforeRows = SvnWorktreeEvidence.statusRows(before, worktree)
    this.check('Status rows read every change kind and keep a non-ASCII name',
      (['item', 'props', 'missing', 'external'] as const).every((kind) => beforeRows.some((row) => row.kind === kind))
      && beforeRows.some((row) => row.path === 'src/přehled.md' && row.kind === 'item'))
    await repository.run(worktree, ['update', '--accept', 'postpone', '--', `${worktree}@`])
    const after = await repository.run(worktree, ['status', '--xml', '--', `${worktree}@`])
    const afterRows = SvnWorktreeEvidence.statusRows(after, worktree)
    this.check('Status rows flag text, property and tree conflicts',
      ['conflict.txt', 'props.txt', 'tree.txt'].every((path) => afterRows.some((row) => row.path === path && row.conflict)))
    const conflicts = SvnWorktreeEvidence.conflicts(after, worktree)
    this.check('Conflicts tell a text conflict, which a resolver may settle, from a tree or property conflict',
      conflicts.some((row) => row.path === 'conflict.txt' && row.text && !row.other)
      && ['props.txt', 'tree.txt'].every((path) => conflicts.some((row) => row.path === path && row.other)))

    const recover = join(main, '.worktrees', '002-recover')
    await repository.run(main, ['checkout', `${url}/Project@HEAD`, recover])
    await writeFile(join(recover, 'src', 'a.txt'), 'one\ntwo\nthree\nfour\nfive here\n')
    await repository.run(recover, ['commit', '-m', 'commit from the worktree', '--', `${join(recover, 'src', 'a.txt')}@`])
    const committed = await repository.run(recover, ['status', '-v', '--xml', '--ignore-externals', '--', `${recover}@`])
    const committedLog = await repository.run(recover, ['log', '-v', '--xml', '-r', '6:6', url])
    await writeFile(join(main, 'src', 'b.txt'), 'b foreign\n')
    await writeFile(join(main, 'keep.txt'), 'keep foreign\n')
    await repository.run(main, ['commit', '-m', 'foreign revision', '--', 'src/b.txt', 'keep.txt'])
    await repository.run(recover, ['update', '--', `${join(recover, 'src', 'b.txt')}@`])
    const foreign = await repository.run(recover, ['status', '-v', '--xml', '--ignore-externals', '--', `${recover}@`])
    const foreignLog = await repository.run(recover, ['log', '-v', '--xml', '-r', '7:7', url])
    const mainInfo = await repository.run(main, ['info', '--xml', '--depth', 'infinity', '--', `${main}@`])
    const worktreeInfo = await repository.run(recover, ['info', '--xml', '--', `${recover}@`])
    const repositoryInfo = await repository.run(recover, ['info', '--xml', url])
    const rangeLog = await repository.run(recover, ['log', '-v', '--xml', '-r', '4:7', url])

    const { base } = SvnWorktreeEvidence.infoEntries(worktreeInfo)[0]
    const revisionLog = async (revision: number) => SvnWorktreeEvidence.loggedRows(
      await repository.run(recover, ['log', '-v', '--xml', '-r', `${revision}:${revision}`, url]), base, '')
    const items = SvnWorktreeEvidence.statusVerboseRows(foreign, recover)
    const own = await SvnWorktreeEvidence.ownCommitRows({ items, revisionLog })
    this.check('The own commits of a worktree name r6 and skip the foreign r7 taken by a single-path update',
      JSON.stringify(own) === JSON.stringify([{ revision: 6, action: 'M', path: 'src/a.txt' }]))
    const incoming = SvnWorktreeEvidence.incoming(['src/a.txt'], SvnWorktreeEvidence.loggedRows(rangeLog, base, '').filter((row) => row.revision !== 6), 'whole')
    this.check('The incoming check skips .aidocs and the worktree\'s own commits, and counts the other logged paths',
      incoming.length > 0 && !incoming.some((path) => path.startsWith('.aidocs/')) && incoming.includes('src/b.txt'))
    const proven = await SvnWorktreeEvidence.provenRows({
      items: SvnWorktreeEvidence.statusVerboseRows(committed, recover), own: '', rootBase: 5, since: 5,
      claimed: ['src/a.txt'], history: async () => [], revisionLog,
    })
    this.check('The BASE proof attributes r6 to the claimed path', JSON.stringify(proven) === JSON.stringify([{ revision: 6, action: 'M', path: 'src/a.txt' }]))

    const placeholders: [string, string][] = [[url, '{REPO}'], [worktree, '{ROOT}'], [recover, '{ROOT}'], [main, '{MAIN}']]
    return [
      { name: 'status-before-update.xml', text: before },
      { name: 'status-after-update.xml', text: after },
      { name: 'status-verbose-committed.xml', text: committed },
      { name: 'status-verbose-foreign.xml', text: foreign },
      { name: 'log-committed.xml', text: committedLog },
      { name: 'log-foreign.xml', text: foreignLog },
      { name: 'log-range.xml', text: rangeLog },
      { name: 'info-main.xml', text: mainInfo },
      { name: 'info-worktree.xml', text: worktreeInfo },
      { name: 'info-repository.xml', text: repositoryInfo },
    ].map(({ name, text }) => ({ name, text: this.anonymized(text, placeholders) }))
  }

  /**
   * Finish Commit end to end on a disposable owner: the review port stands in for the person and
   * commits the scope with svn itself, or closes the review without a commit.
   */
  private async checkFinishFlow(): Promise<void> {
    const repository = await SvnFixtureRepository.create(join(this.root, 'finish-repository'), this.svn)
    await repository.run(this.root, ['mkdir', '--parents', '-m', 'layout', `${repository.url}/Project`])
    const owner = join(this.root, 'finish-owner')
    await repository.run(this.root, ['checkout', `${repository.url}/Project`, owner])
    await writeFile(join(owner, 'a.txt'), 'one\n')
    await repository.run(owner, ['add', '--', 'a.txt'])
    await repository.run(owner, ['propset', 'svn:global-ignores', '.worktrees', '--', '.'])
    await repository.run(owner, ['commit', '-m', 'project'])
    await repository.run(owner, ['update'])

    const manager = new SvnWorktreeManager(this.svn)
    const records = await SessionRecordsStore.load(join(this.root, 'finish-records', 'session-records.json'),
      { snapshotsDirectory: join(this.root, 'finish-records', 'snapshots'), report: (message) => { throw new Error(message) } })
    const sessionOf = async (sessionId: string, folder: string): Promise<string> => {
      const checkout = await manager.create({ ownerDir: owner, folder: /^\d/.test(folder) ? folder : `001-${folder}` })
      if (!checkout.ok) throw new Error(checkout.detail)
      const record: SessionRecord = {
        sessionId, kind: 'shell', title: `014 - ${folder}`, createdAt: 0, life: 'ended', binding: null,
        directory: { mode: 'adHoc', path: owner },
        worktree: {
          worktreePath: checkout.value.worktreePath, branch: checkout.value.url, baseCommit: `r${checkout.value.baseRevision}`,
          repositoryRoot: owner, kind: 'svn', agentStartedAt: 1, ...checkout.value.directoryId === null ? {} : { directoryId: checkout.value.directoryId },
        },
      }
      await records.put(record)
      return checkout.value.worktreePath
    }
    const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, 'flow-script-logs'))

    const committed = await sessionOf('commit-session', 'commit')
    await writeFile(join(committed, 'a.txt'), 'one\ncommitted\n')
    const commit = await actions.finish('commit-session')
    // The commit itself never writes the main copy; the UPDATE the Finish starts after it does (Finish 072).
    this.check('Finish Commit commits from the worktree, labels the receipt, removes the worktree, then updates the main copy by itself',
      commit.answer.ok && commit.outcome?.result === 'committed' && commit.outcome.worktree === 'removed'
      && commit.outcome.labelled?.length === 1 && commit.outcome.labelled[0]?.label === 'receipt'
      && await readFile(join(owner, 'a.txt'), 'utf8') === 'one\ncommitted\n' && !existsSync(committed)
      && records.get('commit-session')?.retiredWorktree?.revisions.length === 1)
    this.check('A committed Finish with the worktree removed keeps the session as a landed row', actions.landed('commit-session', owner))
    const ended = SessionWorkflows.of(records.get('commit-session')!, () => null)
    this.check('F2 sync-first Finish records local command evidence, and its main-copy UPDATE ran with no press',
      records.get('commit-session')?.worktreeLifecycle?.journal.some((entry) => entry.kind === 'commit' && entry.outcome === 'ok') === true
      && ended?.badge === 'Changes published' && records.get('commit-session')?.svnAction === undefined
      && actions.results.list({ sessionId: 'commit-session' }).some((row) => row.main?.revision !== undefined)
      && records.get('commit-session')?.worktreeLifecycle?.journal.some((entry) => entry.kind === 'commit' && entry.output?.includes('Committed revision')) === true)
    const result = actions.results.list({ sessionId: 'commit-session' })
    this.check('R9 a committed Finish writes a durable result with its receipt-labelled revision and the removal done',
      result.length === 1 && result[0].action === 'finish' && result[0].result === 'committed' && result[0].removal === 'removed'
      && result[0].revisions.length === 1 && result[0].revisions[0].label === 'receipt' && result[0].mainCopy === owner)

    // A1: the person committed from the session's own split before Finish; the commit dialog left its receipt.
    const split = await sessionOf('split-session', 'split')
    await writeFile(join(split, 'split.txt'), 'from the split\n')
    await repository.run(split, ['add', '--', 'split.txt'])
    const splitCommit = /Committed revision (\d+)/.exec(await repository.run(split, ['commit', '-m', 'from the split', '--', '.']))?.[1]
    const splitRecord = records.get('split-session')
    if (splitCommit === undefined || splitRecord === null) throw new Error('the split commit left no revision or no record')
    await records.put({ ...splitRecord, commitReceipts: [{ scopeRoot: split, revision: Number(splitCommit), paths: ['split.txt'], at: Date.now() }] })
    const reviewsBeforeSplit = actions.opened.length
    await actions.flow.foreignCommit('split-session', records.get('split-session')!.commitReceipts!)
    await actions.settled()
    const splitFinish = { answer: { ok: true }, outcome: records.get('split-session')?.worktreeOutcome }
    this.check('A1 a retained foreign receipt enters verification: no new publication, the receipt labels the result, the worktree goes and the row stays landed',
      splitFinish.answer.ok && splitFinish.outcome?.result === 'committed' && splitFinish.outcome.worktree === 'removed'
      && actions.opened.length === reviewsBeforeSplit && !existsSync(split) && actions.landed('split-session', owner)
      && JSON.stringify(splitFinish.outcome.labelled?.map((entry) => `${entry.label} r${entry.revision}`)) === JSON.stringify([`receipt r${splitCommit}`]))

    const cancelled = await sessionOf('cancel-session', 'cancel')
    await writeFile(join(cancelled, 'b.txt'), 'new\n')
    actions.decision.of = () => 'cancel'
    const kept = await actions.finish('cancel-session')
    actions.decision.of = () => 'commit'
    this.check('Changes without commit approval waits for the person and keeps the worktree, its change and the session',
      kept.action?.stage === 'changes' && existsSync(join(cancelled, 'b.txt')) && !actions.ended.has('cancel-session'))
    this.check('Discard removes the kept worktree by identity, leaves a tombstone and ends the session',
      (await actions.discard('cancel-session')).ok && !existsSync(cancelled)
      && records.get('cancel-session')?.retiredWorktree?.worktreePath === cancelled && actions.ended.has('cancel-session'))
    this.check('R9 the Discard writes a discarded result for the session it removed',
      actions.results.list({ sessionId: 'cancel-session' }).map((entry) => `${entry.action} ${entry.result} ${entry.removal}`).join()
        === 'discard discarded removed')
    await records.settled()
  }

  /**
   * A committed Finish leaves a landed row until its main copy holds what it committed, whoever
   * updates the main copy. UPDATE is the one action that updates a main copy: `svn update` as a run
   * of the session that asks for it, the resolver for a text conflict, and a visible `svn diff` of
   * what it resolved. No `svn cleanup` ever runs in a main copy.
   */
  private async checkLandedRows(): Promise<void> {
    const repository = await SvnFixtureRepository.create(join(this.root, 'landed-repository'), this.svn)
    await repository.run(this.root, ['mkdir', '--parents', '-m', 'layout', `${repository.url}/Project`])
    const owner = join(this.root, 'landed-owner')
    const other = join(this.root, 'landed-other')
    await repository.run(this.root, ['checkout', `${repository.url}/Project`, owner])
    await writeFile(join(owner, 'a.txt'), 'one\ntwo\nthree\n')
    await repository.run(owner, ['add', '--', 'a.txt'])
    await repository.run(owner, ['propset', 'svn:global-ignores', '.worktrees', '--', '.'])
    await repository.run(owner, ['commit', '-m', 'project'])
    await repository.run(owner, ['update'])
    await repository.run(this.root, ['checkout', `${repository.url}/Project`, other])

    const manager = new SvnWorktreeManager(this.svn)
    const landedRows = new LandedRows({ svn: manager, now: () => Date.now() })
    const records = await SessionRecordsStore.load(join(this.root, 'landed-records', 'session-records.json'),
      { snapshotsDirectory: join(this.root, 'landed-records', 'snapshots'), report: (message) => { throw new Error(message) } })
    const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, 'landed-script-logs'))
    const landedSession = async (sessionId: string, folder: string, text: string): Promise<readonly SvnLabelledRevision[]> => {
      const checkout = await manager.create({ ownerDir: owner, folder })
      if (!checkout.ok) throw new Error(checkout.detail)
      await records.put({
        sessionId, kind: 'shell', title: `014 - ${folder}`, createdAt: 0, life: 'ended', binding: null,
        directory: { mode: 'adHoc', path: owner },
        worktree: {
          worktreePath: checkout.value.worktreePath, branch: checkout.value.url, baseCommit: `r${checkout.value.baseRevision}`,
          repositoryRoot: owner, kind: 'svn', agentStartedAt: 1, ...checkout.value.directoryId === null ? {} : { directoryId: checkout.value.directoryId },
        },
      })
      await writeFile(join(checkout.value.worktreePath, 'a.txt'), text)
      await actions.finish(sessionId)
      const record = records.get(sessionId)
      return (record === null ? null : LandedRows.landingOf(record))?.landed ?? []
    }
    const foreign = async (name: string): Promise<void> => {
      await repository.run(other, ['update'])
      await writeFile(join(other, name), `${name}\n`)
      await repository.run(other, ['add', '--', name])
      await repository.run(other, ['commit', '-m', 'foreign', '--', '.'])
    }

    const first = await landedSession('landed-session', '014-landed', 'one\ntwo\nthree\nfour\n')
    const firstRecord = records.get('landed-session')
    this.check('L1 a committed Finish keeps the session as a landed row: not completed, no worktree, its main copy and the newest revision',
      actions.landed('landed-session', owner) && first.length === 1 && firstRecord?.worktreeOutcome?.result === 'committed')
    // Finish 072: the Finish updates its main copy by itself, with no press and no list of live sessions.
    this.check('L1 the main copy holds the landed revision after the Finish, with no press',
      await landedRows.holds(owner, first) === true && await readFile(join(owner, 'a.txt'), 'utf8') === 'one\ntwo\nthree\nfour\n'
      && firstRecord?.svnAction === undefined)

    await foreign('b.txt')
    await foreign('c.txt')
    await landedRows.refreshBehind(owner)
    this.check('L2 two newer revisions on the server read as 2 behind', landedRows.infoOf(owner, first).behind === 2)
    const offlineRepository = await SvnFixtureRepository.create(join(this.root, 'offline-repository'), this.svn)
    const offline = join(this.root, 'offline-copy')
    await offlineRepository.run(this.root, ['checkout', offlineRepository.url, offline])
    await rename(offlineRepository.directory, `${offlineRepository.directory}-gone`)
    await landedRows.refreshBehind(offline)
    this.check('L2 a main copy whose server cannot be reached reads as behind unknown', landedRows.infoOf(offline, first).behind === null)

    // The person updates the whole main copy in TortoiseSVN, or any other client: the row may go.
    await repository.run(owner, ['update'])
    this.check('L3 an update from another client brings the landed revision in', await landedRows.holds(owner, first) === true)

    // UPDATE meets a text conflict with a local change in the main copy. The UPDATE the Finish starts
    // starts no resolver; the press does.
    await writeFile(join(owner, 'a.txt'), 'one\ntwo main\nthree\nfour\n')
    const second = await landedSession('update-session', '015-update', 'one\ntwo worktree\nthree\nfour\n')
    this.check('L4 the UPDATE a Finish starts waits on its text conflict for Resolve with agent and starts no resolver',
      records.get('update-session')?.svnAction?.needs?.kind === 'conflict' && actions.prompts.length === 0)
    const merged = 'one\ntwo main and worktree\nthree\nfour\n'
    const resolvedIn: string[] = []
    actions.resolve = async (cwd) => {
      resolvedIn.push(cwd)
      const before = await readFile(join(cwd, 'a.txt'), 'utf8')
      if (!before.includes('<<<<<<< .mine')) throw new Error(`the resolver found no conflict in ${cwd}`)
      await writeFile(join(cwd, 'a.txt'), merged)
    }
    const landedBefore = actions.landedDue.length
    const started = await actions.flow.startUpdate('update-session', owner, 'cli')
    await actions.settled()
    actions.resolve = null
    const diffRun = records.get('update-session')?.worktreeLifecycle?.journal.find((run) => run.kind === 'diff')
    const conflicts = SvnWorktreeEvidence.conflicts(await repository.run(owner, ['status', '--xml', '--', '.']), owner)
    this.check('L4 UPDATE runs svn update in the main copy, the resolver there, and a visible svn diff of what it resolved',
      started.ok && records.get('update-session')?.svnAction === undefined && resolvedIn.length === 1 && resolvedIn[0] === owner
      && await readFile(join(owner, 'a.txt'), 'utf8') === merged && conflicts.length === 0
      && diffRun?.args?.join(' ') === 'diff --old .@BASE --new . -- a.txt' && diffRun.cwd === owner && diffRun.outcome === 'ok'
      && diffRun.output?.includes('+two main and worktree') === true
      && records.get('update-session')?.scriptRuns?.some((run) => run.runId === diffRun.runId && run.log.state === 'saved') === true)
    this.check('L4 the recording of an UPDATE reads the landed rows of its main copy at once, and the main copy holds them',
      actions.landedDue.length === landedBefore + 1 && actions.landedDue.at(-1) === owner && await landedRows.holds(owner, second) === true)
    this.check('L4 an UPDATE writes no worktree result', actions.results.list({ sessionId: 'update-session' }).every((entry) => entry.action === 'finish'))
    await repository.run(owner, ['revert', '--', 'a.txt'])

    const third = await landedSession('coordinated-session', '016-coordinated', 'one\ntwo worktree\nthree\nfour\nfive\n')
    await records.put({ sessionId: 'coordinator', kind: 'shell', title: '020 - coordinator', createdAt: 0, life: 'ended', binding: null,
      directory: { mode: 'adHoc', path: owner } })
    const coordinated = await actions.flow.startUpdate('coordinator', owner, 'cli')
    await actions.settled()
    this.check('L5 UPDATE of a coordinator runs locally with a journal, and the landed rows of that main copy then hold',
      coordinated.ok && records.get('coordinator')?.worktreeLifecycle?.journal.some((run) => run.kind === 'update' && run.outcome === 'ok') === true
      && records.get('coordinator')?.svnAction === undefined && await landedRows.holds(owner, third) === true)

    // UPDATE meets a working-copy lock another svn client holds in the main copy: the Finish's own UPDATE.
    await SmokeSvnWorktree.workingCopyLock(owner, true)
    const fourth = await landedSession('locked-session', '017-locked', 'one\ntwo worktree\nthree\nfour\nfive\nsix\n')
    const relaunched = await actions.relaunches('locked-session')
    const lockedUpdates = records.get('locked-session')?.worktreeLifecycle?.journal.filter((run) => run.kind === 'update' && run.cwd === owner) ?? []
    this.check('L7 UPDATE of a locked main copy stops after two equal failures, then waits for the person as locked',
      relaunched === 1 && lockedUpdates.length === 2 && records.get('locked-session')?.svnAction?.needs?.kind === 'locked'
      && records.get('locked-session')?.worktreeLifecycle?.stoppedFailure?.startsWith('Stopped after two identical failures:') === true
      && await landedRows.holds(owner, fourth) === false)
    await SmokeSvnWorktree.workingCopyLock(owner, false)
    const unlocked = await actions.flow.startUpdate('locked-session', owner, 'cli')
    await actions.settled()
    this.check('L7 once the other client let go, UPDATE again updates the main copy and its landed row holds',
      unlocked.ok && records.get('locked-session')?.svnAction === undefined && await landedRows.holds(owner, fourth) === true)
    this.check('L6 no svn cleanup ever ran in a main copy',
      records.list().every((record) => record.worktreeLifecycle?.journal.every((run) => run.kind !== 'cleanup') !== false))
    await records.settled()
  }

  /**
   * The stops of Finish 072 (r813), on a repository named like ours (`applications`) holding project
   * `Jamat`, with a session live in the main copy the whole time. I1: another session's LF saves of
   * CRLF files plus an incoming change land with no wait and no resolver. I2: two blocks added at one
   * place wait for Resolve with agent, and a press after a resolver that left the conflict runs it
   * again. I3: the review expects [Jamat], so an agent message with it publishes. I4: a changed
   * dependency input runs the agreed install by itself. I5: without an install, the wait names only the
   * input that changed. I6: each UPDATE starts after its Finish with no press and no list of sessions.
   */
  private async checkIncident072(): Promise<void> {
    const base = join(this.root, 'incident-072')
    await mkdir(base, { recursive: true })
    const repository = await SvnFixtureRepository.create(join(base, 'applications'), this.svn)
    await repository.run(base, ['mkdir', '--parents', '-m', 'layout', `${repository.url}/ProductivityTools/Jamat`])
    const owner = join(base, 'Jamat')
    await repository.run(base, ['checkout', `${repository.url}/ProductivityTools/Jamat`, owner])
    const crlf = (lines: readonly string[]) => `${lines.join('\r\n')}\r\n`
    const lib = ['export const one = 1', 'export const two = 2', 'export const three = 3', 'export const four = 4', 'export const five = 5', 'export const six = 6']
    const ui = (blocks: readonly string[]) => ['run()', 'if (ready) {', '  start()', '}', ...blocks, 'return', ''].join('\n')
    const usage = ['if (usage) {', '  showUsage()', '}'], extensions = ['if (extensions) {', '  loadExtensions()', '}']
    await writeFile(join(owner, 'lib.ts'), crlf(lib))
    await writeFile(join(owner, 'ui.ts'), ui([]))
    await writeFile(join(owner, 'package.json'), '{ "version": "1.0.0" }\n')
    await writeFile(join(owner, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    await repository.run(owner, ['add', '--', 'lib.ts', 'ui.ts', 'package.json', 'pnpm-lock.yaml'])
    await repository.run(owner, ['propset', 'svn:global-ignores', '.worktrees', '--', '.'])
    await repository.run(owner, ['commit', '-m', 'project'])
    await repository.run(owner, ['update'])

    const manager = new SvnWorktreeManager(this.svn)
    const records = await SessionRecordsStore.load(join(base, 'records', 'session-records.json'),
      { snapshotsDirectory: join(base, 'records', 'snapshots'), report: (message) => { throw new Error(message) } })
    const actions = new SmokeSvnActions(records, manager, this.svn, join(base, 'logs'))
    await records.put({ sessionId: 'main-session', kind: 'shell', title: '049 - main copy', createdAt: 0, life: 'live', binding: null, directory: { mode: 'adHoc', path: owner } })
    const session = async (sessionId: string): Promise<string> => {
      const checkout = await manager.create({ ownerDir: owner, folder: sessionId })
      if (!checkout.ok) throw new Error(checkout.detail)
      await records.put({ sessionId, kind: 'shell', title: sessionId, createdAt: 0, life: 'ended', binding: null, directory: { mode: 'adHoc', path: owner },
        worktree: { worktreePath: checkout.value.worktreePath, branch: checkout.value.url, baseCommit: `r${checkout.value.baseRevision}`,
          repositoryRoot: owner, kind: 'svn', agentStartedAt: 1, ...checkout.value.directoryId === null ? {} : { directoryId: checkout.value.directoryId } } })
      return checkout.value.worktreePath
    }
    const baseline = async (sessionId: string, tree: string): Promise<void> => {
      const assembly = await manager.assembly(tree)
      if (!assembly.ok) throw new Error(assembly.detail)
      const inputs = SetupInputs.of(assembly.value.nodes)
      await records.update(sessionId, (record) => ({ ...record, worktree: { ...record.worktree!, setupBaseline: { at: 1, hashes: {}, inputs: inputs.digest, inputHashes: inputs.hashes } } }))
    }
    const head = async (): Promise<string> => repository.run(owner, ['log', '-l', '1', '--', repository.url])
    const conflicted = async (): Promise<number> => SvnWorktreeEvidence.conflicts(await repository.run(owner, ['status', '--xml', '--', '.']), owner).length
    const updated = (sessionId: string): boolean => records.get(sessionId)?.svnAction === undefined
      && actions.results.list({ sessionId }).some((row) => row.main?.revision !== undefined)

    // I1, I3, I6
    const first = await session('072-incident')
    await baseline('072-incident', first)
    await writeFile(join(first, 'lib.ts'), crlf(lib.map((line, index) => index === 5 ? 'export const six = 66' : line)))
    await writeFile(join(owner, 'lib.ts'), `${lib.map((line, index) => index === 1 ? 'export const two = 22' : line).join('\n')}\n`)
    const landed = await actions.finish('072-incident', { message: '[Jamat] Raise six', messageSource: 'agent-proposal' })
    this.check('I3 a project inside repository applications expects [Jamat], and an agent message with that prefix publishes without an edit',
      landed.outcome?.result === 'committed' && records.get('072-incident')?.worktreeLifecycle?.review?.repositories?.[0]?.expectedPrefix === '[Jamat]'
      && (await head()).includes('[Jamat] Raise six'))
    this.check('I6 the main copy updates after the Finish by itself, with a session live in it and no press or confirmation',
      updated('072-incident') && records.get('main-session')?.life === 'live')
    this.check('I1 LF saves of CRLF files beside an incoming change land with no wait and no resolver, both edits kept in CRLF',
      await readFile(join(owner, 'lib.ts'), 'utf8') === crlf(lib.map((line, index) => index === 1 ? 'export const two = 22' : index === 5 ? 'export const six = 66' : line))
      && await conflicted() === 0 && actions.prompts.length === 0)

    // I2
    const second = await session('073-blocks')
    await baseline('073-blocks', second)
    await writeFile(join(second, 'ui.ts'), ui(usage))
    await writeFile(join(owner, 'ui.ts'), ui(extensions))
    actions.resolve = async () => {}
    await actions.finish('073-blocks', { message: '[Jamat] Show usage', messageSource: 'agent-proposal' })
    const waiting = records.get('073-blocks')
    const workflow = waiting === null ? null : SessionWorkflows.of(waiting, (runId) => records.get(runId))
    this.check('I2 two blocks added at one place wait after the Finish with one press, Resolve with agent, and no resolver started',
      waiting?.worktreeOutcome?.result === 'committed' && waiting.svnAction?.needs?.kind === 'conflict'
      && workflow?.actions[0]?.label === 'Resolve with agent' && actions.prompts.length === 0)
    await actions.flow.startUpdate('073-blocks', owner, 'window')
    await actions.settled()
    this.check('I2 the press starts the resolver; one that leaves the conflict makes the UPDATE wait again',
      actions.prompts.length === 1 && records.get('073-blocks')?.svnAction?.needs !== undefined && await conflicted() === 1)
    actions.resolve = async (cwd) => { await writeFile(join(cwd, 'ui.ts'), ui([...extensions, ...usage])) }
    await actions.flow.startUpdate('073-blocks', owner, 'window')
    await actions.settled()
    actions.resolve = null
    this.check('I2 a second press runs the resolver again and the UPDATE lands with both blocks',
      actions.prompts.length === 2 && updated('073-blocks') && await readFile(join(owner, 'ui.ts'), 'utf8') === ui([...extensions, ...usage])
      && await conflicted() === 0)

    // I4
    const third = await session('074-install')
    await baseline('074-install', third)
    const marker = join(base, 'installed.txt')
    actions.install = { key: 'install', scriptId: 'setup', name: 'setup',
      commands: [{ cwd: third, command: `node -e "require('fs').writeFileSync(process.argv[1], 'installed')" "${marker}"` }] }
    await writeFile(join(third, 'package.json'), '{ "version": "1.1.0" }\n')
    const installed = await actions.finish('074-install', { message: '[Jamat] Bump version', messageSource: 'agent-proposal' })
    actions.install = null
    this.check('I4 a changed package.json runs the agreed install by itself, then the checks and the review, with no environment wait',
      existsSync(marker) && installed.outcome?.result === 'committed'
      && records.get('074-install')?.worktreeLifecycle?.environment?.source === 'setup' && updated('074-install'))

    // I5
    const fourth = await session('075-inputs')
    await baseline('075-inputs', fourth)
    await writeFile(join(fourth, 'package.json'), '{ "version": "2.0.0" }\n')
    await actions.flow.start('075-inputs', { choice: 'commit', requestedBy: 'window' })
    await actions.settled()
    const environment = records.get('075-inputs')?.worktreeLifecycle?.environment
    this.check('I5 without an install the environment wait names only the input that changed, not every input of the project',
      environment?.pending === true && JSON.stringify(environment.paths) === '["package.json"]')
    await actions.discard('075-inputs')
    await records.settled()
  }

  /**
   * The disk half of the scenario table in `docs/architecture/svn-worktrees.md`: create and its
   * refusals, the finish outcomes the bash contract tests, externals first, a held worktree, a
   * junction and a long path. Every owner is a checkout of a repository below this smoke's root.
   */
  private async checkWorktreeContract(heldOnly = false): Promise<void> {
    const repository = await SvnFixtureRepository.create(join(this.root, 'contract-repository'), this.svn)
    const url = repository.url
    await repository.run(this.root, ['mkdir', '--parents', '-m', 'layout', `${url}/Project/src`])
    const owner = join(this.root, 'contract-owner')
    await repository.run(this.root, ['checkout', `${url}/Project`, owner])
    await writeFile(join(owner, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
    await writeFile(join(owner, 'src', 'b.txt'), 'b\n')
    await repository.run(owner, ['add', '--', 'a.txt', 'src/b.txt'])
    await repository.run(owner, ['propset', 'svn:global-ignores', '.worktrees', '--', '.'])
    await repository.run(owner, ['commit', '-m', 'project'])
    await repository.run(owner, ['update'])
    const other = join(this.root, 'contract-other')
    await repository.run(this.root, ['checkout', `${url}/Project`, other])

    const manager = new SvnWorktreeManager(this.svn)
    const records = await SessionRecordsStore.load(join(this.root, 'contract-records', 'session-records.json'),
      { snapshotsDirectory: join(this.root, 'contract-records', 'snapshots'), report: (message) => { throw new Error(message) } })
    const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, 'contract-script-logs'))
    actions.idleFallback = true
    const { opened, ended } = actions
    const provisioner = this.provisionerOf(manager)
    const sessionIn = async (ownerDir: string, sessionId: string, folder: string): Promise<string> => {
      const provision = await this.provisioned(provisioner, { directory: ownerDir, projectRoot: ownerDir }, folder)
      if (!provision.ok) throw new Error(provision.detail)
      if (provision.exitCode !== 0) throw new Error(`the checkout of ${folder} exited with ${provision.exitCode}`)
      await records.put({
        sessionId, kind: 'shell', title: `014 - ${folder}`, createdAt: 0, life: 'ended', binding: null,
        directory: { mode: 'adHoc', path: ownerDir }, worktree: { ...provision.worktree, agentStartedAt: 1 },
      })
      return provision.worktree.worktreePath
    }
    if (heldOnly) { await this.checkHeld({ actions, records, owner, sessionIn }); return }
    const finished = (sessionId: string) => actions.finish(sessionId)
    const foreignCommit = async (path: string, text: string, add = false): Promise<void> => {
      await repository.run(other, ['update'])
      await writeFile(join(other, ...path.split('/')), text)
      if (add) await repository.run(other, ['add', '--', path])
      await repository.run(other, ['commit', '-m', 'foreign', '--', '.'])
    }

    await this.checkCreate({ repository, manager, owner, other })
    await this.checkOwnerScope(owner)

    // SW06: landing is the commit from the worktree; the UPDATE the Finish starts then brings it into the
    // main copy, beside the main copy's own local change, which stays (Finish 072).
    await writeFile(join(owner, 'a.txt'), 'one main\ntwo\nthree\nfour\nfive\n')
    const landing = await sessionIn(owner, 'landing-session', '014-landing')
    await writeFile(join(landing, 'a.txt'), 'one\ntwo\nthree\nfour\nfive session\n')
    const landed = await finished('landing-session')
    this.check('SW06 Finish Commit commits from the worktree, removes it, then updates the main copy and keeps its local change',
      landed.answer.ok && landed.outcome?.result === 'committed' && landed.outcome.worktree === 'removed'
      && await readFile(join(owner, 'a.txt'), 'utf8') === 'one main\ntwo\nthree\nfour\nfive session\n' && !existsSync(landing)
      && actions.landed('landing-session', owner))
    await repository.run(owner, ['revert', '--', 'a.txt'])
    await repository.run(owner, ['update'])

    // SW06: a conflicting foreign commit waits for the person before any review, and nothing is committed.
    const conflicted = await sessionIn(owner, 'conflict-session', '014-conflict')
    await writeFile(join(conflicted, 'a.txt'), 'one\ntwo session\nthree\nfour\nfive session\n')
    await foreignCommit('a.txt', 'one\ntwo foreign\nthree\nfour\nfive session\n')
    const reviewsBefore = opened.length
    const conflict = await finished('conflict-session')
    console.log(`  info: no-merger fallback: ${JSON.stringify(records.get('conflict-session')?.worktreeLifecycle?.wait)}`)
    this.check('SW06 an update conflict where no Claude runs waits for the person, opens no review and keeps the worktree',
      conflict.answer.ok && conflict.action?.needs?.kind === 'conflict' && conflict.action.needs.reason.includes('no merger runs here')
      && opened.length === reviewsBefore && existsSync(join(conflicted, '.svn')) && !ended.has('conflict-session'))
    this.check('SW04 Discard removes a worktree with conflicts and changes', (await actions.discard('conflict-session')).ok && !existsSync(conflicted))

    // SW06 with a merger: the check after it settles what it merged, the update runs again, then the review.
    await repository.run(owner, ['update'])
    const resolvedTree = await sessionIn(owner, 'resolved-session', '014-resolved')
    await writeFile(join(resolvedTree, 'a.txt'), 'one\ntwo foreign\nthree session\nfour\nfive session\n')
    await foreignCommit('a.txt', 'one\ntwo foreign\nthree other\nfour\nfive session\n')
    const merged = 'one\ntwo foreign\nthree other and session\nfour\nfive session\n'
    actions.resolve = async (cwd) => {
      const before = await readFile(join(cwd, 'a.txt'), 'utf8')
      if (!before.includes('<<<<<<< .mine')) throw new Error(`the merger found no conflict in ${cwd}`)
      await writeFile(join(cwd, 'a.txt'), merged)
    }
    const resolvedWait = await finished('resolved-session')
    this.check('F24 a changed selected file requires approval after its merge', resolvedWait.action?.stage === 'changes' && records.get('resolved-session')?.worktreeLifecycle?.review?.selection.includes('a.txt') === true
      && opened.length === reviewsBefore)
    const resolvedFinish = await finished('resolved-session')
    this.check('F24 a merger settles a text conflict: the check after it marks it resolved, the update runs again, reviewed and committed',
      resolvedFinish.answer.ok && resolvedFinish.outcome?.result === 'committed' && resolvedFinish.outcome.worktree === 'removed'
      && opened.length === reviewsBefore + 1 && actions.landed('resolved-session', owner)
      && actions.prompts.length === 1 && actions.prompts[0].includes('-merge.md'))
    await repository.run(other, ['update'])
    this.check('F24 the commit holds what the merger merged', await readFile(join(other, 'a.txt'), 'utf8') === merged)

    // SW06 with a merger that leaves its markers: nothing is marked resolved and the person decides.
    await repository.run(owner, ['update'])
    const markedTree = await sessionIn(owner, 'marked-session', '014-marked')
    await writeFile(join(markedTree, 'a.txt'), 'one mine\ntwo foreign\nthree other and session\nfour\nfive session\n')
    await foreignCommit('a.txt', 'one theirs\ntwo foreign\nthree other and session\nfour\nfive session\n')
    actions.resolve = async () => undefined
    const marked = await finished('marked-session')
    const markedStatus = await repository.run(markedTree, ['status', '--', 'a.txt'])
    this.check('F24 markers the merger left need the person ("the merger ended with 1 left"), and svn still marks the conflict',
      marked.answer.ok && marked.action?.needs?.kind === 'conflict' && marked.action.needs.reason.includes('the merger ended with 1 left')
      && markedStatus.startsWith('C') && opened.length === reviewsBefore + 1 && actions.prompts.length === 2)
    actions.resolve = null
    this.check('SW04 Discard removes the worktree the merger left', (await actions.discard('marked-session')).ok && !existsSync(markedTree))

    // F25: a file the session changed is edited by hand while the merger works: the Finish waits naming
    // it, though the path was changed before too; Check again accepts it and the review commits it.
    await foreignCommit('notes.txt', 'notes\n', true)
    await repository.run(owner, ['update'])
    const guardedTree = await sessionIn(owner, 'guarded-session', '014-guarded')
    const base = await readFile(join(guardedTree, 'a.txt'), 'utf8')
    await writeFile(join(guardedTree, 'a.txt'), base.replace(/^[^\n]*/, 'one guarded'))
    await writeFile(join(guardedTree, 'notes.txt'), 'notes of the session\n')
    await foreignCommit('a.txt', base.replace(/^[^\n]*/, 'one foreign again'))
    const guardedMerged = base.replace(/^[^\n]*/, 'one guarded and foreign again')
    actions.resolve = async (cwd) => {
      if (!(await readFile(join(cwd, 'a.txt'), 'utf8')).includes('<<<<<<< .mine')) throw new Error(`the merger found no conflict in ${cwd}`)
      await writeFile(join(cwd, 'a.txt'), guardedMerged)
      await writeFile(join(cwd, 'notes.txt'), 'notes of the session\nand a line the person added while the merger ran\n')
    }
    const guarded = await finished('guarded-session')
    actions.resolve = null
    this.check('F25 an edit of a file the session changed, made while the merger ran, makes the Finish wait naming it',
      guarded.answer.ok && guarded.action?.needs?.kind === 'conflict'
      && guarded.action.needs.reason.startsWith('changed outside the conflicts while the merger ran: notes.txt;'))
    const changedSelection = await finished('guarded-session')
    this.check('F25 Check again returns the changed selection for review', changedSelection.action?.stage === 'changes')
    const accepted = await finished('guarded-session')
    await repository.run(other, ['update'])
    this.check('F25 Check again accepts it: the review commits the edit with the merge',
      accepted.answer.ok && accepted.outcome?.result === 'committed' && opened.length === reviewsBefore + 2
      && (await readFile(join(other, 'notes.txt'), 'utf8')).includes('while the merger ran')
      && await readFile(join(other, 'a.txt'), 'utf8') === guardedMerged)

    await repository.run(owner, ['update'])
    const updated = await sessionIn(owner, 'updated-session', '014-updated')
    await writeFile(join(updated, 'src', 'b.txt'), 'b session\n')
    await foreignCommit('src/c.txt', 'c\n', true)
    const reviewsBeforeUpdated = opened.length
    const first = await finished('updated-session')
    this.check('SW06 initial preparation receives incoming project changes before publication',
      first.answer.ok && first.outcome?.result === 'committed' && first.outcome.worktree === 'removed'
      && opened.length === reviewsBeforeUpdated + 1 && actions.landed('updated-session', owner))

    await repository.run(owner, ['update'])
    const checked = await sessionIn(owner, 'checked-session', '014-checked')
    await writeFile(join(checked, 'src', 'b.txt'), 'b checked\n')
    actions.checkRuns = 0
    actions.checksOf = () => [{ name: 'tests', command: 'exit 0' }]
    actions.onCheck = async (count) => { if (count === 1) await foreignCommit('src/d.txt', 'd\n', true) }
    const reviewsBeforeChecked = opened.length
    const needsPreparation = await finished('checked-session')
    this.check('A2 a source added in the repository during checks invalidates approval without reading it locally',
      !needsPreparation.answer.ok && needsPreparation.answer.code === 'review-stale' && opened.length === reviewsBeforeChecked
      && existsSync(checked) && !existsSync(join(checked, 'src/d.txt')))
    const checkedFinish = await finished('checked-session')
    actions.checksOf = () => []
    actions.onCheck = null
    const checkRuns = records.list().filter((run) => run.scriptOf?.sessionId === 'checked-session' && run.scriptOf.scriptId === 'checks')
    this.check('A2 Finish runs the declared check, commits its selection and removes the worktree',
      checkedFinish.answer.ok && checkedFinish.outcome?.result === 'committed' && checkedFinish.outcome.worktree === 'removed'
      && actions.checkRuns === 2 && checkRuns.length === 2 && checkRuns.every((run) => run.title === 'tests 014-checked')
      && opened.length === reviewsBeforeChecked + 1 && !existsSync(checked) && actions.landed('checked-session', owner))
    await repository.run(other, ['update'])
    this.check('A2 the commit of that Finish carries the session\'s change on top of the incoming one',
      await readFile(join(other, 'src', 'b.txt'), 'utf8') === 'b checked\n' && existsSync(join(other, 'src', 'd.txt')))

    await this.checkExternals({ repository, actions, sessionIn })
    await this.checkHeld({ actions, records, owner, sessionIn })

    // SW04 and R15: a junction into a shared store survives, and a path beyond 260 characters goes.
    const store = join(this.root, 'contract-shared-store')
    await mkdir(store)
    await writeFile(join(store, 'precious.txt'), 'keep\n')
    const linked = await sessionIn(owner, 'junction-session', '014-junction')
    await symlink(store, join(linked, 'src', 'linked'), 'junction')
    const deep = join(linked, 'deep', ...Array.from({ length: 12 }, (_, index) => `segment-${index}-of-a-long-path`))
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, 'leaf.txt'), 'leaf\n')
    this.check('R15 the fixture holds a path beyond 260 characters', join(deep, 'leaf.txt').length > 260)
    this.check('SW04 Discard removes the worktree without following its junction, long path included',
      (await actions.discard('junction-session')).ok && !existsSync(linked)
      && await readFile(join(store, 'precious.txt'), 'utf8') === 'keep\n')
    this.check('SW03 every removal took only its own worktree: both kept checkouts and lease metadata remain',
      JSON.stringify((await readdir(join(owner, '.worktrees'))).sort()) === JSON.stringify(['.leases', '014-fix-login', '014-fix-login-2']))
    await records.settled()
  }

  /** The owner rule over real working copies: no group and no catalog unless a case names them. */
  private provisionerOf(manager: SvnWorktreeManager, catalog: Partial<WorktreeOwnerDeps> = {}): SvnWorktreeProvisioner {
    return new SvnWorktreeProvisioner(manager, {
      groupScopeOf: (dir) => ProductGroup.scopeOf(dir),
      catalogProjectOf: () => null,
      holdsCatalogProject: () => false,
      workingCopyRootOf: (dir) => manager.workingCopyRootOf(dir),
      ...catalog,
    })
  }

  /**
   * A create as the lifecycle runs it: the place, the reservation that the record is written from,
   * then the checkout run spawned the way the Host spawns it, in the reserved folder.
   */
  private async provisioned(provisioner: SvnWorktreeProvisioner, request: WorktreePlaceRequest, folder: string, baseRef?: string)
    : Promise<{ ok: true; worktree: SessionRecordWorktree; checkout: SessionRecordProcess & { cwd: string }; exitCode: number }
      | { ok: false; code: string; detail: string }> {
    const placed = await provisioner.place(request)
    if (!placed.ok) return placed
    await SvnSmokeIsolation.owner(this.root, placed.value.ownerDir)
    const provision = await provisioner.create({ placement: placed.value, folder, baseRef })
    if (!provision.ok) return provision
    const checkout = provision.value.checkout
    if (checkout === null) throw new Error(`The SVN worktree ${folder} came without its checkout`)
    return { ok: true, worktree: provision.value.worktree, checkout, exitCode: await this.runCheckout(checkout) }
  }

  private async runCheckout(checkout: SessionRecordProcess & { cwd: string }): Promise<number> {
    const outcome = await this.svn.run(checkout.cwd, checkout.args)
    return outcome.failure === null ? outcome.code ?? 1 : 1
  }

  /** SW01 and SW02: a numbered checkout of the owner at HEAD, and every refusal of the owner rules. */
  private async checkCreate(input: {
    repository: SvnFixtureRepository; manager: SvnWorktreeManager; owner: string; other: string
  }): Promise<void> {
    const { repository, manager, owner, other } = input
    await writeFile(join(owner, 'src', 'b.txt'), 'b uncommitted main work\n')
    const provisioner = this.provisionerOf(manager)
    const ownerUrl = (await repository.run(owner, ['info', '--show-item', 'url', '--', '.'])).trim()
    const head = (await repository.run(owner, ['info', '--show-item', 'revision', '--', repository.url])).trim()
    const placed = await provisioner.place({ directory: owner, projectRoot: owner })
    if (placed.ok) await SvnSmokeIsolation.owner(this.root, placed.value.ownerDir)
    const reserved = placed.ok ? await provisioner.create({ placement: placed.value, folder: '014-fix-login' }) : null
    const folder = join(owner, '.worktrees', '014-fix-login')
    this.check('SW01 create reserves .worktrees/<NNN>-<slug> and names the owner URL and r<HEAD> before any checkout',
      reserved !== null && reserved.ok && reserved.value.worktree.kind === 'svn' && reserved.value.worktree.worktreePath === folder
      && reserved.value.worktree.branch === ownerUrl && reserved.value.worktree.baseCommit === `r${head}`
      && reserved.value.worktree.directoryId !== undefined && reserved.value.worktree.cwdSubpath === undefined
      && (await readdir(folder)).length === 0)
    const checkedOut = reserved !== null && reserved.ok && reserved.value.checkout !== null ? await this.runCheckout(reserved.value.checkout) : -1
    this.check('SW01 its checkout run checks the owner URL out at that revision, without the main copy\'s work',
      checkedOut === 0 && await readFile(join(folder, 'src', 'b.txt'), 'utf8') === 'b\n'
      && (await repository.run(folder, ['info', '--show-item', 'revision', '--', '.'])).trim() === head)
    const again = await this.provisioned(provisioner, { directory: owner, projectRoot: owner }, '014-fix-login')
    this.check('SW02 a taken folder is never overwritten: the next create gets <folder>-2',
      again.ok && again.exitCode === 0 && again.worktree.worktreePath === join(owner, '.worktrees', '014-fix-login-2'))
    await repository.run(owner, ['revert', '--', 'src/b.txt'])

    const refusedFor = async (request: { projectRoot: string | null; directory?: string; owner?: string; baseRef?: string }, holdsCatalogProject = false) => {
      const answer = await this.provisioned(this.provisionerOf(manager, { holdsCatalogProject: () => holdsCatalogProject }),
        { directory: request.directory ?? request.projectRoot ?? '', projectRoot: request.projectRoot, owner: request.owner }, '014-refused', request.baseRef)
      return answer.ok ? null : answer
    }
    const plain = join(this.root, 'contract-plain')
    await mkdir(plain)
    const exposed = join(this.root, 'contract-exposed')
    await repository.run(this.root, ['checkout', `${repository.url}/Project`, exposed])
    await mkdir(join(exposed, '.worktrees'))
    await repository.run(exposed, ['add', '--', '.worktrees'])
    const refusals = {
      baseRef: await refusedFor({ projectRoot: owner, baseRef: 'trunk' }),
      inWorktree: await refusedFor({ projectRoot: owner, owner: join(owner, '.worktrees', '014-fix-login') }),
      directoryInWorktree: await refusedFor({ projectRoot: null, directory: join(owner, '.worktrees', '014-fix-login', 'src') }),
      outside: await refusedFor({ projectRoot: owner, owner: other }),
      unversioned: await refusedFor({ projectRoot: plain }),
      zoneRoot: await refusedFor({ projectRoot: owner }, true),
      notIgnored: await refusedFor({ projectRoot: exposed }),
    }
    this.check('SW02 create refuses a base ref, an owner or a directory in a worktree, outside the project, unversioned, a zone root and an unignored .worktrees',
      Object.values(refusals).every((refusal) => refusal !== null && refusal.code === 'invalid-spec')
      && /inside a worktree/.test(refusals.inWorktree?.detail ?? '') && /inside a worktree/.test(refusals.directoryInWorktree?.detail ?? '')
      && /outside the project/.test(refusals.outside?.detail ?? '') && /in no SVN working copy|not a versioned SVN directory/.test(refusals.unversioned?.detail ?? '')
      && /holds other projects/.test(refusals.zoneRoot?.detail ?? '') && /does not ignore/.test(refusals.notIgnored?.detail ?? ''))
    this.check('SW02 and nothing was checked out where the create was refused',
      !existsSync(join(exposed, '.worktrees', '014-refused')) && !existsSync(join(plain, '.worktrees'))
      && !existsSync(join(owner, '.worktrees', '014-refused')))
  }

  /**
   * Create for any directory (Unit 7): a zone working copy holding a product group, a catalog
   * project and a directory outside the catalog. The owner is the group, else the catalog project,
   * else the directory; the session's place below it survives the checkout; a zone root is refused.
   * A failed checkout leaves the reserved folder, which only its own identity lets a retry empty.
   */
  private async checkCreateOwners(): Promise<void> {
    const repository = await SvnFixtureRepository.create(join(this.root, 'create-repository'), this.svn)
    const url = repository.url
    for (const path of ['Zone/Group/Member/src', 'Zone/Group/Backend', 'Zone/Group/Worker', 'Zone/Group/components', 'Zone/Solo/docs', 'Zone/Outside/tools'])
      await repository.run(this.root, ['mkdir', '--parents', '-m', 'layout', `${url}/${path}`])
    const zone = join(this.root, 'create-zone')
    await repository.run(this.root, ['checkout', `${url}/Zone`, zone])
    await writeFile(join(zone, 'Group', ProductGroup.markerConst), '{"kind":"product"}')
    await writeFile(join(zone, 'Group', 'Member', 'src', 'a.txt'), 'member\n')
    await writeFile(join(zone, 'Group', 'Backend', 'backend.txt'), 'backend\n')
    await writeFile(join(zone, 'Group', 'Worker', 'worker.txt'), 'worker\n')
    await writeFile(join(zone, 'Group', 'components', 'shared.txt'), 'shared\n')
    await writeFile(join(zone, 'Solo', 'docs', 'readme.txt'), 'solo\n')
    await repository.run(zone, ['add', '--', `Group/${ProductGroup.markerConst}`, 'Group/Member/src/a.txt',
      'Group/Backend/backend.txt', 'Group/Worker/worker.txt', 'Group/components/shared.txt', 'Solo/docs/readme.txt'])
    await repository.run(zone, ['propset', 'svn:global-ignores', '.worktrees', '--', '.'])
    await repository.run(zone, ['commit', '-m', 'zone'])
    await repository.run(zone, ['update'])
    const group = join(zone, 'Group')
    const solo = join(zone, 'Solo')
    const manager = new SvnWorktreeManager(this.svn)
    const provisioner = this.provisionerOf(manager, {
      catalogProjectOf: (dir) => [group, solo].find((project) => PathCompare.isInside(project, dir)) ?? null,
      holdsCatalogProject: (dir) => PathCompare.isInside(dir, zone),
    })

    const member = await this.provisioned(provisioner, { directory: join(group, 'Member', 'src'), projectRoot: null }, 'c1-member')
    this.check('Create a directory in a group member is a worktree of the whole group, the session at Member/src of it',
      member.ok && member.worktree.repositoryRoot === group && member.worktree.cwdSubpath === 'Member/src'
      && member.worktree.branch === `${url}/Zone/Group` && member.exitCode === 0
      && await readFile(join(member.worktree.worktreePath, 'Member', 'src', 'a.txt'), 'utf8') === 'member\n')
    this.check('Create a three-service product retains both sibling services, shared components and its typed marker', member.ok
      && await readFile(join(member.worktree.worktreePath, 'Backend/backend.txt'), 'utf8') === 'backend\n'
      && await readFile(join(member.worktree.worktreePath, 'Worker/worker.txt'), 'utf8') === 'worker\n'
      && await readFile(join(member.worktree.worktreePath, 'components/shared.txt'), 'utf8') === 'shared\n'
      && JSON.parse(await readFile(join(member.worktree.worktreePath, ProductGroup.markerConst), 'utf8')).kind === 'product')
    const project = await this.provisioned(provisioner, { directory: join(solo, 'docs'), projectRoot: null }, 'c2-solo')
    this.check('Create a subdirectory of a catalog project without a group is a worktree of the project, the subpath kept',
      project.ok && project.worktree.repositoryRoot === solo && project.worktree.cwdSubpath === 'docs' && project.exitCode === 0
      && existsSync(join(project.worktree.worktreePath, 'docs', 'readme.txt')))
    const outside = await this.provisioned(provisioner, { directory: join(zone, 'Outside', 'tools'), projectRoot: null }, 'c3-outside')
    this.check('Create a directory outside the catalog is a worktree of that directory itself',
      outside.ok && outside.worktree.repositoryRoot === join(zone, 'Outside', 'tools') && outside.worktree.cwdSubpath === undefined
      && outside.exitCode === 0)
    const zoneRoot = await this.provisioned(provisioner, { directory: zone, projectRoot: null }, 'c4-zone')
    const plain = await this.provisioned(provisioner, { directory: join(this.root, 'create-plain'), projectRoot: null }, 'c5-plain')
    this.check('Create refuses a working-copy root holding catalog projects, and a directory in no working copy, with the reason',
      !zoneRoot.ok && /holds other projects/.test(zoneRoot.detail) && !existsSync(join(zone, '.worktrees'))
      && !plain.ok && /no directory|in no SVN working copy/.test(plain.detail))

    // A failed checkout: the repository is out of reach, then back; the retry empties the folder by identity first.
    const placed = await provisioner.place({ directory: solo, projectRoot: solo })
    const reserved = placed.ok ? await provisioner.create({ placement: placed.value, folder: 'c6-retry' }) : null
    if (reserved === null || !reserved.ok || reserved.value.checkout === null) throw new Error('Create could not reserve the retry folder')
    const { worktree, checkout } = reserved.value
    const aside = `${repository.directory}-unreachable`
    await rename(repository.directory, aside)
    const failedExit = await this.runCheckout(checkout)
    await rename(aside, repository.directory)
    await mkdir(join(worktree.worktreePath, '.svn'), { recursive: true })
    await writeFile(join(worktree.worktreePath, 'half.txt'), 'half a checkout\n')
    const purged = await provisioner.purgeReserved(worktree)
    const emptied = (await readdir(worktree.worktreePath)).length === 0
    const retriedExit = await this.runCheckout(checkout)
    this.check('Create a checkout that cannot reach the server exits non-zero; the retry empties the reserved folder by identity and checks out again',
      failedExit !== 0 && purged.ok && emptied && retriedExit === 0 && existsSync(join(worktree.worktreePath, 'docs', 'readme.txt'))
      && await SvnWorktreeManager.directoryIdOf(worktree.worktreePath) === worktree.directoryId)

    const replacedPath = join(solo, '.worktrees', 'c7-replaced')
    const replaced = await provisioner.create({ placement: placed.ok ? placed.value : { kind: 'svn', ownerDir: solo, cwdSubpath: '', catalogProject: solo }, folder: 'c7-replaced' })
    if (!replaced.ok) throw new Error(replaced.detail)
    await rm(replacedPath, { recursive: true, force: true })
    await mkdir(replacedPath)
    await writeFile(join(replacedPath, 'keep.txt'), 'another folder of the same name\n')
    const refused = await provisioner.purgeReserved(replaced.value.worktree)
    this.check('Create a reserved folder replaced by another of the same name is refused by identity, and nothing is deleted',
      !refused.ok && /another directory/.test(refused.detail) && existsSync(join(replacedPath, 'keep.txt')))
  }

  /** SW13: the owner's commit scope, as the commit dialog reads it, never lists a worktree. */
  private async checkOwnerScope(owner: string): Promise<void> {
    await writeFile(join(owner, '.worktrees', '014-fix-login', 'a.txt'), 'changed in a worktree\n')
    await writeFile(join(owner, 'src', 'b.txt'), 'b owner change\n')
    const scope = await new FileChangesManager({ diffExecutor: new FileDiffComputer() })
      .workingTree({ sessionId: 'contract-owner', cwd: owner, agent: null, worktree: null }, 'svn', true)
    this.check('SW13 the owner\'s commit scope lists its own change and nothing below .worktrees',
      scope.ok && scope.value.entries.some((entry) => entry.displayPath === 'src/b.txt')
      && scope.value.entries.every((entry) => !entry.displayPath.startsWith('.worktrees')))
    await this.svn.run(join(owner, '.worktrees', '014-fix-login'), ['revert', '--non-interactive', '--', 'a.txt'])
    await this.svn.run(owner, ['revert', '--non-interactive', '--', 'src/b.txt'])
  }

  /** SW11: externals publish first; an incomplete selection publishes no part of the assembly. */
  private async checkExternals(input: {
    repository: SvnFixtureRepository
    actions: SmokeSvnActions
    sessionIn: (ownerDir: string, sessionId: string, folder: string) => Promise<string>
  }): Promise<void> {
    const { repository, actions, sessionIn } = input
    const { opened, decision } = actions
    const finished = (sessionId: string) => actions.finish(sessionId)
    const external = await SvnFixtureRepository.create(join(this.root, 'contract-external'), this.svn)
    await external.run(this.root, ['mkdir', '--parents', '-m', 'external layout', `${external.url}/lib`, `${external.url}/tools`])
    const lib = join(this.root, 'contract-lib')
    await external.run(this.root, ['checkout', external.url, lib])
    await writeFile(join(lib, 'lib', 'l.txt'), 'lib\n')
    await writeFile(join(lib, 'tools', 't.txt'), 'tools\n')
    await external.run(lib, ['add', '--', 'lib/l.txt', 'tools/t.txt'])
    await external.run(lib, ['commit', '-m', 'external library'])
    // `group/tools` makes svn mark `group`, a plain directory it creates and holds no node of.
    const definitions = join(this.root, 'contract-externals.txt')
    await writeFile(definitions, `${external.url}/lib mount\n${external.url}/tools group/tools\n`)
    await repository.run(this.root, ['mkdir', '-m', 'app layout', `${repository.url}/App`])
    const app = join(this.root, 'contract-app')
    await repository.run(this.root, ['checkout', `${repository.url}/App`, app])
    await writeFile(join(app, 'app.txt'), 'app\n')
    await repository.run(app, ['add', '--', 'app.txt'])
    await repository.run(app, ['propset', 'svn:externals', '-F', definitions, '--', '.'])
    await repository.run(app, ['propset', 'svn:global-ignores', '.worktrees', '--', '.'])
    await repository.run(app, ['commit', '-m', 'app with an external'])
    await repository.run(app, ['update'])

    const both = await sessionIn(app, 'external-session', '014-both')
    await writeFile(join(both, 'app.txt'), 'app session\n')
    await writeFile(join(both, 'mount', 'l.txt'), 'lib session\n')
    const before = opened.length
    const landed = await finished('external-session')
    this.check('SW11 a changed mount is reviewed before its parent, and both commits are labelled in their own repositories',
      landed.answer.ok && landed.outcome?.result === 'committed' && landed.outcome.worktree === 'removed'
      && opened.length === before + 2 && opened[before] === join(both, 'mount') && opened[before + 1] === both
      && new Set(landed.outcome.labelled?.map((entry) => entry.repository)).size === 2)

    const cancelled = await sessionIn(app, 'external-cancel', '014-cancel')
    await writeFile(join(cancelled, 'app.txt'), 'app two\n')
    await writeFile(join(cancelled, 'mount', 'l.txt'), 'lib two\n')
    decision.of = (scopeRoot) => scopeRoot.endsWith('mount') ? 'cancel' : 'commit'
    const stopped = await finished('external-cancel')
    decision.of = () => 'commit'
    this.check('SW11 an excluded mount refuses the entire publication and keeps every source',
      !stopped.answer.ok && stopped.answer.code === 'review-stale' && stopped.answer.detail.includes('mount/l.txt')
      && stopped.action?.evidence.length === 0 && opened.length === before + 2 && existsSync(join(cancelled, 'app.txt'))
      && await readFile(join(cancelled, 'mount', 'l.txt'), 'utf8') === 'lib two\n')
    this.check('SW04 Discard removes a worktree with an external mount', (await actions.discard('external-cancel')).ok && !existsSync(cancelled))

    const nested = await sessionIn(app, 'external-nested', '014-nested')
    await writeFile(join(nested, 'group', 'tools', 't.txt'), 'tools session\n')
    const fromNested = opened.length
    const nestedLanded = await finished('external-nested')
    this.check('SW11 a nested external target is reviewed from its own mount, never from the plain directory svn marks',
      nestedLanded.answer.ok && nestedLanded.outcome?.result === 'committed' && nestedLanded.outcome.worktree === 'removed'
      && opened.length === fromNested + 1 && opened[fromNested] === join(nested, 'group', 'tools'))
  }

  /**
   * SW12: a process with its working directory, or an open file, inside the worktree makes the
   * removal IN USE and leaves the worktree whole. This client's own FileChanges view holds nothing.
   */
  private async checkHeld(input: {
    actions: SmokeSvnActions
    records: SessionRecordsStore
    owner: string
    sessionIn: (ownerDir: string, sessionId: string, folder: string) => Promise<string>
  }): Promise<void> {
    const { actions, records, owner, sessionIn } = input
    const { ended } = actions
    const flow = actions.finisher
    const finished = (sessionId: string) => actions.finish(sessionId)
    const held = await sessionIn(owner, 'held-session', '014-held')
    await writeFile(join(held, 'a.txt'), 'one\ntwo\nthree\nfour held\nfive session\n')
    const view = await new FileChangesManager({ diffExecutor: new FileDiffComputer() }).workingTree({
      sessionId: 'held-session', cwd: held, agent: null,
      worktree: { worktreePath: held, repositoryRoot: owner, baseCommit: records.get('held-session')?.worktree?.baseCommit ?? '', kind: 'svn' },
    }, null)
    this.check('SW12 this client reads the worktree through FileChanges before the finish',
      view.ok && view.value.entries.some((entry) => entry.displayPath === 'a.txt'))

    const cwdHolder = await SmokeSvnWorktree.holder(held, 'setInterval(() => {}, 1000)')
    let finish: Awaited<ReturnType<typeof finished>>
    try {
      finish = await finished('held-session')
      await mkdir(join(held, '.worktrees'), { recursive: true })
      for (let attempt = 0; attempt < 4; attempt++) {
        await writeFile(join(held, '.worktrees', 'dev.log'), `ignored output ${attempt}`)
        await actions.flow.start('held-session', { choice: 'commit', requestedBy: 'window' })
        await actions.settled()
        assert.equal(records.get('held-session')?.worktreeLifecycle?.wait?.kind, 'removal-blocked')
      }
      const destination = dirname(actions.results.savedDirectoryOf(records.get('held-session')!.worktreeLifecycle!.actionId!))
      this.check('HX7 repeated native locked cleanup creates no preservation copies as ignored output changes',
        !existsSync(join(destination, 'ignored')) && !existsSync(join(destination, 'discarded')))
    }
    finally { await SmokeSvnWorktree.release(cwdHolder) }
    this.check('SW12 a process working inside reports the native removal error after commit and keeps the worktree whole',
      finish.answer.ok && finish.outcome?.result === 'committed' && finish.outcome.worktree === 'in-use'
      && finish.outcome.lines.some((line) => /^REMOVAL BLOCKED \((EBUSY|EPERM|EACCES)\): /.test(line)) && existsSync(join(held, '.svn'))
      && records.get('held-session')?.worktree !== undefined && !ended.has('held-session'))
    this.check('R12 a held Finish persists its clean permit and offers removal retry plus main-copy UPDATE',
      records.get('held-session')?.worktreeLifecycle?.wait?.kind === 'removal-blocked'
      && records.get('held-session')?.worktreeLifecycle?.removalPermit?.kind === 'clean'
      && finish.action !== undefined && SessionWorkflows.of(records.get('held-session')!, () => null)?.actions.some((action) => action.id === 'update-main') === true)

    const fileHolder = await SmokeSvnWorktree.holder(this.root,
      `require('fs').openSync(${JSON.stringify(join(held, 'a.txt'))}, 'r'); setInterval(() => {}, 1000)`)
    let discarded: Awaited<ReturnType<SmokeSvnActions['discard']>>
    try { discarded = await actions.discard('held-session') }
    finally { await SmokeSvnWorktree.release(fileHolder) }
    this.check('SW12 a file held open refuses the removal too, and the worktree is whole',
      discarded.ok && records.get('held-session')?.worktreeLifecycle?.wait?.kind === 'removal-blocked' && existsSync(join(held, '.svn')))
    this.check('R12 a held person Discard retains its explicit discard permit for a later retry',
      records.get('held-session')?.worktreeLifecycle?.removalPermit?.kind === 'discard')
    // A run that ended after the Discard is what a reopen and a stop leave; its new work must survive.
    const discardedRecord = records.get('held-session')
    if (discardedRecord === null) throw new Error('the refused Discard lost its record')
    const cleanup = WorktreeCleanupPacing.pending('discard-unfinished', Date.now())
    await records.put({ ...discardedRecord, svnAction: undefined, worktreeLifecycle: undefined, worktreeCleanup: cleanup, endedAt: cleanup.requestedAt + 1 })
    await writeFile(join(held, 'after-reopen.txt'), 'made after the Discard\n')
    await flow.cleanUp('held-session')
    this.check('R12 a run after that Discard makes the cleanup count changes, so the new work is kept',
      records.get('held-session')?.worktreeCleanup?.phase === 'kept' && existsSync(join(held, 'after-reopen.txt'))
      && !ended.has('held-session'))
    this.check('SW12 once free it is removed, the FileChanges view of this client notwithstanding, and the session ends',
      (await actions.discard('held-session')).ok && !existsSync(held) && ended.has('held-session'))
  }

  /**
   * The conflict testbed of `scripts/dev/make-conflict-testbed.ts`, one fresh testbed per scenario:
   * `--work` writes only the session's side into the main copy and commits nothing, and `--land`
   * commits r2 with the paths the docs page lists.
   */
  private async checkConflictTestbed(): Promise<void> {
    for (const name of ConflictTestbed.scenarioNamesConst) {
      const root = join(this.root, `testbed-${name}`)
      ConflictTestbed.build(root)
      const scenario = ConflictTestbed.scenariosConst[name]
      const main = ConflictTestbed.mainOf(root)
      ConflictTestbed.work(main, name)
      const status = await this.svn.run(main, ['status', '--xml', '--non-interactive', '--', '.'])
      const changed = [...status.stdout.matchAll(/<entry\s+path="([^"]*)">\s*<wc-status([^>]*)>/g)]
        .filter(([, , attributes]) => !/item="normal"/.test(attributes ?? '') || /props="modified"/.test(attributes ?? ''))
        .map(([, path]) => (path ?? '').replaceAll('\\', '/')).sort()
      const head = async () => (await this.svn.run(root, ['info', '--show-item', 'revision', '--non-interactive', ConflictTestbed.urlOf(root)])).stdout.trim()
      this.check(`testbed ${name}: --work writes only the session's side and commits nothing`,
        JSON.stringify(changed) === JSON.stringify([...scenario.workPaths].sort()) && await head() === '1')
      const revision = ConflictTestbed.land(root, name)
      const log = await this.svn.run(root, ['log', '-v', '--xml', '-r', String(revision), '--non-interactive', ConflictTestbed.urlOf(root)])
      const landed = [...log.stdout.matchAll(/<path[^>]*>([^<]*)<\/path>/g)].map(([, path]) => (path ?? '').replace(/^\//, '')).sort()
      this.check(`testbed ${name}: --land commits r2 with the listed paths`,
        revision === 2 && JSON.stringify(landed) === JSON.stringify([...scenario.landPaths].sort()))
    }
  }

  /**
   * The testbed incident end to end on real svn: a worktree session of the testbed's main copy writes
   * the session's side, another commit lands, and Finish Commit waits with one conflict set that names
   * the tree conflict and both text conflicts, in the words the snapshot, the CLI and the workflow carry.
   */
  private async checkIncidentWait(): Promise<void> {
    const root = join(this.root, 'incident-testbed')
    ConflictTestbed.build(root)
    const main = ConflictTestbed.mainOf(root)
    const manager = new SvnWorktreeManager(this.svn)
    const records = await SessionRecordsStore.load(join(this.root, 'incident-records', 'session-records.json'),
      { snapshotsDirectory: join(this.root, 'incident-records', 'snapshots'), report: (message) => { throw new Error(message) } })
    const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, 'incident-script-logs'))
    actions.idleFallback = true
    const provision = await this.provisioned(this.provisionerOf(manager), { directory: main, projectRoot: main }, '006-incident')
    if (!provision.ok || provision.exitCode !== 0) throw new Error(`the incident worktree: ${JSON.stringify(provision)}`)
    await records.put({ sessionId: 'incident-session', kind: 'shell', title: '006 - incident', createdAt: 0, life: 'ended', binding: null,
      directory: { mode: 'adHoc', path: main }, worktree: { ...provision.worktree, agentStartedAt: 1 } })
    ConflictTestbed.work(provision.worktree.worktreePath, 'incident')
    const landed = ConflictTestbed.land(root, 'incident')
    const finished = await actions.finish('incident-session')
    const action = finished.action
    const info = action === undefined ? null : SvnActionStages.infoOf(action)
    const record = records.get('incident-session')
    const workflow = record === null ? null : SessionWorkflows.of(record, (runId) => records.get(runId))
    const steps = workflow?.rounds.flatMap((round) => round.steps) ?? []
    console.log(`  info: the incident waits: ${info?.summary ?? 'no summary'}; ${info?.conflicts?.entries.map((entry) => `${entry.path} (${entry.kind}): ${entry.description}`).join('; ')}`)
    this.check('F10/F20 the testbed incident reads one set: Jamat fixed the folder with keep-both, both text conflicts wait for the person (no Claude here)',
      finished.answer.ok && action?.needs?.kind === 'conflict' && info?.summary === '3 conflicts: Jamat fixed 1, 2 need you'
      // The wire lists open conflicts first, so the folder Jamat settled comes after both text conflicts.
      && JSON.stringify(info.conflicts?.entries.map((entry) => [entry.path, entry.kind, entry.state, entry.by]))
        === JSON.stringify([['src/catalog.ts', 'text', 'person', null], ['src/wallets.ts', 'text', 'person', null], ['.aidocs/engines', 'tree', 'settled', 'jamat']])
      && info.conflicts?.entries[2]?.description === `Your session added this folder with 2 files; r${landed} added it with 3 files.`
      && info.conflicts?.entries[2]?.saved !== null && existsSync(join(info.conflicts?.entries[2]?.saved ?? '', 't1'))
      && record?.worktreeLifecycle?.syncConflictSet?.entries[0]?.settledWith === 'keep-both'
      && record.worktreeLifecycle.syncConflictSet.entries[0].journal?.option === 'keep-both'
      && (record.worktreeLifecycle.syncConflictSet.entries[0].journal?.done ?? 0) > 0
      && record.worktreeLifecycle.syncConflictSet.entries[0].occurrenceId !== undefined)
    this.check('F10/F20 its workflow names the person conflict wait and exposes the conflict check',
      workflow?.badge === 'Conflicts need your decision'
      && steps.some((step) => step.title === 'Check the conflicts' && step.state === 'waits' && step.target.kind === 'conflicts'))

    // F15: the person keeps both lines of each text conflict and presses Check again.
    const worktreePath = provision.worktree.worktreePath
    for (const file of ['src/catalog.ts', 'src/wallets.ts']) {
      const path = join(worktreePath, ...file.split('/'))
      await writeFile(path, SmokeSvnWorktree.bothSidesOf(await readFile(path, 'utf8')))
    }
    actions.decision.of = () => 'cancel'
    const checked = await actions.finish('incident-session')
    const reviewing = checked.action
    const changed = (await manager.reviewRoots(worktreePath));
    const changedPaths = changed.ok ? changed.value.flatMap((root) => root.changed.map((row) => row.path)) : []
    const after = records.get('incident-session')
    const rounds = after === null ? [] : SessionWorkflows.of(after, (runId) => records.get(runId))?.rounds ?? []
    console.log(`  info: after Check again the review lists ${changedPaths.join(', ')}; rounds ${rounds.map((round) => `${round.title} [${round.steps.map((step) => `${step.title}: ${step.state}`).join(', ')}]`).join(' / ')}`)
    this.check('F15 Check again settles the repaired conflicts, rechecks HEAD and opens the review of the session\'s changes, not r2\'s',
      checked.answer.ok && checked.answer.value.actionId === action?.actionId && reviewing?.stage === 'changes' && !actions.opened.includes(worktreePath)
      && ['src/catalog.ts', 'src/wallets.ts'].every((path) => changedPaths.includes(path))
      && changedPaths.some((path) => path.startsWith('.aidocs/engines/t1'))
      && !changedPaths.some((path) => path.startsWith('.aidocs/engines/t2'))
      && after?.worktreeLifecycle?.syncConflictSet?.entries.every((entry) => entry.state === 'settled') === true
      && after.worktreeLifecycle.syncConflictSet.entries.filter((entry) => entry.kind === 'text').every((entry) => entry.by === 'person' && entry.settledWith === 'merged')
      && after.worktreeLifecycle.facts.syncedAt?.revision === landed
      && after.worktreeLifecycle.journal.some((entry) => entry.kind === 'update' && entry.targetRevision === landed && entry.endedAt !== undefined)
      && rounds.flatMap((round) => round.steps).some((step) => step.body?.kind === 'commit' && step.state === 'waits'))
  }

  /**
   * F17/F20 on a second testbed incident: Jamat's rule settled the folder with keep-both on real svn,
   * so `resolveConflict` refuses it as settled; merged of a text file the person edited settles it, and
   * keep-mine of a text file from the CLI, which only the person may choose, is refused.
   */
  private async checkIncidentResolve(): Promise<void> {
    const root = join(this.root, 'resolve-testbed')
    ConflictTestbed.build(root)
    const main = ConflictTestbed.mainOf(root)
    const manager = new SvnWorktreeManager(this.svn)
    const records = await SessionRecordsStore.load(join(this.root, 'resolve-records', 'session-records.json'),
      { snapshotsDirectory: join(this.root, 'resolve-records', 'snapshots'), report: (message) => { throw new Error(message) } })
    const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, 'resolve-script-logs'))
    actions.idleFallback = true
    const provision = await this.provisioned(this.provisionerOf(manager), { directory: main, projectRoot: main }, '007-resolve')
    if (!provision.ok || provision.exitCode !== 0) throw new Error(`the resolve worktree: ${JSON.stringify(provision)}`)
    await records.put({ sessionId: 'resolve-session', kind: 'shell', title: '007 - resolve', createdAt: 0, life: 'ended', binding: null,
      directory: { mode: 'adHoc', path: main }, worktree: { ...provision.worktree, agentStartedAt: 1 } })
    const worktreePath = provision.worktree.worktreePath
    ConflictTestbed.work(worktreePath, 'incident')
    ConflictTestbed.land(root, 'incident')
    await actions.finish('resolve-session')
    const again = await actions.flow.resolveConflict('resolve-session', { path: '.aidocs/engines', option: 'keep-both', confirm: false, requestedBy: 'cli', by: 'agent' })
    const engines = async (folder: string): Promise<string[]> => (await readdir(join(worktreePath, '.aidocs', 'engines', folder)).catch(() => [])).sort()
    const entry = FinishProjection.action(records.get('resolve-session')!)?.conflictSet?.entries.find((candidate) => candidate.path === '.aidocs/engines')
    const status = await this.svn.run(worktreePath, ['status', '--xml', '--non-interactive', '--', '.aidocs/engines'])
    console.log(`  info: Jamat's keep-both on the incident: t1 [${(await engines('t1')).join(', ')}], t2 [${(await engines('t2')).join(', ')}]; a second keep-both: ${JSON.stringify(again)}`)
    this.check('F17/F20 Jamat settles the incident folder with keep-both: the 3 files r2 added are back beside the session\'s files, saved first; a second keep-both is refused',
      !again.ok && again.code === 'invalid-spec'
      && JSON.stringify(await engines('t2')) === JSON.stringify(['brief.md', 'report.md', 'trail.md'])
      && (await engines('t1')).length === 2
      && entry?.by === 'jamat' && entry.settledWith === 'keep-both' && entry.saved !== undefined && existsSync(join(entry.saved, 't1'))
      && !/tree-conflicted="true"/.test(status.stdout)
      && FinishProjection.action(records.get('resolve-session')!)?.needs?.kind === 'conflict')
    const catalog = join(worktreePath, 'src', 'catalog.ts')
    await writeFile(catalog, SmokeSvnWorktree.bothSidesOf(await readFile(catalog, 'utf8')))
    const merged = await actions.flow.resolveConflict('resolve-session', { path: 'src/catalog.ts', option: 'merged', confirm: false, requestedBy: 'cli', by: 'agent' })
    this.check('F17 merged of a text file the person edited settles it on real svn, and the Finish keeps waiting for the last one',
      merged.ok && merged.value.state === 'settled' && merged.value.left === 1 && FinishProjection.action(records.get('resolve-session')!)?.needs?.kind === 'conflict')
    await actions.settled()
    const before = await readFile(join(worktreePath, 'src', 'wallets.ts'), 'utf8')
    const refused = await actions.flow.resolveConflict('resolve-session', { path: 'src/wallets.ts', option: 'keep-mine', confirm: false, requestedBy: 'cli', by: 'agent' })
    this.check('F17 keep-mine of a text file from the CLI answers person-only and changes nothing',
      !refused.ok && refused.code === 'person-only' && await readFile(join(worktreePath, 'src', 'wallets.ts'), 'utf8') === before)
  }

  /**
   * F19 on a third testbed incident: after Jamat's keep-both the person deletes r2's folder outside
   * Jamat, which the commit would carry, and presses Check again. The guard reopens the folder as
   * drops-incoming; keep-both, the markers removed by hand and Check again then open the review of
   * the session's changes, without r2's files.
   */
  private async checkIncidentGuard(): Promise<void> {
    const root = join(this.root, 'guard-testbed')
    ConflictTestbed.build(root)
    const main = ConflictTestbed.mainOf(root)
    const manager = new SvnWorktreeManager(this.svn)
    const records = await SessionRecordsStore.load(join(this.root, 'guard-records', 'session-records.json'),
      { snapshotsDirectory: join(this.root, 'guard-records', 'snapshots'), report: (message) => { throw new Error(message) } })
    const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, 'guard-script-logs'))
    actions.idleFallback = true
    const provision = await this.provisioned(this.provisionerOf(manager), { directory: main, projectRoot: main }, '008-guard')
    if (!provision.ok || provision.exitCode !== 0) throw new Error(`the guard worktree: ${JSON.stringify(provision)}`)
    await records.put({ sessionId: 'guard-session', kind: 'shell', title: '008 - guard', createdAt: 0, life: 'ended', binding: null,
      directory: { mode: 'adHoc', path: main }, worktree: { ...provision.worktree, agentStartedAt: 1 } })
    const worktreePath = provision.worktree.worktreePath
    ConflictTestbed.work(worktreePath, 'incident')
    const landed = ConflictTestbed.land(root, 'incident')
    await actions.finish('guard-session')
    await this.svn.run(worktreePath, ['delete', '--non-interactive', '--', '.aidocs/engines/t2'])
    const before = actions.opened.length
    let refused = false
    try { await actions.finish('guard-session') } catch (error) { refused = String(error).includes('changed outside Jamat') }
    this.check('F19 an outside svn deletion first stops at changed-outside and publishes nothing',
      refused && records.get('guard-session')?.worktreeLifecycle?.wait?.kind === 'changed-outside' && actions.opened.length === before)
    // Fixture setup isolates the incoming-loss guard after the separate outside-writer refusal.
    await actions.commands.lease.within(worktreePath, 'finish', () => actions.commands.accept(worktreePath))
    const caught = await actions.finish('guard-session')
    const info = caught.action === undefined ? null : SvnActionStages.infoOf(caught.action)
    const engines = info?.conflicts?.entries.find((entry) => entry.path === '.aidocs/engines')
    console.log(`  info: Check again after deleting r2's folder: ${caught.action?.needs?.reason ?? 'no wait'}; ${engines?.description ?? ''}`)
    this.check('F19 Check again after the person deleted what r2 added below the fixed folder waits again: the folder needs you, the commit would drop r2\'s files',
      caught.action?.needs?.kind === 'conflict' && caught.action.stage === 'fixing' && engines?.state === 'person'
      && caught.action.needs.reason.startsWith(`the commit would drop what r${landed} brought in below .aidocs/engines`)
      && JSON.stringify(engines.options.map((option) => option.id)) === JSON.stringify(['keep-both', 'keep-mine']))

    const settled = await actions.flow.resolveConflict('guard-session', { path: '.aidocs/engines', option: 'keep-both', confirm: false, requestedBy: 'window', by: 'person' })
    await actions.settled()
    for (const file of ['src/catalog.ts', 'src/wallets.ts']) {
      const path = join(worktreePath, ...file.split('/'))
      await writeFile(path, SmokeSvnWorktree.bothSidesOf(await readFile(path, 'utf8')))
    }
    actions.decision.of = () => 'cancel'
    const checked = await actions.finish('guard-session')
    const changedRoots = await manager.reviewRoots(worktreePath)
    const changed = changedRoots.ok ? changedRoots.value.flatMap((root) => root.changed.map((row) => row.path)) : []
    console.log(`  info: repeated keep-both: ${JSON.stringify(settled)}; journal ${JSON.stringify(records.get('guard-session')?.worktreeLifecycle?.syncConflictSet?.entries.find((entry) => entry.path === '.aidocs/engines')?.journal)}`)
    console.log(`  info: after keep-both and Check again the review lists ${changed.join(', ')}`)
    this.check('F19 keep-both, the markers removed by hand and Check again open the review of the session\'s changes; r2\'s files are not in it',
      settled.ok && settled.value.state === 'settled' && checked.action?.stage === 'changes' && !actions.opened.includes(worktreePath)
      && ['src/catalog.ts', 'src/wallets.ts'].every((path) => changed.includes(path))
      && changed.some((path) => path.startsWith('.aidocs/engines/t1')) && !changed.some((path) => path.startsWith('.aidocs/engines/t2')))
  }

  /**
   * F20, the incident as it happened: two worktree sessions of one main copy each add an engine trail
   * under the new `.aidocs/engines`, the first commits through its Finish, and the second Finish meets
   * the tree conflict. Jamat's rule keeps both trails, nothing waits, and the review commits both; the
   * result names what Jamat fixed.
   */
  private async checkIncidentRule(): Promise<void> {
    const root = join(this.root, 'rule-testbed')
    ConflictTestbed.build(root)
    const main = ConflictTestbed.mainOf(root)
    const manager = new SvnWorktreeManager(this.svn)
    const records = await SessionRecordsStore.load(join(this.root, 'rule-records', 'session-records.json'),
      { snapshotsDirectory: join(this.root, 'rule-records', 'snapshots'), report: (message) => { throw new Error(message) } })
    const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, 'rule-script-logs'))
    const trails = { 'rule-first': ['t1', ['brief.md', 'report.md']], 'rule-second': ['t2', ['brief.md', 'report.md', 'trail.md']] } as const
    const worktrees = new Map<string, string>()
    for (const [sessionId, [trail, files]] of Object.entries(trails)) {
      const provision = await this.provisioned(this.provisionerOf(manager), { directory: main, projectRoot: main }, `00${worktrees.size + 1}-${sessionId}`)
      if (!provision.ok || provision.exitCode !== 0) throw new Error(`the ${sessionId} worktree: ${JSON.stringify(provision)}`)
      await records.put({ sessionId, kind: 'shell', title: sessionId, createdAt: 0, life: 'ended', binding: null,
        directory: { mode: 'adHoc', path: main }, worktree: { ...provision.worktree, agentStartedAt: 1 } })
      const folder = join(provision.worktree.worktreePath, '.aidocs', 'engines', trail)
      await mkdir(folder, { recursive: true })
      for (const file of files) await writeFile(join(folder, file), `${file} of ${trail}\n`)
      worktrees.set(sessionId, provision.worktree.worktreePath)
    }
    await this.svn.run(worktrees.get('rule-first') ?? '', ['add', '--non-interactive', '--parents', '--', '.aidocs/engines/t1'])
    const first = await actions.finish('rule-first')
    if (first.outcome?.result !== 'committed') throw new Error(`F20 first trail did not commit: ${JSON.stringify(first)}`)
    const changedTrail = await actions.finish('rule-second')
    const second = changedTrail.action?.stage === 'changes' ? await actions.finish('rule-second') : changedTrail
    const head = await this.svn.run(root, ['list', '-R', '--non-interactive', `${ConflictTestbed.urlOf(root)}/.aidocs/engines`])
    const listed = head.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.endsWith('.md')).sort()
    const lines = second.outcome?.lines ?? []
    const result = actions.results.list({ sessionId: 'rule-second' })[0]
    console.log(`  info: the second Finish of the incident: ${lines.join(' | ')}; .aidocs/engines at HEAD: ${listed.join(', ')}`)
    this.check('F20 two worktrees each add an engine trail, the first commits, and the second Finish keeps both without a wait: its review commits both trails',
      first.outcome?.result === 'committed' && second.outcome?.result === 'committed' && second.action?.stage === 'main-update'
      && actions.opened.includes(worktrees.get('rule-second') ?? '')
      && JSON.stringify(listed) === JSON.stringify(['t1/brief.md', 't1/report.md', 't2/brief.md', 't2/report.md', 't2/trail.md']))
    this.check('F20 the result of the second Finish names what Jamat fixed and where the saved copies are',
      lines.includes('FIXED: .aidocs/engines (keep both)') && lines.some((line) => line.startsWith('   saved copies: '))
      && result?.lines.includes('FIXED: .aidocs/engines (keep both)') === true)
  }

  /**
   * F20b, the incident with a same-name file (UA1-J04-1): both worktrees add the new `.aidocs/engines`
   * with their own run and a differing shared `brief.md`, and nothing else conflicts. Jamat's keep-both
   * settles the folder, the brief stays open for the person as `diverged` with the session's copy
   * saved, and nothing publishes until the person settles it; the review then commits both runs and
   * the merged brief, and the history names what Jamat kept and where it saved the copy.
   */
  private async checkIncidentSameName(): Promise<void> {
    const root = join(this.root, 'same-name-testbed')
    ConflictTestbed.build(root)
    const main = ConflictTestbed.mainOf(root)
    const manager = new SvnWorktreeManager(this.svn)
    const records = await SessionRecordsStore.load(join(this.root, 'same-name-records', 'session-records.json'),
      { snapshotsDirectory: join(this.root, 'same-name-records', 'snapshots'), report: (message) => { throw new Error(message) } })
    const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, 'same-name-script-logs'))
    actions.idleFallback = true
    const worktrees = new Map<string, string>()
    for (const [sessionId, run] of [['same-first', 'run-w1'], ['same-second', 'run-w2']] as const) {
      const provision = await this.provisioned(this.provisionerOf(manager), { directory: main, projectRoot: main }, `00${worktrees.size + 1}-${sessionId}`)
      if (!provision.ok || provision.exitCode !== 0) throw new Error(`the ${sessionId} worktree: ${JSON.stringify(provision)}`)
      await records.put({ sessionId, kind: 'shell', title: sessionId, createdAt: 0, life: 'ended', binding: null,
        directory: { mode: 'adHoc', path: main }, worktree: { ...provision.worktree, agentStartedAt: 1 } })
      const engines = join(provision.worktree.worktreePath, '.aidocs', 'engines')
      await mkdir(join(engines, run), { recursive: true })
      await writeFile(join(engines, run, 'result.md'), `result of ${run}\n`)
      await writeFile(join(engines, 'brief.md'), `brief\n${run}\n`)
      worktrees.set(sessionId, provision.worktree.worktreePath)
    }
    const second = worktrees.get('same-second') ?? ''
    await this.svn.run(worktrees.get('same-first') ?? '', ['add', '--non-interactive', '--parents', '--', '.aidocs/engines'])
    const first = await actions.finish('same-first')
    if (first.outcome?.result !== 'committed') throw new Error(`F20b first run did not commit: ${JSON.stringify(first)}`)
    const waited = await actions.finish('same-second')
    const record = records.get('same-second')
    const entries = record?.worktreeLifecycle?.syncConflictSet?.entries ?? []
    const brief = entries.find((entry) => entry.path === '.aidocs/engines/brief.md')
    const steps = (record === null ? null : SessionWorkflows.of(record, (runId) => records.get(runId)))?.rounds.flatMap((round) => round.steps) ?? []
    const listed = steps.flatMap((step) => step.body?.kind === 'conflicts' ? step.body.conflicts?.entries ?? [] : [])
    console.log(`  info: F20b after the second Finish: ${entries.map((entry) => `${entry.path} (${entry.kind}) ${entry.state}${entry.settledWith === undefined ? '' : ` ${entry.settledWith}`}`).join('; ')}`)
    this.check('F20b keep-both settles the new parent and leaves the differing same-name brief open for the person; nothing publishes',
      !actions.opened.includes(second) && waited.action?.needs?.kind === 'conflict'
      && entries.some((entry) => entry.kind === 'tree' && entry.state === 'settled' && entry.by === 'jamat' && entry.settledWith === 'keep-both')
      && brief?.kind === 'diverged' && brief.state === 'person' && brief.saved !== undefined
      && await readFile(brief.saved, 'utf8') === 'brief\nrun-w2\n'
      && await readFile(join(second, '.aidocs', 'engines', 'brief.md'), 'utf8') === 'brief\nrun-w1\n'
      && existsSync(join(second, '.aidocs', 'engines', 'run-w1', 'result.md')) && existsSync(join(second, '.aidocs', 'engines', 'run-w2', 'result.md'))
      && listed.some((entry) => entry.path === '.aidocs/engines/brief.md' && entry.state === 'person'
        && JSON.stringify(entry.options.map((option) => option.id)) === JSON.stringify(['merged', 'take-incoming', 'keep-mine'])))
    await writeFile(join(second, '.aidocs', 'engines', 'brief.md'), 'brief\nrun-w1\nrun-w2\n')
    // The product accepts svn state the person changes before the review (guardsSvnState); this harness answers stop.
    assert(!WorktreeTransitions.guardsSvnState(records.get('same-second')!.worktreeLifecycle!))
    await actions.commands.accept(second)
    const merged = await actions.flow.resolveConflict('same-second', { path: '.aidocs/engines/brief.md', option: 'merged', confirm: false, requestedBy: 'window', by: 'person' })
    await actions.flow.start('same-second', { choice: 'commit', requestedBy: 'window' })
    await actions.settled()
    const review = records.get('same-second')
    const history = (review === null ? null : SessionWorkflows.of(review, (runId) => records.get(runId)))?.rounds.flatMap((round) => round.steps) ?? []
    const fixing = history.find((step) => step.title === 'Check the conflicts' && step.state === 'done')
    const reviewing = await actions.finish('same-second')
    const published = reviewing.action?.stage === 'changes' ? await actions.finish('same-second') : reviewing
    const head = async (path: string) => (await this.svn.run(root, ['cat', '--non-interactive', `${ConflictTestbed.urlOf(root)}/${path}`])).stdout.replace(/\r\n/g, '\n')
    console.log(`  info: F20b after the person merged the brief: ${JSON.stringify(merged)}; ${published.outcome?.lines.join(' | ')}; history: ${fixing?.detail ?? 'no done check of the conflicts'}`)
    this.check('F20b once the person merged the brief, the review commits both runs and the merged brief',
      merged.ok && published.outcome?.result === 'committed' && actions.opened.includes(second)
      && await head('.aidocs/engines/brief.md') === 'brief\nrun-w1\nrun-w2\n'
      && await head('.aidocs/engines/run-w1/result.md') === 'result of run-w1\n' && await head('.aidocs/engines/run-w2/result.md') === 'result of run-w2\n')
    this.check('F20b the review keeps a done check of the conflicts in the Finish history, naming the keep-both and its saved copy',
      review?.worktreeLifecycle?.step === 'reviewing' && fixing !== undefined
      && /^2 conflicts: Jamat fixed 1, you fixed 1; \.aidocs\S* \(keep both\), saved copy: \S/.test(fixing.detail))
  }

  /**
   * CF23 (UA1-J05-1): `src/both.txt` carries a text and a property conflict after one update. The
   * Finish lists them as two open entries; settling one leaves the other open, svn's mark on the path
   * and the Finish waiting, in either order; each kind keeps the side the person chose, the property
   * entry's saved copy holds the `.prej`, and the publication carries both choices.
   */
  private async checkTextAndProperty(): Promise<void> {
    for (const order of ['text-first', 'property-first'] as const) {
      const id = `CF23-${order}`
      const repository = await SvnFixtureRepository.create(join(this.root, `${id}-repository`), this.svn)
      const owner = join(this.root, `${id}-main`)
      await repository.run(this.root, ['checkout', repository.url, owner])
      await mkdir(join(owner, 'src'), { recursive: true })
      await writeFile(join(owner, 'src', 'both.txt'), 'one\nbase\nthree\n')
      await repository.run(owner, ['add', '--', 'src'])
      await repository.run(owner, ['propset', 'jamat:test', 'base', 'src/both.txt'])
      await repository.run(owner, ['propset', 'svn:global-ignores', '.worktrees', '.'])
      await repository.run(owner, ['commit', '-m', 'seed'])
      await repository.run(owner, ['update'])
      const manager = new SvnWorktreeManager(this.svn)
      const records = await SessionRecordsStore.load(join(this.root, `${id}-records.json`), { snapshotsDirectory: join(this.root, `${id}-snapshots`) })
      const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, `${id}-logs`))
      const made = await manager.create({ ownerDir: owner, folder: `001-${id.toLowerCase()}` })
      if (!made.ok) throw new Error(made.detail)
      const tree = made.value.worktreePath
      await records.put({ sessionId: id, kind: 'agent', title: id, createdAt: Date.now(), life: 'ended', binding: null,
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: `fixture-${id}` }, directory: { mode: 'adHoc', path: owner },
        worktree: { kind: 'svn', worktreePath: tree, repositoryRoot: owner, branch: made.value.url, baseCommit: `r${made.value.baseRevision}`,
          agentStartedAt: Date.now(), ...(made.value.directoryId === null ? {} : { directoryId: made.value.directoryId }) } })
      await writeFile(join(tree, 'src', 'both.txt'), 'one\nmine\nthree\n')
      await repository.run(tree, ['propset', 'jamat:test', 'both-w1', 'src/both.txt'])
      await writeFile(join(owner, 'src', 'both.txt'), 'one\ntheirs\nthree\n')
      await repository.run(owner, ['propset', 'jamat:test', 'both-t', 'src/both.txt'])
      await repository.run(owner, ['commit', '-m', 'incoming text and property'])
      await actions.flow.start(id, { choice: 'commit', requestedBy: 'window' })
      await actions.settled()
      const entries = () => records.get(id)?.worktreeLifecycle?.syncConflictSet?.entries.filter((entry) => entry.path === 'src/both.txt') ?? []
      const lifecycle = records.get(id)?.worktreeLifecycle
      console.log(`  info: ${id} after the Finish: step ${lifecycle?.step}, wait ${lifecycle?.wait?.reason ?? 'none'}; `
        + (lifecycle?.syncConflictSet?.entries ?? []).map((entry) => `${entry.path} (${entry.kind}) ${entry.state}`).join('; '))
      this.check(`${id} the text and the property conflict of one file are two open entries`,
        JSON.stringify(entries().map((entry) => [entry.kind, entry.state === 'settled'])) === JSON.stringify([['text', false], ['property', false]]))
      const marks = async () => SvnConflictFacts.conflictedRows(await repository.run(tree, ['status', '--xml', '--', 'src/both.txt']), tree)[0] ?? null
      const property = async () => (await repository.run(tree, ['propget', 'jamat:test', '--', 'src/both.txt'])).trim()
      const merged = 'one\nmine and theirs\nthree\n'
      const settleText = async () => {
        await writeFile(join(tree, 'src', 'both.txt'), merged)
        await actions.commands.accept(tree)
        return actions.flow.resolveConflict(id, { path: 'src/both.txt', kind: 'text', option: 'merged', confirm: false, requestedBy: 'window', by: 'person' })
      }
      const settleProperty = () => actions.flow.resolveConflict(id, { path: 'src/both.txt', kind: 'property', option: 'take-incoming', confirm: false, requestedBy: 'window', by: 'person' })
      const first = order === 'text-first' ? await settleText() : await settleProperty()
      const open = entries().filter((entry) => entry.state !== 'settled').map((entry) => entry.kind)
      const mark = await marks()
      console.log(`  info: ${id} after the first choice: ${JSON.stringify(first)}; open ${open.join(', ')}; svn marks ${JSON.stringify(mark)}`)
      this.check(`${id} settling one kind leaves the other open, marked by svn, and the Finish waiting`,
        first.ok && first.value.left === 1 && JSON.stringify(open) === JSON.stringify([order === 'text-first' ? 'property' : 'text'])
        && (order === 'text-first' ? mark?.property === true && await property() === 'both-w1'
          : mark?.text === true && await property() === 'both-t' && /^<{7} \.mine/m.test(await readFile(join(tree, 'src', 'both.txt'), 'utf8')))
        && records.get(id)?.worktreeLifecycle?.step === 'worker-resolving' && actions.opened.length === 0)
      const second = order === 'text-first' ? await settleProperty() : await settleText()
      const saved = entries().find((entry) => entry.kind === 'property')?.saved
      console.log(`  info: ${id} after the second choice: ${JSON.stringify(second)}; property saved at ${saved}`)
      this.check(`${id} the second kind resolves the path with both choices, and the property's saved copy holds the .prej`,
        second.ok && second.value.left === 0 && await marks() === null && await property() === 'both-t'
        && await readFile(join(tree, 'src', 'both.txt'), 'utf8') === merged && saved !== undefined && existsSync(`${saved}.prej`))
      const reviewing = await actions.finish(id)
      const published = reviewing.outcome?.result === 'committed' ? reviewing : await actions.finish(id)
      console.log(`  info: ${id} publication: ${published.outcome?.lines.join(' | ')}`)
      this.check(`${id} the publication carries the merged text and the incoming property`, published.outcome?.result === 'committed'
        && (await repository.run(owner, ['cat', `${repository.url}/src/both.txt@HEAD`])).replace(/\r\n/g, '\n') === merged
        && (await repository.run(owner, ['propget', 'jamat:test', `${repository.url}/src/both.txt@HEAD`])).trim() === 'both-t')
    }
  }

  /**
   * F21, the lossless rules end to end: for the testbed's `eol`, `binary`, `props` and `delete`
   * scenarios a worktree session's Finish Commit never waits. A conflict svn leaves is settled by its
   * rule and named in a `FIXED:` line; equal binary content svn settles itself.
   */
  private async checkLosslessRules(): Promise<void> {
    const expected = {
      eol: 'FIXED: src/catalog.ts (take incoming)',
      binary: null,
      props: 'FIXED: . (union)',
      delete: 'FIXED: src/legacy.ts (merged)',
    } as const
    for (const [scenario, line] of Object.entries(expected) as [keyof typeof expected, string | null][]) {
      const root = join(this.root, `lossless-${scenario}`)
      ConflictTestbed.build(root)
      const main = ConflictTestbed.mainOf(root)
      const manager = new SvnWorktreeManager(this.svn)
      const records = await SessionRecordsStore.load(join(this.root, `lossless-${scenario}-records`, 'session-records.json'),
        { snapshotsDirectory: join(this.root, `lossless-${scenario}-records`, 'snapshots'), report: (message) => { throw new Error(message) } })
      const actions = new SmokeSvnActions(records, manager, this.svn, join(this.root, `lossless-${scenario}-logs`))
      const provision = await this.provisioned(this.provisionerOf(manager), { directory: main, projectRoot: main }, `009-${scenario}`)
      if (!provision.ok || provision.exitCode !== 0) throw new Error(`the ${scenario} worktree: ${JSON.stringify(provision)}`)
      await records.put({ sessionId: scenario, kind: 'shell', title: scenario, createdAt: 0, life: 'ended', binding: null,
        directory: { mode: 'adHoc', path: main }, worktree: { ...provision.worktree, agentStartedAt: 1 } })
      ConflictTestbed.work(provision.worktree.worktreePath, scenario)
      ConflictTestbed.land(root, scenario)
      const first = await actions.finish(scenario)
      const finished = first.action?.stage === 'changes' ? await actions.finish(scenario) : first
      const lines = finished.outcome?.lines ?? []
      const ignore = scenario === 'props'
        ? (await this.svn.run(root, ['propget', 'svn:ignore', '--non-interactive', ConflictTestbed.urlOf(root)])).stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
        : []
      console.log(`  info: Finish of the testbed ${scenario}: ${finished.action?.needs?.reason ?? 'no wait'}; ${lines.join(' | ')}${scenario === 'props' ? `; svn:ignore at HEAD: ${ignore.join(', ')}` : ''}`)
      this.check(`F21 the testbed ${scenario} Finish reaches its end without a wait${line === null ? ', svn settles it itself' : `, its result names ${line}`}`,
        finished.answer.ok && (finished.outcome?.result === 'committed' ? finished.action?.stage === 'main-update'
          : finished.outcome?.result === 'nothing' && finished.outcome.revisions.length === 0 && !existsSync(provision.worktree.worktreePath))
        && (line === null ? !lines.some((entry) => entry.startsWith('FIXED:')) : lines.includes(line))
        && (scenario !== 'props' || JSON.stringify(ignore) === JSON.stringify(['node_modules', 'coverage', 'dist'])))
      if (scenario === 'delete')
        this.check('F21 scheduling the missing path before sync retains the agreed deletion without another publication', finished.outcome?.result === 'nothing'
          && !(await this.svn.run(root, ['list', '-R', '--non-interactive', ConflictTestbed.urlOf(root)])).stdout.includes('src/legacy.ts'))
      if (scenario === 'props') {
        await actions.flow.startUpdate(scenario, main, 'window')
        await actions.settled()
        const landed = await manager.landingProof(main, actions.results.list({ sessionId: scenario })[0].revisions)
        this.check('F21 root-property UPDATE proves the exact repository root publication', landed.ok && landed.value.holds)
      }
    }
  }

  /** What a person makes of svn's markers by hand: both sides kept, the base section and every marker line gone. */
  private static bothSidesOf(text: string): string {
    let base = false
    return text.split(/(?<=\n)/).filter((line) => {
      if (/^\|{7}/.test(line)) base = true
      else if (/^={7}/.test(line)) base = false
      else if (!/^(?:<{7}|>{7})/.test(line)) return !base
      return false
    }).join('')
  }

  /**
   * The removal after a session's end (Jamat#37), on a disposable owner: each record carries the
   * cleanup its trigger writes and has ended, and a fresh records store stands for the next client
   * start. The reconciler's verdict and the flow's apply then judge it, as they do in the app.
   */
  private async checkCleanup(): Promise<void> {
    const repository = await SvnFixtureRepository.create(join(this.root, 'cleanup-repository'), this.svn)
    await repository.run(this.root, ['mkdir', '--parents', '-m', 'layout', `${repository.url}/Project`])
    const owner = join(this.root, 'cleanup-owner')
    await repository.run(this.root, ['checkout', `${repository.url}/Project`, owner])
    await writeFile(join(owner, 'a.txt'), 'one\n')
    await repository.run(owner, ['add', '--', 'a.txt'])
    await repository.run(owner, ['propset', 'svn:global-ignores', '.worktrees', '--', '.'])
    await repository.run(owner, ['commit', '-m', 'project'])
    await repository.run(owner, ['update'])

    const manager = new SvnWorktreeManager(this.svn)
    const recordsFile = join(this.root, 'cleanup-records', 'session-records.json')
    const options = {
      snapshotsDirectory: join(this.root, 'cleanup-records', 'snapshots'),
      report: (message: string) => { throw new Error(message) },
    }
    const ended = new Set<string>()
    const landedDue: string[] = []
    const landedRows = new LandedRows({ svn: manager, now: () => Date.now() })
    let records = await SessionRecordsStore.load(recordsFile, options)
    const endedAt = Date.now() - 60_000
    const sessionWith = async (sessionId: string, folder: string, trigger: 'committed' | 'remove-when-ended'): Promise<string> => {
      const checkout = await manager.create({ ownerDir: owner, folder })
      if (!checkout.ok) throw new Error(checkout.detail)
      await records.put({
        sessionId, kind: 'shell', title: `014 - ${folder}`, createdAt: 0, life: 'ended', binding: null,
        exitReason: 'stopped', endedAt, directory: { mode: 'adHoc', path: owner },
        worktree: {
          worktreePath: checkout.value.worktreePath, branch: checkout.value.url, baseCommit: `r${checkout.value.baseRevision}`,
          repositoryRoot: owner, kind: 'svn', agentStartedAt: 1, ...checkout.value.directoryId === null ? {} : { directoryId: checkout.value.directoryId },
        },
        worktreeCleanup: WorktreeCleanupPacing.pending(trigger, endedAt),
      })
      return checkout.value.worktreePath
    }
    const commitFrom = async (worktree: string, text: string): Promise<void> => {
      await writeFile(join(worktree, 'a.txt'), text)
      await repository.run(worktree, ['commit', '-m', 'from the worktree', '--', '.'])
    }

    const committed = await sessionWith('committed', '014-committed', 'committed')
    await commitFrom(committed, 'one\ncommitted\n')
    await repository.run(owner, ['update'])
    const changed = await sessionWith('changed', '015-changed', 'remove-when-ended')
    await writeFile(join(changed, 'notes.txt'), 'left behind\n')

    // A dependency store linked in and a deep build tree, both ignored the way a project ignores them.
    const store = join(this.root, 'cleanup-shared-store')
    await mkdir(store)
    await writeFile(join(store, 'precious.txt'), 'keep\n')
    const linked = await sessionWith('linked', '016-linked', 'remove-when-ended')
    await symlink(store, join(linked, 'linked'), 'junction')
    const deep = join(linked, ...Array.from({ length: 12 }, (_, index) => `segment-${index}-of-a-long-path`))
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, 'leaf.txt'), 'leaf\n')
    const ignores = join(this.root, 'cleanup-ignores.txt')
    await writeFile(ignores, 'linked\nsegment-0-of-a-long-path\n')
    await repository.run(linked, ['propset', 'svn:ignore', '-F', ignores, '--', '.'])
    await repository.run(linked, ['commit', '-m', 'ignore the scratch', '--', '.'])
    await repository.run(owner, ['update'])
    this.check('R15 the cleanup fixture holds a path beyond 260 characters', join(deep, 'leaf.txt').length > 260)

    const unlanded = await sessionWith('unlanded', '017-unlanded', 'committed')
    await commitFrom(unlanded, 'one\ncommitted\nunlanded\n')

    // A commit from the session's split, which leaves the receipt the commit dialog writes.
    const splitCommitted = await sessionWith('split-committed', '019-split', 'committed')
    await writeFile(join(splitCommitted, 'a.txt'), 'one\ncommitted\nunlanded\nsplit\n')
    const splitRevision = /Committed revision (\d+)/.exec(await repository.run(splitCommitted, ['commit', '-m', 'from the split', '--', '.']))?.[1]
    const splitRecord = records.get('split-committed')
    if (splitRevision === undefined || splitRecord === null) throw new Error('the split commit left no revision or no record')
    await records.put({ ...splitRecord, commitReceipts: [{ scopeRoot: splitCommitted, revision: Number(splitRevision), paths: ['a.txt'], at: Date.now() }] })

    // A failed setup ran no process of the session's own: it ends with a reason and no exit, and its install exited 1.
    const failedSetup = await sessionWith('failed-setup', '018-failed-setup', 'remove-when-ended')
    const failedRecord = records.get('failed-setup')
    if (!failedRecord) throw new Error('the failed setup has no record')
    await records.put({
      ...failedRecord, exitReason: undefined, endedReason: 'setup failed: the setup exited with 1',
      pendingSetup: { setupSessionId: 'failed-install' },
    })
    await records.put({
      sessionId: 'failed-install', kind: 'shell', title: 'setup', createdAt: 0, life: 'ended', binding: null,
      exitCode: 1, exitReason: 'process-exit', endedAt, directory: { mode: 'adHoc', path: failedSetup },
      commands: [{ command: 'pnpm install', cwd: failedSetup }],
      scriptOf: { sessionId: 'failed-setup', phase: 'before', scriptId: 'setup', name: 'setup' },
    })
    await records.settled()

    // The client restarts: what the records file holds is all the next client knows.
    records = await SessionRecordsStore.load(recordsFile, options)
    const cleanupResults = new WorktreeResultsStore(join(this.root, 'cleanup-results'), {
      now: () => Date.now(), logs: new ScriptLogStore(join(this.root, 'cleanup-logs')), report: () => undefined,
    })
    const steps = new SessionSteps({ changed: () => undefined, now: () => Date.now() })
    const flow = new SvnWorktreeFinishFlow({
      records, svn: manager, steps,
      removal: new SvnWorktreeRemoval({ records, skillRoots: [], svn: manager, onQueue: (work) => work(), changed: () => undefined, steps }),
      actions: { start: () => { throw new Error('a cleanup presses nothing') }, settled: () => { throw new Error('a cleanup presses nothing') } },
      labels: new SvnRevisionLabels(manager),
      results: cleanupResults,
      changed: () => undefined,
      ended: (sessionId) => { ended.add(sessionId) },
      landedDue: (mainCopy) => { landedDue.push(mainCopy) },
      report: () => undefined,
    })
    const landedOf = (sessionId: string) => {
      const record = records.get(sessionId)
      return record === null || record.completed !== undefined || ended.has(sessionId) ? null : LandedRows.landingOf(record)
    }
    const startedAt = Date.now()
    const judge = async (): Promise<string[]> => {
      const due = Reconciler.plan(records.list(), { sessions: [], throughRevision: 0, hostInstanceId: 'smoke-host' }, Date.now(), startedAt)
        .flatMap((change) => change.kind === 'clean-worktree' ? [change.sessionId] : [])
      for (const sessionId of due) {
        const current = records.get(sessionId)
        if (current?.worktreeCleanup === undefined) throw new Error(`${sessionId} has no cleanup to attempt`)
        await records.put({ ...current, worktreeCleanup: WorktreeCleanupPacing.attempted(current.worktreeCleanup, Date.now()) })
        await flow.cleanUp(sessionId)
      }
      return due.sort()
    }

    const first = await judge()
    this.check('R11 the first judgement after a client start takes every pending cleanup of an ended session',
      JSON.stringify(first) === JSON.stringify(['changed', 'committed', 'failed-setup', 'linked', 'split-committed', 'unlanded']))
    this.check('Scripts R13 a failed setup of a session removed when it ends loses its worktree on the first judgement, and the session ends',
      !existsSync(failedSetup) && records.get('failed-setup')?.retiredWorktree?.worktreePath === failedSetup
      && records.get('failed-setup')?.worktree === undefined && ended.has('failed-setup'))
    const committedLanding = landedOf('committed')
    this.check('R12 a session whose worktree committed loses it after its end and a client restart, and stays as a landed row',
      !existsSync(committed) && records.get('committed')?.retiredWorktree?.worktreePath === committed
      && committedLanding?.mainCopy === owner && landedDue.includes(owner))
    this.check('L8 a worktree whose landing already updated the main copy (pp 7.3): the cleanup result is committed, and the main copy holds it at once',
      await landedRows.holds(owner, committedLanding?.landed ?? []) === true
      && cleanupResults.list({ sessionId: 'committed' }).some((entry) => entry.action === 'cleanup' && entry.result === 'committed'))
    this.check('R13 a worktree with a change left is kept with the count, and its session stays',
      existsSync(join(changed, 'notes.txt')) && records.get('changed')?.worktreeCleanup?.phase === 'kept'
      && records.get('changed')?.worktreeCleanup?.reason === '1 change' && !ended.has('changed'))
    this.check('R15 the cleanup removes a worktree with a junction and a long path, and the linked store survives',
      !existsSync(linked) && await readFile(join(store, 'precious.txt'), 'utf8') === 'keep\n' && landedOf('linked') !== null)
    const unlandedLanding = landedOf('unlanded')
    this.check('R14 a clean worktree whose commit the main copy lacks goes all the same, and its session stays as a landed row',
      !existsSync(unlanded) && unlandedLanding !== null && await readFile(join(owner, 'a.txt'), 'utf8') === 'one\ncommitted\n'
      && await landedRows.holds(owner, unlandedLanding.landed) === false)
    const splitResult = cleanupResults.list({ sessionId: 'split-committed' })
    this.check('R9 the cleanup of a worktree that committed from its split writes a committed cleanup result labelled by the receipt',
      !existsSync(splitCommitted) && landedOf('split-committed') !== null && splitResult.length === 1
      && splitResult[0].action === 'cleanup' && splitResult[0].result === 'committed' && splitResult[0].removal === 'removed'
      && JSON.stringify(splitResult[0].revisions.map((entry) => `${entry.label} r${entry.revision}`)) === JSON.stringify([`receipt r${splitRevision}`]))
    await repository.run(owner, ['update'])
    this.check('R14 an update of the main copy by any client brings the landed revision in',
      await landedRows.holds(owner, unlandedLanding?.landed ?? []) === true)
    this.check('R14 a kept cleanup is not judged again at once', (await judge()).length === 0 && existsSync(changed))

    // What `sessions.cleanupWorktree` writes for a kept worktree once its change was taken care of.
    await rm(join(changed, 'notes.txt'))
    const kept = records.get('changed')
    if (kept === null) throw new Error('the kept session has no record')
    await records.put({ ...kept, worktreeCleanup: WorktreeCleanupPacing.pending('requested', Date.now()) })
    this.check('R13 a requested cleanup judges a kept worktree again at once and removes it once nothing is left',
      JSON.stringify(await judge()) === JSON.stringify(['changed']) && !existsSync(changed) && ended.has('changed'))
    await records.settled()
  }

  /**
   * The working-copy lock another svn client holds while it works (E155004), written into the
   * working copy's own `wc.db` the way svn writes it, and taken away again the same way.
   */
  private static async workingCopyLock(workingCopy: string, locked: boolean): Promise<void> {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(join(workingCopy, '.svn', 'wc.db'))
    try {
      database.exec(locked
        ? "INSERT INTO WC_LOCK (wc_id, local_dir_relpath, locked_levels) VALUES (1, '', -1)"
        : 'DELETE FROM WC_LOCK')
    } finally { database.close() }
  }

  /** A node process whose working directory is `cwd`, started and running once this resolves. */
  private static async holder(cwd: string, script: string): Promise<ChildProcess> {
    const child = spawn(process.execPath, ['-e', `${script}; console.log('ready')`], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdout?.once('data', () => resolve())
    })
    return child
  }

  private static async release(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()) })
    child.kill()
    await exited
  }

  /** Disposable paths become placeholders, and nothing that names this PC or its user may remain. */
  private anonymized(text: string, placeholders: readonly [string, string][]): string {
    let result = text.replace(/\r\n/g, '\n')
      .replace(/<date>[^<]*<\/date>/g, '<date>2026-01-01T00:00:00.000000Z</date>')
      .replace(/<text-updated>[^<]*<\/text-updated>/g, '<text-updated>2026-01-01T00:00:00.000000Z</text-updated>')
      .replace(/<uuid>[^<]*<\/uuid>/g, '<uuid>00000000-0000-0000-0000-000000000000</uuid>')
    for (const [path, placeholder] of placeholders)
      for (const form of new Set([path, path.replaceAll('\\', '/')]))
        result = result.replaceAll(form, placeholder)
    const leaks = [this.root, this.root.replaceAll('\\', '/'), userInfo().username, hostname()]
      .filter((value) => value.length > 0 && result.toLowerCase().includes(value.toLowerCase()))
    if (leaks.length > 0) throw new Error(`A fixture would name this machine: ${leaks.join(', ')}`)
    return result
  }

  /**
   * Writes a fixture unless it differs from the committed one only in attribute order: svn 1.14
   * orders the attributes of an element by a hash seeded per process, so two captures of the same
   * facts differ in bytes. Answers 1 when it wrote.
   */
  private static async writeFixture(path: string, text: string): Promise<number> {
    const sorted = (xml: string) => xml.replace(/<([\w-]+)((?:\s+[\w-]+="[^"]*")+)\s*(\/?)>/g,
      (_, name: string, attributes: string, closed: string) => `<${name} ${attributes.trim().split(/\s+(?=[\w-]+=")/).sort().join(' ')}${closed}>`)
    if (existsSync(path) && sorted(await readFile(path, 'utf8')) === sorted(text)) return 0
    await writeFile(path, text, 'utf8')
    return 1
  }

  /** Each committed conflict fixture pair reads to the facts this svn writes for its shape. */
  private async checkConflictFixturesCurrent(captures: readonly ConflictSpikeCapture[]): Promise<void> {
    const texts = new Map(captures.map(({ name, text }) => [name, text]))
    for (const { name, victim } of ConflictShapesSpike.casesConst) {
      const live = ConflictShapesSpike.factsText(texts.get(`status-${name}.xml`) ?? '', texts.get(`info-${name}.xml`) ?? '', victim)
      const fixture = ConflictShapesSpike.factsText(
        await readFile(join(conflictFixtureDirectory, `status-${name}.xml`), 'utf8'),
        await readFile(join(conflictFixtureDirectory, `info-${name}.xml`), 'utf8'),
        victim,
      )
      this.check(`Conflict fixture ${name} reads the same facts as this svn's output`, live === fixture)
    }
  }

  /** The committed fixtures still read the way this svn writes them. */
  private async checkFixturesCurrent(captures: readonly Capture[]): Promise<void> {
    const root = join(this.root, 'parity')
    const reads: Record<string, (text: string) => unknown> = {
      'status-before-update.xml': (text) => SvnWorktreeEvidence.statusRows(text, root),
      'status-after-update.xml': (text) => SvnWorktreeEvidence.statusRows(text, root),
      'status-verbose-committed.xml': (text) => SvnWorktreeEvidence.statusVerboseRows(text, root),
      'status-verbose-foreign.xml': (text) => SvnWorktreeEvidence.statusVerboseRows(text, root),
      'log-committed.xml': (text) => SvnWorktreeEvidence.loggedRows(text, '/Project', ''),
      'log-foreign.xml': (text) => SvnWorktreeEvidence.loggedRows(text, '/Project', ''),
      'log-range.xml': (text) => SvnWorktreeEvidence.loggedRows(text, '/Project', ''),
      'info-main.xml': (text) => SvnWorktreeEvidence.infoEntries(text),
      'info-worktree.xml': (text) => SvnWorktreeEvidence.infoEntries(text),
      'info-repository.xml': (text) => SvnWorktreeEvidence.infoEntries(text),
    }
    for (const { name, text } of captures) {
      const read = reads[name]
      if (read === undefined) throw new Error(`No parity read for ${name}`)
      const fixture = await readFile(join(fixtureDirectory, name), 'utf8')
      const resolved = (value: string) => value.replaceAll('{ROOT}', root).replaceAll('{MAIN}', join(root, 'main'))
      this.check(`Fixture ${name} reads the same as this svn's output`,
        JSON.stringify(read(resolved(fixture))) === JSON.stringify(read(resolved(text))))
    }
  }
}

void SmokeSvnWorktree.run().catch((error) => SmokeRun.failed('smoke-svn-worktree', error))
