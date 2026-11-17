import type {
  FileChangeBaselineKind,
  FileChangesSnapshot,
  FileChangesWorkingTreeSnapshot,
  FileChangesWorkingTreeSource,
  FileChangesVcsId,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type {
  FileViewerDocument,
  FileViewerLocation,
  FileViewerDocumentSource,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'

export interface FileViewerBaselineHint {
  kind: FileChangeBaselineKind
  revision: string | null
  workingTreeSource?: FileChangesWorkingTreeSource
}

export interface FileViewerPanelParams extends Record<string, unknown> {
  sessionId: string
  source: FileViewerDocumentSource
  baselineHint?: FileViewerBaselineHint
  location?: FileViewerLocation
  /**
   * This document's reading size as a percentage of the configured one. Always present once the
   * parameters are read - a layout written before zoom existed reads as 100 % - so no surface has
   * to decide what an absent zoom means.
   */
  zoomPercent: number
  /** Long lines wrap at the panel edge; a layout written before the toggle existed reads as false. */
  wrapLines: boolean
  /** Documents a link or File Tools replaced in this panel, oldest first; Back returns to the last. */
  history: readonly FileViewerPanelVisit[]
  /** Documents Back left, the latest last; Forward returns to them, and a new open clears them. */
  forward: readonly FileViewerPanelVisit[]
  /** Set by Back or Forward until its document is drawn: the offset to scroll that document to. */
  restoreScroll?: FileViewerScrollRequest
}

export interface FileViewerPanelVisit {
  source: FileViewerDocumentSource
  baselineHint?: FileViewerBaselineHint
  /** Absent when the reader was at the top, or when the document could not be shown. */
  restoreScroll?: FileViewerScrollRequest
}

/** Names the document, so the document still on screen while Back loads is not the one scrolled. */
export interface FileViewerScrollRequest {
  documentKey: string
  scrollTop: number
}

export interface FileViewerChangedOpen {
  document: FileViewerDocument
  snapshot: FileChangesSnapshot | FileChangesWorkingTreeSnapshot
  fileId: string
  baselineHint: FileViewerBaselineHint | null
}

export interface FileChangesWorkingTreeViewModel {
  snapshot: FileChangesWorkingTreeSnapshot | null
  snapshots: readonly FileChangesWorkingTreeSnapshot[]
  selectedSource: FileChangesWorkingTreeSource | null
  loading: boolean
  error: string | null
  requiredLoading: boolean
  requiredError: string | null
  select(source: FileChangesWorkingTreeSource): void
  reload(source?: FileChangesWorkingTreeSource): Promise<FileChangesWorkingTreeSnapshot | null>
  snapshotFor(source: FileChangesWorkingTreeSource): FileChangesWorkingTreeSnapshot | null
}

export interface FileChangesViewModel {
  snapshot: FileChangesSnapshot | null
  groups: FileChangesSnapshot['history']['groups']
  nextCursor: string | null
  preferredVcs: FileChangesVcsId | null
  loading: boolean
  loadingMore: boolean
  error: string | null
  reload(preferredVcs?: FileChangesVcsId | null): Promise<FileChangesSnapshot | null>
  loadMore(): Promise<void>
}
