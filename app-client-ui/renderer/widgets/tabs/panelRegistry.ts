import type { IDockviewPanelProps } from 'dockview'

import type { PanelKey } from '../../../shared/tabTransfer'

export interface PanelDescriptor {
  /**
   * Serialized into saved layouts. Renaming one means writing a layout migration first, which is
   * why the set is closed: a panel registered under a key the main process has never heard of
   * looks right until a window transfer or a terminal target has to reason about it.
   */
  key: PanelKey
  title: string
  component: React.FunctionComponent<IDockviewPanelProps>
}

/**
 * The one place that knows which panel keys exist. It refuses a duplicate key rather than letting
 * the second registration shadow the first, and refuses an unknown key rather than opening a blank
 * panel: both mistakes are otherwise found by a user, on a restored layout.
 */
export class PanelRegistry {
  private readonly descriptors = new Map<string, PanelDescriptor>()

  register(descriptor: PanelDescriptor): void {
    if (this.descriptors.has(descriptor.key))
      throw new Error(`Panel key ${JSON.stringify(descriptor.key)} is already registered`)
    this.descriptors.set(descriptor.key, descriptor)
  }

  components(): Record<string, React.FunctionComponent<IDockviewPanelProps>> {
    return Object.fromEntries([...this.descriptors.values()].map((descriptor) =>
      [descriptor.key, descriptor.component]))
  }

  assertComponent(key: string): React.FunctionComponent<IDockviewPanelProps> {
    const descriptor = this.descriptors.get(key)
    if (!descriptor)
      throw new Error(`Unknown panel component: ${JSON.stringify(key)}`)
    return descriptor.component
  }

  titleOf(key: string): string {
    return this.descriptors.get(key)?.title ?? key
  }
}
