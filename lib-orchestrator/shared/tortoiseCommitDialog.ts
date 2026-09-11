import { existsSync } from 'node:fs'
import { CommandInvoker, type InteractiveCommandResult } from './commandInvoker'

export interface TortoiseCommitRequest {
  vcs: 'svn' | 'git'
  scope: string
  messageFile: string | null
}

export class TortoiseCommitDialog {
  static readonly svnToolConst = 'C:\\Program Files\\TortoiseSVN\\bin\\TortoiseProc.exe'
  static readonly gitToolConst = 'C:\\Program Files\\TortoiseGit\\bin\\TortoiseGitProc.exe'

  constructor(private readonly deps: {
    platform: NodeJS.Platform
    exists(path: string): boolean
    commands: Pick<CommandInvoker, 'launchInteractive'>
  } = { platform: process.platform, exists: existsSync, commands: new CommandInvoker() }) {}

  async open(request: TortoiseCommitRequest): Promise<InteractiveCommandResult> {
    let command: string
    if (request.vcs === 'svn') command = TortoiseCommitDialog.svnToolConst
    else if (request.vcs === 'git') command = TortoiseCommitDialog.gitToolConst
    else throw new Error(`Unknown commit VCS: ${JSON.stringify(request.vcs)}`)
    if (this.deps.platform !== 'win32' || !this.deps.exists(command))
      return { ok: false, detail: `Tortoise commit dialog is unavailable: ${command}` }
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env))
      if (!key.toUpperCase().startsWith('GIT_')) env[key] = value
    return this.deps.commands.launchInteractive({ command, cwd: request.scope, env,
      args: ['/command:commit', `/path:${request.scope}`,
        ...(request.messageFile === null ? [] : [`/logmsgfile:${request.messageFile}`])] })
  }
}
