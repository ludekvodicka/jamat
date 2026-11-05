import type { ServiceCaller } from '../../../lib-orchestrator/clientApi/serviceTransport.types'
import type { FileChangesAccess } from './fileChangesAccess'
import { ServiceIpcBase } from '../../../lib-orchestrator/clientApi/serviceIpcBase'

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
  private readonly ownerIdOf: (sender: ServiceCaller) => string | null

  constructor(access: FileChangesAccess, ownerIdOf: (sender: ServiceCaller) => string | null) {
    super()
    this.owners = new Map()
    this.access = access
    this.ownerIdOf = ownerIdOf
  }

  private readonly owners: Map<string, string>

  initialize(): void {
    this.transport.onCaller('gone', caller => {
      const ownerId = this.owners.get(caller.id)
      this.owners.delete(caller.id)
      if (ownerId !== undefined) this.access.revokeOwner(ownerId)
    })
    this.register('fileChanges:list', (event, sessionId, preferredVcs) =>
      this.access.list(this.ownerId(event), sessionId, preferredVcs))
    this.register('fileChanges:working-tree', (event, sessionId, source) =>
      this.access.workingTree(this.ownerId(event), sessionId, source))
    this.register('fileChanges:scoped-working-tree', (event, source) =>
      this.access.scopedWorkingTree(this.ownerId(event), source))
    this.register('fileChanges:history', (event, snapshotId, cursor) =>
      this.access.history(this.ownerId(event), snapshotId, cursor))
    this.register('fileChanges:diff', (event, request) =>
      this.access.diff(this.ownerId(event), request))
    this.register('fileChanges:open-file', (event, snapshotId, fileId) =>
      this.access.openFile(this.ownerId(event), snapshotId, fileId))
    this.assertComplete(ServiceFileChangesIpc.channelsConst)
  }

  private ownerId(sender: ServiceCaller): string {
    const ownerId = this.ownerIdOf(sender)
    if (ownerId === null) throw new Error('File changes request came from an unknown workspace')
    this.owners.set(sender.id, ownerId)
    return ownerId
  }

}
