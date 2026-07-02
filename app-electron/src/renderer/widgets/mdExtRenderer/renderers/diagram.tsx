import { useEffect, useMemo, useState } from 'react'
import { useMdExtTheme, resolveTheme } from '../theme'
import { sanitizeSvg } from '../security'
import { renderDiagram, MAX_DIAGRAM_SRC } from './renderDiagram'

// Inline diagram leaf (v1b). react-markdown renders synchronously, so each diagram owns its async
// engine load + render: a reserved-height loading placeholder (never a blank box / layout jump), an
// in-pane readable error with a show-source toggle, a quiet empty for whitespace-only sources, an
// input-size cap, and DOMPurify-sanitized SVG before injection. Theme-reactive (re-renders when the
// host toggles light/dark). role/aria for a11y.

export function Diagram({ kind, source }: { kind: string; source: string }) {
  const theme = useMdExtTheme()
  const resolved = resolveTheme(theme)
  const [svg, setSvg] = useState<string | null>(null) // null = loading, '' = quiet empty, else SVG
  const [err, setErr] = useState<string | null>(null)
  const [showSrc, setShowSrc] = useState(false)

  useEffect(() => {
    let alive = true
    setErr(null)
    const trimmed = source.trim()
    if (!trimmed) {
      setSvg('') // quiet empty
      return
    }
    if (source.length > MAX_DIAGRAM_SRC) {
      setSvg(null)
      setErr('diagram source too large')
      return
    }
    setSvg(null) // loading
    renderDiagram(kind, source, resolved)
      .then((raw) => {
        if (alive) setSvg(sanitizeSvg(raw))
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [kind, source, resolved])

  // Memoized so a showSrc toggle re-render doesn't rewrite the SVG innerHTML (which would invalidate
  // any in-file search ranges painted over it).
  const inner = useMemo(() => (svg ? { __html: svg } : null), [svg])

  if (err || showSrc) {
    return (
      <div className="mdext-diagram-error" role="note">
        <div className="mdext-diagram-error-head">
          <span className="mdext-diagram-error-msg">{err ? `${kind} diagram error: ${err}` : `${kind} source`}</span>
          <button type="button" className="mdext-diagram-toggle" onClick={() => setShowSrc((s) => !s)}>
            {showSrc && !err ? 'Hide source' : 'Show source'}
          </button>
        </div>
        <pre className="mdext-diagram-source">
          <code>{source}</code>
        </pre>
      </div>
    )
  }

  if (svg === '') return null // whitespace-only → render nothing
  if (inner === null) {
    return <div className="mdext-diagram mdext-loading" role="status" aria-label="Rendering diagram" />
  }

  return (
    <div className="mdext-diagram-wrap">
      <div className={`mdext-diagram mdext-diagram-${kind}`} role="img" aria-label={`${kind} diagram`} dangerouslySetInnerHTML={inner} />
      <button type="button" className="mdext-diagram-toggle mdext-diagram-toggle-float" onClick={() => setShowSrc(true)}>
        Show source
      </button>
    </div>
  )
}
