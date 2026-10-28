import type { SnapinStateDocument } from './snapinContract'
import type { SnapinStore } from './snapinStore'

export class TickGuard {
  private readonly stores: ReadonlyMap<string, Pick<SnapinStore, 'update'>>
  private readonly aborted: Set<string>
  private readonly onRefused: (kind: string) => void

  constructor(stores: ReadonlyMap<string, Pick<SnapinStore, 'update'>>, onRefused: (kind: string) => void = () => {}) {
    this.stores = stores
    this.aborted = new Set()
    this.onRefused = onRefused
  }

  open(kind: string): boolean { return this.stores.has(kind) && !this.aborted.has(kind) }
  abort(kind: string): void { this.aborted.add(kind) }

  async write(kind: string, change: (doc: SnapinStateDocument) => SnapinStateDocument): Promise<boolean> {
    if (!this.open(kind)) return false
    const stored = await this.stores.get(kind)!.update(change)
    if (!stored) { this.aborted.add(kind); this.onRefused(kind) }
    return stored
  }
}
