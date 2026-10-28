import { access, constants } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { WindowsCommand } from './launch/windowsCommand'
import { PowerShellHost } from './launch/powershellHost'

export interface AgentCommand {
  path: string
  command: string
  prefixArgs: readonly string[]
}

export class AgentCommandView {
  static async resolve(name: string, environment: NodeJS.ProcessEnv, platform = process.platform): Promise<AgentCommand | null> {
    if (platform === 'win32') {
      const path = WindowsCommand.programOf(name, environment)
      if (path === null) return null
      const image = WindowsCommand.imageOf(name, environment)
      if (image !== null) return { path, command: image, prefixArgs: [] }
      const script = WindowsCommand.powershellScriptOf(name, environment)
      const host = PowerShellHost.exactArgumentHostOf(environment)
      if (script === null || host === null)
        throw new Error(`Cannot run ${path}: its PowerShell shim requires PowerShell 7 with exact argument passing.`)
      return { path, command: host, prefixArgs: ['-NoProfile', '-NonInteractive', '-File', script] }
    }
    for (const directory of (environment.PATH ?? '').split(delimiter)) {
      if (!isAbsolute(directory)) continue
      const path = join(directory, name)
      try { await access(path, constants.X_OK) }
      catch { continue }
      return { path, command: path, prefixArgs: [] }
    }
    return null
  }
}
