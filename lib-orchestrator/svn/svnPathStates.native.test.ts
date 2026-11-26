import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { CommandInvoker } from '../shared/commandInvoker'
import { ContentHashCache } from './svnContentHash'
import { SvnIgnoreRules } from './svnIgnoreRules'
import { SvnInvoker } from './svnInvoker'
import { SvnPathStates } from './svnPathStates'
import { SvnProps } from './svnProps'

const testRoot = 'Q:/UnitTestFiles/NodeJs/Applications/Jamat/worktrees'
const ignores = SvnIgnoreRules.fromRuntimeConfig(process.env.APPDATA ?? '')

/** A working copy with one committed file per rule of D3, a directory external and a text conflict. */
async function fixture(name: string) {
  const root = await mkdtemp(join(testRoot, `${name}-`)), svn = new SvnInvoker()
  const run = async (cwd: string, args: string[]) => {
    const result = await svn.run(cwd, args)
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }
  const repo = join(root, 'repo'), wc = join(root, 'wc'), other = join(root, 'other'), seed = join(root, 'seed')
  expect((await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repo], cwd: root, env: process.env })).code).toBe(0)
  const url = pathToFileURL(repo).href
  await run(root, ['mkdir', '--parents', '-m', 'Layout', `${url}/trunk`, `${url}/shared/lib`])
  await run(root, ['checkout', `${url}/shared/lib`, seed])
  await writeFile(join(seed, 'lib0.txt'), 'lib\n')
  await run(seed, ['add', 'lib0.txt'])
  await run(seed, ['commit', '-m', 'Library'])
  await run(root, ['checkout', `${url}/trunk`, wc])
  const files = ['clean.txt', 'same.txt', 'touched.txt', 'del.txt', 'mv.txt', 'prop.txt', 'conflict.txt', 'missing.txt', 'eol.txt',
    'eolchg.txt', 'eollf.txt', 'kw.txt']
  for (const file of files) await writeFile(join(wc, file), file.startsWith('eol') ? 'a\nb\n' : `${file}\n`)
  await mkdir(join(wc, 'Mixed'))
  await writeFile(join(wc, 'Mixed', 'Case.txt'), 'case\n')
  await writeFile(join(wc, 'Mixed', 'Gone.txt'), 'gone\n')
  await run(wc, ['add', '--force', '.'])
  for (const file of ['eol.txt', 'eolchg.txt', 'eollf.txt']) await run(wc, ['propset', 'svn:eol-style', 'native', file])
  await run(wc, ['propset', 'svn:keywords', 'Id', 'kw.txt'])
  await run(wc, ['propset', 'svn:externals', '^/shared/lib ext', '.'])
  await run(wc, ['commit', '-m', 'Fixture'])
  await run(wc, ['update'])
  await run(root, ['checkout', `${url}/trunk`, other, '--ignore-externals'])
  await writeFile(join(other, 'conflict.txt'), 'theirs\n')
  await run(other, ['commit', '-m', 'Their change'])
  await writeFile(join(wc, 'conflict.txt'), 'mine\n')
  await run(wc, ['update', '--accept', 'postpone'])
  return { root, wc, svn }
}

type StatusOf = (path: string) => 'clean' | 'dirty'

/** `svn status --xml -v --no-ignore` of `wc`, read for one path: an unlisted path takes its nearest listed ancestor's answer. */
async function statusOf(svn: SvnInvoker, wc: string): Promise<StatusOf> {
  const result = await svn.run(wc, ['status', '--xml', '-v', '--no-ignore', '--ignore-externals'])
  expect(result.code, result.stderr).toBe(0)
  const items = new Map<string, 'clean' | 'dirty'>()
  for (const match of result.stdout.matchAll(/<entry\s+path="([^"]+)">\s*<wc-status([^>]*)>/g)) {
    const item = /item="([^"]+)"/.exec(match[2]!)![1]!, props = /props="([^"]+)"/.exec(match[2]!)?.[1] ?? 'none'
    const clean = ['normal', 'ignored', 'external', 'none'].includes(item) && ['none', 'normal'].includes(props)
    items.set(join(wc, match[1]!).toLowerCase(), clean ? 'clean' : 'dirty')
  }
  return (path) => {
    for (let at = path.toLowerCase(); at.length >= wc.length; at = at.slice(0, Math.max(at.lastIndexOf('\\'), 0))) {
      const found = items.get(at)
      if (found !== undefined) return found
    }
    return 'clean'
  }
}

describe.skipIf(process.platform !== 'win32' || !existsSync(testRoot))('SvnPathStates on a real working copy', () => {
  it('decides every D3 rule as svn status does', async () => {
    const { root, wc, svn } = await fixture('native-path-states')
    try {
      const at = (path: string) => join(wc, path)
      await writeFile(at('same.txt'), 'SAME.txt\n')
      await utimes(at('touched.txt'), new Date(), new Date(Date.now() + 60_000))
      await writeFile(at('eol.txt'), 'a\r\nb\r\n')
      await writeFile(at('eolchg.txt'), 'a\r\nc\r\n')
      await writeFile(at('eollf.txt'), 'a\nb\n')
      await utimes(at('kw.txt'), new Date(), new Date(Date.now() + 60_000))
      await writeFile(join(wc, 'added.txt'), 'added\n')
      const svnRun = async (args: string[]) => expect((await svn.run(wc, args)).code).toBe(0)
      await svnRun(['add', 'added.txt'])
      await svnRun(['delete', 'del.txt'])
      await svnRun(['move', 'mv.txt', 'moved.txt'])
      await svnRun(['propset', 'demo:flag', 'on', 'prop.txt'])
      await rm(at('missing.txt'))
      await rm(at('Mixed/Gone.txt'))

      const hashes = new ContentHashCache()
      const states = new SvnPathStates({ ignores, hashes })
      const expected: Record<string, string> = {
        'clean.txt': 'clean', 'same.txt': 'dirty:modified', 'touched.txt': 'clean', 'added.txt': 'dirty:added',
        'del.txt': 'dirty:deleted', 'mv.txt': 'dirty:moved', 'moved.txt': 'dirty:moved', 'prop.txt': 'dirty:props',
        'conflict.txt': 'dirty:conflict', 'missing.txt': 'dirty:missing', 'eol.txt': 'clean', 'eolchg.txt': 'dirty:modified',
        'eollf.txt': 'clean', 'kw.txt': 'dirty:modified', 'Mixed/Case.txt': 'clean', 'Mixed': 'clean',
      }
      const paths = Object.keys(expected).map(at)
      const facts = states.read(wc, paths)
      const label = (path: string) => {
        const state = facts.get(path)!.state
        return state.kind === 'dirty' ? `dirty:${state.reason}` : state.kind
      }
      expect(Object.fromEntries(Object.keys(expected).map((path) => [path, label(at(path))]))).toEqual(expected)
      expect(facts.get(at('clean.txt'))!.changedAtMs).toBeGreaterThan(Date.now() - 600_000)
      expect(facts.get(at('added.txt'))!.changedAtMs).toBeNull()

      // svn contracts keywords before comparing; D3 reports such a touched file changed without reading it.
      const status = await statusOf(svn, wc)
      for (const path of Object.keys(expected).filter((path) => path !== 'kw.txt'))
        expect(`${path}: ${label(at(path)).split(':')[0]}`).toBe(`${path}: ${status(at(path))}`)

      const reads = hashes.reads
      states.read(wc, [at('touched.txt'), at('clean.txt')])
      expect(hashes.reads).toBe(reads)

      const lower = states.read(wc, [at('mixed/case.txt'), at('mixed/gone.txt')])
      expect(lower.get(at('mixed/case.txt'))!.state).toEqual({ kind: 'clean' })
      expect(lower.get(at('mixed/gone.txt'))!.state).toEqual({ kind: 'dirty', reason: 'missing' })
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 120_000)

  it('reads an untouched committed file without hashing it, and a file of an external against its own database', async () => {
    const { root, wc } = await fixture('native-path-external')
    try {
      const hashes = new ContentHashCache()
      const states = new SvnPathStates({ ignores, hashes })
      expect(states.read(wc, [join(wc, 'clean.txt')]).get(join(wc, 'clean.txt'))!.state).toEqual({ kind: 'clean' })
      expect(hashes.size).toBe(0)
      const external = join(wc, 'ext'), file = join(external, 'lib0.txt')
      expect(states.read(external, [file]).get(file)!.state).toEqual({ kind: 'clean' })
      await writeFile(file, 'external change\n')
      expect(states.read(external, [file]).get(file)!.state).toEqual({ kind: 'dirty', reason: 'modified' })
      const outside = join(root, 'repo', 'format')
      expect(states.read(wc, [outside]).get(outside)!.state).toEqual({ kind: 'outside' })
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 120_000)

  it('decides unversioned paths as svn status does, ignore properties and the runtime config included', async () => {
    const { root, wc, svn } = await fixture('native-path-ignores')
    try {
      const svnRun = async (args: string[]) => expect((await svn.run(wc, args)).code).toBe(0)
      for (const directory of ['app', 'd1', 'd2', 'd3', 'sound']) await mkdir(join(wc, directory))
      await svnRun(['add', 'app', 'd1', 'd2', 'd3', 'sound'])
      await svnRun(['propset', 'svn:ignore', 'node_modules\n', 'app'])
      await svnRun(['propset', 'svn:global-ignores', '*.wav', '.'])
      // Only the new directories and the root's property: the fixture's text conflict stays uncommitted.
      await svnRun(['commit', '-m', 'Ignores', '--depth', 'empty', '.', 'app', 'd1', 'd2', 'd3', 'sound'])
      const files = ['app/node_modules/x.js', '.checkpoints/a', 'sound/x.wav', 'app/new.ts', 'app/added.ts', 'newdir/a.ts', 'd1/Thumbs.db',
        'd2/thumbs.db', 'd3/THUMBS.DB', 'app/notes.txt']
      for (const file of files) {
        await mkdir(join(wc, file, '..'), { recursive: true })
        await writeFile(join(wc, file), 'x\n')
      }
      await svnRun(['add', 'app/added.ts'])
      await writeFile(join(wc, 'app', 'gone.ts'), 'x\n')
      await rm(join(wc, 'app', 'gone.ts'))

      const states = new SvnPathStates({ ignores })
      const paths = [...files, 'app/gone.ts'].map((file) => join(wc, file))
      const facts = states.read(wc, paths)
      const label = (path: string) => {
        const state = facts.get(join(wc, path))!.state
        return state.kind === 'dirty' ? `dirty:${state.reason}` : state.kind
      }
      expect(Object.fromEntries([...files, 'app/gone.ts'].map((file) => [file, label(file)]))).toEqual({
        'app/node_modules/x.js': 'clean', '.checkpoints/a': ignores.ignored('.checkpoints', SvnProps.emptyConst, []) ? 'clean' : 'dirty:unversioned',
        'sound/x.wav': 'clean', 'app/new.ts': 'dirty:unversioned', 'app/added.ts': 'dirty:added', 'newdir/a.ts': 'dirty:unversioned',
        'd1/Thumbs.db': 'clean', 'd2/thumbs.db': 'clean', 'd3/THUMBS.DB': 'dirty:unversioned', 'app/notes.txt': 'dirty:unversioned',
        'app/gone.ts': 'clean',
      })
      const status = await statusOf(svn, wc)
      for (const file of files) expect(`${file}: ${label(file).split(':')[0]}`).toBe(`${file}: ${status(join(wc, file))}`)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 120_000)

  it('answers unknown while svn holds a working-copy lock or the database is locked, without waiting', async () => {
    const { root, wc } = await fixture('native-path-locks')
    try {
      const file = join(wc, 'clean.txt'), states = new SvnPathStates({ ignores })
      const writer = new DatabaseSync(join(wc, '.svn', 'wc.db'))
      try {
        writer.exec("INSERT INTO WC_LOCK (wc_id, local_dir_relpath, locked_levels) VALUES (1, '', -1)")
        expect(states.read(wc, [file]).get(file)!.state).toEqual({ kind: 'unknown', detail: 'work queue or lock' })
        writer.exec('DELETE FROM WC_LOCK')
        writer.exec('BEGIN EXCLUSIVE')
        const started = Date.now()
        expect(states.read(wc, [file]).get(file)!.state).toEqual({ kind: 'unknown', detail: 'busy' })
        expect(Date.now() - started).toBeLessThan(1_000)
        writer.exec('ROLLBACK')
      } finally { writer.close() }
      expect(states.read(wc, [file]).get(file)!.state).toEqual({ kind: 'clean' })
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 120_000)
})
