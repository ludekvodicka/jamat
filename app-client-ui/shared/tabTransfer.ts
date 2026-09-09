/**
 * The panel keys, in the one file both processes read. They are SERIALIZED into saved layouts, so
 * changing the value of a member is a migration, while renaming the member itself is a compile
 * error everywhere at once.
 *
 * They are shared rather than private to the renderer because the MAIN process reasons about two of
 * them: it refuses to transfer `welcome` between windows, and it reads a terminal target out of a
 * `terminal` panel's params. Renaming a key on the renderer's side alone left both of those quietly
 * answering about a key nobody registers any more.
 */
export class PanelKeysConst {
  static readonly welcome = 'welcome'
  static readonly terminal = 'terminal'
  static readonly fileViewer = 'fileViewer'
  static readonly directoryViewer = 'directoryViewer'
  static readonly probe = 'probe'
}

/** `prototype` is excluded because a class carries one and it is not a panel. */
export type PanelKey =
  typeof PanelKeysConst[Exclude<keyof typeof PanelKeysConst, 'prototype'>]

export interface WorkspacePanelPresence {
  panelId: string
  key: string
  title: string
  params: Record<string, unknown>
  sessionId: string | null
  presentation: 'session' | 'plain' | null
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

export interface TabTransferData {
  readonly types: readonly string[]
  getData(format: string): string
  setData(format: string, data: string): void
}

export type TabDropPlacement =
  | { kind: 'tab'; referencePanelId: string; index: number }
  | { kind: 'group'; referenceGroupId: string }
  | {
      kind: 'split'
      referenceGroupId: string | null
      direction: 'above' | 'below' | 'left' | 'right'
    }
  | { kind: 'empty' }

export class TabTransferDrag {
  private static readonly customMimeConst = 'application/x-jamat-tab'
  private static readonly textMimeConst = 'text/plain'
  private static readonly textPrefixConst = 'jamat-tab:'

  static write(dataTransfer: Pick<TabTransferData, 'setData'>, token: string): void {
    dataTransfer.setData(TabTransferDrag.customMimeConst, token)
    dataTransfer.setData(
      TabTransferDrag.textMimeConst,
      `${TabTransferDrag.textPrefixConst}${token}`,
    )
  }

  static mayContainToken(
    dataTransfer: Pick<TabTransferData, 'types'> | null,
  ): boolean {
    if (dataTransfer === null)
      return false
    return dataTransfer.types.includes(TabTransferDrag.customMimeConst)
      || dataTransfer.types.includes(TabTransferDrag.textMimeConst)
  }

  static tokenOf(
    dataTransfer: Pick<TabTransferData, 'types' | 'getData'> | null,
  ): string | null {
    if (dataTransfer === null)
      return null
    if (dataTransfer.types.includes(TabTransferDrag.customMimeConst)) {
      const custom = dataTransfer.getData(TabTransferDrag.customMimeConst)
      if (custom.length > 0)
        return custom
    }
    if (dataTransfer.types.includes(TabTransferDrag.textMimeConst)) {
      const text = dataTransfer.getData(TabTransferDrag.textMimeConst)
      if (text.startsWith(TabTransferDrag.textPrefixConst)
        && text.length > TabTransferDrag.textPrefixConst.length)
        return text.slice(TabTransferDrag.textPrefixConst.length)
    }
    return null
  }
}
