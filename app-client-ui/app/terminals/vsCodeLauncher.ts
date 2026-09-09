import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

import { ChildEnvironment } from '../../../lib-orchestrator/shared/childEnvironment'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import { ErrorText } from '../../shared/errorText'

/**
 * VS Code, opened on a path the main process resolved from a detection.
 *
 * The path goes in as ONE argv entry and no shell is ever involved: a detected path carries whatever
 * characters a filesystem allows, and none of them may reach a command interpreter.
 */
export class VsCodeLauncher {
  static open(path: string, line: number | null): void {
    const executable = VsCodeLauncher.executable()
    if (executable === null) return VsCodeLauncher.report('no VS Code installation found on PATH')
    const args = line !== null && Number.isInteger(line) ? ['-g', `${path}:${line}`] : [path]
    // Without an `env` of its own this child inherits the whole main process environment, and a
    // development client's is electron-vite's: a VS Code opened here would carry `NODE_ENV` and
    // `NODE_PATH` into every terminal opened inside IT.
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: ChildEnvironment.withoutJamat(process.env),
    })
    child.unref()
    child.on('error', (error) => VsCodeLauncher.report(ErrorText.of(error)))
  }

  /**
   * Windows cannot go through the `code.cmd` shim. Since the CVE-2024-27980 fix, spawning a `.cmd`
   * throws unless a shell runs it, and a shell would concatenate the path into a command line rather
   * than escape it (node's own DEP0190 says so). The `Code.exe` beside the shim takes the same file
   * arguments and needs no interpreter. Elsewhere `code` is a real script and spawns as it is.
   */
  private static executable(): string | null {
    if (process.platform !== 'win32') return 'code'
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      // A relative entry resolves against this process's working directory, where an unprivileged
      // user can leave a `code.cmd` and a `..\Code.exe` for the shell to find first.
      if (!isAbsolute(directory)) continue
      if (!existsSync(join(directory, 'code.cmd'))) continue
      const executable = resolve(directory, '..', 'Code.exe')
      if (existsSync(executable)) return executable
    }
    return null
  }

  private static report(detail: string): void {
    AppClientUiReport.error(`VS Code launch failed: ${detail}`)
  }
}
