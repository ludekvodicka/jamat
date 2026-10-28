import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { SvnInvoker } from '../../lib-orchestrator/svn/svnInvoker.js'
import { SvnAssemblyReader } from '../../lib-orchestrator/svn/svnAssembly.js'

export class SvnPreparationScenarios {
  static async run(parent: string): Promise<void> {
    const root = join(parent, 'preparation')
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
    const app = await seed('app'), library = await seed('library')
    await run(app.cwd, ['propset', 'svn:externals', `${library.url} floating\n-r1 ${library.url}@1 pinned\n^/file.txt file-external.txt`, '.'])
    await run(app.cwd, ['propset', 'svn:ignore', 'cache', '.'])
    await commit(app.cwd, 'Declare externals')
    const tree = join(root, 'tree')
    await run(root, ['checkout', app.url, tree])
    const reader = new SvnAssemblyReader(svn)
    const original = await reader.read(tree, true)
    assert.deepEqual(original.incoming, [])
    assert.equal(original.nodes.filter((node) => node.path.startsWith('@mount/')).length, 4)
    assert.deepEqual(await reader.read(tree), original)
    await mkdir(join(tree, 'cache'))
    await writeFile(join(tree, 'cache', 'output'), 'ignored')
    assert.equal((await reader.read(tree)).content, original.content)
    await writeFile(join(tree, 'file.txt'), 'edited\n')
    const edited = await reader.read(tree)
    assert.notEqual(edited.content, original.content)
    await writeFile(join(tree, 'floating', 'file.txt'), 'library edit\n')
    assert.notEqual((await reader.read(tree)).content, edited.content)
    await run(tree, ['revert', 'floating/file.txt', 'file.txt'])
    await run(tree, ['propset', 'custom', 'changed', '.'])
    assert.notEqual((await reader.read(tree)).content, original.content)
    await run(tree, ['revert', '.'])
    await writeFile(join(library.cwd, 'file.txt'), 'incoming library\n')
    await writeFile(join(library.cwd, 'new.txt'), 'incoming external addition\n')
    await run(library.cwd, ['add', 'new.txt'])
    await commit(library.cwd, 'Advance only the external repository')
    await writeFile(join(app.cwd, 'new.txt'), 'incoming application addition\n')
    await run(app.cwd, ['add', 'new.txt'])
    await commit(app.cwd, 'Add an application source after preparation')
    const incoming = await reader.read(tree, true)
    assert.equal(incoming.content, original.content)
    assert(incoming.incoming.includes('floating/file.txt'))
    assert(incoming.incoming.includes('floating/new.txt'))
    assert(incoming.incoming.includes('new.txt'))
    assert.equal(incoming.metadata, original.metadata, 'Incoming additions do not invent local nodes or change the prepared metadata')
    assert(!incoming.incoming.some((path) => path.startsWith('pinned/')))
    await run(tree, ['update'])
    assert.notEqual((await reader.read(tree)).content, original.content)
    await run(join(tree, 'pinned'), ['update', '--ignore-externals'])
    await assert.rejects(reader.read(tree), /Pinned external is not at its declared revision/)
    await run(join(tree, 'pinned'), ['update', '-r1', '--ignore-externals'])
    const beforeFile = await reader.read(tree)
    await writeFile(join(tree, 'file-external.txt'), 'file external edit\n')
    assert.notEqual((await reader.read(tree)).content, beforeFile.content)
    await run(tree, ['revert', 'file-external.txt'])
    const pinnedDate = (await run(library.cwd, ['info', '--show-item', 'last-changed-date', '-r1', library.url])).trim()
    await run(tree, ['propset', 'svn:externals', `${library.url} floating\n-r1 ${library.url}@1 pinned\n-r{${pinnedDate}} ${library.url} dated\n^/file.txt file-external.txt`, '.'])
    await run(tree, ['update'])
    assert.equal((await reader.read(tree)).nodes.filter((node) => node.path.startsWith('@mount/')).length, 5)
    console.log('Preparation assembly: clean bytes, properties, ignored output, directory/file externals and external-only freshness passed')
    console.log('Pinned external: a manual BASE advance is refused; date pins and file-external edits are covered')
    console.log('Incoming additions: application and external paths are reported without reading nonexistent local files')

    const scale = await seed('scale')
    await mkdir(join(scale.cwd, 'project'))
    await mkdir(join(scale.cwd, 'unrelated'))
    await Promise.all(Array.from({ length: 1000 }, (_, index) => writeFile(join(scale.cwd, 'project', `file-${index}.txt`), `base ${index}\n`)))
    await writeFile(join(scale.cwd, 'unrelated', 'other.txt'), 'outside app\n')
    await run(scale.cwd, ['add', 'project', 'unrelated'])
    await run(scale.cwd, ['propset', 'svn:externals', Array.from({ length: 18 }, (_, index) => `${library.url} lib-${index}`).join('\n'), 'project'])
    await commit(scale.cwd, 'Seed 1000 files and 18 externals')
    const large = join(root, 'large')
    await run(root, ['checkout', `${scale.url}/project`, large])
    await Promise.all(Array.from({ length: 500 }, (_, index) => writeFile(join(large, `file-${index}.txt`), `edited ${index}\n`)))
    let calls = 0, progress = 0
    const measured = new SvnAssemblyReader({ run: async (...args) => { calls++; return svn.run(...args) } })
    const started = performance.now(), assembly = await measured.read(large, false, () => { progress++ })
    const localMs = Math.round(performance.now() - started), localCalls = calls
    assert.equal(assembly.nodes.filter((node) => node.path.startsWith('@mount/')).length, 19)
    assert(localCalls <= 4 * 19, `Batched reads must not spawn SVN per file: ${localCalls}`)
    assert(progress > 19, 'Long reads report progress inside large mounts')
    await writeFile(join(scale.cwd, 'unrelated', 'other.txt'), 'unrelated repository advance\n')
    await commit(scale.cwd, 'Advance an unrelated project')
    const freshStarted = performance.now(), fresh = await measured.read(large, true)
    assert.equal(fresh.content, assembly.content)
    assert.deepEqual(fresh.incoming, [], 'An unrelated project revision cannot invalidate the application')
    console.log(`Preparation scale: 500 changed + 500 clean files, 18 externals; local ${localMs} ms / ${localCalls} SVN calls; freshness ${Math.round(performance.now() - freshStarted)} ms / ${calls - localCalls} calls; ${progress} progress reports`)
  }
}
