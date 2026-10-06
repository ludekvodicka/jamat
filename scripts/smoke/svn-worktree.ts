import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { FileDiffComputer } from '../../lib-orchestrator/fileChangesManager/diff/fileDiffComputer.js'
import { FileChangesManager } from '../../lib-orchestrator/fileChangesManager/fileChangesManager.js'
import { Reconciler } from '../../lib-orchestrator/sessionManager/lifecycle/reconciler.js'
import { SvnWorktreeFinishFlow } from '../../lib-orchestrator/sessionManager/lifecycle/svnWorktreeFinishFlow.js'
import { WorktreeCleanupPacing } from '../../lib-orchestrator/sessionManager/lifecycle/worktreeCleanupPacing.js'
import { SvnWorktreeProvisioner } from '../../lib-orchestrator/sessionManager/lifecycle/worktreeProvisioners.js'
import type { SessionRecord } from '../../lib-orchestrator/sessionManager/records/sessionRecord.types.js'
import { SessionRecordsStore } from '../../lib-orchestrator/sessionManager/records/sessionRecordsStore.js'
import type { SessionReviewPort, SessionReviewSettled } from '../../lib-orchestrator/sessionManager/sessionReviewPort.types.js'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
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
    await this.checkWorktreeContract()
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
    const update = await repository.run(worktree, ['update', '--accept', 'postpone', '--', `${worktree}@`])
    const updated = SvnWorktreeEvidence.updateRows(update, worktree)
    this.check('Update rows read added, deleted, updated, merged and conflicted files, properties and trees',
      ['added', 'deleted', 'updated', 'merged', 'conflicted'].every((text) => updated.some((row) => row.text === text))
      && ['updated', 'merged', 'conflicted'].every((props) => updated.some((row) => row.props === props))
      && updated.some((row) => row.treeConflict) && updated.every((row) => row.inside))
    this.check('The incoming check skips .aidocs and counts the other incoming paths',
      JSON.stringify(SvnWorktreeEvidence.incoming(SvnWorktreeEvidence.changed(beforeRows).map((row) => row.path), updated, 'whole'))
        === JSON.stringify(updated.map((row) => row.path).filter((path) => !path.startsWith('.aidocs/'))))
    const after = await repository.run(worktree, ['status', '--xml', '--', `${worktree}@`])
    const afterRows = SvnWorktreeEvidence.statusRows(after, worktree)
    this.check('Status rows flag text, property and tree conflicts',
      ['conflict.txt', 'props.txt', 'tree.txt'].every((path) => afterRows.some((row) => row.path === path && row.conflict)))

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
    const mainBases = new Map(SvnWorktreeEvidence.infoEntries(mainInfo)
      .map((entry) => [SvnWorktreeEvidence.relativeTo(main, entry.path), entry.revision]))
    const mainBaseOf = async (path: string) => mainBases.get(path) ?? 0
    const items = SvnWorktreeEvidence.statusVerboseRows(foreign, recover)
    const recovered = await SvnWorktreeEvidence.recoverableRows({ items, revisionLog, mainBaseOf })
    this.check('Recovery finds the worktree commit r6 and skips the foreign r7 taken by a single-path update',
      JSON.stringify(recovered) === JSON.stringify([{ revision: 6, action: 'M', path: 'src/a.txt' }]))
    const unlanded = await SvnWorktreeEvidence.unlandedCandidates(items, mainBaseOf)
    this.check('The local unlanded check names r6, which the main copy lacks, and not r7, which it holds',
      JSON.stringify(unlanded) === JSON.stringify([{ path: 'src/a.txt', revision: 6 }]))
    const proven = await SvnWorktreeEvidence.provenRows({
      items: SvnWorktreeEvidence.statusVerboseRows(committed, recover), own: '', rootBase: 5, since: 5,
      claimed: ['src/a.txt'], history: async () => [], revisionLog,
    })
    this.check('The BASE proof attributes r6 to the claimed path', JSON.stringify(proven) === JSON.stringify([{ revision: 6, action: 'M', path: 'src/a.txt' }]))

    const placeholders: [string, string][] = [[url, '{REPO}'], [worktree, '{ROOT}'], [recover, '{ROOT}'], [main, '{MAIN}']]
    return [
      { name: 'status-before-update.xml', text: before },
      { name: 'update.txt', text: update },
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
    const answers = new Map<string, SessionReviewSettled>()
    const review: SessionReviewPort = {
      open: async ({ scopeRoot, proposal }) => {
        const commitSessionId = `review-${answers.size + 1}`
        if (proposal === 'commit') {
          const output = await repository.run(scopeRoot, ['commit', '-m', proposal, '--', '.'])
          const revision = /Committed revision (\d+)/.exec(output)?.[1]
          if (revision === undefined) throw new Error(`no revision in ${output}`)
          answers.set(commitSessionId, { state: 'committed', revision })
        }
        else answers.set(commitSessionId, { state: 'cancelled' })
        return { ok: true, value: { commitSessionId } }
      },
      settled: async (commitSessionId) => answers.get(commitSessionId) ?? { state: 'lost' },
    }
    const detached: Promise<unknown>[] = []
    // The sessions whose ending the flow called a success; SessionManager removes exactly those.
    const ended = new Set<string>()
    const flow = new SvnWorktreeFinishFlow({
      records, svn: manager, reviewOf: () => review, releaseBelow: async () => undefined, onQueue: (work) => work(),
      detach: (work) => { detached.push(work) }, report: () => undefined, changed: () => undefined,
      ended: (sessionId) => { ended.add(sessionId) },
    })

    const committed = await sessionOf('commit-session', 'commit')
    await writeFile(join(committed, 'a.txt'), 'one\ncommitted\n')
    const answered = await flow.finish('commit-session')
    await Promise.all(detached)
    const outcome = records.get('commit-session')?.worktreeOutcome
    this.check('Finish Commit commits through the receipt, updates the main copy and removes the worktree',
      answered.ok && outcome?.result === 'committed' && outcome.main === 'updated' && outcome.worktree === 'removed'
      && await readFile(join(owner, 'a.txt'), 'utf8') === 'one\ncommitted\n' && !existsSync(committed)
      && records.get('commit-session')?.retiredWorktree?.revisions.length === 1)
    this.check('A committed finish with the main copy updated and the worktree removed ends the session',
      ended.has('commit-session'))

    const cancelled = await sessionOf('cancel-session', 'cancel')
    await writeFile(join(cancelled, 'b.txt'), 'new\n')
    await flow.finish('cancel-session')
    await Promise.all(detached)
    const kept = records.get('cancel-session')?.worktreeOutcome
    this.check('A review closed without a commit keeps the worktree, its change and the session',
      kept?.result === 'not-committed' && kept.worktree === 'kept' && existsSync(join(cancelled, 'b.txt'))
      && !ended.has('cancel-session'))
    this.check('Discard removes the kept worktree by identity, leaves a tombstone and ends the session',
      (await flow.discard('cancel-session')).ok && !existsSync(cancelled)
      && records.get('cancel-session')?.retiredWorktree?.worktreePath === cancelled && ended.has('cancel-session'))
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
    const opened: string[] = []
    const answers = new Map<string, SessionReviewSettled>()
    const decision = { of: (_scopeRoot: string): 'commit' | 'cancel' => 'commit' }
    const review: SessionReviewPort = {
      open: async ({ scopeRoot }) => {
        opened.push(scopeRoot)
        const commitSessionId = `contract-review-${opened.length}`
        if (decision.of(scopeRoot) === 'commit') {
          const output = await repository.run(scopeRoot, ['commit', '-m', 'contract', '--', '.'])
          const revision = /Committed revision (\d+)/.exec(output)?.[1]
          if (revision === undefined) throw new Error(`no revision in ${output}`)
          answers.set(commitSessionId, { state: 'committed', revision })
        }
        else answers.set(commitSessionId, { state: 'cancelled' })
        return { ok: true, value: { commitSessionId } }
      },
      settled: async (commitSessionId) => answers.get(commitSessionId) ?? { state: 'lost' },
    }
    const detached: Promise<unknown>[] = []
    const ended = new Set<string>()
    const flow = new SvnWorktreeFinishFlow({
      records, svn: manager, reviewOf: () => review, releaseBelow: async () => undefined, onQueue: (work) => work(),
      detach: (work) => { detached.push(work) }, report: () => undefined, changed: () => undefined,
      ended: (sessionId) => { ended.add(sessionId) },
    })
    const provisioner = new SvnWorktreeProvisioner(manager, () => false)
    const sessionIn = async (ownerDir: string, sessionId: string, folder: string): Promise<string> => {
      const provision = await provisioner.create({ projectRoot: ownerDir, folder })
      if (!provision.ok) throw new Error(provision.detail)
      await records.put({
        sessionId, kind: 'shell', title: `014 - ${folder}`, createdAt: 0, life: 'ended', binding: null,
        directory: { mode: 'adHoc', path: ownerDir }, worktree: provision.value,
      })
      return provision.value.worktreePath
    }
    const finished = async (sessionId: string) => {
      const answer = await flow.finish(sessionId)
      await Promise.all(detached)
      return { answer, outcome: records.get(sessionId)?.worktreeOutcome }
    }
    const foreignCommit = async (path: string, text: string, add = false): Promise<void> => {
      await repository.run(other, ['update'])
      await writeFile(join(other, ...path.split('/')), text)
      if (add) await repository.run(other, ['add', '--', path])
      await repository.run(other, ['commit', '-m', 'foreign', '--', '.'])
    }

    await this.checkCreate({ repository, manager, owner, other })
    await this.checkOwnerScope(owner)

    // SW06: a commit lands in a main copy that holds a local change of its own: merged, not lost.
    await writeFile(join(owner, 'a.txt'), 'one main\ntwo\nthree\nfour\nfive\n')
    const merged = await sessionIn(owner, 'merge-session', '014-merge')
    await writeFile(join(merged, 'a.txt'), 'one\ntwo\nthree\nfour\nfive session\n')
    const merge = await finished('merge-session')
    this.check('SW06 Finish Commit merges the commit into a main copy with a local change and removes the worktree',
      merge.answer.ok && merge.outcome?.result === 'committed' && merge.outcome.main === 'merged:1'
      && merge.outcome.worktree === 'removed' && merge.outcome.lines.some((line) => line === 'MAIN MERGED a.txt')
      && await readFile(join(owner, 'a.txt'), 'utf8') === 'one main\ntwo\nthree\nfour\nfive session\n' && !existsSync(merged)
      && ended.has('merge-session'))
    await repository.run(owner, ['revert', '--', 'a.txt'])

    // SW06: a conflicting foreign commit stops before any review, and nothing is committed.
    const conflicted = await sessionIn(owner, 'conflict-session', '014-conflict')
    await writeFile(join(conflicted, 'a.txt'), 'one\ntwo session\nthree\nfour\nfive session\n')
    await foreignCommit('a.txt', 'one\ntwo foreign\nthree\nfour\nfive session\n')
    const reviewsBefore = opened.length
    const conflict = await finished('conflict-session')
    this.check('SW06 an update conflict answers worktree-conflict, opens no review and keeps the worktree',
      !conflict.answer.ok && conflict.answer.code === 'worktree-conflict' && conflict.outcome?.result === 'conflict'
      && conflict.outcome.worktree === 'kept' && conflict.outcome.lines.some((line) => line.startsWith('CONFLICT: '))
      && opened.length === reviewsBefore && existsSync(join(conflicted, '.svn')) && !ended.has('conflict-session'))
    this.check('SW04 Discard removes a worktree with conflicts and changes', (await flow.discard('conflict-session')).ok && !existsSync(conflicted))

    // SW06: other commits to the project stop the first press; the second commits as it is.
    await repository.run(owner, ['update'])
    const updated = await sessionIn(owner, 'updated-session', '014-updated')
    await writeFile(join(updated, 'src', 'b.txt'), 'b session\n')
    await foreignCommit('src/c.txt', 'c\n', true)
    const first = await finished('updated-session')
    this.check('SW06 incoming commits to the project answer worktree-updated, name the revision and open no review',
      !first.answer.ok && first.answer.code === 'worktree-updated' && first.outcome?.result === 'updated'
      && first.outcome.lines[0]?.startsWith('UPDATED to r') === true && opened.length === reviewsBefore
      && !ended.has('updated-session'))
    const second = await finished('updated-session')
    this.check('SW06 a second press after UPDATED reviews, commits and removes the worktree',
      second.answer.ok && second.outcome?.result === 'committed' && second.outcome.worktree === 'removed'
      && opened.length === reviewsBefore + 1 && await readFile(join(owner, 'src', 'b.txt'), 'utf8') === 'b session\n'
      && ended.has('updated-session'))

    await this.checkExternals({ repository, flow, records, opened, decision, sessionIn, finished })
    await this.checkHeld({ repository, flow, records, owner, sessionIn, finished, ended })

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

  /** SW01 and SW02: a numbered checkout of the owner at HEAD, and every refusal of the owner rules. */
  private async checkCreate(input: {
    repository: SvnFixtureRepository; manager: SvnWorktreeManager; owner: string; other: string
  }): Promise<void> {
    const { repository, manager, owner, other } = input
    await writeFile(join(owner, 'src', 'b.txt'), 'b uncommitted main work\n')
    const provisioner = new SvnWorktreeProvisioner(manager, () => false)
    const created = await provisioner.create({ projectRoot: owner, folder: '014-fix-login' })
    const ownerUrl = (await repository.run(owner, ['info', '--show-item', 'url', '--', '.'])).trim()
    const head = (await repository.run(owner, ['info', '--show-item', 'revision', '--', repository.url])).trim()
    this.check('SW01 create checks out the owner URL at HEAD into .worktrees/<NNN>-<slug>, without the main copy\'s work',
      created.ok && created.value.kind === 'svn' && created.value.worktreePath === join(owner, '.worktrees', '014-fix-login')
      && created.value.branch === ownerUrl && created.value.baseCommit === `r${head}` && created.value.directoryId !== undefined
      && await readFile(join(owner, '.worktrees', '014-fix-login', 'src', 'b.txt'), 'utf8') === 'b\n')
    const again = await provisioner.create({ projectRoot: owner, folder: '014-fix-login' })
    this.check('SW02 a taken folder is never overwritten: the next create gets <folder>-2',
      again.ok && again.value.worktreePath === join(owner, '.worktrees', '014-fix-login-2'))
    await repository.run(owner, ['revert', '--', 'src/b.txt'])

    const refusedFor = async (request: { projectRoot: string; owner?: string; baseRef?: string }, holdsOtherProject = false) => {
      const answer = await new SvnWorktreeProvisioner(manager, () => holdsOtherProject).create({ ...request, folder: '014-refused' })
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
      outside: await refusedFor({ projectRoot: owner, owner: other }),
      unversioned: await refusedFor({ projectRoot: plain }),
      zoneRoot: await refusedFor({ projectRoot: owner }, true),
      notIgnored: await refusedFor({ projectRoot: exposed }),
    }
    this.check('SW02 create refuses a base ref, an owner in a worktree, outside the project, unversioned, a zone root and an unignored .worktrees',
      Object.values(refusals).every((refusal) => refusal !== null && refusal.code === 'invalid-spec')
      && /inside a worktree/.test(refusals.inWorktree?.detail ?? '') && /outside the project/.test(refusals.outside?.detail ?? '')
      && /holds other projects/.test(refusals.zoneRoot?.detail ?? '') && /does not ignore/.test(refusals.notIgnored?.detail ?? ''))
    this.check('SW02 and nothing was checked out where the create was refused',
      !existsSync(join(exposed, '.worktrees', '014-refused')) && !existsSync(join(plain, '.worktrees'))
      && !existsSync(join(owner, '.worktrees', '014-refused')))
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
    flow: SvnWorktreeFinishFlow
    records: SessionRecordsStore
    opened: string[]
    decision: { of: (scopeRoot: string) => 'commit' | 'cancel' }
    sessionIn: (ownerDir: string, sessionId: string, folder: string) => Promise<string>
    finished: (sessionId: string) => Promise<{ answer: { ok: boolean }; outcome: SessionRecord['worktreeOutcome'] }>
  }): Promise<void> {
    const { repository, flow, opened, decision, sessionIn, finished } = input
    const external = await SvnFixtureRepository.create(join(this.root, 'contract-external'), this.svn)
    await external.run(this.root, ['mkdir', '--parents', '-m', 'external layout', `${external.url}/lib`])
    const lib = join(this.root, 'contract-lib')
    await external.run(this.root, ['checkout', `${external.url}/lib`, lib])
    await writeFile(join(lib, 'l.txt'), 'lib\n')
    await external.run(lib, ['add', '--', 'l.txt'])
    await external.run(lib, ['commit', '-m', 'external library'])
    await repository.run(this.root, ['mkdir', '-m', 'app layout', `${repository.url}/App`])
    const app = join(this.root, 'contract-app')
    await repository.run(this.root, ['checkout', `${repository.url}/App`, app])
    await writeFile(join(app, 'app.txt'), 'app\n')
    await repository.run(app, ['add', '--', 'app.txt'])
    await repository.run(app, ['propset', 'svn:externals', `${external.url}/lib mount`, '--', '.'])
    await repository.run(app, ['propset', 'svn:global-ignores', '.worktrees', '--', '.'])
    await repository.run(app, ['commit', '-m', 'app with an external'])
    await repository.run(app, ['update'])

    const both = await sessionIn(app, 'external-session', '014-both')
    await writeFile(join(both, 'app.txt'), 'app session\n')
    await writeFile(join(both, 'mount', 'l.txt'), 'lib session\n')
    const before = opened.length
    const landed = await finished('external-session')
    this.check('SW11 a changed mount is reviewed before its parent, published, and both land in the main copy',
      landed.answer.ok && landed.outcome?.result === 'committed' && landed.outcome.worktree === 'removed'
      && opened.length === before + 2 && opened[before] === join(both, 'mount') && opened[before + 1] === both
      && landed.outcome.lines.some((line) => /^EXTERNAL PUBLISHED r\d+ contract-external mount\/l\.txt$/.test(line))
      && await readFile(join(app, 'mount', 'l.txt'), 'utf8') === 'lib session\n'
      && await readFile(join(app, 'app.txt'), 'utf8') === 'app session\n')

    const cancelled = await sessionIn(app, 'external-cancel', '014-cancel')
    await writeFile(join(cancelled, 'app.txt'), 'app two\n')
    await writeFile(join(cancelled, 'mount', 'l.txt'), 'lib two\n')
    decision.of = (scopeRoot) => scopeRoot.endsWith('mount') ? 'cancel' : 'commit'
    const stopped = await finished('external-cancel')
    decision.of = () => 'commit'
    this.check('SW11 a mount left uncommitted stops before the parent, which is never reviewed',
      stopped.outcome?.result === 'not-committed' && stopped.outcome.worktree === 'kept'
      && stopped.outcome.lines.some((line) => line.startsWith('NOT COMMITTED: external mount'))
      && opened.length === before + 3 && existsSync(join(cancelled, 'app.txt')))
    this.check('SW04 Discard removes a worktree with an external mount', (await flow.discard('external-cancel')).ok && !existsSync(cancelled))
  }

  /**
   * SW12: a process with its working directory, or an open file, inside the worktree makes the
   * removal IN USE and leaves the worktree whole. This client's own FileChanges view holds nothing.
   */
  private async checkHeld(input: {
    repository: SvnFixtureRepository
    flow: SvnWorktreeFinishFlow
    records: SessionRecordsStore
    owner: string
    sessionIn: (ownerDir: string, sessionId: string, folder: string) => Promise<string>
    finished: (sessionId: string) => Promise<{ answer: { ok: boolean }; outcome: SessionRecord['worktreeOutcome'] }>
    ended: ReadonlySet<string>
  }): Promise<void> {
    const { flow, records, owner, sessionIn, finished, ended } = input
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
    await records.settled()

    // The client restarts: what the records file holds is all the next client knows.
    records = await SessionRecordsStore.load(recordsFile, options)
    const flow = new SvnWorktreeFinishFlow({
      records, svn: manager, reviewOf: () => null, releaseBelow: async () => undefined, onQueue: (work) => work(),
      detach: () => { throw new Error('a cleanup detaches nothing') }, report: () => undefined, changed: () => undefined,
      ended: (sessionId) => { ended.add(sessionId) },
    })
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
      JSON.stringify(first) === JSON.stringify(['changed', 'committed', 'linked', 'unlanded']))
    this.check('R12 a session whose worktree committed loses it after its end and a client restart, and the session ends',
      !existsSync(committed) && records.get('committed')?.retiredWorktree?.worktreePath === committed && ended.has('committed'))
    this.check('R13 a worktree with a change left is kept with the count, and its session stays',
      existsSync(join(changed, 'notes.txt')) && records.get('changed')?.worktreeCleanup?.phase === 'kept'
      && records.get('changed')?.worktreeCleanup?.reason === '1 change' && !ended.has('changed'))
    this.check('R15 the cleanup removes a worktree with a junction and a long path, and the linked store survives',
      !existsSync(linked) && await readFile(join(store, 'precious.txt'), 'utf8') === 'keep\n' && ended.has('linked'))
    const waiting = records.get('unlanded')?.worktreeCleanup
    this.check('R14 a commit the main copy lacks keeps the worktree pending as unlanded, and the main copy is not written',
      existsSync(unlanded) && waiting?.phase === 'pending' && /^unlanded r\d+: a\.txt$/.test(waiting.reason ?? '')
      && await readFile(join(owner, 'a.txt'), 'utf8') === 'one\ncommitted\n' && !ended.has('unlanded'))
    this.check('R14 an unlanded cleanup and a kept one are not judged again at once', (await judge()).length === 0)

    await repository.run(owner, ['update'])
    await flow.cleanUp('unlanded')
    this.check('R14 once svn update brought the revision into the main copy, the next judgement removes the worktree',
      !existsSync(unlanded) && ended.has('unlanded') && existsSync(changed))

    // What `sessions.cleanupWorktree` writes for a kept worktree once its change was taken care of.
    await rm(join(changed, 'notes.txt'))
    const kept = records.get('changed')
    if (kept === null) throw new Error('the kept session has no record')
    await records.put({ ...kept, worktreeCleanup: WorktreeCleanupPacing.pending('requested', Date.now()) })
    this.check('R13 a requested cleanup judges a kept worktree again at once and removes it once nothing is left',
      JSON.stringify(await judge()) === JSON.stringify(['changed']) && !existsSync(changed) && ended.has('changed'))
    await records.settled()
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
      'update.txt': (text) => SvnWorktreeEvidence.updateRows(text, root),
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
