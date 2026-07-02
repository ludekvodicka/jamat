import type { Components } from 'react-markdown'
import { ShikiCode } from './renderers/shikiCode'
import { Diagram } from './renderers/diagram'
import { DIAGRAM_LANGS } from './renderers/renderDiagram'
import { safeHref, safeImgSrc } from './security'

/** react-markdown component registry, parameterized by the security tier. `rawHtml` (the opt-in
 *  raw-HTML hatch) additionally blocks external image resources so raw `<img src=http://…>` can't
 *  auto-load a beacon — links stay on the `remote` rule (clicking is user-initiated). */
export function mdExtComponents(
  { remote, rawHtml = false, resolveImageSrc }:
    { remote: boolean; rawHtml?: boolean; resolveImageSrc?: (rawSrc: string) => string | undefined },
): Components {
  return {
    // Block code is rendered by ShikiCode (which emits its own <pre>); unwrap react-markdown's
    // default <pre> so we don't nest a block element inside <pre>. Inline code never hits this.
    pre({ children }) {
      return <>{children}</>
    },
    code({ node, className, children }) {
      const text = String(children ?? '')
      // Allow hyphens in the language id (`language-vega-lite`) — `\w` alone stops at the hyphen.
      const lang = /language-([\w-]+)/.exec(className ?? '')?.[1]
      // Block vs inline by the NODE position (react-markdown v9 removed the `inline` prop), NOT by
      // language presence — so a language-less multi-line fence still renders as a block, not inline.
      const start = node?.position?.start.line
      const end = node?.position?.end.line
      const isBlock = (start != null && end != null && start !== end) || /\n/.test(text)
      if (!isBlock) return <code className="mdext-inline">{children}</code>
      const src = text.replace(/\n$/, '')
      if (lang && DIAGRAM_LANGS.has(lang)) return <Diagram kind={lang} source={src} />
      return <ShikiCode lang={lang ?? 'text'} source={src} />
    },
    a: makeSafeLink(remote),
    // The host resolver (local file → data: URL) is passed only OUTSIDE the remote tier — a peer's
    // files must never auto-load. `blockExternal` still governs any src the resolver declines.
    img: makeSafeImg(remote || rawHtml, remote ? undefined : resolveImageSrc),
  }
}

function makeSafeLink(remote: boolean): Components['a'] {
  return function MdExtLink({ href, children }) {
    const safe = safeHref(href, remote)
    if (!safe) return <span className="mdext-blocked-link">{children}</span>
    // `title` gives a hover tooltip showing where the link points. `target=_blank` is a safe default
    // for non-intercepting hosts; the Jamat FileViewer intercepts clicks (opens file links
    // in a new tab, external links in the browser), so no new window appears there.
    return (
      <a href={safe} title={safe} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    )
  }
}

function makeSafeImg(
  blockExternal: boolean,
  resolveImageSrc?: (rawSrc: string) => string | undefined,
): Components['img'] {
  return function MdExtImg({ src, alt }) {
    const raw = typeof src === 'string' ? src : undefined
    // Host resolver first: a local viewer maps a relative / on-disk src to a loadable (data:) URL.
    // Its output is host-produced → trusted, so it bypasses the file:/data: block in safeImgSrc.
    const resolved = raw && resolveImageSrc ? resolveImageSrc(raw) : undefined
    const safe = resolved ?? safeImgSrc(raw, blockExternal)
    if (!safe) return <span className="mdext-blocked-img">{alt || '[image blocked]'}</span>
    return <img src={safe} alt={alt ?? ''} loading="lazy" />
  }
}
