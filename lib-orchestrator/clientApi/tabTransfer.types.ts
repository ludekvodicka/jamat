
export interface WorkspacePanelPresence {
  panelId: string
  key: string
  title: string
  params: Record<string, unknown>
  sessionId: string | null
}

export interface WorkspacePanelSnapshot extends WorkspacePanelPresence {
  windowId: string
  active: boolean
}

export interface TabTransferPayload extends WorkspacePanelPresence {}

export type TabMoveTarget =
  | { kind: 'newWindow' }
  | { kind: 'window'; windowId: string }

export type ClaimPanelResult =
  | { kind: 'granted' }
  | { kind: 'owned'; windowId: string; panelId: string }
  | { kind: 'refused'; detail: string }

export interface ReconcilePanelsResult {
  acceptedPanelIds: readonly string[]
  rejectedPanelIds: readonly string[]
}

export interface TabTransferLease {
  token: string
  panel: TabTransferPayload
}
