import type { FileChangesVcsId } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { FileViewerDocument } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { DirectoryExplorer } from './directoryExplorer'
import { FileChangesWidget } from './fileChangesWidget'
import { FileChangesTreeWidget } from './fileChangesTreeWidget'
import type {
  FileChangesViewModel,
  FileChangesWorkingTreeViewModel,
  FileViewerChangedOpen,
} from './fileViewerPanel.types'
import type { TerminalToolsTab } from './panelFileToolsRegistry'

export function FileToolsSidebar(props: {
  sessionId: string
  documentId: string | null
  selected: TerminalToolsTab
  changes: FileChangesViewModel
  workingTree: FileChangesWorkingTreeViewModel
  onOpenCommit?(vcs: FileChangesVcsId): void
  onSelect(tab: TerminalToolsTab): void
  onOpenChanged(value: FileViewerChangedOpen): void
  onOpenDocument(document: FileViewerDocument): void
  /** The terminal's Notes; absent in the FileViewer, which then draws exactly its three tabs. */
  notes?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="file-tools">
      <div className="file-tools-tabs" role="tablist" aria-label="File tools">
        <button
          type="button"
          role="tab"
          aria-selected={props.selected === 'workingTree'}
          onClick={() => props.onSelect('workingTree')}
        >
          File Changes
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={props.selected === 'fileChanges'}
          onClick={() => props.onSelect('fileChanges')}
        >
          Changelog
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={props.selected === 'directoryExplorer'}
          onClick={() => props.onSelect('directoryExplorer')}
        >
          Explorer
        </button>
        {props.notes !== undefined && (
          <button
            type="button"
            role="tab"
            aria-selected={props.selected === 'notes'}
            onClick={() => props.onSelect('notes')}
          >
            Notes
          </button>
        )}
      </div>
      <div className="file-tools-body">
        {props.selected === 'workingTree'
          ? <>
              {props.onOpenCommit && (props.workingTree.selectedSource === 'svn' || props.workingTree.selectedSource === 'git') && <button type="button"
                onClick={() => {
                  const source = props.workingTree.selectedSource
                  if (source === 'svn' || source === 'git') props.onOpenCommit?.(source)
                }}>Commit…</button>}
              <FileChangesTreeWidget model={props.workingTree} onOpen={props.onOpenChanged} />
            </>
          : props.selected === 'fileChanges'
            ? <FileChangesWidget model={props.changes} onOpen={props.onOpenChanged} />
          : props.selected === 'directoryExplorer'
            ? (
              <DirectoryExplorer
                sessionId={props.sessionId}
                documentId={props.documentId}
                targetPath={null}
                place="sidebar"
                onOpen={props.onOpenDocument}
              />
            )
          : props.selected === 'notes'
            ? (props.notes ?? (() => { throw new Error('Notes selected without Notes content') })())
            : (() => { throw new Error(`Unknown file tools tab: ${JSON.stringify(props.selected)}`) })()}
      </div>
    </div>
  )
}
