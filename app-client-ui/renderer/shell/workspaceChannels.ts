import type { SidebarsStateValue } from '../../shared/sidebarsState'
import type {
  ClaimPanelResult,
  ReconcilePanelsResult,
  TabMoveTarget,
  TabTransferLease,
  TabTransferPayload,
  WorkspacePanelPresence,
} from '../../shared/tabTransfer'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import { IpcFailure } from '../ipc/ipcFailure'

/**
 * What this shell asks the main process for on behalf of its workspace: the tabs channels and the
 * two client-state documents the workspace writes.
 *
 * Every one of them was a method on the shell's composition class, which is what made that class
 * impossible to describe without an "and". They are here because they share one rule rather than
 * because they are small: a channel that refused has no caller left to tell, so it throws and the
 * command that started the work reports the rejection. The two that answer a BOOLEAN are the
 * exceptions, and each says why on itself.
 */
export class WorkspaceChannels {
  /** Answers whether it landed: the caller keeps the change pending until it did. */
  static async saveLayout(layout: string): Promise<boolean> {
    const result = await window.appClient.state.saveLayout(layout)
    if (!result.ok)
      AppClientUiReport.error(`layout not saved: ${result.error}`)
    return result.ok && result.value
  }

  static async clearLayout(): Promise<boolean> {
    const result = await window.appClient.state.clearLayout()
    if (!result.ok)
      AppClientUiReport.error(`layout not cleared: ${result.error}`)
    return result.ok && result.value
  }

  static async claimPanel(panel: WorkspacePanelPresence, activate?: boolean): Promise<ClaimPanelResult> {
    return IpcFailure.unwrap(await window.appClient.tabs.claimPanel(panel, activate))
  }

  static async reconcilePanels(
    panels: readonly WorkspacePanelPresence[],
  ): Promise<ReconcilePanelsResult> {
    return IpcFailure.unwrap(await window.appClient.tabs.reconcilePanels(panels))
  }

  static async releasePanel(panelId: string): Promise<void> {
    IpcFailure.unwrap(await window.appClient.tabs.releasePanel(panelId))
  }

  static async setActivePanel(panelId: string | null): Promise<void> {
    IpcFailure.unwrap(await window.appClient.tabs.setActivePanel(panelId))
  }

  static async tabDragStarted(
    token: string,
    panel: TabTransferPayload,
  ): Promise<void> {
    IpcFailure.unwrap(await window.appClient.tabs.dragStarted(token, panel))
  }

  static async transferPrepare(token: string): Promise<TabTransferLease | null> {
    return IpcFailure.unwrap(await window.appClient.tabs.transferPrepare(token))
  }

  static async transferCommit(token: string): Promise<void> {
    IpcFailure.unwrap(await window.appClient.tabs.transferCommit(token))
  }

  static async transferAbort(token: string): Promise<void> {
    IpcFailure.unwrap(await window.appClient.tabs.transferAbort(token))
  }

  static async movePanel(
    panel: TabTransferPayload,
    target: TabMoveTarget,
  ): Promise<void> {
    IpcFailure.unwrap(await window.appClient.tabs.movePanel(panel, target))
  }

  static async openSessionIds(): Promise<readonly string[]> {
    return IpcFailure.unwrap(await window.appClient.tabs.openSessionIds())
  }

  static async closeTerminalPanel(targetKey: string): Promise<void> {
    IpcFailure.unwrap(await window.appClient.tabs.closeTerminalPanel(targetKey))
  }

  static async publishTerminalRestarted(targetKey: string): Promise<void> {
    IpcFailure.unwrap(await window.appClient.tabs.publishTerminalRestarted(targetKey))
  }

  /**
   * Two different failures, and the caller advances its cursor only past neither: `ok` is the
   * channel answering, `value` is the store saying it wrote. A latched document answers
   * `{ ok: true, value: false }`, which read as success would record a drag as stored.
   */
  static async saveSidebars(state: SidebarsStateValue): Promise<boolean> {
    const result = await window.appClient.state.saveSidebars(state)
    if (!result.ok) {
      AppClientUiReport.error(`sidebar state not saved: ${result.error}`)
      return false
    }
    if (!result.value)
      AppClientUiReport.error('sidebar state was refused by the client state store')
    return result.value
  }
}
