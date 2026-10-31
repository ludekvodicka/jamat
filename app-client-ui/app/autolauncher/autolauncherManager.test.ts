import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RemoteLauncherConfigData } from '../../../lib-orchestrator/remoteControl/remoteLauncherConfig'
import { AutolauncherTarget as Target } from './autolauncherTarget'
import { ConfigIdentityStore } from '../../../lib-orchestrator/shared/configIdentityStore'
import type { AutolauncherSnapshot } from '../../shared/autolauncher'
import { AutolauncherManager } from './autolauncherManager'
import { AutolauncherProblem } from './autolauncherProblem'
import { AutolauncherTarget } from './autolauncherTarget'

describe('app-client-ui/app/autolauncher/autolauncherManager', () => {
  const directories: string[] = []
  afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  })

  async function fixture(mode: 'source' | 'executable' = 'source') {
    const root = await mkdtemp(join(tmpdir(), 'jamat-autolauncher-'))
    directories.push(root)
    const configDir = join(root, 'profile')
    const identity = ConfigIdentityStore.loadOrCreate(configDir, mode === 'source' ? 'development' : 'production')
    const target: AutolauncherSnapshot['target'] = { configDir, configIdentity: identity.configIdentity,
      runtimeChannel: identity.runtimeChannel, mode, path: join(root, mode === 'source' ? 'checkout' : 'Jamat.exe') }
    const files = mode === 'source' ? ['node_modules/tsx/dist/cli.mjs', 'scripts/release/start-packaged-client.ts'].map(path => join(target.path, path)) : [target.path]
    for (const file of files) {
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, '')
    }
    const directory = join(root, 'launcher')
    const pairing = { publicUrl: 'http://127.0.0.1:3511', key: '1'.repeat(64), gatewayAddress: '127.0.0.1' }
    const configFile = join(directory, 'releases', 'installed', 'config.json')
    const metadata = { schemaVersion: 1, enabled: true, ...target, gatewayAddress: pairing.gatewayAddress,
      runtime: { configFile } }
    const writeMetadata = async (enabled: boolean) => {
      await writeFile(join(directory, 'installation.json'), JSON.stringify({ ...metadata, enabled }))
    }
    const setup = {
      install: vi.fn(async (config: RemoteLauncherConfigData) => {
        await mkdir(join(directory, 'releases', 'installed'), { recursive: true })
        await writeFile(join(directory, 'releases', 'installed', 'node.exe'), '')
        await writeFile(configFile, JSON.stringify(config))
        await writeMetadata(true)
      }),
      disable: vi.fn(async () => writeMetadata(false)),
    }
    const connection = { pair: vi.fn(async () => pairing), probe: vi.fn(async () => true) }
    const events: AutolauncherSnapshot[] = []
    const manager = new AutolauncherManager(target, directory, true, setup, connection, event => events.push(event))
    const enable = (invitation: unknown) => manager.enable(invitation, { recipe: Target.fromRunning(target), temporaryPathConfirmed: true })
    return { root, target, directory, pairing, metadata, setup, connection, events, manager, writeMetadata, enable, configFile }
  }

  it.each(['source', 'executable'] as const)('pins the %s recipe and the existing identity, with secret-free snapshots', async mode => {
    const f = await fixture(mode)
    expect(await f.enable('opaque invitation')).toMatchObject({ ok: true,
      snapshot: { installed: true, installedForThisProfile: true, running: true, connectionReady: true } })
    const config = f.setup.install.mock.calls[0]?.[0]
    expect(config).toMatchObject({ configDir: f.target.configDir, configIdentity: f.target.configIdentity,
      runtimeChannel: f.target.runtimeChannel, key: f.pairing.key })
    expect(config?.recipe).toEqual(mode === 'source'
      ? { kind: 'source', repositoryRoot: f.target.path } : { kind: 'executable', path: f.target.path })
    expect(JSON.stringify(f.events)).not.toContain(f.pairing.key)
    expect(JSON.stringify(f.events)).not.toContain('opaque invitation')
  })

  it('directs missing invitations to the Jamat relay without contacting setup', async () => {
    const f = await fixture()
    expect(await f.enable(42)).toEqual({ ok: false, problem: 'Paste the setup invitation from the Jamat relay.' })
    expect(await f.enable(null)).toEqual({ ok: false, problem: 'Create a setup invitation for this PC in the Jamat relay first.' })
    expect(f.connection.pair).not.toHaveBeenCalled()
    expect(f.setup.install).not.toHaveBeenCalled()
  })

  it('retains consumed pairing after UAC cancellation and retries without consuming another invitation', async () => {
    const f = await fixture()
    f.setup.install.mockRejectedValueOnce(new AutolauncherProblem('Installation cancelled.'))
    expect(await f.enable('one use')).toEqual({ ok: false, problem: 'Installation cancelled.' })
    expect(await f.manager.get()).toMatchObject({ operation: 'idle', connectionReady: true, installed: false })
    expect(await f.enable(null)).toMatchObject({ ok: true })
    expect(f.connection.pair).toHaveBeenCalledTimes(1)
    expect(await f.manager.disable()).toMatchObject({ ok: true, snapshot: { installed: false, running: false, connectionReady: true } })
    expect(JSON.parse(await readFile(join(f.directory, 'pairing.json'), 'utf8'))).toEqual(f.pairing)
  })

  it('serializes local operations before their first await', async () => {
    const f = await fixture()
    let release!: () => void
    f.connection.pair.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(f.pairing) }))
    const first = f.enable('invitation')
    expect(await f.enable(null)).toMatchObject({ ok: false, problem: expect.stringContaining('still running') })
    expect(await f.manager.disable()).toMatchObject({ ok: false })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    expect(await first).toMatchObject({ ok: true })
    expect(f.setup.install).toHaveBeenCalledTimes(1)
  })

  it('refuses a changed profile without creating identity or touching Windows', async () => {
    const f = await fixture()
    await rm(join(f.target.configDir, 'config-identity.json'))
    expect(await f.enable('invitation')).toMatchObject({ ok: false, problem: expect.stringContaining('profile changed') })
    expect(f.connection.pair).not.toHaveBeenCalled()
    expect(f.setup.install).not.toHaveBeenCalled()
  })

  it('does not disable another profile and probes active config even if a cancelled connection is saved', async () => {
    const f = await fixture()
    await f.enable('invitation')
    await writeFile(join(f.directory, 'pairing.json'), JSON.stringify({ ...f.pairing, key: '2'.repeat(64) }))
    await f.manager.get()
    expect(f.connection.probe).toHaveBeenLastCalledWith(f.pairing)
    const other = new AutolauncherManager({ ...f.target, configIdentity: 'another' }, f.directory,
      true, f.setup, f.connection, () => {})
    expect(await other.get()).toMatchObject({ installed: true, installedForThisProfile: false })
    expect(await other.disable()).toMatchObject({ ok: false })
    expect(f.setup.disable).not.toHaveBeenCalled()
  })

  it('never reports success if setup did not publish installation metadata and sanitizes unexpected errors', async () => {
    const f = await fixture()
    f.setup.install.mockResolvedValueOnce(undefined)
    expect(await f.enable('invitation')).toMatchObject({ ok: false, problem: expect.stringContaining('could not be verified') })
    f.setup.install.mockRejectedValueOnce(new Error(`native exception with ${f.pairing.key}`))
    const result = await f.enable(null)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(f.pairing.key)
    expect(JSON.stringify(f.events)).not.toContain(f.pairing.key)
  })

  it('clears stale success when metadata becomes corrupt and rejects a config outside its installation', async () => {
    const f = await fixture()
    await f.enable('invitation')
    await writeFile(join(f.directory, 'installation.json'), JSON.stringify({ ...f.metadata,
      runtime: { configFile: join(f.root, 'foreign.json') } }))
    expect(await f.manager.get()).toMatchObject({ installed: false, running: false, problem: expect.any(String) })
  })

  it('reports an unsupported platform without touching setup or pairing', async () => {
    const f = await fixture()
    const manager = new AutolauncherManager(f.target, f.directory, false, f.setup, f.connection, () => {})
    expect(await manager.get()).toMatchObject({ supported: false })
    expect(await manager.enable('x')).toMatchObject({ ok: false })
    expect(await manager.disable()).toMatchObject({ ok: false })
    expect(f.setup.install).not.toHaveBeenCalled()
    expect(f.connection.pair).not.toHaveBeenCalled()
  })

  it('keeps source provenance only for packages built by the named checkout', () => {
    const root = join(tmpdir(), 'source')
    const installed = join(tmpdir(), 'installed', 'Jamat.exe')
    expect(AutolauncherTarget.recipe(false, root, installed, undefined)).toEqual({ mode: 'source', path: root })
    expect(AutolauncherTarget.recipe(true, root, installed, root)).toEqual({ mode: 'executable', path: installed })
    const built = join(root, 'app-client-ui', 'dist', 'local-releases', 'release', 'win-unpacked', 'Jamat.exe')
    expect(AutolauncherTarget.recipe(true, root, built, root)).toEqual({ mode: 'source', path: root })
    expect(AutolauncherTarget.recipe(true, root, built, undefined)).toEqual({ mode: 'executable', path: built })
  })

  it('shows the installed recipe even when it differs from the running app and preserves the active key on update', async () => {
    const f = await fixture('executable')
    await f.enable('invitation')
    await writeFile(join(f.directory, 'pairing.json'), JSON.stringify({ ...f.pairing, key: '2'.repeat(64) }))
    const recipe = { kind: 'detached-command', command: process.execPath, args: ['--version'], cwd: f.root, windowsVerbatimArguments: false }
    expect(await f.manager.enable(null, { recipe, temporaryPathConfirmed: true })).toMatchObject({ ok: true })
    expect(f.setup.install.mock.calls.at(-1)?.[0].key).toBe(f.pairing.key)
    expect(await f.manager.get()).toMatchObject({ installedTarget: { recipe }, currentTarget: { recipe: { kind: 'executable' } } })
    expect(f.connection.pair).toHaveBeenCalledTimes(1)
  })

  it('requires an explicit temporary-path choice before pairing or UAC, then detects deletion on refresh', async () => {
    const f = await fixture('executable')
    expect(await f.manager.enable('invitation')).toMatchObject({ ok: false, problem: expect.stringContaining('temporary') })
    expect(f.connection.pair).not.toHaveBeenCalled()
    expect(f.setup.install).not.toHaveBeenCalled()
    expect(await f.enable('invitation')).toMatchObject({ ok: true })
    await rm(f.target.path)
    expect(await f.manager.get()).toMatchObject({ installed: true, connectionReady: true,
      installedTarget: { availability: { state: 'missing', path: f.target.path } } })
    expect(await f.enable(null)).toMatchObject({ ok: false, problem: expect.stringContaining('missing') })
    expect(f.setup.install).toHaveBeenCalledTimes(1)
  })

  it('keeps a malformed installed recipe visible and repairable with its existing pairing', async () => {
    const f = await fixture('executable')
    await f.enable('invitation')
    const config = JSON.parse(await readFile(f.configFile, 'utf8'))
    await writeFile(f.configFile, JSON.stringify({ ...config, recipe: { kind: 'damaged' } }))
    expect(await f.manager.get()).toMatchObject({ installed: true, connectionReady: true,
      installedTarget: { recipe: null, availability: { state: 'invalid' } } })
    expect(await f.enable(null)).toMatchObject({ ok: true })
    expect(f.connection.pair).toHaveBeenCalledTimes(1)
  })

  it('does not accept a successful installer that kept the wrong recipe', async () => {
    const f = await fixture('executable')
    await f.enable('invitation')
    f.setup.install.mockResolvedValueOnce(undefined)
    expect(await f.manager.enable(null, { recipe: { kind: 'command', command: process.execPath, args: [],
      cwd: f.root, windowsVerbatimArguments: false }, temporaryPathConfirmed: true }))
      .toMatchObject({ ok: false, problem: expect.stringContaining('could not be verified') })
  })
})
