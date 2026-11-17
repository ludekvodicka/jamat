export interface StaleSessionTabsPorts {
  /** The sessions an open local terminal panel draws, in any window. */
  openSessionIds(): readonly string[]
  /** Whether a record exists; null while the records file has not been read. */
  knows(sessionId: string): boolean | null
  close(sessionId: string): void
}

/**
 * Closes the terminal tab of a session whose record is gone. Only Remove in the sessions tree and a
 * session removing itself closed its tab; a removal through the CLI, an agent or a peer, or one while
 * no window drew the tab, left a tab that only says "This terminal is gone" (2026-11-16).
 *
 * A collapsed script run is not stale: its tab is handed to the parent, and closing it first would
 * leave that hand-off nothing to replace.
 */
export class StaleSessionTabs {
  private static readonly collapsedMaxConst = 256
  private readonly ports: StaleSessionTabsPorts
  private readonly requested: Set<string>
  private readonly collapsed: Set<string>

  constructor(ports: StaleSessionTabsPorts) {
    this.ports = ports
    this.requested = new Set()
    this.collapsed = new Set()
  }

  collapsedRun(runId: string): void {
    this.collapsed.add(runId)
    for (const oldest of this.collapsed) {
      if (this.collapsed.size <= StaleSessionTabs.collapsedMaxConst) break
      this.collapsed.delete(oldest)
    }
  }

  reconcile(): void {
    const open = new Set(this.ports.openSessionIds())
    for (const sessionId of this.requested)
      if (!open.has(sessionId)) this.requested.delete(sessionId)
    for (const sessionId of open) {
      if (this.requested.has(sessionId) || this.collapsed.has(sessionId) || this.ports.knows(sessionId) !== false) continue
      this.requested.add(sessionId)
      this.ports.close(sessionId)
    }
  }
}
