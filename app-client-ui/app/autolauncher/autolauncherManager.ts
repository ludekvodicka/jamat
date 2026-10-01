import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { RemoteLauncherConfig } from '../../../lib-orchestrator/remoteControl/remoteLauncherConfig'
import { AtomicJsonFile } from '../../../lib-orchestrator/shared/atomicJsonFile'
import { ConfigIdentityStore } from '../../../lib-orchestrator/shared/configIdentityStore'
import type { AutolauncherResult, AutolauncherSnapshot } from '../../shared/autolauncher'
import { AutolauncherConnection, type AutolauncherPairing } from './autolauncherConnection'
import type { WindowsLauncherSetup } from './windowsLauncherSetup'
import { AutolauncherProblem } from './autolauncherProblem'

export class AutolauncherManager {
  private readonly target: AutolauncherSnapshot['target']
  private readonly directory: string
  private readonly supported: boolean
  private readonly setup: Pick<WindowsLauncherSetup, 'install' | 'disable'>
  private readonly connection: Pick<AutolauncherConnection, 'pair' | 'probe'>
  private readonly onChanged: (snapshot: AutolauncherSnapshot) => void
  private operation: AutolauncherSnapshot['operation'] = 'idle'
  private problem: string | null = null
  private revision = 0
  private latest: AutolauncherSnapshot

  constructor(target: AutolauncherSnapshot['target'], directory: string, supported: boolean,
    setup: Pick<WindowsLauncherSetup, 'install' | 'disable'>,
    connection: Pick<AutolauncherConnection, 'pair' | 'probe'>,
    onChanged: (snapshot: AutolauncherSnapshot) => void) {
    this.target = target
    this.directory = directory
    this.supported = supported
    this.setup = setup
    this.connection = connection
    this.onChanged = onChanged
    this.latest = { supported, target, installed: false, installedForThisProfile: false,
      installedConfigDir: null, running: false, connectionReady: false, launcherUrl: null,
      operation: 'idle', problem: null }
  }

  async get(): Promise<AutolauncherSnapshot> {
    const revision = this.revision
    let snapshot = { ...this.latest, operation: this.operation, problem: this.problem }
    if (!this.supported) return snapshot
    try {
      const pairing = await this.readPairing()
      const installation = await this.readInstallation()
      const active = installation?.enabled ? AutolauncherConnection.parse({
        ...await this.installedPairing(installation), gatewayAddress: installation.gatewayAddress,
      }) : null
      snapshot = { ...snapshot, installed: installation?.enabled === true,
        installedForThisProfile: installation !== null
          && installation.configIdentity === this.target.configIdentity
          && installation.runtimeChannel === this.target.runtimeChannel
          && installation.configDir === this.target.configDir,
        installedConfigDir: installation?.configDir ?? null,
        connectionReady: pairing !== null, launcherUrl: active?.publicUrl ?? pairing?.publicUrl ?? null,
        running: active !== null && await this.connection.probe(active) }
    } catch {
      snapshot = { ...snapshot, installed: false, installedForThisProfile: false,
        installedConfigDir: null, running: false, connectionReady: false, launcherUrl: null,
        problem: this.problem ?? 'Stored launcher setup could not be read. Reconnect using a new invitation.' }
    }
    if (revision !== this.revision) return this.get()
    this.latest = snapshot
    return snapshot
  }

  async enable(invitation: unknown): Promise<AutolauncherResult> {
    if (!this.supported) return { ok: false, problem: 'Autolauncher installation is available on Windows only.' }
    if (this.operation !== 'idle') return { ok: false, problem: 'Another launcher operation is still running.' }
    if (invitation !== null && typeof invitation !== 'string')
      return { ok: false, problem: 'Paste the setup invitation from MiniWolService.' }
    this.begin('installing')
    try {
      this.assertProfile()
      const pairing = invitation === null ? await this.readPairing() : await this.connection.pair(invitation)
      if (!pairing) throw new AutolauncherProblem('Create a setup invitation for this PC in MiniWolService first.')
      await AtomicJsonFile.ensureDirectoryAsync(this.directory)
      // Keep pairing after UAC cancellation so retry does not consume another invitation.
      await AtomicJsonFile.writeAsync(join(this.directory, 'pairing.json'), pairing)
      let recipe
      if (this.target.mode === 'executable') recipe = { kind: 'executable', path: this.target.path }
      else if (this.target.mode === 'source') recipe = { kind: 'source', repositoryRoot: this.target.path }
      else throw new Error('Unknown launcher mode')
      const config = RemoteLauncherConfig.parse({ publicUrl: pairing.publicUrl, key: pairing.key,
        configDir: this.target.configDir, configIdentity: this.target.configIdentity,
        runtimeChannel: this.target.runtimeChannel, recipe, logFile: join(this.directory, 'launcher.log') })
      await this.setup.install(config, pairing.gatewayAddress)
      const deadline = Date.now() + 10_000
      while (!await this.connection.probe(pairing)) {
        if (Date.now() >= deadline)
          throw new AutolauncherProblem('Windows installed the launcher, but it is not responding. Check the launcher log and retry.')
        await setTimeout(250)
      }
      const installed = await this.get()
      if (!installed.installed || !installed.installedForThisProfile || !installed.running)
        throw new AutolauncherProblem('The installed launcher could not be verified for this profile. Refresh status and retry.')
      return await this.finish()
    } catch (error) { return await this.finish(error) }
  }

  async disable(): Promise<AutolauncherResult> {
    if (!this.supported) return { ok: false, problem: 'Autolauncher installation is available on Windows only.' }
    if (this.operation !== 'idle') return { ok: false, problem: 'Another launcher operation is still running.' }
    this.begin('removing')
    try {
      const installation = await this.readInstallation()
      if (installation && (installation.configIdentity !== this.target.configIdentity
        || installation.runtimeChannel !== this.target.runtimeChannel || installation.configDir !== this.target.configDir))
        throw new AutolauncherProblem('The launcher belongs to another profile. Open Settings in that Jamat to disable it.')
      await this.setup.disable(this.target.configIdentity)
      return await this.finish()
    } catch (error) { return await this.finish(error) }
  }

  private assertProfile(): void {
    const current = ConfigIdentityStore.readExisting(this.target.configDir)
    if (!current || current.configIdentity !== this.target.configIdentity
      || current.runtimeChannel !== this.target.runtimeChannel)
      throw new AutolauncherProblem('The running Jamat profile changed on disk. Restart Jamat before installing the launcher.')
  }

  private begin(operation: 'installing' | 'removing'): void {
    this.operation = operation
    this.problem = null
    this.revision++
    this.onChanged({ ...this.latest, operation, problem: null })
  }

  private async finish(error?: unknown): Promise<AutolauncherResult> {
    this.problem = error instanceof AutolauncherProblem ? error.message : error === undefined ? null : 'Launcher setup failed. Check the local installation and retry.'
    this.operation = 'idle'
    this.revision++
    const snapshot = await this.get()
    this.onChanged(snapshot)
    return snapshot.problem === null ? { ok: true, snapshot } : { ok: false, problem: snapshot.problem }
  }

  private async readPairing(): Promise<AutolauncherPairing | null> {
    const value = await this.read('pairing.json')
    return value === null ? null : AutolauncherConnection.parse(value)
  }

  private async readInstallation(): Promise<{
    enabled: boolean; configDir: string; configIdentity: string; runtimeChannel: string;
    gatewayAddress: unknown; configFile: string
  } | null> {
    const value = await this.read('installation.json')
    if (value === null) return null
    if (typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1
      || !('enabled' in value) || typeof value.enabled !== 'boolean' || !('configDir' in value)
      || typeof value.configDir !== 'string' || !('configIdentity' in value) || typeof value.configIdentity !== 'string'
      || !('runtimeChannel' in value) || !ConfigIdentityStore.isRuntimeChannel(value.runtimeChannel)
      || !('gatewayAddress' in value) || !('runtime' in value) || typeof value.runtime !== 'object'
      || value.runtime === null || !('configFile' in value.runtime) || typeof value.runtime.configFile !== 'string')
      throw new Error('Invalid installation metadata')
    const path = relative(join(this.directory, 'releases'), value.runtime.configFile)
    if (!isAbsolute(value.runtime.configFile) || !path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`))
      throw new Error('Invalid installed configuration path')
    return { enabled: value.enabled, configDir: value.configDir,
      configIdentity: value.configIdentity, runtimeChannel: value.runtimeChannel,
      gatewayAddress: value.gatewayAddress, configFile: value.runtime.configFile }
  }

  private async installedPairing(installation: {
    configFile: string; configIdentity: string; configDir: string; runtimeChannel: string
  }): Promise<{ publicUrl: string; key: string }> {
    const config = RemoteLauncherConfig.parse(JSON.parse((await readFile(installation.configFile, 'utf8')).replace(/^\uFEFF/, '')))
    if (config.configIdentity !== installation.configIdentity || config.runtimeChannel !== installation.runtimeChannel
      || config.configDir !== installation.configDir) throw new Error('Installed profile mismatch')
    return { publicUrl: config.publicUrl, key: config.key }
  }

  private async read(file: string): Promise<unknown> {
    try { return JSON.parse((await readFile(join(this.directory, file), 'utf8')).replace(/^\uFEFF/, '')) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }
}
