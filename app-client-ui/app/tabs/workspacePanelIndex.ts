import type {
  ClaimPanelResult,
  ReconcilePanelsResult,
  TabTransferPayload,
  WorkspacePanelPresence,
  WorkspacePanelSnapshot,
} from '../../shared/tabTransfer'
import { PanelKeysConst } from '../../shared/tabTransfer'
import { TerminalTargetCodec } from '../../shared/terminalTarget'

interface OwnedPanel {
  windowId: string
  panel: WorkspacePanelPresence
}

/** The in-memory owner of every non-welcome panel across all workspace windows. */
export class WorkspacePanelIndex {
  private readonly owners = new Map<string, OwnedPanel>()
  private readonly activeByWindow = new Map<string, string | null>()

  claimOpen(windowId: string, panel: WorkspacePanelPresence): ClaimPanelResult {
    const sameId = this.owners.get(panel.panelId)
    if (sameId?.windowId === windowId) {
      // The same window claiming again is a REFRESH, not a no-op: the stored presence is what
      // `tabs.list` answers with, and a renamed session only ever reached dockview. Leaving the
      // old record standing made the remote API report the title the tab opened with.
      this.own(windowId, panel)
      return { kind: 'granted' }
    }
    else if (sameId)
      return { kind: 'owned', windowId: sameId.windowId, panelId: sameId.panel.panelId }

    const sameSession = this.sessionOwnerOf(panel)
    if (sameSession)
      return {
        kind: 'owned',
        windowId: sameSession.windowId,
        panelId: sameSession.panel.panelId,
      }

    this.own(windowId, panel)
    return { kind: 'granted' }
  }

  /**
   * A copy, because the caller's object outlives the call. The same payload also reaches
   * `TabTransferBroker`, whose lease is copied for the same reason, and a `params` value shared
   * between the two would let an edit on one side show up on the other. `params` is a document
   * rather than a flat record, so the copy goes all the way down.
   */
  private own(windowId: string, panel: WorkspacePanelPresence): void {
    this.owners.set(panel.panelId, { windowId, panel: structuredClone(panel) })
  }

  reconcile(
    windowId: string,
    panels: readonly WorkspacePanelPresence[],
  ): ReconcilePanelsResult {
    const acceptedPanelIds: string[] = []
    const rejectedPanelIds: string[] = []
    const seen = new Set<string>()
    for (const panel of panels) {
      if (seen.has(panel.panelId)) continue
      seen.add(panel.panelId)
      const answer = this.claimOpen(windowId, panel)
      if (answer.kind === 'granted')
        acceptedPanelIds.push(panel.panelId)
      else if (answer.kind === 'owned' || answer.kind === 'refused')
        rejectedPanelIds.push(panel.panelId)
      else
        throw new Error(`Unknown panel claim result: ${JSON.stringify(answer)}`)
    }
    return { acceptedPanelIds, rejectedPanelIds }
  }

  transfer(
    expectedSourceWindowId: string,
    targetWindowId: string,
    panel: TabTransferPayload,
  ): void {
    const owner = this.owners.get(panel.panelId)
    if (owner && owner.windowId !== expectedSourceWindowId)
      throw new Error(`Panel has a different owner: ${panel.panelId}`)
    const sameSession = this.sessionOwnerOf(panel)
    if (sameSession && sameSession.panel.panelId !== panel.panelId)
      throw new Error(`Session already has a panel: ${String(panel.sessionId)}`)
    this.own(targetWindowId, panel)
    if (this.activeByWindow.get(expectedSourceWindowId) === panel.panelId)
      this.activeByWindow.set(expectedSourceWindowId, null)
  }

  release(panelId: string, windowId: string): void {
    if (this.owners.get(panelId)?.windowId !== windowId)
      return
    this.owners.delete(panelId)
    if (this.activeByWindow.get(windowId) === panelId)
      this.activeByWindow.set(windowId, null)
  }

  releaseWindow(windowId: string): void {
    for (const [panelId, owner] of this.owners)
      if (owner.windowId === windowId)
        this.owners.delete(panelId)
    this.activeByWindow.delete(windowId)
  }

  setActivePanel(windowId: string, panelId: string | null): void {
    if (panelId === null) {
      this.activeByWindow.set(windowId, null)
      return
    }
    const owner = this.owners.get(panelId)
    if (!owner || owner.windowId !== windowId)
      throw new Error(`Active panel is not owned by window ${windowId}: ${panelId}`)
    this.activeByWindow.set(windowId, panelId)
  }

  ownerOf(panelId: string): string | null {
    return this.owners.get(panelId)?.windowId ?? null
  }

  panelsOfSession(
    sessionId: string,
  ): readonly { windowId: string; panel: WorkspacePanelPresence }[] {
    return [...this.owners.values()]
      .filter((owner) => owner.panel.sessionId === sessionId)
  }

  panelsOfTerminalTarget(
    targetKey: string,
  ): readonly { windowId: string; panel: WorkspacePanelPresence }[] {
    return [...this.owners.values()]
      .filter((owner) => WorkspacePanelIndex.terminalTargetKeyOf(owner.panel) === targetKey)
  }

  openSessionIds(): readonly string[] {
    return [...new Set([...this.owners.values()]
      .map((owner) => owner.panel.sessionId)
      .filter((sessionId): sessionId is string => sessionId !== null))]
  }

  plainSessionIds(windowId: string): readonly string[] {
    return [...new Set([...this.owners.values()]
      .filter((owner) =>
        owner.windowId === windowId && owner.panel.presentation === 'plain')
      .map((owner) => owner.panel.sessionId)
      .filter((sessionId): sessionId is string => sessionId !== null))]
  }

  visibleTerminalTargetKeys(visible: ReadonlySet<string>): readonly string[] {
    const targetKeys = new Set<string>()
    for (const windowId of visible) {
      const panelId = this.activeByWindow.get(windowId)
      if (panelId === undefined || panelId === null)
        continue
      const owner = this.owners.get(panelId)
      if (owner?.windowId !== windowId)
        continue
      const targetKey = WorkspacePanelIndex.terminalTargetKeyOf(owner.panel)
      if (targetKey !== null)
        targetKeys.add(targetKey)
    }
    return [...targetKeys]
  }

  entries(): readonly { panelId: string; windowId: string }[] {
    return [...this.owners].map(([panelId, owner]) => ({ panelId, windowId: owner.windowId }))
  }

  snapshot(): readonly WorkspacePanelSnapshot[] {
    return [...this.owners.values()].map((owner) => ({
      // Out as deeply as it went in: what a reader is handed is never the index's own object.
      ...structuredClone(owner.panel),
      windowId: owner.windowId,
      active: this.activeByWindow.get(owner.windowId) === owner.panel.panelId,
    }))
  }

  private sessionOwnerOf(panel: WorkspacePanelPresence): OwnedPanel | null {
    const targetKey = WorkspacePanelIndex.terminalTargetKeyOf(panel)
    if (targetKey === null || panel.presentation === 'plain')
      return null
    return [...this.owners.values()].find((owner) =>
      owner.panel.presentation !== 'plain'
      && WorkspacePanelIndex.terminalTargetKeyOf(owner.panel) === targetKey) ?? null
  }

  private static terminalTargetKeyOf(panel: WorkspacePanelPresence): string | null {
    if (panel.key !== PanelKeysConst.terminal) return null
    const reading = TerminalTargetCodec.read(panel.params)
    return reading === null ? null : TerminalTargetCodec.key(reading.target)
  }
}
