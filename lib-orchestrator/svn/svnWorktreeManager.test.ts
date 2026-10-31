import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommandOutcome, CommandRunner } from '../shared/commandInvoker.types'
import type { SvnRoot, SvnWorktreeLocation } from './svn.types'
import { SvnWorktreeManager } from './svnWorktreeManager'
import { CommandInvoker } from '../shared/commandInvoker'
import { SvnInvoker } from './svnInvoker'

/** Paths whose next purge fails, the way a file another process holds makes it fail. */
const purgeFailures = vi.hoisted(() => new Map<string, Error>())

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      const failure = purgeFailures.get(String(path))
      return failure === undefined ? actual.rm(path, options) : Promise.reject(failure)
    },
  }
})

const url = 'file:///repository/Project'
const repository = 'file:///repository'

type Reply = Partial<CommandOutcome> | undefined
type Handler = (cwd: string, args: string[]) => Reply | Promise<Reply>

/** A runner that answers by command; an unexpected command fails the test with its arguments. */
function scripted(handler: Handler) {
  const calls: { cwd: string; args: string[] }[] = []
  const runner: CommandRunner = { run: async (cwd, args) => {
    calls.push({ cwd, args })
    const reply = await handler(cwd, args)
    if (reply === undefined) throw new Error(`unexpected svn ${args.join(' ')} in ${cwd}`)
    return { code: 0, stdout: '', stderr: '', failure: null, ...reply }
  } }
  return { manager: new SvnWorktreeManager(runner), runner, calls }
}

const failed = (stderr: string): Reply => ({ code: 1, stderr })

function infoXml(options: { revision?: number; entryUrl?: string; wcRoot?: string; path?: string } = {}): string {
  return infoListXml([options])
}

function infoListXml(entries: Parameters<typeof infoXml>[0][]): string {
  return '<?xml version="1.0"?><info>' + entries.map((options = {}) => {
    const entryUrl = options.entryUrl ?? url
    return `<entry kind="dir" path="${options.path ?? '.'}" revision="${options.revision ?? 41}">`
      + `<url>${entryUrl}</url><relative-url>^${entryUrl.slice(repository.length) || '/'}</relative-url>`
      + `<repository><root>${repository}</root></repository>`
      + (options.wcRoot === undefined ? '' : `<wc-info><wcroot-abspath>${options.wcRoot}</wcroot-abspath></wc-info>`)
      + '</entry>'
  }).join('') + '</info>'
}

function landingInfoXml(args: readonly string[], base = url, wcRoot?: string): string {
  return infoListXml(args.slice(args.indexOf('--') + 1).map((target) => {
    const path = target.replace(/@$/, '')
    return { path, wcRoot, entryUrl: path === '.' ? base : `${base}/${path}` }
  }))
}

interface Entry { path: string; item: string; props?: string; revision?: number; changed?: number; tree?: true }

function statusXml(entries: readonly Entry[]): string {
  return '<?xml version="1.0"?><status><target path=".">' + entries.map((entry) =>
    `<entry path="${entry.path}"><wc-status item="${entry.item}" props="${entry.props ?? 'none'}"`
    + (entry.revision === undefined ? '' : ` revision="${entry.revision}"`)
    + (entry.tree === true ? ' tree-conflicted="true"' : '') + '>'
    + (entry.changed === undefined ? '' : `<commit revision="${entry.changed}"/>`)
    + '</wc-status></entry>').join('') + '</target></status>'
}

function logXml(revision: number, paths: readonly { action: string; path: string }[]): string {
  return `<?xml version="1.0"?><log><logentry revision="${revision}"><paths>`
    + paths.map((path) => `<path action="${path.action}" kind="file">${path.path}</path>`).join('')
    + '</paths></logentry></log>'
}

const has = (args: readonly string[], ...flags: string[]): boolean => flags.every((flag) => args.includes(flag))

describe('lib-orchestrator/svn/svnWorktreeManager', () => {
  it('snap-in public reads return URL, HEAD names and local changes non-interactively', async () => {
    const fixture = scripted((_cwd, args) => {
      if (args[0] === 'info') return { stdout: infoXml() }
      if (args[0] === 'list') return { stdout: '<lists><list path="test"><entry kind="file"><name>900-pending-p1-a.md</name></entry></list></lists>' }
      if (args[0] === 'status') return { stdout: statusXml([{ path: '900-pending-p1-a.md', item: 'modified' }]) }
      throw new Error('unexpected command')
    })
    expect(await fixture.manager.urlOf(process.cwd())).toEqual({ ok: true, value: url })
    expect(await fixture.manager.listAtHead(url)).toEqual({ ok: true, value: ['900-pending-p1-a.md'] })
    expect(await fixture.manager.changedNames(process.cwd())).toEqual({ ok: true, value: ['900-pending-p1-a.md'] })
    expect(fixture.calls.every((call) => call.args.includes('--non-interactive'))).toBe(true)
    expect(fixture.calls[1].args).toContain('HEAD')
  })

  let temporary: string

  beforeEach(async () => {
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'jamat-v3-svn-worktree-manager-')))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  })

  it('keeps approved property hashes stable across XML order and formatting while retaining values', async () => {
    await writeFile(join(temporary, 'a'), 'content')
    let xml = '<properties><target path="a"><property name="z">one</property><property name="p">two</property></target></properties>'
    const { manager } = scripted((_cwd, args) => args[0] === 'proplist' ? { stdout: xml } : undefined)
    const first = await manager.commitHashes(temporary, ['a'])
    xml = '<properties>\n<target path="a">\n<property name="p">two</property>\n<property name="z">one</property>\n</target>\n</properties>'
    expect(await manager.commitHashes(temporary, ['a'])).toEqual(first)
    xml = xml.replace('two', 'changed')
    expect(await manager.commitHashes(temporary, ['a'])).not.toEqual(first)
  })

  it('refuses incomplete directory hashes for ready and review proof', async () => {
    const folder = join(temporary, 'folder')
    await mkdir(folder)
    for (let index = 0; index <= 2000; index++) await writeFile(join(folder, String(index)), '')
    const { manager } = scripted(() => ({ stdout: '<properties/>' }))
    expect(await manager.commitHashes(temporary, ['folder'])).toMatchObject({ ok: false, detail: expect.stringContaining('complete directory hash') })
    const proof = await manager.commitHashes(temporary, ['folder'], 'node')
    expect(proof.ok).toBe(true)
    await writeFile(join(folder, '2001'), 'dev server output')
    expect(await manager.commitHashes(temporary, ['folder'], 'node')).toEqual(proof)
  })

  it('hashes an external carrier independently of its proved external content and properties', async () => {
    const mount = join(temporary, 'modules', 'Library')
    await mkdir(join(mount, '.svn'), { recursive: true })
    await writeFile(join(mount, '.before-svn'), 'external hidden bytes')
    await writeFile(join(mount, 'file'), 'before')
    let mapping = '^/library Library', property = 'before'
    const { manager } = scripted((cwd, args) => {
      if (args[0] === 'status') return { stdout: statusXml([{ path: 'modules/Library', item: 'external' }]) }
      if (args[0] === 'info') return { stdout: infoXml({ wcRoot: cwd }) }
      if (args[0] === 'proplist') return { stdout: `<properties><target path="modules"><property name="svn:externals">${mapping}</property></target><target path="modules/Library/file"><property name="p">${property}</property></target></properties>` }
    })
    const paths = ['modules', 'modules/Library/file']
    const before = await manager.commitHashes(temporary, paths)
    expect(before.ok).toBe(true)
    await writeFile(join(mount, 'file'), 'after')
    await writeFile(join(mount, '.before-svn'), 'changed hidden bytes')
    property = 'after'
    const changed = await manager.commitHashes(temporary, paths)
    if (!before.ok || !changed.ok) throw new Error('External carrier proof failed')
    expect(changed.value.modules).toBe(before.value.modules)
    expect(changed.value['modules/Library/file']).not.toBe(before.value['modules/Library/file'])
    mapping = '^/other Library'
    expect(await manager.commitHashes(temporary, paths)).not.toEqual(changed)
    expect(await manager.hashes(temporary, ['modules'], true)).toMatchObject({ ok: false, detail: expect.stringContaining('nested SVN metadata') })
  })

  it.each(['unmapped', 'wrong-root'] as const)('refuses %s nested metadata in a commit proof', async (kind) => {
    await mkdir(join(temporary, 'folder', 'nested', '.svn'), { recursive: true })
    const { manager } = scripted((_cwd, args) => {
      if (args[0] === 'status') return { stdout: statusXml(kind === 'unmapped' ? [] : [{ path: 'folder/nested', item: 'external' }]) }
      if (args[0] === 'info') return { stdout: infoXml({ wcRoot: temporary }) }
    })
    expect(await manager.commitHashes(temporary, ['folder'])).toMatchObject({ ok: false })
  })

  it('batches property proof without losing versioned values beside unversioned targets', async () => {
    await writeFile(join(temporary, 'versioned'), 'one')
    await writeFile(join(temporary, 'new'), 'two')
    let value = 'original'
    const { manager, calls } = scripted((_cwd, args) => args[0] === 'proplist' ? {
      code: 1, stderr: "svn: W200005: 'new' is not under version control\nsvn: E200009: Could not display properties of all targets",
      stdout: `<properties><target path="versioned"><property name="p">${value}</property></target></properties>`,
    } : undefined)
    const first = await manager.commitHashes(temporary, ['versioned', 'new'])
    expect(first.ok).toBe(true)
    expect(calls).toHaveLength(1)
    value = 'changed'
    const second = await manager.commitHashes(temporary, ['versioned', 'new'])
    if (!first.ok || !second.ok) throw new Error('Property proof failed')
    expect(second.value.versioned).not.toBe(first.value.versioned)
    expect(second.value.new).toBe(first.value.new)
  })

  it('keeps a directory proof identical when a property-free descendant is also an explicit target', async () => {
    await mkdir(join(temporary, 'dir'))
    await writeFile(join(temporary, 'dir', 'file'), 'same bytes')
    const { manager } = scripted((_cwd, args) => ({ stdout: '<properties><target path="dir"><property name="p">value</property></target>'
      + (args.includes('dir/file@') ? '<target path="dir/file"/>' : '') + '</properties>' }))
    const alone = await manager.commitHashes(temporary, ['dir'])
    const combined = await manager.commitHashes(temporary, ['dir', 'dir/file'])
    if (!alone.ok || !combined.ok) throw new Error('Directory proof failed')
    expect(combined.value.dir).toBe(alone.value.dir)
  })

  it('binds a reviewed directory to descendant properties and refuses incomplete property reads', async () => {
    await mkdir(join(temporary, 'dir'))
    await writeFile(join(temporary, 'dir', 'child'), 'same content')
    let property = 'before'
    let denied = false
    const { manager } = scripted((_cwd, args) => args[0] !== 'proplist' ? undefined : denied
      ? { code: 1, stderr: 'svn: E155004: Working copy locked', stdout: '<properties/>' }
      : { stdout: `<properties><target path="dir/child"><property name="p">${property}</property></target></properties>` })
    const before = await manager.commitHashes(temporary, ['dir'])
    property = 'after'
    expect(await manager.commitHashes(temporary, ['dir'])).not.toEqual(before)
    denied = true
    expect(await manager.commitHashes(temporary, ['dir'])).toMatchObject({ ok: false })
  })

  it.each(['added', 'modified', 'replaced'] as const)('prepares a selected %s directory without reading it as text', async (item) => {
    const path = join(temporary, 'directory')
    await mkdir(path)
    const { manager } = scripted((_cwd, args) => {
      if (args[0] === 'status') return { stdout: statusXml([{ path, item, props: 'modified' }]) }
      if (args[0] === 'info') return { stdout: '<info><entry kind="dir"><wc-info><schedule>normal</schedule></wc-info></entry></info>' }
      return undefined
    })
    expect(await manager.prepareCommit(temporary, [path])).toEqual({ ok: true, value: { targets: [path], added: [] } })
  })

  it('keeps absent selected regular files fail-closed while scheduled deletions remain preparable', async () => {
    const path = join(temporary, 'missing')
    for (const item of ['modified', 'deleted']) {
      const { manager } = scripted((_cwd, args) => args[0] === 'status'
        ? { stdout: statusXml([{ path, item }]) }
        : args[0] === 'info' ? { stdout: '<info><entry kind="dir"><wc-info><schedule>normal</schedule></wc-info></entry></info>' } : undefined)
      const result = await manager.prepareCommit(temporary, [path])
      expect(result.ok).toBe(item === 'deleted')
    }
  })

  it.each(['modified', 'added', 'unversioned', 'deleted'] as const)('saves unchanged setup %s files and properties before reverting them', async (item) => {
    const file = join(temporary, 'lock')
    if (item !== 'deleted') await writeFile(file, 'setup')
    const { manager, calls } = scripted(async (_cwd, args) => {
      if (args[0] === 'proplist') return { stdout: '<properties>setup property</properties>' }
      if (args[0] === 'status') return { stdout: statusXml([{ path: 'lock', item }]) }
      if (args[0] === 'info') return { stdout: infoXml({ path: 'lock' }).replace('kind="dir"', 'kind="file"') }
      if (args[0] === 'revert') {
        if (item !== 'added') await writeFile(file, 'base')
        return {}
      }
    })
    const baseline = await manager.commitHashes(temporary, ['lock'])
    if (!baseline.ok) throw new Error(baseline.detail)
    const saved = join(temporary, 'results', 'setup')
    expect(await manager.revertSetup(temporary, ['lock'], baseline.value, saved)).toEqual({ ok: true, value: undefined })
    const copy = join(saved, (await readdir(saved))[0])
    expect(JSON.parse(await readFile(join(copy, 'state.json'), 'utf8'))).toMatchObject({ path: 'lock', item, missing: item === 'deleted', properties: '<properties>setup property</properties>' })
    if (item !== 'deleted') expect(await readFile(join(copy, 'working'), 'utf8')).toBe('setup')
    if (item === 'modified' || item === 'deleted') expect(await readFile(file, 'utf8')).toBe('base')
    else expect(existsSync(file)).toBe(false)
    expect(calls.filter((call) => call.args[0] === 'revert')).toHaveLength(item === 'unversioned' ? 0 : 1)
  })

  it.each(['content', 'properties', 'during-copy'] as const)('keeps a setup file whose %s changed after the baseline', async (change) => {
    const file = join(temporary, 'lock')
    await writeFile(file, 'setup')
    let properties = 'setup'
    let reads = 0
    const { manager, calls } = scripted(async (_cwd, args) => {
      if (args[0] === 'proplist') {
        reads += 1
        if (change === 'during-copy' && reads === 3) await writeFile(file, 'worker')
        return { stdout: `<properties><target path="lock"><property name="p">${properties}</property></target></properties>` }
      }
      if (args[0] === 'status') return { stdout: statusXml([{ path: 'lock', item: 'modified' }]) }
    })
    const baseline = await manager.commitHashes(temporary, ['lock'])
    if (!baseline.ok) throw new Error(baseline.detail)
    if (change === 'content') await writeFile(file, 'worker')
    else if (change === 'properties') properties = 'worker'
    expect(await manager.revertSetup(temporary, ['lock'], baseline.value, join(temporary, 'setup'))).toEqual({ ok: true, value: undefined })
    expect(calls.some((call) => call.args[0] === 'revert')).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(change === 'properties' ? 'setup' : 'worker')
  })

  it('keeps setup directories without matching complete proof', async () => {
    await mkdir(join(temporary, 'dir'))
    await writeFile(join(temporary, 'dir', 'worker'), 'keep')
    const { manager, calls } = scripted(() => ({ stdout: '<properties/>' }))
    expect(await manager.revertSetup(temporary, ['dir'], { dir: 'hash' }, join(temporary, 'setup'))).toEqual({ ok: true, value: undefined })
    expect(calls.every((call) => call.args[0] === 'proplist')).toBe(true)
    expect(await readFile(join(temporary, 'dir', 'worker'), 'utf8')).toBe('keep')
  })

  it('copies and removes a proven unversioned setup directory including empty descendants', async () => {
    await mkdir(join(temporary, 'dir', 'empty'), { recursive: true })
    await writeFile(join(temporary, 'dir', 'lock'), 'setup')
    const { manager } = scripted((_cwd, args) => args[0] === 'status'
      ? { stdout: statusXml([{ path: 'dir', item: 'unversioned' }]) } : { stdout: '<properties/>' })
    const baseline = await manager.commitHashes(temporary, ['dir'])
    if (!baseline.ok) throw new Error(baseline.detail)
    const saved = join(temporary, 'saved')
    expect((await manager.revertSetup(temporary, ['dir'], baseline.value, saved)).ok).toBe(true)
    expect(existsSync(join(temporary, 'dir'))).toBe(false)
    const copy = join(saved, (await readdir(saved))[0], 'working')
    expect(await readFile(join(copy, 'lock'), 'utf8')).toBe('setup')
    expect(existsSync(join(copy, 'empty'))).toBe(true)
  })

  it.each(['content', 'properties'] as const)('preserves a setup directory with late %s', async (change) => {
    await mkdir(join(temporary, 'dir'))
    await writeFile(join(temporary, 'dir', 'file'), 'setup')
    let value = 'setup'
    let reads = 0
    const { manager, calls } = scripted(async (_cwd, args) => {
      if (args[0] === 'status') return { stdout: statusXml([{ path: 'dir', item: 'unversioned' }]) }
      if (args[0] === 'proplist') {
        reads++
        if (reads === 4) {
          if (change === 'content') await writeFile(join(temporary, 'dir', 'file'), 'worker')
          else value = 'worker'
        }
        return { stdout: `<properties><target path="dir"><property name="p">${value}</property></target></properties>` }
      }
    })
    const baseline = await manager.commitHashes(temporary, ['dir'])
    if (!baseline.ok) throw new Error(baseline.detail)
    expect((await manager.revertSetup(temporary, ['dir'], baseline.value, join(temporary, 'saved'))).ok).toBe(true)
    expect(await readFile(join(temporary, 'dir', 'file'), 'utf8')).toBe(change === 'content' ? 'worker' : 'setup')
    expect(value).toBe(change === 'properties' ? 'worker' : 'setup')
    expect(calls.some((call) => call.args[0] === 'revert')).toBe(false)
  })

  it('reverts directory properties with depth empty and semantic XML order while preserving children', async () => {
    await mkdir(join(temporary, 'dir'))
    await writeFile(join(temporary, 'dir', 'file'), 'worker')
    let reads = 0
    const { manager, calls } = scripted((_cwd, args) => {
      if (args[0] === 'status') return { stdout: statusXml([{ path: 'dir', item: 'normal', props: 'modified' }]) }
      if (args[0] === 'proplist') {
        const props = ['<property name="a">1</property>', '<property name="b">2</property>']
        return { stdout: `<properties><target path="dir">${(++reads % 2 ? props : props.reverse()).join('')}</target></properties>` }
      }
      return {}
    })
    const baseline = await manager.commitHashes(temporary, ['dir'])
    if (!baseline.ok) throw new Error(baseline.detail)
    expect((await manager.revertSetup(temporary, ['dir'], baseline.value, join(temporary, 'saved'))).ok).toBe(true)
    expect(calls.filter((call) => call.args[0] === 'revert').map((call) => call.args)).toEqual([['revert', '--non-interactive', '--depth', 'empty', '--', 'dir@']])
    expect(await readFile(join(temporary, 'dir', 'file'), 'utf8')).toBe('worker')
  })

  it('disposes proven added descendants before removing empty added scaffolding', async () => {
    await mkdir(join(temporary, 'dir'))
    await writeFile(join(temporary, 'dir', 'file'), 'setup')
    const { manager, calls } = scripted((_cwd, args) => args[0] === 'status'
      ? { stdout: statusXml([{ path: args.at(-1)!.slice(0, -1), item: 'added' }]) }
      : args[0] === 'proplist' ? { stdout: '<properties/>' } : {})
    const baseline = await manager.commitHashes(temporary, ['dir/file', 'dir'])
    if (!baseline.ok) throw new Error(baseline.detail)
    expect((await manager.revertSetup(temporary, ['dir/file', 'dir'], baseline.value, join(temporary, 'saved'))).ok).toBe(true)
    expect(existsSync(join(temporary, 'dir'))).toBe(false)
    expect(calls.filter((call) => call.args[0] === 'revert').map((call) => call.args.at(-1))).toEqual(['dir/file@', 'dir@'])
  })

  it.each([false, true])('restores a setup directory deletion only while absent (recreated=%s)', async (recreated) => {
    const { manager, calls } = scripted(async (_cwd, args) => {
      if (args[0] === 'proplist') return { stdout: '<properties/>' }
      if (args[0] === 'status') return { stdout: statusXml([{ path: 'dir', item: 'deleted' }]) }
      if (args[0] === 'info') return { stdout: infoXml({ path: 'dir' }) }
      if (args[0] === 'revert') { await mkdir(join(temporary, 'dir')); return {} }
    })
    const baseline = await manager.commitHashes(temporary, ['dir'])
    if (!baseline.ok) throw new Error(baseline.detail)
    if (recreated) {
      await mkdir(join(temporary, 'dir'))
      await writeFile(join(temporary, 'dir', 'worker'), 'keep')
    }
    const saved = join(temporary, 'saved')
    expect((await manager.revertSetup(temporary, ['dir'], baseline.value, saved)).ok).toBe(true)
    expect(calls.filter((call) => call.args[0] === 'revert')).toHaveLength(recreated ? 0 : 1)
    if (recreated) expect(await readFile(join(temporary, 'dir', 'worker'), 'utf8')).toBe('keep')
    else expect(JSON.parse(await readFile(join(saved, (await readdir(saved))[0], 'state.json'), 'utf8'))).toMatchObject({ missing: true, missingKind: 'dir', item: 'deleted' })
  })

  // Mirabia 114: commits elsewhere in the repository moved HEAD, and two update rounds brought nothing.
  it('proves an update unneeded only for a uniform worktree whose own history and mounts did not move', async () => {
    const svn = new SvnInvoker()
    const run = async (cwd: string, args: string[]): Promise<void> => {
      expect(await svn.run(cwd, args), args.join(' ')).toMatchObject({ code: 0 })
    }
    const repo = join(temporary, 'repo'), side = join(temporary, 'side'), wc = join(temporary, 'wc')
    expect(await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repo], cwd: temporary, env: process.env })).toMatchObject({ code: 0 })
    const root = pathToFileURL(repo).href
    await run(temporary, ['mkdir', '-m', 'layout', `${root}/app`, `${root}/lib`, `${root}/other`])
    await run(temporary, ['checkout', root, side])
    await writeFile(join(side, 'lib', 'l.txt'), 'lib\n')
    await writeFile(join(side, 'app', 'a.txt'), 'app\n')
    await run(side, ['add', 'lib/l.txt', 'app/a.txt'])
    await run(side, ['commit', '-m', 'files'])
    await run(side, ['update'])
    await run(side, ['propset', 'svn:externals', '^/lib mount', 'app'])
    await run(side, ['commit', '-m', 'mount'])
    await run(temporary, ['checkout', `${root}/app`, wc])
    const manager = new SvnWorktreeManager(svn)
    const commit = async (path: string, content: string, message: string, add = false): Promise<void> => {
      await run(side, ['update'])
      await writeFile(join(side, path), content)
      if (add) await run(side, ['add', path])
      await run(side, ['commit', '-m', message])
    }
    expect(await manager.unmoved(wc)).toEqual({ ok: true, value: true })
    await commit('other/o.txt', 'elsewhere\n', 'elsewhere', true)
    expect(await manager.unmoved(wc)).toEqual({ ok: true, value: true })
    await commit('lib/l.txt', 'lib 2\n', 'the mount moved')
    expect(await manager.unmoved(wc)).toEqual({ ok: true, value: false })
    await run(wc, ['update'])
    expect(await manager.unmoved(wc)).toEqual({ ok: true, value: true })
    await commit('app/a.txt', 'app 2\n', 'the worktree moved')
    expect(await manager.unmoved(wc)).toEqual({ ok: true, value: false })
    await run(wc, ['update'])
    // A commit from the worktree leaves its directory at the older BASE: only an update makes it whole again.
    await writeFile(join(wc, 'a.txt'), 'mine\n')
    await run(wc, ['commit', '-m', 'own'])
    expect(await manager.unmoved(wc)).toEqual({ ok: true, value: false })
  })

  it('restores an actual SVN setup directory deletion and its separately proven descendants', async () => {
    const repo = join(temporary, 'repo')
    const wc = join(temporary, 'wc')
    expect(await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repo], cwd: temporary, env: process.env })).toMatchObject({ code: 0 })
    const svn = new SvnInvoker()
    expect(await svn.run(temporary, ['checkout', pathToFileURL(repo).href, wc])).toMatchObject({ code: 0 })
    await mkdir(join(wc, 'dir'))
    await writeFile(join(wc, 'dir', 'child'), 'original child bytes\r\n')
    expect(await svn.run(wc, ['add', 'dir'])).toMatchObject({ code: 0 })
    expect(await svn.run(wc, ['commit', '-m', 'Disposable setup fixture'])).toMatchObject({ code: 0 })
    expect(await svn.run(wc, ['delete', 'dir'])).toMatchObject({ code: 0 })
    const manager = new SvnWorktreeManager(svn)
    const changes = await manager.changes(wc)
    if (!changes.ok) throw new Error(changes.detail)
    const paths = changes.value.map((row) => row.path)
    expect(paths).toEqual(['dir'])
    const baseline = await manager.commitHashes(wc, paths)
    if (!baseline.ok) throw new Error(baseline.detail)
    expect(await manager.revertSetup(wc, paths, baseline.value, join(temporary, 'saved'))).toEqual({ ok: true, value: undefined })
    expect(await manager.changes(wc)).toEqual({ ok: true, value: [] })
    expect(await readFile(join(wc, 'dir', 'child'), 'utf8')).toBe('original child bytes\r\n')
  })

  it.each(['/', ''])('proves repository-root properties for the receipt path %j', async (path) => {
    const { manager } = scripted((_cwd, args) => {
      if (args[0] === 'status') return { stdout: statusXml([{ path: '.', item: 'normal', revision: 50 }]) }
      if (args[0] === 'info') return { stdout: landingInfoXml(args, repository) }
      if (args[0] === 'log') return { stdout: logXml(50, [{ action: 'M', path: '/' }]) }
    })
    expect(await manager.landingPaths(temporary, [{ repository, revision: 50, paths: [path] }]))
      .toMatchObject({ ok: true, value: [{ root: temporary, path: '.', repositoryPath: '' }] })
    expect(await manager.landingProof(temporary, [{ repository, revision: 50, paths: [path] }]))
      .toEqual({ ok: true, value: { holds: true } })
  })

  it('proves landing per path, including old receipts, and reports a conflicted skipped node', async () => {
    await writeFile(join(temporary, 'older'), 'local')
    await writeFile(join(temporary, 'newer'), 'new')
    let oldBase = 40
    let conflict = true
    const { manager } = scripted((_cwd, args) => {
      if (args[0] === 'status' && !args.includes('--depth')) return { stdout: statusXml([]) }
      if (args[0] === 'info') return { stdout: landingInfoXml(args) }
      if (args[0] === 'log') { const revision = Number(args[args.indexOf('-r') + 1]); return { stdout: logXml(revision, [{ action: 'M', path: '/Project/' + (revision === 41 ? 'older' : 'newer') }]) } }
      if (args[0] === 'status') return { stdout: statusXml(args.slice(args.indexOf('--') + 1).map((target) => {
        const path = target.slice(0, -1)
        return { path, item: path === 'older' && conflict ? 'conflicted' : 'normal', revision: path === 'older' ? oldBase : 50 }
      })) }
    })
    const landed = [{ repository, revision: 41, paths: ['/Project/older'] }, { repository, revision: 50, paths: ['/Project/newer'] }]
    expect(await manager.landingProof(temporary, landed)).toMatchObject({ ok: true, value: { holds: false, reason: 'older still at r40 (conflict)' } })
    conflict = false
    expect(await manager.landingProof(temporary, landed)).toMatchObject({ ok: true, value: { holds: false } })
    oldBase = 50
    expect(await manager.landingProof(temporary, landed)).toEqual({ ok: true, value: { holds: true } })
  })

  it('expands a directory landing target so its stale child cannot disappear behind a current parent', async () => {
    await mkdir(join(temporary, 'dir'))
    await writeFile(join(temporary, 'dir', 'child'), 'old')
    const { manager } = scripted((_cwd, args) => {
      if (args[0] === 'status' && !args.includes('--depth')) return { stdout: statusXml([]) }
      if (args[0] === 'info') return { stdout: landingInfoXml(args) }
      if (args[0] === 'log') return { stdout: logXml(50, [{ action: 'M', path: '/Project/dir' }, { action: 'M', path: '/Project/dir/child' }]) }
      if (args[0] === 'status') return { stdout: statusXml(args.slice(args.indexOf('--') + 1).map((target) => {
        const path = target.slice(0, -1)
        return { path, item: 'normal', revision: path === 'dir' ? 50 : 40 }
      })) }
    })
    expect(await manager.landingProof(temporary, [{ repository, revision: 50, paths: ['/Project/dir'] }]))
      .toMatchObject({ ok: true, value: { holds: false, reason: 'dir/child still at r40 (normal)' } })
  })

  it('batches landing status without attributing a later conflict to an earlier path', async () => {
    for (const path of ['first', 'second']) await writeFile(join(temporary, path), 'local')
    const { manager, calls } = scripted((_cwd, args) => {
      if (args[0] === 'status' && !args.includes('--depth')) return { stdout: statusXml([]) }
      if (args[0] === 'info') return { stdout: landingInfoXml(args) }
      if (args[0] === 'log') return { stdout: logXml(50, ['first', 'second'].map((path) => ({ action: 'M', path: `/Project/${path}` }))) }
      if (args[0] === 'status') return { stdout: '<status>' + ['first', 'second'].map((path) =>
        `<target path="${path}"><entry path="${path}"><wc-status item="normal" props="none" revision="50"${path === 'second' ? ' tree-conflicted="true"' : ''}/></entry></target>`).join('') + '</status>' }
    })
    expect(await manager.landingProof(temporary, [{ repository, revision: 50 }]))
      .toEqual({ ok: true, value: { holds: false, reason: 'second still at r50 (conflict)', local: { path: 'second', item: 'conflicted' } } })
    expect(calls.filter((call) => call.args[0] === 'status' && call.args.includes('--depth')).map((call) => call.args))
      .toEqual([['status', '--non-interactive', '--xml', '--verbose', '--depth', 'empty', '--', 'first@', 'second@']])
  })

  it('names the local state of the main copy that keeps a landed path unproven, and none for a path that is only behind', async () => {
    let item = 'deleted'
    let base = 50
    const { manager } = scripted((_cwd, args) => {
      if (args[0] === 'status' && !args.includes('--depth')) return { stdout: statusXml([]) }
      if (args[0] === 'info') return { stdout: landingInfoXml(args) }
      if (args[0] === 'log') return { stdout: logXml(50, [{ action: 'M', path: '/Project/docs/gone.txt' }]) }
      if (args[0] === 'status') return { stdout: statusXml([{ path: 'docs/gone.txt', item, revision: base }]) }
    })
    expect(await manager.landingProof(temporary, [{ repository, revision: 50 }]))
      .toEqual({ ok: true, value: { holds: false, reason: 'docs/gone.txt is locally deleted', local: { path: 'docs/gone.txt', item: 'deleted' } } })
    await mkdir(join(temporary, 'docs'))
    await writeFile(join(temporary, 'docs', 'gone.txt'), 'kept on disk')
    expect(await manager.landingProof(temporary, [{ repository, revision: 50 }]))
      .toEqual({ ok: true, value: { holds: false, reason: 'docs/gone.txt still at r50 (deleted)', local: { path: 'docs/gone.txt', item: 'deleted' } } })
    item = 'normal'
    base = 40
    expect(await manager.landingProof(temporary, [{ repository, revision: 50 }]))
      .toEqual({ ok: true, value: { holds: false, reason: 'docs/gone.txt still at r40 (normal)' } })
  })

  it('bounds long landing status and info commands and deduplicates paths across receipts', async () => {
    const paths = Array.from({ length: 160 }, (_, index) => `${index}-${'a'.repeat(95)}`)
    await Promise.all(paths.map((path) => writeFile(join(temporary, path), 'local')))
    const { manager, calls } = scripted((_cwd, args) => {
      if (args[0] === 'status' && !args.includes('--depth')) return { stdout: statusXml([]) }
      if (args[0] === 'info') return { stdout: landingInfoXml(args) }
      if (args[0] === 'log') return { stdout: logXml(Number(args[args.indexOf('-r') + 1]), paths.map((path) => ({ action: 'M', path: `/Project/${path}` }))) }
      if (args[0] === 'status') return { stdout: statusXml(args.slice(args.indexOf('--') + 1).map((target) => ({ path: target.slice(0, -1), item: 'normal', revision: 50 }))) }
    })
    expect(await manager.landingProof(temporary, [{ repository, revision: 49 }, { repository, revision: 50 }]))
      .toEqual({ ok: true, value: { holds: true } })
    const batches = calls.filter((call) => call.args[0] === 'status' && call.args.includes('--depth'))
    expect(batches).toHaveLength(2)
    expect(batches.flatMap((call) => call.args.slice(call.args.indexOf('--') + 1))).toEqual(paths.map((path) => `${path}@`))
    for (const call of batches) expect(call.args.join(' ').length).toBeLessThan(32_767)
    const infoBatches = calls.filter((call) => call.args[0] === 'info' && call.args.includes('--depth'))
    expect(infoBatches).toHaveLength(2)
    expect(infoBatches.flatMap((call) => call.args.slice(call.args.indexOf('--') + 1))).toEqual(paths.map((path) => `${path}@`))
  })

  it('keeps the status and URL proof of each external in its own root', async () => {
    const mount = join(temporary, 'lib')
    await mkdir(join(mount, '.svn'), { recursive: true })
    await writeFile(join(temporary, 'a'), 'main')
    await writeFile(join(mount, 'a'), 'external')
    let switched = false
    const { manager, calls } = scripted((cwd, args) => {
      if (args[0] === 'status' && !args.includes('--depth')) return { stdout: statusXml([{ path: 'lib', item: 'external' }]) }
      if (args[0] === 'info' && !args.includes('--depth')) return { stdout: infoListXml([{ path: '.', entryUrl: `${repository}/Project` }, { path: 'lib', entryUrl: `${repository}/External` }]) }
      if (args[0] === 'info') return { stdout: switched
        ? infoXml({ path: 'a', entryUrl: `${repository}/wrong` })
        : landingInfoXml(args, `${repository}${cwd === temporary ? '/Project' : '/External'}`, cwd) }
      if (args[0] === 'log') return { stdout: logXml(50, [{ action: 'M', path: '/Project/a' }, { action: 'M', path: '/External/a' }]) }
      if (args[0] === 'status') return { stdout: statusXml([{ path: 'a', item: 'normal', revision: 50 }]) }
    })
    expect(await manager.landingProof(temporary, [{ repository, revision: 50 }])).toEqual({ ok: true, value: { holds: true } })
    expect(calls.filter((call) => call.args[0] === 'status' && call.args.includes('--depth')).map((call) => call.cwd)).toEqual([temporary, mount])
    expect(calls.filter((call) => call.args[0] === 'info' && !call.args.includes('--depth')).map((call) => call.args))
      .toEqual([['info', '--non-interactive', '--xml', '--', '.@', 'lib@']])
    switched = true
    expect(await manager.landingProof(temporary, [{ repository, revision: 50 }]))
      .toEqual({ ok: true, value: { holds: false, reason: 'a checks out a different repository path' } })
  })

  it('shares the roots and the revision log of a main copy until an svn write moves its stamp', async () => {
    await mkdir(join(temporary, '.svn'))
    await writeFile(join(temporary, '.svn', 'wc.db'), 'db')
    await writeFile(join(temporary, 'a'), 'main')
    const { manager, calls } = scripted((_cwd, args) => {
      if (args[0] === 'status' && !args.includes('--depth')) return { stdout: statusXml([]) }
      if (args[0] === 'info') return { stdout: landingInfoXml(args) }
      if (args[0] === 'log') return { stdout: logXml(50, [{ action: 'M', path: '/Project/a' }]) }
      if (args[0] === 'status') return { stdout: statusXml([{ path: 'a', item: 'normal', revision: 50 }]) }
    })
    const reads = () => calls.filter((call) => !call.args.includes('--depth')).map((call) => call.args[0])
    const landed = [{ repository, revision: 50 }]
    expect(await manager.landingStamp(temporary)).toBeNull()
    for (let read = 0; read < 3; read++) expect(await manager.landingProof(temporary, landed)).toEqual({ ok: true, value: { holds: true } })
    // The first proof reads the roots under no stamp yet, the second under one, the third reuses them.
    expect(reads()).toEqual(['status', 'info', 'log', 'status', 'info'])
    expect(await manager.landingStamp(temporary)).not.toBeNull()
    await writeFile(join(temporary, '.svn', 'wc.db'), 'db after an update')
    expect(await manager.landingProof(temporary, landed)).toEqual({ ok: true, value: { holds: true } })
    expect(reads()).toEqual(['status', 'info', 'log', 'status', 'info', 'status', 'info'])
  })

  it('does not prove a landing when a batched status command fails', async () => {
    const { manager } = scripted((_cwd, args) => {
      if (args[0] === 'status' && !args.includes('--depth')) return { stdout: statusXml([]) }
      if (args[0] === 'info') return { stdout: infoXml() }
      if (args[0] === 'log') return { stdout: logXml(50, [{ action: 'M', path: '/Project/a' }]) }
      if (args[0] === 'status') return failed('E155004: Working copy locked')
    })
    expect(await manager.landingProof(temporary, [{ repository, revision: 50 }])).toMatchObject({ ok: false, code: 'locked' })
  })

  it.each(['missing', 'failed'])('does not prove a landing with %s batched info evidence', async (evidence) => {
    await writeFile(join(temporary, 'a'), 'local')
    const { manager } = scripted((_cwd, args) => {
      if (args[0] === 'status' && !args.includes('--depth')) return { stdout: statusXml([]) }
      if (args[0] === 'info' && !args.includes('--depth')) return { stdout: infoXml() }
      if (args[0] === 'log') return { stdout: logXml(50, [{ action: 'M', path: '/Project/a' }]) }
      if (args[0] === 'status') return { stdout: statusXml([{ path: 'a', item: 'normal', revision: 50 }]) }
      if (args[0] === 'info') return evidence === 'missing' ? { stdout: infoXml({ path: 'b' }) } : failed('E155010: node not found')
    })
    expect(await manager.landingProof(temporary, [{ repository, revision: 50 }])).toMatchObject({ ok: false, code: 'svn-failed' })
  })

  it('maps landing by working-copy URL even when an external uses the same repository', async () => {
    await mkdir(join(temporary, 'lib', '.svn'), { recursive: true })
    const { manager } = scripted((cwd, args) => {
      if (args[0] === 'status') return { stdout: statusXml([{ path: 'lib', item: 'external' }]) }
      if (args[0] === 'info') return { stdout: infoXml({ entryUrl: cwd === temporary ? url : repository + '/branches/other', wcRoot: cwd }) }
      if (args[0] === 'log') return { stdout: logXml(50, [{ action: 'M', path: '/Project/lib/a' }]) }
    })
    expect(await manager.landingPaths(temporary, [{ repository, revision: 50, paths: ['/Project/lib/a'] }]))
      .toMatchObject({ ok: true, value: [{ root: null, repositoryPath: '/Project/lib/a' }] })
    expect(await manager.landingProof(temporary, [{ repository, revision: 50, paths: ['/Project/lib/a'] }]))
      .toMatchObject({ ok: true, value: { holds: false, reason: expect.stringContaining('no matching working-copy URL') } })
  })

  it('proves landing with repository deletion evidence for an absent landed path', async () => {
    let deleted = false
    const { manager } = scripted((_cwd, args) => {
      if (args[0] === 'status') return { stdout: statusXml([]) }
      if (args[0] === 'info') return { stdout: infoXml({ revision: 50 }) }
      if (args[0] === 'log') return { stdout: logXml(41, [{ action: args.includes('41:50') && deleted ? 'D' : 'M', path: '/Project/gone' }]) }
    })
    const receipts = [{ repository, revision: 41, paths: ['/Project/gone'] }]
    expect(await manager.landingProof(temporary, receipts)).toMatchObject({ ok: true, value: { holds: false, reason: expect.stringContaining('without a repository deletion proof') } })
    deleted = true
    expect(await manager.landingProof(temporary, receipts)).toEqual({ ok: true, value: { holds: true } })
  })

  it('proves both nodes of a case-only rename without confusing the new file with the deleted name', async () => {
    await writeFile(join(temporary, 'title.txt'), 'renamed')
    let deleted = false
    let base = 40
    const { manager } = scripted((_cwd, args) => {
      if (args[0] === 'status' && !args.includes('--depth')) return { stdout: statusXml([]) }
      if (args[0] === 'status') return { stdout: statusXml([{ path: 'title.txt', item: 'normal', revision: base }]) }
      if (args[0] === 'info' && !args.includes('--depth')) return { stdout: infoXml({ revision: 50 }) }
      if (args[0] === 'info') return { stdout: landingInfoXml(args) }
      if (args[0] === 'log') return { stdout: logXml(41, [
        { action: args.includes('41:50') && !deleted ? 'M' : 'D', path: '/Project/Title.txt' },
        { action: 'A', path: '/Project/title.txt' },
      ]) }
    })
    const receipts = [{ repository, revision: 41, paths: ['/Project/Title.txt', '/Project/title.txt'] }]
    expect(await manager.landingProof(temporary, receipts)).toMatchObject({ ok: true, value: { holds: false, reason: expect.stringContaining('without a repository deletion proof') } })
    deleted = true
    expect(await manager.landingProof(temporary, receipts)).toEqual({ ok: true, value: { holds: false, reason: 'title.txt still at r40 (normal)' } })
    base = 50
    expect(await manager.landingProof(temporary, receipts)).toEqual({ ok: true, value: { holds: true } })
  })

  it('keeps case-renamed directory contents in the assembly without treating them as recreated deletions', async () => {
    await mkdir(join(temporary, 'Old'))
    await writeFile(join(temporary, 'Old/child.txt'), 'edited after move')
    const { manager } = scripted((_cwd, args) => {
      if (args[0] === 'info') return { stdout: infoXml().replace('</root>', '</root><uuid>fixture</uuid>') }
      if (args[0] === 'proplist') return { stdout: '<properties/>' }
      if (args[0] === 'status') return { stdout: statusXml([
        { path: '.', item: 'normal' }, { path: 'Old', item: 'added' }, { path: 'Old/child.txt', item: 'modified' },
        { path: 'old', item: 'deleted' }, { path: 'old/child.txt', item: 'deleted' },
      ]) }
    })
    const first = await manager.assembly(temporary)
    if (!first.ok) throw new Error(first.detail)
    expect(first.value.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'old/child.txt', content: '' }), expect.objectContaining({ path: 'Old/child.txt' }),
    ]))
    await writeFile(join(temporary, 'Old/child.txt'), 'another edit')
    const next = await manager.assembly(temporary)
    if (!next.ok) throw new Error(next.detail)
    expect(next.value.content).not.toBe(first.value.content)
  })

  it('saves overlap content, properties and local deletion evidence before UPDATE', async () => {
    await writeFile(join(temporary, 'edited'), 'person bytes')
    const { manager } = scripted((_cwd, args) => {
      if (args[0] === 'proplist') return { stdout: '<properties><target path="edited"><property name="local">person property</property></target></properties>' }
      if (args[0] === 'status') return { stdout: statusXml([{ path: args.at(-1)!.slice(0, -1), item: args.at(-1) === 'gone@' ? 'deleted' : 'modified' }]) }
    })
    const saved = await manager.saveLocalPaths(temporary, ['edited', 'gone'], join(temporary, 'saved'))
    if (!saved.ok) throw new Error(saved.detail)
    const copies = await Promise.all((await readdir(saved.value)).map(async (name) => ({ path: join(saved.value, name), state: JSON.parse(await readFile(join(saved.value, name, 'state.json'), 'utf8')) })))
    const edited = copies.find((copy) => copy.state.path === 'edited')!
    expect(await readFile(join(edited.path, 'working'), 'utf8')).toBe('person bytes')
    expect(edited.state.properties).toContain('person property')
    expect(copies.find((copy) => copy.state.path === 'gone')!.state.missing).toBe(true)
  })

  it('includes working properties in the approved selection hash', async () => {
    await writeFile(join(temporary, 'a.txt'), 'same content')
    let property = 'before'
    const { manager } = scripted((_cwd, args) => args[0] === 'proplist' ? { stdout: `<properties><target path="a.txt"><property name="p">${property}</property></target></properties>` } : undefined)
    const before = await manager.commitHashes(temporary, ['a.txt'])
    property = 'after'
    const after = await manager.commitHashes(temporary, ['a.txt'])
    expect(before.ok && after.ok && before.value['a.txt'] !== after.value['a.txt']).toBe(true)
  })

  it('undoes only still-scheduled preparation adds deepest first and keeps file contents', async () => {
    await mkdir(join(temporary, 'new'))
    await writeFile(join(temporary, 'new', 'a.txt'), 'keep this')
    const { manager, calls } = scripted((_cwd, args) => {
      if (args[0] === 'status') return { stdout: statusXml([{ path: args.at(-1)!.slice(0, -1), item: args.at(-1) === 'existing.txt@' ? 'modified' : 'added' }]) }
      if (args[0] === 'revert') return {}
      return undefined
    })
    expect((await manager.unprepareCommit(temporary, [join(temporary, 'new'), join(temporary, 'existing.txt'), join(temporary, 'new', 'a.txt')])).ok).toBe(true)
    expect(calls.filter((call) => call.args[0] === 'revert').map((call) => call.args.at(-1))).toEqual(['new/a.txt@', 'new@'])
    expect(await readFile(join(temporary, 'new', 'a.txt'), 'utf8')).toBe('keep this')
    expect((await manager.unprepareCommit(temporary, [join(temporary, '..', 'outside')])).ok).toBe(false)
  })

  describe('owner', () => {
    it('accepts a versioned directory of the project and refuses one outside it, inside a worktree or unversioned', async () => {
      const project = join(temporary, 'Project')
      const member = join(project, 'Member')
      await mkdir(member, { recursive: true })
      const { manager } = scripted((cwd, args) => args[0] !== 'info' ? undefined
        : cwd === member ? { stdout: infoXml({ wcRoot: project }) }
        : failed(`svn: E155007: '${cwd}' is not a working copy`))
      const holdsOtherProject = (): boolean => { throw new Error('a directory below the working-copy root is never asked') }
      await expect(manager.ownerProblem({ ownerDir: member, projectPath: project, holdsOtherProject })).resolves.toBeNull()
      await expect(manager.ownerProblem({ ownerDir: temporary, projectPath: project, holdsOtherProject })).resolves.toMatch(/outside the project/)
      await expect(manager.ownerProblem({ ownerDir: join(project, '.worktrees', '014-x'), projectPath: project, holdsOtherProject }))
        .resolves.toMatch(/inside a worktree/)
      await expect(manager.ownerProblem({ ownerDir: join(project, 'absent'), projectPath: project, holdsOtherProject })).resolves.toMatch(/no directory/)
      await expect(manager.ownerProblem({ ownerDir: project, projectPath: project, holdsOtherProject }))
        .resolves.toBe(`checkpoints mode makes SVN worktrees and ${project} is in no SVN working copy`)
    })

    it('refuses a working-copy root that holds another project and accepts a product group or a standalone repository', async () => {
      const zone = join(temporary, 'Zone')
      await mkdir(zone)
      const { manager } = scripted(() => ({ stdout: infoXml({ wcRoot: zone.replaceAll(sep, '/') }) }))
      await expect(manager.ownerProblem({ ownerDir: zone, projectPath: zone, holdsOtherProject: () => true }))
        .resolves.toMatch(/working-copy root that holds other projects/)
      await expect(manager.ownerProblem({ ownerDir: zone, projectPath: zone, holdsOtherProject: () => false })).resolves.toBeNull()
    })

    it('checks that the owner still checks out the URL and the worktree is the checkout made for it', async () => {
      const owner = join(temporary, 'owner')
      const worktreePath = join(owner, '.worktrees', '014-x')
      await mkdir(join(worktreePath, '.svn'), { recursive: true })
      const directoryId = await SvnWorktreeManager.directoryIdOf(worktreePath) ?? undefined
      let ownerUrl = url
      const { manager } = scripted((cwd, args) => args[0] === 'info' ? { stdout: infoXml({ entryUrl: cwd === owner ? ownerUrl : url }) } : undefined)
      await expect(manager.ownerCheck({ worktreePath, ownerDir: owner, url, directoryId })).resolves.toEqual({ ok: true, value: undefined })
      if (directoryId !== undefined)
        await expect(manager.ownerCheck({ worktreePath, ownerDir: owner, url, directoryId: '1:2:3' }))
          .resolves.toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/another directory/) })
      ownerUrl = `${repository}/Other`
      await expect(manager.ownerCheck({ worktreePath, ownerDir: owner, url, directoryId }))
        .resolves.toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/checks out .*Other, not/) })
    })
  })

  describe('create', () => {
    function creating(_owner: string, options: { ignored?: boolean; checkoutFails?: boolean; whileChecking?: () => Promise<void> } = {}) {
      return scripted(async (cwd, args) => {
        // The owner stands at r40; its URL is at r41 on the server.
        if (args[0] === 'info') return { stdout: infoXml({ revision: args.at(-1) === url ? 41 : 40 }) }
        if (args[0] === 'status' && has(args, '--no-ignore', '--depth', 'immediates')) {
          await options.whileChecking?.()
          return { stdout: statusXml([{ path: '.worktrees', item: options.ignored === false ? 'unversioned' : 'ignored' }]) }
        }
        if (args[0] === 'checkout') {
          const target = join(cwd, args[args.length - 1])
          await mkdir(join(target, '.svn'), { recursive: true })
          return options.checkoutFails === true ? failed('svn: E170013: Unable to connect') : {}
        }
        return undefined
      })
    }

    it('reserves .worktrees/<folder> with the owner URL, the HEAD revision and the folder identity, and checks out nothing', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(owner)
      const { manager, calls } = creating(owner)
      const reserved = await manager.reserve({ ownerDir: owner, folder: '014-fix-login' })
      const worktreePath = join(owner, '.worktrees', '014-fix-login')
      expect(reserved).toEqual({ ok: true, value: { worktreePath, url, baseRevision: 41, directoryId: expect.stringMatching(/^\d+:\d+:\d+$/) } })
      expect(calls.find((call) => call.args[0] === 'checkout')).toBeUndefined()
      expect(calls.filter((call) => call.args[0] === 'info').map((call) => call.args.at(-1))).toEqual(['.', url])
      expect(existsSync(worktreePath)).toBe(true)
      expect(existsSync(join(worktreePath, '.svn'))).toBe(false)
    })

    it('leaves nothing behind when the HEAD of the owner URL cannot be read', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(owner)
      const { manager } = scripted((_cwd, args) => args[0] !== 'info' ? undefined
        : args.at(-1) === url ? failed('svn: E170013: Unable to connect') : { stdout: infoXml() })
      expect(await manager.reserve({ ownerDir: owner, folder: 'x' }))
        .toMatchObject({ ok: false, code: 'svn-failed', detail: expect.stringMatching(/HEAD revision.*E170013/s) })
      expect(existsSync(join(owner, '.worktrees'))).toBe(false)
    })

    it('checks the owner URL out at the reserved HEAD into the folder and names its revision and identity', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(owner)
      const { manager, calls } = creating(owner)
      const created = await manager.create({ ownerDir: owner, folder: '014-fix-login' })
      const worktreePath = join(owner, '.worktrees', '014-fix-login')
      expect(created).toEqual({ ok: true, value: { worktreePath, url, baseRevision: 41, directoryId: expect.any(String) } })
      expect(calls.find((call) => call.args[0] === 'checkout')).toEqual({ cwd: worktreePath,
        args: ['checkout', '--non-interactive', '-q', '--', `${url}@41`, '.'] })
      expect(SvnWorktreeManager.checkoutArgsOf(url, 41, 'quiet')).toEqual(['checkout', '-q', '--', `${url}@41`, '.'])
      expect(SvnWorktreeManager.checkoutArgsOf(url, 41, 'listed')).toEqual(['checkout', '--', `${url}@41`, '.'])
    })

    it('takes the next free name when the folder or its .deleting rest is taken', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(join(owner, '.worktrees', '014-fix-login'), { recursive: true })
      await mkdir(join(owner, '.worktrees', '014-fix-login-2.deleting'))
      const created = await creating(owner).manager.create({ ownerDir: owner, folder: '014-fix-login' })
      expect(created).toMatchObject({ ok: true, value: { worktreePath: join(owner, '.worktrees', '014-fix-login-3') } })
    })

    it('refuses a .worktrees directory SVN does not ignore and removes only what this call made', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(owner)
      expect(await creating(owner, { ignored: false }).manager.create({ ownerDir: owner, folder: 'x' }))
        .toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/SVN does not ignore/) })
      expect(existsSync(join(owner, '.worktrees'))).toBe(false)
      await mkdir(join(owner, '.worktrees'))
      expect(await creating(owner, { ignored: false }).manager.create({ ownerDir: owner, folder: 'x' })).toMatchObject({ ok: false })
      expect(existsSync(join(owner, '.worktrees'))).toBe(true)
    })

    it('leaves no folder behind when the checkout fails', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(owner)
      expect(await creating(owner, { checkoutFails: true }).manager.create({ ownerDir: owner, folder: 'x' }))
        .toMatchObject({ ok: false, code: 'svn-failed', detail: expect.stringMatching(/nothing was left behind.*E170013/s) })
      expect(existsSync(join(owner, '.worktrees'))).toBe(false)
    })

    it('names the folder a failed checkout leaves behind when it cannot be deleted', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(owner)
      const worktreePath = join(owner, '.worktrees', 'x')
      purgeFailures.set(worktreePath, new Error('EBUSY: resource busy or locked'))
      try {
        expect(await creating(owner, { checkoutFails: true }).manager.create({ ownerDir: owner, folder: 'x' })).toMatchObject({
          ok: false,
          code: 'svn-failed',
          detail: expect.stringMatching(/is left behind \(EBUSY: resource busy or locked\); delete it by hand: .*E170013/s),
        })
      }
      finally { purgeFailures.clear() }
      expect(existsSync(worktreePath)).toBe(true)
    })

    // A finish removes the empty `.worktrees` of the same owner while a create is between making it
    // and reserving its folder there.
    it('keeps .worktrees while a create of the same owner is under way', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(owner)
      let manager: SvnWorktreeManager | null = null
      const it_ = creating(owner, { whileChecking: () => manager!.removeEmptyWorktreesDir(owner) })
      manager = it_.manager

      expect(await it_.manager.create({ ownerDir: owner, folder: 'x' }))
        .toMatchObject({ ok: true, value: { worktreePath: join(owner, '.worktrees', 'x') } })
      await it_.manager.removeEmptyWorktreesDir(owner)
      expect(existsSync(join(owner, '.worktrees', 'x'))).toBe(true)
    })

    it('refuses a folder that is no slug', async () => {
      expect(await creating(temporary).manager.create({ ownerDir: temporary, folder: '../x' })).toMatchObject({ ok: false, code: 'refused' })
      expect(await creating(temporary).manager.reserve({ ownerDir: temporary, folder: '../x' })).toMatchObject({ ok: false, code: 'refused' })
    })
  })

  describe('a reserved folder', () => {
    it('is emptied for another checkout and keeps its identity', async () => {
      const worktreePath = join(temporary, 'owner', '.worktrees', 'x')
      await mkdir(join(worktreePath, '.svn', 'tmp'), { recursive: true })
      await writeFile(join(worktreePath, 'half.txt'), 'half\n', 'utf8')
      const directoryId = await SvnWorktreeManager.directoryIdOf(worktreePath) ?? undefined
      const { manager, calls } = scripted(() => undefined)

      expect(await manager.purgeReserved({ worktreePath, directoryId })).toEqual({ ok: true, value: undefined })
      expect(existsSync(join(worktreePath, '.svn'))).toBe(false)
      expect(existsSync(join(worktreePath, 'half.txt'))).toBe(false)
      expect(await SvnWorktreeManager.directoryIdOf(worktreePath)).toBe(directoryId ?? null)
      expect(calls).toEqual([])
    })

    it('is never emptied when it is another directory, carries no identity or is gone', async () => {
      const worktreePath = join(temporary, 'owner', '.worktrees', 'x')
      await mkdir(worktreePath, { recursive: true })
      await writeFile(join(worktreePath, 'keep.txt'), 'keep\n', 'utf8')
      const { manager } = scripted(() => undefined)

      expect(await manager.purgeReserved({ worktreePath, directoryId: '1:2:3' }))
        .toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/another directory.*nothing was deleted/) })
      expect(await manager.purgeReserved({ worktreePath }))
        .toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/no file ID.*nothing was deleted/) })
      expect(existsSync(join(worktreePath, 'keep.txt'))).toBe(true)
      expect(await manager.purgeReserved({ worktreePath: join(temporary, 'gone'), directoryId: '1:2:3' }))
        .toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/is gone/) })
    })
  })

  describe('working-copy root', () => {
    it('reads the root of the working copy holding a directory from svn info XML', async () => {
      const directory = join(temporary, 'Group', 'Member')
      await mkdir(directory, { recursive: true })
      const { manager } = scripted(() => ({ stdout: infoXml({ wcRoot: 'C:/Zone/R&amp;D' }) }))
      expect(await manager.workingCopyRootOf(directory)).toEqual({ ok: true, value: 'C:/Zone/R&D' })
    })

    it('answers no directory and an unversioned directory with their reasons', async () => {
      const { manager } = scripted(() => failed('svn: E155007: not a working copy'))
      expect(await manager.workingCopyRootOf(join(temporary, 'absent'))).toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/no directory/) })
      expect(await manager.workingCopyRootOf(temporary)).toMatchObject({ ok: false, code: 'not-a-working-copy' })
    })
  })

  // The update itself is a run of the SVN action now; these are the reads and writes around it.
  describe('around the update run', () => {
    const changedBefore: Entry[] = [{ path: 'src/a.txt', item: 'modified', revision: 5 }, { path: 'gone', item: 'missing', revision: 5 },
      { path: 'gone/inner.txt', item: 'missing', revision: 5 }, { path: 'mount', item: 'external' }]

    it('schedules each deletion from disk once, at its top, before the update', async () => {
      const { manager, calls } = scripted((cwd, args) => cwd !== temporary ? undefined
        : args[0] === 'status' ? { stdout: statusXml(changedBefore) } : args[0] === 'delete' ? {} : undefined)
      expect(await manager.scheduleMissing(temporary)).toEqual({ ok: true, value: undefined })
      expect(calls.map((call) => call.args)).toEqual([
        ['status', '--non-interactive', '--xml', '--', '.'],
        ['delete', '--non-interactive', '-q', '--force', '--', 'gone@'],
      ])
    })

    it('never schedules a file missing at or below a recorded conflict victim, and schedules one outside it', async () => {
      const { manager, calls } = scripted((cwd, args) => cwd !== temporary ? undefined
        : args[0] === 'status' ? { stdout: statusXml([...changedBefore, { path: '.aidocs/engines/t2/brief.md', item: 'missing', revision: 5 },
          { path: '.aidocs/engines', item: 'missing', revision: 5 }]) }
        : args[0] === 'delete' ? {} : undefined)
      expect(await manager.scheduleMissing(temporary, ['.aidocs/engines', 'src/catalog.ts'])).toEqual({ ok: true, value: undefined })
      expect(calls.map((call) => call.args)).toEqual([
        ['status', '--non-interactive', '--xml', '--', '.'],
        ['delete', '--non-interactive', '-q', '--force', '--', 'gone@'],
      ])
    })

    it('names a file deleted from disk whose name svn cannot take, and passes nothing', async () => {
      const { manager, calls } = scripted((_cwd, args) => args[0] === 'status'
        ? { stdout: statusXml([{ path: 'složka/ř.txt', item: 'missing', revision: 5 }]) } : undefined)
      expect(await manager.scheduleMissing(temporary)).toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/složka\/ř.txt/) })
      expect(calls).toHaveLength(1)
    })

    it('marks conflicts resolved as the files stand, in batches, and passes no name svn cannot take', async () => {
      const { manager, calls } = scripted((cwd, args) => cwd === temporary && args[0] === 'resolve' ? {} : undefined)
      const many = Array.from({ length: 51 }, (_, index) => `src/f${index}.txt`)
      expect(await manager.resolveWorking(temporary, ['a.txt', ...many])).toEqual({ ok: true, value: undefined })
      expect(calls.map((call) => call.args.slice(0, 6))).toEqual([
        ['resolve', '--non-interactive', '--accept', 'working', '--', 'a.txt@'],
        ['resolve', '--non-interactive', '--accept', 'working', '--', 'src/f49.txt@'],
      ])
      expect(calls.map((call) => call.args.length - 5)).toEqual([50, 2])

      const refused = scripted(() => undefined)
      expect(await refused.manager.resolveWorking(temporary, ['a.txt', 'složka/ř.txt']))
        .toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/složka\/ř.txt/) })
      expect(refused.calls).toEqual([])

      const failing = scripted(() => failed('svn: E155010: The node was not found'))
      expect(await failing.manager.resolveWorking(temporary, ['a.txt'])).toMatchObject({ ok: false, code: 'svn-failed' })
    })

    it('reads text conflicts apart from tree and property conflicts, and the changes beside them', async () => {
      const after: Entry[] = [{ path: 'src/a.txt', item: 'conflicted', revision: 9 }, { path: 'tree.txt', item: 'normal', tree: true },
        { path: 'props.txt', item: 'normal', props: 'conflicted' }, { path: 'src/b.txt', item: 'modified', revision: 9 }]
      const { manager } = scripted((_cwd, args) => args[0] === 'status' ? { stdout: statusXml(after) } : undefined)
      expect(await manager.status(temporary)).toEqual({ ok: true, value: {
        textConflicts: ['src/a.txt'],
        otherConflicts: ['tree.txt', 'props.txt'],
        changed: ['src/a.txt', 'props.txt', 'src/b.txt'],
      } })
    })

    it('reads incoming paths of a changed project from svn log -v between the BASE before and after, never its own commits', async () => {
      const { manager, calls } = scripted((_cwd, args) => {
        if (args[0] === 'info') return { stdout: infoXml({ revision: 9 }) }
        if (args[0] === 'log') return { stdout: '<?xml version="1.0"?><log>'
          + '<logentry revision="6"><paths><path action="M" kind="file">/Project/src/a.txt</path></paths></logentry>'
          + '<logentry revision="8"><paths><path action="M" kind="file">/Project/src/b.txt</path>'
          + '<path action="M" kind="file">/Project/.aidocs/n.md</path></paths></logentry></log>' }
        return undefined
      })
      expect(await manager.incoming(temporary, 5, ['src/a.txt'], [6])).toEqual({ ok: true, value: ['src/b.txt'] })
      expect(calls.find((call) => call.args[0] === 'log')?.args).toEqual(['log', '--non-interactive', '-v', '--xml', '-r', '6:9', '--', url])
      expect(await manager.incoming(temporary, 9, ['src/a.txt'], [])).toEqual({ ok: true, value: [] })
      expect(calls.filter((call) => call.args[0] === 'log')).toHaveLength(1)
    })

    it('in a product group counts only the member projects the session changed', async () => {
      await writeFile(join(temporary, '.appgroup'), '')
      const { manager } = scripted((_cwd, args) => args[0] === 'info' ? { stdout: infoXml({ revision: 9 }) }
        : args[0] === 'log' ? { stdout: logXml(8, [{ action: 'M', path: '/Project/MemberB/b.txt' }]) } : undefined)
      expect(await manager.incoming(temporary, 5, ['MemberA/a.txt'], [])).toEqual({ ok: true, value: [] })
      expect(await manager.incoming(temporary, 5, ['MemberB/x.txt'], [])).toEqual({ ok: true, value: ['MemberB/b.txt'] })
    })

    it('reads a working copy as locked by an svn lock error or a locked directory', async () => {
      const locked = scripted(() => failed(`svn: E155004: Working copy '${temporary}' locked.`)).manager
      expect(await locked.locked(temporary)).toBe(true)
      const marked = scripted(() => ({ stdout: `<status><target path="."><entry path="."><wc-status item="normal" props="none" wc-locked="true"/></entry></target></status>` })).manager
      expect(await marked.locked(temporary)).toBe(true)
      const free = scripted(() => ({ stdout: statusXml([{ path: 'a.txt', item: 'modified' }]) })).manager
      expect(await free.locked(temporary)).toBe(false)
      expect(await scripted(() => failed('svn: E170013: Unable to connect')).manager.locked(temporary)).toBe(false)
    })

    it('marks a mount whose external definition names a revision, and asks for definitions only when a mount exists', async () => {
      await mkdir(join(temporary, 'pinned', '.svn'), { recursive: true })
      await mkdir(join(temporary, 'floating', '.svn'), { recursive: true })
      const rows: Entry[] = [{ path: 'pinned', item: 'external' }, { path: 'floating', item: 'external' },
        { path: 'pinned/p.txt', item: 'modified', revision: 4 }]
      const { manager, calls } = scripted((_cwd, args) => args[0] === 'status' ? { stdout: statusXml(rows) }
        : args[0] === 'propget' ? { stdout: `<properties><target path="."><property name="svn:externals">^/libs/p@3 pinned\n^/libs/f floating</property></target></properties>` }
          : undefined)
      const roots = await manager.reviewRoots(temporary)
      expect(roots.ok && roots.value.map((root) => ({ own: root.own, pinned: root.pinned, changed: root.changed.length }))).toEqual([
        { own: 'floating', pinned: false, changed: 0 },
        { own: 'pinned', pinned: true, changed: 1 },
        { own: '', pinned: false, changed: 0 },
      ])
      expect(calls.find((call) => call.args[0] === 'propget')?.args).toEqual(['propget', '--non-interactive', 'svn:externals', '-R', '--xml', '--', '.'])

      const plain = scripted((_cwd, args) => args[0] === 'status' ? { stdout: statusXml([{ path: 'a.txt', item: 'modified' }]) } : undefined)
      expect(await plain.manager.reviewRoots(temporary)).toMatchObject({ ok: true, value: [{ own: '', pinned: false }] })
      expect(plain.calls.some((call) => call.args[0] === 'propget')).toBe(false)
    })

    it('reads a nested external pin from the containing external working copy', async () => {
      await mkdir(join(temporary, 'outer', '.svn'), { recursive: true })
      await mkdir(join(temporary, 'outer', 'nested', '.svn'), { recursive: true })
      const rows: Entry[] = [{ path: 'outer', item: 'external' }, { path: 'outer/nested', item: 'external' },
        { path: 'outer/nested/a.txt', item: 'modified', revision: 1 }]
      const { manager, calls } = scripted((cwd, args) => args[0] === 'status' ? { stdout: statusXml(rows) }
        : args[0] === 'propget' ? { stdout: `<properties><target path="."><property name="svn:externals">${cwd === temporary ? '^/outer outer' : '-r1 ^/nested@1 nested'}</property></target></properties>` }
          : undefined)
      const roots = await manager.reviewRoots(temporary)
      expect(roots.ok && roots.value.map(({ own, pinned }) => ({ own, pinned }))).toEqual([
        { own: 'outer/nested', pinned: true }, { own: 'outer', pinned: false }, { own: '', pinned: false },
      ])
      expect(calls.filter((call) => call.args[0] === 'propget').map((call) => call.cwd)).toEqual([join(temporary, 'outer'), temporary])
    })

    it('fingerprints the worktree by its status and the size and time of each changed file', async () => {
      await writeFile(join(temporary, 'a.txt'), 'one\n')
      const { manager } = scripted((_cwd, args) => args[0] === 'status' ? { stdout: statusXml([{ path: 'a.txt', item: 'modified', revision: 5 }]) } : undefined)
      const first = await manager.fingerprint(temporary)
      expect(await manager.fingerprint(temporary)).toEqual(first)
      await writeFile(join(temporary, 'a.txt'), 'one and two\n')
      const second = await manager.fingerprint(temporary)
      expect(second.ok && first.ok && second.value !== first.value).toBe(true)
    })

    it('takes the working copies below a plain directory svn marks as external, never that directory itself', async () => {
      // `clients/coinGecko` and `clients/telegram` defined on `shared` make svn mark `shared/clients`,
      // a directory svn created and holds no node of; `shared/gone` names an external not on disk.
      for (const mount of [['shared', 'app'], ['shared', 'clients', 'coinGecko'], ['shared', 'clients', 'telegram']])
        await mkdir(join(temporary, ...mount, '.svn'), { recursive: true })
      const rows: Entry[] = [{ path: 'shared/app', item: 'external' }, { path: 'shared/clients', item: 'external' },
        { path: 'shared/gone', item: 'external' }, { path: 'shared/clients/telegram/t.ts', item: 'modified', revision: 4 }]
      const { manager } = scripted((cwd, args) => cwd === temporary && args[0] === 'status' ? { stdout: statusXml(rows) } : undefined)
      const telegram = [{ kind: 'item', conflict: false, path: 'shared/clients/telegram/t.ts' }]
      expect(await manager.roots(temporary)).toEqual({ ok: true, value: [
        { path: join(temporary, 'shared', 'clients', 'coinGecko'), own: 'shared/clients/coinGecko', changed: [] },
        { path: join(temporary, 'shared', 'clients', 'telegram'), own: 'shared/clients/telegram', changed: telegram },
        { path: join(temporary, 'shared', 'app'), own: 'shared/app', changed: [] },
        { path: temporary, own: '', changed: [] },
      ] })
    })

  })

  describe('merger handover', () => {
    it('hashes a file by content, a folder by the names and contents below it, and an absent path as missing, reading files only', async () => {
      await mkdir(join(temporary, 'src', 'deep'), { recursive: true })
      await writeFile(join(temporary, 'src', 'a.ts'), 'one\n')
      await writeFile(join(temporary, 'src', 'deep', 'b.ts'), 'two\n')
      const { manager, calls } = scripted(() => undefined)
      const first = await manager.hashes(temporary, ['src/a.ts', 'src', 'gone.ts'])
      expect(first.ok && first.value['src/a.ts']).toBe(createHash('sha256').update('one\n').digest('hex'))
      expect(first.ok && first.value['src']).toMatch(/^dir:[0-9a-f]{64}$/)
      expect(first.ok && first.value['gone.ts']).toBe('missing')
      await writeFile(join(temporary, 'src', 'deep', 'b.ts'), 'two changed\n')
      const second = await manager.hashes(temporary, ['src', 'src/a.ts'])
      expect(second.ok && second.value['src']).not.toBe(first.ok && first.value['src'])
      expect(second.ok && second.value['src/a.ts']).toBe(first.ok && first.value['src/a.ts'])
      expect(calls).toEqual([])
    })

    it('answers the highest BASE past a revision from status -v without externals, or null', async () => {
      const { manager, calls } = scripted((_cwd, args) => args[0] === 'status'
        ? { stdout: statusXml([{ path: temporary, item: 'normal', revision: 42 }, { path: join(temporary, 'a.txt'), item: 'normal', revision: 43 }]) }
        : undefined)
      expect(await manager.baseAbove(temporary, 42)).toEqual({ ok: true, value: 43 })
      expect(await manager.baseAbove(temporary, 43)).toEqual({ ok: true, value: null })
      expect(has(calls[0].args, 'status', '-v', '--xml', '--ignore-externals')).toBe(true)
    })
  })

  describe('conflict set', () => {
    const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')
    const entry = (path: string, kind: string, inner = ''): string =>
      `<entry kind="${kind}" path="${path}" revision="9"><url>${url}/${path}</url><wc-info><schedule>normal</schedule>${inner}</wc-info>`
    const tree = '<tree-conflict reason="unversioned" victim="engines" action="add" operation="update" kind="dir">'
      + `<version side="source-right" kind="dir" revision="9" path-in-repos="Project/.aidocs/engines" repos-url="${repository}"/></tree-conflict>`

    it('reads every kind together, each victim in its parent, and passes svn no name it cannot take', async () => {
      await mkdir(join(temporary, '.aidocs', 'engines', 't1'), { recursive: true })
      await mkdir(join(temporary, '.aidocs', 'engines', 't2'), { recursive: true })
      await writeFile(join(temporary, '.aidocs', 'engines', 't1', 'brief.md'), 'session t1\n')
      await writeFile(join(temporary, '.aidocs', 'engines', 't2', 'brief.md'), 'session t2\n')
      const folder = join(temporary, 'složka')
      await mkdir(folder)
      await writeFile(join(folder, 'ř.txt.mine'), 'one\r\ntwo\r\n')
      await writeFile(join(folder, 'ř.txt.r9'), 'one\ntwo\n')
      const slash = (path: string): string => path.replaceAll(sep, '/')
      const status = statusXml([
        { path: '.aidocs/engines', item: 'deleted', revision: 9, tree: true },
        { path: '.aidocs/engines/t1', item: 'unversioned' },
        { path: 'složka/ř.txt', item: 'conflicted', revision: 9 },
        { path: 'a.txt', item: 'normal', props: 'conflicted', revision: 9 },
      ])
      const properties = (target: string, value: string): string =>
        `<properties><target path="${target}"><property name="svn:ignore">${value}</property></target></properties>`
      const { manager, calls } = scripted((cwd, args) => {
        if (args[0] === 'status') return { stdout: status }
        if (args[0] === 'info' && !args.includes('--depth')) return { stdout: infoXml({ revision: 9 }) }
        if (args[0] === 'info' && cwd === temporary)
          return { stdout: `<info>${entry('.', 'dir')}</entry>${entry('a.txt', 'file')}<conflict type="property"><prop-file>${slash(temporary)}/a.txt.prej</prop-file></conflict></entry></info>` }
        if (args[0] === 'info' && cwd === join(temporary, '.aidocs') && args.includes('immediates'))
          return { stdout: `<info>${entry('.', 'dir')}</entry>${entry('engines', 'dir')}${tree}</entry></info>` }
        if (args[0] === 'info' && cwd === join(temporary, '.aidocs') && args.includes('infinity'))
          return { stdout: `<info>${entry('engines', 'dir')}</entry>${entry('engines\\t2', 'dir')}</entry>`
            + `${entry('engines\\t2\\brief.md', 'file', `<checksum>${sha1('incoming\n')}</checksum>`)}</entry>`
            + `${entry('engines\\t2\\trail.md', 'file', `<checksum>${sha1('trail\n')}</checksum>`)}</entry></info>` }
        if (args[0] === 'info' && cwd === folder)
          return { stdout: `<info>${entry('.', 'dir')}</entry>${entry('ř.txt', 'file')}<conflict type="text">`
            + `<prev-base-file>${slash(folder)}/ř.txt.r5</prev-base-file><prev-wc-file>${slash(folder)}/ř.txt.mine</prev-wc-file>`
            + `<cur-base-file>${slash(folder)}/ř.txt.r9</cur-base-file></conflict></entry></info>` }
        if (args[0] === 'proplist' && args.includes(`${url}/.@5`)) return { stdout: properties(`${url}/.`, 'a\n') }
        if (args[0] === 'proplist' && args.includes('BASE')) return { stdout: properties('a.txt', 'a\nc\n') }
        if (args[0] === 'proplist') return { stdout: properties('a.txt', 'a\nb\n') }
        return undefined
      })

      const read = await manager.conflictSet(temporary, 5)
      expect(read).toMatchObject({ ok: true, value: { revision: 9 } })
      const facts = read.ok ? read.value.facts : []
      expect(facts.map((fact) => [fact.path, fact.kind, fact.takesArgument])).toEqual([
        ['.aidocs/engines', 'tree', true], ['složka/ř.txt', 'text', false], ['a.txt', 'property', true],
      ])
      expect(facts[0]).toMatchObject({
        tree: { reason: 'unversioned', action: 'added', localKind: 'dir', incomingKind: 'dir', incomingRevision: 9, localHistory: false },
        content: { files: { local: 2, incoming: 2, same: 0, differing: 1 } },
      })
      expect(facts[1]).toMatchObject({ sidecars: ['složka/ř.txt.r5', 'složka/ř.txt.mine', 'složka/ř.txt.r9'], content: { equal: 'eol' } })
      expect(facts[2]).toMatchObject({ sidecars: ['a.txt.prej'], properties: [{ name: 'svn:ignore', older: null, mine: 'a\nb\n', theirs: 'a\nc\n' }] })
      expect(read.ok && read.value.rows.filter((row) => row.conflict).map((row) => row.path)).toEqual(['.aidocs/engines', 'složka/ř.txt', 'a.txt'])
      expect(calls.find((call) => call.cwd === folder)?.args).toEqual(['info', '--non-interactive', '--xml', '--depth', 'immediates', '--', '.'])
      expect(calls.some((call) => call.args.some((arg) => /[^\x20-\x7e]/.test(arg)))).toBe(false)
    })

    it('reads the root alone with depth empty, and a property absent before the update from a parent svn did not have', async () => {
      const { manager, calls } = scripted((_cwd, args) => {
        if (args[0] === 'status') return { stdout: statusXml([{ path: '.', item: 'normal', props: 'conflicted', revision: 9 }]) }
        if (args[0] === 'info' && !args.includes('--depth')) return { stdout: infoXml({ revision: 9 }) }
        if (args[0] === 'info') return { stdout: `<info>${entry('.', 'dir')}<conflict type="property"/></entry></info>` }
        if (args[0] === 'proplist' && args.some((arg) => arg.endsWith('@5'))) return failed('svn: E160013: path not found')
        if (args[0] === 'proplist') return { stdout: `<properties><target path="."><property name="p">${args.includes('BASE') ? 'theirs' : 'mine'}</property></target></properties>` }
        return undefined
      })
      expect(await manager.conflictSet(temporary, 5)).toMatchObject({ ok: true, value: { facts: [{ path: '.', kind: 'property',
        properties: [{ name: 'p', older: null, mine: 'mine', theirs: 'theirs' }] }] } })
      expect(calls.find((call) => call.args.includes('--depth'))?.args).toEqual(['info', '--non-interactive', '--xml', '--depth', 'empty', '--', '.'])
    })

    it('gives a conflict inside an external the revision of the external\'s own working copy, read once per root (UA1-J06-3)', async () => {
      const external = join(temporary, 'lib', 'ea')
      await mkdir(external, { recursive: true })
      const slash = (path: string): string => path.replaceAll(sep, '/')
      const inExternal = (name: string): string => `<entry kind="file" path="${name}" revision="2"><url>${url}/lib/ea/${name}</url>`
        + `<wc-info><wcroot-abspath>${slash(external)}</wcroot-abspath><schedule>normal</schedule></wc-info><conflict type="text">`
        + `<prev-base-file>${slash(external)}/${name}.r1</prev-base-file><cur-base-file>${slash(external)}/${name}.r2</cur-base-file></conflict></entry>`
      const { manager, calls } = scripted((cwd, args) => {
        if (args[0] === 'status') return { stdout: statusXml([
          { path: 'src/k.txt', item: 'conflicted', revision: 3 }, { path: 'lib/ea/a.txt', item: 'conflicted', revision: 2 }, { path: 'lib/ea/b.txt', item: 'conflicted', revision: 2 },
        ]) }
        if (args[0] === 'info' && !args.includes('--depth')) return { stdout: infoXml({ revision: cwd === external ? 2 : 3 }) }
        if (args[0] === 'info' && cwd === external) return { stdout: `<info>${inExternal('a.txt')}${inExternal('b.txt')}</info>` }
        if (args[0] === 'info' && cwd === join(temporary, 'src'))
          return { stdout: `<info><entry kind="file" path="k.txt" revision="3"><url>${url}/src/k.txt</url><wc-info><wcroot-abspath>${slash(temporary)}</wcroot-abspath></wc-info>`
            + '<conflict type="text"/></entry></info>' }
        return undefined
      })
      const read = await manager.conflictSet(temporary, 2)
      expect(read).toMatchObject({ ok: true, value: { revision: 3 } })
      expect(read.ok && read.value.facts.map((fact) => [fact.path, fact.rootRevision])).toEqual([['src/k.txt', 3], ['lib/ea/a.txt', 2], ['lib/ea/b.txt', 2]])
      expect(calls.filter((call) => call.args[0] === 'info' && !call.args.includes('--depth')).map((call) => call.cwd)).toEqual([temporary, external])
    })

    it('answers a failed read as an svn failure and reads nothing more for a set without conflicts', async () => {
      expect(await scripted(() => failed('svn: E155037: Previous operation has not finished')).manager.conflictSet(temporary, 5))
        .toMatchObject({ ok: false, code: 'locked' })
      const clean = scripted((_cwd, args) => args[0] === 'status' ? { stdout: statusXml([{ path: 'a.txt', item: 'modified', revision: 9 }]) }
        : args[0] === 'info' ? { stdout: infoXml({ revision: 9 }) } : undefined)
      expect(await clean.manager.conflictSet(temporary, 5)).toEqual({ ok: true, value: { revision: 9, facts: [], lockedPaths: [],
        rows: [{ path: 'a.txt', item: 'modified', conflict: false, base: 9 }] } })
      expect(clean.calls).toHaveLength(2)
    })

    it('includes nested working-copy locks even when SVN has cleared their conflict flag', async () => {
      const locked = scripted((_cwd, args) => args[0] === 'status' ? { stdout:
        '<status><target path="."><entry path="EA/EC"><wc-status item="normal" props="none" revision="2" wc-locked="true"/></entry></target></status>' }
        : args[0] === 'info' ? { stdout: infoXml({ revision: 9 }) } : undefined)
      expect(await locked.manager.conflictSet(temporary, 5)).toMatchObject({ ok: true, value: { facts: [], lockedPaths: ['EA/EC'] } })
    })
  })

  describe('proofs', () => {
    const fixture = (name: string, root: string, main: string): string =>
      readFileSync(join(import.meta.dirname, 'fixtures', 'worktree', name), 'utf8')
        .replaceAll('{ROOT}', root).replaceAll('{MAIN}', main).replaceAll('{REPO}', repository).replaceAll('\\', sep)
    const root = (path: string, changed: SvnRoot['changed'] = []): SvnRoot => ({ path, own: '', changed })

    it('finds the commits of the worktree itself since its checkout, confirmed by svn log -v', async () => {
      const worktree = join(temporary, 'worktree')
      const main = join(temporary, 'main')
      const { manager, calls } = scripted((cwd, args) => {
        if (cwd === worktree && args[0] === 'status') return { stdout: fixture('status-verbose-foreign.xml', worktree, main) }
        if (cwd === worktree && args[0] === 'info') return { stdout: fixture('info-worktree.xml', worktree, main) }
        if (args[0] === 'log') return { stdout: fixture(args.includes('6:6') ? 'log-committed.xml' : 'log-foreign.xml', worktree, main) }
        return undefined
      })
      expect(await manager.ownCommits(root(worktree))).toEqual({ ok: true, value: {
        repository, rows: [{ revision: 6, action: 'M', path: 'src/a.txt' }],
      } })
      expect(calls.filter((call) => call.args[0] === 'log')).toHaveLength(2)
      expect(calls.some((call) => call.cwd === main)).toBe(false)
    })

    it('reports a worktree directory present until it is gone', async () => {
      const { manager } = scripted(() => undefined)
      await mkdir(join(temporary, 'worktree'))

      expect(await manager.present(join(temporary, 'worktree'))).toBe(true)
      expect(await manager.present(join(temporary, 'gone'))).toBe(false)
    })

    it('reads the lower bounds once per repository and proves a review by its receipt or by BASE', async () => {
      const worktree = join(temporary, 'worktree')
      const mount = join(worktree, 'mount')
      const { manager, calls } = scripted((cwd, args) => {
        if (args[0] === 'info' && args.at(-1) === repository) return { stdout: infoXml({ revision: 5, entryUrl: repository }) }
        if (args[0] === 'info') return { stdout: infoXml({ revision: 5 }) }
        if (args[0] === 'log') return { stdout: logXml(6, [{ action: 'M', path: '/Project/src/a.txt' }]) }
        if (args[0] === 'status' && cwd === worktree)
          return { stdout: statusXml([{ path: 'src/a.txt', item: 'normal', revision: 6, changed: 6 }, { path: 'src', item: 'normal', revision: 5, changed: 4 }]) }
        return undefined
      })
      const roots = [{ path: mount, own: 'mount', changed: [] }, root(worktree, [{ kind: 'item', conflict: false, path: 'src/a.txt' }])]
      const bounds = await manager.lowerBounds(roots)
      expect(bounds).toEqual({ ok: true, value: {
        mount: { repository, base: '/Project', rootBase: 5, since: 5 },
        '': { repository, base: '/Project', rootBase: 5, since: 5 },
      } })
      expect(calls.filter((call) => call.args.at(-1) === repository)).toHaveLength(1)
      if (!bounds.ok) return
      expect(await manager.reviewed(roots[1], bounds.value, 6)).toEqual({ ok: true, value: [{ revision: 6, action: 'M', path: 'src/a.txt' }] })
      expect(await manager.reviewed(roots[1], bounds.value, 5)).toMatchObject({ ok: false, detail: expect.stringMatching(/pre-review/) })
      expect(await manager.proven(roots[1], bounds.value)).toEqual({ ok: true, value: [{ revision: 6, action: 'M', path: 'src/a.txt' }] })
    })

    it('answers a failed svn read inside a proof with its code', async () => {
      const { manager } = scripted(() => failed('svn: E170013: Unable to connect'))
      expect(await manager.ownCommits(root(temporary))).toMatchObject({ ok: false, code: 'svn-failed', detail: expect.stringMatching(/E170013/) })
    })
  })

  // Removed with the main-copy landing: no step writes the main copy after a commit any more.
  describe('removal', () => {
    async function worktree(name = '014-x'): Promise<SvnWorktreeLocation> {
      const owner = join(temporary, 'owner')
      const worktreePath = join(owner, '.worktrees', name)
      await mkdir(join(worktreePath, '.svn'), { recursive: true })
      await writeFile(join(worktreePath, 'a.txt'), 'a\n')
      return { worktreePath, ownerDir: owner, url, directoryId: await SvnWorktreeManager.directoryIdOf(worktreePath) ?? undefined }
    }
    const noSvn = (): Reply => undefined

    it('renames the worktree aside, purges it and removes the empty .worktrees', async () => {
      const location = await worktree()
      const { manager } = scripted(noSvn)
      expect(await manager.renameAside(location)).toEqual({ ok: true, value: 'renamed' })
      expect(existsSync(`${location.worktreePath}.deleting`)).toBe(true)
      expect(await manager.renameAside(location)).toEqual({ ok: true, value: 'renamed' })
      expect(await manager.purgeAside(location)).toEqual({ ok: true, value: 'removed' })
      await manager.removeEmptyWorktreesDir(location.ownerDir)
      expect(existsSync(join(location.ownerDir, '.worktrees'))).toBe(false)
      expect(await manager.renameAside(location)).toEqual({ ok: true, value: 'absent' })
    })

    it('refuses another directory at the recorded path', async () => {
      const location = await worktree()
      if (location.directoryId === undefined) return
      const { manager } = scripted(noSvn)
      expect(await manager.renameAside({ ...location, directoryId: '1:2:3' }))
        .toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/another directory/) })
      expect(existsSync(location.worktreePath)).toBe(true)
    })

    it('selects a surviving removal remainder only when its directory identity matches', async () => {
      const location = await worktree()
      const { manager } = scripted(noSvn)
      expect(await manager.removalSource(location)).toMatchObject({ ok: true, value: { path: location.worktreePath, aside: false, present: true } })
      await manager.renameAside(location)
      expect(await manager.removalSource(location)).toMatchObject({ ok: true, value: { path: `${location.worktreePath}.deleting`, aside: true, present: true } })
      expect(await manager.removalSource({ ...location, directoryId: 'wrong' })).toMatchObject({ ok: false, code: 'refused' })
      await mkdir(location.worktreePath)
      expect(await manager.removalSource(location)).toMatchObject({ ok: false, detail: expect.stringContaining('Both the worktree') })
    })

    it('does not treat a linked worktree or linked SVN metadata as absent removal evidence', async () => {
      const location = await worktree()
      const { manager } = scripted(noSvn)
      const linked = join(temporary, 'linked-worktree')
      await symlink(location.worktreePath, linked, 'junction')
      expect(await manager.removalStatus(linked)).toMatchObject({ ok: false, detail: expect.stringContaining('linked directory') })
      await rm(join(location.worktreePath, '.svn'), { recursive: true })
      await symlink(join(temporary, 'missing-metadata'), join(location.worktreePath, '.svn'), 'junction')
      expect(await manager.removalStatus(location.worktreePath)).toMatchObject({ ok: false, detail: expect.stringContaining('linked directory') })
    })

    it('without a file ID decides by the URL the worktree checks out', async () => {
      const location = { ...await worktree(), directoryId: undefined }
      let checkedOut = `${repository}/Other`
      const { manager } = scripted((_cwd, args) => args[0] === 'info' ? { stdout: infoXml({ entryUrl: checkedOut }) } : undefined)
      expect(await manager.renameAside(location)).toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/Other, not/) })
      checkedOut = url
      expect(await manager.renameAside(location)).toEqual({ ok: true, value: 'renamed' })
    })

    it.skipIf(process.platform !== 'win32')('answers in-use while a process has its working directory inside', async () => {
      const location = await worktree()
      const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
        { cwd: location.worktreePath, stdio: ['ignore', 'pipe', 'ignore'] })
      try {
        // The child opens its working directory while it starts, after `spawn` already fired.
        await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject) })
        expect(await scripted(noSvn).manager.renameAside(location)).toEqual({ ok: true,
          value: { blocked: 'EBUSY', path: location.worktreePath, detail: expect.stringContaining('EBUSY') } })
        expect(await readFile(join(location.worktreePath, 'a.txt'), 'utf8')).toBe('a\n')
      }
      finally {
        const exited = new Promise((resolve) => child.once('exit', resolve))
        child.kill()
        await exited
      }
      expect(await scripted(noSvn).manager.renameAside(location)).toEqual({ ok: true, value: 'renamed' })
    })

    it('purges through the remover its composer hands in', async () => {
      const location = await worktree()
      const removed: string[] = []
      const manager = new SvnWorktreeManager(scripted(noSvn).runner, async (path) => {
        removed.push(path)
        await rm(path, { recursive: true, force: true })
      })
      expect(await manager.renameAside(location)).toEqual({ ok: true, value: 'renamed' })
      expect(await manager.purgeAside(location)).toEqual({ ok: true, value: 'removed' })
      expect(removed).toEqual([`${location.worktreePath}.deleting`])
    })

    it('answers undeleted when the remover fails, and keeps the rest for the next pass', async () => {
      const location = await worktree()
      const manager = new SvnWorktreeManager(scripted(noSvn).runner, async () => {
        throw new Error('EBUSY: resource busy or locked')
      })
      expect(await manager.renameAside(location)).toEqual({ ok: true, value: 'renamed' })
      expect(await manager.purgeAside(location)).toEqual({ ok: true, value: 'undeleted' })
      expect(existsSync(`${location.worktreePath}.deleting`)).toBe(true)
    })

    it('unlinks a junction into a shared store without touching the store, and removes a path beyond 260 characters', async () => {
      const store = join(temporary, 'store', 'package')
      await mkdir(store, { recursive: true })
      await writeFile(join(store, 'index.js'), 'shared\n')
      const location = await worktree()
      await mkdir(join(location.worktreePath, 'node_modules'))
      await symlink(store, join(location.worktreePath, 'node_modules', 'package'), 'junction')
      const deep = join(location.worktreePath, ...Array.from({ length: 6 }, (_, index) => `${index}`.padEnd(50, 'd')))
      expect(join(deep, 'file.txt').length).toBeGreaterThan(260)
      await mkdir(deep, { recursive: true })
      await writeFile(join(deep, 'file.txt'), 'deep\n')
      const { manager } = scripted(noSvn)
      expect(await manager.renameAside(location)).toEqual({ ok: true, value: 'renamed' })
      expect(await manager.purgeAside(location)).toEqual({ ok: true, value: 'removed' })
      expect(existsSync(`${location.worktreePath}.deleting`)).toBe(false)
      expect(await readFile(join(store, 'index.js'), 'utf8')).toBe('shared\n')
    })
  })

  describe('landed rows', () => {
    it('reads the root revision and repository of a main copy locally', async () => {
      const { manager, calls } = scripted((_cwd, args) => args[0] === 'info' ? { stdout: infoXml({ revision: 57 }) } : undefined)
      expect(await manager.rootRevisionOf(temporary)).toEqual({ ok: true, value: { repository, revision: 57 } })
      expect(calls.map((call) => call.args)).toEqual([['info', '--non-interactive', '--xml', '--', '.']])
    })

    it('counts the revisions after the root revision from svn log -q, and reads E160006 as none behind', async () => {
      const entries = '<?xml version="1.0"?><log><logentry revision="58"><author>a</author></logentry>'
        + '<logentry revision="60"><author>a</author></logentry><logentry\n   revision="61"></logentry></log>'
      const behind = scripted((_cwd, args) => {
        if (args[0] === 'status') return { stdout: statusXml([]) }
        if (args[0] === 'info') return { stdout: infoXml({ revision: 57 }) }
        if (args[0] === 'log') return { stdout: entries }
        return undefined
      })
      expect(await behind.manager.behind(temporary)).toEqual({ ok: true, value: [{ own: '', behind: 3 }] })
      expect(behind.calls.find((call) => call.args[0] === 'log')?.args).toEqual(['log', '--non-interactive', '-q', '--xml', '-r', '58:HEAD', '--', '.'])
      const current = scripted((_cwd, args) => {
        if (args[0] === 'status') return { stdout: statusXml([]) }
        if (args[0] === 'info') return { stdout: infoXml({ revision: 61 }) }
        if (args[0] === 'log') return { code: 1, stdout: '<?xml version="1.0"?>\n<log>\n', stderr: 'svn: E160006: No such revision 62' }
        return undefined
      })
      expect(await current.manager.behind(temporary)).toEqual({ ok: true, value: [{ own: '', behind: 0 }] })
      const offline = scripted((_cwd, args) => {
        if (args[0] === 'status') return { stdout: statusXml([]) }
        if (args[0] === 'info') return { stdout: infoXml({ revision: 61 }) }
        if (args[0] === 'log') return failed('svn: E170013: Unable to connect to a repository')
        return undefined
      })
      expect(await offline.manager.behind(temporary)).toMatchObject({ ok: false, code: 'svn-failed' })
    })

    it('counts every floating external working copy against its own repository, one log per root, and skips a pinned one', async () => {
      for (const mount of ['ea', 'eb', 'pinned']) await mkdir(join(temporary, 'lib', mount, '.svn'), { recursive: true })
      const rows: Entry[] = [{ path: 'lib/ea', item: 'external' }, { path: 'lib/eb', item: 'external' }, { path: 'lib/pinned', item: 'external' }]
      const revisions: Record<string, number> = { '': 4, 'lib/ea': 3, 'lib/eb': 2, 'lib/pinned': 1 }
      const heads: Record<string, number> = { '': 4, 'lib/ea': 4, 'lib/eb': 3, 'lib/pinned': 9 }
      const ownOf = (cwd: string): string => cwd === temporary ? '' : cwd.slice(temporary.length + 1).split(sep).join('/')
      const { manager, calls } = scripted((cwd, args) => {
        if (args[0] === 'status') return { stdout: statusXml(rows) }
        if (args[0] === 'propget') return { stdout: '<properties><target path="lib"><property name="svn:externals">^/ea ea\n^/eb eb\n^/p@1 pinned</property></target></properties>' }
        if (args[0] === 'info') return { stdout: infoXml({ revision: revisions[ownOf(cwd)] }) }
        if (args[0] !== 'log') return undefined
        const own = ownOf(cwd)
        const from = revisions[own] + 1
        if (from > heads[own]) return { code: 1, stderr: `svn: E160006: No such revision ${from}` }
        return { stdout: '<log>' + Array.from({ length: heads[own] - from + 1 }, (_, index) => `<logentry revision="${from + index}"></logentry>`).join('') + '</log>' }
      })
      expect(await manager.behind(temporary)).toEqual({ ok: true, value: [
        { own: '', behind: 0 }, { own: 'lib/ea', behind: 1 }, { own: 'lib/eb', behind: 1 },
      ] })
      expect(calls.filter((call) => call.args[0] === 'status')).toHaveLength(1)
      expect(calls.filter((call) => call.args[0] === 'log').map((call) => ownOf(call.cwd)).sort()).toEqual(['', 'lib/ea', 'lib/eb'])
    })

    it('reads a real main copy behind in its externals only, each from its own repository', { timeout: 60_000 }, async () => {
      const svn = new SvnInvoker()
      const must = async (cwd: string, args: string[]): Promise<void> => {
        const outcome = await svn.run(cwd, args)
        expect(outcome.code, outcome.stderr).toBe(0)
      }
      const repos: Record<string, string> = {}
      for (const name of ['app', 'ea', 'eb']) {
        repos[name] = join(temporary, 'repos', name)
        await mkdir(repos[name], { recursive: true })
        expect(await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repos[name]], cwd: temporary, env: process.env })).toMatchObject({ code: 0 })
      }
      const seed = join(temporary, 'seed')
      for (const name of ['ea', 'eb']) {
        await must(temporary, ['checkout', pathToFileURL(repos[name]).href, join(seed, name)])
        await writeFile(join(seed, name, 'notes.txt'), `${name} 1\n`)
        await must(join(seed, name), ['add', '--', 'notes.txt'])
        await must(join(seed, name), ['commit', '-m', 'seed', '--', '.'])
      }
      const main = join(temporary, 'main')
      await must(temporary, ['checkout', pathToFileURL(repos.app).href, main])
      await mkdir(join(main, 'lib'))
      await must(main, ['add', '--', 'lib'])
      await must(main, ['propset', 'svn:externals', `${pathToFileURL(repos.ea).href} ea\n${pathToFileURL(repos.eb).href} eb\n-r1 ${pathToFileURL(repos.ea).href} pinned\n`, '--', 'lib'])
      await must(main, ['commit', '-m', 'externals', '--', '.'])
      await must(main, ['update', '--', '.'])
      for (const name of ['ea', 'eb']) {
        await writeFile(join(seed, name, 'notes.txt'), `${name} 2\n`)
        await must(join(seed, name), ['commit', '-m', 'published from a worktree', '--', '.'])
      }

      expect(await new SvnWorktreeManager(svn).behind(main)).toEqual({ ok: true, value: [
        { own: '', behind: 0 }, { own: 'lib/ea', behind: 1 }, { own: 'lib/eb', behind: 1 },
      ] })
    })

    it('lists the working copies of the mounts below a main copy, never the main copy itself', async () => {
      await mkdir(join(temporary, 'shared', 'frontend', '.svn'), { recursive: true })
      const rows: Entry[] = [{ path: 'shared/frontend', item: 'external' }, { path: 'a.txt', item: 'modified', revision: 3 }]
      const { manager } = scripted((_cwd, args) => args[0] === 'status' ? { stdout: statusXml(rows) } : undefined)
      expect(await manager.mountRootsOf(temporary)).toEqual({ ok: true, value: [join(temporary, 'shared', 'frontend')] })
    })
  })
})


describe('SVN commit recovery evidence', () => {
  it('reads verbose history with exact message, author, time and repository paths', async () => {
    const h = scripted((_cwd, args) => args[0] === 'info' ? { stdout: infoXml({ revision: 42 }) }
      : args[0] === 'log' ? { stdout: '<log><logentry revision="42"><author>ana</author><date>2026-10-16T10:00:00Z</date><paths><path action="M">/Project/a.txt</path></paths><msg>\n[App] Change &amp; test\n\nDetails\n</msg></logentry></log>' } : undefined)
    expect(await h.manager.logSince('C:/tree', 41)).toEqual({ ok: true, value: [{ revision: 42, author: 'ana',
      date: Date.parse('2026-10-16T10:00:00Z'), paths: ['/Project/a.txt'], message: '\n[App] Change & test\n\nDetails\n' }] })
    expect(h.calls[1].args).toEqual(['log', '--non-interactive', '--xml', '-v', '-r', '42:42', '--', '.'])
  })

  /**
   * UA1-J09-2 on real svn: a copy of the working copy taken before the commit is the working copy of a
   * client killed after the server accepted it, its nodes still at BASE r1 with the published bytes as edits.
   */
  it('gives the published nodes of a killed commit their revision and leaves every byte as it was', async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'jamat-v3-killed-commit-')))
    try {
      const svn = new SvnInvoker(), repo = join(temporary, 'repo'), wc = join(temporary, 'wc'), killed = join(temporary, 'killed')
      const run = async (cwd: string, args: string[]): Promise<string> => {
        const result = await svn.run(cwd, args)
        expect(result.code, result.stderr).toBe(0)
        return result.stdout
      }
      expect(await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repo], cwd: temporary, env: process.env })).toMatchObject({ code: 0 })
      await run(temporary, ['checkout', pathToFileURL(repo).href, wc])
      for (const name of ['edit.txt', 'gone.txt', 'kept.txt', 'other.txt']) await writeFile(join(wc, name), `${name} one\n`)
      await run(wc, ['add', '--', 'edit.txt', 'gone.txt', 'kept.txt', 'other.txt'])
      await run(wc, ['commit', '-m', 'base'])
      await writeFile(join(wc, 'edit.txt'), 'edit.txt two\n')
      await run(wc, ['propset', 'jamat:note', 'reviewed', 'edit.txt'])
      await writeFile(join(wc, 'new.txt'), 'new\n')
      await mkdir(join(wc, 'nd'))
      await writeFile(join(wc, 'nd', 'f.txt'), 'f\n')
      await run(wc, ['add', '--', 'new.txt', 'nd'])
      await run(wc, ['delete', '--', 'gone.txt'])
      await run(wc, ['delete', '--keep-local', '--', 'kept.txt'])
      await writeFile(join(wc, 'other.txt'), 'other.txt not selected\n')
      await cp(wc, killed, { recursive: true })
      const selection = ['edit.txt', 'new.txt', 'nd', 'nd/f.txt', 'gone.txt', 'kept.txt']
      await run(wc, ['commit', '-m', 'published', '--depth', 'empty', '--', ...selection])
      expect(await new SvnWorktreeManager(svn).advancePublished(killed, selection, 2)).toEqual({ ok: true, value: undefined })
      const status = (await run(killed, ['status'])).split(/\r?\n/).filter(Boolean).sort()
      expect(status).toEqual(['?       kept.txt', 'M       other.txt'])
      for (const name of ['edit.txt', 'new.txt', 'nd', 'nd/f.txt']) expect((await run(killed, ['info', '--show-item', 'revision', '--', name])).trim()).toBe('2')
      expect((await run(killed, ['info', '--show-item', 'depth', '--', 'nd'])).trim()).toBe('infinity')
      expect(await readFile(join(killed, 'edit.txt'), 'utf8')).toBe('edit.txt two\n')
      expect(await readFile(join(killed, 'kept.txt'), 'utf8')).toBe('kept.txt one\n')
      expect(await readFile(join(killed, 'other.txt'), 'utf8')).toBe('other.txt not selected\n')
      expect(existsSync(join(killed, 'gone.txt'))).toBe(false)
    } finally { await rm(temporary, { recursive: true, force: true }) }
  })
})
