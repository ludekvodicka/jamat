import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { FileDiffComputer } from '../../lib-orchestrator/fileChangesManager/diff/fileDiffComputer.js'
import { FileChangesManager } from '../../lib-orchestrator/fileChangesManager/fileChangesManager.js'
import { LandedRows } from '../../lib-orchestrator/sessionManager/lifecycle/landedRows.js'
import { Reconciler } from '../../lib-orchestrator/sessionManager/lifecycle/reconciler.js'
import type { SessionInternalMarks, WorktreePlaceRequest } from '../../lib-orchestrator/sessionManager/lifecycle/sessionLifecycle.js'
import { SvnActionFlow } from '../../lib-orchestrator/sessionManager/lifecycle/svnActionFlow.js'
import { SvnResolverLauncher } from '../../lib-orchestrator/sessionManager/lifecycle/svnResolverLauncher.js'
import { SvnRevisionLabels } from '../../lib-orchestrator/sessionManager/lifecycle/svnRevisionLabels.js'
import { SvnWorktreeFinishFlow } from '../../lib-orchestrator/sessionManager/lifecycle/svnWorktreeFinishFlow.js'
import { SvnWorktreeRemoval } from '../../lib-orchestrator/sessionManager/lifecycle/svnWorktreeRemoval.js'
import { WorktreeCleanupPacing } from '../../lib-orchestrator/sessionManager/lifecycle/worktreeCleanupPacing.js'
import { SvnWorktreeProvisioner } from '../../lib-orchestrator/sessionManager/lifecycle/worktreeProvisioners.js'
import type { WorktreeOwnerDeps } from '../../lib-orchestrator/sessionManager/lifecycle/worktreeOwner.js'
import type { SessionRecord, SessionRecordProcess, SessionRecordScriptStep, SessionRecordWorktree } from '../../lib-orchestrator/sessionManager/records/sessionRecord.types.js'
import { SessionRecordsStore } from '../../lib-orchestrator/sessionManager/records/sessionRecordsStore.js'
import { WorktreeResultsStore } from '../../lib-orchestrator/sessionManager/results/worktreeResultsStore.js'
import { ScriptChain } from '../../lib-orchestrator/sessionManager/scripts/scriptChain.js'
import { ScriptLogStore } from '../../lib-orchestrator/sessionManager/scripts/scriptLogStore.js'
import type { SessionCreateSpec, SessionsOpResult, SvnLabelledRevision } from '../../lib-orchestrator/sessionManager/sessionManagerApi.types.js'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { PathCompare } from '../../lib-orchestrator/shared/pathCompare.js'
import { ProductGroup } from '../../lib-orchestrator/shared/productGroup.js'
import { ReviewRunExit } from '../../lib-orchestrator/shared/reviewRunExit.js'
import { SvnInvoker } from '../../lib-orchestrator/svn/svnInvoker.js'
import { SvnWorktreeEvidence } from '../../lib-orchestrator/svn/svnWorktreeEvidence.js'
import { SvnWorktreeManager } from '../../lib-orchestrator/svn/svnWorktreeManager.js'
import { SmokeHarness, SmokeRun } from './smokeHarness.js'

const fixtureDirectory = join(import.meta.dirname, '..', '..', 'lib-orchestrator', 'svn', 'fixtures', 'worktree')

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

/**
 * The SVN action over real working copies, with its runs carried out in this process: an svn run
 * spawns svn as the Host would, a declared check runs its command in a shell, and a review run is the
 * scripted review port: it stands in for the person, who commits its root with `svn commit` (leaving
 * the receipt the commit dialog writes) or closes the review without a commit. The conflict resolver
 * is a scripted edit of the conflicted files, or no Claude at all. Each run ends with its exit code
 * and is judged as the reconcile pass judges it. The real review run (`jamat-v3 sessions
 * worktree-review --self --wait` against a client's commit dialog) needs a running AppClientUI with
 * its commit split, which no library smoke starts; `sessionManager.test.ts` and `app.test.ts` cover
 * that wire.
 */
class SmokeSvnActions {
  readonly flow: SvnActionFlow
  readonly finisher: SvnWorktreeFinishFlow
  /** Where every ending of this harness writes its durable result. */
  readonly results: WorktreeResultsStore
  /** The roots a review run was launched for, in order. */
  readonly opened: string[] = []
  readonly ended = new Set<string>()
  /** The main copies a committed ending or an UPDATE asked the manager to read again. */
  readonly landedDue: string[] = []
  decision: { of: (scopeRoot: string) => 'commit' | 'cancel' } = { of: () => 'commit' }
  /** What the resolver does in the directory it runs in; null: no Claude can run here. */
  resolve: ((cwd: string) => Promise<void>) | null = null
  /** The prompt of every resolver started, in order. */
  readonly prompts: string[] = []
  /** The `scripts.after` checks a press freezes, as name and one shell command in the worktree. */
  checksOf: () => { name: string; command: string }[] = () => []
  /** Runs inside each check before its command, with the count of checks run so far. */
  onCheck: ((count: number) => Promise<void>) | null = null
  /** How many check runs ended. */
  checkRuns = 0
  private readonly records: SessionRecordsStore
  private readonly repository: SvnFixtureRepository
  private readonly svn: SvnInvoker
  private readonly detached: Promise<unknown>[] = []
  private minted = 0

  constructor(records: SessionRecordsStore, manager: SvnWorktreeManager, repository: SvnFixtureRepository, svn: SvnInvoker, logs: string) {
    this.records = records
    this.repository = repository
    this.svn = svn
    this.results = new WorktreeResultsStore(`${logs}-results`, { now: () => Date.now(), logs: new ScriptLogStore(logs), report: () => undefined })
    const removal = new SvnWorktreeRemoval({ records, svn: manager, releaseBelow: async () => undefined, onQueue: (work) => work(), changed: () => undefined })
    const ended = (sessionId: string): void => { this.ended.add(sessionId) }
    this.flow = new SvnActionFlow({
      records,
      svn: manager,
      labels: new SvnRevisionLabels(manager),
      removal,
      resolver: {
        unavailable: () => this.resolve === null ? 'no Claude runs in this smoke' : null,
        briefs: new ScriptLogStore(logs),
        withMarkers: (root, paths) => SvnResolverLauncher.markersIn(root, paths),
      },
      results: this.results,
      createResolver: (spec, marks) => this.resolver(spec, marks),
      stopRun: async () => true,
      finishRefusal: () => null,
      activityOf: () => null,
      ended,
      landedDue: (mainCopy) => { this.landedDue.push(mainCopy) },
      proposalsSpent: () => undefined,
      detach: (work) => { this.detached.push(work) },
      changed: () => undefined,
      runs: { launch: (run) => this.launch(run) },
      checks: { declaredAfter: async (record) => ({ ok: true, steps: this.checkStepsOf(record) }) },
      stop: async () => ({ ok: true, value: undefined }),
      report: () => undefined,
      newId: () => `smoke-${++this.minted}`,
      now: () => Date.now(),
    })
    this.finisher = new SvnWorktreeFinishFlow({
      records,
      svn: manager,
      removal,
      actions: { start: (sessionId, press) => this.flow.start(sessionId, press), settled: (sessionId) => this.flow.settled(sessionId) },
      labels: new SvnRevisionLabels(manager),
      results: this.results,
      finishRefusal: () => null,
      changed: () => undefined,
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
  async finish(sessionId: string): Promise<{ answer: SessionsOpResult<{ actionId: string | null }>; outcome: SessionRecord['worktreeOutcome']; action: SessionRecord['svnAction'] }> {
    const answer = await this.finisher.finish(sessionId, { choice: 'commit', requestedBy: 'cli' })
    await this.settled()
    const record = this.records.get(sessionId)
    return { answer, outcome: record?.worktreeOutcome, action: record?.svnAction }
  }

  async settled(): Promise<void> {
    for (let round = 0; round < 100 && this.detached.length > 0; round += 1) await Promise.all(this.detached.splice(0))
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
    const process = run.process
    let exitCode: number
    if (process === undefined) exitCode = await this.check(run)
    else if (process.tool === 'svn') {
      const outcome = await this.svn.run(cwd, process.args)
      exitCode = outcome.failure === null ? outcome.code ?? 1 : 1
    }
    else if (process.tool === 'jamat-cli') exitCode = await this.review(run, cwd)
    else throw new Error(`Unknown run tool: ${JSON.stringify(process.tool satisfies never)}`)
    const parentId = run.scriptOf?.sessionId ?? ''
    await this.records.put({ ...this.records.get(run.sessionId) ?? run, life: 'ended', binding: null, pendingOperationId: undefined,
      pendingOperationKind: undefined, exitCode, exitReason: 'process-exit', endedAt: Date.now() })
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

  /** The resolver's create: its record, the scripted edit in its directory, then its end with exit 0. */
  private async resolver(spec: SessionCreateSpec, marks: SessionInternalMarks): Promise<SessionsOpResult<{ sessionId: string }>> {
    const resolve = this.resolve
    if (resolve === null) throw new Error('A resolver was started with no Claude')
    const cwd = spec.directory.mode === 'adHoc' ? spec.directory.path : ''
    this.prompts.push(spec.agent?.initialPrompt ?? '')
    const run: SessionRecord = {
      sessionId: marks.sessionId, kind: 'agent', title: spec.title ?? 'resolver', directory: spec.directory, createdAt: Date.now(),
      agent: { agentId: 'claude', launchMode: spec.agent?.mode ?? 'new', oneShot: true, permission: marks.permission },
      scriptOf: marks.scriptOf, binding: null, life: 'live',
    }
    await this.records.put(run)
    await resolve(cwd)
    await this.records.put({ ...run, life: 'ended', exitCode: 0, exitReason: 'process-exit', endedAt: Date.now() })
    await this.flow.noteVerdict(marks.scriptOf.sessionId, { kind: 'succeeded' })
    return { ok: true, value: { sessionId: marks.sessionId } }
  }

  /** The person in the review: a commit leaves the receipt the commit dialog writes for the run's parent. */
  private async review(run: SessionRecord, scopeRoot: string): Promise<number> {
    this.opened.push(scopeRoot)
    if (this.decision.of(scopeRoot) === 'cancel') return ReviewRunExit.cancelledConst
    const output = await this.repository.run(scopeRoot, ['commit', '-m', 'review', '--', '.'])
    const revision = /Committed revision (\d+)/.exec(output)?.[1]
    if (revision === undefined) throw new Error(`no revision in ${output}`)
    const parent = this.records.get(run.scriptOf?.sessionId ?? '')
    if (parent !== null)
      await this.records.put({ ...parent, commitReceipts: [...parent.commitReceipts ?? [],
        { scopeRoot, revision: Number(revision), paths: [], at: Date.now() }] })
    return ReviewRunExit.committedConst
  }
}

class SmokeSvnWorktree extends SmokeHarness {
  private readonly svn = new SvnInvoker()
  private readonly root: string
  private readonly capture: boolean

  private constructor(root: string, capture: boolean) {
    super()
    this.root = root
    this.capture = capture
  }

  static async run(): Promise<void> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'jamat-v3-svn-worktree-smoke-')))
    try { await new SmokeSvnWorktree(root, process.argv.includes('--capture')).execute() }
    finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) }
  }

  private async execute(): Promise<void> {
    await this.checkNonAsciiSpike()
    const captures = await this.checkFinishEvidence()
    if (this.capture) {
      await mkdir(fixtureDirectory, { recursive: true })
      for (const { name, text } of captures) await writeFile(join(fixtureDirectory, name), text, 'utf8')
      console.log(`  wrote ${captures.length} fixtures to ${fixtureDirectory}`)
    }
    else await this.checkFixturesCurrent(captures)
    await this.checkFinishFlow()
    await this.checkLandedRows()
    await this.checkWorktreeContract()
    await this.checkCreateOwners()
    await this.checkCleanup()
    console.log(`\nsmoke-svn-worktree: ${this.passed} checks passed`)
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
      const checkout = await manager.create({ ownerDir: owner, folder })
      if (!checkout.ok) throw new Error(checkout.detail)
      const record: SessionRecord = {
        sessionId, kind: 'shell', title: `014 - ${folder}`, createdAt: 0, life: 'ended', binding: null,
        directory: { mode: 'adHoc', path: owner },
        worktree: {
          worktreePath: checkout.value.worktreePath, branch: checkout.value.url, baseCommit: `r${checkout.value.baseRevision}`,
          repositoryRoot: owner, kind: 'svn', ...checkout.value.directoryId === null ? {} : { directoryId: checkout.value.directoryId },
        },
      }
      await records.put(record)
      return checkout.value.worktreePath
    }
    const actions = new SmokeSvnActions(records, manager, repository, this.svn, join(this.root, 'flow-script-logs'))

    const committed = await sessionOf('commit-session', 'commit')
    await writeFile(join(committed, 'a.txt'), 'one\ncommitted\n')
    const commit = await actions.finish('commit-session')
    this.check('Finish Commit commits from the worktree, labels the receipt, removes the worktree and never writes the main copy',
      commit.answer.ok && commit.outcome?.result === 'committed' && commit.outcome.main === 'none' && commit.outcome.worktree === 'removed'
      && commit.outcome.labelled?.length === 1 && commit.outcome.labelled[0]?.label === 'receipt'
      && await readFile(join(owner, 'a.txt'), 'utf8') === 'one\n' && !existsSync(committed)
      && records.get('commit-session')?.retiredWorktree?.revisions.length === 1)
    this.check('A committed Finish with the worktree removed keeps the session as a landed row', actions.landed('commit-session', owner))
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
    const splitFinish = await actions.finish('split-session')
    this.check('A1 a commit from the split before Finish: no review opens, the receipt labels the result, the worktree goes and the row stays landed',
      splitFinish.answer.ok && splitFinish.outcome?.result === 'committed' && splitFinish.outcome.worktree === 'removed'
      && actions.opened.length === reviewsBeforeSplit && !existsSync(split) && actions.landed('split-session', owner)
      && JSON.stringify(splitFinish.outcome.labelled?.map((entry) => `${entry.label} r${entry.revision}`)) === JSON.stringify([`receipt r${splitCommit}`]))

    const cancelled = await sessionOf('cancel-session', 'cancel')
    await writeFile(join(cancelled, 'b.txt'), 'new\n')
    actions.decision.of = () => 'cancel'
    const kept = await actions.finish('cancel-session')
    actions.decision.of = () => 'commit'
    this.check('A review closed without a commit waits for the person and keeps the worktree, its change and the session',
      kept.action?.needs?.kind === 'review-cancelled' && existsSync(join(cancelled, 'b.txt')) && !actions.ended.has('cancel-session'))
    this.check('Discard removes the kept worktree by identity, leaves a tombstone and ends the session',
      (await actions.finisher.discard('cancel-session')).ok && !existsSync(cancelled)
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
    const actions = new SmokeSvnActions(records, manager, repository, this.svn, join(this.root, 'landed-script-logs'))
    const landedSession = async (sessionId: string, folder: string, text: string): Promise<readonly SvnLabelledRevision[]> => {
      const checkout = await manager.create({ ownerDir: owner, folder })
      if (!checkout.ok) throw new Error(checkout.detail)
      await records.put({
        sessionId, kind: 'shell', title: `014 - ${folder}`, createdAt: 0, life: 'ended', binding: null,
        directory: { mode: 'adHoc', path: owner },
        worktree: {
          worktreePath: checkout.value.worktreePath, branch: checkout.value.url, baseCommit: `r${checkout.value.baseRevision}`,
          repositoryRoot: owner, kind: 'svn', ...checkout.value.directoryId === null ? {} : { directoryId: checkout.value.directoryId },
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
      actions.landed('landed-session', owner) && first.length === 1 && firstRecord?.worktreeOutcome?.result === 'committed'
      && await readFile(join(owner, 'a.txt'), 'utf8') === 'one\ntwo\nthree\n')
    this.check('L1 the main copy does not hold the landed revision yet', await landedRows.holds(owner, first) === false)

    await foreign('b.txt')
    await foreign('c.txt')
    await landedRows.refreshBehind(owner)
    this.check('L2 three newer revisions on the server read as 3 behind', landedRows.infoOf(owner, first).behind === 3)
    const offlineRepository = await SvnFixtureRepository.create(join(this.root, 'offline-repository'), this.svn)
    const offline = join(this.root, 'offline-copy')
    await offlineRepository.run(this.root, ['checkout', offlineRepository.url, offline])
    await rename(offlineRepository.directory, `${offlineRepository.directory}-gone`)
    await landedRows.refreshBehind(offline)
    this.check('L2 a main copy whose server cannot be reached reads as behind unknown', landedRows.infoOf(offline, first).behind === null)

    // The person updates the whole main copy in TortoiseSVN, or any other client: the row may go.
    await repository.run(owner, ['update'])
    this.check('L3 an update from another client brings the landed revision in', await landedRows.holds(owner, first) === true)

    // UPDATE meets a text conflict with a local change in the main copy.
    const second = await landedSession('update-session', '015-update', 'one\ntwo worktree\nthree\nfour\n')
    await writeFile(join(owner, 'a.txt'), 'one\ntwo main\nthree\nfour\n')
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
    const runsOf = (parentId: string) => records.list().filter((run) => run.scriptOf?.sessionId === parentId)
    const diffRun = runsOf('update-session').find((run) => run.process?.args.includes('diff'))
    const conflicts = SvnWorktreeEvidence.conflicts(await repository.run(owner, ['status', '--xml', '--', '.']), owner)
    this.check('L4 UPDATE runs svn update in the main copy, the resolver there, and a visible svn diff of what it resolved',
      started.ok && records.get('update-session')?.svnAction === undefined && resolvedIn.length === 1 && resolvedIn[0] === owner
      && await readFile(join(owner, 'a.txt'), 'utf8') === merged && conflicts.length === 0
      && diffRun?.process?.args.join(' ') === '--non-interactive diff -- a.txt@' && diffRun.directory.mode === 'adHoc'
      && diffRun.directory.path === owner)
    this.check('L4 the recording of an UPDATE reads the landed rows of its main copy at once, and the main copy holds them',
      actions.landedDue.length === landedBefore + 1 && actions.landedDue.at(-1) === owner && await landedRows.holds(owner, second) === true)
    this.check('L4 an UPDATE writes no worktree result', actions.results.list({ sessionId: 'update-session' }).every((entry) => entry.action === 'finish'))
    await repository.run(owner, ['revert', '--', 'a.txt'])

    // UPDATE from a coordinator that holds no worktree: the runs are its children.
    const third = await landedSession('coordinated-session', '016-coordinated', 'one\ntwo worktree\nthree\nfour\nfive\n')
    await records.put({ sessionId: 'coordinator', kind: 'shell', title: '020 - coordinator', createdAt: 0, life: 'ended', binding: null,
      directory: { mode: 'adHoc', path: owner } })
    this.check('L5 before the coordinator updates, the main copy lacks the landed revision', await landedRows.holds(owner, third) === false)
    const coordinated = await actions.flow.startUpdate('coordinator', owner, 'cli')
    await actions.settled()
    this.check('L5 UPDATE of a coordinator runs as its child, and the landed rows of that main copy then hold',
      coordinated.ok && runsOf('coordinator').some((run) => run.process?.args.includes('update'))
      && records.get('coordinator')?.svnAction === undefined && await landedRows.holds(owner, third) === true)

    // UPDATE meets a working-copy lock another svn client holds in the main copy.
    const fourth = await landedSession('locked-session', '017-locked', 'one\ntwo worktree\nthree\nfour\nfive\nsix\n')
    await SmokeSvnWorktree.workingCopyLock(owner, true)
    const lockedStart = await actions.flow.startUpdate('locked-session', owner, 'cli')
    await actions.settled()
    const relaunched = await actions.relaunches('locked-session')
    const lockedUpdates = runsOf('locked-session').filter((run) => run.process?.args.includes('update')
      && run.directory.mode === 'adHoc' && run.directory.path === owner)
    this.check('L7 UPDATE of a locked main copy is relaunched on the lock pace three times, then waits for the person as locked',
      lockedStart.ok && relaunched === 3 && lockedUpdates.length === 4 && records.get('locked-session')?.svnAction?.needs?.kind === 'locked'
      && await landedRows.holds(owner, fourth) === false)
    await SmokeSvnWorktree.workingCopyLock(owner, false)
    const unlocked = await actions.flow.startUpdate('locked-session', owner, 'cli')
    await actions.settled()
    this.check('L7 once the other client let go, UPDATE again updates the main copy and its landed row holds',
      unlocked.ok && records.get('locked-session')?.svnAction === undefined && await landedRows.holds(owner, fourth) === true)
    this.check('L6 no svn cleanup ever ran in a main copy',
      records.list().every((run) => run.process?.args.includes('cleanup') !== true))
    await records.settled()
  }

  /**
   * The disk half of the scenario table in `docs/architecture/svn-worktrees.md`: create and its
   * refusals, the finish outcomes the bash contract tests, externals first, a held worktree, a
   * junction and a long path. Every owner is a checkout of a repository below this smoke's root.
   */
  private async checkWorktreeContract(): Promise<void> {
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
    const actions = new SmokeSvnActions(records, manager, repository, this.svn, join(this.root, 'contract-script-logs'))
    const { opened, ended } = actions
    const flow = actions.finisher
    const provisioner = this.provisionerOf(manager)
    const sessionIn = async (ownerDir: string, sessionId: string, folder: string): Promise<string> => {
      const provision = await this.provisioned(provisioner, { directory: ownerDir, projectRoot: ownerDir }, folder)
      if (!provision.ok) throw new Error(provision.detail)
      if (provision.exitCode !== 0) throw new Error(`the checkout of ${folder} exited with ${provision.exitCode}`)
      await records.put({
        sessionId, kind: 'shell', title: `014 - ${folder}`, createdAt: 0, life: 'ended', binding: null,
        directory: { mode: 'adHoc', path: ownerDir }, worktree: provision.worktree,
      })
      return provision.worktree.worktreePath
    }
    const finished = (sessionId: string) => actions.finish(sessionId)
    const foreignCommit = async (path: string, text: string, add = false): Promise<void> => {
      await repository.run(other, ['update'])
      await writeFile(join(other, ...path.split('/')), text)
      if (add) await repository.run(other, ['add', '--', path])
      await repository.run(other, ['commit', '-m', 'foreign', '--', '.'])
    }

    await this.checkCreate({ repository, manager, owner, other })
    await this.checkOwnerScope(owner)

    // SW06: landing is the commit from the worktree; the main copy and its own local change stay as they are.
    await writeFile(join(owner, 'a.txt'), 'one main\ntwo\nthree\nfour\nfive\n')
    const landing = await sessionIn(owner, 'landing-session', '014-landing')
    await writeFile(join(landing, 'a.txt'), 'one\ntwo\nthree\nfour\nfive session\n')
    const landed = await finished('landing-session')
    this.check('SW06 Finish Commit commits from the worktree, removes it and leaves the main copy and its local change alone',
      landed.answer.ok && landed.outcome?.result === 'committed' && landed.outcome.main === 'none' && landed.outcome.worktree === 'removed'
      && await readFile(join(owner, 'a.txt'), 'utf8') === 'one main\ntwo\nthree\nfour\nfive\n' && !existsSync(landing)
      && actions.landed('landing-session', owner))
    await repository.run(owner, ['revert', '--', 'a.txt'])
    await repository.run(owner, ['update'])

    // SW06: a conflicting foreign commit waits for the person before any review, and nothing is committed.
    const conflicted = await sessionIn(owner, 'conflict-session', '014-conflict')
    await writeFile(join(conflicted, 'a.txt'), 'one\ntwo session\nthree\nfour\nfive session\n')
    await foreignCommit('a.txt', 'one\ntwo foreign\nthree\nfour\nfive session\n')
    const reviewsBefore = opened.length
    const conflict = await finished('conflict-session')
    this.check('SW06 an update conflict where no Claude runs waits for the person, opens no review and keeps the worktree',
      conflict.answer.ok && conflict.action?.needs?.kind === 'conflict' && conflict.action.needs.reason.includes('nobody can resolve them here')
      && opened.length === reviewsBefore && existsSync(join(conflicted, '.svn')) && !ended.has('conflict-session'))
    this.check('SW04 Discard removes a worktree with conflicts and changes', (await flow.discard('conflict-session')).ok && !existsSync(conflicted))

    // SW06 with a resolver: its files are verified, svn marks them resolved, the update runs again, then the review.
    await repository.run(owner, ['update'])
    const resolvedTree = await sessionIn(owner, 'resolved-session', '014-resolved')
    await writeFile(join(resolvedTree, 'a.txt'), 'one\ntwo foreign\nthree session\nfour\nfive session\n')
    await foreignCommit('a.txt', 'one\ntwo foreign\nthree other\nfour\nfive session\n')
    const merged = 'one\ntwo foreign\nthree other and session\nfour\nfive session\n'
    actions.resolve = async (cwd) => {
      const before = await readFile(join(cwd, 'a.txt'), 'utf8')
      if (!before.includes('<<<<<<< .mine')) throw new Error(`the resolver found no conflict in ${cwd}`)
      await writeFile(join(cwd, 'a.txt'), merged)
    }
    const resolvedFinish = await finished('resolved-session')
    this.check('SW06 a resolver settles a text conflict: verified, marked resolved, updated again, reviewed and committed',
      resolvedFinish.answer.ok && resolvedFinish.outcome?.result === 'committed' && resolvedFinish.outcome.worktree === 'removed'
      && opened.length === reviewsBefore + 1 && actions.landed('resolved-session', owner)
      && actions.prompts.length === 1 && actions.prompts[0].includes('-conflicts.txt'))
    await repository.run(other, ['update'])
    this.check('SW06 the commit holds what the resolver merged', await readFile(join(other, 'a.txt'), 'utf8') === merged)

    // SW06 with a resolver that leaves its markers: nothing is marked resolved and the person decides.
    await repository.run(owner, ['update'])
    const markedTree = await sessionIn(owner, 'marked-session', '014-marked')
    await writeFile(join(markedTree, 'a.txt'), 'one mine\ntwo foreign\nthree other and session\nfour\nfive session\n')
    await foreignCommit('a.txt', 'one theirs\ntwo foreign\nthree other and session\nfour\nfive session\n')
    actions.resolve = async () => undefined
    const marked = await finished('marked-session')
    const markedStatus = await repository.run(markedTree, ['status', '--', 'a.txt'])
    this.check('SW06 markers left by the resolver need the person, and svn still marks the conflict',
      marked.answer.ok && marked.action?.needs?.kind === 'resolver-failed' && markedStatus.startsWith('C')
      && opened.length === reviewsBefore + 1 && actions.prompts.length === 2)
    actions.resolve = null
    this.check('SW04 Discard removes the worktree the resolver left', (await flow.discard('marked-session')).ok && !existsSync(markedTree))

    // SW06: other commits to the project need the person when no checks are declared; Finish again commits as it is.
    await repository.run(owner, ['update'])
    const updated = await sessionIn(owner, 'updated-session', '014-updated')
    await writeFile(join(updated, 'src', 'b.txt'), 'b session\n')
    await foreignCommit('src/c.txt', 'c\n', true)
    const reviewsBeforeUpdated = opened.length
    const first = await finished('updated-session')
    this.check('SW06 incoming commits to the project without declared checks wait for the person and open no review',
      first.answer.ok && first.action?.needs?.kind === 'incoming' && first.action.needs.reason.includes('src/c.txt')
      && opened.length === reviewsBeforeUpdated && !ended.has('updated-session'))
    const second = await finished('updated-session')
    this.check('SW06 Finish again reviews, commits and removes the worktree',
      second.answer.ok && second.outcome?.result === 'committed' && second.outcome.worktree === 'removed'
      && opened.length === reviewsBeforeUpdated + 1 && actions.landed('updated-session', owner))

    // A2: a declared check runs before the update; a commit to the project landing meanwhile runs it again.
    await repository.run(owner, ['update'])
    const checked = await sessionIn(owner, 'checked-session', '014-checked')
    await writeFile(join(checked, 'src', 'b.txt'), 'b checked\n')
    actions.checkRuns = 0
    actions.checksOf = () => [{ name: 'tests', command: 'exit 0' }]
    actions.onCheck = async (count) => { if (count === 1) await foreignCommit('src/d.txt', 'd\n', true) }
    const reviewsBeforeChecked = opened.length
    const checkedFinish = await finished('checked-session')
    actions.checksOf = () => []
    actions.onCheck = null
    const checkRuns = records.list().filter((run) => run.scriptOf?.sessionId === 'checked-session' && run.scriptOf.scriptId === 'checks')
    this.check('A2 Finish runs the declared check, runs it again after an incoming commit, then reviews once, commits and removes the worktree',
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
      (await flow.discard('junction-session')).ok && !existsSync(linked)
      && await readFile(join(store, 'precious.txt'), 'utf8') === 'keep\n')
    this.check('SW03 every removal took only its own worktree: the two kept ones stay, with no rest beside them',
      existsSync(join(owner, '.worktrees')) && (await readdir(join(owner, '.worktrees'))).every((name) => name.startsWith('014-fix-login')))
    await records.settled()
  }

  /** The owner rule over real working copies: no group and no catalog unless a case names them. */
  private provisionerOf(manager: SvnWorktreeManager, catalog: Partial<WorktreeOwnerDeps> = {}): SvnWorktreeProvisioner {
    return new SvnWorktreeProvisioner(manager, {
      groupRootOf: (dir) => ProductGroup.rootOf(dir),
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
      && /outside the project/.test(refusals.outside?.detail ?? '') && /in no SVN working copy/.test(refusals.unversioned?.detail ?? '')
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
    for (const path of ['Zone/Group/Member/src', 'Zone/Solo/docs', 'Zone/Outside/tools'])
      await repository.run(this.root, ['mkdir', '--parents', '-m', 'layout', `${url}/${path}`])
    const zone = join(this.root, 'create-zone')
    await repository.run(this.root, ['checkout', `${url}/Zone`, zone])
    await writeFile(join(zone, 'Group', ProductGroup.markerConst), '')
    await writeFile(join(zone, 'Group', 'Member', 'src', 'a.txt'), 'member\n')
    await writeFile(join(zone, 'Solo', 'docs', 'readme.txt'), 'solo\n')
    await repository.run(zone, ['add', '--', `Group/${ProductGroup.markerConst}`, 'Group/Member/src/a.txt', 'Solo/docs/readme.txt'])
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

  /** SW11: a changed external mount is reviewed first, and a mount left uncommitted stops before its parent. */
  private async checkExternals(input: {
    repository: SvnFixtureRepository
    actions: SmokeSvnActions
    sessionIn: (ownerDir: string, sessionId: string, folder: string) => Promise<string>
  }): Promise<void> {
    const { repository, actions, sessionIn } = input
    const { opened, decision } = actions
    const flow = actions.finisher
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
    this.check('SW11 a mount left uncommitted waits for the person before the parent, which is never reviewed',
      stopped.action?.needs?.kind === 'review-cancelled' && stopped.action.needs.reason.includes(join(cancelled, 'mount'))
      && opened.length === before + 3 && existsSync(join(cancelled, 'app.txt')))
    this.check('SW04 Discard removes a worktree with an external mount', (await flow.discard('external-cancel')).ok && !existsSync(cancelled))

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
    try { finish = await finished('held-session') }
    finally { await SmokeSvnWorktree.release(cwdHolder) }
    this.check('SW12 a process working inside makes the removal IN USE after the commit, and the worktree is whole',
      finish.answer.ok && finish.outcome?.result === 'committed' && finish.outcome.worktree === 'in-use'
      && finish.outcome.lines.some((line) => line.startsWith('IN USE: ')) && existsSync(join(held, '.svn'))
      && records.get('held-session')?.worktree !== undefined && !ended.has('held-session'))
    this.check('R12 that Finish asks for the removal after the end, so the worktree goes once nothing holds it',
      records.get('held-session')?.worktreeCleanup?.phase === 'pending'
      && records.get('held-session')?.worktreeCleanup?.trigger === 'removal-unfinished')

    const fileHolder = await SmokeSvnWorktree.holder(this.root,
      `require('fs').openSync(${JSON.stringify(join(held, 'a.txt'))}, 'r'); setInterval(() => {}, 1000)`)
    let discarded: Awaited<ReturnType<SvnWorktreeFinishFlow['discard']>>
    try { discarded = await flow.discard('held-session') }
    finally { await SmokeSvnWorktree.release(fileHolder) }
    this.check('SW12 a file held open refuses the removal too, and the worktree is whole',
      !discarded.ok && discarded.code === 'locked' && existsSync(join(held, '.svn')))
    this.check('R12 a Discard a holder stopped asks for the removal after the end, without the change check',
      records.get('held-session')?.worktreeCleanup?.trigger === 'discard-unfinished')
    // A run that ended after the Discard is what a reopen and a stop leave; its new work must survive.
    const discardedRecord = records.get('held-session')
    if (discardedRecord?.worktreeCleanup === undefined) throw new Error('the refused Discard wrote no cleanup')
    await records.put({ ...discardedRecord, endedAt: discardedRecord.worktreeCleanup.requestedAt + 1 })
    await writeFile(join(held, 'after-reopen.txt'), 'made after the Discard\n')
    await flow.cleanUp('held-session')
    this.check('R12 a run after that Discard makes the cleanup count changes, so the new work is kept',
      records.get('held-session')?.worktreeCleanup?.phase === 'kept' && existsSync(join(held, 'after-reopen.txt'))
      && !ended.has('held-session'))
    this.check('SW12 once free it is removed, the FileChanges view of this client notwithstanding, and the session ends',
      (await flow.discard('held-session')).ok && !existsSync(held) && ended.has('held-session'))
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
          repositoryRoot: owner, kind: 'svn', ...checkout.value.directoryId === null ? {} : { directoryId: checkout.value.directoryId },
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
    const flow = new SvnWorktreeFinishFlow({
      records, svn: manager,
      removal: new SvnWorktreeRemoval({ records, svn: manager, releaseBelow: async () => undefined, onQueue: (work) => work(), changed: () => undefined }),
      actions: { start: () => { throw new Error('a cleanup presses nothing') }, settled: () => { throw new Error('a cleanup presses nothing') } },
      labels: new SvnRevisionLabels(manager),
      results: cleanupResults,
      finishRefusal: () => null, changed: () => undefined,
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
