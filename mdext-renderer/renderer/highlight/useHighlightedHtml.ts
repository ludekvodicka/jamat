import { useEffect, useState } from 'react'

import { FileHighlighter } from './fileHighlighter'

/**
 * One source, highlighted, or null while there is nothing to draw yet and null again where the
 * highlighter refused - a language it has no grammar for, or more source than the drawing thread can
 * afford. Both callers draw plain text for null, which is what makes one answer enough.
 *
 * It was written twice, in the file panel's code view and in the markdown fence, with the same state
 * and the same effect shape - and the two had already drifted: one cleared its HTML when the source
 * changed and the other left the previous block's markup under the new text.
 */
export function useHighlightedHtml(
  source: string,
  language: string,
  /** False leaves the fence plain without asking: past a document's budget, or a mode that is not it. */
  enabled = true,
): string | null {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    // Cleared first, always. Kept, the previous source's markup stayed on screen under the new text
    // for as long as the highlighter took, and Copy carried a third thing.
    setHtml(null)
    if (!enabled) return
    let alive = true
    void FileHighlighter.html(source, language)
      .then((value) => { if (alive) setHtml(value) })
      .catch(() => { if (alive) setHtml(null) })
    return () => { alive = false }
  }, [enabled, language, source])

  return html
}
