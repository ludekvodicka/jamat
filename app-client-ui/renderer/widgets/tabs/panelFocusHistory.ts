/** What a replaced preview needs to come back as it was: its component, title and last parameters. */
export interface PanelReopen {
  key: string
  title: string
  params: Record<string, unknown>
}

export interface PanelFocusEntry {
  panelId: string
  /** Set while a newer preview holds this panel's place; null while the panel is open. */
  reopen: PanelReopen | null
}

/**
 * The panels this window had in front, most recent first. Closing the panel in front goes back to
 * the one before it, not to whatever tab happens to sit beside it.
 *
 * A preview that a newer preview replaced stays in line with what it showed, because nobody closed
 * it: a person who previews B from A and then finishes B expects A back. Every other way a panel
 * leaves drops it, so a tab someone closed on purpose never returns by itself.
 */
export class PanelFocusHistory {
  private static readonly lengthMaxConst = 32
  private entries: readonly PanelFocusEntry[] = []

  visited(panelId: string): void {
    this.entries = [
      { panelId, reopen: null },
      ...this.entries.filter((entry) => entry.panelId !== panelId),
    ].slice(0, PanelFocusHistory.lengthMaxConst)
  }

  /** Called before the replaced preview goes, so `removed` keeps it. */
  replaced(panelId: string, reopen: PanelReopen): void {
    this.entries = this.entries.map((entry) => entry.panelId === panelId ? { panelId, reopen } : entry)
  }

  removed(panelId: string): void {
    this.entries = this.entries.filter((entry) => entry.panelId !== panelId || entry.reopen !== null)
  }

  forget(panelId: string): void {
    this.entries = this.entries.filter((entry) => entry.panelId !== panelId)
  }

  /** Most recent first, without the panel that is leaving. */
  before(panelId: string): readonly PanelFocusEntry[] {
    return this.entries.filter((entry) => entry.panelId !== panelId)
  }

  clear(): void {
    this.entries = []
  }
}
