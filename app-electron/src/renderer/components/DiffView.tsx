import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { diffLines } from 'diff'
import { highlightToLines, highlightToLinesSync } from '../utils/shiki'

interface DiffViewProps {
  beforeText: string
  afterText: string
  /** Tag rendered above the diff body, e.g. "new file" / "overwritten". */
  label?: string | null
  /** Auto-collapse threshold — diffs longer than this render truncated with a "show full" toggle. */
  maxLines?: number
  /**
   * Best-effort 1-based line number where the diff region begins in the real
   * file. When a number, the gutter anchors numbering here; when `null`/
   * omitted, the gutter shows relative (1-based) numbering.
   *
   * Only the after-side column is disk-anchored — the anchor is found by
   * locating `afterText` on disk. Before-side numbers are interpolated within
   * the hunk from the same anchor and are approximate once add/delete counts
   * diverge.
   */
  startLine?: number | null
  /**
   * Shiki language id (e.g. `'typescript'`). When set and loaded, context/add/
   * del lines render with syntax highlighting overlaid by the green/red diff
   * backgrounds. When `undefined`, falls back to plain monospace — preserves
   * the SessionChangesPanel rendering.
   */
  highlightLang?: string | null
  /**
   * When true, the diff renders inside its own scrolling area with a VS-Code-
   * style **minimap** on the right showing the full file change distribution
   * + a draggable viewport indicator. The component then expects its parent
   * to give it a constrained height (flex/abs/percent), since it sizes to
   * fill that height instead of growing to content. When false (default), the
   * original content-sized rendering is used — keeps SessionChangesPanel
   * untouched.
   */
  showMinimap?: boolean
}

interface DiffSegment {
  kind: 'add' | 'del' | 'ctx'
  text: string
  beforeNo: number | null
  afterNo: number | null
  /** Pre-highlighted HTML for the line, or null when no language is set / available. */
  html: string | null
}

const DEFAULT_MAX_LINES = 200

/**
 * Unified line-diff renderer styled after VS Code Source Control. Pure
 * presentation — no fetching, no IPC. Driven entirely by `beforeText` /
 * `afterText`. Empty `beforeText` renders as all-added (new file / overwritten
 * write); identical inputs render "no changes".
 *
 * A two-column gutter shows before/after line numbers. With `startLine` the
 * numbers are real file lines (best-effort); without it they are relative.
 *
 * Pass `highlightLang` to overlay Shiki syntax colors on top of the green/red
 * diff backgrounds — used by FileViewer's full-file diff mode.
 */
export function DiffView({
  beforeText,
  afterText,
  label,
  maxLines = DEFAULT_MAX_LINES,
  startLine,
  highlightLang,
  showMinimap,
}: DiffViewProps) {
  // Highlight via Shiki. The synchronous fast-path (highlightToLinesSync) covers
  // every view after the first in a session — the highlighter is warm, so colors
  // are ready in-render with no flash. Only the very first use is cold: sync
  // returns null, we render plain, and the async effect warms the highlighter and
  // stashes the result so the next render colors it.
  const [asyncHl, setAsyncHl] = useState<{ before: string[] | null; after: string[] | null }>({ before: null, after: null })

  const hl = useMemo(() => {
    if (!highlightLang) return { before: null, after: null }
    const before = highlightToLinesSync(beforeText, highlightLang)
    const after = highlightToLinesSync(afterText, highlightLang)
    if (before !== null || after !== null) return { before, after }
    return asyncHl
  }, [beforeText, afterText, highlightLang, asyncHl])

  useEffect(() => {
    if (!highlightLang) return
    // Warm path is already handled synchronously by the memo above.
    if (highlightToLinesSync(beforeText, highlightLang) !== null) return
    let alive = true
    Promise.all([highlightToLines(beforeText, highlightLang), highlightToLines(afterText, highlightLang)])
      .then(([before, after]) => {
        if (alive) setAsyncHl({ before, after })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [beforeText, afterText, highlightLang])

  const segments = useMemo<DiffSegment[]>(() => {
    const beforeLines = hl.before
    const afterLines = hl.after

    const raw: { kind: DiffSegment['kind']; text: string; html: string | null }[] = []
    if (beforeText === afterText) {
      // no segments
    } else if (beforeText === '') {
      // Strip a single trailing newline so a `\n`-terminated file (the common
      // Write case) does not render a phantom blank last line that would
      // throw off the gutter line count.
      const body = afterText.endsWith('\n') ? afterText.slice(0, -1) : afterText
      const lines = body.split('\n')
      for (let i = 0; i < lines.length; i++) {
        raw.push({ kind: 'add', text: lines[i], html: afterLines?.[i] ?? null })
      }
    } else {
      // Walk diff parts, tracking after-side and before-side line indices so
      // we can attach the pre-highlighted HTML to each segment.
      let afterIdx = 0
      let beforeIdx = 0
      const parts = diffLines(beforeText, afterText)
      for (const part of parts) {
        const value = part.value.endsWith('\n') ? part.value.slice(0, -1) : part.value
        const lines = value.split('\n')
        for (const line of lines) {
          if (part.added) {
            raw.push({ kind: 'add', text: line, html: afterLines?.[afterIdx] ?? null })
            afterIdx++
          } else if (part.removed) {
            raw.push({ kind: 'del', text: line, html: beforeLines?.[beforeIdx] ?? null })
            beforeIdx++
          } else {
            raw.push({ kind: 'ctx', text: line, html: afterLines?.[afterIdx] ?? null })
            afterIdx++
            beforeIdx++
          }
        }
      }
    }
    // Assign line numbers. Context advances both counters, additions only the
    // after-side, deletions only the before-side — a standard unified hunk.
    const base = typeof startLine === 'number' && startLine > 0 ? startLine : 1
    let bn = base
    let an = base
    return raw.map(({ kind, text, html }) => {
      if (kind === 'ctx') return { kind, text, html, beforeNo: bn++, afterNo: an++ }
      if (kind === 'add') return { kind, text, html, beforeNo: null, afterNo: an++ }
      return { kind, text, html, beforeNo: bn++, afterNo: null }
    })
  }, [beforeText, afterText, startLine, hl])

  const [expanded, setExpanded] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const tooLong = segments.length > maxLines
  const visible = tooLong && !expanded ? segments.slice(0, Math.floor(maxLines / 2)) : segments
  const hiddenCount = segments.length - visible.length

  if (segments.length === 0) {
    return (
      <div className="diff-view diff-empty">
        {label ? <span className="diff-label">[{label}]</span> : null}
        <span className="diff-empty-text">no changes</span>
      </div>
    )
  }

  const renderedLines = (
    <>
      {visible.map((seg, i) => (
        <span key={i} className={`diff-line diff-line-${seg.kind}`}>
          <span className="diff-gutter diff-gutter-before">{seg.beforeNo ?? ''}</span>
          <span className="diff-gutter">{seg.afterNo ?? ''}</span>
          <span className="diff-marker">{seg.kind === 'add' ? '+' : seg.kind === 'del' ? '-' : ' '}</span>
          {seg.html !== null ? (
            <span className="diff-text" dangerouslySetInnerHTML={{ __html: seg.html || ' ' }} />
          ) : (
            <span className="diff-text">{seg.text || ' '}</span>
          )}
          {'\n'}
        </span>
      ))}
    </>
  )

  const showFullBtn = tooLong && !expanded ? (
    <button className="diff-show-full" onClick={() => setExpanded(true)} type="button">
      Show full diff ({hiddenCount} more lines)
    </button>
  ) : null

  if (showMinimap) {
    return (
      <div className="diff-view diff-view-with-minimap">
        {label ? <div className="diff-label">[{label}]</div> : null}
        <div className="diff-view-body-area">
          <div className="diff-body-scroll" ref={scrollerRef}>
            <pre className="diff-body">{renderedLines}</pre>
          </div>
          <DiffMinimap segments={visible} scrollerRef={scrollerRef} />
        </div>
        {showFullBtn}
      </div>
    )
  }

  return (
    <div className="diff-view">
      {label ? <div className="diff-label">[{label}]</div> : null}
      <pre className="diff-body">{renderedLines}</pre>
      {showFullBtn}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Minimap — VS-Code-style scroll overview
// ────────────────────────────────────────────────────────────────────────────

interface DiffMinimapProps {
  segments: DiffSegment[]
  scrollerRef: React.RefObject<HTMLDivElement | null>
}

function DiffMinimap({ segments, scrollerRef }: DiffMinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<{ topPct: number; heightPct: number }>({ topPct: 0, heightPct: 100 })
  const [dragging, setDragging] = useState(false)

  // Render colored rows onto the canvas. Re-runs when segments or container
  // size changes. Sub-pixel rows are bumped to 1px so they remain visible on
  // tall files.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const draw = () => {
      const cssW = canvas.clientWidth
      const cssH = canvas.clientHeight
      if (cssW === 0 || cssH === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(cssW * dpr)
      canvas.height = Math.floor(cssH * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)
      if (segments.length === 0) return
      const rowH = cssH / segments.length
      const drawH = Math.max(rowH, 1.5)
      for (let i = 0; i < segments.length; i++) {
        const kind = segments[i].kind
        if (kind === 'ctx') continue
        ctx.fillStyle = kind === 'add' ? 'rgba(78, 201, 78, 0.85)' : 'rgba(244, 71, 71, 0.85)'
        ctx.fillRect(0, i * rowH, cssW, drawH)
      }
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [segments])

  // Track the scroller's visible region as a viewport rectangle on the
  // minimap. Percent-based so the indicator scales with container height.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const update = () => {
      const total = scroller.scrollHeight
      if (total <= 0) return
      const topPct = (scroller.scrollTop / total) * 100
      const heightPct = Math.min(100, (scroller.clientHeight / total) * 100)
      setViewport({ topPct, heightPct })
    }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [scrollerRef])

  const scrollFromY = useCallback((clientY: number) => {
    const wrap = wrapRef.current
    const scroller = scrollerRef.current
    if (!wrap || !scroller) return
    const rect = wrap.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    // Center the viewport on the click point — feels more natural than
    // anchoring its top to the cursor.
    const visibleRatio = scroller.clientHeight / scroller.scrollHeight
    const target = (ratio - visibleRatio / 2) * scroller.scrollHeight
    scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, target))
  }, [scrollerRef])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => scrollFromY(e.clientY)
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, scrollFromY])

  return (
    <div
      ref={wrapRef}
      className="diff-minimap"
      onMouseDown={(e) => {
        scrollFromY(e.clientY)
        setDragging(true)
        e.preventDefault()
      }}
    >
      <canvas ref={canvasRef} className="diff-minimap-canvas" />
      <div
        className="diff-minimap-viewport"
        style={{ top: `${viewport.topPct}%`, height: `${viewport.heightPct}%` }}
      />
    </div>
  )
}
