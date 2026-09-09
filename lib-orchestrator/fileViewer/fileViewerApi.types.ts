export type FileViewerViewMode = 'rendered' | 'raw' | 'diff' | 'preview' | 'hex'
export type FileViewerDirectoryNodeKind = 'file' | 'directory' | 'symlink' | 'other'

export type FileViewerDocumentKind =
  | { kind: 'markdown'; flavor: 'markdown' | 'mdext' }
  /** A page, not a language: `rendered` draws it the way a browser would, `raw` shows the source. */
  | { kind: 'html' }
  | { kind: 'code'; language: string }
  | { kind: 'text' }
  | { kind: 'image'; mimeType: string; animated: boolean }
  | { kind: 'svg'; mimeType: 'image/svg+xml' }
  | { kind: 'video'; mimeType: string }
  | { kind: 'hex' }
  | { kind: 'missing' }

export type FileViewerDocumentSource =
  | { kind: 'workspace'; sessionId: string; path: string }
  | { kind: 'external'; sessionId: string; path: string; anchorPath: string }
  | { kind: 'filesystem'; sessionId: string; path: string }
  | { kind: 'detected'; sessionId: string; path: string }

export interface FileViewerLocation {
  line: number
}

export interface FileViewerDocument {
  documentId: string
  documentKey: string
  source: FileViewerDocumentSource
  path: string
  name: string
  size: number | null
  contentVersion: string | null
  kind: FileViewerDocumentKind
  modes: readonly FileViewerViewMode[]
}

export type FileViewerOpenResult =
  | { ok: true; value: FileViewerDocument }
  | {
    ok: false
    code: 'invalid-source' | 'outside-root' | 'not-file' | 'not-found' | 'access-denied'
      | 'proof-expired'
    detail: string
  }

export type FileViewerTextResult =
  | { ok: true; kind: 'text'; text: string; contentVersion: string }
  | { ok: true; kind: 'too-large'; size: number; limit: number; detail: string }
  | { ok: true; kind: 'binary'; detail: string }
  | {
    ok: false
    code: 'document-expired' | 'wrong-owner' | 'document-changed' | 'outside-root'
      | 'not-text' | 'missing'
    detail: string
  }

/**
 * Whether the file a granted document was opened on is still the one on disk.
 *
 * One `stat`, no bytes: the caller asks on its own cadence and decides what to do with the answer,
 * the same bargain `vcsStatusView` makes in the change manager. `missing` is its own case rather
 * than `changed`, because a file that is gone cannot be reopened and a viewer that reloaded on it
 * would replace what is on screen with an error about a path nobody touched.
 */
export type FileViewerVersionResult =
  | { ok: true; kind: 'unchanged' }
  | { ok: true; kind: 'changed'; contentVersion: string }
  | { ok: true; kind: 'missing' }
  | {
    ok: false
    code: 'document-expired' | 'wrong-owner' | 'outside-root'
    detail: string
  }

export interface FileViewerChunk {
  bytes: Uint8Array
  offset: number
  length: number
  totalSize: number
  eof: boolean
  contentVersion: string
}

export type FileViewerChunkResult =
  | { ok: true; value: FileViewerChunk }
  | {
    ok: false
    code: 'document-expired' | 'wrong-owner' | 'document-changed' | 'outside-root'
      | 'invalid-range' | 'missing'
    detail: string
  }

/**
 * What the protocol handler needs to stream one granted file, and nothing else.
 *
 * `resourceAccess` used to answer with `StoredFileViewerResource` - the grant store's own record,
 * carrying `ownerId` and `rootPath` out to a handler that has no business seeing either, and making
 * the protocol's test the single arrow from outside the subsystem into `access/`.
 */
export interface FileViewerGrantedFile {
  path: string
  mimeType: string
  size: number
  contentVersion: string
}

export interface FileViewerDirectoryEntry {
  entryId: string
  name: string
  path: string
  nodeKind: FileViewerDirectoryNodeKind
  targetKind: 'file' | 'directory' | null
  size: number | null
  modifiedAt: number | null
  openable: boolean
  detail: string | null
}

export interface FileViewerDirectory {
  directoryId: string
  rootPath: string
  path: string
  relativePath: string
  canGoParent: boolean
  entries: readonly FileViewerDirectoryEntry[]
  truncated: boolean
}

export type FileViewerDirectoryResult =
  | { ok: true; value: FileViewerDirectory }
  | {
    ok: false
    code:
      | 'directory-expired'
      | 'document-expired'
      | 'entry-expired'
      | 'wrong-owner'
      | 'outside-root'
      | 'not-directory'
      | 'not-file'
      | 'not-found'
      | 'access-denied'
      | 'proof-expired'
    detail: string
  }

export interface FileViewerResource {
  resourceId: string
  mimeType: string
  size: number
  contentVersion: string
}

export type FileViewerResourceResult =
  | { ok: true; value: FileViewerResource }
  | {
    ok: false
    code: 'document-expired' | 'wrong-owner' | 'invalid-reference' | 'outside-root'
      | 'not-file' | 'not-found' | 'access-denied'
    detail: string
  }

export type FileViewerPathResult =
  | { ok: true; path: string }
  | { ok: false; code: 'document-expired' | 'wrong-owner'; detail: string }
