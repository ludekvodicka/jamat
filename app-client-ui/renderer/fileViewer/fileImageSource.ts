import type { SessionDirectoryPorts } from '../../shared/sessionWorkspace'
import type { FileViewerDirectoryEntry } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { FileViewerProtocolUrl } from '../../shared/fileViewerProtocol'
import type { ImageViewerSource } from './imageViewer'

export class FileImageSource {
  static supports(entry: FileViewerDirectoryEntry): boolean {
    return entry.openable && entry.targetKind === 'file' && /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i.test(entry.name)
  }

  static element(target: EventTarget | null, root: HTMLElement, name: string): ImageViewerSource | null {
    const element = target instanceof Element ? target.closest('img, svg') : null
    if (!element || !root.contains(element)) return null
    if (element instanceof HTMLImageElement) {
      const url = element.currentSrc || element.src
      return url ? { name: element.alt || name, load: async () => ({ url }) } : null
    }
    if (element instanceof SVGSVGElement) {
      const svg = element.cloneNode(true) as SVGSVGElement
      const box = element.viewBox.baseVal
      if (box.width > 0 && box.height > 0) {
        svg.setAttribute('width', String(box.width))
        svg.setAttribute('height', String(box.height))
      }
      const url = FileImageSource.svg(new XMLSerializer().serializeToString(svg))
      return { name: element.getAttribute('aria-label') || name, load: async () => ({ url }) }
    }
    return null
  }

  static directory(ports: SessionDirectoryPorts, directoryId: string, entry: FileViewerDirectoryEntry): ImageViewerSource {
    return { name: entry.name, load: async () => {
      const opened = await ports.openEntry(directoryId, entry.entryId)
      if (!opened.ok) throw new Error(opened.error)
      if (!opened.value.ok) throw new Error(opened.value.detail)
      const document = opened.value.value
      const release = (): void => { void ports.release(document.documentId) }
      try {
        let url: string
        if (document.kind.kind === 'image') {
          const answer = await ports.mediaResource(document.documentId)
          if (!answer.ok) throw new Error(answer.error)
          if (!answer.value.ok) throw new Error(answer.value.detail)
          url = FileViewerProtocolUrl.resource(answer.value.value.resourceId)
        } else if (document.kind.kind === 'svg') {
          const answer = await ports.text(document.documentId)
          if (!answer.ok) throw new Error(answer.error)
          if (!answer.value.ok || answer.value.kind !== 'text') throw new Error(answer.value.detail)
          url = FileImageSource.svg(answer.value.text)
        } else throw new Error('This file is not a supported image.')
        return { url, release }
      } catch (error) { release(); throw error }
    } }
  }

  private static svg(source: string): string {
    // An image document cannot run SVG scripts or load external resources; never insert this as HTML.
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
  }
}
