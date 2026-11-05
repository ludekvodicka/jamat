import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommandInvoker } from '../shared/commandInvoker'
import type { CommandRunner } from '../shared/commandInvoker.types'
import { SvnInvoker } from './svnInvoker'
import { SvnUpdateTargets } from './svnUpdateTargets'

describe('SvnUpdateTargets', () => {
  let temporary: string

  beforeEach(async () => {
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'jamat-v3-svn-update-targets-')))
  })

  afterEach(async () => {
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  })

  /** A real owner with `count` directory externals of one library, and a runner that counts every svn call. */
  async function owner(count: number) {
    const svn = new SvnInvoker()
    const run = async (cwd: string, args: string[]): Promise<void> => {
      expect(await svn.run(cwd, args), args.join(' ')).toMatchObject({ code: 0 })
    }
    const repo = join(temporary, 'repo'), side = join(temporary, 'side'), wc = join(temporary, 'wc')
    expect(await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repo], cwd: temporary, env: process.env })).toMatchObject({ code: 0 })
    const root = pathToFileURL(repo).href
    await run(temporary, ['mkdir', '-m', 'layout', `${root}/app`, `${root}/lib`])
    await run(temporary, ['checkout', root, side])
    await writeFile(join(side, 'lib', 'l.txt'), 'lib\n')
    await run(side, ['add', 'lib/l.txt'])
    const names = Array.from({ length: count }, (_, index) => `m${String(index).padStart(2, '0')}`)
    await run(side, ['propset', 'svn:externals', names.map((name) => `^/lib ${name}`).join('\n'), 'app'])
    await run(side, ['commit', '-m', 'mounts'])
    await run(temporary, ['checkout', `${root}/app`, wc])
    const calls: string[][] = []
    const counting: CommandRunner = { run: (cwd, args, options) => { calls.push(args); return svn.run(cwd, args, options) } }
    const target = { path: wc, url: `${root}/app`, repository: root, revision: 2, kind: 'dir' as const, pinned: false }
    return { targets: new SvnUpdateTargets(counting), target, calls, wc, names, run }
  }

  it('reads 30 clean mounts for protection in one status and one info call', async () => {
    const h = await owner(30)
    const before = await h.targets.snapshot(h.target, false, true)
    expect(before.protectedMounts).toEqual([])
    expect(h.calls.map((args) => args[0])).toEqual(['propget', 'propget', 'status', 'info'])
    expect(h.calls[2]).toHaveLength(3 + 30)
  })

  it('protects a mount with local edits and one with a property change, once each', async () => {
    const h = await owner(3)
    await writeFile(join(h.wc, 'm00', 'l.txt'), 'edit\n')
    await h.run(join(h.wc, 'm02'), ['propset', 'jamat:test', 'local', 'l.txt'])
    const before = await h.targets.snapshot(h.target, false, true)
    expect(before.protectedMounts).toEqual([
      { path: join(h.wc, 'm00'), url: `${h.target.repository}/lib`, repository: h.target.repository },
      { path: join(h.wc, 'm02'), url: `${h.target.repository}/lib`, repository: h.target.repository },
    ])
  })

  it('splits targets beyond one argument batch into several calls with the same result', async () => {
    const names = Array.from({ length: 300 }, (_, index) => `${'n'.repeat(80)}${String(index).padStart(3, '0')}`)
    for (const name of names) await mkdir(join(temporary, name))
    const definitions = names.map((name) => `^/lib ${name}`).join('\n')
    const calls: string[][] = []
    const runner: CommandRunner = { run: async (_cwd, args) => {
      calls.push(args)
      const targets = args.slice(args.indexOf('--') + 1).map((target) => target.replace(/@$/, ''))
      let stdout: string
      if (args[0] === 'propget') stdout = `<?xml version="1.0"?><properties><target path="."><property name="svn:externals">${definitions}</property></target></properties>`
      else if (args[0] === 'status') stdout = '<?xml version="1.0"?><status>' + targets.map((target) => `<target path="${target}"><entry path="${target}">`
        + `<wc-status item="${target === names[250] ? 'modified' : 'normal'}" props="none" revision="2"></wc-status></entry></target>`).join('') + '</status>'
      else if (args[0] === 'info') stdout = '<?xml version="1.0"?><info>' + targets.map((target) => `<entry kind="dir" path="${target}" revision="2">`
        + '<url>file:///repo/lib</url><relative-url>^/lib</relative-url><repository><root>file:///repo</root></repository></entry>').join('') + '</info>'
      else throw new Error(`unexpected svn ${args.join(' ')}`)
      return { code: 0, stdout, stderr: '', failure: null }
    } }
    const before = await new SvnUpdateTargets(runner).snapshot({ path: temporary, url: 'file:///repo/app', repository: 'file:///repo', revision: 2, kind: 'dir', pinned: false }, false, true)
    expect(before.protectedMounts).toEqual([{ path: join(temporary, names[250]), url: 'file:///repo/lib', repository: 'file:///repo' }])
    const status = calls.filter((args) => args[0] === 'status'), info = calls.filter((args) => args[0] === 'info')
    expect(status.length).toBeGreaterThan(1)
    expect(info).toHaveLength(status.length)
    expect(status.flatMap((args) => args.slice(args.indexOf('--') + 1))).toEqual(names.map((name) => `${name}@`))
    for (const args of status) expect(args.join(' ').length).toBeLessThan(24_000)
  })
})
