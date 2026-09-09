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
  reload(): Promise<void>
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
  reload(preferredVcs?: FileChangesVcsId | null): Promise<void>
  loadMore(): Promise<void>
}
