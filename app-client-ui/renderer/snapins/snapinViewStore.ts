import type { SnapinView } from '../../../lib-orchestrator/snapins/snapinsApi.types'
import { AppControl } from '../ipc/appControl'
import { SnapshotStore } from '../ipc/snapshotStore'

export class SnapinViewStore extends SnapshotStore<SnapinView> {
  readonly catalog: ReturnType<typeof SnapinViewStore.readCatalog>

  constructor(kind: string) {
    super('The snap-in', {
      read: () => AppControl.value('snapins.view', { kind }),
      subscribe: (onChanged) => window.appClient.onSnapinsChanged((event) => { if (event.kind === kind) onChanged() }),
      reportError: (message) => console.error(message),
    })
    this.catalog = SnapinViewStore.readCatalog()
  }

  private static readCatalog() { return AppControl.value('snapins.list', {}) }
}
