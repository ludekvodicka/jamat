import { createHash, randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from 'node:path'

import { ErrorText } from '../shared/errorText'
import { PathCompare } from '../shared/pathCompare'
import { FileViewerGrantBoundary } from './access/fileViewerGrantBoundary'
import {
  FileViewerGrantStore,
  type StoredFileViewerResource,
} from './access/fileViewerGrantStore'
import { FileContentNotAFileError, FileContentReader } from './content/fileContentReader'
import { FileFormatRegistry } from './content/fileFormatRegistry'
import { FileDirectoryReader } from './directory/fileDirectoryReader'
import type {
  FileViewerChunkResult,
  FileViewerDirectory,
  FileViewerDirectoryResult,
  FileViewerDocument,
  FileViewerDocumentSource,
  FileViewerGrantedFile,
  FileViewerOpenResult,
  FileViewerPathResult,
  FileViewerResource,
  FileViewerResourceResult,
  FileViewerTextResult,
  FileViewerVersionResult,
} from './fileViewerApi.types'

export interface FileViewerChangedFileAccess {
  sessionId: string
  cwd: string
  path: string
  nodeKind: 'file' | 'directory'
}

export interface FileViewerDeps {
  /** The one slot a caller fills: a test that wants to look at the grants it handed out. */
  grants?: FileViewerGrantStore
}

/**
 * Every door into a document or a directory, and the proof each one needs.
 *
 * **The five doors keep their own cascades on purpose.** They look alike - resolve, prove the path
 * is inside a root, open - and what differs between them is exactly the part that matters: which
 * root the path is proved against, and when. `openWorkspace` proves against the session's own root;
 * `openFilesystem` proves against the volume root and does it TWICE, before and after `realpath`,
 * because a path that resolves out of the volume is a different question from one that was written
 * out of it; `openChanged` proves against an anchor's parent; `openDetected` walks a cascade of
 * roots and takes the narrowest that can prove itself again on restore. Folding them into one helper
 * would hide the differences behind a parameter, and the differences are the security.
 *
 * What they DO share is here rather than repeated: the containment check itself is
 * `access/FileViewerGrantBoundary`, beside the store whose grants it makes mean something, and every
 * read that hands bytes back asks it again.
 */
export class FileViewer {
  private readonly grants: FileViewerGrantStore
  private readonly content: FileContentReader
  private readonly directories: FileDirectoryReader

  constructor(deps?: FileViewerDeps) {
    this.grants = deps?.grants ?? new FileViewerGrantStore()
    this.content = new FileContentReader()
    this.directories = new FileDirectoryReader()
  }

  async openWorkspace(
    ownerId: string,
    sessionId: string,
    cwd: string,
    path: string,
    supportsDiff = false,
  ): Promise<FileViewerOpenResult> {
    try {
      const rootPath = await realpath(cwd)
      const requested = isAbsolute(path) ? resolve(path) : resolve(rootPath, path)
      const realPath = await FileViewer.existingPathOrMarkdown(requested)
      if (!PathCompare.isInside(rootPath, realPath))
        return { ok: false, code: 'outside-root', detail: 'The file is outside the session root' }
      return await this.openExisting(
        ownerId,
        rootPath,
        realPath,
        { kind: 'workspace', sessionId, path: realPath },
        supportsDiff,
      )
    }
    catch (error) { return FileViewer.openFailure(error) }
  }

  async openFilesystem(
    ownerId: string,
    sessionId: string,
    cwd: string,
    path: string,
    supportsDiff = false,
  ): Promise<FileViewerOpenResult> {
    if (!isAbsolute(path))
      return { ok: false, code: 'invalid-source', detail: 'The filesystem path is not absolute' }
    try {
      const workspaceRoot = await realpath(cwd)
      const rootPath = FileViewer.filesystemRoot(workspaceRoot)
      const requested = resolve(path)
      if (!PathCompare.isInside(rootPath, requested))
        return { ok: false, code: 'outside-root', detail: 'The file is outside the session filesystem root' }
      const realPath = await FileViewer.existingPathOrMarkdown(requested)
      if (!PathCompare.isInside(rootPath, realPath))
        return { ok: false, code: 'outside-root', detail: 'The file is outside the session filesystem root' }
      return await this.openExisting(
        ownerId,
        rootPath,
        realPath,
        { kind: 'filesystem', sessionId, path: realPath },
        supportsDiff,
      )
    }
    catch (error) { return FileViewer.openFailure(error) }
  }

  async openChanged(
    ownerId: string,
    access: FileViewerChangedFileAccess,
  ): Promise<FileViewerOpenResult> {
    if (access.nodeKind !== 'file')
      return { ok: false, code: 'not-file', detail: 'A directory cannot be opened as a document' }
    try {
      const rootPath = await realpath(access.cwd)
      const requested = resolve(access.path)
      let realPath = requested
      let exists = true
      try { realPath = await realpath(requested) }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
        exists = false
        // A file that is not there cannot be resolved, but its directory usually can, and the path
        // has to end up in the same form as `rootPath` or the comparison below is between two
        // spellings of the same place. Without this a caller that wrote the path any way other than
        // the canonical one - an 8.3 short name on Windows, a symlinked parent - gets a file inside
        // its own session root classified as external, and a grant rooted at a path that stops
        // proving itself the moment the file appears.
        try { realPath = join(await realpath(dirname(requested)), basename(requested)) }
        catch { /* the parent is gone too, so the path as written is all there is to go on */ }
      }
      const workspace = PathCompare.isInside(rootPath, realPath)
      const source: FileViewerDocumentSource = workspace
        ? { kind: 'workspace', sessionId: access.sessionId, path: realPath }
        : {
          kind: 'external',
          sessionId: access.sessionId,
          path: realPath,
          anchorPath: requested,
        }
      const grantRoot = workspace ? rootPath : exists ? await realpath(dirname(realPath)) : dirname(realPath)
      return await this.openTrusted(
        ownerId,
        grantRoot,
        realPath,
        source,
        true,
        true,
      )
    }
    catch (error) { return FileViewer.openFailure(error) }
  }

  async restoreExternal(
    ownerId: string,
    access: FileViewerChangedFileAccess,
    targetPath: string,
    supportsDiff: boolean,
  ): Promise<FileViewerOpenResult> {
    if (access.nodeKind !== 'file')
      return { ok: false, code: 'not-file', detail: 'The external anchor is not a file' }
    try {
      const anchorParent = await realpath(dirname(access.path))
      const target = await FileViewer.existingPathOrMarkdown(resolve(targetPath))
      if (!PathCompare.isInside(anchorParent, target))
        return { ok: false, code: 'outside-root', detail: 'The file is outside the external directory grant' }
      return await this.openExisting(
        ownerId,
        anchorParent,
        target,
        {
          kind: 'external',
          sessionId: access.sessionId,
          path: target,
          anchorPath: resolve(access.path),
        },
        supportsDiff,
      )
    }
    catch (error) { return FileViewer.openFailure(error) }
  }

  /**
   * Main-only path boundary: `path` comes from a terminal detection lookup or an authorized local
   * control request, never from a renderer or remote peer. The cascade picks the narrowest source
   * that can prove itself again on restore, so only a target no session cwd covers falls through to
   * the `detected` source and its target-root grant.
   */
  async openDetected(
    ownerId: string,
    sessionId: string,
    cwd: string | null,
    path: string,
    supportsDiff = false,
  ): Promise<FileViewerOpenResult> {
    try {
      const rootPath = cwd === null ? null : await realpath(cwd)
      const requested = rootPath !== null && !isAbsolute(path)
        ? resolve(rootPath, path)
        : resolve(path)
      const realPath = await FileViewer.existingPathOrMarkdown(requested)
      if (rootPath !== null) {
        if (PathCompare.isInside(rootPath, realPath))
          return await this.openExisting(
            ownerId,
            rootPath,
            realPath,
            { kind: 'workspace', sessionId, path: realPath },
            supportsDiff,
          )
        const sessionRoot = FileViewer.filesystemRoot(rootPath)
        if (PathCompare.isInside(sessionRoot, realPath))
          return await this.openExisting(
            ownerId,
            sessionRoot,
            realPath,
            { kind: 'filesystem', sessionId, path: realPath },
            supportsDiff,
          )
      }
      return await this.openExisting(
        ownerId,
        FileViewer.filesystemRoot(realPath),
        realPath,
        { kind: 'detected', sessionId, path: realPath },
        supportsDiff,
      )
    }
    catch (error) { return FileViewer.openFailure(error) }
  }

  async text(ownerId: string, documentId: string): Promise<FileViewerTextResult> {
    const found = this.grants.document(documentId, ownerId)
    if (!found.ok) return found
    const document = found.value.document
    // Named rather than excluded. The text kinds were whatever was left over, so a kind added later
    // - a pdf, an archive - would have been read as UTF-8 and handed to the renderer as text.
    if (document.kind.kind === 'missing')
      return { ok: false, code: 'missing', detail: 'The document no longer exists' }
    if (document.kind.kind !== 'markdown' && document.kind.kind !== 'code'
      && document.kind.kind !== 'text' && document.kind.kind !== 'svg'
      && document.kind.kind !== 'html')
      return { ok: false, code: 'not-text', detail: 'The document is not a text format' }
    if (!await FileViewerGrantBoundary.insideGrant(found.value.rootPath, document.path))
      return { ok: false, code: 'outside-root', detail: 'The document moved outside its grant' }
    const read = await this.content.text(document.path, document.contentVersion)
    if (read.kind === 'text') return { ok: true, ...read }
    else if (read.kind === 'too-large')
      return {
        ok: true,
        ...read,
        detail: `The file is ${read.size} bytes; full text is limited to ${read.limit} bytes`,
      }
    else if (read.kind === 'binary') return { ok: true, ...read }
    else if (read.kind === 'missing')
      return { ok: false, code: 'missing', detail: 'The document no longer exists' }
    else if (read.kind === 'changed')
      return { ok: false, code: 'document-changed', detail: 'The document changed; refresh it' }
    else throw new Error(`Unknown file text read: ${JSON.stringify(read)}`)
  }

  /**
   * Whether the granted document still matches its file, without reading a byte of it.
   *
   * The grant is what makes this cheap AND safe: the path is one this owner already proved, so the
   * answer costs one `stat` and no caller ever names a path. A document opened while its file was
   * absent - which `openChanged` allows - holds no version, so a file that is still absent is
   * `unchanged` rather than a `missing` a viewer would keep reporting.
   */
  async version(ownerId: string, documentId: string): Promise<FileViewerVersionResult> {
    const found = this.grants.document(documentId, ownerId)
    if (!found.ok) return found
    const document = found.value.document
    // The `stat` comes BEFORE the containment check here, the one place in this class where it
    // does, because the containment check answers false for a path that no longer exists - which
    // is the very case this method was added to report. Nothing is handed back either way: a file
    // that is there is still checked, and a file that is gone has nothing to leak.
    const read = await this.content.version(document.path)
    if (read.kind === 'missing')
      return document.contentVersion === null
        ? { ok: true, kind: 'unchanged' }
        : { ok: true, kind: 'missing' }
    else if (read.kind === 'version') {
      if (!await FileViewerGrantBoundary.insideGrant(found.value.rootPath, document.path))
        return { ok: false, code: 'outside-root', detail: 'The document moved outside its grant' }
      return read.contentVersion === document.contentVersion
        ? { ok: true, kind: 'unchanged' }
        : { ok: true, kind: 'changed', contentVersion: read.contentVersion }
    }
    else throw new Error(`Unknown file version read: ${JSON.stringify(read)}`)
  }

  async chunk(ownerId: string, documentId: string, offset: number): Promise<FileViewerChunkResult> {
    const found = this.grants.document(documentId, ownerId)
    if (!found.ok) return found
    const document = found.value.document
    if (document.kind.kind === 'missing')
      return { ok: false, code: 'missing', detail: 'The document no longer exists' }
    if (!await FileViewerGrantBoundary.insideGrant(found.value.rootPath, document.path))
      return { ok: false, code: 'outside-root', detail: 'The document moved outside its grant' }
    const read = await this.content.chunk(document.path, document.contentVersion, offset)
    if (read.kind === 'chunk') return { ok: true, value: read.value }
    else if (read.kind === 'missing')
      return { ok: false, code: 'missing', detail: 'The document no longer exists' }
    else if (read.kind === 'changed')
      return { ok: false, code: 'document-changed', detail: 'The document changed; refresh it' }
    else if (read.kind === 'invalid-range')
      return { ok: false, code: 'invalid-range', detail: read.detail }
    else throw new Error(`Unknown file chunk read: ${JSON.stringify(read)}`)
  }

  async rootDirectory(
    ownerId: string,
    sessionId: string,
    cwd: string,
  ): Promise<FileViewerDirectoryResult> {
    try {
      const rootPath = await realpath(cwd)
      return await this.openDirectory(ownerId, rootPath, rootPath, {
        kind: 'workspace',
        sessionId,
        path: rootPath,
      })
    }
    catch (error) { return FileViewer.directoryFailure(error) }
  }

  async projectDirectory(
    ownerId: string,
    sessionId: string,
    cwd: string,
  ): Promise<FileViewerDirectoryResult> {
    try {
      const path = await realpath(cwd)
      return await this.openDirectory(ownerId, FileViewer.filesystemRoot(path), path, {
        kind: 'filesystem',
        sessionId,
        path,
      })
    }
    catch (error) { return FileViewer.directoryFailure(error) }
  }

  /**
   * Trusted-path primitive: `path` may only be supplied by main after a terminal detection proved
   * it, never by a renderer, and it is the REAL path that proof was taken on. `provenRoot` is the
   * root it was proved against; the grant reaches the root of the target's own drive or UNC share,
   * so a caller that proved a different one - which is what a junction across volumes produces -
   * is refused rather than handed the root nobody proved.
   */
  async directoryAt(
    ownerId: string,
    sessionId: string,
    path: string,
    provenRoot: string,
  ): Promise<FileViewerDirectoryResult> {
    try {
      const realPath = await realpath(resolve(path))
      if (PathCompare.comparable(realPath) !== PathCompare.comparable(path))
        return { ok: false, code: 'outside-root', detail: 'The directory is not the path that was proved' }
      const rootPath = FileViewer.filesystemRoot(realPath)
      if (PathCompare.comparable(rootPath) !== PathCompare.comparable(provenRoot))
        return { ok: false, code: 'outside-root', detail: 'The directory is outside the proved filesystem root' }
      return await this.openDirectory(ownerId, rootPath, realPath, {
        kind: 'detected',
        sessionId,
        path: realPath,
      })
    }
    catch (error) { return FileViewer.directoryFailure(error) }
  }

  async directoryForDocument(
    ownerId: string,
    documentId: string,
  ): Promise<FileViewerDirectoryResult> {
    const found = this.grants.document(documentId, ownerId)
    if (!found.ok) return found
    if (found.value.document.kind.kind === 'missing')
      return { ok: false, code: 'not-directory', detail: 'A missing file has no directory grant' }
    try {
      const path = await realpath(dirname(found.value.document.path))
      if (!PathCompare.isInside(found.value.rootPath, path))
        return { ok: false, code: 'outside-root', detail: 'The parent is outside the explorer root' }
      return await this.openDirectory(
        ownerId,
        found.value.rootPath,
        path,
        found.value.document.source,
      )
    }
    catch (error) { return FileViewer.directoryFailure(error) }
  }

  async directoryEntry(
    ownerId: string,
    directoryId: string,
    entryId: string,
  ): Promise<FileViewerDirectoryResult> {
    const found = this.grants.entry(directoryId, entryId, ownerId)
    if (!found.ok) return found
    if (found.entry.targetKind !== 'directory')
      return { ok: false, code: 'not-directory', detail: 'The entry is not a directory' }
    try {
      const path = await realpath(found.entry.path)
      if (!PathCompare.isInside(found.directory.rootPath, path))
        return { ok: false, code: 'outside-root', detail: 'The directory is outside the explorer root' }
      return await this.openDirectory(
        ownerId,
        found.directory.rootPath,
        path,
        found.directory.source,
      )
    }
    catch (error) { return FileViewer.directoryFailure(error) }
  }

  async parentDirectory(ownerId: string, directoryId: string): Promise<FileViewerDirectoryResult> {
    const found = this.grants.directory(directoryId, ownerId)
    if (!found.ok) return found
    if (PathCompare.comparable(found.value.path) === PathCompare.comparable(found.value.rootPath))
      return { ok: false, code: 'outside-root', detail: 'The explorer is already at its root' }
    try {
      // Resolved BEFORE it is checked, which is what `directoryEntry`, `directoryForDocument` and
      // `openFileEntry` all do and this one did not. Checking the lexical parent and then listing
      // the resolved one is the swap this file defends against everywhere else: rename the parent
      // out of the way, put a junction in its place - no administrator rights needed on Windows -
      // and one press of `up` handed back the names, sizes and times of a directory outside the
      // grant root. Reproduced against this class during the 2026-08-24 review.
      const parent = await realpath(dirname(found.value.path))
      if (!PathCompare.isInside(found.value.rootPath, parent))
        return { ok: false, code: 'outside-root', detail: 'The parent is outside the explorer root' }
      return await this.openDirectory(ownerId, found.value.rootPath, parent, found.value.source)
    }
    catch (error) { return FileViewer.directoryFailure(error) }
  }

  async openFileEntry(
    ownerId: string,
    directoryId: string,
    entryId: string,
  ): Promise<FileViewerOpenResult> {
    const found = this.grants.entry(directoryId, entryId, ownerId)
    if (!found.ok)
      return {
        ok: false,
        code: found.code === 'wrong-owner' ? 'access-denied' : 'invalid-source',
        detail: found.detail,
      }
    if (found.entry.targetKind !== 'file')
      return { ok: false, code: 'not-file', detail: 'The entry is not a file' }
    try {
      const path = await realpath(found.entry.path)
      if (!PathCompare.isInside(found.directory.rootPath, path))
        return { ok: false, code: 'outside-root', detail: 'The file is outside the explorer root' }
      const source: FileViewerDocumentSource = { ...found.directory.source, path }
      return await this.openExisting(
        ownerId,
        found.directory.rootPath,
        path,
        source,
        false,
      )
    }
    catch (error) { return FileViewer.openFailure(error) }
  }

  async mediaResource(ownerId: string, documentId: string): Promise<FileViewerResourceResult> {
    const found = this.grants.document(documentId, ownerId)
    if (!found.ok) return found
    const document = found.value.document
    if (document.kind.kind !== 'image' && document.kind.kind !== 'video')
      return { ok: false, code: 'not-file', detail: 'The document is not streamable media' }
    if (document.size === null || document.contentVersion === null)
      return { ok: false, code: 'not-found', detail: 'The media file no longer exists' }
    if (!await FileViewerGrantBoundary.insideGrant(found.value.rootPath, document.path))
      return { ok: false, code: 'outside-root', detail: 'The media file moved outside its grant' }
    return {
      ok: true,
      value: this.publicResource(this.grants.putResource({
        ownerId,
        documentId,
        rootPath: found.value.rootPath,
        path: document.path,
        mimeType: document.kind.mimeType,
        size: document.size,
        contentVersion: document.contentVersion,
      })),
    }
  }

  async relativeResource(
    ownerId: string,
    documentId: string,
    reference: string,
  ): Promise<FileViewerResourceResult> {
    const found = this.grants.document(documentId, ownerId)
    if (!found.ok) return found
    const relativePath = FileViewer.relativeReference(reference)
    if (relativePath === null)
      return { ok: false, code: 'invalid-reference', detail: 'Only relative local resources are allowed' }
    try {
      const path = await realpath(resolve(dirname(found.value.document.path), relativePath))
      if (!PathCompare.isInside(found.value.rootPath, path))
        return { ok: false, code: 'outside-root', detail: 'The resource is outside the document grant' }
      const inspection = await this.content.inspect(path, false)
      if (inspection.kind.kind !== 'image')
        return { ok: false, code: 'not-file', detail: 'The resource is not a supported raster image' }
      return {
        ok: true,
        value: this.publicResource(this.grants.putResource({
          ownerId,
          documentId,
          rootPath: found.value.rootPath,
          path,
          mimeType: inspection.kind.mimeType,
          size: inspection.size!,
          contentVersion: inspection.contentVersion!,
        })),
      }
    }
    catch (error) { return FileViewer.resourceFailure(error) }
  }

  path(ownerId: string, documentId: string): FileViewerPathResult {
    return this.grants.path(documentId, ownerId)
  }

  async resourceAccess(resourceId: string): Promise<FileViewerGrantedFile | null> {
    const resource = this.grants.resource(resourceId)
    if (resource === null) return null
    if (!await FileViewerGrantBoundary.insideGrant(resource.rootPath, resource.path)) return null
    // The four fields the protocol streams with. `ownerId` and `rootPath` stay inside the subsystem.
    return {
      path: resource.path,
      mimeType: resource.mimeType,
      size: resource.size,
      contentVersion: resource.contentVersion,
    }
  }

  release(ownerId: string, documentId: string): void {
    this.grants.revokeDocument(documentId, ownerId)
  }

  revokeOwner(ownerId: string): void {
    this.grants.revokeOwner(ownerId)
  }

  static panelKeyOf(sessionId: string, path: string): string {
    return createHash('sha256')
      .update(sessionId)
      .update('\0')
      .update(PathCompare.comparable(path))
      .digest('base64url')
      .slice(0, 32)
  }

  static filesystemRoot(path: string): string {
    const root = parse(path).root
    if (!root) throw new Error(`The path has no filesystem root: ${path}`)
    return root
  }

  private async openExisting(
    ownerId: string,
    rootPath: string,
    path: string,
    source: FileViewerDocumentSource,
    supportsDiff: boolean,
  ): Promise<FileViewerOpenResult> {
    return this.openTrusted(ownerId, rootPath, path, source, supportsDiff, false)
  }

  private async openTrusted(
    ownerId: string,
    rootPath: string,
    path: string,
    source: FileViewerDocumentSource,
    supportsDiff: boolean,
    allowMissing: boolean,
  ): Promise<FileViewerOpenResult> {
    FileViewer.assertKnownSource(source)
    const inspection = await this.content.inspect(path, allowMissing)
    const document: FileViewerDocument = {
      documentId: randomUUID(),
      documentKey: FileViewer.panelKeyOf(source.sessionId, path),
      source,
      path,
      name: basename(path),
      size: inspection.size,
      contentVersion: inspection.contentVersion,
      kind: inspection.kind,
      modes: FileFormatRegistry.modes(inspection.kind, supportsDiff, inspection.size),
    }
    this.grants.putDocument({ ownerId, rootPath, document })
    return { ok: true, value: document }
  }

  /**
   * Every door into a document passes through here, so this is where a source kind this build does
   * not know is refused.
   *
   * It used to be refused as a side effect of deciding the document's `location`, which nothing read
   * - so removing that field removed the guard with it, and an unknown source reached the key
   * builder as `undefined` and failed with a sentence about the `data` argument.
   */
  private static assertKnownSource(source: FileViewerDocumentSource): void {
    if (source.kind === 'workspace' || source.kind === 'external'
      || source.kind === 'filesystem' || source.kind === 'detected')
      return
    throw new Error(`Unknown file viewer source: ${JSON.stringify(source)}`)
  }

  private async openDirectory(
    ownerId: string,
    rootPath: string,
    path: string,
    source: FileViewerDocumentSource,
  ): Promise<FileViewerDirectoryResult> {
    const info = await stat(path)
    if (!info.isDirectory())
      return { ok: false, code: 'not-directory', detail: 'The path is not a directory' }
    const read = await this.directories.read(rootPath, path)
    const directoryId = this.grants.putDirectory({ ownerId, rootPath, path, source })
    this.grants.setDirectoryEntries(directoryId, read.entries)
    const value: FileViewerDirectory = {
      directoryId,
      rootPath,
      path,
      relativePath: relative(rootPath, path).replace(/\\/g, '/'),
      canGoParent: PathCompare.comparable(rootPath) !== PathCompare.comparable(path),
      entries: read.publicEntries,
      truncated: read.truncated,
    }
    return { ok: true, value }
  }

  private publicResource(resource: StoredFileViewerResource): FileViewerResource {
    return {
      resourceId: resource.resourceId,
      mimeType: resource.mimeType,
      size: resource.size,
      contentVersion: resource.contentVersion,
    }
  }

  /**
   * The path, or the markdown file beside it.
   *
   * A V1 compatibility: an extensionless target that is absent is tried again with `.md`, which is
   * how a link to `guide` opens `guide.md`. Four public entry points call this, and the old name
   * said nothing about a different file coming back.
   */
  private static async existingPathOrMarkdown(requested: string): Promise<string> {
    try { return await realpath(requested) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code === 'ENOENT' || code === 'ENOTDIR') && extname(requested) === '')
        return realpath(`${requested}.md`)
      throw error
    }
  }

  /**
   * The one operation that takes a string any document author wrote and makes a path of it.
   *
   * Decoded FIRST, then judged. Asking `isAbsolute` about the still-encoded form let `%2F…` past a
   * gate whose whole sentence is "only relative local resources are allowed", and the two refusals
   * downstream do not answer alike - `outside-root` for a path that exists, `not-found` for one that
   * does not - so a rendered markdown file was an existence oracle for any absolute path on the
   * drive. Measured that way during the 2026-08-24 review.
   */
  private static relativeReference(reference: string): string | null {
    const trimmed = reference.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')
      || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null
    const encoded = trimmed.split(/[?#]/, 1)[0]
    if (!encoded) return null
    let path: string
    try { path = decodeURIComponent(encoded) }
    catch { return null }
    if (!path || isAbsolute(path) || path.startsWith('/') || path.startsWith('\\')) return null
    return path
  }

  /**
   * One errno table for the three doors, which used to carry it three times over 36 lines: adding
   * `ELOOP` to one left the other two reporting a symlink cycle as `not-directory` / `not-file`.
   *
   * What differs per door is the NOUN in the sentence and where an error nobody recognised lands,
   * so those are what the callers pass.
   */
  private static failure<TCode extends string>(
    error: unknown,
    noun: string,
    fallback: TCode,
  ): { ok: false; code: TCode | 'not-found' | 'access-denied'; detail: string } {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return { ok: false, code: 'not-found', detail: `The ${noun} does not exist` }
    if (code === 'EACCES' || code === 'EPERM')
      return { ok: false, code: 'access-denied', detail: `The ${noun} cannot be accessed` }
    if (code === 'ELOOP')
      return { ok: false, code: 'not-found', detail: `The ${noun} is behind a symlink cycle` }
    return { ok: false, code: fallback, detail: ErrorText.of(error) }
  }

  private static openFailure(error: unknown): FileViewerOpenResult {
    // Recognised by its type, not by its sentence. The substring match this replaces meant rewording
    // the reader's message would have turned every "you opened a directory" into `invalid-source`.
    if (error instanceof FileContentNotAFileError)
      return { ok: false, code: 'not-file', detail: ErrorText.of(error) }
    return FileViewer.failure(error, 'file', 'invalid-source')
  }

  private static directoryFailure(error: unknown): FileViewerDirectoryResult {
    return FileViewer.failure(error, 'directory', 'not-directory')
  }

  private static resourceFailure(error: unknown): FileViewerResourceResult {
    return FileViewer.failure(error, 'resource', 'not-file')
  }
}
