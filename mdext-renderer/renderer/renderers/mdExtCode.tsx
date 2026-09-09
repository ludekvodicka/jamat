import { useEffect, useMemo, useRef, useState } from 'react'

import { useHighlightedHtml } from '../highlight/useHighlightedHtml'
import { MdExtSecurity } from '../mdExtSecurity'

export function MdExtCode(props: {
  language: string
  source: string
  /** False past the document's budget: the fence draws as plain text, which is also the fallback. */
  highlight: boolean
}): React.JSX.Element {
  const html = useHighlightedHtml(props.source, props.language, props.highlight)
  const [copied, setCopied] = useState(false)
  const code = useRef<HTMLElement | null>(null)
  /** Held so the cleanup can clear it: a fence copied and then scrolled away wrote into a gone tree. */
  const copiedTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
  }, [])

  const inner = useMemo(() => html === null ? null : { __html: html }, [html])

  const select = (): void => {
    if (!code.current) return
    const range = document.createRange()
    range.selectNodeContents(code.current)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  const copy = (): void => {
    if (!navigator.clipboard?.writeText) {
      select()
      return
    }
    void navigator.clipboard.writeText(MdExtSecurity.clipboard(props.source))
      .then(() => {
        setCopied(true)
        if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
        copiedTimer.current = window.setTimeout(() => {
          copiedTimer.current = null
          setCopied(false)
        }, 1_200)
      })
      .catch(select)
  }

  return (
    <div className="mdext-code">
      <button type="button" className="mdext-copy" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      {inner === null
        ? <pre ref={(element) => { code.current = element }} className="mdext-code-fallback"><code>{props.source}</code></pre>
        : <div ref={(element) => { code.current = element }} className="mdext-code-shiki" dangerouslySetInnerHTML={inner} />}
    </div>
  )
}
