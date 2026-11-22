import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'

import { ErrorText } from '../../shared/errorText'
import { FileImageTransfer, type FileImageArea } from './fileImageTransfer'
import './imageViewer.css'

export interface ImageViewerResource {
  url: string
  release?(): void
}

export interface ImageViewerSource {
  name: string
  load(): Promise<ImageViewerResource>
}

export function useImageViewer(): {
  open(source: ImageViewerSource): void
  viewer: React.JSX.Element | null
} {
  const [source, setSource] = useState<ImageViewerSource | null>(null)
  const close = useCallback(() => setSource(null), [])
  const open = useCallback((next: ImageViewerSource) => {
    // Enter fullscreen during the click, before loading a local or remote file consumes its activation.
    flushSync(() => setSource(next))
  }, [])
  return { open, viewer: source === null ? null : <ImageViewer source={source} onClose={close} /> }
}

export function ImageViewer(props: { source: ImageViewerSource; onClose(): void }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fullscreenError, setFullscreenError] = useState<string | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [zoom, setZoom] = useState<number | null>(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const image = useRef<HTMLImageElement>(null)
  const [areaMode, setAreaMode] = useState(false)
  const [selection, setSelection] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [notice, setNotice] = useState<{ kind: 'done' | 'error'; text: string } | null>(null)
  const close = props.onClose

  useLayoutEffect(() => {
    const element = root.current!
    const previous = document.activeElement
    const siblings = [...document.body.children].filter((node): node is HTMLElement =>
      node instanceof HTMLElement && node !== element)
    const inert = siblings.map((node) => node.inert)
    for (const node of siblings) node.inert = true
    element.focus()
    let entered = false
    let alive = true
    const changed = (): void => {
      if (document.fullscreenElement === element) entered = true
      else if (entered) close()
    }
    document.addEventListener('fullscreenchange', changed)
    if (element.requestFullscreen)
      void element.requestFullscreen().catch((failure: unknown) => {
        if (alive) setFullscreenError(`Fullscreen unavailable: ${ErrorText.of(failure)}`)
      })
    else setFullscreenError('Fullscreen is unavailable in this window.')
    return () => {
      alive = false
      document.removeEventListener('fullscreenchange', changed)
      siblings.forEach((node, index) => { node.inert = inert[index] })
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
      const restoreFocus = (): void => {
        if (previous instanceof HTMLElement && previous.isConnected && !document.querySelector('.image-viewer'))
          previous.focus({ preventScroll: true })
      }
      // Chromium restores its own focus after the fullscreen transition, after React's cleanup.
      if (document.fullscreenElement === element) void document.exitFullscreen().then(restoreFocus, restoreFocus)
      window.requestAnimationFrame(restoreFocus)
    }
  }, [close])

  useEffect(() => {
    let alive = true
    let resource: ImageViewerResource | null = null
    setUrl(null)
    setError(null)
    setSize(null)
    setZoom(null)
    void props.source.load().then((loaded) => {
      if (!alive) { loaded.release?.(); return }
      resource = loaded
      setUrl(loaded.url)
    }).catch((failure: unknown) => { if (alive) setError(ErrorText.of(failure)) })
    return () => { alive = false; resource?.release?.() }
  }, [props.source])

  useLayoutEffect(() => {
    const element = viewport.current!
    const measure = (): void => setBounds({ width: element.clientWidth, height: element.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (notice?.kind !== 'done') return
    const timer = window.setTimeout(() => setNotice(null), 2_000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const copy = (area?: FileImageArea): void => {
    if (url === null || size === null) return
    setNotice(null)
    void FileImageTransfer.copy(url, area).then(
      () => setNotice({ kind: 'done', text: area ? 'Area copied to clipboard' : 'Image copied to clipboard' }),
      (failure: unknown) => setNotice({ kind: 'error', text: `Image not copied: ${ErrorText.of(failure)}` }))
  }
  const copySelection = (chosen: { x0: number; y0: number; x1: number; y1: number }): void => {
    const element = image.current
    if (element === null || size === null) return
    const box = element.getBoundingClientRect()
    const left = Math.max(box.left, Math.min(chosen.x0, chosen.x1)), right = Math.min(box.right, Math.max(chosen.x0, chosen.x1))
    const top = Math.max(box.top, Math.min(chosen.y0, chosen.y1)), bottom = Math.min(box.bottom, Math.max(chosen.y0, chosen.y1))
    if (right - left < 2 || bottom - top < 2 || box.width === 0 || box.height === 0) {
      setNotice({ kind: 'error', text: 'Drag across the image to select the area to copy.' })
      return
    }
    const scaleX = size.width / box.width, scaleY = size.height / box.height
    copy({ x: (left - box.left) * scaleX, y: (top - box.top) * scaleY, width: (right - left) * scaleX, height: (bottom - top) * scaleY })
  }
  const toggleAreaMode = (): void => {
    setSelection(null)
    setAreaMode((current) => !current)
  }

  const fit = size === null ? 1 : Math.min(1, bounds.width / size.width, bounds.height / size.height)
  const scale = zoom ?? fit
  const changeZoom = (factor: number): void => setZoom(Math.max(0.05, Math.min(16, scale * factor)))
  const width = size === null ? undefined : Math.max(1, size.width * scale)
  const height = size === null ? undefined : Math.max(1, size.height * scale)

  useEffect(() => {
    const element = viewport.current!
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (size === null || event.deltaY === 0) return
      setZoom((current) => Math.max(0.05, Math.min(16, (current ?? fit) * (event.deltaY < 0 ? 1.25 : 0.8))))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [fit, size])

  return createPortal(
    <div ref={root} className="image-viewer" role="dialog" aria-modal="true"
      aria-label={`Image: ${props.source.name}`} tabIndex={-1}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          if (areaMode) toggleAreaMode()
          else close()
        }
        else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); copy() }
        else if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(1.25) }
        else if (event.key === '-') { event.preventDefault(); changeZoom(0.8) }
        else if (event.key === '0') { event.preventDefault(); setZoom(null) }
        else if (event.key === '1') { event.preventDefault(); setZoom(1) }
        else if (event.key === 'Tab') {
          const buttons = [...root.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
          event.preventDefault()
          buttons[next]?.focus()
        }
      }}>
      <div className="image-viewer__toolbar">
        <span className="image-viewer__name" title={props.source.name}>{props.source.name}</span>
        {notice && <span className={`image-viewer__status image-viewer__status--${notice.kind}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</span>}
        {areaMode && !notice && <span className="image-viewer__status" role="status">Drag across the image to copy an area (Esc cancels)</span>}
        {size && <span className="image-viewer__dimensions">{size.width} × {size.height}</span>}
        <button type="button" disabled={!size} aria-label="Zoom out" onClick={() => changeZoom(0.8)}>−</button>
        <output aria-label="Image zoom">{Math.round(scale * 100)}%</output>
        <button type="button" disabled={!size} aria-label="Zoom in" onClick={() => changeZoom(1.25)}>+</button>
        <button type="button" disabled={!size} aria-pressed={zoom === null} onClick={() => setZoom(null)}>Fit</button>
        <button type="button" disabled={!size} aria-pressed={zoom === 1} onClick={() => setZoom(1)}>1:1</button>
        <button type="button" disabled={!size} title="Copy image to clipboard (Ctrl+C)" onClick={() => copy()}>Copy</button>
        <button type="button" disabled={!size} aria-pressed={areaMode} title="Select an area of the image and copy it to clipboard"
          onClick={toggleAreaMode}>Copy area</button>
        <button type="button" title="Close (Esc)" aria-label="Close image viewer" onClick={close}>×</button>
      </div>
      {fullscreenError && <p className="image-viewer__notice" role="status">{fullscreenError}</p>}
      <div ref={viewport} className={`image-viewer__viewport${areaMode ? ' image-viewer__viewport--area' : ''}`}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          const element = event.currentTarget
          if (areaMode) {
            setSelection({ x0: event.clientX, y0: event.clientY, x1: event.clientX, y1: event.clientY })
            element.setPointerCapture(event.pointerId)
            return
          }
          pan.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop }
          element.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (areaMode) {
            const { clientX, clientY } = event
            setSelection((current) => current && { ...current, x1: clientX, y1: clientY })
            return
          }
          if (!pan.current) return
          event.currentTarget.scrollLeft = pan.current.left + pan.current.x - event.clientX
          event.currentTarget.scrollTop = pan.current.top + pan.current.y - event.clientY
        }}
        onPointerUp={() => {
          pan.current = null
          if (!areaMode || selection === null) return
          setSelection(null)
          setAreaMode(false)
          copySelection(selection)
        }}
        onPointerCancel={() => { pan.current = null; setSelection(null) }}>
        {error ? <p className="image-viewer__error" role="alert">{error}</p>
          : url === null ? <p className="image-viewer__loading" role="status">Loading image…</p>
            : <div className="image-viewer__canvas" style={{ minWidth: width, minHeight: height }}>
              <img ref={image} src={url} alt={props.source.name} draggable={false} style={{ width, height }}
                onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                onError={() => setError('This image could not be decoded.')} />
            </div>}
      </div>
      {selection && <div className="image-viewer__selection" style={{
        left: Math.min(selection.x0, selection.x1), top: Math.min(selection.y0, selection.y1),
        width: Math.abs(selection.x1 - selection.x0), height: Math.abs(selection.y1 - selection.y0),
      }} />}
    </div>, document.body,
  )
}
