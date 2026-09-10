import type { WebContents } from 'electron'

import { ServiceIpcBase } from '../shared/serviceIpcBase'
import type { VersioningCommitManager } from './versioningCommitManager'
import type { ServiceFileChangesIpc } from '../fileChanges/serviceFileChangesIpc'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import type { ExternalDiffLauncher } from './externalDiffLauncher'

export class ServiceVersioningCommitIpc extends ServiceIpcBase<typeof ServiceVersioningCommitIpc.channelsConst> {
  static readonly channelsConst = {
    'versioning:commit-open-draft': true,
    'versioning:commit-read': true,
    'versioning:commit-files': true,
    'versioning:commit-external-diff': true,
    'versioning:commit-open-tab': true,
    'versioning:commit-set-message': true,
    'versioning:commit-run': true,
    'versioning:commit-close': true,
    'versioning:commit-open-sessions': true,
  } as const

  constructor(private readonly manager: VersioningCommitManager, private readonly ownerIdOf: (sender: WebContents) => string | null,
    private readonly files: Pick<ServiceFileChangesIpc, 'workingTree'>,
    private readonly openTab: (sessionId: string, vcs: 'svn' | 'git', scope?: string) => Promise<ReturnType<AppClientUiIpcInvokeMap['versioning:commit-open-tab']>>,
    private readonly diff: Pick<ExternalDiffLauncher, 'launch'>) { super() }

  initialize(): void {
    this.register('versioning:commit-external-diff', (event, request) => this.diff.launch(this.owner(event.sender), request))
    this.register('versioning:commit-open-tab', (event, sessionId, vcs, scope) => { this.owner(event.sender); return this.openTab(sessionId, vcs, scope) })
    this.register('versioning:commit-open-draft', async (event, sessionId, vcs, scope) => {
      const ownerId = this.owner(event.sender)
      const prepared = await this.manager.prepare(sessionId, vcs, scope, null)
      if (prepared.ok) {
        if (event.sender.isDestroyed()) this.manager.releaseUnattached(prepared.value.draftId)
        else this.manager.attach(prepared.value.draftId, ownerId)
      }
      return prepared
    })
    this.register('versioning:commit-read', (event, draftId) => this.manager.read(this.owner(event.sender), draftId))
    this.register('versioning:commit-files', async (event, draftId) => {
      const ownerId = this.owner(event.sender)
      const draft = this.manager.read(ownerId, draftId)
      if (draft === null) return { ok: false, code: 'invalid-context', detail: 'The commit dialog no longer exists' }
      return this.files.workingTree(ownerId, draft.sessionId, draft.source, draft.scopeRoot)
    })
    this.register('versioning:commit-set-message', (event, draftId, message) => this.manager.setMessage(this.owner(event.sender), draftId, message))
    this.register('versioning:commit-run', (event, request) => this.manager.run(this.owner(event.sender), request))
    this.register('versioning:commit-close', (event, draftId) => this.manager.release(draftId, this.owner(event.sender)))
    this.register('versioning:commit-open-sessions', (event) => { this.owner(event.sender); return this.manager.openSessions() })
    this.assertComplete(ServiceVersioningCommitIpc.channelsConst)
  }

  private owner(sender: WebContents): string {
    const ownerId = this.ownerIdOf(sender)
    if (ownerId === null) throw new Error('Commit request came from an unknown workspace')
    // A reload keeps draft text and results; only a dead window gives up its ownership.
    this.watchSender(sender, () => this.manager.revokeOwner(ownerId), false)
    return ownerId
  }
}
