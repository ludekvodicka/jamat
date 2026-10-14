import { useEffect, useRef, useState } from 'react'

import { FileViewerSearchRanges } from './fileViewerSearchRanges'

export function useFileViewerSearch(body: React.RefObject<HTMLDivElement | null>, prepare: () => void) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Range[]>([])
  const [active, setActive] = useState(0)
  const [limited, setLimited] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const show = (): void => {
    prepare()
    setOpen(true)
    input.current?.focus()
    input.current?.select()
  }
  const close = (): void => {
    setOpen(false)
    body.current?.closest<HTMLElement>('.file-viewer')?.focus({ preventScroll: true })
  }
  const move = (direction: -1 | 1): void => {
    if (matches.length === 1 && body.current !== null)
      FileViewerSearchRanges.reveal(body.current, matches[0])
    else if (matches.length > 0)
      setActive((current) => (current + direction + matches.length) % matches.length)
  }

  useEffect(() => {
    if (!open) return
    input.current?.focus()
    input.current?.select()
  }, [open])

  useEffect(() => {
    const root = body.current
    if (!open || query === '' || root === null) {
      setMatches([])
      setActive(0)
      setLimited(false)
      return
    }
    const update = (): void => {
      const found = FileViewerSearchRanges.find(root, query)
      setLimited(found.length > FileViewerSearchRanges.limitConst)
      setMatches(found.slice(0, FileViewerSearchRanges.limitConst))
      setActive(0)
    }
    update()
    // Highlighting, diagrams, diff mode and refreshed content can replace text after it first draws.
    const observer = new MutationObserver(update)
    observer.observe(root, { subtree: true, childList: true, characterData: true })
    return () => observer.disconnect()
  }, [body, open, query])

  useEffect(() => {
    if (matches.length === 0) return
    const highlight = CSS.highlights.get('file-viewer-search') ?? new Highlight()
    CSS.highlights.set('file-viewer-search', highlight)
    for (const range of matches) highlight.add(range)
    return () => {
      for (const range of matches) highlight.delete(range)
      if (highlight.size === 0) CSS.highlights.delete('file-viewer-search')
    }
  }, [matches])

  useEffect(() => {
    const range = matches[active]
    const root = body.current
    if (!range || root === null) return
    const highlight = CSS.highlights.get('file-viewer-search-active') ?? new Highlight()
    highlight.priority = 1
    CSS.highlights.set('file-viewer-search-active', highlight)
    highlight.add(range)
    FileViewerSearchRanges.reveal(root, range)
    return () => {
      highlight.delete(range)
      if (highlight.size === 0) CSS.highlights.delete('file-viewer-search-active')
    }
  }, [active, body, matches])

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey) return
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      event.stopPropagation()
      show()
    } else if (open && event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  return { open, query, setQuery, input, show, close, move, onKeyDown, active, count: matches.length, limited }
}

export function FileViewerSearchBar(props: {
  search: ReturnType<typeof useFileViewerSearch>
}): React.JSX.Element | null {
  const search = props.search
  if (!search.open) return null
  return (
    <div className="file-viewer-search" role="search" aria-label="Find in file">
      <input
        ref={search.input}
        type="text"
        aria-label="Find in file"
        placeholder="Find in file"
        value={search.query}
        spellCheck={false}
        onChange={(event) => search.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
          if (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            event.stopPropagation()
            search.move(event.key === 'ArrowUp' || (event.key === 'Enter' && event.shiftKey) ? -1 : 1)
          }
        }}
      />
      <span className="file-viewer-search-count" role="status" aria-live="polite"
        title={search.limited ? 'Showing the first 10,000 matches. Refine the search to see fewer results.' : undefined}>
        {search.query === '' ? '' : search.count === 0 ? 'No matches'
          : `${search.active + 1} / ${search.count}${search.limited ? '+' : ''}`}
      </span>
      <button type="button" aria-label="Previous match" title="Previous match (Shift+Enter / ↑)"
        disabled={search.count === 0} onClick={() => search.move(-1)}>↑</button>
      <button type="button" aria-label="Next match" title="Next match (Enter / ↓)"
        disabled={search.count === 0} onClick={() => search.move(1)}>↓</button>
      <button type="button" aria-label="Close search" title="Close search (Escape)"
        onClick={search.close}>×</button>
    </div>
  )
}
