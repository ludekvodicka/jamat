import type { FileChangesVcsId, FileChangesWorkingTreeSource, FileDiffRequest } from '../fileChangesManager/fileChangesManagerApi.types'
import type { FileViewerDocumentSource } from '../fileViewer/fileViewerApi.types'
import type { TerminalMenuCapture } from '../terminalDetector/terminalDetectorApi.types'

export type RemoteFileRequest =
  | { kind: 'conflict'; path: string }
  | { kind: 'merge-brief' }
  | { kind: 'detect'; capture: TerminalMenuCapture }
  | { kind: 'detected-file' | 'detected-directory'; requestId: string; detectionId: string }
  | { kind: 'restore'; source: FileViewerDocumentSource; supportsDiff: boolean }
  | { kind: 'release' | 'version' | 'document-directory' | 'media' | 'export'; documentId: string }
  | { kind: 'resource-metadata'; resourceId: string; version: string }
  | { kind: 'resource-bytes'; resourceId: string; version: string; offset: number; length: number }
  | { kind: 'bytes'; documentId: string; version: string; offset: number; length: number }
  | { kind: 'root-directory' | 'project-directory' }
  | { kind: 'directory-at'; path: string }
  | { kind: 'directory-entry' | 'open-entry'; directoryId: string; entryId: string }
  | { kind: 'parent-directory'; directoryId: string }
  | { kind: 'relative'; documentId: string; reference: string }

export interface RemoteContentPage {
  transferId: string
  version: string
  offset: number
  totalBytes: number
  base64: string
}

export interface RemoteContentCursor {
  transferId: string
  version: string
  offset: number
}

export interface RemoteFileBytes {
  version: string
  offset: number
  length: number
  totalSize: number
  base64: string
  eof: boolean
}

export type RemoteChangesRequest =
  | { kind: 'list'; preferredVcs: FileChangesVcsId | null }
  | { kind: 'working-tree'; source: FileChangesWorkingTreeSource | null }
  | { kind: 'scoped'; source: FileViewerDocumentSource }
  | { kind: 'history'; snapshotId: string; cursor: string }
  | { kind: 'diff'; request: FileDiffRequest }
  | { kind: 'open'; snapshotId: string; fileId: string }
