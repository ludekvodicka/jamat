import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { SvnInvoker } from '../../lib-orchestrator/svn/svnInvoker.js'
import { SvnWorktreeEvidence } from '../../lib-orchestrator/svn/svnWorktreeEvidence.js'
import { SvnWorktreeManager } from '../../lib-orchestrator/svn/svnWorktreeManager.js'
import { SvnWorktreeSeed } from '../../lib-orchestrator/svn/svnWorktreeSeed.js'
import { type SessionRecord, SessionRecordsStore } from '../../lib-orchestrator/sessionManager/worktreeSessionRecords.js'
import { SessionScriptsManager, ScriptLogStore } from '../../lib-orchestrator/sessionManager/worktreeSessionScripts.js'
import { ScriptChain } from '../../lib-orchestrator/sessionManager/scripts/scriptChain.js'
import { SvnStepRunner } from '../../lib-orchestrator/worktrees/svnStepRunner.js'
import { SvnCheckoutStep } from '../../lib-orchestrator/worktrees/worktreeProvision.js'
import { WorktreeLifecycleMigration } from '../../lib-orchestrator/worktrees/worktreeLifecycleMigration.js'

/**
 * The seed copy of I69 on disposable repositories with floating, pinned and file externals: real
 * creates through the checkout step, compared with a plain checkout of the same revision, and every
 * fallback the seed takes (`docs/architecture/svn-worktrees.md`, **Seed copy**).
 */
export class SvnSeedScenarios {
  static async run(parent: string): Promise<void> {
    const root = join(parent, 'seed-copy')
    await mkdir(root)
    const svn = new SvnInvoker()
    let passed = 0
    const check = (description: string, condition: boolean): void => {
      assert(condition, description)
      passed += 1
      console.log(`  ok  ${description}`)
    }
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
    const repositoryOf = async (name: string) => {
      const repository = join(root, `${name}-repository`), cwd = join(root, `${name}-main`)
      const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: root, env: process.env })
      assert.equal(created.code, 0, created.stderr)
      const url = pathToFileURL(repository).href
      await run(root, ['checkout', url, cwd])
      return { cwd, url }
    }
    const library = await repositoryOf('library')
    await writeFile(join(library.cwd, 'file.txt'), 'library\n')
    await run(library.cwd, ['add', 'file.txt'])
    await commit(library.cwd, 'Seed the library')
    const app = await repositoryOf('app'), owner = app.cwd
    await mkdir(join(owner, 'src', 'nested'), { recursive: true })
    for (let index = 0; index < 40; index++) await writeFile(join(owner, 'src', 'nested', `file-${index}.txt`), `file ${index}\n`)
    await writeFile(join(owner, 'src', 'main.ts'), 'export {}\n')
    await mkdir(join(owner, 'shared'))
    await writeFile(join(owner, 'shared', 'config.txt'), 'config\n')
    await run(owner, ['add', 'src', 'shared'])
    await commit(owner, 'Seed the application')
    await run(owner, ['propset', 'svn:global-ignores', '.worktrees', '.'])
    await run(owner, ['propset', 'svn:externals', [`${library.url} floating`, `-r1 ${library.url}@1 pinned`, '^/shared/config.txt config-copy.txt'].join('\n'), '.'])
    await commit(owner, 'Declare floating, pinned and file externals')

    const records = await SessionRecordsStore.load(join(root, 'records.json'), { snapshotsDirectory: join(root, 'snapshots') })
    const logs = new ScriptLogStore(join(root, 'logs'))
    const unreachable = async (): Promise<never> => { throw new Error('No Host in the seed scenarios') }
    const scripts = new SessionScriptsManager({ records, logs, now: () => Date.now(), onCollapsed: () => {}, report: () => {},
      host: { runtimeInspect: unreachable, runtimeRemove: unreachable, runtimeStop: unreachable } })
    let runs = 0
    const runner = new SvnStepRunner({ records, scripts, svn, now: () => Date.now(), newId: () => `seed-run-${++runs}`, changed: () => {} })
    const manager = new SvnWorktreeManager(svn)
    const seeds = new SvnWorktreeSeed(svn)
    // Every plain checkout of a few files is fast; this clock makes each one count as slow, so it makes the seed.
    let clock = 0
    const step = new SvnCheckoutStep({ records, runner, svn: manager, seed: seeds, now: () => (clock += SvnWorktreeSeed.adoptMillisecondsConst) })
    const seed = SvnWorktreeSeed.pathOf(owner)

    /** A create as the lifecycle runs it: the reservation the record is written from, then the checkout step. */
    const create = async (folder: string, prepare?: (worktreePath: string) => Promise<void>) => {
      const reserved = await manager.reserve({ ownerDir: owner, folder })
      assert(reserved.ok, JSON.stringify(reserved))
      const { worktreePath, url, baseRevision, directoryId } = reserved.value
      const checkout = ScriptChain.processStepOf('svn', 'checkout', { tool: 'svn', cwd: worktreePath,
        args: ['--non-interactive', ...SvnWorktreeManager.checkoutArgsOf(url, baseRevision, 'listed')] })
      const record: SessionRecord = { sessionId: folder, kind: 'shell', title: folder, directory: { mode: 'default' }, binding: null, life: 'starting', createdAt: 1,
        worktree: { kind: 'svn', worktreePath, repositoryRoot: owner, branch: url, baseCommit: `r${baseRevision}`, ...(directoryId === null ? {} : { directoryId }) },
        pendingSetup: { local: true, setupSessionId: `${folder}-wait`, steps: [checkout], cursor: 0 } }
      await records.put({ ...record, worktreeLifecycle: WorktreeLifecycleMigration.fromOld(record)! })
      await prepare?.(worktreePath)
      const runId = await step.run(folder, prepare !== undefined)
      return { worktreePath, revision: baseRevision, directoryId, log: (await logs.read(folder, runId, 100_000))?.text ?? '' }
    }
    const statusOf = async (path: string) => run(path, ['status', '--xml', '--no-ignore', '--', '.'])
    const revisionOf = async (path: string) => Number((await run(path, ['info', '--show-item', 'revision', '--', '.'])).trim())
    /** Every node with its item and BASE, externals included, and the bytes of every file outside `.svn`. */
    const shapeOf = async (path: string) => {
      const nodes = SvnWorktreeEvidence.statusVerboseRows(await run(path, ['status', '-v', '--xml', '--', '.']), path)
        .map((row) => `${row.path} ${row.item} ${row.props} r${row.base}`).sort()
      const files: string[] = []
      for (const entry of await readdir(path, { recursive: true, withFileTypes: true })) {
        const file = join(entry.parentPath, entry.name)
        if (!entry.isFile() || file.split(/[\\/]/).includes('.svn')) continue
        files.push(`${relative(path, file).replace(/\\/g, '/')} ${createHash('sha1').update(await readFile(file)).digest('hex')}`)
      }
      return JSON.stringify({ nodes, files: files.sort() })
    }

    const first = await create('001-first')
    check('S1 without a seed the create checks out plainly and says why', /Plain checkout; the seed was not used: there is no seed/.test(first.log))
    check('S1 a slow plain checkout becomes the seed, clean at its revision',
      existsSync(join(seed, '.svn')) && await seeds.proof(seed, first.revision) === null && await revisionOf(seed) === first.revision)

    await writeFile(join(owner, 'src', 'main.ts'), 'export const moved = 1\n')
    await writeFile(join(owner, 'shared', 'config.txt'), 'config moved\n')
    await commit(owner, 'Move the owner')
    await writeFile(join(library.cwd, 'file.txt'), 'library moved\n')
    await commit(library.cwd, 'Move the floating library')
    await mkdir(join(first.worktreePath, '.checkpoints'))
    await mkdir(join(first.worktreePath, '.next'))
    await writeFile(join(first.worktreePath, '.next', 'cache.txt'), 'build output\n')
    const seeded = await create('002-seeded')
    check('S2 the next create copies the seed and updates the copy to its reserved revision',
      /Copied the seed .* at r\d+ in [\d.]+ s; updating it to r\d+/.test(seeded.log) && await revisionOf(seeded.worktreePath) === seeded.revision
      && seeded.revision > first.revision)
    const plain = join(root, 'plain-checkout')
    await run(root, ['checkout', '-q', '--', `${app.url}@${seeded.revision}`, plain])
    check('S2 the seeded worktree equals a plain checkout of the same revision: nodes, BASE, externals and bytes',
      await shapeOf(seeded.worktreePath) === await shapeOf(plain))
    check('S2 svn status --no-ignore of the seeded worktree names nothing but externals',
      SvnWorktreeSeed.problemsOf(await statusOf(seeded.worktreePath), seeded.worktreePath, seeded.revision).length === 0
      && (await readFile(join(seeded.worktreePath, 'floating', 'file.txt'), 'utf8')) === 'library moved\n'
      && (await readFile(join(seeded.worktreePath, 'pinned', 'file.txt'), 'utf8')) === 'library\n'
      && (await readFile(join(seeded.worktreePath, 'config-copy.txt'), 'utf8')) === 'config moved\n')
    check('S2 the seeded worktree inherits nothing of another worktree and keeps the identity of the folder it reserved',
      !existsSync(join(seeded.worktreePath, '.checkpoints')) && !existsSync(join(seeded.worktreePath, '.next'))
      && seeded.directoryId !== null && seeded.directoryId !== first.directoryId && seeded.directoryId !== await SvnWorktreeManager.directoryIdOf(seed)
      && await SvnWorktreeManager.directoryIdOf(seeded.worktreePath) === seeded.directoryId)
    check('S2 the journal records the copy\'s update as the checkout step, ended',
      records.get('002-seeded')!.worktreeLifecycle!.journal.every((entry) => entry.kind === 'update' && entry.stepId.startsWith('checkout-') && entry.outcome === 'ok'))

    await writeFile(join(owner, 'src', 'main.ts'), 'export const moved = 2\n')
    await commit(owner, 'Move the owner again')
    await seeds.settled()
    const [left, right] = await Promise.all([create('003-left'), create('004-right')])
    check('S3 two creates at once both copy the one seed, one after the other, and each proves its revision',
      [left, right].every((made) => /Copied the seed/.test(made.log)) && await revisionOf(left.worktreePath) === left.revision
      && await revisionOf(right.worktreePath) === right.revision)
    await seeds.settled()
    check('S3 the background refresh brings the seed to HEAD and leaves it clean',
      await revisionOf(seed) === right.revision && await seeds.proof(seed, right.revision) === null)

    await writeFile(join(seed, 'stray.txt'), 'not versioned\n')
    const dirty = await create('005-dirty-seed')
    check('S4 a seed that is not clean falls back to a plain checkout that names the stray file, in a clean folder',
      /was no clean checkout at r\d+: svn status names stray\.txt/.test(dirty.log) && /Plain checkout/.test(dirty.log)
      && !existsSync(join(dirty.worktreePath, 'stray.txt')) && await seeds.proof(dirty.worktreePath, dirty.revision) === null)
    check('S4 that slow plain checkout replaced the unclean seed', !existsSync(join(seed, 'stray.txt')) && await seeds.proof(seed, dirty.revision) === null)

    await rm(seed, { recursive: true, force: true })
    await run(root, ['checkout', '-q', '--', library.url, seed])
    const foreign = await create('006-foreign-seed')
    check('S5 a seed of another URL and repository is not copied: plain checkout',
      new RegExp(`the seed checks out ${library.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(foreign.log) && await revisionOf(foreign.worktreePath) === foreign.revision)

    const crashed = await create('007-crashed', async (worktreePath) => {
      await mkdir(join(worktreePath, '.svn'))
      await writeFile(join(worktreePath, '.svn', 'wc.db'), 'half a database')
      await writeFile(join(worktreePath, SvnWorktreeSeed.markerConst), seed)
    })
    check('S6 recovery of a seed copy that never finished empties the folder and makes the worktree again',
      !existsSync(join(crashed.worktreePath, SvnWorktreeSeed.markerConst)) && await seeds.proof(crashed.worktreePath, crashed.revision) === null)

    await seeds.settled()
    const listed = (await readdir(join(owner, '.worktrees'))).filter((name) => !name.startsWith('.'))
    check('S7 the seed is no worktree: the folders of .worktrees without a leading dot are the seven creates',
      JSON.stringify(listed.sort()) === JSON.stringify(['001-first', '002-seeded', '003-left', '004-right', '005-dirty-seed', '006-foreign-seed', '007-crashed']))
    console.log(`\nsmoke-svn-worktree matrix seed: ${passed} checks passed`)
  }
}
