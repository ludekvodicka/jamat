import { Fragment, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkDirective from 'remark-directive'
import rehypeSanitize from 'rehype-sanitize'
import type { Pluggable, PluggableList } from 'unified'
import { splitFrontmatter } from './utils/splitFrontmatter'
import { remarkMdextDirectives } from './directives'
import { mdExtComponents } from './components'
import { MDEXT_SANITIZE } from './security'
import { MdExtThemeContext } from './theme'
import type { MdExtRendererProps } from './types'
import './mdExtRenderer.css'

// rehype-raw (the raw-HTML parser, pulls in parse5) is lazy-loaded ONLY when the escape hatch is
// on, so hosts that leave it off never bundle/run it. Module-level promise = load once, shared.
let rawPluginPromise: Promise<Pluggable> | null = null
const loadRehypeRaw = (): Promise<Pluggable> =>
  (rawPluginPromise ??= import('rehype-raw').then((m) => m.default as Pluggable))

/**
 * Deterministic, render-only Markdown viewer extended with our markers. v1a renders GFM +
 * syntax-highlighted code (Shiki) with an always-on sanitization baseline (raw HTML off via
 * react-markdown, rehype-sanitize on the hast, URL-scheme allow-list on links/images). MUI-free
 * and themed via CSS variables, so the same widget runs in MUI/Next and plain-React hosts.
 */
export function MdExtRenderer({
  source,
  theme = 'auto',
  className,
  remote = false,
  allowRawHtml = false,
  resolveImageSrc,
}: MdExtRendererProps) {
  // The hatch is hard-disabled for untrusted remote content, regardless of the prop.
  const rawOn = allowRawHtml && !remote
  const [rawPlugin, setRawPlugin] = useState<Pluggable | null>(null)
  useEffect(() => {
    if (!rawOn) {
      setRawPlugin(null)
      return
    }
    let alive = true
    loadRehypeRaw()
      .then((p) => {
        if (alive) setRawPlugin(() => p)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [rawOn])

  const { frontmatter, body } = splitFrontmatter(source)
  const classes = ['mdext', theme !== 'auto' ? `mdext-${theme}` : '', className].filter(Boolean).join(' ')
  // Until rehype-raw has loaded, fall back to the raw-off baseline (safe direction): raw HTML stays
  // inert, then re-renders with the hatch once the parser arrives. In raw mode, images also drop
  // external resources (no auto-load beacon) via the component's blockExternal path.
  const rehypePlugins: PluggableList =
    rawOn && rawPlugin ? [rawPlugin, [rehypeSanitize, MDEXT_SANITIZE]] : [[rehypeSanitize, MDEXT_SANITIZE]]
  return (
    <MdExtThemeContext.Provider value={theme}>
      <div className={classes}>
        {frontmatter && <MdExtFrontmatter entries={frontmatter} />}
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkDirective, remarkMdextDirectives]}
          rehypePlugins={rehypePlugins}
          components={mdExtComponents({ remote, rawHtml: rawOn, resolveImageSrc })}
        >
          {body}
        </ReactMarkdown>
      </div>
    </MdExtThemeContext.Provider>
  )
}

/** Compact, collapsible metadata strip — collapsed by default so it never dominates the view. */
function MdExtFrontmatter({ entries }: { entries: Array<[string, string]> }) {
  return (
    <details className="mdext-frontmatter">
      <summary>
        metadata <span className="mdext-frontmatter-count">({entries.length})</span>
      </summary>
      <dl className="mdext-frontmatter-list">
        {entries.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  )
}
