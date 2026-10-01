import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { LocalPackageInputs } from './localPackageInputs.js'

export interface LocalClientPackageManifest {
  schemaVersion: 1
  inputHash: string
  executablePath: string
  builtAt: string
}

export class LocalClientPackage {
  private readonly repositoryRoot: string
  private readonly releasesRoot: string
  private readonly currentFile: string
  private readonly lockFile: string

  constructor(repositoryRoot: string) {
    this.repositoryRoot = resolve(repositoryRoot)
    this.releasesRoot = join(this.repositoryRoot, 'app-client-ui', 'dist', 'local-releases')
    this.currentFile = join(this.releasesRoot, 'current.json')
    this.lockFile = join(this.releasesRoot, 'build.lock')
  }

  async ensure(): Promise<LocalClientPackageManifest> {
    mkdirSync(this.releasesRoot, { recursive: true })
    const lock = await this.acquireLock()
    try {
      return await this.ensureLocked()
    } finally {
      closeSync(lock)
      rmSync(this.lockFile)
    }
  }

  private async ensureLocked(): Promise<LocalClientPackageManifest> {
    const inputs = LocalPackageInputs.read(this.repositoryRoot)
    const current = this.readCurrent()
    if (current !== null && current.inputHash === inputs.hash && this.isComplete(current)) {
      console.error(`[package-when-stale] up to date: ${current.executablePath}`)
      return current
    }
    const workingRoot = join(this.repositoryRoot, 'out')
    mkdirSync(workingRoot, { recursive: true })
    const release = mkdtempSync(join(this.releasesRoot, `${inputs.hash.slice(0, 16)}-`))
    // Windows' archive extractor still has MAX_PATH limits inside Node's nested npm tree.
    const snapshot = mkdtempSync(join(workingRoot, '.pkg-'))
    let published = false
    try {
      inputs.writeTo(snapshot)
      for (const directory of ['', 'app-client-ui', 'app-host', 'lib-orchestrator'])
        symlinkSync(join(this.repositoryRoot, directory, 'node_modules'),
          join(snapshot, directory, 'node_modules'), 'junction')
      // The existing builders resolve all generated paths from these copied scripts and packages.
      // Their dependency junctions are read only: no pnpm install or native rebuild runs through them.
      console.error(`[package-when-stale] packaging input ${inputs.hash}`)
      await this.packageSnapshot(snapshot, release)
      const manifest: LocalClientPackageManifest = {
        schemaVersion: 1,
        inputHash: inputs.hash,
        executablePath: join(release, 'win-unpacked', 'Jamat.exe'),
        builtAt: new Date().toISOString(),
      }
      if (!this.isComplete(manifest)) throw new Error('packaging did not produce a complete client, Host and launcher')
      if (LocalPackageInputs.read(this.repositoryRoot).hash !== inputs.hash)
        throw new Error('package inputs changed during the build; retry to build the current tree')
      writeFileSync(join(release, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      const next = join(this.releasesRoot, `current-${randomUUID()}.json`)
      try {
        writeFileSync(next, `${JSON.stringify(manifest, null, 2)}\n`)
        renameSync(next, this.currentFile)
      } finally {
        rmSync(next, { force: true })
      }
      published = true
      console.error(`[package-when-stale] ready: ${manifest.executablePath}`)
      return manifest
    } finally {
      this.removeUnder(snapshot, workingRoot)
      if (!published) this.removeUnder(release, this.releasesRoot)
    }
  }

  protected async packageSnapshot(snapshot: string, release: string): Promise<void> {
    if (process.platform !== 'win32' || process.arch !== 'x64')
      throw new Error('automatic client packaging requires Windows x64')
    const tsx = join(snapshot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    await this.runNode(tsx, ['scripts/setup/prepare-remarkable-sidecar.ts'], snapshot)
    await this.runNode(tsx, ['scripts/release/prepare-launcher.ts'], snapshot)
    await this.runNode(tsx, ['scripts/release/prepare-host-bundle.ts'], snapshot)
    const ui = join(snapshot, 'app-client-ui')
    await this.runNode(join(ui, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), ['build'], ui)
    await this.runNode(join(ui, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), [
      '--win', '--x64', '--dir', '--publish', 'never', `--config.directories.output=${release}`,
    ], ui)
  }

  private runNode(script: string, args: string[], cwd: string): Promise<void> {
    return new Promise((accept, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd,
        env: { ...process.env, NODE_ENV: 'production' },
        stdio: ['ignore', process.stderr, process.stderr],
        windowsHide: true,
      })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (code === 0) accept()
        else reject(new Error(`${script} failed (${signal ?? String(code)})`))
      })
    })
  }

  private async acquireLock(): Promise<number> {
    const deadline = Date.now() + 30 * 60_000
    let reported = false
    while (true) {
      try {
        const descriptor = openSync(this.lockFile, 'wx')
        try {
          writeFileSync(descriptor, JSON.stringify({ pid: process.pid }))
          return descriptor
        } catch (error) {
          closeSync(descriptor)
          rmSync(this.lockFile)
          throw error
        }
      } catch (error) {
        if (!this.hasCode(error, 'EEXIST')) throw error
      }
      this.checkLockOwner()
      if (Date.now() >= deadline) throw new Error(`timed out waiting for package lock: ${this.lockFile}`)
      if (!reported) console.error('[package-when-stale] waiting for the current package build')
      reported = true
      await setTimeout(250)
    }
  }

  private checkLockOwner(): void {
    let pid: unknown
    try { pid = (JSON.parse(readFileSync(this.lockFile, 'utf8')) as { pid?: unknown }).pid }
    catch (error) {
      if (this.hasCode(error, 'ENOENT') || error instanceof SyntaxError) return
      throw error
    }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0)
      throw new Error(`invalid package lock; inspect before removing: ${this.lockFile}`)
    try { process.kill(pid, 0) }
    catch (error) {
      if (!this.hasCode(error, 'ESRCH')) throw error
      // Never steal a stale path: another waiter could replace it between inspection and removal.
      throw new Error(`abandoned package lock; inspect before removing: ${this.lockFile}`)
    }
  }

  private readCurrent(): LocalClientPackageManifest | null {
    if (!existsSync(this.currentFile)) return null
    const value = JSON.parse(readFileSync(this.currentFile, 'utf8')) as Partial<LocalClientPackageManifest> | null
    if (value === null || typeof value !== 'object'
      || value.schemaVersion !== 1 || typeof value.inputHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.inputHash) || typeof value.executablePath !== 'string'
      || typeof value.builtAt !== 'string')
      throw new Error(`invalid package manifest: ${this.currentFile}`)
    const child = relative(this.releasesRoot, value.executablePath)
    if (isAbsolute(child) || child.startsWith(`..${sep}`) || child === '..'
      || !/^[^/\\]+[/\\]win-unpacked[/\\]Jamat\.exe$/.test(child))
      throw new Error(`package executable is outside its release: ${value.executablePath}`)
    return value as LocalClientPackageManifest
  }

  private isComplete(manifest: LocalClientPackageManifest): boolean {
    const directory = dirname(manifest.executablePath)
    return [manifest.executablePath, join(directory, 'resources', 'app.asar'),
      join(directory, 'resources', 'host', 'start.cjs'),
      join(directory, 'resources', 'remarkable-sidecar', 'manifest.json'),
      ...['node.exe', 'launcher.cjs', 'install-launcher.ps1', 'package.json', 'README.md',
        'LICENSE', 'NODE-LICENSE.txt', 'WS-LICENSE.txt'].map(name => join(directory, 'resources', 'launcher', name)),
    ].every(existsSync)
  }

  private hasCode(error: unknown, code: string): boolean {
    return error instanceof Error && 'code' in error && error.code === code
  }

  private removeUnder(directory: string, root: string): void {
    const child = relative(resolve(root), resolve(directory))
    if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`))
      throw new Error(`refusing to remove a package path outside ${root}: ${directory}`)
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

export function ensurePackagedClient(repositoryRoot: string): Promise<LocalClientPackageManifest> {
  return new LocalClientPackage(repositoryRoot).ensure()
}
