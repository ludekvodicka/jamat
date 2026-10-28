import type { FileViewerDirectoryEntry } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import {
  ContextMenu,
  type ContextMenuPosition,
} from '../widgets/contextMenu'
import { FileImageSource } from './fileImageSource'

export function DirectoryEntryContextMenu(props: {
  entry: FileViewerDirectoryEntry
  position: ContextMenuPosition
  onView(): void
  onImageFullScreen(): void
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
      }, ...(FileImageSource.supports(props.entry) ? [{
        key: 'image-fullscreen',
        label: 'Open image full screen',
        onSelect: props.onImageFullScreen,
      }] : [])]}
      onClose={props.onClose}
    />
  )
}
