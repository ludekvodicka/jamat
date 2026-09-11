import { TortoiseCommitDialog } from '../../lib-orchestrator/shared/tortoiseCommitDialog'

import type { RemoteControlStepResult } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'

export interface CommitAsideRequest {
  vcs: 'svn' | 'git'
  scope: string
  messageFile: string | null
  reason: 'jamat-unavailable' | 'session-not-open' | 'outside-session'
}

export interface CommitAsideResult {
  kind: 'opened-aside'
  tool: 'tortoisesvn' | 'tortoisegit'
  scope: string
  reason: CommitAsideRequest['reason']
}

export class CommitAsideLauncher {
  constructor(private readonly dialog: Pick<TortoiseCommitDialog, 'open'> = new TortoiseCommitDialog()) {}

  async open(request: CommitAsideRequest): Promise<RemoteControlStepResult<CommitAsideResult>> {
    let tool: CommitAsideResult['tool']
    if (request.vcs === 'svn') tool = 'tortoisesvn'
    else if (request.vcs === 'git') tool = 'tortoisegit'
    else throw new Error(`Unknown commit VCS: ${JSON.stringify(request.vcs)}`)
    try {
      const opened = await this.dialog.open(request)
      if (!opened.ok) return { ok: false, error: { code: 'unavailable', detail: opened.detail } }
      return { ok: true, value: { kind: 'opened-aside', tool, scope: request.scope, reason: request.reason } }
    } catch (error) {
      return { ok: false, error: { code: 'unavailable', detail: String(error) } }
    }
  }
}
