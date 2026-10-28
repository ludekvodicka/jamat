import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { SvnInvoker } from '../../lib-orchestrator/svn/svnInvoker.js'
import { SvnTextResolution } from '../../lib-orchestrator/svn/svnTextResolution.js'

export class SvnTextResolutionScenarios {
  static async run(parent: string): Promise<void> {
    const root = join(parent, 'text-translation'), svn = new SvnInvoker()
    await mkdir(root)
    const run = async (cwd: string, args: string[]) => {
      const result = await svn.run(cwd, args)
      assert.equal(result.code, 0, result.stderr)
      return result.stdout
    }
    const repo = join(root, 'repo'), main = join(root, 'main'), direct = join(root, 'direct'), working = join(root, 'working')
    assert.equal((await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repo], cwd: root, env: process.env })).code, 0)
    const url = pathToFileURL(repo).href
    await run(root, ['checkout', url, main])
    const message = join(root, 'message.txt')
    await writeFile(message, '[Fixture] Text resolution translation')
    const commit = (cwd: string) => run(cwd, ['commit', '--file', message])
    const cases = ['native', 'LF', 'CRLF'].flatMap((eol) => (['mine', 'theirs'] as const).map((side) => ({ eol, side, name: `${eol}-${side}.txt` })))
    for (const { eol, name } of cases) {
      await writeFile(join(main, name), '$Rev$\nbase\n')
      await run(main, ['add', name])
      await run(main, ['propset', 'svn:eol-style', eol, name])
      await run(main, ['propset', 'svn:keywords', 'Rev', name])
    }
    await commit(main)
    await run(root, ['checkout', url, direct])
    await run(root, ['checkout', url, working])
    for (const { name } of cases)
      for (const [cwd, text] of [[direct, 'local'], [working, 'local'], [main, 'incoming']])
        await writeFile(join(cwd, name), (await readFile(join(cwd, name), 'utf8')).replace('base', text))
    await commit(main)
    for (const cwd of [direct, working]) await run(cwd, ['update', '--accept', 'postpone'])
    const resolution = new SvnTextResolution(svn)
    for (const { side, name } of cases) {
      await resolution.choose({ root: working, savedDir: join(root, 'copies', name), path: name, kind: 'text',
        option: side === 'mine' ? 'keep-mine' : 'take-incoming', journal: null, onStep: async () => {} }, side)
      assert.equal((await resolution.resolve(working, name)).ok, true)
      await run(direct, ['resolve', '--accept', `${side}-full`, name])
      assert.deepEqual(await readFile(join(working, name)), await readFile(join(direct, name)), name)
    }
    console.log('[svn-audit] Text choice + accept working matches native SVN bytes for native/LF/CRLF and expanded Rev keywords, both sides')
  }
}
