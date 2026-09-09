import { spawn } from 'node:child_process'

import type { GitCommandFailure, GitCommandOutcome, GitCommandRunner } from './git.types'
import { CommandInvoker } from '../shared/commandInvoker'
import type { CommandFailure } from '../shared/commandInvoker.types'

export interface GitInvokerOptions {
  /** The tests script every outcome through this; nothing in production passes it. */
  spawnImpl?: typeof spawn
  /**
   * How long one call may take. The default is the shared one, sized for worktree work that runs for
   * minutes; a read somebody is waiting for passes its own.
   */
  timeoutMilliseconds?: number
}

/**
 * The only place this library starts a git process. It neither throws nor rejects: a git that is not
 * installed, one that hangs and one that floods its output are outcomes, and turning them into typed
 * results is the worktree manager's job.
 *
 * The spawn is always asynchronous. This runs inside the Electron main process, where a synchronous
 * child would freeze the window, the Host socket and every IPC handler for as long as git takes.
 */
export class GitInvoker implements GitCommandRunner {
  private readonly invoker: CommandInvoker

  constructor(options?: GitInvokerOptions) {
    this.invoker = new CommandInvoker({
      spawnImpl: options?.spawnImpl ?? spawn,
      ...(options?.timeoutMilliseconds === undefined
        ? {}
        : { timeoutMilliseconds: options.timeoutMilliseconds }),
    })
  }

  /**
   * The directory is asked about before anything is spawned, because afterwards the answer is gone:
   * a cwd that does not exist fails the spawn with `ENOENT` carrying `path: 'git'` and
   * `syscall: 'spawn git'`, byte for byte what a machine without git produces. Removing a worktree
   * somebody deleted by hand would otherwise be reported as git not being installed.
   */
  async run(cwd: string, args: string[]): Promise<GitCommandOutcome> {
    const outcome = await this.invoker.run({
      command: 'git',
      args,
      cwd,
      env: GitInvoker.childEnv(),
    })
    return {
      ...outcome,
      failure: outcome.failure === null ? null : GitInvoker.failureOf(outcome.failure),
    }
  }

  private static failureOf(failure: CommandFailure): GitCommandFailure {
    if (failure === 'aborted') return 'spawn-failed'
    else if (failure === 'command-missing') return 'git-missing'
    else if (failure === 'cwd-missing') return 'cwd-missing'
    else if (failure === 'spawn-failed') return 'spawn-failed'
    else if (failure === 'timeout') return 'timeout'
    else if (failure === 'output-limit') return 'output-limit'
    else {
      const unhandled: never = failure
      throw new Error(`Unknown command failure: ${JSON.stringify(unhandled)}`)
    }
  }

  /**
   * An inherited `GIT_DIR` or `GIT_WORK_TREE` retargets every command at a repository the caller
   * never named, and a credential prompt in a windowless child is a command that never returns.
   * `GIT_OPTIONAL_LOCKS=0` keeps a plain status from taking the index lock of a repository the user
   * is working in.
   */
  private static childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env))
      if (!key.startsWith('GIT_')) env[key] = value
    env.GIT_OPTIONAL_LOCKS = '0'
    env.GIT_TERMINAL_PROMPT = '0'
    return env
  }
}
