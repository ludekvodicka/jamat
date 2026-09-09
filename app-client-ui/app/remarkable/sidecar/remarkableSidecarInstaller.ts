import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { CommandInvoker } from '../../../../lib-orchestrator/shared/commandInvoker'
import type {
  CommandInvocation,
  CommandOutcome,
} from '../../../../lib-orchestrator/shared/commandInvoker.types'
import type {
  RemarkableDependencyStatus,
  RemarkableResult,
} from '../../../shared/remarkableApi.types'
import {
  RemarkableSidecarManifest,
  type RemarkableSidecarManifestValue,
} from './remarkableSidecarManifest'

type RemarkableReadyStatus = Extract<RemarkableDependencyStatus, { kind: 'ready' }>
type RemarkablePublishState =
  | { kind: 'created' }
  | { kind: 'replaced'; previous: string }
  | { kind: 'unchanged' }

class RemarkableInstallCancelledError extends Error {}

export interface RemarkableSidecarExecutable {
  node: string
  entry: string
  bundleId: string
}

export interface RemarkableSidecarInstallerOptions {
  sourceDirectory: string
  toolsDirectory: string
  invoker?: { run(invocation: CommandInvocation): Promise<CommandOutcome> }
  platform?: NodeJS.Platform
  architecture?: string
  id?: () => string
  copy?: (source: string, target: string) => Promise<void>
}

export class RemarkableSidecarInstaller {
  private readonly invoker: { run(invocation: CommandInvocation): Promise<CommandOutcome> }
  private readonly platform: NodeJS.Platform
  private readonly architecture: string
  private readonly id: () => string
  private readonly copy: (source: string, target: string) => Promise<void>
  private installing: Promise<RemarkableResult<RemarkableReadyStatus>> | null = null
  /**
   * What `executable()` proved in THIS process. Hashing the bundle costs about a second, and it sat
   * in front of every single tablet command - one import pays it three times. `status()` and every
   * install path still hash for real; this only spares the repeat before a spawn.
   */
  private verified: {
    directory: string
    bundleId: string
    paths: { node: string; entry: string }
  } | null = null

  constructor(private readonly options: RemarkableSidecarInstallerOptions) {
    this.invoker = options.invoker ?? new CommandInvoker({ timeoutMilliseconds: 30_000 })
    this.platform = options.platform ?? process.platform
    this.architecture = options.architecture ?? process.arch
    this.id = options.id ?? randomUUID
    this.copy = options.copy ?? (async (source, target) => await cp(source, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
    }))
  }

  async status(): Promise<RemarkableDependencyStatus> {
    if (!this.supported())
      return { kind: 'unsupported-platform', detail: this.unsupportedDetail() }
    let source: RemarkableSidecarManifestValue
    // The manifest alone: what runs is the INSTALLED copy, verified below, and the install path
    // hashes the source before it copies anything. Hashing it here doubled the cost of opening
    // the settings card for an answer nobody acts on.
    try { source = await RemarkableSidecarManifest.read(this.options.sourceDirectory) }
    catch (error) {
      return { kind: 'source-missing', detail: RemarkableSidecarInstaller.detailOf(error) }
    }
    const target = this.targetOf(source)
    if (!await RemarkableSidecarInstaller.exists(target)) {
      const entries = await RemarkableSidecarInstaller.directories(this.options.toolsDirectory)
      return entries.some((entry) => !entry.startsWith('.'))
        ? { kind: 'outdated', detail: 'A different reMarkable sidecar bundle is installed' }
        : { kind: 'missing', detail: 'The reMarkable sidecar is not installed' }
    }
    try {
      const installed = await RemarkableSidecarManifest.read(target)
      if (installed.bundleId !== source.bundleId)
        return { kind: 'outdated', detail: 'The installed reMarkable sidecar bundle is outdated' }
      await RemarkableSidecarManifest.verify(target, installed)
      return RemarkableSidecarInstaller.ready(installed)
    } catch (error) {
      return { kind: 'damaged', detail: RemarkableSidecarInstaller.detailOf(error) }
    }
  }

  async install(signal: AbortSignal): Promise<RemarkableResult<RemarkableReadyStatus>> {
    if (signal.aborted) return RemarkableSidecarInstaller.cancelled()
    if (this.installing !== null) return await this.installing
    // Repair is the user asking for a real check, and an install moves the directory either way.
    this.verified = null
    const installing = this.installOnce(signal)
    this.installing = installing
    try { return await installing }
    finally {
      this.verified = null
      if (this.installing === installing) this.installing = null
    }
  }

  async executable(): Promise<RemarkableResult<RemarkableSidecarExecutable>> {
    if (!this.supported())
      return RemarkableSidecarInstaller.failure('unsupported-platform', this.unsupportedDetail())
    let manifest: RemarkableSidecarManifestValue
    try { manifest = await RemarkableSidecarManifest.read(this.options.sourceDirectory) }
    catch {
      return RemarkableSidecarInstaller.failure(
        'sidecar-not-installed',
        'The bundled reMarkable sidecar source is unavailable',
      )
    }
    const target = this.targetOf(manifest)
    if (!await RemarkableSidecarInstaller.exists(target))
      return RemarkableSidecarInstaller.failure(
        'sidecar-not-installed',
        'Install the reMarkable dependencies before using the tablet',
      )
    try {
      const installed = await RemarkableSidecarManifest.read(target)
      if (installed.bundleId !== manifest.bundleId)
        return RemarkableSidecarInstaller.failure(
          'sidecar-not-installed',
          'Repair the reMarkable dependencies before using the tablet',
        )
      const paths = await this.verifiedPaths(target, installed)
      return { ok: true, value: { ...paths, bundleId: installed.bundleId } }
    } catch {
      return RemarkableSidecarInstaller.failure(
        'sidecar-damaged',
        'The installed reMarkable sidecar is damaged; repair its dependencies',
      )
    }
  }

  private async installOnce(signal: AbortSignal): Promise<RemarkableResult<RemarkableReadyStatus>> {
    if (!this.supported())
      return RemarkableSidecarInstaller.failure('unsupported-platform', this.unsupportedDetail())
    let source: RemarkableSidecarManifestValue
    try { source = await this.sourceManifest() }
    catch (error) {
      return RemarkableSidecarInstaller.failure('install-failed', RemarkableSidecarInstaller.detailOf(error))
    }
    if (signal.aborted) return RemarkableSidecarInstaller.cancelled()
    const target = this.targetOf(source)
    const alreadyValid = await this.validTarget(target, source)
    if (signal.aborted) return RemarkableSidecarInstaller.cancelled()
    if (alreadyValid) return { ok: true, value: RemarkableSidecarInstaller.ready(source) }

    const staging = join(this.options.toolsDirectory, `.install-${this.id()}`)
    try {
      RemarkableSidecarInstaller.throwIfAborted(signal)
      await mkdir(this.options.toolsDirectory, { recursive: true })
      await this.copy(this.options.sourceDirectory, staging)
      RemarkableSidecarInstaller.throwIfAborted(signal)
      const copied = await RemarkableSidecarManifest.read(staging)
      if (copied.bundleId !== source.bundleId)
        throw new Error('The copied reMarkable sidecar manifest changed during installation')
      const paths = await RemarkableSidecarManifest.verify(staging, copied)
      RemarkableSidecarInstaller.throwIfAborted(signal)
      await this.verifyHelp(staging, paths, signal)
      RemarkableSidecarInstaller.throwIfAborted(signal)
      const published = await this.publish(staging, target, source, signal)
      if (signal.aborted) {
        await this.rollbackPublish(target, published)
        throw new RemarkableInstallCancelledError()
      }
      if (!await this.validTarget(target, source)) {
        await this.rollbackPublish(target, published)
        throw new Error('The published reMarkable sidecar did not pass verification')
      }
      if (signal.aborted) {
        await this.rollbackPublish(target, published)
        throw new RemarkableInstallCancelledError()
      }
      await RemarkableSidecarInstaller.finishPublish(published)
      return { ok: true, value: RemarkableSidecarInstaller.ready(source) }
    } catch (error) {
      if (error instanceof RemarkableInstallCancelledError)
        return RemarkableSidecarInstaller.cancelled()
      return RemarkableSidecarInstaller.failure('install-failed', RemarkableSidecarInstaller.detailOf(error))
    } finally {
      await RemarkableSidecarInstaller.discard(staging)
    }
  }

  private async verifiedPaths(
    directory: string,
    manifest: RemarkableSidecarManifestValue,
  ): Promise<{ node: string; entry: string }> {
    const remembered = this.verified
    if (remembered !== null
      && remembered.directory === directory
      && remembered.bundleId === manifest.bundleId)
      return remembered.paths
    const paths = await RemarkableSidecarManifest.verify(directory, manifest)
    this.verified = { directory, bundleId: manifest.bundleId, paths }
    return paths
  }

  private async sourceManifest(): Promise<RemarkableSidecarManifestValue> {
    const manifest = await RemarkableSidecarManifest.read(this.options.sourceDirectory)
    await RemarkableSidecarManifest.verify(this.options.sourceDirectory, manifest)
    return manifest
  }

  private async verifyHelp(
    directory: string,
    paths: { node: string; entry: string },
    signal: AbortSignal,
  ): Promise<void> {
    const outcome = await this.invoker.run({
      command: paths.node,
      args: [paths.entry, '--help', '--json'],
      cwd: directory,
      env: RemarkableSidecarInstaller.cleanEnvironment(),
      signal,
    })
    if (signal.aborted || outcome.failure === 'aborted') throw new RemarkableInstallCancelledError()
    if (outcome.failure !== null || outcome.code !== 0
      || outcome.stdout.trim().length === 0)
      throw new Error('The reMarkable sidecar help check failed')
  }

  private async publish(
    staging: string,
    target: string,
    expected: RemarkableSidecarManifestValue,
    signal: AbortSignal,
  ): Promise<RemarkablePublishState> {
    RemarkableSidecarInstaller.throwIfAborted(signal)
    if (!await RemarkableSidecarInstaller.exists(target)) {
      RemarkableSidecarInstaller.throwIfAborted(signal)
      try {
        await rename(staging, target)
        return { kind: 'created' }
      } catch (error) {
        if (await this.validTarget(target, expected)) return { kind: 'unchanged' }
        throw error
      }
    }
    if (await this.validTarget(target, expected)) return { kind: 'unchanged' }
    RemarkableSidecarInstaller.throwIfAborted(signal)
    const previous = join(this.options.toolsDirectory, `.replace-${this.id()}`)
    await rename(target, previous)
    try {
      RemarkableSidecarInstaller.throwIfAborted(signal)
      await rename(staging, target)
    }
    catch (error) {
      await rename(previous, target)
      throw error
    }
    return { kind: 'replaced', previous }
  }

  private async rollbackPublish(target: string, published: RemarkablePublishState): Promise<void> {
    if (published.kind === 'unchanged') return
    else if (published.kind === 'created')
      await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    else if (published.kind === 'replaced') {
      await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      await rename(published.previous, target)
    } else throw new Error(`Unknown reMarkable publish state: ${JSON.stringify(published)}`)
  }

  private async validTarget(
    directory: string,
    expected: RemarkableSidecarManifestValue,
  ): Promise<boolean> {
    try {
      const installed = await RemarkableSidecarManifest.read(directory)
      if (installed.bundleId !== expected.bundleId) return false
      await RemarkableSidecarManifest.verify(directory, installed)
      return true
    } catch { return false }
  }

  private targetOf(manifest: RemarkableSidecarManifestValue): string {
    return join(this.options.toolsDirectory, manifest.bundleId)
  }

  private supported(): boolean {
    return this.platform === 'win32' && this.architecture === 'x64'
  }

  private unsupportedDetail(): string {
    return `The reMarkable sidecar supports win32-x64, not ${this.platform}-${this.architecture}`
  }

  private static ready(manifest: RemarkableSidecarManifestValue): RemarkableReadyStatus {
    return {
      kind: 'ready',
      bundleId: manifest.bundleId,
      nodeVersion: manifest.node.version,
      cliVersion: manifest.cli.version,
    }
  }

  private static cleanEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      const name = key.toUpperCase()
      if (!name.startsWith('RMCLI_')
        && name !== 'NODE_OPTIONS'
        && name !== 'NODE_PATH'
        && name !== 'PATH') env[key] = value
    }
    env.PATH = ''
    return env
  }

  private static async directories(root: string): Promise<string[]> {
    try {
      return (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch (error) {
      if (RemarkableSidecarInstaller.errorCode(error) === 'ENOENT') return []
      throw error
    }
  }

  private static async exists(path: string): Promise<boolean> {
    try { await lstat(path); return true }
    catch (error) {
      if (RemarkableSidecarInstaller.errorCode(error) === 'ENOENT') return false
      throw error
    }
  }

  private static async discard(path: string): Promise<void> {
    try { await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
    catch { return }
  }

  private static async finishPublish(published: RemarkablePublishState): Promise<void> {
    if (published.kind === 'created' || published.kind === 'unchanged') return
    else if (published.kind === 'replaced') await RemarkableSidecarInstaller.discard(published.previous)
    else throw new Error(`Unknown reMarkable publish state: ${JSON.stringify(published)}`)
  }

  private static errorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object') return undefined
    return typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined
  }

  private static detailOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private static throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new RemarkableInstallCancelledError()
  }

  private static cancelled<T>(): RemarkableResult<T> {
    return RemarkableSidecarInstaller.failure('cancelled', 'The reMarkable installation was cancelled')
  }

  private static failure<T>(
    code: 'cancelled' | 'install-failed' | 'sidecar-damaged' | 'sidecar-not-installed' | 'unsupported-platform',
    detail: string,
  ): RemarkableResult<T> {
    return { ok: false, code, detail, retryable: false }
  }
}
