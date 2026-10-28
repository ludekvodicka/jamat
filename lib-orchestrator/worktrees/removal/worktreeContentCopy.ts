import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, open, chmod, statfs } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import { CommandInvoker } from '../../shared/commandInvoker'
import { ErrnoCode } from '../../shared/errnoCode'
import { PathCompare } from '../../shared/pathCompare'
import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import type { SvnRemovalRow } from '../../svn/svn.types'
import type { WorktreeRemovalPermit } from './worktreeRemovalPermit'

interface CopiedEntry {
  path: string
  bucket: 'ignored' | 'discarded'
  bytes: number
  hash: string | null
  link?: string
  linkType?: 'symbolic-link'
}

export interface WorktreeContentCopied {
  attempt: string
  rows: readonly SvnRemovalRow[]
  entries: CopiedEntry[]
  ignored: number
  discarded: number
  bundle: boolean
  links: number
  remainder: boolean
  source?: CopiedEntry[]
  omitted?: string[]
}

export class WorktreeContentCopy {
  static waste(path: string): boolean {
    return path.split(/[\\/]/).some((part) => ['node_modules', '.next', '.next-build', '.turbo', '.vite', '.cache'].includes(part))
  }

  async copy(root: string, rows: readonly SvnRemovalRow[], permit: WorktreeRemovalPermit, destination: string, remainder = false, identity = root): Promise<WorktreeContentCopied> {
    const receipt = join(destination, 'copy-manifests', `${createHash('sha256').update(identity).digest('hex')}.json`)
    const previous: WorktreeContentCopied | null = await readFile(receipt, 'utf8').then((value) => JSON.parse(value)).catch((error: unknown) => {
      if (ErrnoCode.of(error) === 'ENOENT') return null
      throw error
    })
    if (previous !== null) WorktreeContentCopy.validateReceipt(previous)
    if (remainder && previous?.source === undefined)
      throw new Error(`${root} was moved aside by an earlier removal and has no verified preservation receipt, so it is not copied or deleted automatically. Copy what you need from it, delete it, then press Try again.`)
    if (remainder && previous?.source !== undefined) {
      const current = await this.inventory(root, [{ path: '.', ignored: false, kind: 'item', conflict: false }],
        { kind: 'discard', by: 'person', at: 0 }, true, previous.omitted)
      const known = new Map(previous.source.map((entry) => [entry.path, entry]))
      const changed = current.filter((entry) => JSON.stringify(known.get(entry.path)) !== JSON.stringify(entry))
        .map((entry) => `${entry.path} (${known.has(entry.path) ? 'changed' : 'new'})`)
      if (changed.length > 0)
        throw new Error(`The partially removed worktree ${root} changed since its saved copy: ${WorktreeContentCopy.listOf(changed)}. `
          + 'Jamat deletes only files its saved copy holds. Move that content out of the worktree or restore it, then press Try again.')
      await this.verifyDestination(destination, previous)
      return { ...previous, remainder: true, source: current }
    }
    const saved = new Set<string>()
    for (const bucket of ['ignored', 'discarded'])
      for (const name of await readdir(join(destination, bucket)).catch((error: unknown) => { if (ErrnoCode.of(error) === 'ENOENT') return []; throw error }))
        if (/^[a-f0-9-]{36}$/.test(name)) saved.add(name)
    // Sizes first: a full disk refuses before the whole worktree is hashed again on every retry.
    await WorktreeContentCopy.ensureSpace(destination, await this.inventory(root, rows, permit, remainder, [], false), [...saved])
    const entries = await this.inventory(root, rows, permit, remainder)
    if (!remainder && previous !== null && JSON.stringify(previous.entries) === JSON.stringify(entries)) {
      await this.verifyDestination(destination, previous)
      const source = await this.inventory(root, [{ path: '.', ignored: false, kind: 'item', conflict: false }],
        { kind: 'discard', by: 'person', at: 0 }, true, previous.omitted)
      const current = { ...previous, rows, remainder, source }
      await AtomicJsonFile.writeAsync(receipt, current)
      return current
    }
    const digest = createHash('sha256').update(JSON.stringify([identity, entries])).digest('hex')
    const attempt = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
    await WorktreeContentCopy.ensureSpace(destination, entries, [attempt])
    for (const entry of entries) {
      const target = join(destination, entry.bucket, attempt, entry.path)
      if (entry.link !== undefined) await mkdir(join(destination, entry.bucket, attempt), { recursive: true })
      else if (entry.hash === null) await mkdir(target, { recursive: true })
      else {
        await mkdir(dirname(target), { recursive: true })
        const exists = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
        if (exists === null) {
          const temporary = join(destination, 'copy-manifests', `${attempt}.copying`)
          await mkdir(dirname(temporary), { recursive: true })
          try {
            await copyFile(join(root, entry.path), temporary)
            if (await WorktreeContentCopy.hashOf(temporary) !== entry.hash) throw new Error(`changed while copying: ${entry.path}`)
            await rename(temporary, target)
          } finally { await rm(temporary, { force: true }) }
        }
        if (await WorktreeContentCopy.hashOf(target) !== entry.hash)
          throw new Error(`The saved copy changed: ${target}. Jamat never overwrites a saved copy: put its bytes back, or delete that file so the copy takes it again.`)
        const mode = (await lstat(target)).mode
        await chmod(target, mode | 0o200)
        const file = await open(target, 'r+')
        try { await file.sync() } finally { await file.close(); await chmod(target, mode) }
      }
    }
    const links = entries.filter((entry) => entry.link !== undefined)
    if (links.length > 0) {
      await mkdir(join(destination, 'copy-manifests'), { recursive: true })
      await AtomicJsonFile.writeAsync(join(destination, 'copy-manifests', `${attempt}.json`), { links })
    }
    let bundle = false
    const store = join(root, '.checkpoints', 'store.git')
    if (permit.kind === 'discard' && entries.some((entry) => entry.path.replace(/\\/g, '/').startsWith('.checkpoints/store.git/'))) {
      const target = join(destination, 'discarded', attempt, 'store.bundle')
      // A git killed mid-bundle leaves its lock; a unique name keeps that lock from blocking every retry.
      const temporary = join(destination, 'copy-manifests', `${attempt}.${randomUUID().slice(0, 8)}.bundle`)
      await mkdir(dirname(target), { recursive: true })
      await mkdir(dirname(temporary), { recursive: true })
      try {
        // The result directory of the default profile already lies past 260 characters (UA1-J11-2).
        const result = await new CommandInvoker().run({ command: 'git', args: ['-c', 'core.longpaths=true', '--git-dir', store, 'bundle', 'create', temporary, '--all'], cwd: root, env: process.env })
        if (result.failure !== null || result.code !== 0) throw new Error(`checkpoint bundle failed: ${result.stderr || result.stdout || result.failure}`)
        await rename(temporary, target)
      } finally { for (const path of [temporary, `${temporary}.lock`]) await rm(path, { force: true }) }
      bundle = true
    }
    const omitted = rows.filter((row) => (row.ignored || row.unversioned) && WorktreeContentCopy.waste(row.path)).map((row) => relative(root, resolve(root, row.path)))
    const source = await this.inventory(root, [{ path: '.', ignored: false, kind: 'item', conflict: false }],
      { kind: 'discard', by: 'person', at: 0 }, true, omitted)
    const copied = { attempt, rows, entries, source, omitted, links: links.length, remainder, ignored: entries.filter((entry) => entry.bucket === 'ignored' && entry.hash !== null && entry.link === undefined).length,
      discarded: entries.filter((entry) => entry.bucket === 'discarded' && entry.hash !== null && entry.link === undefined).length, bundle }
    await mkdir(dirname(receipt), { recursive: true })
    await AtomicJsonFile.writeAsync(receipt, copied)
    return copied
  }

  async verify(root: string, copied: WorktreeContentCopied, permit: WorktreeRemovalPermit): Promise<void> {
    if (copied.remainder && copied.source !== undefined) {
      const current = await this.inventory(root, [{ path: '.', ignored: false, kind: 'item', conflict: false }],
        { kind: 'discard', by: 'person', at: 0 }, true, copied.omitted)
      if (JSON.stringify(current) !== JSON.stringify(copied.source)) throw new Error('changed after the copy: removal remainder')
      return
    }
    const current = await this.inventory(root, copied.rows, permit, copied.remainder)
    if (JSON.stringify(current) !== JSON.stringify(copied.entries)) throw new Error('changed after the copy: preserved worktree content')
  }

  private async verifyDestination(destination: string, copied: WorktreeContentCopied): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(copied.attempt)) throw new Error('Invalid preservation receipt')
    for (const entry of copied.entries) {
      const target = resolve(destination, entry.bucket, copied.attempt, entry.path)
      if (!PathCompare.isInside(destination, target)) throw new Error('Invalid preservation path')
      if (entry.hash === null && !(await lstat(target)).isDirectory()) throw new Error(`The saved directory changed: ${entry.path}`)
      if (entry.hash !== null && entry.link === undefined && await WorktreeContentCopy.hashOf(target) !== entry.hash)
        throw new Error(`The saved copy changed: ${target}. Jamat never overwrites a saved copy: put its bytes back.`)
    }
    const links = copied.entries.filter((entry) => entry.link !== undefined)
    if (links.length > 0) {
      const saved = JSON.parse(await readFile(join(destination, 'copy-manifests', `${copied.attempt}.json`), 'utf8'))
      if (JSON.stringify(saved.links) !== JSON.stringify(links)) throw new Error('The saved link descriptions changed')
    }
  }

  /** At most five paths, then how many more, so a refusal stays one readable line. */
  private static listOf(paths: readonly string[]): string {
    return paths.length <= 5 ? paths.join(', ') : `${paths.slice(0, 5).join(', ')} and ${paths.length - 5} more`
  }

  private static validateReceipt(value: WorktreeContentCopied): void {
    const safePath = (path: unknown): path is string => typeof path === 'string' && !/^[\\/]|[:\0\r\n]/.test(path)
      && !path.split(/[\\/]/).includes('..')
    const entries = (rows: unknown): boolean => Array.isArray(rows) && rows.every((entry) => entry !== null && typeof entry === 'object'
      && safePath(entry.path) && ['ignored', 'discarded'].includes(entry.bucket) && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0
      && (entry.hash === null || typeof entry.hash === 'string') && (entry.link === undefined || typeof entry.link === 'string'))
    if (value === null || typeof value !== 'object' || !/^[a-f0-9-]{36}$/.test(value.attempt)
      || !entries(value.entries) || value.source !== undefined && !entries(value.source)
      || value.omitted !== undefined && (!Array.isArray(value.omitted) || value.omitted.some((path) => !safePath(path) || !WorktreeContentCopy.waste(path))))
      throw new Error('Invalid preservation receipt; retain the worktree for inspection')
  }

  /** Only files missing from every attempt in `saved` need room, so a resumed copy asks for the rest. */
  private static async ensureSpace(destination: string, entries: readonly CopiedEntry[], saved: readonly string[]): Promise<void> {
    let needed = 0n
    for (const entry of entries) {
      if (entry.hash === null || entry.link !== undefined) continue
      let present = false
      for (const attempt of saved)
        present ||= await lstat(join(destination, entry.bucket, attempt, entry.path)).then(() => true, (error: unknown) => {
          if (ErrnoCode.of(error) === 'ENOENT' || ErrnoCode.of(error) === 'ENOTDIR') return false
          throw error
        })
      if (!present) needed += BigInt(entry.bytes)
    }
    if (needed === 0n) return
    await mkdir(destination, { recursive: true })
    const space = await statfs(destination, { bigint: true })
    const reserve = 256n * 1024n * 1024n
    if (space.bavail * space.bsize < needed * 2n + reserve)
      throw new Error(`Not enough free space to preserve this worktree at ${destination}: need ${needed * 2n + reserve} bytes including reserve, available ${space.bavail * space.bsize}. Free space or move the preserved results before retrying; the worktree is retained.`)
  }

  private async inventory(root: string, rows: readonly SvnRemovalRow[], permit: WorktreeRemovalPermit, remainder: boolean, omitted: readonly string[] = [], hashed = true): Promise<CopiedEntry[]> {
    const entries = new Map<string, CopiedEntry>()
    const visit = async (path: string, bucket: CopiedEntry['bucket'], wasteAllowed: boolean): Promise<void> => {
      if (omitted.some((skip) => PathCompare.isInside(resolve(root, skip), resolve(root, path)))) return
      if (wasteAllowed && WorktreeContentCopy.waste(path) || path.split(/[\\/]/).includes('.svn')) return
      const absolute = resolve(root, path)
      if (!PathCompare.isInside(root, absolute)) throw new Error(`copy path leaves the worktree: ${path}`)
      const info = await lstat(absolute).catch((error: unknown) => {
        if (ErrnoCode.of(error) === 'ENOENT') return null
        throw error
      })
      // A deletion has no working bytes; its SVN evidence and logs remain with the result.
      if (info === null) return
      if (info.isSymbolicLink()) {
        const link = await readlink(absolute)
        entries.set(`${bucket}/${path}`, { path, bucket, bytes: Buffer.byteLength(link), hash: `link:${link}`, link, linkType: 'symbolic-link' })
        return
      }
      if (!PathCompare.isInside(await realpath(root), await realpath(absolute))) throw new Error(`copy target leaves the worktree: ${path}`)
      const key = `${bucket}/${path}`
      if (entries.has(key)) return
      if (info.isDirectory()) {
        entries.set(key, { path, bucket, bytes: 0, hash: null })
        for (const name of (await readdir(absolute)).sort()) await visit(join(path, name), bucket, wasteAllowed)
      }
      else if (info.isFile()) {
        entries.set(key, { path, bucket, bytes: info.size, hash: hashed ? await WorktreeContentCopy.hashOf(absolute) : '' })
      }
      else throw new Error(`removal-blocked: unsupported file kind: ${path}`)
    }
    for (const row of rows) {
      let bucket: CopiedEntry['bucket'] | null
      if (remainder) bucket = 'discarded'
      else if (row.ignored) bucket = 'ignored'
      else if (permit.kind === 'discard') bucket = row.conflict || row.kind !== 'clean' && row.kind !== 'external' ? 'discarded' : null
      else if (permit.kind === 'clean') bucket = null
      else throw new Error(`Unknown removal permit: ${JSON.stringify(permit satisfies never)}`)
      if (bucket === null) continue
      const path = relative(root, resolve(root, row.path))
      // Check every parent too: svn can name a child beneath a junction directly.
      let parent = root
      for (const segment of path.split(/[\\/]/).filter(Boolean).slice(0, -1)) {
        parent = join(parent, segment)
        const info = await lstat(parent).catch((error: unknown) => {
          if (ErrnoCode.of(error) === 'ENOENT') return null
          throw error
        })
        if (info?.isSymbolicLink()) throw new Error(`removal-blocked: preserve the link before removal: ${parent}`)
      }
      await visit(path, bucket, !remainder && (row.ignored || row.unversioned === true))
    }
    return [...entries.values()].sort((a, b) => `${a.bucket}/${a.path}`.localeCompare(`${b.bucket}/${b.path}`))
  }

  private static async hashOf(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
  }
}
