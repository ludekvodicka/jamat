import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  FileDiffData,
  FileDiffLineKind,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { FileHighlighter } from '../../../mdext-renderer/renderer'

export interface FileDiffVisualLine {
  key: string
  kind: FileDiffLineKind
  text: string
  beforeLine: number | null
  afterLine: number | null
  header: string | null
}

export function FileDiffView(props: {
  data: FileDiffData
  currentText: string | null
  language: string
}): React.JSX.Element {
  const [full, setFull] = useState(false)
  /**
   * The rows AND what they were highlighted from, together.
   *
   * Held apart, the highlighting was indexed by line POSITION: the render in which `lines` changes
   * drew the new rows with the previous rows' HTML, row by row. Switching a diff to "Full file"
   * drew the first forty lines of the file with the changed rows' text under the new line numbers.
   */
  const [highlighted, setHighlighted] =
    useState<{ for: readonly FileDiffVisualLine[]; html: readonly string[] } | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const fullAvailable = props.data.completeness === 'full'
    && props.currentText !== null
    && FileDiffVisual.matchesCurrent(props.data, props.currentText)
  const showFull = full && fullAvailable
  const lines = useMemo(
    () => showFull && props.currentText !== null
      ? FileDiffVisual.full(props.data, props.currentText)
      : FileDiffVisual.changes(props.data),
    [props.currentText, props.data, showFull],
  )

  useEffect(() => {
    let alive = true
    setHighlighted(null)
    void FileHighlighter.lines(lines.map((line) => line.text).join('\n'), props.language)
      .then((value) => { if (alive) setHighlighted({ for: lines, html: value }) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [lines, props.language])
  const html = FileDiffHighlighting.forLines(highlighted, lines)

  return (
    <div className="file-diff">
      <div className="file-diff-toolbar">
        <span>{props.data.baseline.label} → {props.data.current.label}</span>
        <button type="button" aria-pressed={!full} onClick={() => setFull(false)}>Changes</button>
        <button
          type="button"
          aria-pressed={showFull}
          disabled={!fullAvailable}
          title={FileDiffVisual.fullUnavailableDetail(props.data, props.currentText)}
          onClick={() => setFull(true)}
        >
          Full file
        </button>
      </div>
      {(props.data.detail || props.data.completeness !== 'full') && (
        <p className="file-diff-detail">
          {props.data.detail ?? 'The selected chat baseline covers only the recorded region.'}
        </p>
      )}
      {props.data.completeness === 'full' && props.currentText !== null && !fullAvailable && (
        <p className="file-diff-detail">The current file no longer matches this diff. Refresh it.</p>
      )}
      {lines.length === 0
        ? <p className="file-viewer-note">No text changes.</p>
        : (
          <div className="file-diff-area">
            <div className="file-diff-scroll" ref={scroller}>
              <pre className="file-diff-lines">
                {lines.map((line, index) => (
                  <span
                    key={line.key}
                    className={`file-diff-line file-diff-line--${line.kind}`}
                    data-file-line={line.afterLine ?? undefined}
                  >
                    {line.header && <span className="file-diff-hunk">{line.header}</span>}
                    <span className="file-diff-gutter">{line.beforeLine ?? ''}</span>
                    <span className="file-diff-gutter">{line.afterLine ?? ''}</span>
                    <span className="file-diff-marker">
                      {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
                    </span>
                    <span
                      className="file-diff-text"
                      dangerouslySetInnerHTML={{ __html: html?.[index] || FileDiffVisual.escape(line.text) || ' ' }}
                    />
                    {'\n'}
                  </span>
                ))}
              </pre>
            </div>
            <FileDiffMinimap lines={lines} scroller={scroller} />
          </div>
        )}
    </div>
  )
}

function FileDiffMinimap(props: {
  lines: readonly FileDiffVisualLine[]
  scroller: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const viewport = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const draw = (): void => {
      const context = element.getContext('2d')
      if (!context || element.clientWidth === 0 || element.clientHeight === 0) return
      const ratio = window.devicePixelRatio || 1
      element.width = Math.floor(element.clientWidth * ratio)
      element.height = Math.floor(element.clientHeight * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, element.clientWidth, element.clientHeight)
      const styles = getComputedStyle(document.documentElement)
      const add = styles.getPropertyValue('--color-ok').trim()
      const remove = styles.getPropertyValue('--color-danger').trim()
      const height = element.clientHeight / Math.max(1, props.lines.length)
      props.lines.forEach((line, index) => {
        if (line.kind === 'context') return
        context.fillStyle = line.kind === 'add' ? add : remove
        context.fillRect(0, index * height, element.clientWidth, Math.max(1, height))
      })
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(element)
    return () => observer.disconnect()
  }, [props.lines])

  useEffect(() => {
    const scroller = props.scroller.current
    const marker = viewport.current
    if (!scroller || !marker) return
    const update = (): void => {
      const total = Math.max(1, scroller.scrollHeight)
      marker.style.top = `${scroller.scrollTop / total * 100}%`
      marker.style.height = `${Math.min(100, scroller.clientHeight / total * 100)}%`
    }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', update)
      observer.disconnect()
    }
    // `props.lines` and not only the element: content changes `scrollHeight`, not the box, so the
    // observer never fires for it. Keyed on the element alone, the rectangle kept the size it had
    // for a forty-line diff while a two-thousand-line file scrolled behind it.
  }, [props.lines, props.scroller])

  return (
    <div
      className="file-diff-minimap"
      onMouseDown={(event) => {
        const scroller = props.scroller.current
        if (!scroller) return
        const bounds = event.currentTarget.getBoundingClientRect()
        const position = (event.clientY - bounds.top) / bounds.height
        scroller.scrollTop = Math.max(0, position * scroller.scrollHeight - scroller.clientHeight / 2)
      }}
    >
      <canvas ref={canvas} />
      <div ref={viewport} />
    </div>
  )
}

/**
 * Which highlighting belongs to which rows.
 *
 * A class rather than a line in the component, because the frame it protects is one React flushes
 * past: the click that changes the rows renders ONCE with the new rows and the old HTML before the
 * effect clears it, and that frame drew the first lines of a file with the changed rows' text under
 * the new line numbers.
 */
export class FileDiffHighlighting {
  static forLines(
    held: { for: readonly FileDiffVisualLine[]; html: readonly string[] } | null,
    lines: readonly FileDiffVisualLine[],
  ): readonly string[] | null {
    return held !== null && held.for === lines ? held.html : null
  }
}

export class FileDiffVisual {
  static changes(data: FileDiffData): readonly FileDiffVisualLine[] {
    const lines: FileDiffVisualLine[] = []
    data.hunks.forEach((hunk, hunkIndex) => {
      const header = `@@ -${hunk.beforeStart},${hunk.beforeLines} +${hunk.afterStart},${hunk.afterLines} @@`
      hunk.lines.forEach((line, lineIndex) => lines.push({
        ...line,
        key: `${hunkIndex}:${lineIndex}`,
        header: lineIndex === 0 ? header : null,
      }))
    })
    return lines
  }

  static full(data: FileDiffData, currentText: string): readonly FileDiffVisualLine[] {
    if (data.completeness !== 'full')
      throw new Error('A region diff cannot be projected as a full file')
    if (!FileDiffVisual.matchesCurrent(data, currentText))
      throw new Error('The current file no longer matches the diff hunks')
    const current = FileDiffVisual.textLines(currentText)
    const at = new Map<number, FileDiffVisualLine[]>()
    for (const [hunkIndex, hunk] of data.hunks.entries()) {
      let afterCursor = hunk.afterStart
      for (const [lineIndex, line] of hunk.lines.entries()) {
        const position = line.afterLine ?? afterCursor
        const values = at.get(position) ?? []
        values.push({
          ...line,
          key: `${hunkIndex}:${lineIndex}`,
          header: lineIndex === 0
            ? `@@ -${hunk.beforeStart},${hunk.beforeLines} +${hunk.afterStart},${hunk.afterLines} @@`
            : null,
        })
        at.set(position, values)
        if (line.afterLine !== null) afterCursor = line.afterLine + 1
      }
    }
    const result: FileDiffVisualLine[] = []
    for (let lineNumber = 1; lineNumber <= current.length; lineNumber++) {
      const changed = at.get(lineNumber) ?? []
      const removals = changed.filter((line) => line.kind === 'remove')
      result.push(...removals)
      const currentChange = changed.find((line) => line.afterLine === lineNumber)
      result.push(currentChange ?? {
        key: `full:${lineNumber}`,
        kind: 'context',
        text: current[lineNumber - 1],
        beforeLine: null,
        afterLine: lineNumber,
        header: null,
      })
    }
    result.push(...(at.get(current.length + 1) ?? []).filter((line) => line.kind === 'remove'))
    return result
  }

  static matchesCurrent(data: FileDiffData, currentText: string): boolean {
    const current = FileDiffVisual.textLines(currentText)
    for (const hunk of data.hunks)
      for (const line of hunk.lines)
        if (line.afterLine !== null && current[line.afterLine - 1] !== line.text) return false
    return true
  }

  static fullUnavailableDetail(data: FileDiffData, currentText: string | null): string | undefined {
    if (data.completeness !== 'full') return 'Full file is unavailable for a partial chat diff'
    if (currentText === null) return 'Current text is unavailable'
    if (!FileDiffVisual.matchesCurrent(data, currentText)) return 'Refresh the stale diff first'
    return undefined
  }

  static escape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  private static textLines(value: string): string[] {
    const lines = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    if (value.endsWith('\n')) lines.pop()
    return lines
  }
}
