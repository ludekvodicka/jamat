import type { RemoteFileBytes, RemoteFileRequest } from '../../../lib-orchestrator/remoteControl/remoteContentApi.types'
import type { RemoteSessionView } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { FileViewerChunkResult, FileViewerDirectoryResult, FileViewerDocument, FileViewerOpenResult, FileViewerTextResult } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { FileViewerLimits } from '../../../lib-orchestrator/fileViewer/fileViewerLimits'
import type { AppClientUiBridge, IpcResult } from '../../shared/appClientUiIpc'
import type { SessionFilePorts, SessionTarget, SessionDirectoryPorts } from '../../shared/sessionWorkspace'
import { SessionWorkspaceKeys } from '../../shared/sessionWorkspace'
import { RemoteContentRead } from '../../shared/remoteContentRead'
import { RemoteFileResults } from '../../shared/remoteFileResults'

export class RemoteFileViewerPorts {
  readonly viewer: SessionFilePorts['viewer']
  readonly directories: SessionDirectoryPorts
  private readonly target: Extract<SessionTarget, { kind: 'remote' }>
  private readonly open: () => Promise<RemoteSessionView>
  private readonly bridge: Pick<AppClientUiBridge['remote'], 'requestFiles' | 'readFilePage' | 'mediaResource' | 'exportFile' | 'startImageDrag'>
  private generation = 0
  private closed = false
  private readonly documents = new Map<string, FileViewerDocument>()

  constructor(target: Extract<SessionTarget, { kind: 'remote' }>, open: () => Promise<RemoteSessionView>,
    bridge: Pick<AppClientUiBridge['remote'], 'requestFiles' | 'readFilePage' | 'mediaResource' | 'exportFile' | 'startImageDrag'>,
    external: AppClientUiBridge['fileViewer']['openExternal']) {
    this.target = target
    this.open = open
    this.bridge = bridge
    this.viewer = {
      restore: async (source, supportsDiff) => this.adopt(await this.request<FileViewerOpenResult>({ kind: 'restore', source, supportsDiff })),
      release: async (documentId) => {
        if (!this.documents.delete(documentId)) return { ok: true, value: undefined }
        return this.request<void>({ kind: 'release', documentId })
      },
      text: (documentId) => this.text(documentId),
      chunk: (documentId, offset) => this.chunk(documentId, offset),
      version: (documentId) => this.request({ kind: 'version', documentId }),
      mediaResource: (documentId) => this.media(documentId, null),
      relativeResource: (documentId, reference) => this.media(documentId, reference),
      exportFile: async (documentId, name) => {
        if (this.closed) return { ok: false, error: 'Remote content view closed' }
        try { const view = await this.open(); return await this.bridge.exportFile(this.target.remoteEndpointId, view.viewId, documentId, name) }
        catch (error) { return { ok: false, error: String(error) } }
      },
      openExternal: external,
      startImageDrag: async (documentId) => {
        if (this.closed) return { ok: false, error: 'Remote content view closed' }
        try { const view = await this.open(); return await this.bridge.startImageDrag(this.target.remoteEndpointId, view.viewId, documentId) }
        catch (error) { return { ok: false, error: String(error) } }
      },
    }
    this.directories = {
      rootDirectory: (sessionId) => this.directorySession(sessionId, 'root-directory'),
      projectDirectory: (sessionId) => this.directorySession(sessionId, 'project-directory'),
      directoryAt: (sessionId, path) => sessionId === this.target.sessionId ? this.request({ kind: 'directory-at', path }) : this.foreign(),
      documentDirectory: (documentId) => this.request({ kind: 'document-directory', documentId }),
      directoryEntry: (directoryId, entryId) => this.request({ kind: 'directory-entry', directoryId, entryId }),
      parentDirectory: (directoryId) => this.request({ kind: 'parent-directory', directoryId }),
      openEntry: async (directoryId, entryId) => this.adopt(await this.request<FileViewerOpenResult>({ kind: 'open-entry', directoryId, entryId })),
      release: this.viewer.release,
      mediaResource: this.viewer.mediaResource,
      text: this.viewer.text,
    }
  }

  private async media(documentId: string, reference: string | null): ReturnType<AppClientUiBridge['remote']['mediaResource']> {
    if (this.closed) return { ok: false, error: 'Remote content view closed' }
    try { const view = await this.open(); return await this.bridge.mediaResource(this.target.remoteEndpointId, view.viewId, documentId, reference) }
    catch (error) { return { ok: false, error: String(error) } }
  }

  clear(): void { this.closed = true; this.generation++; this.documents.clear() }

  async request<T>(request: RemoteFileRequest): Promise<IpcResult<T>> {
    if (this.closed) return { ok: false, error: 'Remote content view closed' }
    const generation = this.generation
    try {
      const view = await this.open()
      const first = await this.bridge.requestFiles(this.target.remoteEndpointId, view.viewId, request)
      if (!first.ok) return first
      if (!first.value.ok) return { ok: false, error: first.value.error.detail }
      const bytes = await RemoteContentRead.collect(first.value.value, async (cursor) => {
        const next = await this.bridge.readFilePage(this.target.remoteEndpointId, view.viewId, cursor)
        if (!next.ok) throw new Error(next.error)
        if (!next.value.ok) throw new Error(next.value.error.detail)
        return next.value.value
      })
      if (generation !== this.generation) return { ok: false, error: 'Remote content view closed' }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!RemoteFileResults.valid(request, value)) return { ok: false, error: 'Malformed remote file response' }
      return { ok: true, value: value as T }
    } catch (error) { return { ok: false, error: String(error) } }
  }

  adopt(answer: IpcResult<FileViewerOpenResult>): IpcResult<FileViewerOpenResult> {
    if (!answer.ok || !answer.value.ok) return answer
    try { return { ok: true, value: { ok: true, value: this.adoptDocument(answer.value.value) } } }
    catch (error) { return { ok: false, error: String(error) } }
  }

  adoptDocument(document: FileViewerDocument): FileViewerDocument {
    if (document.source.sessionId !== this.target.sessionId) throw new Error('Remote document belongs to another session')
    const qualified = { ...document, documentKey: SessionWorkspaceKeys.of(this.target, document.documentKey) }
    this.documents.set(qualified.documentId, qualified)
    return qualified
  }

  private directorySession(sessionId: string, kind: 'root-directory' | 'project-directory'): Promise<IpcResult<FileViewerDirectoryResult>> {
    return sessionId === this.target.sessionId ? this.request({ kind }) : this.foreign()
  }

  private async foreign<T>(): Promise<IpcResult<T>> { return { ok: false, error: 'Directory belongs to another session' } }

  private async chunk(documentId: string, offset: number): Promise<IpcResult<FileViewerChunkResult>> {
    const document = this.documents.get(documentId)
    if (!document || document.contentVersion === null) return { ok: true, value: { ok: false, code: 'document-expired', detail: 'Remote document grant expired' } }
    const answer = await this.request<{ ok: true; value: RemoteFileBytes } | Extract<FileViewerChunkResult, { ok: false }>>({ kind: 'bytes', documentId,
      version: document.contentVersion, offset, length: FileViewerLimits.chunkBytes })
    if (!answer.ok) return answer
    if (!answer.value.ok) return { ok: true, value: answer.value }
    const value = answer.value.value
    const bytes = RemoteContentRead.decode(value.base64)
    if (value.version !== document.contentVersion || value.offset !== offset || bytes.length !== value.length || value.length > FileViewerLimits.chunkBytes
      || value.totalSize !== document.size || value.offset + value.length > value.totalSize || value.eof !== (value.offset + value.length === value.totalSize)
      || value.length === 0 && !value.eof)
      return { ok: false, error: 'Invalid remote byte range' }
    return { ok: true, value: { ok: true, value: { ...value, bytes, contentVersion: value.version } } }
  }

  private async text(documentId: string): Promise<IpcResult<FileViewerTextResult>> {
    const document = this.documents.get(documentId)
    if (!document || document.size === null) return { ok: true, value: { ok: false, code: 'missing', detail: 'Remote file is missing' } }
    const limit = FileViewerLimits.textBytes(document.kind)
    if (document.size > limit)
      return { ok: true, value: { ok: true, kind: 'too-large', size: document.size, limit, detail: 'Full text exceeds the viewer limit' } }
    const bytes = new Uint8Array(document.size)
    let offset = 0
    do {
      const answer = await this.chunk(documentId, offset)
      if (!answer.ok) return answer
      if (!answer.value.ok) return { ok: false, error: answer.value.detail }
      bytes.set(answer.value.value.bytes, offset)
      offset += answer.value.value.length
      if (answer.value.value.eof) break
    } while (offset < bytes.length)
    if (bytes.includes(0)) return { ok: true, value: { ok: true, kind: 'binary', detail: 'The file contains NUL bytes' } }
    try { return { ok: true, value: { ok: true, kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), contentVersion: document.contentVersion! } } }
    catch { return { ok: true, value: { ok: true, kind: 'binary', detail: 'The file is not valid UTF-8 text' } } }
  }
}
