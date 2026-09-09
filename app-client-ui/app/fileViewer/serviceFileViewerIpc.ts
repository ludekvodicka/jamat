import { DetectionRefusal } from '../shared/detectionRefusal'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import { shell, type WebContents } from 'electron'

import { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import type {
  FileViewerDirectoryResult,
  FileViewerDocumentSource,
  FileViewerOpenResult,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import { PathCompare } from '../../../lib-orchestrator/shared/pathCompare'
import { ClipboardAccess } from '../shared/clipboardAccess'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

export class ServiceFileViewerIpc extends ServiceIpcBase<
  typeof ServiceFileViewerIpc.channelsConst
> {
  static readonly channelsConst = {
    'fileViewer:open-workspace': true,
    'fileViewer:restore': true,
    'fileViewer:text': true,
    'fileViewer:version': true,
    'fileViewer:chunk': true,
    'fileViewer:root-directory': true,
    'fileViewer:project-directory': true,
    'fileViewer:directory-at': true,
    'fileViewer:document-directory': true,
    'fileViewer:directory-entry': true,
    'fileViewer:parent-directory': true,
    'fileViewer:open-entry': true,
    'fileViewer:media-resource': true,
    'fileViewer:relative-resource': true,
    'fileViewer:copy-path': true,
    'fileViewer:open-external': true,
    'fileViewer:release': true,
  } as const

  constructor(
    private readonly viewer: FileViewer,
    private readonly sessions: SessionManager,
    private readonly ownerIdOf: (sender: WebContents) => string | null,
    private readonly restoreExternal: (
      ownerId: string,
      source: Extract<FileViewerDocumentSource, { kind: 'external' }>,
      supportsDiff: boolean,
    ) => Promise<FileViewerOpenResult>,
    private readonly restoreDetected: (
      ownerId: string,
      source: Extract<FileViewerDocumentSource, { kind: 'detected' }>,
      supportsDiff: boolean,
    ) => Promise<FileViewerOpenResult>,
    private readonly allowsDetected: (path: string) => boolean,
  ) {
    super()
  }

  initialize(): void {
    this.register('fileViewer:open-workspace', (event, sessionId, path, supportsDiff) =>
      this.openWorkspace(this.ownerId(event.sender), sessionId, path, supportsDiff))
    this.register('fileViewer:restore', (event, source, supportsDiff) =>
      this.restore(this.ownerId(event.sender), source, supportsDiff))
    this.register('fileViewer:text', (event, documentId) =>
      this.viewer.text(this.ownerId(event.sender), documentId))
    this.register('fileViewer:version', (event, documentId) =>
      this.viewer.version(this.ownerId(event.sender), documentId))
    this.register('fileViewer:chunk', (event, documentId, offset) =>
      this.viewer.chunk(this.ownerId(event.sender), documentId, offset))
    this.register('fileViewer:root-directory', (event, sessionId) =>
      this.rootDirectory(this.ownerId(event.sender), sessionId))
    this.register('fileViewer:project-directory', (event, sessionId) =>
      this.projectDirectory(this.ownerId(event.sender), sessionId))
    this.register('fileViewer:directory-at', (event, sessionId, path) =>
      this.directoryAt(this.ownerId(event.sender), sessionId, path))
    this.register('fileViewer:document-directory', (event, documentId) =>
      this.viewer.directoryForDocument(this.ownerId(event.sender), documentId))
    this.register('fileViewer:directory-entry', (event, directoryId, entryId) =>
      this.viewer.directoryEntry(this.ownerId(event.sender), directoryId, entryId))
    this.register('fileViewer:parent-directory', (event, directoryId) =>
      this.viewer.parentDirectory(this.ownerId(event.sender), directoryId))
    this.register('fileViewer:open-entry', (event, directoryId, entryId) =>
      this.viewer.openFileEntry(this.ownerId(event.sender), directoryId, entryId))
    this.register('fileViewer:media-resource', (event, documentId) =>
      this.viewer.mediaResource(this.ownerId(event.sender), documentId))
    this.register('fileViewer:relative-resource', (event, documentId, reference) =>
      this.viewer.relativeResource(this.ownerId(event.sender), documentId, reference))
    this.register('fileViewer:copy-path', (event, documentId) =>
      this.copyPath(this.ownerId(event.sender), documentId))
    this.register('fileViewer:open-external', (event, url) => {
      this.ownerId(event.sender)
      return this.openExternal(url)
    })
    this.register('fileViewer:release', (event, documentId) =>
      this.viewer.release(this.ownerId(event.sender), documentId))
    this.assertComplete(ServiceFileViewerIpc.channelsConst)
  }

  private async openWorkspace(
    ownerId: string,
    sessionId: string,
    path: string,
    supportsDiff: boolean,
  ) {
    const context = await this.sessions.workingContext(sessionId)
    if (!context.ok)
      return { ok: false as const, code: 'invalid-source' as const, detail: context.detail }
    return this.viewer.openWorkspace(ownerId, sessionId, context.value.cwd, path, supportsDiff)
  }

  private async restore(
    ownerId: string,
    source: FileViewerDocumentSource,
    supportsDiff: boolean,
  ): Promise<FileViewerOpenResult> {
    if (source.kind === 'workspace')
      return this.openWorkspace(ownerId, source.sessionId, source.path, supportsDiff)
    else if (source.kind === 'external')
      return this.restoreExternal(ownerId, source, supportsDiff)
    else if (source.kind === 'filesystem')
      return this.openFilesystem(ownerId, source, supportsDiff)
    else if (source.kind === 'detected')
      return this.restoreDetectedDocument(ownerId, source, supportsDiff)
    else
      throw new Error(`Unknown file viewer source: ${JSON.stringify(source)}`)
  }

  private async openFilesystem(
    ownerId: string,
    source: Extract<FileViewerDocumentSource, { kind: 'filesystem' }>,
    supportsDiff: boolean,
  ): Promise<FileViewerOpenResult> {
    const context = await this.sessions.workingContext(source.sessionId)
    if (!context.ok)
      return { ok: false, code: 'invalid-source', detail: context.detail }
    return this.viewer.openFilesystem(
      ownerId,
      source.sessionId,
      context.value.cwd,
      source.path,
      supportsDiff,
    )
  }

  private async rootDirectory(ownerId: string, sessionId: string) {
    const context = await this.sessions.workingContext(sessionId)
    if (!context.ok)
      return { ok: false as const, code: 'not-found' as const, detail: context.detail }
    return this.viewer.rootDirectory(ownerId, sessionId, context.value.cwd)
  }

  private async projectDirectory(ownerId: string, sessionId: string) {
    const context = await this.sessions.workingContext(sessionId)
    if (!context.ok)
      return { ok: false as const, code: 'not-found' as const, detail: context.detail }
    return this.viewer.projectDirectory(ownerId, sessionId, context.value.cwd)
  }

  /**
   * The one path this contract takes from a renderer, so it takes two proofs for it: the same one a
   * restored filesystem panel gives - the target sits inside the session's own filesystem root,
   * which `project-directory` already grants whole - or a hit in the register of detected opens,
   * which is what carries a panel on another drive across a remount. The register dies with the
   * process, so after a restart this refuses rather than quietly widening what a path may reach.
   *
   * Both are taken on the REAL path and the viewer is handed that path with the root they proved:
   * the grant root comes from where the target actually lives, so a lexical proof would pass on one
   * drive while a junction across volumes handed out the root of another.
   */
  private async directoryAt(
    ownerId: string,
    sessionId: string,
    path: string,
  ): Promise<FileViewerDirectoryResult> {
    const target = await ServiceFileViewerIpc.realPathOf(path)
    if (target === null)
      return { ok: false, code: 'not-found', detail: 'The directory does not exist' }
    if (!await this.sessionRootAllows(sessionId, target) && !this.allowsDetected(target))
      return {
        ok: false,
        code: 'proof-expired',
        detail: DetectionRefusal.detailOf('directory'),
      }
    return this.viewer.directoryAt(ownerId, sessionId, target, FileViewer.filesystemRoot(target))
  }

  /**
   * The same pair of proofs, because a file opened out of a detected directory panel carries that
   * panel's source: a target on the session's own filesystem root is one `open-workspace` or a
   * restored filesystem panel already reaches, and only a target further out needs the register.
   */
  private async restoreDetectedDocument(
    ownerId: string,
    source: Extract<FileViewerDocumentSource, { kind: 'detected' }>,
    supportsDiff: boolean,
  ): Promise<FileViewerOpenResult> {
    const target = await ServiceFileViewerIpc.realPathOf(source.path)
    if (target === null)
      return { ok: false, code: 'not-found', detail: 'The file does not exist' }
    if (await this.sessionRootAllows(source.sessionId, target))
      return this.viewer.openDetected(ownerId, source.sessionId, null, target, supportsDiff)
    return this.restoreDetected(ownerId, { ...source, path: target }, supportsDiff)
  }

  private async sessionRootAllows(sessionId: string, target: string): Promise<boolean> {
    const context = await this.sessions.workingContext(sessionId)
    if (!context.ok) return false
    try {
      const root = FileViewer.filesystemRoot(await realpath(context.value.cwd))
      return PathCompare.isInside(root, target)
    }
    catch { return false }
  }

  private static async realPathOf(path: string): Promise<string | null> {
    try { return await realpath(resolve(path)) }
    catch { return null }
  }

  private async copyPath(ownerId: string, documentId: string): Promise<boolean> {
    const found = this.viewer.path(ownerId, documentId)
    if (!found.ok) return false
    return ClipboardAccess.writeText(found.path)
  }

  private async openExternal(value: string): Promise<boolean> {
    let url: URL
    try { url = new URL(value) }
    catch { return false }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    await shell.openExternal(url.toString())
    return true
  }

  private ownerId(sender: WebContents): string {
    const ownerId = this.ownerIdOf(sender)
    if (ownerId === null) throw new Error('File viewer request came from an unknown workspace')
    return ownerId
  }
}
