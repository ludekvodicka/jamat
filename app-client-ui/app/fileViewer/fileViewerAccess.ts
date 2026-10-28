import { DetectionRefusal } from '../shared/detectionRefusal'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'


import { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import type {
  FileViewerDirectoryResult,
  FileViewerDocumentSource,
  FileViewerOpenResult,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import { PathCompare } from '../../../lib-orchestrator/shared/pathCompare'

export interface FileViewerAccessDeps {
  viewer: FileViewer
  sessions: Pick<SessionManager, 'workingContext' | 'scriptLogOf'>
  restoreExternal: (ownerId: string, source: Extract<FileViewerDocumentSource, { kind: 'external' }>, supportsDiff: boolean) => Promise<FileViewerOpenResult>
  restoreDetected: (ownerId: string, source: Extract<FileViewerDocumentSource, { kind: 'detected' }>, supportsDiff: boolean) => Promise<FileViewerOpenResult>
  allowsDetected: (path: string) => boolean
  restoreWorkingTree: (ownerId: string, source: FileViewerDocumentSource) => Promise<FileViewerOpenResult>
}

export class FileViewerAccess {
  private readonly viewer: FileViewer
  private readonly sessions: FileViewerAccessDeps['sessions']
  private readonly restoreExternal: FileViewerAccessDeps['restoreExternal']
  private readonly restoreDetected: FileViewerAccessDeps['restoreDetected']
  private readonly allowsDetected: FileViewerAccessDeps['allowsDetected']
  private readonly restoreWorkingTree: FileViewerAccessDeps['restoreWorkingTree']

  constructor(deps: FileViewerAccessDeps) {
    this.viewer = deps.viewer
    this.sessions = deps.sessions
    this.restoreExternal = deps.restoreExternal
    this.restoreDetected = deps.restoreDetected
    this.allowsDetected = deps.allowsDetected
    this.restoreWorkingTree = deps.restoreWorkingTree
  }

  async containsWorkingTree(source: FileViewerDocumentSource): Promise<boolean> {
    if (!source.workingTree) return true
    const context = await this.sessions.workingContext(source.sessionId)
    if (!context.ok) return false
    const root = await FileViewerAccess.realPathOf(context.value.cwd)
    const scope = await FileViewerAccess.realPathOf(source.workingTree.scopeRoot)
    return root !== null && scope !== null && PathCompare.isInside(root, scope)
  }

  async openWorkspace(
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

  async restore(
    ownerId: string,
    source: FileViewerDocumentSource,
    supportsDiff: boolean,
  ): Promise<FileViewerOpenResult> {
    if (source.workingTree !== undefined)
      return this.restoreWorkingTree(ownerId, source)
    if (source.kind === 'workspace')
      return this.openWorkspace(ownerId, source.sessionId, source.path, supportsDiff)
    else if (source.kind === 'external')
      return this.restoreExternal(ownerId, source, supportsDiff)
    else if (source.kind === 'filesystem')
      return this.openFilesystem(ownerId, source, supportsDiff)
    else if (source.kind === 'detected')
      return this.restoreDetectedDocument(ownerId, source, supportsDiff)
    else if (source.kind === 'scriptLog')
      return this.openScriptLog(ownerId, source)
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

  /** The source's own path is never read: the parent's history proves the run and names the file. */
  private async openScriptLog(
    ownerId: string,
    source: Extract<FileViewerDocumentSource, { kind: 'scriptLog' }>,
  ): Promise<FileViewerOpenResult> {
    const proven = await this.sessions.scriptLogOf(source.sessionId, source.runId)
    if (!proven.ok)
      return { ok: false, code: 'invalid-source', detail: proven.detail }
    return this.viewer.openScriptLog(ownerId, source.sessionId, source.runId, proven.value.path)
  }

  async rootDirectory(ownerId: string, sessionId: string) {
    const context = await this.sessions.workingContext(sessionId)
    if (!context.ok)
      return { ok: false as const, code: 'not-found' as const, detail: context.detail }
    return this.viewer.rootDirectory(ownerId, sessionId, context.value.cwd)
  }

  async projectDirectory(ownerId: string, sessionId: string) {
    const context = await this.sessions.workingContext(sessionId)
    if (!context.ok)
      return { ok: false as const, code: 'not-found' as const, detail: context.detail }
    return this.viewer.projectDirectory(ownerId, sessionId, context.value.cwd)
  }

  /**
   * The one path this contract takes from a renderer, so it takes two proofs for it: the same one a
   * restored filesystem panel gives - the target sits inside the session's own filesystem root,
   * which `project-directory` already grants whole - or a hit in the register of detected opens,
   * which is what carries a panel on another drive across a remount and a restart. Only main writes
   * that register, so a path no click proved still refuses rather than widening what it may reach.
   *
   * Both are taken on the REAL path and the viewer is handed that path with the root they proved:
   * the grant root comes from where the target actually lives, so a lexical proof would pass on one
   * drive while a junction across volumes handed out the root of another.
   */
  async directoryAt(
    ownerId: string,
    sessionId: string,
    path: string,
  ): Promise<FileViewerDirectoryResult> {
    const target = await FileViewerAccess.realPathOf(path)
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
    const target = await FileViewerAccess.realPathOf(source.path)
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

}
