import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { RemoteLauncherConfigData } from '../../../lib-orchestrator/remoteControl/remoteLauncherConfig'
import { AutolauncherProblem } from './autolauncherProblem'

export class WindowsLauncherSetup {
  private readonly bundle: string
  private readonly destination: string

  constructor(bundle: string, destination: string) {
    this.bundle = bundle
    this.destination = destination
  }

  async install(config: RemoteLauncherConfigData, gatewayAddress: string): Promise<void> {
    await this.run('Install', config.configIdentity, config, gatewayAddress)
  }

  async disable(configIdentity: string): Promise<void> {
    await this.run('Disable', configIdentity)
  }

  private async run(action: 'Install' | 'Disable', identity: string,
    config?: RemoteLauncherConfigData, gatewayAddress?: string): Promise<void> {
    const working = await mkdtemp(join(tmpdir(), 'jamat-launcher-setup-'))
    try {
      const configFile = join(working, 'config.json')
      const resultFile = join(working, 'result.json')
      if (config) await writeFile(configFile, JSON.stringify(config))
      const execute = promisify(execFile)
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const account = await execute(join(systemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
        { windowsHide: true, timeout: 5000 })
      const sid = /\bS-1-[\d-]+\b/.exec(account.stdout)?.[0]
      if (!sid) throw new AutolauncherProblem('Could not identify the current Windows account.')
      let exitFailed = false
      try {
        await execute(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(this.bundle, 'install-launcher.ps1'),
          '-Action', action, '-Destination', this.destination, '-ExpectedUserSid', sid,
          '-ExpectedConfigIdentity', identity, '-ResultFile', resultFile,
          ...(config ? ['-ConfigFile', configFile, '-GatewayAddress', gatewayAddress!] : []),
        ], { windowsHide: true, maxBuffer: 64 * 1024 })
      } catch { exitFailed = true }
      let result: unknown
      try { result = JSON.parse((await readFile(resultFile, 'utf8')).replace(/^\uFEFF/, '')) }
      catch { throw new AutolauncherProblem('Windows setup did not finish. Check the administrator prompt and try again.') }
      if (typeof result !== 'object' || result === null || !('ok' in result))
        throw new AutolauncherProblem('Windows setup returned an invalid result.')
      if (exitFailed || result.ok !== true)
        throw new AutolauncherProblem('problem' in result && typeof result.problem === 'string'
          ? result.problem : 'Windows could not configure the launcher.')
    } finally {
      // mkdtemp owns exactly this directory; no path from the renderer enters cleanup.
      await rm(working, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
}
