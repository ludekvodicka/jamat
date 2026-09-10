import type { FileViewerDocumentSource } from '../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { FileChangesVcsId } from '../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'

export type TabControlCommand =
  | { kind: 'open-commit'; requestId: string; panelId: string; vcs: FileChangesVcsId; scopeRoot: string; title: string; messageApplied: boolean }
  | {
      kind: 'open-session'
      requestId: string
      sessionId: string
      tabTitle: string
      plain: boolean
    }
  | {
      kind: 'open-file'
      requestId: string
      panelId: string
      source: FileViewerDocumentSource
      documentKey: string
      title: string
    }
  | { kind: 'focus-panel'; requestId: string; panelId: string }
  | { kind: 'close-panel'; requestId: string; panelId: string }

export type TabControlCommandResult =
  | { kind: 'opened'; panelId: string }
  | { kind: 'focused-existing'; panelId: string; windowId: string }
  | { kind: 'focused'; panelId: string }
  | { kind: 'closed'; panelId: string }
  | { kind: 'file-opened'; panelId: string }
  | { kind: 'commit-opened'; panelId: string }
  | { kind: 'failed'; detail: string }

export interface TabControlAck {
  requestId: string
  result: TabControlCommandResult
}
