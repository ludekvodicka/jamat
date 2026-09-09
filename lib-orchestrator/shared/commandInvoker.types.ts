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
  run(cwd: string, args: string[]): Promise<CommandOutcome>
}

export interface CommandInvocation {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}
