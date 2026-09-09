import type { FileViewerDirectoryEntry } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import {
  ContextMenu,
  type ContextMenuPosition,
} from '../widgets/contextMenu'

export function DirectoryEntryContextMenu(props: {
  entry: FileViewerDirectoryEntry
  position: ContextMenuPosition
  onView(): void
  onClose(): void
}): React.JSX.Element {
  return (
    <ContextMenu
      position={props.position}
      ariaLabel={`Actions for ${props.entry.name}`}
      className="file-directory-menu"
      items={[{
        key: 'view',
        label: 'View',
        onSelect: props.onView,
      }]}
      onClose={props.onClose}
    />
  )
}
