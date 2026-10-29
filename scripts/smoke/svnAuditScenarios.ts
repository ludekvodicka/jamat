import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { SvnInvoker } from '../../lib-orchestrator/svn/svnInvoker.js'
import { SvnWorktreeManager } from '../../lib-orchestrator/svn/svnWorktreeManager.js'
import { SessionRecordsStore, type SessionRecordSvnAction } from '../../lib-orchestrator/sessionManager/worktreeSessionRecords.js'
import { SessionScriptsManager, ScriptLogStore } from '../../lib-orchestrator/sessionManager/worktreeSessionScripts.js'
import { WorktreeLease } from '../../lib-orchestrator/worktrees/worktreeLease.js'
import { RemoteControlInstanceRegistry } from '../../lib-orchestrator/remoteControl/remoteControlInstanceRegistry.js'
import { WorktreeSvnCommands } from '../../lib-orchestrator/worktrees/worktreeSvnCommands.js'
import { WorktreeOperations } from '../../lib-orchestrator/worktrees/worktreeOperations.js'
import { WorktreeResultsStore } from '../../lib-orchestrator/worktrees/worktreeResults.js'
import { SvnConflictFlow, SvnResolverLauncher } from '../../lib-orchestrator/worktrees/worktreeConflicts.js'
import { SvnConflictShapes } from '../../lib-orchestrator/svn/svnConflictShapes.js'
import { SvnConflictResolutions } from '../../lib-orchestrator/svn/svnConflictResolutions.js'
import { CommitStep, VerifyStep } from '../../lib-orchestrator/worktrees/worktreeFinish.js'
import { SvnWorktreeEvidence } from '../../lib-orchestrator/svn/svnWorktreeEvidence.js'
import { SvnStepRunner } from '../../lib-orchestrator/worktrees/svnStepRunner.js'
import { SvnCommitManager } from '../../lib-orchestrator/svn/svnCommitManager.js'
import { FileChangesManager } from '../../lib-orchestrator/fileChangesManager/fileChangesManager.js'
import { FileDiffComputer } from '../../lib-orchestrator/fileChangesManager/diff/fileDiffComputer.js'
import { VcsStatusView } from '../../lib-orchestrator/fileChangesManager/vcsStatusView.js'
import { GitCommitManager } from '../../lib-orchestrator/git/gitCommitManager.js'
import { GitInvoker } from '../../lib-orchestrator/git/gitInvoker.js'

import type { SvnStepJournalEntry } from '../../lib-orchestrator/worktrees/worktreeState.js'
import { SvnTextResolutionScenarios } from './svnTextResolutionScenarios.js'

const requireUi = createRequire(import.meta.url)
const { VersioningCommitManager } = requireUi('../../app-client-ui/app/versioning/versioningCommitManager.ts') as typeof import('../../app-client-ui/app/versioning/versioningCommitManager.js')
const { VersioningCommitMessageStore } = requireUi('../../app-client-ui/app/versioning/versioningCommitMessageStore.ts') as typeof import('../../app-client-ui/app/versioning/versioningCommitMessageStore.js')

export class SvnAuditScenarios {
  static async run(parent: string): Promise<void> {
    await SvnTextResolutionScenarios.run(parent)
    const root = join(parent, 'audit-regressions')
    await mkdir(root)
    const svn = new SvnInvoker()
    const run = async (cwd: string, args: string[]) => {
      const answer = await svn.run(cwd, args)
      assert.equal(answer.code, 0, answer.stderr || answer.stdout)
      assert.equal(answer.failure, null)
      return answer.stdout
    }
    const repository = join(root, 'repository'), main = join(root, 'main')
    const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: root, env: process.env })
    assert.equal(created.code, 0, created.stderr)
    const url = pathToFileURL(repository).href
    await run(root, ['checkout', url, main])
    const commit = async (cwd: string, text: string) => {
      const file = join(root, 'message.txt')
      await writeFile(file, `[Fixture] ${text}`)
      await run(cwd, ['commit', '--file', file, '--username', 'fixture'])
      return Number((await run(cwd, ['info', '--show-item', 'revision', url])).trim())
    }
    for (const name of ['moved.txt', 'rounds.txt', 'held.txt']) await writeFile(join(main, name), 'base\n')
    await writeFile(join(main, 'keywords.txt'), '$Rev$ $Revision$ $Custom$ $Rev::             $\nbase\n')
    await run(main, ['add', 'keywords.txt', 'moved.txt', 'rounds.txt', 'held.txt'])
    await run(main, ['propset', 'svn:keywords', 'Rev Custom=%r', 'keywords.txt'])
    await run(main, ['propset', 'svn:eol-style', 'native', 'keywords.txt'])
    await run(main, ['propset', 'svn:global-ignores', '.worktrees\nignored\n', '.'])
    await commit(main, 'Seed audit scenarios')
    await run(main, ['update'])
    const manager = new SvnWorktreeManager(svn)
    const made = await manager.create({ ownerDir: main, folder: '001-audit' })
    assert(made.ok, JSON.stringify(made))
    const tree = made.value.worktreePath
    await writeFile(join(tree, 'keywords.txt'), (await readFile(join(tree, 'keywords.txt'), 'utf8')).replace(/\r\n/g, '\n') + 'worker\n')
    const before = await manager.commitHashes(tree, ['keywords.txt'], 'node')
    assert(before.ok, JSON.stringify(before))
    const revision = await commit(tree, 'Publish translated keyword file')
    const after = await manager.commitHashes(tree, ['keywords.txt'], 'node')
    const remote = await manager.publicationHashes(tree, ['keywords.txt'], revision)
    assert(after.ok && remote.ok)
    assert.deepEqual(after.value, before.value)
    assert.deepEqual(remote.value, before.value)
    await mkdir(join(tree, 'ignored'))
    for (let index = 0; index < 2100; index++) await writeFile(join(tree, 'ignored', `${index}.txt`), 'generated')
    const directory = await manager.commitHashes(tree, ['.'], 'node')
    assert(directory.ok)
    await writeFile(join(tree, 'ignored', '0.txt'), 'dev server output')
    assert.deepEqual(await manager.commitHashes(tree, ['.'], 'node'), directory)
    console.log('  ok  P2/P3 native keyword and EOL publication proofs; directory proof excludes 2100 ignored files')

    const records = await SessionRecordsStore.load(join(root, 'records.json'), { snapshotsDirectory: join(root, 'snapshots') })
    await records.put({ sessionId: 'audit', kind: 'shell', title: 'Audit fixture', life: 'ended', binding: null, directory: { mode: 'adHoc', path: tree }, createdAt: 1,
      worktree: { ...made.value, directoryId: made.value.directoryId ?? undefined, kind: 'svn', repositoryRoot: main, branch: url, baseCommit: 'r1' },
      worktreeLifecycle: { version: 0, actionId: 'audit', phase: 'finishing', step: 'worker-resolving', outOfDate: 0, journal: [],
        facts: { worker: { liveness: 'stopped', resumeFailures: 0 } } } })
    await mkdir(join(tree, 'kept-local'))
    await writeFile(join(tree, 'kept-local', 'a.txt'), 'retained local bytes\n')
    await run(tree, ['add', 'kept-local'])
    await commit(tree, 'Seed keep-local deletion')
    await run(tree, ['delete', '--keep-local', 'kept-local'])
    const deletions = await manager.changes(tree)
    assert(deletions.ok)
    const selected = deletions.value.filter((row) => row.deleted).map((row) => row.path)
    assert(selected.includes('kept-local'))
    const deletedHashes = await manager.commitHashes(tree, selected, 'node')
    assert(deletedHashes.ok)
    const keptAssembly = await manager.assembly(tree)
    assert(keptAssembly.ok, `Unchanged keep-local remainder must be accepted: ${JSON.stringify(keptAssembly)}`)
    await writeFile(join(tree, 'kept-local', 'a.txt'), 'newly recreated bytes\n')
    assert.equal((await manager.assembly(tree)).ok, false, 'Recreated bytes under deletion must block preparation')
    await writeFile(join(tree, 'kept-local', 'a.txt'), 'retained local bytes\n')
    const deletionRevision = await commit(tree, 'Publish keep-local deletion')
    const verified = await new VerifyStep(records, manager).run('audit', tree, deletionRevision, {
      version: 0, selection: selected, deletions: selected, hashes: deletedHashes.value, message: '[Fixture] Publish deletion', source: 'person-local', acknowledged: [], headMovedBy: 0,
    }, 'disposing')
    assert.equal(verified.verified, true, JSON.stringify(verified))
    assert.equal(await readFile(join(tree, 'kept-local', 'a.txt'), 'utf8'), 'retained local bytes\n')
    await records.update('audit', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, step: 'worker-resolving' } }))
    console.log('  ok  P10 directory keep-local deletion verifies repository removal and preserves physical content')
    const logs = new ScriptLogStore(join(root, 'logs'))
    const results = new WorktreeResultsStore(join(root, 'results'), { logs, now: Date.now, report: () => {} })
    const unreachable = async (): Promise<never> => { throw new Error('No Host in this fixture') }
    const scripts = new SessionScriptsManager({ records, logs, now: Date.now, onCollapsed: () => {}, report: () => {},
      host: { runtimeInspect: unreachable, runtimeStop: unreachable, runtimeRemove: unreachable } })
    const commands = new WorktreeSvnCommands(svn, new WorktreeLease('audit-fixture', () => []), async () => 'accept')
    const guarded = new WorktreeSvnCommands(svn, commands.lease, async () => 'stop')
    await mkdir(join(main, '.worktrees', '.leases'), { recursive: true })
    await writeFile(`${WorktreeLease.fileOf(main)}.fingerprint`, 'old-profile-fingerprint')
    const files = new FileChangesManager({ diffExecutor: new FileDiffComputer() })
    const dialog = new VersioningCommitManager({
      messages: new VersioningCommitMessageStore(join(root, 'dialog-messages.json'), console.error),
      sessions: { worktreeAt: async () => null, workingContext: async () => ({ ok: true, value: { sessionId: 'main', cwd: main, agent: null, worktree: null } }) },
      vcsStatus: new VcsStatusView(), fileAccess: (_owner, snapshot, file) => files.fileAccess(snapshot, file),
      snapshotOf: (_owner, snapshot) => files.workingSnapshot(snapshot), git: new GitCommitManager(new GitInvoker()),
      svn: new SvnCommitManager(guarded, (scope, _paths, work) => guarded.lease.within(scope, 'commit', work)),
      tortoise: { open: unreachable }, onChanged: () => {},
    })
    for (const value of ['first main commit', 'second main commit']) {
      await writeFile(join(main, 'held.txt'), `${value}\n`)
      const prepared = await dialog.prepare('main', 'svn', main, null)
      assert(prepared.ok, JSON.stringify(prepared))
      dialog.attach(prepared.value.draftId, 'fixture')
      const read = await files.workingTree({ sessionId: 'main', cwd: main, agent: null, worktree: null }, 'svn', true)
      assert(read.ok, JSON.stringify(read))
      const snapshot = dialog.files('fixture', prepared.value.draftId, read.value)
      const selected = snapshot.entries.filter((row) => row.displayPath === 'held.txt')
      assert.equal(selected.length, 1)
      const result = await dialog.run('fixture', { draftId: prepared.value.draftId, snapshotId: snapshot.snapshotId,
        fileIds: selected.map((row) => row.fileId), message: `[Fixture] ${value}` })
      assert(result.ok, JSON.stringify(result))
      assert(result.revision)
      dialog.release(prepared.value.draftId, 'fixture')
    }
    assert.equal(await readFile(`${WorktreeLease.fileOf(main)}.fingerprint`, 'utf8'), 'old-profile-fingerprint')
    console.log('  ok  N3 two main commits with edits and an old profile fingerprint through the dialog backend and production command lease')
    const baseRevision = Number((await run(main, ['info', '--show-item', 'revision', url])).trim())
    const retryMessage = 'Recover a lost reply after an earlier failed attempt'
    const retry: SvnStepJournalEntry = { kind: 'commit', stepId: 'audit-commit-retry', runId: 'retry', attempt: 2, startedAt: Date.now(),
      baseRevision, paths: ['/held.txt'], messageHash: CommitStep.messageHash(`[Fixture] ${retryMessage}`) }
    await records.update('audit', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
      journal: [...record.worktreeLifecycle!.journal, { ...retry, runId: 'failed', attempt: 1, endedAt: Date.now(), outcome: 'auth' }, retry] } }))
    await writeFile(join(main, 'held.txt'), 'lost reply publication\n')
    const recoveredRevision = await commit(main, retryMessage)
    const recover = new CommitStep({ records, svn: manager, logs, runner: { run: unreachable }, now: Date.now })
    assert.deepEqual(await recover.recover(retry, main), { kind: 'landed', revision: recoveredRevision })
    console.log('  ok  N1 same-action failed predecessor does not make a real lost commit reply ambiguous')
    const resolver = { briefs: logs, unavailable: () => 'No agent in this fixture', withMarkers: SvnResolverLauncher.markersIn, cli: () => ({ ok: false as const, detail: 'No agent in this fixture' }),
      instance: { configIdentity: 'audit', channel: 'development' as const } }
    const operations = new WorktreeOperations({ records, scripts, now: Date.now, newId: randomUUID, changed: () => {}, commands,
      svn: manager, results, resolver, busyReason: () => null, holdInput: () => () => {}, handoffs: { checksFailed: async () => {}, conflicts: async () => {}, notifyCaller: async () => {} } })
    const flow = new SvnConflictFlow({ svn: manager, briefs: logs, handover: results, resolutions: operations.resolutions,
      savedDirectoryOf: (id) => results.savedDirectoryOf(id), withMarkers: resolver.withMarkers, unavailable: resolver.unavailable, cli: resolver.cli, now: Date.now })
    let action: SessionRecordSvnAction = { actionId: 'audit', kind: 'finish', stage: 'fixing', root: tree, checks: [], checkCursor: 0, rootCursor: 0,
      evidence: [], rounds: { incoming: 0, outOfDate: 0, lock: 0 }, requestedBy: 'window', startedAt: Date.now() }
    await run(tree, ['move', 'moved.txt', 'renamed.txt'])
    await writeFile(join(main, 'moved.txt'), 'incoming edit\n')
    await commit(main, 'Edit source of local move')
    await run(tree, ['update', '--ignore-externals', '--accept', 'postpone'])
    const moved = await flow.remember(action)
    assert(moved.ok, JSON.stringify(moved))
    action = { ...action, conflictSet: moved.value.set }
    const resolved = await flow.resolve(action, { path: 'moved.txt', option: 'keep-both', requestedBy: 'window', by: 'person', confirm: false }, async () => {}, 'worker-resolving')
    assert(resolved.ok, JSON.stringify(resolved))
    assert.equal(existsSync(join(tree, 'moved.txt')), false)
    assert.equal(await readFile(join(tree, 'renamed.txt'), 'utf8'), 'incoming edit\n')
    assert(records.get('audit')!.worktreeLifecycle!.journal.some((entry) => entry.kind === 'resolve' && entry.outcome === 'ok'))
    console.log('  ok  K6/K8 move-vs-edit resolves at its destination through the production journaled resolver')

    await writeFile(join(tree, 'rounds.txt'), 'local first\n')
    await writeFile(join(main, 'rounds.txt'), 'incoming first\n')
    await commit(main, 'First conflict')
    await run(tree, ['update', '--ignore-externals', '--accept', 'postpone'])
    const first = await flow.remember(action)
    assert(first.ok)
    const firstEntry = first.value.set.entries.find((entry) => entry.path === 'rounds.txt')!
    await writeFile(join(tree, 'rounds.txt'), 'merged first round\n')
    const settled = await flow.resolve({ ...action, conflictSet: first.value.set }, { path: 'rounds.txt', option: 'merged', requestedBy: 'window', by: 'person', confirm: false }, async () => {}, 'worker-resolving')
    assert(settled.ok, JSON.stringify(settled))
    await writeFile(join(tree, 'rounds.txt'), 'second round session work\n')
    await run(main, ['delete', 'rounds.txt'])
    await commit(main, 'Delete after first conflict settlement')
    await run(tree, ['update', '--ignore-externals', '--accept', 'postpone'])
    const second = await flow.remember(settled.value.action, first.value.memory)
    assert(second.ok)
    const secondEntry = second.value.set.entries.find((entry) => entry.path === 'rounds.txt')!
    assert.notEqual(firstEntry.occurrenceId, secondEntry.occurrenceId)
    // Memory keys an occurrence by path and kind: the settled text occurrence stays beside the new tree one.
    assert.notEqual(first.value.memory.paths.find((entry) => entry.occurrenceId === firstEntry.occurrenceId)!.saved,
      second.value.memory.paths.find((entry) => entry.occurrenceId === secondEntry.occurrenceId)!.saved)
    const deleted = await flow.resolve({ ...action, conflictSet: second.value.set }, { path: 'rounds.txt', option: 'take-incoming', requestedBy: 'window', by: 'person', confirm: false }, async () => {}, 'worker-resolving')
    assert(deleted.ok, JSON.stringify(deleted))
    assert.equal(await readFile(join(results.savedDirectoryOf('audit'), 'resolutions', secondEntry.occurrenceId!, 'rounds.txt'), 'utf8'), 'second round session work\n')
    assert.equal(SvnConflictShapes.agentOption('externals', 'property', 'merged', ['svn:externals']), false)
    console.log('  ok  K2/K3/K5 second occurrence has a new identity and keeps the second local version before destructive resolution')
    if (process.platform === 'win32') {
      await writeFile(join(tree, 'held.txt'), 'local conflict\n')
      await writeFile(join(main, 'held.txt'), 'incoming conflict\n')
      await commit(main, 'Locked-file conflict')
      await run(tree, ['update', '--ignore-externals', '--accept', 'postpone'])
      const remembered = await flow.remember(action)
      assert(remembered.ok)
      const conflicted = { ...action, conflictSet: remembered.value.set }
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$f=[System.IO.File]::Open($env:JAMAT_V3_HELD_FILE,'Open','Read','Read'); try { [Console]::WriteLine('HELD'); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }"],
      { windowsHide: true, env: { ...process.env, JAMAT_V3_HELD_FILE: join(tree, 'held.txt') }, stdio: ['pipe', 'pipe', 'pipe'] })
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('File holder did not become ready')), 10_000)
          child.once('error', (error) => { clearTimeout(timer); reject(error) })
          child.stdout.on('data', (data) => { if (String(data).includes('HELD')) { clearTimeout(timer); resolve() } })
        })
        const refused = await flow.resolve(conflicted, { path: 'held.txt', option: 'take-incoming', requestedBy: 'window', by: 'person', confirm: true }, async () => {}, 'worker-resolving')
        assert.equal(refused.ok, false, JSON.stringify(refused))
        assert.equal(SvnWorktreeEvidence.lockedPaths(await run(tree, ['status', '--xml']), tree).length, 0, 'A held text file must fail before SVN queues a write')
      } finally { child.stdin.end('\n'); await closed }
      await writeFile(join(tree, 'held.txt'), 'manual merge after interrupted resolve\n')
      const checkedAgain = await flow.recheck(conflicted, () => {})
      assert.equal(checkedAgain.ok, true, JSON.stringify(checkedAgain))
      assert.equal(await manager.locked(tree), false, 'Check again must recover the locked WC before declaring a conflict settled')
      assert.equal(await readFile(join(tree, 'held.txt'), 'utf8'), 'manual merge after interrupted resolve\n')
      const firstRetry = await flow.resolve(conflicted, { path: 'held.txt', option: 'merged', requestedBy: 'window', by: 'person', confirm: true }, async () => {}, 'worker-resolving')
      assert.equal(firstRetry.ok, true, JSON.stringify(firstRetry))
      assert.equal(await readFile(join(tree, 'held.txt'), 'utf8'), 'manual merge after interrupted resolve\n')
      const secondRetry = await flow.resolve(conflicted, { path: 'held.txt', option: 'merged', requestedBy: 'window', by: 'person', confirm: true }, async () => {}, 'worker-resolving')
      assert(secondRetry.ok, JSON.stringify(secondRetry))
      assert((await manager.prepareCommit(tree, [join(tree, 'held.txt')], async () => {})).ok)
      await run(tree, ['cleanup'])
      assert.equal(await readFile(join(tree, 'held.txt'), 'utf8'), 'manual merge after interrupted resolve\n')
      console.log('  ok  R4 K8 held text fails before SVN; Check again and later cleanup preserve the manual merge')
      const externalRepository = join(root, 'external-repository')
      await run(main, ['update'])
      assert.equal((await new CommandInvoker().run({ command: 'svnadmin', args: ['create', externalRepository], cwd: root, env: process.env })).code, 0)
      await run(main, ['propset', 'svn:externals', `${pathToFileURL(externalRepository).href} library`, '.'])
      await commit(main, 'Attach external for locked recovery')
      await run(main, ['update'])
      await writeFile(join(main, 'library', 'held.txt'), 'base\n')
      await run(join(main, 'library'), ['add', 'held.txt'])
      await commit(join(main, 'library'), 'Seed external conflict')
      for (const name of ['retry-incoming.txt', 'retry-mine.txt', 'newer.txt', 'other.txt']) await writeFile(join(main, name), 'base\n')
      await run(main, ['add', 'retry-incoming.txt', 'retry-mine.txt', 'newer.txt', 'other.txt'])
      await commit(main, 'Seed repeated recovery cases')
      await run(tree, ['update', '--accept', 'postpone'])
      for (const [path, option] of [['library/held.txt', 'merged'], ['retry-incoming.txt', 'take-incoming'], ['retry-mine.txt', 'keep-mine'], ['newer.txt', 'take-incoming']] as const) {
        const external = path.startsWith('library/')
        await writeFile(join(tree, path), 'local case\n')
        await writeFile(join(main, path), 'incoming case\n')
        await commit(external ? join(main, 'library') : main, `Incoming ${path}`)
        await run(tree, ['update', '--accept', 'postpone'])
        const remembered = await flow.remember(action)
        assert(remembered.ok, JSON.stringify(remembered))
        const current = { ...action, conflictSet: remembered.value.set }
        const entry = remembered.value.set.entries.find((row) => row.path === path)!
        assert(entry)
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "$f=[System.IO.File]::Open($env:JAMAT_V3_HELD_FILE,'Open','Read','Read'); try { [Console]::WriteLine('HELD'); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }"],
        { windowsHide: true, env: { ...process.env, JAMAT_V3_HELD_FILE: join(tree, path + '.mine') }, stdio: ['pipe', 'pipe', 'pipe'] })
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('File holder did not become ready')), 10_000)
            child.once('error', (error) => { clearTimeout(timer); reject(error) })
            child.stdout.on('data', (data) => { if (String(data).includes('HELD')) { clearTimeout(timer); resolve() } })
          })
          const failed = await flow.resolve(current, { path, option: option === 'merged' ? 'take-incoming' : option,
            requestedBy: 'window', by: 'person', confirm: true }, async () => {}, 'worker-resolving')
          assert.equal(failed.ok, false, JSON.stringify(failed))
          assert(await manager.locked(tree))
        } finally { child.stdin.end('\n'); await closed }
        if (option === 'merged') {
          await writeFile(join(tree, path), 'manual external merge\n')
          const checked = await flow.recheck(current, () => {})
          assert.equal(checked.ok, true, JSON.stringify(checked))
          assert.equal(await manager.locked(tree), false)
          assert.equal(await readFile(join(tree, path), 'utf8'), 'manual external merge\n')
          const settled = await flow.recheck(current, () => {})
          assert(settled.ok, JSON.stringify(settled))
          assert.equal(settled.value.entries.find((row) => row.path === path)?.state, 'settled')
          const prepared = await manager.prepareCommit(join(tree, 'library'), [join(tree, path)], async () => {})
          assert(prepared.ok, JSON.stringify(prepared))
          await run(join(tree, 'library'), ['cleanup'])
          assert.equal(await readFile(join(tree, path), 'utf8'), 'manual external merge\n')
        }
        else if (path === 'newer.txt') {
          await writeFile(join(tree, 'other.txt'), 'older edit\n')
          const executor = new SvnConflictResolutions({ now: Date.now, markersIn: resolver.withMarkers, svn: { run: async (cwd, args, options) => {
            if (args[0] === 'cleanup') await writeFile(join(tree, 'other.txt'), 'newer edit saved during cleanup\n')
            return svn.run(cwd, args, options)
          } } })
          const recovered = await executor.apply({ root: tree, actionId: action.actionId, path, kind: entry.kind, option, journal: null,
            savedDir: join(results.savedDirectoryOf(action.actionId), 'resolutions', entry.occurrenceId!), onStep: async () => {} })
          assert.equal(recovered.ok, true, JSON.stringify(recovered))
          assert.equal(await readFile(join(tree, 'other.txt'), 'utf8'), 'newer edit saved during cleanup\n')
        }
        else {
          const opposite = option === 'take-incoming' ? 'keep-mine' : 'take-incoming'
          const settled = await flow.resolve(current, { path, option: opposite, requestedBy: 'window', by: 'person', confirm: true }, async () => {}, 'worker-resolving')
          assert(settled.ok, JSON.stringify(settled))
          assert.equal(settled.value.state, 'settled')
          assert.equal(await readFile(join(tree, path), 'utf8'), opposite === 'take-incoming' ? 'incoming case\n' : 'local case\n')
          assert.equal(await manager.locked(tree), false)
        }
      }
      console.log('  ok  R4 K8 sidecar-only queues: external Check again, opposite choices and concurrent edits preserve selected bytes')
    }
    await guarded.accept(tree)
    await writeFile(join(tree, 'outside-edit.txt'), 'saved during preparation\n')
    const guardedRunner = new SvnStepRunner({ records, scripts, svn: guarded, lease: guarded.lease, now: Date.now, newId: randomUUID, changed: () => {} })
    await assert.rejects(() => guardedRunner.run('audit', 'update', tree, ['update', '--ignore-externals', '--accept', 'postpone'],
      { stepId: 'audit-outside-update', attempt: 1 }), /changed outside Jamat/)
    assert.equal(existsSync(`${WorktreeLease.fileOf(tree)}.writer`), false)
    await guarded.accept(tree)
    assert((await guardedRunner.run('audit', 'update', tree, ['update', '--ignore-externals', '--accept', 'postpone'],
      { stepId: 'audit-outside-update', attempt: 2 })).ok)
    if (process.platform === 'win32') {
      await writeFile(`${WorktreeLease.fileOf(main)}.writer`, JSON.stringify({ pid: 999999, instanceId: 'crashed-legacy', token: randomUUID(), purpose: 'update', takenAt: 1 }))
      const releaseDeadline = Date.now() + 20_000
      for (;;) {
        try { await guarded.lease.checkAndRelease(main); break }
        catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('SVN processes are still running') || Date.now() >= releaseDeadline) throw error
          await pause(100)
        }
      }
      assert.equal(existsSync(`${WorktreeLease.fileOf(main)}.writer`), false)
    }
    console.log('  ok  N2/C1 preflight refuses without orphan marker; retry succeeds; dead legacy writer can be checked and released')
    const updated = await guarded.lease.within(main, 'update', () => guarded.run(main, ['update', '--ignore-externals', '--accept', 'postpone'], {
      onSpawn: () => writeFileSync(join(main, 'during-update.txt'), 'saved while main update starts\n'),
    }))
    assert.equal(updated.code, 0, updated.stderr)
    assert.equal(await readFile(join(main, 'during-update.txt'), 'utf8'), 'saved while main update starts\n')
    assert.equal(existsSync(`${WorktreeLease.fileOf(main)}.writer`), false)
    assert.equal(await readFile(`${WorktreeLease.fileOf(main)}.fingerprint`, 'utf8'), 'old-profile-fingerprint')
    console.log('  ok  N2/C4 local save during main update is preserved and does not poison its lease')
    const registry = join(root, 'stale-registry'), leaseRoot = join(root, 'lease-main')
    await mkdir(registry)
    await mkdir(leaseRoot)
    await writeFile(join(registry, 'old.json'), JSON.stringify({ schemaVersion: 1, instanceId: 'crashed-owner', pid: process.pid,
      configIdentity: 'fixture', runtimeChannel: 'development', startedAt: 1, applicationVersion: 'fixture', descriptorFile: join(root, 'descriptor.json') }))
    const oldLease = new WorktreeLease('crashed-owner', () => RemoteControlInstanceRegistry.readComplete(registry))
    assert((await oldLease.take(leaseRoot, 'update')).ok)
    const leaseFile = WorktreeLease.fileOf(leaseRoot)
    const oldIdentity = { ...JSON.parse(await readFile(leaseFile, 'utf8')), processBirth: '1' }
    await writeFile(leaseFile, JSON.stringify(oldIdentity))
    await writeFile(`${leaseFile}.writer`, JSON.stringify({ ...oldIdentity, children: [999999] }))
    const nextLease = new WorktreeLease('new-owner', () => RemoteControlInstanceRegistry.readComplete(registry))
    const taken = await nextLease.take(leaseRoot, 'update')
    assert(taken.ok, 'A stale registration cannot override the mismatching process birth')
    assert.equal(existsSync(`${leaseFile}.writer`), false)
    await taken.release()
    console.log('  ok  D1 real nonempty registry with reused live PID permits lease and dead-writer recovery')
    await run(main, ['propset', 'svn:eol-style', 'LF', 'held.txt'])
    await writeFile(join(main, 'held.txt'), 'first\r\nsecond\n')
    const mixed = await manager.commitHashes(main, ['held.txt'], 'node')
    assert.equal(mixed.ok, false, 'Mixed declared EOL must not silently produce a proof')
    assert(!mixed.ok && mixed.detail.includes('held.txt'), JSON.stringify(mixed))
    console.log('  ok  Mixed EOL refusal identifies its source file')
  }
}
