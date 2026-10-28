import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { SvnConflictResolutions } from '../../lib-orchestrator/svn/svnConflictResolutions.js'
import { SvnConflictShapes } from '../../lib-orchestrator/svn/svnConflictShapes.js'
import { SvnInvoker } from '../../lib-orchestrator/svn/svnInvoker.js'
import { SvnWorktreeManager } from '../../lib-orchestrator/svn/svnWorktreeManager.js'

/** Real merge conflicts exercise the production reader and executor, including a source outside target BASE. */
export class SvnBranchConflicts {
  static async run(root: string, svn: SvnInvoker): Promise<void> {
    const repository = join(root, 'branch-conflicts-repo')
    const target = join(root, 'branch-conflicts-target')
    const worker = join(root, 'branch-conflicts-worker')
    const seed = join(root, 'branch-conflicts-seed')
    const message = join(root, 'branch-message.txt')
    const url = pathToFileURL(repository).href
    const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: root, env: process.env })
    assert.equal(created.code, 0, created.stderr)
    const run = async (cwd: string, args: string[]): Promise<string> => {
      const answer = await svn.run(cwd, [args[0], '--non-interactive', ...args.slice(1)])
      assert.equal(answer.code, 0, `${args.join(' ')}: ${answer.stderr}`)
      assert.equal(answer.failure, null)
      return answer.stdout
    }
    await writeFile(message, '[fixture] Exercise branch conflict provenance\n')
    await run(root, ['checkout', url, seed])
    await mkdir(join(seed, 'trunk'))
    await mkdir(join(seed, 'branches'))
    await writeFile(join(seed, 'trunk', 'a.txt'), 'base\n')
    await run(seed, ['add', 'trunk', 'branches'])
    await run(seed, ['propset', 'fixture:policy', 'base', 'trunk/a.txt'])
    await run(seed, ['propset', 'svn:ignore', 'common\nold\n', 'trunk'])
    await run(seed, ['commit', '-F', message])
    await run(root, ['copy', `${url}/trunk@1`, `${url}/branches/feature`, '-F', message])
    await run(root, ['checkout', `${url}/branches/feature`, worker])
    await writeFile(join(worker, 'a.txt'), 'incoming\n')
    await mkdir(join(worker, 'new'))
    await writeFile(join(worker, 'new', 'shared.txt'), 'incoming tree\n')
    await run(worker, ['add', 'new'])
    await run(worker, ['propset', 'fixture:policy', 'incoming', 'a.txt'])
    await run(worker, ['propset', 'svn:ignore', 'common\nincoming\n', '.'])
    await run(worker, ['commit', '-F', message])
    await run(root, ['checkout', `${url}/trunk`, target])
    await writeFile(join(target, 'a.txt'), 'target\n')
    await mkdir(join(target, 'new'))
    await writeFile(join(target, 'new', 'shared.txt'), 'target tree\n')
    await run(target, ['add', 'new'])
    await run(target, ['propset', 'fixture:policy', 'target', 'a.txt'])
    await run(target, ['propset', 'svn:ignore', 'common\nmine\n', '.'])
    await run(target, ['commit', '-F', message])
    await run(target, ['update'])
    await run(target, ['merge', `${url}/branches/feature@3`, '--accept', 'postpone'])
    const read = await new SvnWorktreeManager(svn).conflictSet(target, 4)
    assert.ok(read.ok, read.ok ? '' : read.detail)
    // The read gives a path with a text and a property conflict one fact of each kind.
    const property = read.value.facts.find((fact) => fact.path === 'a.txt' && fact.kind === 'property')!
    const text = read.value.facts.find((fact) => fact.path === 'a.txt' && fact.kind === 'text')!
    assert.deepEqual(property.properties, [{ name: 'fixture:policy', older: 'base', mine: 'target', theirs: 'incoming' }])
    assert.equal(text.content?.equal, 'differs')
    console.log('  ok  branch property conflict reads source-left/source-right revisions, not target BASE')
    const tree = read.value.facts.find((fact) => fact.path === 'new')!
    assert.equal(tree.tree?.operation, 'merge')
    assert.equal(tree.content, null)
    assert.deepEqual(SvnConflictShapes.planOf(tree), { shape: 'unrecognized', options: ['merged', 'keep-mine'], rule: null, agent: false })
    console.log('  ok  branch tree conflict has no automatic revert-to-BASE rule')
    const executor = new SvnConflictResolutions({ svn, now: Date.now, markersIn: async () => [] })
    const savedDir = join(root, 'branch-conflicts-saved')
    const blocked = await executor.apply({ root: target, savedDir, path: 'new', kind: 'tree', option: 'keep-both', journal: null, onStep: async () => assert.fail('no destructive step may run') })
    assert.ok(!blocked.ok && blocked.code === 'refused')
    assert.equal(await readFile(join(target, 'new', 'shared.txt'), 'utf8'), 'target tree\n')
    console.log('  ok  direct executor refuses the unsafe tree option before changing local bytes')
    const merged = await executor.apply({ root: target, savedDir, path: '.', kind: 'property', option: 'union', properties: ['svn:ignore'], journal: null, onStep: async () => {} })
    assert.ok(merged.ok, merged.ok ? '' : merged.detail)
    assert.equal((await run(target, ['propget', 'svn:ignore', '--no-newline', '.'])).replaceAll('\r\n', '\n'), 'common\nincoming\nmine\n')
    console.log('  ok  branch property union preserves both additions using the actual common ancestor')
    const verified = await new CommandInvoker().run({ command: 'svnadmin', args: ['verify', repository], cwd: root, env: process.env })
    assert.equal(verified.code, 0, verified.stderr)
    console.log('smoke-svn-worktree branch conflicts: 4 scenarios passed; repository verified')
  }
}
