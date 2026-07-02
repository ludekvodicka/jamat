import { useEffect, useMemo, useRef, useState } from 'react'
import { sanitizeClipboard } from '../security'

// Shiki via the JS RegExp engine (no Oniguruma WASM → sidesteps the file:// bundling risk).
// Dual-theme output (defaultColor:false) emits per-token `--shiki-light` / `--shiki-dark` CSS
// vars; the theme is picked entirely in CSS (see mdExtRenderer.css), so this leaf needs no
// theme prop. The highlighter is a process-wide singleton, built lazily on first code block.
//
// Lang modules are loaded with explicit static `import()` calls (a fixed list) so both Vite
// AND Next can statically analyse them — a fully-dynamic `import(`…/${x}.mjs`)` would not bundle
// in Next. Each lang is loaded with Promise.allSettled so one JS-engine-incompatible grammar
// can't fail the whole highlighter.

// Deferred so the lang chunks load on first code block, not at module-eval time.
const langImports = (): Array<Promise<unknown>> => [
  import('shiki/langs/typescript.mjs'),
  import('shiki/langs/tsx.mjs'),
  import('shiki/langs/javascript.mjs'),
  import('shiki/langs/jsx.mjs'),
  import('shiki/langs/json.mjs'),
  import('shiki/langs/jsonc.mjs'),
  import('shiki/langs/bash.mjs'),
  import('shiki/langs/python.mjs'),
  import('shiki/langs/go.mjs'),
  import('shiki/langs/rust.mjs'),
  import('shiki/langs/java.mjs'),
  import('shiki/langs/c.mjs'),
  import('shiki/langs/cpp.mjs'),
  import('shiki/langs/csharp.mjs'),
  import('shiki/langs/sql.mjs'),
  import('shiki/langs/yaml.mjs'),
  import('shiki/langs/toml.mjs'),
  import('shiki/langs/html.mjs'),
  import('shiki/langs/css.mjs'),
  import('shiki/langs/markdown.mjs'),
  import('shiki/langs/diff.mjs'),
  import('shiki/langs/dockerfile.mjs'),
]

type Highlighter = {
  codeToHtml: (code: string, options: Record<string, unknown>) => string
  getLoadedLanguages: () => string[]
  loadLanguage: (lang: unknown) => Promise<void>
}

let highlighterP: Promise<Highlighter> | null = null

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterP) {
    highlighterP = (async () => {
      const { createHighlighterCore } = await import('shiki/core')
      const { createJavaScriptRegexEngine } = await import('shiki/engine/javascript')
      const hl = (await createHighlighterCore({
        themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      })) as unknown as Highlighter
      await Promise.allSettled(langImports().map((p) => hl.loadLanguage(p)))
      return hl
    })()
  }
  return highlighterP
}

export interface ShikiCodeProps {
  lang: string
  source: string
}

export function ShikiCode({ lang, source }: ShikiCodeProps) {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const codeRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    let alive = true
    getHighlighter()
      .then((hl) => {
        const useLang = hl.getLoadedLanguages().includes(lang) ? lang : 'text'
        const out = hl.codeToHtml(source, {
          lang: useLang,
          themes: { light: 'github-light', dark: 'github-dark' },
          defaultColor: false,
        })
        if (alive) setHtml(out)
      })
      .catch(() => {
        if (alive) setHtml(null) // fall back to the plain <pre> below
      })
    return () => {
      alive = false
    }
  }, [lang, source])

  // New {__html} object identity on every render forces React to rewrite innerHTML; memoize so a
  // copied-toggle re-render doesn't wipe in-file search highlights painted into the Shiki spans.
  const inner = useMemo(() => (html != null ? { __html: html } : null), [html])

  const selectFallback = () => {
    const el = codeRef.current
    if (!el) return
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  const copy = () => {
    const text = sanitizeClipboard(source)
    const ok = () => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(ok).catch(selectFallback)
    } else {
      selectFallback()
    }
  }

  return (
    <div className="mdext-code">
      <button type="button" className="mdext-copy" onClick={copy} aria-label="Copy code to clipboard">
        {copied ? 'Copied' : 'Copy'}
      </button>
      {inner ? (
        <div
          ref={(el) => {
            codeRef.current = el
          }}
          className="mdext-code-shiki"
          dangerouslySetInnerHTML={inner}
        />
      ) : (
        <pre
          ref={(el) => {
            codeRef.current = el
          }}
          className="shiki mdext-code-fallback"
        >
          <code>{source}</code>
        </pre>
      )}
    </div>
  )
}
