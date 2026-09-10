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
import type { FileToolsTab } from './panelFileToolsRegistry'

export function FileToolsSidebar(props: {
  sessionId: string
  documentId: string | null
  selected: FileToolsTab
  changes: FileChangesViewModel
  workingTree: FileChangesWorkingTreeViewModel
  onOpenCommit?(vcs: FileChangesVcsId): void
  onSelect(tab: FileToolsTab): void
  onOpenChanged(value: FileViewerChangedOpen): void
  onOpenDocument(document: FileViewerDocument): void
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
              : (() => { throw new Error(`Unknown file tools tab: ${JSON.stringify(props.selected)}`) })()}
      </div>
    </div>
  )
}
