export type CommandFailure =
  | 'aborted'
  | 'command-missing'
  | 'cwd-missing'
  | 'spawn-failed'
  | 'timeout'
  | 'output-limit'

export interface CommandOutcome {
  closed?: boolean
  code: number
  stdout: string
  /** The raw stdout, only when the run asked for it with `stdoutBytes`. */
  stdoutBytes?: Buffer
  stderr: string
  failure: CommandFailure | null
}

export interface CommandRunner {
  run(cwd: string, args: string[], options?: CommandRunOptions): Promise<CommandOutcome>
}

export interface CommandRunOptions {
  onSpawn?(pid: number): void
  /** run() reports lifetime separately from its bounded result; a forced wrapper-only exit cannot fulfill it. */
  onLifetime?(exited: Promise<void>): void
  trackClose?: true
  signal?: AbortSignal
  timeoutMs?: number
  retain?: 'all' | { tailBytes: number }
  /** Also answer stdout as bytes: file content that may not be UTF-8 (`svn cat` of a binary file). */
  stdoutBytes?: true
  onStdout?(chunk: string): void
  onStderr?(chunk: string): void
}

export interface CommandInvocation extends CommandRunOptions {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
}
