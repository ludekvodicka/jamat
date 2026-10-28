import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { SvnInvoker } from '../../lib-orchestrator/svn/svnInvoker.js'
import { SvnWorktreeManager } from '../../lib-orchestrator/svn/svnWorktreeManager.js'
import { SessionRecordsStore } from '../../lib-orchestrator/sessionManager/worktreeSessionRecords.js'
import { SessionScriptsManager, ScriptLogStore } from '../../lib-orchestrator/sessionManager/worktreeSessionScripts.js'
import { SvnStepRunner } from '../../lib-orchestrator/worktrees/svnStepRunner.js'
import { WorktreeUpdate } from '../../lib-orchestrator/worktrees/worktreeUpdate.js'

export class SvnUpdateScenarios {
  static async run(parent: string): Promise<void> {
    const root = join(parent, 'update-cursor')
    await mkdir(root)
    const svn = new SvnInvoker()
    const run = async (cwd: string, args: string[]) => {
      const result = await svn.run(cwd, args)
      assert.equal(result.code, 0, result.stderr || result.stdout)
      assert.equal(result.failure, null)
      return result.stdout
    }
    const commit = async (cwd: string, text: string) => {
      const message = join(root, 'message.txt')
      await writeFile(message, `[Fixture] ${text}`)
      await run(cwd, ['commit', '--file', message, '--username', 'fixture'])
      await run(cwd, ['update'])
    }
    const seed = async (name: string) => {
      const repository = join(root, `${name}-repository`), cwd = join(root, `${name}-seed`)
      const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: root, env: process.env })
      assert.equal(created.code, 0, created.stderr)
      const url = pathToFileURL(repository).href
      await run(root, ['checkout', url, cwd])
      await writeFile(join(cwd, 'file.txt'), 'base\n')
      await run(cwd, ['add', 'file.txt'])
      await commit(cwd, `Seed ${name}`)
      return { cwd, url }
    }
    const app = await seed('app'), library = await seed('library'), inner = await seed('inner')
    await run(library.cwd, ['propset', 'svn:externals', `${inner.url} nested`, '.'])
    await commit(library.cwd, 'Add nested mount')
    const pinnedDate = (await run(library.cwd, ['info', '--show-item', 'last-changed-date', `${library.url}@1`])).trim()
    await run(app.cwd, ['propset', 'svn:global-ignores', '.worktrees', '.'])
    await run(app.cwd, ['propset', 'svn:externals', [
      `${library.url} floating`, `-r1 ${library.url}@1 pinned`, `../library-repository@{${pinnedDate}} date-pinned`,
    ].join('\n'), '.'])
    await commit(app.cwd, 'Declare floating and pinned directory externals')
    await run(app.cwd, ['update'])
    const manager = new SvnWorktreeManager(svn)
    const made = await manager.create({ ownerDir: app.cwd, folder: '001-update-cursor' })
    assert(made.ok, JSON.stringify(made))
    const tree = made.value.worktreePath
    await writeFile(join(tree, 'floating/file.txt'), 'worker edit\n')
    await writeFile(join(library.cwd, 'file.txt'), 'incoming edit\n')
    await commit(library.cwd, 'Advance floating library')
    const file = join(root, 'records.json'), options = { snapshotsDirectory: join(root, 'snapshots') }
    let records = await SessionRecordsStore.load(file, options)
    await records.put({ sessionId: 'update', kind: 'shell', title: 'Update test', life: 'ended', binding: null, directory: { mode: 'adHoc', path: tree }, createdAt: 1,
      worktree: { kind: 'svn', repositoryRoot: app.cwd, worktreePath: tree, branch: app.url, baseCommit: 'r2' },
      worktreeLifecycle: { version: 0, actionId: 'update', phase: 'finishing', step: 'syncing', outOfDate: 0, journal: [],
        facts: { worker: { liveness: 'stopped', resumeFailures: 0 } } } })
    let fail = false, loseResponse = false, nextRun = 0
    const calls: Array<{ cwd: string; args: string[] }> = []
    const build = () => {
      const unreachable = async (): Promise<never> => { throw new Error('No Host in SVN update scenarios') }
      const scripts = new SessionScriptsManager({ records, logs: new ScriptLogStore(join(root, 'logs')), now: () => Date.now(),
        onCollapsed: () => {}, report: () => {}, host: { runtimeInspect: unreachable, runtimeRemove: unreachable, runtimeStop: unreachable } })
      const runner = new SvnStepRunner({ records, scripts, now: () => Date.now(), newId: () => `update-run-${++nextRun}`, changed: () => {},
        svn: { run: async (cwd, args, options) => {
          if (args[0] === 'update') {
            calls.push({ cwd, args })
            if (fail && cwd === join(tree, 'pinned')) return { code: 1, failure: null, stdout: '', stderr: 'svn: E170013: simulated network interruption' }
          }
          const result = await svn.run(cwd, args, options)
          if (loseResponse && args[0] === 'update') { loseResponse = false; throw new Error('Lost update response') }
          return result
        } } })
      return new WorktreeUpdate({ records, runner, targets: manager.updateTargets, svn: manager, changed: () => {} })
    }
    let update = build()
    const conflicted = await update.run('update', 'update', tree, 2)
    assert.equal(conflicted.complete, false)
    assert.equal(records.get('update')!.worktreeLifecycle!.update!.units[records.get('update')!.worktreeLifecycle!.update!.cursor].target.path, join(tree, 'floating'))
    assert(!calls.some((call) => call.cwd === join(tree, 'pinned')))
    await writeFile(join(tree, 'floating/file.txt'), 'worker edit\nincoming edit\n')
    await run(join(tree, 'floating'), ['resolve', '--accept', 'working', 'file.txt'])
    fail = true
    await assert.rejects(update.run('update', 'update', tree, 2), /network interruption/)
    const completed = calls.filter((call) => call.cwd === tree || call.cwd === join(tree, 'floating')).length
    await writeFile(join(inner.cwd, 'file.txt'), 'later head\n')
    await commit(inner.cwd, 'Advance nested repository during the interrupted update')
    records = await SessionRecordsStore.load(file, options)
    update = build(); fail = false
    assert.equal((await update.run('update', 'update', tree, 999)).complete, true)
    assert.equal(calls.filter((call) => call.cwd === tree || call.cwd === join(tree, 'floating')).length, completed)
    assert.equal((await run(join(tree, 'floating/nested'), ['info', '--show-item', 'revision'])).trim(), '1')
    assert.equal((await run(join(tree, 'pinned'), ['info', '--show-item', 'revision'])).trim(), '1')
    assert.equal((await run(join(tree, 'date-pinned'), ['info', '--show-item', 'revision'])).trim(), '1')
    assert.equal(await readFile(join(tree, 'date-pinned/file.txt'), 'utf8'), 'base\n')
    const reviewRoots = await manager.reviewRoots(tree)
    assert(reviewRoots.ok)
    assert.equal(reviewRoots.value.find((item) => item.own === 'date-pinned')?.pinned, true)
    assert.equal(await readFile(join(tree, 'floating/file.txt'), 'utf8'), 'worker edit\nincoming edit\n')
    console.log('  ok  UPDATE cursor survives conflict, failure and reload; completed roots are not replayed and saved pins remain fixed')

    loseResponse = true
    await assert.rejects(update.run('update', 'update', tree, 2), /Lost update response/)
    const pending = records.get('update')!.worktreeLifecycle!.journal.find((entry) => entry.endedAt === undefined)
    assert(pending)
    records = await SessionRecordsStore.load(file, options)
    update = build()
    assert.equal(await update.recover('update', pending, false), true)
    assert.equal((await update.run('update', 'update', tree, 2)).complete, true)
    assert.equal((await run(join(tree, 'floating/nested'), ['info', '--show-item', 'revision'])).trim(), '2')
    assert.equal(records.get('update')!.worktreeLifecycle!.journal.some((entry) => entry.endedAt === undefined), false)
    console.log('  ok  UPDATE recovers a lost response at its fixed target and a fresh run receives newer nested HEAD')

    await run(app.cwd, ['propset', 'svn:externals', [
      `${library.url} floating`, `-r1 ${library.url}@1 pinned`, '^/file.txt@1 file-external.txt', '^/file.txt floating-file.txt', `${inner.url} new-mount`,
    ].join('\n'), '.'])
    await writeFile(join(app.cwd, 'file.txt'), 'incoming application\n')
    await commit(app.cwd, 'Add an incoming mount')
    assert.equal((await update.run('update', 'update', tree, 3)).complete, true)
    assert.equal(await readFile(join(tree, 'new-mount/file.txt'), 'utf8'), 'later head\n')
    assert.equal(await readFile(join(tree, 'floating-file.txt'), 'utf8'), 'incoming application\n')
    assert.equal(await readFile(join(tree, 'file-external.txt'), 'utf8'), 'base\n')
    assert(records.get('update')!.worktreeLifecycle!.journal.some((entry) => entry.stepId.endsWith('-externals')))
    console.log('  ok  UPDATE reconciles an incoming external definition through SVN and verifies the newly registered mount')

    await writeFile(join(app.cwd, 'file.txt'), 'later application\n')
    await commit(app.cwd, 'Advance a floating file external without changing definitions')
    const beforeFileUpdate = calls.length
    assert.equal((await update.run('update', 'update', tree, 4)).complete, true)
    assert.equal(await readFile(join(tree, 'floating-file.txt'), 'utf8'), 'later application\n')
    assert.equal(await readFile(join(tree, 'file-external.txt'), 'utf8'), 'base\n')
    assert(calls.slice(beforeFileUpdate).some((call) => !call.args.includes('--ignore-externals')))
    const fileStatus = await run(tree, ['status', '-v', '--xml', '--depth', 'empty', 'floating-file.txt'])
    assert(fileStatus.includes('file-external="true"'))
    console.log('  ok  UPDATE advances a floating file external through its carrier, retaining registration and pinned bytes')

    await writeFile(join(tree, 'floating-file.txt'), 'local file external edit\n')
    await writeFile(join(app.cwd, 'file.txt'), 'conflicting application edit\n')
    await commit(app.cwd, 'Conflict with a local file external edit')
    assert.equal((await update.run('update', 'update', tree, 5)).complete, false)
    const fileConflicts = await manager.conflictSet(tree, 5)
    assert(fileConflicts.ok)
    assert.equal(fileConflicts.value.facts.length, 1)
    await writeFile(join(tree, 'floating-file.txt'), 'local file external edit\nconflicting application edit\n')
    await run(tree, ['resolve', '--accept', 'working', 'floating-file.txt'])
    assert.equal((await update.run('update', 'update', tree, 5)).complete, true)
    assert.equal(await readFile(join(tree, 'floating-file.txt'), 'utf8'), 'local file external edit\nconflicting application edit\n')
    assert((await run(tree, ['status', '-v', '--xml', '--depth', 'empty', 'floating-file.txt'])).includes('file-external="true"'))
    console.log('  ok  UPDATE resumes after a file-external conflict, retaining local bytes and native registration')

    await run(tree, ['revert', 'floating-file.txt'])
    await run(app.cwd, ['propset', 'svn:externals', [
      `${library.url} floating`, `-r1 ${library.url}@1 pinned`, `${inner.url} new-mount`,
    ].join('\n'), '.'])
    await commit(app.cwd, 'Remove file externals before testing independent directory conflicts')
    assert.equal((await update.run('update', 'update', tree, 6)).complete, true)

    for (const mount of ['new-mount', 'floating/nested']) await writeFile(join(tree, mount, 'file.txt'), 'local nested edit\n')
    await writeFile(join(inner.cwd, 'file.txt'), 'incoming nested edit\n')
    await commit(inner.cwd, 'Conflict in two independently mounted copies')
    for (const mount of ['new-mount', 'floating/nested']) {
      assert.equal((await update.run('update', 'update', tree, 6)).complete, false)
      const state = records.get('update')!.worktreeLifecycle!.update!
      assert.equal(state.units[state.cursor].target.path, join(tree, mount))
      const conflicts = await manager.conflictSet(tree, 6)
      assert(conflicts.ok)
      assert.equal(conflicts.value.facts.length, 1)
      await writeFile(join(tree, mount, 'file.txt'), 'local nested edit\nincoming nested edit\n')
      await run(join(tree, mount), ['resolve', '--accept', 'working', 'file.txt'])
    }
    assert.equal((await update.run('update', 'update', tree, 6)).complete, true)
    for (const mount of ['new-mount', 'floating/nested'])
      assert.equal(await readFile(join(tree, mount, 'file.txt'), 'utf8'), 'local nested edit\nincoming nested edit\n')
    console.log('  ok  UPDATE pauses independently for conflicts in two mounts and preserves both resolutions before completing')
    const definitions = await run(app.cwd, ['propget', 'svn:externals', '.'])
    const oldUrl = (await run(join(tree, 'new-mount'), ['info', '--show-item', 'url', '.'])).trim()
    for (const mode of ['removed', 'redirected'] as const) {
      const changed = definitions.split(/\r?\n/).flatMap((line) => line.includes('new-mount')
        ? mode === 'removed' ? [] : [`${library.url} new-mount`] : [line]).join('\n')
      await run(app.cwd, ['propset', 'svn:externals', changed, '.'])
      await commit(app.cwd, `${mode} dirty mount definition`)
      const revision = Number((await run(app.cwd, ['info', '--show-item', 'revision', '.'])).trim())
      await records.update('update', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, update: undefined } }))
      await assert.rejects(update.run('update', 'update', tree, revision), /contains local changes.*removed or redirected/)
      assert.equal((await run(join(tree, 'new-mount'), ['info', '--show-item', 'url', '.'])).trim(), oldUrl)
      assert.equal(await readFile(join(tree, 'new-mount/file.txt'), 'utf8'), 'local nested edit\nincoming nested edit\n')
      await run(app.cwd, ['propset', 'svn:externals', definitions, '.'])
      await commit(app.cwd, 'Restore fixture mapping')
      await run(tree, ['update', '--ignore-externals', '--accept', 'postpone'])
    }
    console.log('  ok  X2 removed and redirected dirty externals remain at their original URL with local content intact')

    const main = await seed('main'), mounted = await seed('mounted')
    await writeFile(join(main.cwd, 'older.txt'), 'base\n')
    await writeFile(join(main.cwd, 'prop.txt'), 'base\n')
    await run(main.cwd, ['add', 'older.txt', 'prop.txt'])
    await run(main.cwd, ['propset', 'svn:externals', `${mounted.url} lib/ea`, '.'])
    await commit(main.cwd, 'Main copy with a mounted library')
    const copy = join(root, 'main-copy')
    await run(root, ['checkout', main.url, copy])
    await writeFile(join(main.cwd, 'older.txt'), 'earlier commit\n')
    await run(main.cwd, ['propset', 'jamat:test', 'earlier', 'prop.txt'])
    await commit(main.cwd, 'Earlier commit the main copy conflicts with')
    await writeFile(join(copy, 'older.txt'), 'personal\n')
    await run(copy, ['propset', 'jamat:test', 'personal', 'prop.txt'])
    await run(copy, ['update', '--accept', 'postpone'])
    const before = await manager.status(copy)
    assert(before.ok)
    assert.deepEqual([before.value.textConflicts, before.value.otherConflicts], [['older.txt'], ['prop.txt']])
    const marked = await readFile(join(copy, 'older.txt'), 'utf8')
    await writeFile(join(main.cwd, 'file.txt'), 'published application\n')
    await writeFile(join(main.cwd, 'older.txt'), 'published over the older conflict\n')
    await writeFile(join(main.cwd, 'prop.txt'), 'published over the older property conflict\n')
    await commit(main.cwd, 'Published application change')
    await writeFile(join(mounted.cwd, 'file.txt'), 'published library\n')
    await commit(mounted.cwd, 'Published library change')
    const head = Number((await run(main.cwd, ['info', '--show-item', 'revision', main.url])).trim())
    await records.put({ sessionId: 'older', kind: 'shell', title: 'Older conflict', life: 'ended', binding: null, directory: { mode: 'adHoc', path: copy }, createdAt: 1,
      worktreeLifecycle: { version: 0, actionId: 'older', phase: 'finishing', step: 'syncing', outOfDate: 0, journal: [],
        facts: { worker: { liveness: 'stopped', resumeFailures: 0 } } } })
    const older = [...before.value.textConflicts, ...before.value.otherConflicts]
    assert.equal((await update.run('older', 'older', copy, head)).complete, false)
    assert.equal((await run(join(copy, 'lib/ea'), ['info', '--show-item', 'revision', '.'])).trim(), '1')
    assert.equal((await update.run('older', 'older', copy, head, older)).complete, true)
    assert.equal(await readFile(join(copy, 'file.txt'), 'utf8'), 'published application\n')
    assert.equal(await readFile(join(copy, 'lib/ea/file.txt'), 'utf8'), 'published library\n')
    assert.equal(await readFile(join(copy, 'older.txt'), 'utf8'), marked)
    const after = await manager.status(copy)
    assert(after.ok)
    assert.deepEqual([after.value.textConflicts, after.value.otherConflicts], [['older.txt'], ['prop.txt']])
    console.log('  ok  MW07 conflicts the main copy held before UPDATE stop no target: svn skips them, the root and its external reach the published revisions')
  }
}
