import { useEffect, useMemo, useState } from 'react'

import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import { MdExtSecurity } from '../mdExtSecurity'
import { MdExtDiagramEngine } from './mdExtDiagramEngine'

export function MdExtDiagram(props: {
  language: string
  source: string
  /** False past the document's budget: the fence offers its source rather than being drawn. */
  allowed: boolean
}): React.JSX.Element | null {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)

  useEffect(() => {
    let alive = true
    setError(null)
    if (!props.source.trim()) {
      setSvg('')
      return () => { alive = false }
    }
    if (props.source.length > MdExtDiagramEngine.maxSourceCharacters) {
      setSvg(null)
      setError('Diagram source is too large')
      return () => { alive = false }
    }
    if (!props.allowed) {
      setSvg(null)
      setError('This document draws its first diagrams only; here is the source')
      return () => { alive = false }
    }
    setSvg(null)
    // Told, not merely stopped listening to: a mermaid render waits in one queue shared by the whole
    // window, and a diagram whose panel is gone used to take its turn there anyway.
    const wanted = new AbortController()
    void MdExtDiagramEngine.render(props.language, props.source, wanted.signal)
      .then((value) => { if (alive) setSvg(MdExtSecurity.svg(value)) })
      .catch((reason: unknown) => {
        if (alive) setError(ErrorText.of(reason))
      })
    return () => {
      alive = false
      wanted.abort()
    }
  }, [props.allowed, props.language, props.source])

  const inner = useMemo(() => svg ? { __html: svg } : null, [svg])
  if (error || showSource)
    return (
      <div className="mdext-diagram-error" role="note">
        <div className="mdext-diagram-error-head">
          <span>{error ? `${props.language}: ${error}` : `${props.language} source`}</span>
          <button type="button" onClick={() => setShowSource((value) => !value)}>
            {showSource && !error ? 'Hide source' : 'Show source'}
          </button>
        </div>
        <pre><code>{props.source}</code></pre>
      </div>
    )
  if (svg === '') return null
  if (inner === null)
    return <div className="mdext-diagram mdext-diagram-loading" role="status">Rendering diagram...</div>
  return (
    <div className="mdext-diagram-wrap">
      <div
        className={`mdext-diagram mdext-diagram-${props.language}`}
        role="img"
        aria-label={`${props.language} diagram`}
        dangerouslySetInnerHTML={inner}
      />
      <button type="button" className="mdext-diagram-source-button" onClick={() => setShowSource(true)}>
        Show source
      </button>
    </div>
  )
}
