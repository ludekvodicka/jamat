import { FileViewerProtocolUrl } from '../../shared/fileViewerProtocol'
import type { ImageViewerSource } from './imageViewer'

/** A rectangle in the image's own pixels. */
export interface FileImageArea {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Images out of the file viewer: onto the clipboard as a PNG, or dragged as a file.
 *
 * The renderer draws the PNG itself, because it already decodes every format it shows (WebP, AVIF,
 * SVG) and a cut-out is a canvas crop; main only puts the finished PNG on the clipboard.
 */
export class FileImageTransfer {
  private static readonly resourcePrefixConst = `${FileViewerProtocolUrl.scheme}://resource/`

  static async copySource(source: ImageViewerSource): Promise<void> {
    const loaded = await source.load()
    try { await FileImageTransfer.copy(loaded.url) }
    finally { loaded.release?.() }
  }

  static async copy(url: string, area?: FileImageArea): Promise<void> {
    const image = new Image()
    // A protocol image on a canvas stays readable only when it was loaded through CORS.
    if (url.startsWith(FileImageTransfer.resourcePrefixConst)) image.crossOrigin = 'anonymous'
    image.src = url
    await image.decode()
    const width = image.naturalWidth, height = image.naturalHeight
    if (width < 1 || height < 1) throw new Error('The image has no size to copy.')
    const x = Math.max(0, Math.min(width - 1, Math.floor(area?.x ?? 0)))
    const y = Math.max(0, Math.min(height - 1, Math.floor(area?.y ?? 0)))
    const right = Math.max(x + 1, Math.min(width, Math.ceil(area === undefined ? width : area.x + area.width)))
    const bottom = Math.max(y + 1, Math.min(height, Math.ceil(area === undefined ? height : area.y + area.height)))
    const canvas = document.createElement('canvas')
    canvas.width = right - x
    canvas.height = bottom - y
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The image cannot be drawn for copying.')
    context.drawImage(image, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
    const answer = await window.appClient.clipboard.writeImage(canvas.toDataURL('image/png'))
    if (!answer.ok) throw new Error(answer.error)
    if (!answer.value) throw new Error('Another application held the clipboard; the image was not copied.')
  }

  /** The resource id of an image the file protocol serves, or null for any other image. */
  static resourceId(element: EventTarget | null): string | null {
    if (!(element instanceof HTMLImageElement)) return null
    const url = element.currentSrc || element.src
    if (!url.startsWith(FileImageTransfer.resourcePrefixConst)) return null
    try { return decodeURIComponent(url.slice(FileImageTransfer.resourcePrefixConst.length)) || null }
    catch { return null }
  }

  static async startDrag(resourceId: string): Promise<void> {
    const answer = await window.appClient.fileViewer.startResourceDrag(resourceId)
    if (!answer.ok) throw new Error(answer.error)
    if (!answer.value) throw new Error('The image is no longer available for dragging. Reload it and try again.')
  }
}
