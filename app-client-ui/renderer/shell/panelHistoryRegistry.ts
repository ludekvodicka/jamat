export type PanelHistoryDirection = 'back' | 'forward'

/**
 * The mouse Back and Forward buttons, sent to the panel in front. The panel does the step itself,
 * because only it can read where its reader is in the document it leaves.
 */
export class PanelHistoryRegistry {
  private readonly handles = new Map<string, (direction: PanelHistoryDirection) => void>()

  register(panelId: string, step: (direction: PanelHistoryDirection) => void): () => void {
    if (this.handles.has(panelId))
      throw new Error(`History is already registered for panel ${panelId}`)
    this.handles.set(panelId, step)
    return () => {
      if (this.handles.get(panelId) === step) this.handles.delete(panelId)
    }
  }

  /** A panel without history, or no panel, ignores the button. */
  step(panelId: string | null, direction: PanelHistoryDirection): void {
    if (panelId !== null) this.handles.get(panelId)?.(direction)
  }
}
