import { useState } from 'react'

import { ContextMenu, type ContextMenuPosition } from '../widgets/contextMenu'
import { FileImageSource } from './fileImageSource'
import { useImageViewer, type ImageViewerSource } from './imageViewer'

export function FileImageSurface(props: { name: string; children: React.ReactNode }): React.JSX.Element {
  const image = useImageViewer()
  const [menu, setMenu] = useState<{ source: ImageViewerSource; position: ContextMenuPosition; origin: HTMLElement | null } | null>(null)
  return <div className="file-image-surface"
    onClickCapture={(event) => {
      if (event.target instanceof Element && event.target.closest('a')
        && FileImageSource.element(event.target, event.currentTarget, props.name)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }}
    onDoubleClick={(event) => {
      const source = FileImageSource.element(event.target, event.currentTarget, props.name)
      if (!source) return
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.closest<HTMLElement>('.file-viewer')?.focus()
      image.open(source)
    }}
    onContextMenu={(event) => {
      const source = FileImageSource.element(event.target, event.currentTarget, props.name)
      if (!source) return
      event.preventDefault()
      event.stopPropagation()
      setMenu({ source, position: { x: event.clientX, y: event.clientY }, origin: event.currentTarget.closest<HTMLElement>('.file-viewer') })
    }}>
    {props.children}
    {menu && <ContextMenu ariaLabel="Image actions" position={menu.position}
      items={[{ key: 'fullscreen', label: 'Open image full screen', onSelect: () => { menu.origin?.focus(); image.open(menu.source) } }]}
      onClose={() => setMenu(null)} />}
    {image.viewer}
  </div>
}
