export type CommandFailure =
  | 'aborted'
  | 'command-missing'
  | 'cwd-missing'
  | 'spawn-failed'
  | 'timeout'
  | 'output-limit'

export interface CommandOutcome {
  code: number
  stdout: string
  stderr: string
  failure: CommandFailure | null
}

export interface CommandRunner {
  run(cwd: string, args: string[], options?: CommandRunOptions): Promise<CommandOutcome>
}

export interface CommandRunOptions {
  onStdout?(chunk: string): void
}

export interface CommandInvocation extends CommandRunOptions {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}
