import type { WebContents } from 'electron'
import type { FileChangesAccess } from './fileChangesAccess'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

export class ServiceFileChangesIpc extends ServiceIpcBase<typeof ServiceFileChangesIpc.channelsConst> {
  static readonly channelsConst = {
    'fileChanges:list': true,
    'fileChanges:working-tree': true,
    'fileChanges:scoped-working-tree': true,
    'fileChanges:history': true,
    'fileChanges:diff': true,
    'fileChanges:open-file': true,
  } as const

  private readonly access: FileChangesAccess
  private readonly ownerIdOf: (sender: WebContents) => string | null

  constructor(access: FileChangesAccess, ownerIdOf: (sender: WebContents) => string | null) {
    super()
    this.access = access
    this.ownerIdOf = ownerIdOf
  }

  initialize(): void {
    this.register('fileChanges:list', (event, sessionId, preferredVcs) =>
      this.access.list(this.ownerId(event.sender), sessionId, preferredVcs))
    this.register('fileChanges:working-tree', (event, sessionId, source) =>
      this.access.workingTree(this.ownerId(event.sender), sessionId, source))
    this.register('fileChanges:scoped-working-tree', (event, source) =>
      this.access.scopedWorkingTree(this.ownerId(event.sender), source))
    this.register('fileChanges:history', (event, snapshotId, cursor) =>
      this.access.history(this.ownerId(event.sender), snapshotId, cursor))
    this.register('fileChanges:diff', (event, request) =>
      this.access.diff(this.ownerId(event.sender), request))
    this.register('fileChanges:open-file', (event, snapshotId, fileId) =>
      this.access.openFile(this.ownerId(event.sender), snapshotId, fileId))
    this.assertComplete(ServiceFileChangesIpc.channelsConst)
  }

  private ownerId(sender: WebContents): string {
    const ownerId = this.ownerIdOf(sender)
    if (ownerId === null) throw new Error('File changes request came from an unknown workspace')
    return ownerId
  }

}
