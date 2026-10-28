import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as files from 'node:fs/promises'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SvnRemovalRow } from '../../svn/svn.types'
import { WorktreeContentCopy } from './worktreeContentCopy'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, statfs: vi.fn(actual.statfs), copyFile: vi.fn(actual.copyFile) }
})

describe('WorktreeContentCopy', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
  const clean = { kind: 'clean' as const, provedAt: 1, allowed: [] }
  const discard = { kind: 'discard' as const, by: 'person' as const, at: 1 }
  const row = (path: string, ignored = false): SvnRemovalRow => ({ path, ignored, kind: 'item', conflict: false })
  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-worktree-copy-'))
    roots.push(directory)
    const root = join(directory, 'worktree')
    const destination = join(directory, 'result')
    mkdirSync(root)
    const write = (path: string, content: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    return { root, destination, write, copies: new WorktreeContentCopy() }
  }

  it('refuses before copying when the result disk cannot hold the content and reserve', async () => {
    const h = fixture()
    h.write('note', 'preserve me')
    const space = await files.statfs(h.root, { bigint: true })
    vi.mocked(files.statfs).mockResolvedValueOnce({ ...space, bavail: 0n })
    await expect(h.copies.copy(h.root, [row('note', true)], clean, h.destination)).rejects.toThrow('Not enough free space')
    expect(existsSync(join(h.destination, 'ignored'))).toBe(false)
    expect(readFileSync(join(h.root, 'note'), 'utf8')).toBe('preserve me')
  })

  it('retries interrupted copies without another directory or overwriting preserved bytes', async () => {
    const h = fixture()
    h.write('a.txt', 'first file')
    h.write('b.txt', 'second file')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(files.copyFile).mockImplementationOnce(actual.copyFile).mockRejectedValueOnce(new Error('ENOSPC'))
    await expect(h.copies.copy(h.root, [row('.')], discard, h.destination)).rejects.toThrow('ENOSPC')
    const attempts = await files.readdir(join(h.destination, 'discarded'))
    expect(attempts).toHaveLength(1)
    const copied = await h.copies.copy(h.root, [row('.')], discard, h.destination)
    expect(copied.attempt).toBe(attempts[0])
    expect(await files.readdir(join(h.destination, 'discarded'))).toEqual(attempts)
    expect(readFileSync(join(h.destination, 'discarded', copied.attempt, 'a.txt'), 'utf8')).toBe('first file')
    expect(readFileSync(join(h.destination, 'discarded', copied.attempt, 'b.txt'), 'utf8')).toBe('second file')
  })

  it('checks the free space before it hashes the content', async () => {
    const h = fixture()
    h.write('note', 'preserve me')
    const space = await files.statfs(h.root, { bigint: true })
    vi.mocked(files.statfs).mockResolvedValueOnce({ ...space, bavail: 0n })
    const hashOf = vi.spyOn(WorktreeContentCopy as unknown as { hashOf: (path: string) => Promise<string> }, 'hashOf')
    try {
      await expect(h.copies.copy(h.root, [row('note', true)], clean, h.destination)).rejects.toThrow('Not enough free space')
      expect(hashOf).not.toHaveBeenCalled()
    } finally { hashOf.mockRestore() }
  })

  it('asks for room only for the files a resumed copy has not saved yet', async () => {
    const h = fixture()
    h.write('a.txt', 'a'.repeat(1024 * 1024))
    h.write('b.txt', 'second file')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(files.copyFile).mockImplementationOnce(actual.copyFile).mockRejectedValueOnce(new Error('ENOSPC'))
    await expect(h.copies.copy(h.root, [row('.')], discard, h.destination)).rejects.toThrow('ENOSPC')
    const space = await actual.statfs(h.root, { bigint: true })
    const rest = 2n * BigInt('second file'.length) + 256n * 1024n * 1024n
    vi.mocked(files.statfs).mockImplementation(async () => ({ ...space, bavail: (rest + space.bsize - 1n) / space.bsize }) as never)
    try {
      expect((await h.copies.copy(h.root, [row('.')], discard, h.destination)).discarded).toBe(2)
    } finally { vi.mocked(files.statfs).mockImplementation(actual.statfs as never) }
  })

  it('copies ignored checkpoints and temp logs but omits ignored build waste', async () => {
    const h = fixture()
    h.write('.checkpoints/store.git/HEAD', 'ref: refs/heads/main')
    h.write('.aidocs/temp/log.txt', 'diagnostics')
    h.write('node_modules/x', 'generated')
    const copied = await h.copies.copy(h.root, [row('.checkpoints', true), row('.aidocs/temp', true), row('node_modules', true)], clean, h.destination)
    expect(copied.ignored).toBe(2)
    expect(readFileSync(join(h.destination, 'ignored', copied.attempt, '.checkpoints/store.git/HEAD'), 'utf8')).toBe('ref: refs/heads/main')
    expect(readFileSync(join(h.destination, 'ignored', copied.attempt, '.aidocs/temp/log.txt'), 'utf8')).toBe('diagnostics')
    expect(existsSync(join(h.destination, 'ignored/node_modules'))).toBe(false)
    await h.copies.verify(h.root, copied, clean)
    h.write('.aidocs/temp/late.txt', 'late')
    await expect(h.copies.verify(h.root, copied, clean)).rejects.toThrow('changed after the copy')
  })

  it('preserves more than 500 MB instead of permanently blocking cleanup', async () => {
    const h = fixture()
    h.write('large', '')
    truncateSync(join(h.root, 'large'), 600 * 1024 * 1024)
    const copy = await h.copies.copy(h.root, [row('large', true)], clean, h.destination)
    expect(copy.ignored).toBe(1)
    expect((await h.copies.copy(h.root, [row('large', true)], clean, h.destination)).attempt).toBe(copy.attempt)
  }, 120_000)

  it('reuses a verified copy after partial removal, excluding known ignored dependencies', async () => {
    const h = fixture()
    h.write('note', 'keep me')
    h.write('clean', 'repository bytes')
    h.write('node_modules/cache', 'generated')
    const copied = await h.copies.copy(h.root, [row('note', true), row('node_modules', true)], clean, h.destination, false, 'directory-identity')
    rmSync(join(h.root, 'clean'))
    const retried = await h.copies.copy(h.root, [row('.')], discard, h.destination, true, 'directory-identity')
    expect(retried.attempt).toBe(copied.attempt)
    expect(retried.entries.some((entry) => entry.path.includes('node_modules'))).toBe(false)
    h.write('late', 'new local bytes')
    await expect(h.copies.copy(h.root, [row('.')], discard, h.destination, true, 'directory-identity')).rejects.toThrow('partially removed worktree')
  })

  it('names the new and the changed files of a partly deleted worktree and where it lies (UA1-J11-4, CL10)', async () => {
    const h = fixture()
    h.write('note', 'keep me')
    h.write('README.md', 'readme')
    await h.copies.copy(h.root, [row('note', true)], clean, h.destination, false, 'directory-identity')
    h.write('src/new-work.txt', 'new work')
    h.write('README.md', 'readme with a late line')
    const refused = await h.copies.copy(h.root, [row('.')], discard, h.destination, true, 'directory-identity').catch((error: Error) => error.message)
    expect(refused).toContain(`The partially removed worktree ${h.root} changed since its saved copy`)
    expect(refused).toContain(`${join('src', 'new-work.txt')} (new)`)
    expect(refused).toContain('README.md (changed)')
    expect(refused).toContain('Move that content out of the worktree or restore it')
    expect(readFileSync(join(h.root, 'src/new-work.txt'), 'utf8')).toBe('new work')
  })

  it('refuses removal when the retained backup was changed between attempts', async () => {
    const h = fixture()
    h.write('note', 'keep me')
    const copied = await h.copies.copy(h.root, [row('note', true)], clean, h.destination)
    const saved = join(h.destination, 'ignored', copied.attempt, 'note')
    writeFileSync(saved, 'damaged backup')
    await expect(h.copies.copy(h.root, [row('note', true)], clean, h.destination)).rejects.toThrow(`saved copy changed: ${saved}. Jamat never overwrites a saved copy`)
  })

  it('names the changed saved file and the way out when a resumed copy meets it (UA1-J11-4, CL08)', async () => {
    const h = fixture()
    h.write('a.txt', 'first file')
    h.write('b.txt', 'second file')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(files.copyFile).mockImplementationOnce(actual.copyFile).mockRejectedValueOnce(new Error('EPERM'))
    await expect(h.copies.copy(h.root, [row('.')], discard, h.destination)).rejects.toThrow('EPERM')
    const [attempt] = await files.readdir(join(h.destination, 'discarded'))
    const saved = join(h.destination, 'discarded', attempt, 'a.txt')
    writeFileSync(saved, 'tampered')
    const refused = await h.copies.copy(h.root, [row('.')], discard, h.destination).catch((error: Error) => error.message)
    expect(refused).toContain(`saved copy changed: ${saved}. Jamat never overwrites a saved copy`)
    expect(refused).toContain('delete that file so the copy takes it again')
    expect(readFileSync(saved, 'utf8')).toBe('tampered')
  })

  it('keeps each copy attempt immutable when removal is retried', async () => {
    const h = fixture()
    h.write('note', 'first')
    const first = await h.copies.copy(h.root, [row('note', true)], clean, h.destination)
    h.write('note', 'second')
    const second = await h.copies.copy(h.root, [row('note', true)], clean, h.destination)
    expect(readFileSync(join(h.destination, 'ignored', first.attempt, 'note'), 'utf8')).toBe('first')
    expect(readFileSync(join(h.destination, 'ignored', second.attempt, 'note'), 'utf8')).toBe('second')
  })

  it('preserves all working files and sidecars of 22 conflicts on discard', async () => {
    const h = fixture()
    const rows: SvnRemovalRow[] = []
    for (let index = 0; index < 22; index += 1)
      for (const suffix of ['', '.mine', '.r1', '.r2']) {
        const path = `file-${index}${suffix}`
        h.write(path, `content ${path}`)
        rows.push({ ...row(path), conflict: suffix === '' })
      }
    const copied = await h.copies.copy(h.root, rows, discard, h.destination)
    expect(copied.discarded).toBe(88)
    for (const entry of rows) expect(readFileSync(join(h.destination, 'discarded', copied.attempt, entry.path), 'utf8')).toBe(`content ${entry.path}`)
  })

  it('preserves a versioned dirty file even under a waste-named directory', async () => {
    const h = fixture()
    h.write('node_modules/tracked', 'handwritten')
    const copied = await h.copies.copy(h.root, [row('node_modules/tracked')], discard, h.destination)
    expect(copied.discarded).toBe(1)
    expect(readFileSync(join(h.destination, 'discarded', copied.attempt, 'node_modules/tracked'), 'utf8')).toBe('handwritten')
  })

  it('preserves an ignored junction description but refuses a child beneath it', async () => {
    const h = fixture()
    const outside = join(dirname(h.root), 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'private'), 'outside')
    symlinkSync(outside, join(h.root, 'link'), 'junction')
    const copied = await h.copies.copy(h.root, [row('link', true)], clean, h.destination)
    expect(copied.links).toBe(1)
    expect(copied.ignored).toBe(0)
    const manifest = JSON.parse(readFileSync(join(h.destination, 'copy-manifests', `${copied.attempt}.json`), 'utf8'))
    expect(manifest.links).toEqual([expect.objectContaining({ path: 'link', linkType: 'symbolic-link', link: expect.stringContaining('outside') })])
    expect(existsSync(join(h.destination, 'ignored', copied.attempt, 'link/private'))).toBe(false)
    await expect(h.copies.copy(h.root, [row('link/private', true)], clean, h.destination)).rejects.toThrow('preserve the link')
  })

  function checkpointStore(root: string) {
    const store = join(root, '.checkpoints', 'store.git')
    execFileSync('git', ['init', '--bare', store], { windowsHide: true, stdio: 'pipe' })
    const git = (args: string[], input?: string): string => execFileSync('git', ['--git-dir', store, ...args], {
      windowsHide: true, encoding: 'utf8', input, env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@local',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@local' },
    }).trim()
    const tree = git(['mktree'], '')
    const commit = git(['commit-tree', tree, '-m', 'Checkpoint fixture'])
    git(['update-ref', 'refs/heads/main', commit])
    return { git, commit }
  }

  it('writes a checkpoint bundle as well as the ignored store on discard', async () => {
    const h = fixture()
    const { git, commit } = checkpointStore(h.root)
    const copied = await h.copies.copy(h.root, [row('.checkpoints', true)], discard, h.destination)
    expect(copied.bundle).toBe(true)
    expect(git(['bundle', 'list-heads', join(h.destination, 'discarded', copied.attempt, 'store.bundle')])).toContain(commit)
  })

  it('writes the checkpoint bundle below a result directory deeper than 260 characters (UA1-J11-2)', async () => {
    const h = fixture()
    const { git, commit } = checkpointStore(h.root)
    // The default development profile puts the bundle lock 262 characters deep, the lab profile 275.
    const destination = join(dirname(h.destination), 'r'.repeat(100), 's'.repeat(100), 'c1b09905-d36f-4b26-be2c-85bac03bbd82')
    expect(join(destination, 'copy-manifests', `${'0'.repeat(36)}.bundle.lock`).length).toBeGreaterThan(260)
    const copied = await h.copies.copy(h.root, [row('.checkpoints', true)], discard, destination)
    expect(copied.bundle).toBe(true)
    expect(git(['-c', 'core.longpaths=true', 'bundle', 'list-heads', join(destination, 'discarded', copied.attempt, 'store.bundle')])).toContain(commit)
  })

  it('writes the checkpoint bundle again when a killed git left its lock in the same copy directory', async () => {
    const h = fixture()
    const { git, commit } = checkpointStore(h.root)
    const first = await h.copies.copy(h.root, [row('.checkpoints', true)], discard, h.destination)
    const bundle = join(h.destination, 'discarded', first.attempt, 'store.bundle')
    for (const name of await files.readdir(join(h.destination, 'copy-manifests'))) rmSync(join(h.destination, 'copy-manifests', name))
    rmSync(bundle)
    writeFileSync(`${bundle}.lock`, '')
    const retried = await h.copies.copy(h.root, [row('.checkpoints', true)], discard, h.destination)
    expect(retried.attempt).toBe(first.attempt)
    expect(git(['bundle', 'list-heads', bundle])).toContain(commit)
    expect(await files.readdir(join(h.destination, 'copy-manifests'))).toHaveLength(1)
  })
})
