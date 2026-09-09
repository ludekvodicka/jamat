import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  CommandInvocation,
  CommandOutcome,
} from '../../../../lib-orchestrator/shared/commandInvoker.types'
import { RemarkableSidecarInstaller } from './remarkableSidecarInstaller'
import type {
  RemarkableSidecarFile,
  RemarkableSidecarManifestValue,
} from './remarkableSidecarManifest'

describe('app-client-ui/app/remarkable/sidecar/remarkableSidecarInstaller', () => {
  let root: string
  let source: string
  let tools: string

  beforeEach(() => {
    // This subsystem proves a path by realpath(p) === p, and os.tmpdir() is an 8.3 short
    // name on the Windows CI runner. Only the NATIVE call expands one, so a plain
    // realpathSync here would leave the root short and every such proof would refuse.
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'jamat-v3-remarkable-installer-')))
    source = join(root, 'source')
    tools = join(root, 'tools')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reports source-missing, missing, ready, damaged and outdated exclusively', async () => {
    const missingSource = installer(new FakeInvoker(), join(root, 'absent'))
    expect((await missingSource.status()).kind).toBe('source-missing')

    const first = writeSeed(source, 'a'.repeat(64))
    const current = installer(new FakeInvoker())
    expect((await current.status()).kind).toBe('missing')
    expect((await current.install(freshSignal())).ok).toBe(true)
    expect(await current.status()).toEqual({
      kind: 'ready',
      bundleId: first.bundleId,
      nodeVersion: '22.23.2',
      cliVersion: '0.3.0',
    })

    writeFileSync(join(tools, first.bundleId, 'node.exe'), 'damaged')
    expect((await current.status()).kind).toBe('damaged')
    rmSync(join(tools, first.bundleId), { recursive: true, force: true })
    mkdirSync(join(tools, 'old-valid-bundle'))
    writeSeed(source, 'b'.repeat(64))
    expect((await current.status()).kind).toBe('outdated')
  })

  /**
   * Hashing the bundle takes about a second, and it sat in front of every tablet command: one
   * import runs three of them. The deliberate checks - status and every install path - still hash.
   */
  it('hashes the installed tree once per process before a spawn and again after an install', async () => {
    const manifest = writeSeed(source, 'a'.repeat(64))
    const current = installer(new FakeInvoker())
    expect((await current.install(freshSignal())).ok).toBe(true)
    const target = join(tools, manifest.bundleId)
    expect(await current.executable()).toMatchObject({ ok: true })

    writeFileSync(join(target, 'node.exe'), 'damaged after the check')

    expect(await current.executable()).toMatchObject({ ok: true })
    expect((await current.status()).kind).toBe('damaged')

    expect((await current.install(freshSignal())).ok).toBe(true)
    expect(readFileSync(join(target, 'node.exe'), 'utf8')).toBe('plain node')
    expect(await current.executable()).toMatchObject({ ok: true })
  })

  it('reads the source manifest for status without hashing the source tree', async () => {
    const manifest = writeSeed(source, 'a'.repeat(64))
    expect((await installer(new FakeInvoker()).install(freshSignal())).ok).toBe(true)

    writeFileSync(join(source, 'node.exe'), 'source damaged after the install')

    // What runs is the installed copy; the install path is where the source proves itself.
    expect(await installer(new FakeInvoker()).status()).toMatchObject({
      kind: 'ready',
      bundleId: manifest.bundleId,
    })
    expect(await installer(new FakeInvoker()).install(freshSignal()))
      .toMatchObject({ ok: false, code: 'install-failed' })
  })

  it('publishes once for concurrent callers with absolute verified help argv and a clean env', async () => {
    const manifest = writeSeed(source, 'a'.repeat(64))
    const fake = new FakeInvoker()
    let copies = 0
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const current = installer(fake, source, async (from, to) => {
      copies += 1
      await waiting
      cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
    })

    const signal = freshSignal()
    const one = current.install(signal)
    const two = current.install(signal)
    await vi.waitFor(() => expect(copies).toBe(1))
    release()
    expect((await one).ok).toBe(true)
    expect((await two).ok).toBe(true)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toEqual(expect.objectContaining({
      command: join(tools, `.install-id-1`, 'node.exe'),
      args: [join(tools, `.install-id-1`, 'node_modules', 'remarkable-cli', 'dist', 'cli.js'), '--help', '--json'],
      cwd: join(tools, `.install-id-1`),
    }))
    expect(fake.calls[0].env.PATH).toBe('')
    expect(Object.keys(fake.calls[0].env).filter((key) => key.toUpperCase().startsWith('RMCLI_')))
      .toEqual([])
    expect(existsSync(join(tools, manifest.bundleId))).toBe(true)
    expect(readdirSync(tools).filter((entry) => entry.startsWith('.install-'))).toEqual([])
  })

  it('keeps an older ready bundle and removes only its staging after copy or help failure', async () => {
    const old = writeSeed(source, 'a'.repeat(64))
    const fake = new FakeInvoker()
    expect((await installer(fake).install(freshSignal())).ok).toBe(true)

    const next = writeSeed(source, 'b'.repeat(64))
    fake.outcomes.push({ code: 1, stdout: '', stderr: 'help failed', failure: null })
    const failed = await installer(fake).install(freshSignal())
    expect(failed).toEqual(expect.objectContaining({ ok: false, code: 'install-failed' }))
    expect(existsSync(join(tools, old.bundleId))).toBe(true)
    expect(existsSync(join(tools, next.bundleId))).toBe(false)
    expect(readdirSync(tools).filter((entry) => entry.startsWith('.install-'))).toEqual([])

    const copyFailure = installer(new FakeInvoker(), source, async (_from, to) => {
      mkdirSync(to)
      throw new Error('copy interrupted')
    })
    expect(await copyFailure.install(freshSignal())).toEqual(expect.objectContaining({
      ok: false,
      code: 'install-failed',
    }))
    expect(readdirSync(tools).filter((entry) => entry.startsWith('.install-'))).toEqual([])
  })

  it('restores the previous target when final published-tree verification fails', async () => {
    const manifest = writeSeed(source, 'a'.repeat(64))
    expect((await installer(new FakeInvoker()).install(freshSignal())).ok).toBe(true)
    const target = join(tools, manifest.bundleId)
    writeFileSync(join(target, 'node.exe'), 'previous damaged bytes')

    const fake = new FakeInvoker()
    fake.onRun = () => writeFileSync(join(tools, '.install-id-1', 'node.exe'), 'published damaged bytes')
    const result = await installer(fake).install(freshSignal())

    expect(result).toMatchObject({ ok: false, code: 'install-failed' })
    expect(readFileSync(join(target, 'node.exe'), 'utf8')).toBe('previous damaged bytes')
    expect(readdirSync(tools).some((entry) => entry.startsWith('.replace-'))).toBe(false)
    expect(readdirSync(tools).some((entry) => entry.startsWith('.install-'))).toBe(false)
  })

  it('returns cancelled before a pre-aborted install touches source, tools or help', async () => {
    writeSeed(source, 'a'.repeat(64))
    const fake = new FakeInvoker()
    const abort = new AbortController()
    abort.abort()

    expect(await installer(fake).install(abort.signal)).toMatchObject({
      ok: false,
      code: 'cancelled',
    })
    expect(fake.calls).toEqual([])
    expect(existsSync(tools)).toBe(false)
  })

  it('waits for an active copy, then cancels without help or publish and preserves the old bundle', async () => {
    const old = writeSeed(source, 'a'.repeat(64))
    expect((await installer(new FakeInvoker()).install(freshSignal())).ok).toBe(true)
    const next = writeSeed(source, 'b'.repeat(64))
    let copyStarted!: () => void
    let finishCopy!: () => void
    const started = new Promise<void>((resolve) => { copyStarted = resolve })
    const finish = new Promise<void>((resolve) => { finishCopy = resolve })
    const fake = new FakeInvoker()
    const current = installer(fake, source, async (from, to) => {
      copyStarted()
      await finish
      cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
    })
    const abort = new AbortController()
    let settled = false
    const installing = current.install(abort.signal)
    void installing.finally(() => { settled = true })
    await started

    abort.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    finishCopy()

    expect(await installing).toMatchObject({ ok: false, code: 'cancelled' })
    expect(fake.calls).toEqual([])
    expect(existsSync(join(tools, old.bundleId))).toBe(true)
    expect(existsSync(join(tools, next.bundleId))).toBe(false)
    expect(readdirSync(tools).some((entry) => entry.startsWith('.install-'))).toBe(false)
  })

  it('passes abort to help and never publishes its candidate after the child is cancelled', async () => {
    const old = writeSeed(source, 'a'.repeat(64))
    expect((await installer(new FakeInvoker()).install(freshSignal())).ok).toBe(true)
    const next = writeSeed(source, 'b'.repeat(64))
    let helpStarted!: () => void
    const started = new Promise<void>((resolve) => { helpStarted = resolve })
    const fake = new FakeInvoker()
    fake.runAction = async (invocation) => await new Promise<CommandOutcome>((resolve) => {
      helpStarted()
      invocation.signal?.addEventListener('abort', () => resolve({
        code: -1,
        stdout: '',
        stderr: '',
        failure: 'aborted',
      }), { once: true })
    })
    const abort = new AbortController()
    const installing = installer(fake).install(abort.signal)
    await started

    abort.abort()

    expect(await installing).toMatchObject({ ok: false, code: 'cancelled' })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.signal).toBe(abort.signal)
    expect(existsSync(join(tools, old.bundleId))).toBe(true)
    expect(existsSync(join(tools, next.bundleId))).toBe(false)
    expect(readdirSync(tools).some((entry) => entry.startsWith('.install-'))).toBe(false)
  })

  function installer(
    invoker: FakeInvoker,
    seed = source,
    copy?: (from: string, to: string) => Promise<void>,
  ): RemarkableSidecarInstaller {
    let id = 0
    return new RemarkableSidecarInstaller({
      sourceDirectory: seed,
      toolsDirectory: tools,
      invoker,
      platform: 'win32',
      architecture: 'x64',
      id: () => `id-${++id}`,
      ...(copy === undefined ? {} : { copy }),
    })
  }
})

class FakeInvoker {
  readonly calls: CommandInvocation[] = []
  readonly outcomes: CommandOutcome[] = []
  onRun: ((invocation: CommandInvocation) => void) | null = null
  runAction: ((invocation: CommandInvocation) => Promise<CommandOutcome>) | null = null

  async run(invocation: CommandInvocation): Promise<CommandOutcome> {
    this.calls.push(invocation)
    this.onRun?.(invocation)
    if (this.runAction !== null) return await this.runAction(invocation)
    return this.outcomes.shift() ?? {
      code: 0,
      stdout: 'rmcli help\n',
      stderr: '',
      failure: null,
    }
  }
}

function writeSeed(directory: string, packageLockSha256: string): RemarkableSidecarManifestValue {
  rmSync(directory, { recursive: true, force: true })
  const contents = new Map<string, string>([
    ['NODE-LICENSE.txt', 'node license'],
    ['node.exe', 'plain node'],
    ['node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'native'],
    ['node_modules/remarkable-cli/LICENSE', 'cli license'],
    ['node_modules/remarkable-cli/dist/cli.js', 'cli entry'],
    ['node_modules/remarkable-cli/package.json', '{"name":"remarkable-cli"}'],
  ])
  const roles = new Map<string, RemarkableSidecarFile['role']>([
    ['NODE-LICENSE.txt', 'node-license'],
    ['node.exe', 'node'],
    ['node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'native-module'],
    ['node_modules/remarkable-cli/LICENSE', 'cli-license'],
    ['node_modules/remarkable-cli/dist/cli.js', 'cli-entry'],
    ['node_modules/remarkable-cli/package.json', 'cli-package'],
  ])
  const files = [...contents].map(([path, content]) => ({
    role: roles.get(path) as RemarkableSidecarFile['role'],
    path,
    sha256: createHash('sha256').update(content).digest('hex'),
  })).sort((left, right) => left.path.localeCompare(right.path))
  for (const [path, content] of contents) {
    const file = join(directory, ...path.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  const treeHash = createHash('sha256')
  const treeEntries = [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))
  for (const file of treeEntries)
    treeHash.update(file.path, 'utf8').update('\0').update(file.sha256, 'ascii').update('\n')
  const tree = { files: treeEntries.length, sha256: treeHash.digest('hex') }
  const base = {
    schemaVersion: 1 as const,
    platform: 'win32-x64' as const,
    node: {
      version: '22.23.2' as const,
      executable: 'node.exe',
      archiveSha256: '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97',
    },
    cli: {
      package: 'remarkable-cli' as const,
      version: '0.3.0' as const,
      entry: 'node_modules/remarkable-cli/dist/cli.js',
    },
    recipe: { packageLockSha256 },
    tree,
    files,
  }
  const hash = createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    platform: base.platform,
    nodeVersion: base.node.version,
    nodeArchiveSha256: base.node.archiveSha256,
    cliPackage: base.cli.package,
    cliVersion: base.cli.version,
    packageLockSha256,
    tree,
    files,
  })).digest('hex')
  const manifest: RemarkableSidecarManifestValue = {
    ...base,
    bundleId: `win32-x64-node-22.23.2-remarkable-cli-0.3.0-${hash.slice(0, 16)}`,
  }
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function freshSignal(): AbortSignal {
  return new AbortController().signal
}
