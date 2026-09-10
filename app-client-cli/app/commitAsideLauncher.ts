import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import type { RemoteControlStepResult } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'

export interface CommitAsideRequest {
  vcs: 'svn' | 'git'
  scope: string
  messageFile: string | null
  reason: 'jamat-unavailable' | 'session-not-open'
}

export interface CommitAsideResult {
  kind: 'opened-aside'
  tool: 'tortoisesvn' | 'tortoisegit'
  scope: string
  reason: CommitAsideRequest['reason']
}

export class CommitAsideLauncher {
  static readonly svnToolConst = 'C:\\Program Files\\TortoiseSVN\\bin\\TortoiseProc.exe'
  static readonly gitToolConst = 'C:\\Program Files\\TortoiseGit\\bin\\TortoiseGitProc.exe'

  constructor(private readonly deps = { platform: process.platform, exists: existsSync, spawn }) {}

  async open(request: CommitAsideRequest): Promise<RemoteControlStepResult<CommitAsideResult>> {
    let command: string
    let tool: CommitAsideResult['tool']
    if (request.vcs === 'svn') { command = CommitAsideLauncher.svnToolConst; tool = 'tortoisesvn' }
    else if (request.vcs === 'git') { command = CommitAsideLauncher.gitToolConst; tool = 'tortoisegit' }
    else throw new Error(`Unknown commit VCS: ${JSON.stringify(request.vcs)}`)
    if (this.deps.platform !== 'win32' || !this.deps.exists(command))
      return { ok: false, error: { code: 'unavailable', detail: `Tortoise commit dialog is unavailable: ${command}` } }
    const args = ['/command:commit', `/path:${request.scope}`,
      ...(request.messageFile === null ? [] : [`/logmsgfile:${request.messageFile}`])]
    try {
      await new Promise<void>((resolve, reject) => {
        const child = this.deps.spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
        child.once('error', reject)
        child.once('spawn', () => { child.unref(); resolve() })
      })
      return { ok: true, value: { kind: 'opened-aside', tool, scope: request.scope, reason: request.reason } }
    } catch (error) {
      return { ok: false, error: { code: 'unavailable', detail: `${command}: ${String(error)}` } }
    }
  }
}
