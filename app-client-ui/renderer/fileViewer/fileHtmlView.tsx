import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import type { SessionFilePorts } from '../../shared/sessionWorkspace'
import { useEffect, useMemo, useState } from 'react'

import { MdExtSecurity } from '../../../mdext-renderer/renderer'
import { ErrorText } from '../../shared/errorText'
import { FileViewerProtocolUrl } from '../../shared/fileViewerProtocol'

type HtmlPreviewPorts = Pick<AppClientUiBridge['fileViewer'], 'registerHtmlPreview' | 'releaseHtmlPreview'>
type RenderedHtml = { kind: 'static'; html: string } | { kind: 'scripted'; url: string }

/**
 * An HTML file drawn the way a browser would draw it, inside a frame of its own.
 *
 * By default nothing in it runs: a sandboxed `srcdoc` frame carries no `allow-scripts`, inherits
 * the app's own CSP, and `MdExtSecurity.page` removes every script and handler before either
 * refusal is needed.
 *
 * When the reader opts into `allowScripts` for one open document, the prepared HTML is registered
 * in main and loaded from its own ephemeral `jamat-v3-html://<previewId>/` origin with a strict
 * offline CSP (inline scripts and styles allowed, no network, no subframes, no parent or preload
 * access). Each preview gets its own cross-origin host so `history.replaceState` works while the
 * frame stays isolated from both the shell and other open HTML documents.
 */
export function FileHtmlView(props: {
  ports: Pick<SessionFilePorts['viewer'], 'relativeResource'>
  documentId: string
  name: string
  source: string
  allowScripts?: boolean
  onAllowScriptsChange?(allow: boolean): void
  preview?: HtmlPreviewPorts
}): React.JSX.Element {
  const allowScripts = props.allowScripts === true
  const preview = props.preview ?? window.appClient?.fileViewer
  const [rendered, setRendered] = useState<RenderedHtml | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hasScripts = useMemo(() => FileHtmlPage.hasScripts(props.source), [props.source])

  useEffect(() => {
    let alive = true
    let registeredId: string | null = null
    setRendered(null)
    setError(null)
    const release = (previewId: string): void => {
      void preview?.releaseHtmlPreview?.(previewId).catch(() => undefined)
    }
    const load = async (): Promise<void> => {
      if (!allowScripts) {
        const html = await FileHtmlPage.of(props.source, props.documentId, props.ports)
        if (alive) setRendered({ kind: 'static', html })
        return
      }
      if (!preview?.registerHtmlPreview || !preview.releaseHtmlPreview) {
        if (alive) setError('Scripted HTML preview is unavailable.')
        return
      }
      const html = await FileHtmlPage.scripted(props.source, props.documentId, props.ports)
      if (!alive) return
      const answer = await preview.registerHtmlPreview(html)
      if (!answer.ok) {
        if (alive) setError(answer.error)
        return
      }
      if (!alive) {
        release(answer.value)
        return
      }
      registeredId = answer.value
      setRendered({ kind: 'scripted', url: FileViewerProtocolUrl.html(answer.value) })
    }
    void load().catch((reason: unknown) => {
      if (alive) setError(ErrorText.of(reason))
    })
    return () => {
      alive = false
      if (registeredId !== null) release(registeredId)
    }
  }, [props.source, props.documentId, props.ports, allowScripts, preview])

  if (error !== null) return <p className="file-viewer-error">{error}</p>
  if (rendered === null) return <p className="file-viewer-note">Rendering the page...</p>
  const frame = rendered.kind === 'static'
    ? <iframe className="file-viewer-html" title={props.name} sandbox="" srcDoc={rendered.html} />
    : <iframe className="file-viewer-html" title={props.name} sandbox="allow-scripts allow-same-origin" src={rendered.url} />
  if (!allowScripts && hasScripts && props.onAllowScriptsChange)
    return (
      <div className="file-viewer-html-host">
        <div className="file-viewer-html-banner" role="status">
          <span>Scripts are disabled in this preview.</span>
          <button type="button" onClick={() => props.onAllowScriptsChange?.(true)}>
            Enable scripts
          </button>
        </div>
        {frame}
      </div>
    )
  return frame
}

/** The document that goes into the frame: sanitised, its pictures granted, its own styling intact. */
export class FileHtmlPage {
  /**
   * What the page looks like before it says anything itself, and why it is not the app's own theme:
   * a file like this is written against a browser's defaults, so a report with no colours of its own
   * would be black text on the app's dark ground - unreadable - if it inherited this window instead.
   *
   * The ground is NAMED rather than themed, and it is stated rather than left to `color-scheme`:
   * measured in Chromium on 2026-09-08, a frame whose document sets no background keeps a
   * transparent canvas whatever its colour scheme, so the app's dark ground showed straight through
   * and the page's own black text was invisible on it. It goes in FIRST, so every rule the page
   * carries wins over it.
   */
  static readonly baseStyleConst = ':root{color-scheme:light}'
    + 'html{background:white;color:black;'
    + 'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5}'
    + 'body{margin:16px}'

  /**
   * How many pictures one page may hold a grant for. The store keeps 512 of them for every window
   * in the app, so one page of thumbnails must not be able to evict what another window is reading.
   */
  private static readonly imagesMaxConst = 64
  private static readonly scriptedBlockedSelectorConst =
    'iframe,frame,frameset,object,embed,applet,base,link,meta[http-equiv]'
  private static readonly scriptedBlockedAttributesConst = ['srcdoc', 'ping', 'formaction'] as const

  static hasScripts(source: string): boolean {
    const parsed = new DOMParser().parseFromString(source, 'text/html')
    if (parsed.querySelector('script') !== null) return true
    for (const element of parsed.querySelectorAll('*'))
      for (const attribute of element.attributes)
        if (/^on[a-z]/i.test(attribute.name)) return true
    return false
  }

  static async of(source: string, documentId: string, ports: Pick<SessionFilePorts['viewer'], 'relativeResource'>): Promise<string> {
    const parsed = new DOMParser().parseFromString(MdExtSecurity.page(source), 'text/html')
    return FileHtmlPage.finalize(parsed, documentId, ports)
  }

  /**
   * Keeps inline scripts and event handlers while still stripping nested frames, plugins, base/link
   * tags, meta redirects, `srcset` and non-image `src` attributes. The response CSP on
   * `jamat-v3-html:` enforces the same offline boundary independently.
   */
  static async scripted(source: string, documentId: string, ports: Pick<SessionFilePorts['viewer'], 'relativeResource'>): Promise<string> {
    const parsed = new DOMParser().parseFromString(source, 'text/html')
    for (const element of parsed.querySelectorAll(FileHtmlPage.scriptedBlockedSelectorConst))
      element.remove()
    for (const attribute of FileHtmlPage.scriptedBlockedAttributesConst)
      for (const element of parsed.querySelectorAll(`[${attribute}]`))
        element.removeAttribute(attribute)
    return FileHtmlPage.finalize(parsed, documentId, ports)
  }

  private static async finalize(parsed: Document, documentId: string, ports: Pick<SessionFilePorts['viewer'], 'relativeResource'>): Promise<string> {
    FileHtmlPage.strip(parsed)
    await FileHtmlPage.images(parsed, documentId, ports)
    const style = parsed.createElement('style')
    style.textContent = FileHtmlPage.baseStyleConst
    parsed.head.insertBefore(style, parsed.head.firstChild)
    return `<!doctype html>${parsed.documentElement.outerHTML}`
  }

  /**
   * Every source of a request this document did not grant. `srcset` is the one that hides: it names
   * candidates the picture pass below never sees, so a page could name a remote URL there and have
   * it fetched the moment the frame lays out.
   */
  private static strip(parsed: Document): void {
    for (const element of parsed.querySelectorAll('[srcset]')) element.removeAttribute('srcset')
    for (const element of parsed.querySelectorAll('[src]'))
      if (!(element instanceof HTMLImageElement)) element.removeAttribute('src')
  }

  /**
   * A picture beside the file, through the same grant the markdown renderer uses: main resolves the
   * reference against the document's own directory and refuses anything outside its grant, so the
   * page cannot read the disk by naming it. An embedded `data:` picture is already in the file and
   * needs nobody's permission; every other scheme loses its `src` rather than being fetched.
   */
  private static async images(parsed: Document, documentId: string, ports: Pick<SessionFilePorts['viewer'], 'relativeResource'>): Promise<void> {
    const images = [...parsed.querySelectorAll('img[src]')]
    for (const beyond of images.slice(FileHtmlPage.imagesMaxConst)) beyond.removeAttribute('src')
    await Promise.all(images.slice(0, FileHtmlPage.imagesMaxConst).map(async (image) => {
      const value = image.getAttribute('src') ?? ''
      if (/^data:image\//i.test(value.trim())) return
      const reference = MdExtSecurity.relativeImage(value)
      if (reference === null) {
        image.removeAttribute('src')
        return
      }
      const answer = await ports.relativeResource(documentId, reference)
      if (answer.ok && answer.value.ok)
        image.setAttribute('src', FileViewerProtocolUrl.resource(answer.value.value.resourceId))
      else image.removeAttribute('src')
    }))
  }
}
