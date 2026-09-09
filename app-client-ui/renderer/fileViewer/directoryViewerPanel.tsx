import type { IDockviewPanelProps } from 'dockview'

import type {
  FileViewerDocument,
  FileViewerDocumentSource,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { DirectoryExplorer } from './directoryExplorer'

export type DirectoryViewerPanelProps = IDockviewPanelProps & {
  openFile(source: FileViewerDocumentSource, documentKey: string): void
}

export function DirectoryViewerPanel(props: DirectoryViewerPanelProps): React.JSX.Element {
  const sessionId = DirectoryViewerPanelState.sessionIdOf(props.params)
  const targetPath = DirectoryViewerPanelState.pathOf(props.params)
  const openFile = (document: FileViewerDocument): void => {
    try {
      props.openFile(document.source, document.documentKey)
    }
    finally {
      void window.appClient.fileViewer.release(document.documentId)
    }
  }
  return (
    <section
      className="file-directory-viewer"
      aria-label={targetPath === null ? 'Project directory' : 'Directory'}
    >
      <DirectoryExplorer
        sessionId={sessionId}
        targetPath={targetPath}
        documentId={null}
        place="panel"
        onOpen={openFile}
      />
    </section>
  )
}

export class DirectoryViewerPanelState {
  static sessionIdOf(params: Record<string, unknown>): string {
    const sessionId = params.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0)
      throw new Error(`Directory viewer has no session: ${JSON.stringify(params)}`)
    return sessionId
  }

  /**
   * An address, not an authority: the layout remembers WHERE this panel was looking, and every mount
   * proves it again through the main-side check inside `directory-at`. A panel saved before this
   * parameter existed has none, and opens the session's project folder exactly as it always did.
   */
  static pathOf(params: Record<string, unknown>): string | null {
    const path = params.path
    if (path === undefined) return null
    if (typeof path !== 'string' || path.length === 0)
      throw new Error(`Directory viewer has an unreadable path: ${JSON.stringify(params)}`)
    return path
  }
}
