import { realpath } from 'node:fs/promises'
import { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import type { TerminalDetectResult, TerminalMenuCapture, TerminalDirectoryOpenResult } from '../../../lib-orchestrator/terminalDetector/terminalDetectorApi.types'
import type { FileViewerOpenResult } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
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
  private readonly sessions: Pick<SessionManager, 'workingContext'>
  private readonly viewer: Pick<FileViewer, 'openDetected' | 'release'>
  private readonly detector: Pick<TerminalDetector, 'markOpened'> & Partial<Pick<TerminalDetector, 'detect' | 'pathOf'>>
  private readonly proofs = new Map<string, { owner: string; sessionId: string; paths: Map<string, string> }>()

  constructor(
    sessions: Pick<SessionManager, 'workingContext'>,
    viewer: Pick<FileViewer, 'openDetected' | 'release'>,
    detector: Pick<TerminalDetector, 'markOpened'> & Partial<Pick<TerminalDetector, 'detect' | 'pathOf'>>,
  ) { this.sessions = sessions; this.viewer = viewer; this.detector = detector }

  async detect(owner: string, sessionId: string, capture: TerminalMenuCapture): Promise<TerminalDetectResult> {
    if (!this.detector.detect) throw new Error('Source path detection is unavailable')
    const result = await this.detector.detect(sessionId, capture)
    const paths = new Map<string, string>()
    for (const detection of result.detections) {
      const ids = detection.kind === 'directory' ? [detection.detectionId, ...detection.children.map((child) => child.detectionId)] : [detection.detectionId]
      for (const id of ids) {
        const hit = this.detector.pathOf?.(result.requestId, id)
        if (hit && hit.kind !== 'url') {
          try { paths.set(id, await realpath(hit.path)) }
          catch { /* A disappearing detection cannot acquire a proof. */ }
        }
      }
    }
    this.proofs.set(result.requestId, { owner, sessionId, paths })
    while (this.proofs.size > 256) this.proofs.delete(this.proofs.keys().next().value!)
    return result
  }

  async detected(owner: string, sessionId: string, requestId: string, detectionId: string, kind: 'file' | 'directory'): Promise<FileViewerOpenResult | TerminalDirectoryOpenResult> {
    const proof = this.proofs.get(requestId)
    const hit = this.detector.pathOf?.(requestId, detectionId)
    const path = proof?.paths.get(detectionId)
    if (!proof || proof.owner !== owner || proof.sessionId !== sessionId || !hit || hit.sessionId !== sessionId || !path)
      return { ok: false, code: 'proof-expired', detail: 'Source path proof expired. Right-click the path again.' }
    if (hit.kind !== kind) return { ok: false, code: 'not-directory', detail: 'The detection has a different kind' }
    try {
      if (await realpath(hit.path) !== path) return { ok: false, code: 'proof-expired', detail: 'The detected path was redirected. Right-click it again.' }
    } catch { return { ok: false, code: 'not-found', detail: 'The detected path no longer exists' } }
    if (kind === 'directory') {
      this.detector.markOpened(path, 'directory')
      return { ok: true, value: { sessionId, path, directoryKey: FileViewer.panelKeyOf(sessionId, path) } }
    } else if (kind === 'file') {
      const context = await this.sessions.workingContext(sessionId)
      if (!context.ok) return { ok: false, code: 'invalid-source', detail: context.detail }
      const answer = await this.viewer.openDetected(owner, sessionId, context.value.cwd, path)
      if (answer.ok) this.detector.markOpened(answer.value.path, 'file')
      return answer
    } else throw new Error(`Unknown detected kind: ${kind}`)
  }

  release(owner: string): void {
    for (const [id, proof] of this.proofs) if (proof.owner === owner) this.proofs.delete(id)
  }

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
