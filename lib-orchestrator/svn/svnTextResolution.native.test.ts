import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CommandInvoker } from '../shared/commandInvoker'
import type { CommandRunner } from '../shared/commandInvoker.types'
import { SvnInvoker } from './svnInvoker'
import { SvnTextResolution } from './svnTextResolution'
import { SvnConflictResolutions } from './svnConflictResolutions'

const testRoot = 'Q:/UnitTestFiles/NodeJs/Applications/Jamat/worktrees'

/** A file opened by another process with the given sharing, until the returned release is awaited. */
async function held(file: string, share = 'Read'): Promise<() => Promise<void>> {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$f=[System.IO.File]::Open($env:JAMAT_V3_HELD_FILE,'Open','Read','${share}'); try { [Console]::WriteLine('HELD'); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }`],
  { windowsHide: true, env: { ...process.env, JAMAT_V3_HELD_FILE: file }, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const deadline = setTimeout(() => child.kill(), 60_000)
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', () => reject(new Error('File holder ended before becoming ready')))
    child.stdout.on('data', (data) => { if (String(data).includes('HELD')) resolve() })
  })
  return async () => { child.stdin.end('\n'); await closed; clearTimeout(deadline) }
}

/** A repository and a working copy whose update left each file conflicted: base, then local in `wc`, incoming committed from `main`. */
async function conflicted(name: string, files: Record<string, { base: string | Buffer; local: string | Buffer; incoming: string | Buffer; mime?: string }>) {
  const root = await mkdtemp(join(testRoot, `${name}-`)), svn = new SvnInvoker()
  const run = async (cwd: string, args: string[]) => {
    const result = await svn.run(cwd, args)
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }
  const repo = join(root, 'repo'), main = join(root, 'main'), wc = join(root, 'wc'), message = join(root, 'message.txt')
  expect((await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repo], cwd: root, env: process.env })).code).toBe(0)
  await writeFile(message, `[Fixture] Native ${name}`)
  await run(root, ['checkout', pathToFileURL(repo).href, main])
  for (const [path, file] of Object.entries(files)) {
    await writeFile(join(main, path), file.base)
    await run(main, ['add', path])
    if (file.mime !== undefined) await run(main, ['propset', 'svn:mime-type', file.mime, path])
  }
  await run(main, ['commit', '--file', message])
  await run(root, ['checkout', pathToFileURL(repo).href, wc])
  for (const [path, file] of Object.entries(files)) {
    await writeFile(join(wc, path), file.local)
    await writeFile(join(main, path), file.incoming)
  }
  await run(main, ['commit', '--file', message])
  await run(wc, ['update', '--accept', 'postpone'])
  return { root, repo, main, wc, svn, run, message }
}

const input = (root: string, savedDir: string, path: string, option: 'take-incoming' | 'keep-mine') =>
  ({ root, savedDir, path, kind: 'text' as const, option, journal: null, onStep: async () => {} })

describe.skipIf(process.platform !== 'win32' || !existsSync(testRoot))('real SVN text recovery on Windows', () => {
  it('calls recoverLocked on a real interrupted working queue and refuses an unknown installation queue', async () => {
    const root = await mkdtemp(join(testRoot, 'native-k8-unit-')), svn = new SvnInvoker()
    const run = async (cwd: string, args: string[]) => {
      const result = await svn.run(cwd, args)
      expect(result.code, result.stderr).toBe(0)
      return result.stdout
    }
    const repo = join(root, 'repo'), main = join(root, 'main')
    expect((await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repo], cwd: root, env: process.env })).code).toBe(0)
    const url = pathToFileURL(repo).href, message = join(root, 'message.txt')
    await writeFile(message, '[Fixture] Native recoverLocked regression')
    await run(root, ['checkout', url, main])
    await writeFile(join(main, 'a.txt'), 'base\n')
    await run(main, ['add', 'a.txt'])
    await run(main, ['commit', '--file', message])
    for (const name of ['owned', 'unknown']) {
      const wc = join(root, name)
      await run(root, ['checkout', url, wc])
      await writeFile(join(wc, 'a.txt'), 'local\n')
    }
    await writeFile(join(main, 'a.txt'), 'incoming\n')
    await run(main, ['commit', '--file', message])
    for (const name of ['owned', 'unknown'] as const) {
      const wc = join(root, name), savedDir = join(root, 'saved', name)
      await mkdir(savedDir, { recursive: true })
      await run(wc, ['update', '--accept', 'postpone'])
      expect(await readFile(join(wc, 'a.txt'), 'utf8')).toContain('<<<<<<<')
      const text = new SvnTextResolution(svn)
      if (name === 'owned') await text.choose(input(wc, savedDir, 'a.txt', 'keep-mine'), 'mine')
      const release = await held(join(wc, name === 'owned' ? 'a.txt.mine' : 'a.txt'))
      try {
        if (name === 'owned') expect((await text.resolve(wc, 'a.txt')).ok).toBe(false)
        else expect((await svn.run(wc, ['resolve', '--accept', 'mine-full', 'a.txt'])).code).not.toBe(0)
      } finally { await release() }
      expect(await run(wc, ['status', '--xml'])).toContain('wc-locked="true"')
      await writeFile(join(wc, 'a.txt'), 'manual merge after interruption\n')
      const resolutions = new SvnConflictResolutions({ svn, markersIn: async () => [], now: Date.now })
      const recovered = await resolutions.recoverLocked(wc, savedDir)
      expect(recovered.ok).toBe(name === 'owned')
      expect(await readFile(join(wc, 'a.txt'), 'utf8')).toBe('manual merge after interruption\n')
      expect((await run(wc, ['status', '--xml'])).includes('wc-locked="true"')).toBe(name === 'unknown')
      if (name === 'unknown') {
        const copies = (await readdir(savedDir)).filter((entry) => entry.startsWith('locked-'))
        expect(copies).toHaveLength(1)
        expect(!recovered.ok && recovered.detail).toContain(join(savedDir, copies[0]))
        expect(!recovered.ok && recovered.detail).toContain('a.txt')
        expect(await readFile(join(savedDir, copies[0], 'a.txt'), 'utf8')).toBe('manual merge after interruption\n')
        expect((await readdir(join(savedDir, copies[0]))).sort()).toEqual(expect.arrayContaining(['a.txt', 'a.txt.mine']))
      }
    }
  }, 150_000)

  it('settles a binary conflict, which has no .mine sidecar, with either side', async () => {
    const binary = (text: string) => Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(text)])
    const fixture = await conflicted('native-binary', {
      'b.bin': { base: binary('base'), local: binary('local b'), incoming: binary('incoming b'), mime: 'application/octet-stream' },
      'c.bin': { base: binary('base'), local: binary('local c'), incoming: binary('incoming c'), mime: 'application/octet-stream' },
    })
    expect(existsSync(join(fixture.wc, 'b.bin.mine'))).toBe(false)
    const resolutions = new SvnConflictResolutions({ svn: fixture.svn, markersIn: async () => [], now: Date.now })
    expect(await resolutions.apply(input(fixture.wc, join(fixture.root, 'saved', 'b'), 'b.bin', 'take-incoming'))).toEqual({ ok: true, value: undefined })
    expect(await resolutions.apply(input(fixture.wc, join(fixture.root, 'saved', 'c'), 'c.bin', 'keep-mine'))).toEqual({ ok: true, value: undefined })
    expect(await readFile(join(fixture.wc, 'b.bin'))).toEqual(binary('incoming b'))
    expect(await readFile(join(fixture.wc, 'c.bin'))).toEqual(binary('local c'))
    expect(await fixture.run(fixture.wc, ['status', '--xml'])).not.toContain('item="conflicted"')
  }, 150_000)

  it('keeps the saved sides of each path apart in one saved folder, installs a side over a missing working file and names a read-only one', async () => {
    const fixture = await conflicted('native-sides', {
      'a.txt': { base: 'base\n', local: 'local a\n', incoming: 'incoming a\n' },
      'b.txt': { base: 'base\n', local: 'local b\n', incoming: 'incoming b\n' },
      'r.txt': { base: 'base\n', local: 'local r\n', incoming: 'incoming r\n' },
    })
    const text = new SvnTextResolution(fixture.svn), savedDir = join(fixture.root, 'saved')
    await rm(join(fixture.wc, 'b.txt'))
    for (const path of ['a.txt', 'b.txt']) await text.choose(input(fixture.wc, savedDir, path, 'take-incoming'), 'theirs')
    expect(await readFile(join(fixture.wc, 'a.txt'), 'utf8')).toBe('incoming a\n')
    expect(await readFile(join(fixture.wc, 'b.txt'), 'utf8')).toBe('incoming b\n')
    await chmod(join(fixture.wc, 'r.txt'), 0o444)
    await expect(text.choose(input(fixture.wc, savedDir, 'r.txt', 'take-incoming'), 'theirs')).rejects.toThrow(/^r\.txt is read-only/)
    expect((await readdir(fixture.wc)).filter((entry) => entry.includes('.jamat-'))).toEqual([])
  }, 150_000)

  it('says in words that a held sidecar stopped the resolve and left the working copy locked, also on a retry, and settles once it is closed (UA1-J06-1)', async () => {
    const fixture = await conflicted('native-held-sidecar', { 'a.txt': { base: 'base\n', local: 'local\n', incoming: 'incoming\n' } })
    const resolutions = new SvnConflictResolutions({ svn: fixture.svn, markersIn: async () => [], now: Date.now })
    const savedDir = join(fixture.root, 'saved')
    const resumed = { ...input(fixture.wc, savedDir, 'a.txt', 'keep-mine'), journal: { option: 'keep-mine' as const, done: 1 } }
    const release = await held(join(fixture.wc, 'a.txt.r2'))
    let interrupted, retried
    try {
      interrupted = await resolutions.apply(input(fixture.wc, savedDir, 'a.txt', 'keep-mine'))
      retried = await resolutions.apply(resumed)
    } finally { await release() }
    expect(interrupted).toEqual({ ok: false, code: 'locked', detail: 'a.txt.r2 is open in another program, so SVN could not finish settling a.txt and the working copy stays locked. '
      + 'Close that program, then choose the option again or press Check again; Jamat finishes its own SVN step first.' })
    expect(retried).toEqual({ ok: false, code: 'locked', detail: `a.txt.r2 is open in another program, so Jamat could not finish its own interrupted SVN step and the working copy ${fixture.wc} `
      + 'stays locked. Close that program, then choose the option again or press Check again. Your working files were left as they are.' })
    expect(await readFile(join(fixture.wc, 'a.txt'), 'utf8')).toBe('local\n')
    expect(await resolutions.apply(resumed)).toEqual({ ok: true, value: undefined })
    expect(await readFile(join(fixture.wc, 'a.txt'), 'utf8')).toBe('local\n')
    const status = await fixture.run(fixture.wc, ['status', '--xml'])
    expect(status).not.toContain('item="conflicted"')
    expect(status).not.toContain('wc-locked="true"')
  }, 150_000)

  it('names a working file held open for reading as open in another program when Windows refuses to replace it, and installs the side once it is closed (UA1-J06-4)', async () => {
    const fixture = await conflicted('native-held-read', { 'a.txt': { base: 'base\n', local: 'local\n', incoming: 'incoming\n' } })
    const resolutions = new SvnConflictResolutions({ svn: fixture.svn, markersIn: async () => [], now: Date.now })
    const savedDir = join(fixture.root, 'saved')
    const before = await readFile(join(fixture.wc, 'a.txt'))
    const release = await held(join(fixture.wc, 'a.txt'))
    let refused
    try { refused = await resolutions.apply(input(fixture.wc, savedDir, 'a.txt', 'take-incoming')) } finally { await release() }
    expect(refused).toEqual({ ok: false, code: 'locked', detail: 'a.txt is open in another program; close it and choose the option again' })
    expect(await readFile(join(fixture.wc, 'a.txt'))).toEqual(before)
    expect(await resolutions.apply({ ...input(fixture.wc, savedDir, 'a.txt', 'take-incoming'), journal: { option: 'take-incoming', done: 1 } })).toEqual({ ok: true, value: undefined })
    expect(await readFile(join(fixture.wc, 'a.txt'), 'utf8')).toBe('incoming\n')
  }, 150_000)

  it('names a working file deleted under its own pending installation instead of asking to release holders', async () => {
    const fixture = await conflicted('native-gone', { 'a.txt': { base: 'base\n', local: 'local\n', incoming: 'incoming\n' } })
    const text = new SvnTextResolution(fixture.svn), savedDir = join(fixture.root, 'saved')
    await text.choose(input(fixture.wc, savedDir, 'a.txt', 'take-incoming'), 'theirs')
    const release = await held(join(fixture.wc, 'a.txt'))
    try { expect((await text.resolve(fixture.wc, 'a.txt')).ok).toBe(false) } finally { await release() }
    await rm(join(fixture.wc, 'a.txt'))
    const resolutions = new SvnConflictResolutions({ svn: fixture.svn, markersIn: async () => [], now: Date.now })
    const refused = await resolutions.recoverLocked(fixture.wc, savedDir)
    expect(refused).toMatchObject({ ok: false, code: 'locked' })
    expect(!refused.ok && refused.detail).toMatch(/^The working file a\.txt is missing/)
    await writeFile(join(fixture.wc, 'a.txt'), 'put back by the person\n')
    expect(await resolutions.recoverLocked(fixture.wc, savedDir)).toEqual({ ok: true, value: undefined })
    expect(await readFile(join(fixture.wc, 'a.txt'), 'utf8')).toBe('put back by the person\n')
  }, 150_000)

  it('never fingerprints the lock of a live foreign SVN operation that took the working copy just before resolve', async () => {
    const fixture = await conflicted('native-live', { 'a.txt': { base: 'base\n', local: 'local\n', incoming: 'incoming\n' } })
    await writeFile(join(fixture.repo, 'hooks', 'pre-commit.bat'), '@echo off\r\nping -n 9 127.0.0.1 >nul\r\nexit 0\r\n')
    await writeFile(join(fixture.wc, 'o.txt'), 'foreign commit\n')
    await fixture.run(fixture.wc, ['add', 'o.txt'])
    let foreign: Promise<{ code: number | null }> | null = null
    const locked = async () => (await fixture.svn.run(fixture.wc, ['status', '--xml', '--depth', 'empty'])).stdout.includes('wc-locked="true"')
    const racing: CommandRunner = { run: async (cwd, args, options) => {
      if (args[0] === 'resolve' && foreign === null) {
        foreign = fixture.svn.run(fixture.wc, ['commit', '--file', fixture.message, '--', 'o.txt'])
        for (let attempt = 0; attempt < 100 && !await locked(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100))
        expect(await locked()).toBe(true)
      }
      return fixture.svn.run(cwd, args, options)
    } }
    const text = new SvnTextResolution(racing), savedDir = join(fixture.root, 'saved')
    await text.choose(input(fixture.wc, savedDir, 'a.txt', 'take-incoming'), 'theirs')
    expect((await text.resolve(fixture.wc, 'a.txt')).ok).toBe(false)
    expect(JSON.parse(await readFile(join(fixture.wc, '.svn', 'jamat-text-resolution.json'), 'utf8'))).toEqual({ version: 1, database: null })
    const resolutions = new SvnConflictResolutions({ svn: fixture.svn, markersIn: async () => [], now: Date.now })
    expect(await resolutions.recoverLocked(fixture.wc, savedDir)).toMatchObject({ ok: false, code: 'locked' })
    expect(await locked()).toBe(true)
    expect((await foreign!).code).toBe(0)
  }, 150_000)
})
