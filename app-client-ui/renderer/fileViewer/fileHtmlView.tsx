import { useEffect, useState } from 'react'

import { MdExtSecurity } from '../../../mdext-renderer/renderer'
import { ErrorText } from '../../shared/errorText'
import { FileViewerProtocolUrl } from '../../shared/fileViewerProtocol'

/**
 * An HTML file drawn the way a browser would draw it, inside a frame of its own.
 *
 * The frame is what makes this possible at all: a page brings a whole stylesheet, and `body { }` in
 * this document would restyle the application around it. A sandboxed `srcdoc` frame is a separate
 * document with an opaque origin, so the page's CSS reaches its own content and nothing else.
 *
 * Nothing in it runs. The frame carries no `allow-scripts`, and a `srcdoc` document inherits the
 * app's own CSP, so a page's script is refused twice over and its `<script>` is gone before either
 * refusal is needed. What that costs is the page that DRAWS itself with JavaScript: a chart built
 * by a library at load time comes up empty, and its markup is what `raw` is for. Links are inert
 * for the same reason - the frame may not navigate anything, this window included.
 */
export function FileHtmlView(props: {
  documentId: string
  name: string
  source: string
}): React.JSX.Element {
  const [page, setPage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setPage(null)
    setError(null)
    void FileHtmlPage.of(props.source, props.documentId).then(
      (html) => { if (alive) setPage(html) },
      (reason: unknown) => { if (alive) setError(ErrorText.of(reason)) },
    )
    return () => { alive = false }
  }, [props.source, props.documentId])

  if (error !== null) return <p className="file-viewer-error">{error}</p>
  if (page === null) return <p className="file-viewer-note">Rendering the page...</p>
  return <iframe className="file-viewer-html" title={props.name} sandbox="" srcDoc={page} />
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

  static async of(source: string, documentId: string): Promise<string> {
    const parsed = new DOMParser().parseFromString(MdExtSecurity.page(source), 'text/html')
    FileHtmlPage.strip(parsed)
    await FileHtmlPage.images(parsed, documentId)
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
  private static async images(parsed: Document, documentId: string): Promise<void> {
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
      const answer = await window.appClient.fileViewer.relativeResource(documentId, reference)
      if (answer.ok && answer.value.ok)
        image.setAttribute('src', FileViewerProtocolUrl.resource(answer.value.value.resourceId))
      else image.removeAttribute('src')
    }))
  }
}
