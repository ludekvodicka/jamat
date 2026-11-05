import { useState } from 'react'

import { ContextMenu, type ContextMenuPosition } from '../widgets/contextMenu'
import { FileImageSource } from './fileImageSource'
import { useImageViewer, type ImageViewerSource } from './imageViewer'

export function FileImageSurface(props: {
  name: string
  children: React.ReactNode
  onAskSelection?(line: number, selection: string): void
}): React.JSX.Element {
  const image = useImageViewer()
  const [menu, setMenu] = useState<{ source: ImageViewerSource; position: ContextMenuPosition; origin: HTMLElement | null } | null>(null)
  const [askMenu, setAskMenu] = useState<{ line: number; text: string; position: ContextMenuPosition } | null>(null)
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
      setMenu(null)
      setAskMenu(null)
      const source = FileImageSource.element(event.target, event.currentTarget, props.name)
      if (!source) {
        if (!props.onAskSelection) return
        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0 || !selection.toString().trim()) return
        const range = selection.getRangeAt(0)
        if (!event.currentTarget.contains(range.startContainer) || !event.currentTarget.contains(range.endContainer)) return
        const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
        const positioned = element?.closest<HTMLElement>('[data-file-line-start]')
        const line = Number(positioned?.dataset.fileLineStart)
        if (!Number.isSafeInteger(line) || line < 1) return
        event.preventDefault()
        event.stopPropagation()
        setAskMenu({ line, text: selection.toString(), position: { x: event.clientX, y: event.clientY } })
        return
      }
      event.preventDefault()
      event.stopPropagation()
      setMenu({ source, position: { x: event.clientX, y: event.clientY }, origin: event.currentTarget.closest<HTMLElement>('.file-viewer') })
    }}>
    {props.children}
    {menu && <ContextMenu ariaLabel="Image actions" position={menu.position}
      items={[{ key: 'fullscreen', label: 'Open image full screen', onSelect: () => { menu.origin?.focus(); image.open(menu.source) } }]}
      onClose={() => setMenu(null)} />}
    {askMenu && props.onAskSelection && <ContextMenu ariaLabel="Selection actions" position={askMenu.position}
      items={[{ key: 'ask', label: 'Ask', onSelect: () => props.onAskSelection?.(askMenu.line, askMenu.text) }]}
      onClose={() => setAskMenu(null)} />}
    {image.viewer}
  </div>
}
