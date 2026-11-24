import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  FileDiffData,
  FileDiffLineKind,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { FileHighlighter } from '../../../mdext-renderer/renderer'
import { FilePropertyChanges } from './filePropertyChanges'

export type FileDiffLayout = 'unified' | 'split'
export type FileDiffMinimapMark = 'context' | 'add' | 'remove' | 'change'

export interface FileDiffVisualLine {
  key: string
  kind: FileDiffLineKind
  text: string
  beforeLine: number | null
  afterLine: number | null
  header: string | null
}

export interface FileDiffSplitCell {
  line: FileDiffVisualLine
  index: number
}

export interface FileDiffSplitRow {
  key: string
  header: string | null
  left: FileDiffSplitCell | null
  right: FileDiffSplitCell | null
}

export function FileDiffView(props: {
  data: FileDiffData
  currentText: string | null
  language: string
  wrapLines?: boolean
}): React.JSX.Element {
  const [full, setFull] = useState(false)
  const [layout, setLayout] = useState<FileDiffLayout>(() => FileDiffLayoutPreference.read())
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
  const leftScroller = useRef<HTMLDivElement | null>(null)
  const wrapLines = props.wrapLines === true
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
  const splitRows = useMemo(
    () => layout === 'split' ? FileDiffVisual.split(lines) : [],
    [layout, lines],
  )
  const minimapMarks = useMemo(
    () => FileDiffVisual.minimapMarks(layout, lines, splitRows),
    [layout, lines, splitRows],
  )

  const changeLayout = (next: FileDiffLayout): void => {
    setLayout(next)
    FileDiffLayoutPreference.write(next)
  }

  useEffect(() => {
    let alive = true
    setHighlighted(null)
    void FileHighlighter.lines(lines.map((line) => line.text).join('\n'), props.language)
      .then((value) => { if (alive) setHighlighted({ for: lines, html: value }) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [lines, props.language])

  useEffect(() => {
    if (layout !== 'split' || wrapLines) return
    const left = leftScroller.current
    const right = scroller.current
    if (!left || !right) return
    // Recording the clamped read-back position suppresses the echo scroll event on the sibling pane
    // without snapping the driving pane back when the two sides differ in scrollable width.
    const seen = {
      leftTop: left.scrollTop,
      leftLeft: left.scrollLeft,
      rightTop: right.scrollTop,
      rightLeft: right.scrollLeft,
    }
    const onLeftScroll = (): void => {
      if (left.scrollTop !== seen.leftTop) {
        seen.leftTop = left.scrollTop
        right.scrollTop = left.scrollTop
        seen.rightTop = right.scrollTop
      }
      if (left.scrollLeft !== seen.leftLeft) {
        seen.leftLeft = left.scrollLeft
        right.scrollLeft = left.scrollLeft
        seen.rightLeft = right.scrollLeft
      }
    }
    const onRightScroll = (): void => {
      if (right.scrollTop !== seen.rightTop) {
        seen.rightTop = right.scrollTop
        left.scrollTop = right.scrollTop
        seen.leftTop = left.scrollTop
      }
      if (right.scrollLeft !== seen.rightLeft) {
        seen.rightLeft = right.scrollLeft
        left.scrollLeft = right.scrollLeft
        seen.leftLeft = left.scrollLeft
      }
    }
    left.addEventListener('scroll', onLeftScroll, { passive: true })
    right.addEventListener('scroll', onRightScroll, { passive: true })
    return () => {
      left.removeEventListener('scroll', onLeftScroll)
      right.removeEventListener('scroll', onRightScroll)
    }
  }, [layout, wrapLines, lines.length])

  const html = FileDiffHighlighting.forLines(highlighted, lines)
  const scrollerKey = `${layout}:${wrapLines ? 'wrap' : 'nowrap'}`

  return (
    <div className="file-diff">
      <div className="file-diff-toolbar">
        <span className="file-diff-toolbar-label">{props.data.baseline.label} → {props.data.current.label}</span>
        <div className="file-diff-toolbar-group" role="group" aria-label="Diff layout">
          <button type="button" aria-pressed={layout === 'unified'} onClick={() => changeLayout('unified')}>
            Unified
          </button>
          <button type="button" aria-pressed={layout === 'split'} onClick={() => changeLayout('split')}>
            Side by side
          </button>
        </div>
        <div className="file-diff-toolbar-group" role="group" aria-label="Diff scope">
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
      </div>
      {(props.data.detail || props.data.completeness !== 'full') && (
        <p className="file-diff-detail">
          {props.data.detail ?? 'The selected chat baseline covers only the recorded region.'}
        </p>
      )}
      {props.data.completeness === 'full' && props.currentText !== null && !fullAvailable && (
        <p className="file-diff-detail">The current file no longer matches this diff. Refresh it.</p>
      )}
      {props.data.properties && <FilePropertyChanges properties={props.data.properties} />}
      {lines.length === 0
        ? <p className="file-viewer-note">No text changes.</p>
        : (
          <div className="file-diff-area">
            {layout === 'unified'
              ? (
                <div className="file-diff-scroll" ref={scroller} tabIndex={-1}>
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
                        <span className="file-diff-marker">{FileDiffVisual.markerOf(line.kind)}</span>
                        <span
                          className="file-diff-text"
                          dangerouslySetInnerHTML={{ __html: html?.[index] || FileDiffVisual.escape(line.text) || ' ' }}
                        />
                        {'\n'}
                      </span>
                    ))}
                  </pre>
                </div>
              )
              : layout === 'split'
                ? (
                  <FileDiffSplitContent
                    data={props.data}
                    rows={splitRows}
                    html={html}
                    wrapLines={wrapLines}
                    leftScroller={leftScroller}
                    rightScroller={scroller}
                  />
                )
                : (() => { throw new Error(`Unknown diff layout: ${JSON.stringify(layout)}`) })()}
            <FileDiffMinimap marks={minimapMarks} scroller={scroller} scrollerKey={scrollerKey} />
          </div>
        )}
    </div>
  )
}

function FileDiffSplitContent(props: {
  data: FileDiffData
  rows: readonly FileDiffSplitRow[]
  html: readonly string[] | null
  wrapLines: boolean
  leftScroller: React.RefObject<HTMLDivElement | null>
  rightScroller: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  return (
    <div className="file-diff-split-main">
      <div className="file-diff-split-headers">
        <div className="file-diff-split-header" title={props.data.baseline.path}>
          {props.data.baseline.label}
        </div>
        <div className="file-diff-split-header" title={props.data.current.path}>
          {props.data.current.label}
        </div>
      </div>
      {props.wrapLines
        ? (
          <div className="file-diff-scroll file-diff-split-scroll" ref={props.rightScroller} tabIndex={-1}>
            <div className="file-diff-split-grid">
              {props.rows.map((row) => (
                <FileDiffSplitGridRow key={row.key} row={row} html={props.html} />
              ))}
            </div>
          </div>
        )
        : (
          <div className="file-diff-split-panes">
            <div className="file-diff-split-pane file-diff-split-pane--before" ref={props.leftScroller} tabIndex={-1}>
              <div className="file-diff-split-lines">
                {props.rows.map((row) => (
                  <FileDiffSplitPaneRow key={row.key} row={row} side="before" html={props.html} />
                ))}
              </div>
            </div>
            <div
              className="file-diff-scroll file-diff-split-pane file-diff-split-pane--after"
              ref={props.rightScroller}
              tabIndex={-1}
            >
              <div className="file-diff-split-lines">
                {props.rows.map((row) => (
                  <FileDiffSplitPaneRow key={row.key} row={row} side="after" html={props.html} />
                ))}
              </div>
            </div>
          </div>
        )}
    </div>
  )
}

function FileDiffSplitGridRow(props: {
  row: FileDiffSplitRow
  html: readonly string[] | null
}): React.JSX.Element {
  return (
    <>
      {props.row.header && (
        <div className="file-diff-hunk file-diff-split-hunk file-diff-split-hunk--span">
          {props.row.header}
        </div>
      )}
      <FileDiffSplitCellView cell={props.row.left} side="before" html={props.html} />
      <FileDiffSplitCellView cell={props.row.right} side="after" html={props.html} />
    </>
  )
}

function FileDiffSplitPaneRow(props: {
  row: FileDiffSplitRow
  side: 'before' | 'after'
  html: readonly string[] | null
}): React.JSX.Element {
  const cell = props.side === 'before' ? props.row.left : props.row.right
  return (
    <>
      {props.row.header && (
        <div
          className="file-diff-hunk file-diff-split-hunk"
          aria-hidden={props.side === 'after' ? 'true' : undefined}
        >
          {props.side === 'before' ? props.row.header : '\u00A0'}
        </div>
      )}
      <FileDiffSplitCellView cell={cell} side={props.side} html={props.html} />
    </>
  )
}

function FileDiffSplitCellView(props: {
  cell: FileDiffSplitCell | null
  side: 'before' | 'after'
  html: readonly string[] | null
}): React.JSX.Element {
  if (props.cell === null)
    return (
      <div
        className={`file-diff-split-cell file-diff-split-cell--${props.side} file-diff-split-cell--empty`}
        aria-hidden="true"
      >
        <span className="file-diff-gutter" />
        <span className="file-diff-marker" />
        <span className="file-diff-text">{'\u00A0'}</span>
      </div>
    )
  const { line, index } = props.cell
  const lineNumber = props.side === 'before' ? line.beforeLine : line.afterLine
  return (
    <div
      className={`file-diff-split-cell file-diff-split-cell--${props.side} file-diff-line--${line.kind}`}
      data-file-line={props.side === 'after' ? (line.afterLine ?? undefined) : undefined}
    >
      <span className="file-diff-gutter">{lineNumber ?? ''}</span>
      <span className="file-diff-marker">{FileDiffVisual.markerOf(line.kind)}</span>
      <span
        className="file-diff-text"
        dangerouslySetInnerHTML={{ __html: props.html?.[index] || FileDiffVisual.escape(line.text) || ' ' }}
      />
    </div>
  )
}

function FileDiffMinimap(props: {
  marks: readonly FileDiffMinimapMark[]
  scroller: React.RefObject<HTMLDivElement | null>
  scrollerKey: string
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
      const height = element.clientHeight / Math.max(1, props.marks.length)
      const barHeight = Math.max(1, height)
      const half = element.clientWidth / 2
      props.marks.forEach((mark, index) => {
        const y = index * height
        if (mark === 'context') return
        else if (mark === 'add') {
          context.fillStyle = add
          context.fillRect(0, y, element.clientWidth, barHeight)
        }
        else if (mark === 'remove') {
          context.fillStyle = remove
          context.fillRect(0, y, element.clientWidth, barHeight)
        }
        else if (mark === 'change') {
          context.fillStyle = remove
          context.fillRect(0, y, half, barHeight)
          context.fillStyle = add
          context.fillRect(half, y, element.clientWidth - half, barHeight)
        }
        else throw new Error(`Unknown minimap mark: ${JSON.stringify(mark)}`)
      })
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(element)
    return () => observer.disconnect()
  }, [props.marks])

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
    // `props.marks` and `props.scrollerKey` as well as the ref: content changes `scrollHeight`
    // without resizing the box, and layout/wrap switches mount a new `.file-diff-scroll` element.
  }, [props.marks, props.scroller, props.scrollerKey])

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

export class FileDiffLayoutPreference {
  static readonly storageKeyConst = 'jamat.fileDiff.layout'

  static read(): FileDiffLayout {
    try {
      const stored = window.localStorage.getItem(FileDiffLayoutPreference.storageKeyConst)
      if (stored === 'unified' || stored === 'split') return stored
    }
    catch {
      return 'unified'
    }
    return 'unified'
  }

  static write(layout: FileDiffLayout): void {
    try {
      window.localStorage.setItem(FileDiffLayoutPreference.storageKeyConst, layout)
    }
    catch {
      // Storage refusal only drops persistence across opens; the active view still switches.
    }
  }
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
  static markerOf(kind: FileDiffLineKind): string {
    if (kind === 'add') return '+'
    else if (kind === 'remove') return '-'
    else if (kind === 'context') return ' '
    else throw new Error(`Unknown diff line kind: ${JSON.stringify(kind)}`)
  }

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
    let beforeCursor = 1
    for (let lineNumber = 1; lineNumber <= current.length; lineNumber++) {
      const changed = at.get(lineNumber) ?? []
      const removals = changed.filter((line) => line.kind === 'remove')
      for (const removal of removals) {
        result.push(removal)
        if (removal.beforeLine !== null) beforeCursor = removal.beforeLine + 1
      }
      const currentChange = changed.find((line) => line.afterLine === lineNumber)
      if (currentChange !== undefined) {
        result.push(currentChange)
        if (currentChange.beforeLine !== null) beforeCursor = currentChange.beforeLine + 1
      }
      else {
        result.push({
          key: `full:${lineNumber}`,
          kind: 'context',
          text: current[lineNumber - 1],
          beforeLine: beforeCursor,
          afterLine: lineNumber,
          header: null,
        })
        beforeCursor += 1
      }
    }
    result.push(...(at.get(current.length + 1) ?? []).filter((line) => line.kind === 'remove'))
    return result
  }

  static split(lines: readonly FileDiffVisualLine[]): readonly FileDiffSplitRow[] {
    const rows: FileDiffSplitRow[] = []
    let removes: FileDiffSplitCell[] = []
    let adds: FileDiffSplitCell[] = []
    let pendingHeader: string | null = null

    const flush = (): void => {
      const count = Math.max(removes.length, adds.length)
      for (let i = 0; i < count; i++) {
        const left = removes[i] ?? null
        const right = adds[i] ?? null
        rows.push({
          key: `${left?.line.key ?? 'empty'}|${right?.line.key ?? 'empty'}`,
          header: i === 0 ? pendingHeader : null,
          left,
          right,
        })
      }
      removes = []
      adds = []
      pendingHeader = null
    }

    lines.forEach((line, index) => {
      if (line.header !== null) flush()
      if (line.kind === 'context') {
        flush()
        const cell: FileDiffSplitCell = { line, index }
        rows.push({ key: line.key, header: line.header, left: cell, right: cell })
      }
      else if (line.kind === 'remove') {
        if (adds.length > 0) flush()
        if (line.header !== null) pendingHeader = line.header
        removes.push({ line, index })
      }
      else if (line.kind === 'add') {
        if (line.header !== null) pendingHeader = line.header
        adds.push({ line, index })
      }
      else throw new Error(`Unknown diff line kind: ${JSON.stringify(line.kind)}`)
    })
    flush()
    return rows
  }

  static minimapMarks(
    layout: FileDiffLayout,
    lines: readonly FileDiffVisualLine[],
    splitRows: readonly FileDiffSplitRow[],
  ): readonly FileDiffMinimapMark[] {
    if (layout === 'unified') return lines.map((line) => line.kind)
    else if (layout === 'split')
      return splitRows.map((row) => {
        const removed = row.left?.line.kind === 'remove'
        const added = row.right?.line.kind === 'add'
        if (removed && added) return 'change'
        else if (removed) return 'remove'
        else if (added) return 'add'
        else return 'context'
      })
    else throw new Error(`Unknown diff layout: ${JSON.stringify(layout)}`)
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
