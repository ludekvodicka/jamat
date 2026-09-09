import { readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'

export type ProcessStartIdentityProbe =
  | { state: 'alive'; processStartedAt: number }
  | { state: 'dead' }
  | { state: 'unknown'; reason: string }

export type ProcessStartIdentityComparison =
  | { state: 'same'; processStartedAt: number }
  | { state: 'different'; processStartedAt: number }
  | { state: 'dead' }
  | { state: 'unknown'; reason: string }

interface ProcessStartQuery {
  file: string
  args: string[]
  env?: NodeJS.ProcessEnv
  failureMessage: string
}

export class ProcessStartIdentity {
  private static currentValue: number | null = null
  private static readonly windowsScriptConst = [
    "$ErrorActionPreference='Stop'",
    '$target=Get-Process -Id ([int]$env:JAMAT_V3_PROCESS_ID)',
    '[DateTimeOffset]::new($target.StartTime).ToUnixTimeMilliseconds()',
  ].join(';')

  static current(): number {
    if (ProcessStartIdentity.currentValue === null)
      ProcessStartIdentity.currentValue = ProcessStartIdentity.require(process.pid)
    return ProcessStartIdentity.currentValue
  }

  static require(pid: number): number {
    const probe = ProcessStartIdentity.probe(pid)
    if (probe.state === 'alive')
      return probe.processStartedAt
    else if (probe.state === 'dead')
      throw new Error(`Process ${pid} exited before its start identity could be read`)
    else if (probe.state === 'unknown')
      throw new Error(`Cannot read process ${pid} start identity: ${probe.reason}`)
    else
      throw new Error(`Unknown process identity probe: ${JSON.stringify(probe)}`)
  }

  static compare(
    pid: number,
    expectedProcessStartedAt: number,
  ): ProcessStartIdentityComparison {
    return ProcessStartIdentity.comparison(
      ProcessStartIdentity.probe(pid),
      expectedProcessStartedAt,
    )
  }

  static async compareAsync(
    pid: number,
    expectedProcessStartedAt: number,
  ): Promise<ProcessStartIdentityComparison> {
    return ProcessStartIdentity.comparison(
      await ProcessStartIdentity.probeAsync(pid),
      expectedProcessStartedAt,
    )
  }

  /**
   * Does a process with this pid exist?
   *
   * Signal 0 performs the permission and existence checks without delivering anything. EPERM means
   * the process is there but owned by someone else, still alive, which is what the callers ask about.
   *
   * Liveness of a SESSION never derives from a stored pid (a recycled pid would resurrect a dead
   * row); this answers a narrower question, for the two places where a stored pid is the right
   * evidence: a single-instance lock, and a descriptor whose owner may have been killed.
   */
  static isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  static probe(pid: number): ProcessStartIdentityProbe {
    const shortcut = ProcessStartIdentity.shortcut(pid)
    if (shortcut)
      return shortcut
    try {
      if (process.platform === 'win32')
        return ProcessStartIdentity.aliveValue(ProcessStartIdentity.runSync(
          ProcessStartIdentity.windowsQuery(pid),
        ))
      else if (process.platform === 'linux')
        return ProcessStartIdentity.probeLinux(pid)
      else if (process.platform === 'darwin')
        return ProcessStartIdentity.macValue(ProcessStartIdentity.runSync(
          ProcessStartIdentity.macQuery(pid),
        ))
      else
        return {
          state: 'unknown',
          reason: `unsupported platform ${process.platform}`,
        }
    } catch (error) {
      return ProcessStartIdentity.failure(pid, error)
    }
  }

  /**
   * The same evidence as `probe` without the synchronous child process. On Windows the query costs
   * 200-400 ms of hard event-loop blocking per call, so every caller that can await must use this form.
   */
  static async probeAsync(pid: number): Promise<ProcessStartIdentityProbe> {
    const shortcut = ProcessStartIdentity.shortcut(pid)
    if (shortcut)
      return shortcut
    try {
      if (process.platform === 'win32')
        return ProcessStartIdentity.aliveValue(await ProcessStartIdentity.run(
          ProcessStartIdentity.windowsQuery(pid),
        ))
      // Reading /proc costs a page rather than a process, so there is nothing to move off the loop.
      else if (process.platform === 'linux')
        return ProcessStartIdentity.probeLinux(pid)
      else if (process.platform === 'darwin')
        return ProcessStartIdentity.macValue(await ProcessStartIdentity.run(
          ProcessStartIdentity.macQuery(pid),
        ))
      else
        return {
          state: 'unknown',
          reason: `unsupported platform ${process.platform}`,
        }
    } catch (error) {
      return ProcessStartIdentity.failure(pid, error)
    }
  }

  private static comparison(
    probe: ProcessStartIdentityProbe,
    expectedProcessStartedAt: number,
  ): ProcessStartIdentityComparison {
    if (probe.state === 'alive')
      return probe.processStartedAt === expectedProcessStartedAt
        ? { state: 'same', processStartedAt: probe.processStartedAt }
        : { state: 'different', processStartedAt: probe.processStartedAt }
    else if (probe.state === 'dead')
      return probe
    else if (probe.state === 'unknown')
      return probe
    else
      throw new Error(`Unknown process identity probe: ${JSON.stringify(probe)}`)
  }

  /** Everything that is decided without asking the operating system about the process. */
  private static shortcut(pid: number): ProcessStartIdentityProbe | null {
    if (!Number.isInteger(pid) || pid <= 0)
      return { state: 'dead' }
    if (pid === process.pid && ProcessStartIdentity.currentValue !== null)
      return {
        state: 'alive',
        processStartedAt: ProcessStartIdentity.currentValue,
      }
    return ProcessStartIdentity.isPidAlive(pid) ? null : { state: 'dead' }
  }

  // A process that exited between the liveness check and the query is dead, not unverifiable: reporting
  // `unknown` there would block every recovery that requires proof of death.
  private static failure(pid: number, error: unknown): ProcessStartIdentityProbe {
    if (!ProcessStartIdentity.isPidAlive(pid))
      return { state: 'dead' }
    return {
      state: 'unknown',
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  private static windowsQuery(pid: number): ProcessStartQuery {
    return {
      file: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        ProcessStartIdentity.windowsScriptConst,
      ],
      env: { ...process.env, JAMAT_V3_PROCESS_ID: String(pid) },
      failureMessage: 'PowerShell process query failed',
    }
  }

  private static macQuery(pid: number): ProcessStartQuery {
    return {
      file: 'ps',
      args: ['-p', String(pid), '-o', 'lstart='],
      failureMessage: 'ps process query failed',
    }
  }

  private static runSync(query: ProcessStartQuery): string {
    const result = spawnSync(query.file, query.args, {
      encoding: 'utf8',
      windowsHide: true,
      ...(query.env ? { env: query.env } : {}),
    })
    if (result.error)
      throw result.error
    if (result.status !== 0)
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || query.failureMessage,
      )
    return result.stdout
  }

  private static run(query: ProcessStartQuery): Promise<string> {
    return new Promise<string>((resolvePromise, reject) => {
      const child = spawn(query.file, query.args, {
        windowsHide: true,
        ...(query.env ? { env: query.env } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { stdout += chunk })
      child.stderr?.on('data', (chunk: string) => { stderr += chunk })
      child.once('error', reject)
      child.once('close', (status) => status === 0
        ? resolvePromise(stdout)
        : reject(new Error(
            stderr.trim() || stdout.trim() || query.failureMessage,
          )))
    })
  }

  private static probeLinux(pid: number): ProcessStartIdentityProbe {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const suffix = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)
    if (suffix.length < 20)
      throw new Error('Linux process stat has no start-time field')
    return ProcessStartIdentity.aliveValue(suffix[19])
  }

  private static macValue(stdout: string): ProcessStartIdentityProbe {
    return ProcessStartIdentity.aliveValue(String(Date.parse(stdout.trim())))
  }

  private static aliveValue(value: string): ProcessStartIdentityProbe {
    const processStartedAt = Number(value.trim())
    if (!Number.isSafeInteger(processStartedAt) || processStartedAt <= 0)
      throw new Error(`Invalid process start identity: ${JSON.stringify(value.trim())}`)
    return { state: 'alive', processStartedAt }
  }
}
