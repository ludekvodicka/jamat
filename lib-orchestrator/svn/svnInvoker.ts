import { spawn } from 'node:child_process'

import { CommandInvoker } from '../shared/commandInvoker'
import type { CommandOutcome, CommandRunner } from '../shared/commandInvoker.types'

export interface SvnInvokerOptions {
  /** As for git: `svn log` and `svn cat` reach the repository server, so the default is far too long. */
  timeoutMilliseconds?: number
}

/**
 * `svn`, run the way this tree runs any command.
 *
 * What this class adds over the shared invoker is `childEnv()` and nothing else. It used to add a
 * character-for-character copy of `CommandRunner`, a copy of `CommandOutcome` whose only difference
 * was renaming `command-missing` to `svn-missing` - a name nothing ever read, because the adapter
 * asks `failure === null` or prints the word into a sentence - and a `spawnImpl` option no caller
 * ever passed, because the test writes its own runner rather than constructing this.
 */
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

  run(cwd: string, args: string[]): Promise<CommandOutcome> {
    return this.invoker.run({ command: 'svn', args, cwd, env: SvnInvoker.childEnv() })
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
