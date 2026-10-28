import { spawn } from 'node:child_process'

import { CommandInvoker } from '../shared/commandInvoker'
import type { CommandOutcome, CommandRunner, CommandRunOptions } from '../shared/commandInvoker.types'

export interface SvnInvokerOptions {
  /** As for git: `svn log` and `svn cat` reach the repository server, so the default is far too long. */
  timeoutMilliseconds?: number
}

export class SvnInvoker implements CommandRunner {
  private readonly invoker: CommandInvoker

  constructor(options?: SvnInvokerOptions) {
    this.invoker = new CommandInvoker({
      spawnImpl: spawn,
      ...(options?.timeoutMilliseconds === undefined
        ? {}
        : { timeoutMilliseconds: options.timeoutMilliseconds }),
    })
  }

  run(cwd: string, args: string[], options?: CommandRunOptions): Promise<CommandOutcome> {
    const writes = new Set(['add', 'changelist', 'cl', 'checkout', 'co', 'cleanup', 'commit', 'ci', 'copy', 'cp',
      'delete', 'del', 'remove', 'rm', 'import', 'lock', 'merge', 'mkdir', 'move', 'mv', 'rename', 'ren',
      'propdel', 'pdel', 'pd', 'propset', 'pset', 'ps', 'relocate', 'resolve', 'resolved', 'revert',
      'switch', 'sw', 'unlock', 'update', 'up', 'patch'])
    const separator = args.indexOf('--')
    const optionsAndCommand = separator === -1 ? args : args.slice(0, separator)
    const nonInteractive = optionsAndCommand.some((arg) => writes.has(arg)) && !optionsAndCommand.includes('--non-interactive')
    return this.invoker.run({ command: 'svn', args: nonInteractive ? ['--non-interactive', ...args] : args,
      cwd, env: SvnInvoker.childEnv(), ...options })
  }

  private static childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    delete env.SVN_EDITOR
    delete env.SVN_SSH
    // Every parser here reads svn's output as DATA - status letters, error codes, the words in a
    // "path not found" message. A localized svn translates those sentences, so a parser matching on
    // English would quietly answer wrong on a Czech or German machine.
    env.LC_ALL = 'C'
    env.LANG = 'C'
    return env
  }
}
