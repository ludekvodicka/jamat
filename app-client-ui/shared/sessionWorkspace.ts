import type { FileViewerDocumentSource } from '../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { AppClientUiBridge } from './appClientUiIpc'
import { type TerminalTarget, TerminalTargetCodec } from './terminalTarget'

export type SessionTarget = TerminalTarget
export class SessionWorkspaceTargets {
  static panel(params: Record<string, unknown>): SessionTarget {
    const explicit = params.target as Partial<TerminalTarget> | undefined
    const reading = TerminalTargetCodec.read(explicit?.kind === 'local' ? { sessionId: explicit.sessionId } : explicit === undefined ? params : { target: explicit })
    if (!reading || typeof params.sessionId === 'string' && params.sessionId !== reading.target.sessionId)
      throw new Error('Panel has an invalid session target')
    return reading.target
  }
}
export interface RoutedDocument { target: SessionTarget; source: FileViewerDocumentSource }
export interface SessionFilePorts {
  directories?: SessionDirectoryPorts
  viewer: Pick<AppClientUiBridge['fileViewer'], 'restore' | 'release' | 'text' | 'chunk' | 'version' | 'relativeResource' | 'mediaResource' | 'openExternal' | 'startImageDrag'> & { exportFile?(documentId: string, name: string): Promise<import('./appClientUiIpc').IpcResult<boolean>> }
  changes: Pick<AppClientUiBridge['fileChanges'], 'scopedWorkingTree' | 'diff'>
}

export class SessionWorkspaceKeys {
  static of(target: SessionTarget, key: string): string {
    if (target.kind === 'local') return JSON.stringify(['local', target.sessionId, key])
    else if (target.kind === 'remote') return JSON.stringify(['remote', target.remoteEndpointId, target.sessionId, key])
    else throw new Error(`Unknown session target: ${JSON.stringify(target)}`)
  }
}

export type SessionDirectoryPorts = Pick<AppClientUiBridge['fileViewer'], 'rootDirectory' | 'projectDirectory' | 'directoryAt' | 'documentDirectory' | 'directoryEntry' | 'parentDirectory' | 'openEntry' | 'release' | 'mediaResource' | 'text'>
