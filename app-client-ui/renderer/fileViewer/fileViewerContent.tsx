import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { FileDiffResult } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type {
  FileViewerDocument,
  FileViewerDocumentSource,
  FileViewerLocation,
  FileViewerTextResult,
  FileViewerViewMode,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import {
  MdExtRenderer,
  MdExtSecurity,
  useHighlightedHtml,
} from '../../../mdext-renderer/renderer'
import { FileViewerProtocolUrl } from '../../shared/fileViewerProtocol'
import { FileDiffView } from './fileDiffView'
import { FileHexView } from './fileHexView'
import { FileHtmlView } from './fileHtmlView'
import { FileViewerPath } from './fileViewerPath'

/** Why there is no diff yet, in the three ways that are not the same thing. */
export interface FileViewerBaselineState {
  /** The change list refused; there is nothing to choose from and this says why. */
  error: string | null
  loading: boolean
  /** Whether a baseline has been picked at all. */
  chosen: boolean
}

export function FileViewerContent(props: {
  document: FileViewerDocument
  mode: FileViewerViewMode
  text: FileViewerTextResult | null
  diff: FileDiffResult | null
  baselines: FileViewerBaselineState
  location?: FileViewerLocation
  onOpenSource(source: FileViewerDocumentSource): void
}): React.JSX.Element {
  let content: React.JSX.Element
  if (props.mode === 'hex') content = <FileHexView documentId={props.document.documentId} />
  else if (props.mode === 'preview') content = <FileMediaPreview document={props.document} />
  else if (props.mode === 'diff')
    content = (
      <FileDiffContent
        document={props.document}
        text={props.text}
        diff={props.diff}
        baselines={props.baselines}
      />
    )
  else if (props.mode === 'raw')
    content = <FileRawContent result={props.text} location={props.location} />
  else if (props.mode === 'rendered')
    content = (
      <FileRenderedContent
        document={props.document}
        result={props.text}
        location={props.location}
        onOpenSource={props.onOpenSource}
      />
    )
  else throw new Error(`Unknown file viewer mode: ${JSON.stringify(props.mode)}`)
  return props.location === undefined
    ? content
    : <FileViewerLineReveal location={props.location}>{content}</FileViewerLineReveal>
}

function FileRenderedContent(props: {
  document: FileViewerDocument
  result: FileViewerTextResult | null
  location?: FileViewerLocation
  onOpenSource(source: FileViewerDocumentSource): void
}): React.JSX.Element {
  /*
   * Both of these are memoised, and above the early return, because react-markdown takes the
   * `components` object as the element TYPE of every node it draws. A new identity there is not a
   * re-render, it is an unmount and a fresh mount of the whole document: every diagram runs its
   * engine again, every code fence loses its highlighting, and every image asks for a new resource
   * grant out of a store that holds 512 and is shared by every window - so a handful of renders
   * evicted grants a video in another window was still streaming from.
   *
   * The renders are not rare. Dragging the sidebar splitter commits one per pointer move.
   */
  const documentId = props.document.documentId
  const documentPath = props.document.path
  const documentSource = props.document.source
  const onOpenSource = props.onOpenSource
  const resolveImage = useCallback(async (reference: string): Promise<string | null> => {
    const answer = await window.appClient.fileViewer.relativeResource(documentId, reference)
    return answer.ok && answer.value.ok
      ? FileViewerProtocolUrl.resource(answer.value.value.resourceId)
      : null
  }, [documentId])
  const onLink = useCallback((reference: string): void => {
    if (reference.startsWith('#')) {
      document.getElementById(reference.slice(1))?.scrollIntoView({ block: 'start' })
      return
    }
    if (/^https?:/i.test(reference)) {
      void window.appClient.fileViewer.openExternal(reference)
      return
    }
    const path = FileViewerPath.resolve(documentPath, reference)
    onOpenSource({ ...documentSource, path })
  }, [documentPath, documentSource, onOpenSource])
  const text = FileViewerText.value(props.result)
  if (!text.ok) return <p className={text.error ? 'file-viewer-error' : 'file-viewer-note'}>{text.detail}</p>
  const source = FileViewerText.withoutBom(text.value)
  const kind = props.document.kind
  if (kind.kind === 'markdown')
    return <MdExtRenderer source={source} resolveImage={resolveImage} onLink={onLink} />
  if (kind.kind === 'html')
    return (
      <FileHtmlView
        documentId={props.document.documentId}
        name={props.document.name}
        source={source}
      />
    )
  if (kind.kind === 'code')
    return <FileHighlightedCode source={source} language={kind.language} location={props.location} />
  if (kind.kind === 'svg')
    return (
      <div
        className="file-viewer-svg"
        role="img"
        aria-label={props.document.name}
        dangerouslySetInnerHTML={{ __html: MdExtSecurity.svg(source) }}
      />
    )
  if (kind.kind === 'text')
    return props.location === undefined
      ? <pre className="file-viewer-raw">{source}</pre>
      : <FileSourceLines source={source} className="file-viewer-raw" />
  throw new Error(`Document cannot use rendered mode: ${JSON.stringify(kind)}`)
}

function FileHighlightedCode(props: {
  source: string
  language: string
  location?: FileViewerLocation
}): React.JSX.Element {
  const html = useHighlightedHtml(props.source, props.language)
  const inner = useMemo(() => html === null ? null : { __html: html }, [html])
  return inner === null
    ? props.location === undefined
      ? <pre className="file-viewer-raw">{props.source}</pre>
      : <FileSourceLines source={props.source} className="file-viewer-raw" />
    : <div className="file-viewer-code" dangerouslySetInnerHTML={inner} />
}

function FileRawContent(props: {
  result: FileViewerTextResult | null
  location?: FileViewerLocation
}): React.JSX.Element {
  const text = FileViewerText.value(props.result)
  return text.ok
    ? props.location === undefined
      ? <pre className="file-viewer-raw">{text.value}</pre>
      : <FileSourceLines source={text.value} className="file-viewer-raw" />
    : <p className={text.error ? 'file-viewer-error' : 'file-viewer-note'}>{text.detail}</p>
}

function FileSourceLines(props: { source: string; className: string }): React.JSX.Element {
  return (
    <pre className={`${props.className} file-viewer-source-lines`}>
      {props.source.split('\n').map((sourceLine, index) => {
        const line = sourceLine.endsWith('\r') ? sourceLine.slice(0, -1) : sourceLine
        return <span key={index} data-file-line={index + 1}>{line}</span>
      })}
    </pre>
  )
}

function FileViewerLineReveal(props: {
  location: FileViewerLocation
  children: React.ReactNode
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = root.current
    if (container === null) return
    let target: HTMLElement | null = null
    let timer: number | null = null
    const reveal = (): void => {
      const next = FileViewerLineTargets.find(container, props.location.line)
      if (next === null || next === target) return
      target?.classList.remove(FileViewerLineTargets.classNameConst)
      target = next
      for (const details of FileViewerLineTargets.closedDetailsOf(next)) details.open = true
      next.classList.add(FileViewerLineTargets.classNameConst)
      next.scrollIntoView({ block: 'center', inline: 'nearest' })
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        next.classList.remove(FileViewerLineTargets.classNameConst)
        timer = null
      }, FileViewerLineTargets.highlightMillisecondsConst)
    }
    reveal()
    // Shiki replaces its plain fallback asynchronously, so the final line can arrive after this effect.
    const observer = new MutationObserver(reveal)
    observer.observe(container, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (timer !== null) window.clearTimeout(timer)
      target?.classList.remove(FileViewerLineTargets.classNameConst)
    }
  }, [props.location])

  return <div ref={root} className="file-viewer-location">{props.children}</div>
}

class FileViewerLineTargets {
  static readonly classNameConst = 'file-viewer-line-target'
  static readonly highlightMillisecondsConst = 1_800

  static find(root: HTMLElement, line: number): HTMLElement | null {
    if (!Number.isSafeInteger(line) || line < 1) return null
    const exact = root.querySelector<HTMLElement>(`[data-file-line="${line}"]`)
    if (exact !== null) return FileViewerLineTargets.visibleTarget(exact)
    const codeLines = root.querySelectorAll<HTMLElement>('.file-viewer-code .line')
    if (line <= codeLines.length) return codeLines.item(line - 1)
    const ranged = [...root.querySelectorAll<HTMLElement>(
      '[data-file-line-start][data-file-line-end]',
    )]
    const containing = ranged.filter((element) => {
      const range = FileViewerLineTargets.rangeOf(element)
      return range !== null && range.start <= line && line <= range.end
    })
    containing.sort((left, right) => {
      const leftRange = FileViewerLineTargets.rangeOf(left)!
      const rightRange = FileViewerLineTargets.rangeOf(right)!
      const width = leftRange.end - leftRange.start - (rightRange.end - rightRange.start)
      if (width !== 0) return width
      if (left.contains(right)) return 1
      if (right.contains(left)) return -1
      return 0
    })
    if (containing.length > 0) return FileViewerLineTargets.visibleTarget(containing[0])
    const positioned = ranged
      .map((element) => ({ element, range: FileViewerLineTargets.rangeOf(element) }))
      .filter((item): item is { element: HTMLElement; range: { start: number; end: number } } =>
        item.range !== null)
      .sort((left, right) => left.range.start - right.range.start)
    const nearest = positioned.find((item) => item.range.start > line)?.element
      ?? positioned[positioned.length - 1]?.element
      ?? null
    return nearest === null ? null : FileViewerLineTargets.visibleTarget(nearest)
  }

  static closedDetailsOf(target: HTMLElement): HTMLDetailsElement[] {
    const details: HTMLDetailsElement[] = []
    for (let current: Element | null = target; current !== null; current = current.parentElement)
      if (current instanceof HTMLDetailsElement && !current.open) details.push(current)
    return details
  }

  private static rangeOf(element: HTMLElement): { start: number; end: number } | null {
    const start = Number.parseInt(element.dataset.fileLineStart ?? '', 10)
    const end = Number.parseInt(element.dataset.fileLineEnd ?? '', 10)
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) ? { start, end } : null
  }

  private static visibleTarget(element: HTMLElement): HTMLElement {
    const child = element.classList.contains('mdext-source-block')
      ? element.firstElementChild
      : null
    return child instanceof HTMLElement ? child : element
  }
}

/**
 * `diff === null` carried three different states: nobody has chosen a baseline, the change list
 * could not be read so there is nothing to choose FROM, and the diff is on its way. All three drew
 * "Select a diff baseline." - so a session whose VCS read failed opened with a calm invitation to
 * choose and nowhere to learn why the list was empty. The reason lived in the sidebar widget, which
 * is only on screen when that tab is open.
 */
function FileDiffContent(props: {
  document: FileViewerDocument
  text: FileViewerTextResult | null
  diff: FileDiffResult | null
  baselines: FileViewerBaselineState
}): React.JSX.Element {
  if (props.diff === null) {
    if (props.baselines.error !== null)
      return (
        <p className="file-viewer-error">
          The change list could not be read: {props.baselines.error}
        </p>
      )
    if (props.baselines.loading)
      return <p className="file-viewer-note">Reading the change list...</p>
    if (!props.baselines.chosen) return <p className="file-viewer-note">Select a diff baseline.</p>
    return <p className="file-viewer-note">Loading the diff...</p>
  }
  if (!props.diff.ok) return <p className="file-viewer-error">{props.diff.code}: {props.diff.detail}</p>
  if (props.diff.kind !== 'text') return <p className="file-viewer-note">{props.diff.detail}</p>
  const current = FileViewerText.value(props.text)
  return (
    <FileDiffView
      data={props.diff.data}
      currentText={current.ok ? current.value : null}
      language={FileViewerText.language(props.document)}
    />
  )
}

function FileMediaPreview(props: { document: FileViewerDocument }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fit = useFileViewerMediaFit(url)
  useEffect(() => {
    let alive = true
    setUrl(null)
    setError(null)
    void window.appClient.fileViewer.mediaResource(props.document.documentId).then((answer) => {
      if (!alive) return
      if (!answer.ok) setError(answer.error)
      else if (!answer.value.ok) setError(`${answer.value.code}: ${answer.value.detail}`)
      else setUrl(FileViewerProtocolUrl.resource(answer.value.value.resourceId))
    })
    return () => { alive = false }
  }, [props.document.documentId])
  if (error) return <p className="file-viewer-error">{error}</p>
  if (url === null) return <p className="file-viewer-note">Loading media...</p>
  if (props.document.kind.kind === 'image')
    return (
      <div className="file-viewer-media">
        <div className="file-viewer-media-frame" style={fit.style}>
          <img
            ref={fit.media as React.RefObject<HTMLImageElement | null>}
            src={url}
            alt={props.document.name}
            onLoad={fit.remeasure}
            onError={() => setError('The image cannot be decoded. Use Hex to inspect it.')}
          />
        </div>
      </div>
    )
  else if (props.document.kind.kind === 'video')
    return (
      <div className="file-viewer-media">
        <div className="file-viewer-media-frame" style={fit.style}>
          <video
            ref={fit.media as React.RefObject<HTMLVideoElement | null>}
            src={url}
            controls
            preload="metadata"
            onLoadedMetadata={fit.remeasure}
            onError={() => setError('The video cannot be decoded. Use Hex to inspect it.')}
          />
        </div>
      </div>
    )
  else throw new Error(`Document cannot use preview mode: ${JSON.stringify(props.document.kind)}`)
}

/**
 * The size the picture fits at, which is what the zoom multiplies and what the frame is built from.
 *
 * It is READ rather than computed: `offsetWidth` is the laid-out size, which `transform` does not
 * touch, so one measurement answers it for every zoom. Until it is known the frame carries no fit
 * variables at all and the stylesheet falls back to the plain fit rules - which is precisely the
 * state being measured. A resize of the panel drops the measurement, because the fit is a fact
 * about the picture AND the box it is drawn in.
 */
function useFileViewerMediaFit(url: string | null): {
  media: React.RefObject<HTMLElement | null>
  style: React.CSSProperties | undefined
  remeasure(): void
} {
  const media = useRef<HTMLElement | null>(null)
  const [fit, setFit] = useState<{ width: number; height: number } | null>(null)
  const remeasure = useCallback((): void => setFit(null), [])

  useLayoutEffect(() => {
    const element = media.current
    if (fit !== null || element === null) return
    setFit({ width: element.offsetWidth, height: element.offsetHeight })
  }, [fit, url])

  useEffect(() => {
    const frame = media.current?.parentElement ?? null
    const box = frame?.parentElement ?? null
    if (box === null) return
    const observer = new ResizeObserver(remeasure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [remeasure, url])

  return {
    media,
    style: fit === null
      ? undefined
      : {
        '--file-viewer-media-fit-width': `${fit.width}px`,
        '--file-viewer-media-fit-height': `${fit.height}px`,
      } as React.CSSProperties,
    remeasure,
  }
}

export class FileViewerText {
  static value(result: FileViewerTextResult | null):
    | { ok: true; value: string }
    | { ok: false; error: boolean; detail: string } {
    if (result === null) return { ok: false, error: false, detail: 'Loading file...' }
    if (!result.ok) return { ok: false, error: true, detail: `${result.code}: ${result.detail}` }
    if (result.kind === 'text') return { ok: true, value: result.text }
    else if (result.kind === 'too-large') return { ok: false, error: false, detail: result.detail }
    else if (result.kind === 'binary') return { ok: false, error: false, detail: result.detail }
    else throw new Error(`Unknown file text result: ${JSON.stringify(result)}`)
  }

  static language(document: FileViewerDocument): string {
    const kind = document.kind
    if (kind.kind === 'code') return kind.language
    else if (kind.kind === 'markdown') return 'markdown'
    else if (kind.kind === 'html') return 'html'
    else if (kind.kind === 'svg') return 'xml'
    else if (kind.kind === 'text' || kind.kind === 'hex' || kind.kind === 'image'
      || kind.kind === 'video' || kind.kind === 'missing')
      return 'text'
    else
      throw new Error(`Unknown file viewer document kind: ${JSON.stringify(kind)}`)
  }

  /** The name says what it does: a leading BOM is a byte-order mark, not a character to draw. */
  static withoutBom(value: string): string {
    return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
  }
}
