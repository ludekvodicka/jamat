import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

import { CommandInvoker, type InteractiveCommandResult } from './commandInvoker'
import { TortoiseCommitDialog } from './tortoiseCommitDialog'

export interface TortoiseConflictEditorDeps {
  platform: NodeJS.Platform
  exists(path: string): boolean
  commands: Pick<CommandInvoker, 'launchInteractive'>
}

/**
 * TortoiseSVN's conflict editor for one conflicted path: the text merge for a text conflict, the
 * tree conflict dialog for a tree conflict. The launcher of the commit dialog's kind; it decides
 * nothing and runs no svn itself, and a refusal names the tool it expected.
 */
export class TortoiseConflictEditor {
  private readonly platform: NodeJS.Platform
  private readonly exists: (path: string) => boolean
  private readonly commands: Pick<CommandInvoker, 'launchInteractive'>

  constructor(deps: TortoiseConflictEditorDeps = { platform: process.platform, exists: existsSync, commands: new CommandInvoker() }) {
    this.platform = deps.platform
    this.exists = deps.exists
    this.commands = deps.commands
  }

  /** `absolutePath` is the conflicted file or folder; TortoiseSVN takes it as a whole argument, so any name works. */
  async open(absolutePath: string): Promise<InteractiveCommandResult> {
    const tool = TortoiseCommitDialog.svnToolConst
    if (this.platform !== 'win32' || !this.exists(tool))
      return { ok: false, detail: `TortoiseSVN's conflict editor is unavailable: ${tool}` }
    return this.commands.launchInteractive({
      command: tool,
      cwd: dirname(absolutePath),
      env: process.env,
      args: ['/command:conflicteditor', `/path:${absolutePath}`],
    })
  }
}
