import { randomUUID } from 'node:crypto'

import type {
  FileViewerDirectoryEntry,
  FileViewerDocument,
  FileViewerDocumentSource,
} from '../fileViewerApi.types'
import { FileViewerLimits } from '../fileViewerLimits'

export interface StoredFileViewerDocument {
  ownerId: string
  rootPath: string
  document: FileViewerDocument
}

export interface StoredFileViewerDirectory {
  ownerId: string
  rootPath: string
  path: string
  source: FileViewerDocumentSource
  entries: ReadonlyMap<string, StoredFileViewerEntry>
}

export interface StoredFileViewerEntry {
  public: FileViewerDirectoryEntry
  path: string
  targetKind: 'file' | 'directory' | null
}

export interface StoredFileViewerResource {
  resourceId: string
  ownerId: string
  documentId: string
  rootPath: string
  path: string
  mimeType: string
  size: number
  contentVersion: string
}

interface Expiring<T> {
  value: T
  expiresAt: number
}

export class FileViewerGrantStore {
  private static readonly ttlMillisecondsConst = 2 * 60 * 60_000
  private static readonly maxDocumentsConst = 256
  private static readonly maxDirectoriesConst = 128
  private static readonly maxResourcesConst = 512

  private readonly documents = new Map<string, Expiring<StoredFileViewerDocument>>()
  private readonly directories = new Map<string, Expiring<StoredFileViewerDirectory>>()
  private readonly resources = new Map<string, Expiring<StoredFileViewerResource>>()

  constructor(private readonly now: () => number = Date.now) {}

  putDocument(value: StoredFileViewerDocument): void {
    this.prune()
    this.evict(this.documents, FileViewerGrantStore.maxDocumentsConst)
    this.documents.set(value.document.documentId, this.expiring(value))
  }

  document(documentId: string, ownerId: string):
    | { ok: true; value: StoredFileViewerDocument }
    | { ok: false; code: 'document-expired' | 'wrong-owner'; detail: string } {
    this.prune()
    const found = this.documents.get(documentId)
    if (!found) return { ok: false, code: 'document-expired', detail: 'The document token expired' }
    if (found.value.ownerId !== ownerId)
      return { ok: false, code: 'wrong-owner', detail: 'The document belongs to another window' }
    this.touch(this.documents, documentId, found)
    return { ok: true, value: found.value }
  }

  putDirectory(value: Omit<StoredFileViewerDirectory, 'entries'>): string {
    this.prune()
    this.evict(this.directories, FileViewerGrantStore.maxDirectoriesConst)
    const directoryId = randomUUID()
    this.directories.set(directoryId, this.expiring({ ...value, entries: new Map() }))
    return directoryId
  }

  setDirectoryEntries(directoryId: string, entries: ReadonlyMap<string, StoredFileViewerEntry>): void {
    const found = this.directories.get(directoryId)
    if (!found) throw new Error(`Unknown directory token: ${directoryId}`)
    found.value = { ...found.value, entries }
    found.expiresAt = this.now() + FileViewerGrantStore.ttlMillisecondsConst
    this.evictBySize(directoryId)
  }

  /**
   * The ceiling the count above does not give: one grant holds up to 5 000 stored entries, so 128 of
   * them is 640 000 objects held in the main process, refreshed on every touch, long after the panel
   * that asked was closed. Every navigation mints a new grant without releasing the old one, so an
   * explorer walk reaches this on its own.
   *
   * The oldest USE goes first, and never the one just filled in - that is the grant somebody is
   * looking at.
   */
  private evictBySize(keep: string): void {
    let held = 0
    for (const found of this.directories.values()) held += found.value.entries.size
    for (const [id, found] of this.directories) {
      if (held <= FileViewerLimits.directoryEntriesHeldMax) return
      if (id === keep) continue
      held -= found.value.entries.size
      this.directories.delete(id)
    }
  }

  directory(directoryId: string, ownerId: string):
    | { ok: true; value: StoredFileViewerDirectory }
    | { ok: false; code: 'directory-expired' | 'wrong-owner'; detail: string } {
    this.prune()
    const found = this.directories.get(directoryId)
    if (!found) return { ok: false, code: 'directory-expired', detail: 'The directory token expired' }
    if (found.value.ownerId !== ownerId)
      return { ok: false, code: 'wrong-owner', detail: 'The directory belongs to another window' }
    this.touch(this.directories, directoryId, found)
    return { ok: true, value: found.value }
  }

  entry(directoryId: string, entryId: string, ownerId: string):
    | { ok: true; directory: StoredFileViewerDirectory; entry: StoredFileViewerEntry }
    | { ok: false; code: 'directory-expired' | 'entry-expired' | 'wrong-owner'; detail: string } {
    const found = this.directory(directoryId, ownerId)
    if (!found.ok) return found
    const entry = found.value.entries.get(entryId)
    if (!entry) return { ok: false, code: 'entry-expired', detail: 'The directory entry expired' }
    return { ok: true, directory: found.value, entry }
  }

  putResource(input: Omit<StoredFileViewerResource, 'resourceId'>): StoredFileViewerResource {
    this.prune()
    this.evict(this.resources, FileViewerGrantStore.maxResourcesConst)
    const value = { ...input, resourceId: randomUUID() }
    this.resources.set(value.resourceId, this.expiring(value))
    return value
  }

  resource(resourceId: string): StoredFileViewerResource | null {
    this.prune()
    const found = this.resources.get(resourceId)
    if (!found) return null
    this.touch(this.resources, resourceId, found)
    return found.value
  }

  path(documentId: string, ownerId: string):
    | { ok: true; path: string }
    | { ok: false; code: 'document-expired' | 'wrong-owner'; detail: string } {
    const found = this.document(documentId, ownerId)
    return found.ok ? { ok: true, path: found.value.document.path } : found
  }

  /**
   * Everything that document handed out, not only the document.
   *
   * The directories were left behind until 2026-08-24, and a directory grant made from an EXTERNAL
   * document is rooted outside the workspace with nothing but that document's own listing to justify
   * it - so closing the tab left a token that kept listing and opening files under a directory
   * outside the project for the sliding two-hour TTL, while the document token beside it answered
   * `document-expired`.
   */
  revokeDocument(documentId: string, ownerId: string): void {
    const found = this.documents.get(documentId)
    if (!found || found.value.ownerId !== ownerId) return
    this.documents.delete(documentId)
    for (const [resourceId, resource] of this.resources)
      if (resource.value.documentId === documentId) this.resources.delete(resourceId)
    // Matched on the source, because that is the only thing a directory grant keeps of the document
    // it was opened from - and it is the right thing to match on: the source is what justified the
    // root in the first place.
    for (const [directoryId, directory] of this.directories)
      if (directory.value.ownerId === ownerId
        && FileViewerGrantStore.sameSource(directory.value.source, found.value.document.source))
        this.directories.delete(directoryId)
  }

  private static sameSource(
    left: FileViewerDocumentSource,
    right: FileViewerDocumentSource,
  ): boolean {
    return left.kind === right.kind && JSON.stringify(left) === JSON.stringify(right)
  }

  revokeOwner(ownerId: string): void {
    for (const [id, found] of this.documents)
      if (found.value.ownerId === ownerId) this.documents.delete(id)
    for (const [id, found] of this.directories)
      if (found.value.ownerId === ownerId) this.directories.delete(id)
    for (const [id, found] of this.resources)
      if (found.value.ownerId === ownerId) this.resources.delete(id)
  }

  private expiring<T>(value: T): Expiring<T> {
    return { value, expiresAt: this.now() + FileViewerGrantStore.ttlMillisecondsConst }
  }

  private touch<T>(map: Map<string, Expiring<T>>, key: string, found: Expiring<T>): void {
    found.expiresAt = this.now() + FileViewerGrantStore.ttlMillisecondsConst
    map.delete(key)
    map.set(key, found)
  }

  private evict<T>(map: Map<string, Expiring<T>>, limit: number): void {
    while (map.size >= limit) map.delete(map.keys().next().value!)
  }

  private prune(): void {
    const now = this.now()
    for (const [id, found] of this.documents)
      if (found.expiresAt <= now) this.documents.delete(id)
    for (const [id, found] of this.directories)
      if (found.expiresAt <= now) this.directories.delete(id)
    for (const [id, found] of this.resources)
      if (found.expiresAt <= now) this.resources.delete(id)
  }
}
