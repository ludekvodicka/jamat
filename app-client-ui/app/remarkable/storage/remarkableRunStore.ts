import { randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { RemarkableResult } from '../../../shared/remarkableApi.types'

export interface RemarkableRun {
  id: string
  directory: string
}

export interface RemarkableAttempt {
  id: string
  run: RemarkableRun
  directory: string
  backupDirectory: string
  outputPath: string
}

export interface RemarkableRunStoreOptions {
  runsDirectory: string
  importsDirectory: string
  now?: () => number
  id?: () => string
  move?: (source: string, target: string) => Promise<void>
}

export class RemarkableRunStore {
  static readonly retentionMillisecondsConst = 30 * 24 * 60 * 60 * 1_000
  static readonly retainedEntriesMaxConst = 64

  private readonly runsDirectory: string
  private readonly importsDirectory: string
  private readonly scopeDirectory: string
  private readonly now: () => number
  private readonly id: () => string
  private readonly move: (source: string, target: string) => Promise<void>
  private readonly activeRuns = new Set<string>()

  constructor(options: RemarkableRunStoreOptions) {
    if (!isAbsolute(options.runsDirectory) || !isAbsolute(options.importsDirectory))
      throw new Error('The reMarkable run and import roots must be absolute')
    this.runsDirectory = resolve(options.runsDirectory)
    this.importsDirectory = resolve(options.importsDirectory)
    if (dirname(this.runsDirectory) !== dirname(this.importsDirectory)
      || this.runsDirectory === this.importsDirectory)
      throw new Error('The reMarkable run and import roots must share one profile directory')
    this.scopeDirectory = dirname(this.runsDirectory)
    this.now = options.now ?? Date.now
    this.id = options.id ?? randomUUID
    this.move = options.move ?? rename
  }

  async createRun(): Promise<RemarkableRun> {
    const threshold = this.now() - RemarkableRunStore.retentionMillisecondsConst
    await this.cleanupRoot(
      this.runsDirectory,
      threshold,
      RemarkableRunStore.retainedEntriesMaxConst - 1,
    )
    await this.cleanupRoot(this.importsDirectory, threshold)
    await this.requireRoot(this.runsDirectory, true)
    const id = this.nextId()
    const directory = join(this.runsDirectory, id)
    await mkdir(directory)
    this.activeRuns.add(directory)
    return { id, directory }
  }

  async createAttempt(run: RemarkableRun): Promise<RemarkableAttempt> {
    await this.requireRun(run)
    const id = this.nextId()
    const directory = join(run.directory, id)
    await mkdir(directory)
    return {
      id,
      run,
      directory,
      backupDirectory: directory,
      outputPath: join(directory, 'page.png'),
    }
  }

  /**
   * The same verification promoteOutput does, minus the move: a preview is read and drawn, never
   * imported, so its file stays in the attempt and dies with the run.
   */
  async readOutput(
    attempt: RemarkableAttempt,
    outputPath: string,
    outputBytes: number,
    maximumBytes: number,
  ): Promise<RemarkableResult<Buffer>> {
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || outputBytes > maximumBytes)
        return RemarkableRunStore.invalidOutput()
      handle = await this.openOutput(attempt, outputPath, outputBytes)
      if (handle === null) return RemarkableRunStore.invalidOutput()
      const bytes = await handle.readFile()
      if (bytes.byteLength !== outputBytes) return RemarkableRunStore.invalidOutput()
      return { ok: true, value: bytes }
    } catch {
      return RemarkableRunStore.invalidOutput()
    } finally {
      if (handle !== null) await handle.close().catch(() => undefined)
    }
  }

  async promoteOutput(
    attempt: RemarkableAttempt,
    outputPath: string,
    outputBytes: number,
  ): Promise<RemarkableResult<string>> {
    let handle: Awaited<ReturnType<typeof open>> | null = null
    let imported: string | null = null
    let moved = false
    let accepted = false
    try {
      handle = await this.openOutput(attempt, outputPath, outputBytes)
      if (handle === null) return RemarkableRunStore.invalidOutput()
      const opened = await handle.stat({ bigint: true })
      await this.cleanupRoot(
        this.importsDirectory,
        this.now() - RemarkableRunStore.retentionMillisecondsConst,
        RemarkableRunStore.retainedEntriesMaxConst - 1,
      )
      await this.requireRoot(this.importsDirectory, true)
      const resolvedImports = await realpath(this.importsDirectory)
      imported = join(this.importsDirectory, `${this.nextId()}.png`)
      await this.move(outputPath, imported)
      moved = true
      const confirmed = await lstat(imported, { bigint: true })
      const held = await handle.stat({ bigint: true })
      const resolvedImported = await realpath(imported)
      if (!confirmed.isFile()
        || confirmed.isSymbolicLink()
        || confirmed.size !== BigInt(outputBytes)
        || !RemarkableRunStore.sameFile(opened, held)
        || !RemarkableRunStore.sameFile(held, confirmed)
        || !RemarkableRunStore.contained(resolvedImports, resolvedImported))
        return RemarkableRunStore.invalidOutput()
      accepted = true
      return { ok: true, value: imported }
    } catch {
      return RemarkableRunStore.invalidOutput()
    } finally {
      if (handle !== null) await handle.close().catch(() => undefined)
      if (moved && !accepted && imported !== null) await this.discardImported(imported)
    }
  }

  /**
   * Opens the one path this attempt is allowed to produce, or nothing. The handle is the caller's
   * to close, and it is what proves later that the file it read is the file it opened.
   */
  private async openOutput(
    attempt: RemarkableAttempt,
    outputPath: string,
    outputBytes: number,
  ): Promise<Awaited<ReturnType<typeof open>> | null> {
    await this.requireAttempt(attempt)
    if (resolve(outputPath) !== attempt.outputPath
      || extname(outputPath).toLowerCase() !== '.png'
      || !Number.isSafeInteger(outputBytes)
      || outputBytes <= 0)
      return null
    const handle = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat({ bigint: true })
      const linkInfo = await lstat(outputPath, { bigint: true })
      const resolvedOutput = await realpath(outputPath)
      const resolvedAttempt = await realpath(attempt.directory)
      if (!linkInfo.isFile()
        || linkInfo.isSymbolicLink()
        || linkInfo.size !== BigInt(outputBytes)
        || !RemarkableRunStore.sameFile(opened, linkInfo)
        || !RemarkableRunStore.contained(resolvedAttempt, resolvedOutput)) {
        await handle.close().catch(() => undefined)
        return null
      }
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
    return handle
  }

  /**
   * Drops an import this store promoted, for the one caller that copied it somewhere else. It is
   * the private discard with a name: the guard that refuses any path outside the imports root is
   * what makes it safe to expose at all.
   */
  async forgetImport(path: string): Promise<void> {
    await this.discardImported(resolve(path))
  }

  async release(run: RemarkableRun): Promise<void> {
    try {
      await this.requireRun(run)
      await rm(run.directory, { recursive: true, force: true })
    }
    finally { this.activeRuns.delete(run.directory) }
  }

  async cleanup(): Promise<void> {
    const threshold = this.now() - RemarkableRunStore.retentionMillisecondsConst
    await this.cleanupRoot(this.runsDirectory, threshold)
    await this.cleanupRoot(this.importsDirectory, threshold)
  }

  private async cleanupRoot(
    root: string,
    threshold: number,
    maximum = RemarkableRunStore.retainedEntriesMaxConst,
  ): Promise<void> {
    if (!await this.requireRoot(root, false)) return
    const entries = await readdir(root, { withFileTypes: true })
    const retained: { path: string; mtimeMs: number; directory: boolean }[] = []
    for (const entry of entries) {
      if (!this.expectedCleanupEntry(root, entry.name, entry.isDirectory(), entry.isFile())) continue
      const path = join(root, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()
        || root === this.runsDirectory && !info.isDirectory()
        || root === this.importsDirectory && !info.isFile()
        || !RemarkableRunStore.samePath(await realpath(path), path)) continue
      retained.push({ path, mtimeMs: Number(info.mtimeMs), directory: info.isDirectory() })
    }
    retained.sort((left, right) => left.mtimeMs - right.mtimeMs)
    let kept = retained.length
    for (const entry of retained) {
      if (this.activeRuns.has(entry.path)) continue
      if (entry.mtimeMs >= threshold && kept <= maximum) continue
      await rm(entry.path, { recursive: entry.directory, force: true })
      kept -= 1
    }
  }

  private async requireRoot(root: string, create: boolean): Promise<boolean> {
    if (root !== this.runsDirectory && root !== this.importsDirectory)
      throw new Error('The reMarkable storage root is unknown')
    let scopeInfo
    try {
      if (create) await mkdir(this.scopeDirectory, { recursive: true })
      scopeInfo = await lstat(this.scopeDirectory)
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (!scopeInfo.isDirectory()
      || scopeInfo.isSymbolicLink()
      || !RemarkableRunStore.samePath(await realpath(this.scopeDirectory), this.scopeDirectory))
      throw new Error('The reMarkable storage root is not a real profile directory')
    if (create) {
      try { await mkdir(root) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    let rootInfo
    try { rootInfo = await lstat(root) }
    catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (!rootInfo.isDirectory()
      || rootInfo.isSymbolicLink()
      || !RemarkableRunStore.samePath(await realpath(root), root)
      || dirname(root) !== this.scopeDirectory)
      throw new Error('The reMarkable storage root is not a real profile directory')
    return true
  }

  private expectedCleanupEntry(
    root: string,
    name: string,
    directory: boolean,
    file: boolean,
  ): boolean {
    if (root === this.runsDirectory) return directory && RemarkableRunStore.isSafeId(name)
    else if (root === this.importsDirectory)
      return file && name.endsWith('.png') && RemarkableRunStore.isSafeId(name.slice(0, -4))
    else throw new Error('The reMarkable storage root is unknown')
  }

  private async discardImported(path: string): Promise<void> {
    if (dirname(path) !== this.importsDirectory) return
    try {
      if (!await this.requireRoot(this.importsDirectory, false)) return
      await rm(path, { recursive: false, force: true })
    } catch { return }
  }

  private async requireRun(run: RemarkableRun): Promise<void> {
    this.validateRun(run)
    await this.requireRoot(this.runsDirectory, false)
    const info = await lstat(run.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The reMarkable run is invalid')
    if (await realpath(run.directory) !== run.directory) throw new Error('The reMarkable run path is invalid')
  }

  private async requireAttempt(attempt: RemarkableAttempt): Promise<void> {
    await this.requireRun(attempt.run)
    if (!RemarkableRunStore.isSafeId(attempt.id)
      || attempt.directory !== join(attempt.run.directory, attempt.id)
      || attempt.backupDirectory !== attempt.directory
      || attempt.outputPath !== join(attempt.directory, 'page.png'))
      throw new Error('The reMarkable attempt is invalid')
    const info = await lstat(attempt.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The reMarkable attempt is invalid')
    if (await realpath(attempt.directory) !== attempt.directory)
      throw new Error('The reMarkable attempt path is invalid')
  }

  private validateRun(run: RemarkableRun): void {
    if (!RemarkableRunStore.isSafeId(run.id)
      || run.directory !== join(this.runsDirectory, run.id))
      throw new Error('The reMarkable run is outside its store')
  }

  private nextId(): string {
    const id = this.id()
    if (!RemarkableRunStore.isSafeId(id)) throw new Error('The reMarkable ID generator returned an invalid ID')
    return id
  }

  private static isSafeId(value: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== '.' && value !== '..'
  }

  private static contained(root: string, child: string): boolean {
    const nested = relative(root, child)
    return nested.length > 0 && nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested)
  }

  private static sameFile(left: BigIntStats, right: BigIntStats): boolean {
    return left.dev === right.dev
      && left.ino === right.ino
      && left.birthtimeNs === right.birthtimeNs
      && left.size === right.size
  }

  private static samePath(left: string, right: string): boolean {
    return process.platform === 'win32'
      ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
      : resolve(left) === resolve(right)
  }

  private static invalidOutput(): RemarkableResult<never> {
    return {
      ok: false,
      code: 'invalid-cli-output',
      detail: 'The reMarkable CLI output file failed validation',
      retryable: false,
    }
  }
}
