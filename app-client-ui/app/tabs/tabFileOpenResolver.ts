import type { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import type { FileViewerDocumentSource } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { TerminalDetector } from '../../../lib-orchestrator/terminalDetector/terminalDetector'

export type TabFileOpenResolution =
  | {
      ok: true
      source: FileViewerDocumentSource
      documentKey: string
      title: string
    }
  | { ok: false; code: 'not-found' | 'operation-failed'; detail: string }

export class TabFileOpenResolver {
  private static readonly ownerIdConst = 'remote-control'

  constructor(
    private readonly sessions: Pick<SessionManager, 'workingContext'>,
    private readonly viewer: Pick<FileViewer, 'openDetected' | 'release'>,
    private readonly detector: Pick<TerminalDetector, 'markOpened'>,
  ) {}

  async resolve(sessionId: string, path: string): Promise<TabFileOpenResolution> {
    const context = await this.sessions.workingContext(sessionId)
    if (!context.ok)
      return { ok: false, code: 'not-found', detail: context.detail }
    const answer = await this.viewer.openDetected(
      TabFileOpenResolver.ownerIdConst,
      sessionId,
      context.value.cwd,
      path,
    )
    if (!answer.ok)
      return {
        ok: false,
        code: answer.code === 'not-found' ? 'not-found' : 'operation-failed',
        detail: answer.detail,
      }
    try {
      this.detector.markOpened(answer.value.path, 'file')
      return {
        ok: true,
        source: answer.value.source,
        documentKey: answer.value.documentKey,
        title: answer.value.name,
      }
    } finally {
      this.viewer.release(TabFileOpenResolver.ownerIdConst, answer.value.documentId)
    }
  }
}
