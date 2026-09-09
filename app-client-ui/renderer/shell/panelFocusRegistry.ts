export type PanelSurfaceFocus = () => void

/**
 * Where the keyboard goes when a panel is put in front, per renderer document.
 *
 * A panel takes the caret itself when dockview says it became active, and that covers everything
 * except the clicks a person actually makes. Dockview fires nothing at all when the tab or the row
 * clicked is the one already in front - `doSetActivePanel` returns on the panel it already holds -
 * and the click has just put the DOM focus on whatever was under it: the tab element, or the tree
 * row's own button. Both end with a live terminal that owns no focus and typing that goes nowhere.
 *
 * So the two surfaces a person clicks say where the caret belongs, and the panel that owns the
 * terminal is the one that knows how to reach it. Keyed by PANEL rather than by session, because
 * what a tab click knows about itself is its panel id, and a plain tab and a session tab of one
 * session are two panels.
 */
export class PanelFocusRegistry {
  private readonly surfaces = new Map<string, PanelSurfaceFocus>()

  /** The returned function retires THIS registration alone: a late unmount cannot delete a newer one. */
  register(panelId: string, focus: PanelSurfaceFocus): () => void {
    this.surfaces.set(panelId, focus)
    return () => {
      if (this.surfaces.get(panelId) === focus) this.surfaces.delete(panelId)
    }
  }

  /** False is a panel with nothing to type into: a file viewer, the welcome tab, or no tab at all. */
  focus(panelId: string | null): boolean {
    if (panelId === null)
      return false
    const surface = this.surfaces.get(panelId)
    if (surface === undefined)
      return false
    surface()
    return true
  }
}
