import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ImageViewerResource, ImageViewerSource } from './imageViewer'
import { useImageViewer } from './imageViewer'
import { FileImageSurface } from './fileImageSurface'
import { FileImageTransfer } from './fileImageTransfer'
import { FileViewerContent } from './fileViewerContent'
import type { SessionFilePorts } from '../../shared/sessionWorkspace'

function Launcher(props: { source: ImageViewerSource }): React.JSX.Element {
  const image = useImageViewer()
  return <><button onClick={() => image.open(props.source)}>Open</button>{image.viewer}</>
}

describe('fullscreen image viewer', () => {
  let fullscreen: Element | null
  const request = vi.fn(function (this: HTMLElement): Promise<void> {
    fullscreen = this
    document.dispatchEvent(new Event('fullscreenchange'))
    return Promise.resolve()
  })
  const exit = vi.fn(async () => { fullscreen = null; document.dispatchEvent(new Event('fullscreenchange')) })

  beforeEach(() => {
    fullscreen = null
    request.mockClear()
    exit.mockClear()
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen })
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: request })
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen')
    Reflect.deleteProperty(document, 'exitFullscreen')
    Reflect.deleteProperty(document, 'fullscreenElement')
  })

  function source(release = vi.fn()): ImageViewerSource {
    return { name: 'diagram.png', load: vi.fn(async () => ({ url: 'data:image/png;base64,AA==', release })) }
  }

  async function open(value = source()) {
    const view = render(<Launcher source={value} />)
    const button = screen.getByRole('button', { name: 'Open' })
    button.focus()
    fireEvent.click(button)
    const image = await screen.findByRole('img', { name: value.name })
    Object.defineProperties(image, { naturalWidth: { value: 1600 }, naturalHeight: { value: 1200 } })
    fireEvent.load(image)
    return { ...view, image, button, dialog: screen.getByRole('dialog') }
  }

  it('fits large images, supports actual pixels, wheel zoom and dragging', async () => {
    const { image } = await open()
    expect(request).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('Image zoom')).toHaveTextContent('50%')
    expect(image).toHaveStyle({ width: '800px', height: '600px' })
    fireEvent.click(screen.getByRole('button', { name: '1:1' }))
    expect(image).toHaveStyle({ width: '1600px', height: '1200px' })
    const viewport = image.closest('.image-viewer__viewport')!
    expect(fireEvent.wheel(viewport, { deltaY: -100, cancelable: true })).toBe(false)
    expect(screen.getByLabelText('Image zoom')).toHaveTextContent('125%')
    fireEvent.pointerDown(viewport, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(viewport, { clientX: 60, clientY: 50 })
    expect(viewport.scrollLeft).toBe(40)
    expect(viewport.scrollTop).toBe(50)
    fireEvent.pointerUp(viewport)
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }))
    expect(screen.getByLabelText('Image zoom')).toHaveTextContent('50%')
  })

  it('closes only the popup, restores focus and releases its grant on Escape', async () => {
    const release = vi.fn()
    const { container, button, dialog } = await open(source(release))
    expect(container.inert).toBe(true)
    expect(document.activeElement).toBe(dialog)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(button)
    expect(container.inert).not.toBe(true)
    expect(exit).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it('closes when the operating system leaves fullscreen', async () => {
    await open()
    act(() => { fullscreen = null; document.dispatchEvent(new Event('fullscreenchange')) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('releases a late resource after closing while loading', async () => {
    let resolve!: (resource: ImageViewerResource) => void
    const release = vi.fn()
    const pending = { name: 'slow.webp', load: () => new Promise<ImageViewerResource>((done) => { resolve = done }) }
    render(<Launcher source={pending} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(request).toHaveBeenCalledOnce()
    expect(screen.getByText('Loading image…')).toHaveAttribute('role', 'status')
    fireEvent.click(screen.getByRole('button', { name: 'Close image viewer' }))
    await act(async () => resolve({ url: 'data:image/webp;base64,AA==', release }))
    expect(release).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps an accessible close button when fullscreen or image loading fails', async () => {
    request.mockRejectedValueOnce(new Error('Denied'))
    render(<Launcher source={{ name: 'missing.png', load: async () => { throw new Error('File was removed') } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('File was removed')
    expect(screen.getByText(/Fullscreen unavailable/)).toHaveAttribute('role', 'status')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(screen.getByRole('button', { name: 'Close image viewer' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Close image viewer' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a decoding error without closing the document', async () => {
    const { image } = await open()
    fireEvent.error(image)
    expect(screen.getByRole('alert')).toHaveTextContent('could not be decoded')
    expect(screen.getByRole('button', { name: 'Close image viewer' })).toBeEnabled()
  })

  it('opens the resolved mdext image on double-click without navigating its wrapping link', async () => {
    const onOpenSource = vi.fn()
    const ports = { relativeResource: vi.fn(async () => ({ ok: true, value: { ok: true, value: { resourceId: 'picture' } } })) } as unknown as SessionFilePorts['viewer']
    const view = render(<section className="file-viewer" tabIndex={-1}>
      <FileImageSurface name="report.mdext">
        <FileViewerContent ports={ports} document={{ documentId: 'doc', documentKey: 'doc', name: 'report.mdext',
          path: 'C:/work/report.mdext', source: { kind: 'workspace', sessionId: 'session', path: 'report.mdext' },
          kind: { kind: 'markdown', flavor: 'mdext' }, modes: ['rendered'], size: 100, contentVersion: '1' }}
          mode="rendered" text={{ ok: true, kind: 'text', contentVersion: '1', text: '[![Chart](chart.png)](other.md)' }}
          diff={null} baselines={{ error: null, loading: false, chosen: false }} onOpenSource={onOpenSource} />
      </FileImageSurface>
    </section>)
    const thumbnail = await screen.findByRole('img', { name: 'Chart' })
    fireEvent.click(thumbnail)
    fireEvent.doubleClick(thumbnail)
    const full = await within(screen.getByRole('dialog')).findByRole('img', { name: 'Chart' })
    expect(full).toHaveAttribute('src', 'jamat-v3-file://resource/picture')
    expect(onOpenSource).not.toHaveBeenCalled()
    expect(ports.relativeResource).toHaveBeenCalledExactlyOnceWith('doc', 'chart.png')
    fireEvent.keyDown(full, { key: 'Escape' })
    expect(view.container.querySelector('.file-viewer')).toHaveFocus()
    expect(thumbnail).toBeInTheDocument()
    fireEvent.contextMenu(thumbnail)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open image full screen' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  })
  it('copies the whole image from the toolbar button and from Ctrl+C', async () => {
    const copy = vi.spyOn(FileImageTransfer, 'copy').mockResolvedValue()
    const { dialog } = await open()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(copy).toHaveBeenLastCalledWith('data:image/png;base64,AA==', undefined)
    expect(await screen.findByText('Image copied to clipboard')).toHaveAttribute('role', 'status')
    fireEvent.keyDown(dialog, { key: 'c', ctrlKey: true })
    expect(copy).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('shows why a copy failed', async () => {
    vi.spyOn(FileImageTransfer, 'copy').mockRejectedValue(new Error('Another application held the clipboard'))
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Image not copied: Another application held the clipboard')
  })

  it('copies a selected area in the image pixels and leaves area mode', async () => {
    const copy = vi.spyOn(FileImageTransfer, 'copy').mockResolvedValue()
    const { image } = await open()
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) })
    const area = screen.getByRole('button', { name: 'Copy area' })
    fireEvent.click(area)
    expect(area).toHaveAttribute('aria-pressed', 'true')
    const viewport = image.closest('.image-viewer__viewport')!
    fireEvent.pointerDown(viewport, { button: 0, clientX: 300, clientY: 250 })
    fireEvent.pointerMove(viewport, { clientX: 100, clientY: 100 })
    expect(document.querySelector('.image-viewer__selection')).toHaveStyle({ left: '100px', top: '100px', width: '200px', height: '150px' })
    fireEvent.pointerUp(viewport)
    expect(copy).toHaveBeenCalledExactlyOnceWith('data:image/png;base64,AA==', { x: 200, y: 200, width: 400, height: 300 })
    expect(area).toHaveAttribute('aria-pressed', 'false')
    expect(viewport.scrollLeft).toBe(0)
  })

  it('cancels area mode on Escape without closing the viewer', async () => {
    const copy = vi.spyOn(FileImageTransfer, 'copy').mockResolvedValue()
    const { dialog } = await open()
    const area = screen.getByRole('button', { name: 'Copy area' })
    fireEvent.click(area)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(area).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(copy).not.toHaveBeenCalled()
  })
})

describe('document image transfer', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('copies an image from its context menu', async () => {
    const copy = vi.spyOn(FileImageTransfer, 'copy').mockResolvedValue()
    render(<FileImageSurface name="doc.md"><img src="jamat-v3-file://resource/picture" alt="Chart" /></FileImageSurface>)
    fireEvent.contextMenu(screen.getByRole('img', { name: 'Chart' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy image to clipboard' }))
    expect(await screen.findByText('Image copied to clipboard')).toHaveAttribute('role', 'status')
    expect(copy).toHaveBeenCalledExactlyOnceWith('jamat-v3-file://resource/picture')
  })

  it('drags a protocol image as a file instead of its URL', async () => {
    const startResourceDrag = vi.fn(async () => ({ ok: true as const, value: true }))
    vi.stubGlobal('appClient', { fileViewer: { startResourceDrag } })
    render(<FileImageSurface name="doc.md"><img src="jamat-v3-file://resource/picture%201" alt="Chart" /></FileImageSurface>)
    expect(fireEvent.dragStart(screen.getByRole('img', { name: 'Chart' }))).toBe(false)
    expect(startResourceDrag).toHaveBeenCalledExactlyOnceWith('picture 1')
  })

  it('leaves the browser drag of any other image alone and reports a refused drag', async () => {
    const startResourceDrag = vi.fn(async () => ({ ok: false as const, error: 'Only source images can be dragged' }))
    vi.stubGlobal('appClient', { fileViewer: { startResourceDrag } })
    render(<FileImageSurface name="doc.md">
      <img src="data:image/png;base64,AA==" alt="Inline" />
      <img src="jamat-v3-file://resource/picture" alt="Chart" />
    </FileImageSurface>)
    expect(fireEvent.dragStart(screen.getByRole('img', { name: 'Inline' }))).toBe(true)
    expect(startResourceDrag).not.toHaveBeenCalled()
    fireEvent.dragStart(screen.getByRole('img', { name: 'Chart' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Only source images can be dragged')
  })
})
