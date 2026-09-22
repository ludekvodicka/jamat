import { spawnSync } from 'node:child_process'

import { WindowsCommand } from './windowsCommand'

/**
 * The PowerShell on this machine that may run a generated `.ps1` shim, or null when it has none.
 *
 * A shim hands its own arguments on with `& node.exe $args`, and what that does to them is a
 * setting rather than a constant: under `Legacy` passing PowerShell rebuilds ONE command line out of
 * the array, so an argument holding a double quote comes apart. Measured on 2026-09-21 through the
 * Host's own node-pty, against a child that wrote its `process.argv` to a file: `powershell.exe`
 * 5.1 turned `say "hello there"` into two arguments with the quotes eaten, while `pwsh` 7.6.6
 * delivered all eleven test prompts whole.
 *
 * So the question is not which version is installed but what the installed one does, and it is
 * ASKED rather than assumed from a version number: the host prints `$PSNativeCommandArgumentPassing`
 * and only `Standard` and `Windows` are taken. `Windows` is what 7.6.6 answers and means Standard
 * for everything but a few legacy interpreters, which node.exe is not one of. A release old enough
 * to default to `Legacy`, and Windows PowerShell 5.1, which has no such setting to print at all,
 * both fall out of that by themselves.
 *
 * `powershell.exe` is deliberately never looked for. It is the host that is always there and the one
 * that corrupts a quoted argument, so a machine without `pwsh` keeps the refusal it has today.
 */
export class PowerShellHost {
  private static readonly hostNameConst = 'pwsh'
  private static readonly exactModesConst = new Set(['Standard', 'Windows'])
  private static readonly probeTimeoutMsConst = 10_000
  /** Keyed by the resolved host, because the answer is a property of that one installation. */
  private static readonly exactHosts = new Map<string, boolean>()

  /**
   * `probe` is injected for the reason the environment is: what a host answers is a property of what
   * somebody installed, so a test states it instead of asserting whatever this machine happens to
   * have.
   */
  static exactArgumentHostOf(
    environment: NodeJS.ProcessEnv,
    probe?: (hostPath: string) => string | null,
  ): string | null {
    const host = WindowsCommand.imageOf(PowerShellHost.hostNameConst, environment)
    if (host === null) return null
    const known = PowerShellHost.exactHosts.get(host)
    if (known !== undefined) return known ? host : null
    const mode = (probe ?? PowerShellHost.modeOf)(host)
    const exact = mode !== null && PowerShellHost.exactModesConst.has(mode)
    PowerShellHost.exactHosts.set(host, exact)
    return exact ? host : null
  }

  /**
   * `-NoProfile` because the launch passes it too: a profile that sets `Legacy` has to be out of
   * both, or the answer would not be about the run that follows it.
   */
  private static modeOf(hostPath: string): string | null {
    const result = spawnSync(
      hostPath,
      ['-NoProfile', '-NonInteractive', '-Command', '$PSNativeCommandArgumentPassing'],
      { encoding: 'utf8', timeout: PowerShellHost.probeTimeoutMsConst, windowsHide: true },
    )
    if (result.error !== undefined || result.status !== 0) return null
    return result.stdout.trim()
  }
}
