import type { SidebarSide } from '../../../shared/sidebarsState'

export interface SidebarViewProps {
  side: SidebarSide
  viewKey: string
  width: number
}

export interface SidebarViewDescriptor {
  /** Serialized into the stored state as the active view. Renaming one is a state migration. */
  key: string
  side: SidebarSide
  title: string
  component: React.FunctionComponent<SidebarViewProps>
  /**
   * The one action a view puts on the dock's title line, beside the close button. A view whose main
   * verb would otherwise need a row of its own gets that row back: the title line is already there
   * and already has space to its right.
   *
   * A node and not a component: the dock's `action` is a node already, and nothing drawn here has
   * ever asked which side or how wide the sidebar is. Widen it back if one ever does.
   */
  headerAction?: React.ReactNode
}

/**
 * Which views exist, per side. The same shape as `PanelRegistry` and for the same reason: the
 * stored state names a view by key, so the key has to resolve to a component at startup or the
 * mistake is found by a user on a restored window.
 *
 * Only the GLOBAL sidebars need this. A tab sidebar has no registry because the panel composes its
 * own content and never resolves a key.
 */
export class SidebarRegistry {
  private readonly descriptors = new Map<string, SidebarViewDescriptor>()

  register(descriptor: SidebarViewDescriptor): void {
    if (this.descriptors.has(descriptor.key))
      throw new Error(`Sidebar view key ${JSON.stringify(descriptor.key)} is already registered`)
    this.descriptors.set(descriptor.key, descriptor)
  }

  assertView(key: string): SidebarViewDescriptor {
    const descriptor = this.descriptors.get(key)
    if (!descriptor)
      throw new Error(`Unknown sidebar view: ${JSON.stringify(key)}`)
    return descriptor
  }

  private forSide(side: SidebarSide): readonly SidebarViewDescriptor[] {
    return [...this.descriptors.values()].filter((descriptor) => descriptor.side === side)
  }

  /** Registration order, which is what makes the first registered view a side's default. */
  keysOf(side: SidebarSide): readonly string[] {
    return this.forSide(side).map((descriptor) => descriptor.key)
  }
}
