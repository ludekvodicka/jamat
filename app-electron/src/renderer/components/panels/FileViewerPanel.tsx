import { IDockviewPanelProps } from 'dockview'
import { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { makeDataSource } from '../../datasource/panelDataSource'
import { useLayoutStore } from '../../store/layout-store'
import { fileViewerPanelId, openPeerFile, openDirectoryViewer, parentDir, pathCrumbs } from '../../utils/terminal-helpers'
import type { RemotePeer } from '../../../../../core/types/remote-control'
import { highlightToInnerHtml, highlightToInnerHtmlSync } from '../../utils/shiki'
import { DiffView } from '../DiffView'
import { FileDiffPane } from '../FileDiffPane'
import { DiffAgainstSelector } from '../DiffAgainstSelector'
import { useIpcQuery } from '../../hooks/useIpcQuery'
import { langForPath } from '../../utils/file-language'
import { resolveDiffModeOnOptions } from '../../utils/diff-mode-resolve'
import type { DiffOptions as DiffOptionsResult } from '../../../../../core/types/file-diff'
import type { DiffBaseline, DiffMode, DiffOption } from '../../../../../core/types/file-diff'
import { MdExtRenderer } from '@mdext'

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

/** Resolve a markdown image `src` against the viewed file's directory into an absolute local path
 *  (or return it unchanged if already absolute). Collapses `./` and `../`, tolerates both slashes;
 *  strips a trailing `?query`/`#hash`. Returns null for an empty src. */
function resolveLocalImagePath(dir: string, src: string): string | null {
  const clean = src.replace(/[?#].*$/, '').trim()
  if (!clean) return null
  if (/^[a-zA-Z]:[/\\]/.test(clean) || clean.startsWith('/') || clean.startsWith('\\')) return clean
  const out: string[] = []
  for (const p of `${dir}/${clean}`.split(/[/\\]+/)) {
    if (p === '' || p === '.') continue
    if (p === '..') { out.pop(); continue }
    out.push(p)
  }
  return out.length ? out.join('/') : null
}

const CSV_ROW_CAP = 5000

// Resolve a markdown link href against the directory of the file being viewed (renderer-side, no
// node:path): handles ./ and ../ and posix/windows separators; absolute paths pass through. Turns an
// in-doc relative link ("W01.md", "../weeks/W01.md") into a path the FileViewer can open in a tab.
function resolveLinkPath(baseFile: string, href: string): string {
  const clean = href.replace(/[?#].*$/, '')
  if (/^[a-zA-Z]:[/\\]/.test(clean) || clean.startsWith('/')) return clean // already absolute
  const sep = baseFile.includes('\\') ? '\\' : '/'
  const baseDir = baseFile.replace(/[/\\][^/\\]*$/, '')
  const out: string[] = []
  for (const part of `${baseDir}${sep}${clean}`.split(/[/\\]+/)) {
    if (part === '.') continue
    if (part === '..') {
      if (out.length > 1) out.pop()
      continue
    }
    out.push(part)
  }
  const resolved = out.join(sep)
  // Wiki-style relative links often drop the extension ("[W01](W01)" → W01.md). When the target's
  // last segment has no extension at all, fall back to `.md` so the new tab opens the markdown doc
  // instead of showing "File not found". Links that already carry an extension pass through untouched.
  const lastSeg = resolved.slice(resolved.lastIndexOf(sep) + 1)
  if (lastSeg && !lastSeg.includes('.')) return `${resolved}.md`
  return resolved
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
  return buf
}

// Quote-aware delimited parser (handles "" escape inside quoted fields and
// CRLF/LF line endings). Stops after rowCap rows so giant CSVs don't kill DOM.
function parseDelimited(text: string, delim: string, rowCap: number): { rows: string[][]; truncated: boolean; totalSeen: number } {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuote = false
  let totalSeen = 0
  let truncated = false
  const pushRow = () => {
    row.push(cell); cell = ''
    totalSeen++
    if (rows.length < rowCap) rows.push(row)
    else truncated = true
    row = []
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else inQuote = false
      } else cell += c
    } else if (c === '"') {
      inQuote = true
    } else if (c === delim) {
      row.push(cell); cell = ''
    } else if (c === '\n' || c === '\r') {
      pushRow()
      if (c === '\r' && text[i + 1] === '\n') i++
    } else cell += c
  }
  if (cell.length > 0 || row.length > 0) pushRow()
  return { rows, truncated, totalSeen }
}

interface FileViewerParams {
  filePath?: string
  /** When set, enables Claude session diff modes against this project's active session. */
  projectDir?: string
  /** Specific session id to diff against; defaults to the active session of `projectDir`. */
  sessionId?: string
  /**
   * Initial diff mode override. When set, the panel uses this instead of the
   * backend-resolved default (typically `git-head`). RecentFiles "Open file"
   * uses `{ kind: 'off' }` to land directly in non-diff view.
   */
  initialDiffMode?: DiffMode
  /**
   * Caller wants the backend's smart-default DIFF baseline on open (e.g. RecentFiles "Show
   * changes"). Only consulted when there is no `initialDiffMode` and no saved default view —
   * in that unset case the panel otherwise lands on the rendered/formatted view (non-diff).
   */
  preferDiffOnOpen?: boolean
  /**
   * When set, the panel reads the FILE + diffs from this PEER over the op API instead of the
   * local FS (Direction #2 remote parity). Remote mode is read-only: edit/save, VS Code, file
   * watching, and binary (image/PDF) previews are local-only and disabled.
   */
  peer?: RemotePeer
}

const DIFF_MODE_OFF: DiffMode = { kind: 'off' }

// Which view a freshly-opened file lands on, when not opened with an explicit initialDiffMode.
// Persisted globally (right-click a view button → "Set as default"). UNSET (null) defaults to
// FORMATTED (non-diff): opening a file — terminal right-click, keyboard, command palette — lands on
// the rendered view, not an auto-diff. 'diff' opts back into the backend's smart-default baseline on
// every open; callers that specifically want changes-on-open pass `preferDiffOnOpen` instead.
type FileViewDefault = 'formatted' | 'raw' | 'diff'
const FILE_VIEW_DEFAULT_KEY = 'file-viewer-default-mode'
function getFileViewDefault(): FileViewDefault | null {
  const v = localStorage.getItem(FILE_VIEW_DEFAULT_KEY)
  return v === 'formatted' || v === 'raw' || v === 'diff' ? v : null
}
function setFileViewDefault(mode: FileViewDefault | null): void {
  if (mode) localStorage.setItem(FILE_VIEW_DEFAULT_KEY, mode)
  else localStorage.removeItem(FILE_VIEW_DEFAULT_KEY)
}

function diffModeKey(mode: DiffMode): string {
  if (mode.kind === 'git-head-back' || mode.kind === 'session-turn-back') {
    return `${mode.kind}:${mode.n}`
  }
  return mode.kind
}

// In-file find. Uses the CSS Custom Highlight API (Range-based) rather than wrapping matches in
// <mark> nodes. Wrapping mutates the DOM, and for the markdown view (rendered via
// dangerouslySetInnerHTML) React WIPES those manual mutations on the very next re-render — so the
// match count showed but nothing highlighted and Next/Prev jumped to detached nodes. Highlight
// ranges paint over the live text without touching the DOM, so they survive re-renders in every
// view (markdown, code, raw). Chromium (Electron) supports CSS.highlights; if absent it no-ops.
function useFileSearch(containerRef: React.RefObject<HTMLElement | null>) {
  const [visible, setVisible] = useState(false)
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [currentMatch, setCurrentMatch] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rangesRef = useRef<Range[]>([])
  const currentIdxRef = useRef(0)

  const clearHighlights = useCallback(() => {
    CSS.highlights?.delete('file-search')
    CSS.highlights?.delete('file-search-current')
    rangesRef.current = []
    currentIdxRef.current = 0
    setMatchCount(0)
    setCurrentMatch(0)
  }, [])

  // Paint match `idx` (0-based) as current, the whole set as plain matches, and scroll it in view.
  const showMatch = useCallback((idx: number) => {
    const ranges = rangesRef.current
    if (!CSS.highlights || ranges.length === 0 || !ranges[idx]) return
    CSS.highlights.set('file-search', new Highlight(...ranges))
    const current = new Highlight(ranges[idx])
    current.priority = 1 // paints over the base 'file-search' layer
    CSS.highlights.set('file-search-current', current)
    currentIdxRef.current = idx
    setCurrentMatch(idx + 1)
    // Ranges have no scrollIntoView — scroll the element that contains the match start.
    ranges[idx].startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }, [])

  const highlight = useCallback((q: string) => {
    clearHighlights()
    if (!q || !containerRef.current || typeof CSS === 'undefined' || !CSS.highlights) return

    const ranges: Range[] = []
    const lowerQ = q.toLowerCase()
    // Skip text inside rendered diagrams — SVG label text (mermaid/DOT node names) isn't document
    // text, so it shouldn't count as a find hit or steal the "current match" scroll.
    const walker = document.createTreeWalker(containerRef.current, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        for (let el = n.parentElement; el; el = el.parentElement) {
          if (el.classList?.contains('mdext-diagram')) return NodeFilter.FILTER_REJECT
        }
        return NodeFilter.FILTER_ACCEPT
      },
    })
    let node: Text | null
    while ((node = walker.nextNode() as Text | null)) {
      const text = node.textContent ?? ''
      const lowerText = text.toLowerCase()
      let idx = lowerText.indexOf(lowerQ)
      while (idx !== -1) {
        const r = document.createRange()
        r.setStart(node, idx)
        r.setEnd(node, idx + q.length)
        ranges.push(r)
        idx = lowerText.indexOf(lowerQ, idx + q.length)
      }
    }

    rangesRef.current = ranges
    setMatchCount(ranges.length)
    if (ranges.length > 0) showMatch(0)
  }, [containerRef, clearHighlights, showMatch])

  const goTo = useCallback((dir: 1 | -1) => {
    const ranges = rangesRef.current
    if (ranges.length === 0) return
    showMatch((currentIdxRef.current + dir + ranges.length) % ranges.length)
  }, [showMatch])

  const open = useCallback(() => {
    setVisible(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  const close = useCallback(() => {
    setVisible(false)
    setQuery('')
    clearHighlights()
  }, [clearHighlights])

  // Re-paint after async-rendered content settles the DOM under us — the markdown widget's Shiki
  // leaves swap their fallback <pre> for highlighted spans after mount, which detaches ranges
  // painted against the fallback. The CSS Highlight API mutates nothing, so observing can't loop;
  // rAF-debounce coalesces the burst of mutations a render produces.
  useEffect(() => {
    const el = containerRef.current
    if (!visible || !el) return
    let raf = 0
    const obs = new MutationObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => highlight(query))
    })
    obs.observe(el, { childList: true, subtree: true, characterData: true })
    return () => { obs.disconnect(); cancelAnimationFrame(raf) }
  }, [visible, query, highlight, containerRef])

  return { visible, query, setQuery, matchCount, currentMatch, inputRef, open, close, highlight, goTo }
}

function CsvTable({ text, delim }: { text: string; delim: string }) {
  const { rows, truncated, totalSeen } = parseDelimited(text, delim, CSV_ROW_CAP)
  if (rows.length === 0) return <div className="file-viewer-status">Empty file</div>
  const [header, ...body] = rows
  const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0)
  return (
    <div className="file-viewer-table-wrap">
      <table className="file-viewer-table">
        <thead>
          <tr>
            <th className="file-viewer-table-rownum"></th>
            {Array.from({ length: colCount }, (_, i) => (
              <th key={i}>{header[i] ?? ''}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              <td className="file-viewer-table-rownum">{ri + 1}</td>
              {Array.from({ length: colCount }, (_, ci) => (
                <td key={ci}>{r[ci] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <div className="file-viewer-table-notice">
          Showing first {CSV_ROW_CAP.toLocaleString()} of {totalSeen.toLocaleString()} rows — switch to Raw to see the rest.
        </div>
      )}
    </div>
  )
}

/** Rendered HTML preview — an isolated Electron <webview> loading the file via file://, so scripts and
 *  relative CSS/JS/images resolve exactly as in a browser (same mechanism as the usage-stats report).
 *  Local files only; the webview runs out-of-process and popups are disabled. Re-mounts (reloads) when
 *  the path changes or the Source⇄Preview toggle flips. */
function HtmlPreview({ filePath }: { filePath: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const p = filePath.replace(/\\/g, '/')
    const webview = document.createElement('webview') as any
    webview.setAttribute('allowpopups', 'false')
    webview.src = `${p.startsWith('/') ? 'file://' : 'file:///'}${p}`
    webview.style.width = '100%'
    webview.style.height = '100%'
    webview.style.border = 'none'
    host.appendChild(webview)
    return () => webview.remove()
  }, [filePath])
  return <div ref={hostRef} style={{ flex: 1, minHeight: 0, display: 'flex' }} />
}

export function FileViewerPanel({ api, params }: IDockviewPanelProps<FileViewerParams>) {
  const [content, setContent] = useState<string | null>(null)
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [rawMode, setRawMode] = useState(() => getFileViewDefault() === 'raw')
  // Right-click "Set as default" menu for the view-mode buttons (Formatted / Raw / Diff).
  const [defaultMenu, setDefaultMenu] = useState<{ x: number; y: number; mode: FileViewDefault } | null>(null)
  const defaultMenuRef = useRef<HTMLDivElement>(null)
  const [defaultMode, setDefaultModeState] = useState<FileViewDefault | null>(() => getFileViewDefault())
  const openDefaultMenu = useCallback((e: React.MouseEvent, mode: FileViewDefault) => {
    e.preventDefault(); e.stopPropagation()
    setDefaultMenu({ x: e.clientX, y: e.clientY, mode })
  }, [])
  const applyDefault = useCallback((mode: FileViewDefault | null) => {
    setFileViewDefault(mode)
    setDefaultModeState(mode)
    setDefaultMenu(null)
  }, [])
  useEffect(() => {
    if (!defaultMenu) return
    const onDown = (ev: MouseEvent) => { if (defaultMenuRef.current && !defaultMenuRef.current.contains(ev.target as Node)) setDefaultMenu(null) }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setDefaultMenu(null) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [defaultMenu])
  const [editMode, setEditMode] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [closeConfirm, setCloseConfirm] = useState(false)
  const [svgShowSource, setSvgShowSource] = useState(false)
  // HTML: Preview (rendered in a webview) vs Source (highlighted). Default Preview.
  const [htmlShowSource, setHtmlShowSource] = useState(false)
  const [tableMode, setTableMode] = useState(true)
  const [diffMode, setDiffMode] = useState<DiffMode>(DIFF_MODE_OFF)
  const [diffOptions, setDiffOptions] = useState<DiffOption[]>([])
  const [diffBaseline, setDiffBaseline] = useState<DiffBaseline | null>(null)
  // Resolved session that the backend picked for this file — might differ
  // from `params.sessionId` (e.g. cross-session fallback for a file
  // developed across multiple sessions). All subsequent get-baseline calls
  // must use this so the diff matches the dropdown's session-* options.
  const [effectiveSessionId, setEffectiveSessionId] = useState<string | null>(null)
  // True after the user picks a diff mode in the selector. Stops the
  // options-resolve callback from overwriting their pick with the smart
  // default if the IPC settles late. Reset whenever filePath changes.
  const userPickedDiffMode = useRef(false)
  const codeRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pdfBlobUrlRef = useRef<string | null>(null)

  // Data source: local (this machine's FS) or, when `params.peer` is set, the peer over the op API.
  // Remote mode is read-only — `remote` gates the local-only affordances (edit/watch/VS Code/binary).
  const ds = useMemo(() => makeDataSource(params.peer), [params.peer?.id])
  const remote = ds.remote
  // True when a remote file is binary (image/PDF): there is no remote binary-read op, so we show a
  // notice instead of attempting a (garbled) text read.
  const [remoteBinaryBlocked, setRemoteBinaryBlocked] = useState(false)
  // Local markdown image srcs (raw src as written → data: URL read off disk), so relative
  // `![](assets/x.svg)` renders — the browser can't load it on its own and the renderer's sanitizer
  // blocks file:/data:. Populated by the effect below; passed to MdExtRenderer as resolveImageSrc.
  const [imageSrcMap, setImageSrcMap] = useState<Map<string, string>>(new Map())

  const filePath = params.filePath ?? ''
  const fileName = filePath.replace(/^.*[/\\]/, '')
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  const lang = langForPath(filePath)
  const isMarkdown = ext === 'md' || ext === 'markdown'
  // Markdown now renders via the shared MdExtRenderer widget (react-markdown + Shiki, sanitized) —
  // real React DOM, so the old marked + dangerouslySetInnerHTML memoization hack is gone. In-file
  // search keeps working via the CSS Custom Highlight API; a MutationObserver in useFileSearch
  // re-paints once async leaves (Shiki) settle the DOM.
  const imageMime = IMAGE_MIME[ext]
  const isSvg = ext === 'svg'
  const isPdf = ext === 'pdf'
  const isCsv = ext === 'csv'
  const isTsv = ext === 'tsv'
  const isTable = isCsv || isTsv
  const isHtml = ext === 'html' || ext === 'htm'
  // HTML preview renders in a webview (local files only — no peer webview). Source/diff/edit/remote
  // fall back to the text path. Gated in the JSX below (which already excludes diff/edit by position).
  const showAsHtml = isHtml && !htmlShowSource && !remote
  // SVG can be shown either as a rendered image or as XML source — other image
  // formats are always rendered. svgShowSource flips SVG into text mode.
  const showAsImage = !!imageMime && !(isSvg && svgShowSource)
  const showAsTable = isTable && tableMode && !editMode
  const projectDir = params.projectDir ?? null
  const sessionId = params.sessionId ?? null

  // Open this file's containing folder in a directory viewer tab (local only — a remote peer's
  // folder can't be browsed in the local FS panel).
  const openFolder = () => {
    const dir = parentDir(filePath)
    const api = useLayoutStore.getState().dockviewApi
    if (dir && api) openDirectoryViewer(api, dir, projectDir ?? undefined)
  }

  // The toolbar path as clickable crumbs: each DIRECTORY segment opens a directory viewer at that
  // folder (like the directory viewer's own breadcrumb); the final segment (the file name) is plain.
  // Falls back to a static span for remote files (the directory viewer is local-only).
  const renderPath = () => {
    if (remote || !filePath) {
      return <span className="file-viewer-path" title={filePath}>{filePath}</span>
    }
    const crumbs = pathCrumbs(filePath)
    return (
      <span className="file-viewer-path" title={filePath}>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <span key={c.dir}>
              {i > 0 && <span className="file-viewer-path-sep">\</span>}
              {last ? (
                <span className="file-viewer-path-name">{c.label}</span>
              ) : (
                <span
                  className="file-viewer-path-crumb"
                  title={`Open ${c.dir} in directory viewer`}
                  onClick={() => {
                    const api = useLayoutStore.getState().dockviewApi
                    if (api) openDirectoryViewer(api, c.dir, projectDir ?? undefined)
                  }}
                >{c.label}</span>
              )}
            </span>
          )
        })}
      </span>
    )
  }

  // The file viewer's binary/visual modes (image / pdf / csv-as-table)
  // replace the text rendering entirely — diff mode can't apply. Markdown
  // formatted view and SVG source view are still text under the hood, so the
  // selector stays available and the diff render takes precedence when active.
  const isCustomRender = showAsImage || isPdf || showAsTable
  // `diffActive` = user picked a non-off baseline and it loaded — drives
  // selector highlight + status pill. `inDiffMode` = we actually have changes
  // worth rendering as a diff; without changes we fall back to the normal
  // file view (so user sees the full file, not an "empty diff" placeholder).
  const diffActive =
    diffMode.kind !== 'off' &&
    !!diffBaseline &&
    !diffBaseline.error &&
    !editMode &&
    !isCustomRender
  const inDiffMode =
    diffActive && !!diffBaseline && (diffBaseline.addedLines > 0 || diffBaseline.removedLines > 0)

  const search = useFileSearch(contentRef)

  // In-document link clicks: open file/relative links in a NEW TAB of this window (resolved against
  // the current file's dir), and external http(s) links in the default browser — instead of the old
  // <a target=_blank> behavior that spawned a whole new app window. Anchors (#…) fall through.
  const handleContentClick = useCallback(
    (e: React.MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest?.('a')
      if (!anchor) return
      const href = anchor.getAttribute('href')
      if (!href || href.startsWith('#')) return
      e.preventDefault()
      if (/^https?:/i.test(href)) {
        window.electronAPI?.runAction?.('open-url', href)
        return
      }
      const dockApi = useLayoutStore.getState().dockviewApi
      if (!dockApi) return
      const target = resolveLinkPath(filePath, href)
      if (params.peer) {
        openPeerFile(dockApi, params.peer, target, params.projectDir)
        return
      }
      const id = fileViewerPanelId(params.projectDir, target)
      const linkParams = { filePath: target, projectDir: params.projectDir }
      const existing = dockApi.panels.find((p) => p.id === id)
      if (existing) {
        existing.api.updateParameters(linkParams)
        existing.api.setActive()
        return
      }
      dockApi.addPanel({ id, component: 'fileViewerPanel', title: target.replace(/^.*[/\\]/, ''), params: linkParams })
    },
    [filePath, params.peer, params.projectDir],
  )

  // Single source of truth for find highlights: (re)paint after the query OR the rendered view
  // changes underneath (live-reload, Formatted/Raw/Diff/Source switch). Runs post-commit, so the
  // ranges resolve against the DOM that's actually on screen. The input's onChange only setQuery's.
  useLayoutEffect(() => {
    if (search.visible) search.highlight(search.query)
  }, [search.visible, search.query, search.highlight, content, rawMode, inDiffMode, svgShowSource])

  const reload = useCallback(() => {
    if (!filePath) return
    if (showAsImage || isPdf) {
      // No remote binary-read op — show a notice rather than a garbled text read.
      if (remote) {
        setRemoteBinaryBlocked(true)
        setImageDataUrl(null); setPdfBlobUrl(null); setContent('')
        setLoading(false); api.setTitle(fileName)
        return
      }
      setRemoteBinaryBlocked(false)
      if (!window.electronAPI?.readFileBinary) return
      window.electronAPI.readFileBinary(filePath).then((b64) => {
        if (b64 === null) {
          setImageDataUrl(null)
          setPdfBlobUrl(null)
          setContent(null)
          setLoading(false)
          return
        }
        if (isPdf) {
          const buf = base64ToArrayBuffer(b64)
          const blob = new Blob([buf], { type: 'application/pdf' })
          const url = URL.createObjectURL(blob)
          if (pdfBlobUrlRef.current) URL.revokeObjectURL(pdfBlobUrlRef.current)
          pdfBlobUrlRef.current = url
          setPdfBlobUrl(url)
          setImageDataUrl(null)
        } else {
          setImageDataUrl(`data:${imageMime};base64,${b64}`)
          setPdfBlobUrl(null)
        }
        setContent('')
        setLoading(false)
        api.setTitle(fileName)
      })
    } else {
      setRemoteBinaryBlocked(false)
      ds.readFile(filePath).then((data) => {
        setContent(data)
        setImageDataUrl(null)
        setPdfBlobUrl(null)
        setLoading(false)
        if (data !== null) api.setTitle(fileName)
      }).catch(() => {
        setContent(null)
        setLoading(false)
      })
    }
  }, [filePath, fileName, showAsImage, isPdf, imageMime, remote, ds])

  // Pre-resolve LOCAL markdown image srcs into data: URLs (read off disk, relative to this file's
  // dir). The browser can't load a relative/on-disk `![](assets/x.svg)` on its own, and the
  // renderer's sanitizer blocks file:/data:; so the host reads the bytes and hands the widget a
  // trusted data: URL via resolveImageSrc. Remote (peer) files are never auto-loaded.
  useEffect(() => {
    if (!isMarkdown || remote || !content || !window.electronAPI?.readFileBinary) {
      setImageSrcMap((prev) => (prev.size ? new Map() : prev))
      return
    }
    let alive = true
    const dir = filePath.replace(/[/\\][^/\\]*$/, '')
    const srcs = new Set<string>()
    const re = /!\[[^\]]*\]\(\s*<?([^)>\s]+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const s = m[1]
      if (/^https?:/i.test(s) || s.startsWith('data:') || s.startsWith('//') || s.startsWith('#')) continue
      srcs.add(s)
    }
    if (srcs.size === 0) {
      setImageSrcMap((prev) => (prev.size ? new Map() : prev))
      return
    }
    void Promise.all([...srcs].map(async (raw) => {
      const abs = resolveLocalImagePath(dir, raw)
      if (!abs) return null
      const mime = IMAGE_MIME[abs.split('.').pop()?.toLowerCase() ?? '']
      if (!mime) return null
      const b64 = await window.electronAPI!.readFileBinary!(abs).catch(() => null)
      return b64 == null ? null : ([raw, `data:${mime};base64,${b64}`] as const)
    })).then((pairs) => {
      if (!alive) return
      const map = new Map<string, string>()
      for (const p of pairs) if (p) map.set(p[0], p[1])
      setImageSrcMap(map)
    })
    return () => { alive = false }
  }, [isMarkdown, remote, content, filePath])

  const resolveImageSrc = useCallback((raw: string) => imageSrcMap.get(raw), [imageSrcMap])

  // Read editMode through a ref so the file-watcher callback isn't torn
  // down on every edit-mode toggle, but still sees the latest value (a stale
  // closure here would clobber the textarea with disk content while the
  // user is editing).
  const editModeRef = useRef(editMode)
  useEffect(() => { editModeRef.current = editMode }, [editMode])

  useEffect(() => {
    if (!filePath) {
      setLoading(false)
      return
    }
    setLoading(true)
    reload()
    // File watching is a LOCAL-FS concern — a peer's path doesn't exist here. Remote viewers
    // refresh manually (no live auto-reload).
    if (remote) return
    window.electronAPI.watchFile?.(filePath)
    const removeListener = window.electronAPI.onFileChanged?.((changed) => {
      if (changed === filePath && !editModeRef.current) reload()
    })
    return () => {
      removeListener?.()
      window.electronAPI.unwatchFile?.(filePath)
    }
  }, [filePath, reload, remote])

  useEffect(() => () => {
    if (pdfBlobUrlRef.current) {
      URL.revokeObjectURL(pdfBlobUrlRef.current)
      pdfBlobUrlRef.current = null
    }
  }, [])

  // Shiki highlight of the plain-code view. The synchronous fast-path runs in a
  // layout effect (before paint), so a warm highlighter colors the code with no
  // flash; only the first cold use falls back to async, briefly showing the raw
  // `{content}` text child React rendered. On failure / unknown lang plain stays.
  useLayoutEffect(() => {
    if (!(codeRef.current && content && lang && !editMode && !inDiffMode)) return
    const el = codeRef.current
    const sync = highlightToInnerHtmlSync(content, lang)
    if (sync != null) {
      el.innerHTML = sync
      return
    }
    let alive = true
    highlightToInnerHtml(content, lang)
      .then((html) => {
        if (alive && html != null) el.innerHTML = html
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [content, lang, editMode, inDiffMode])

  // Reset the user-picked flag whenever the file changes — a fresh file
  // should take the backend's smart default until the user picks otherwise.
  useEffect(() => {
    userPickedDiffMode.current = false
  }, [filePath, projectDir])

  // Conditions under which the diff selector + baseline are meaningful.
  // Image/PDF/SVG renders, edit mode, or unloaded content all skip the
  // fetch and clear any prior diff state.
  const canShowDiff = !!filePath && content !== null && !isCustomRender

  // Selector options: enumerate available baselines for this file.
  useIpcQuery<DiffOptionsResult>(
    () => canShowDiff ? ds.getFileDiffOptions(filePath, projectDir, sessionId) : undefined,
    [filePath, projectDir, sessionId, canShowDiff, ds],
    {
      onResolve: (opts) => {
        setDiffOptions(opts.options)
        setEffectiveSessionId(opts.effectiveSessionId ?? null)
        // params.initialDiffMode wins on first mount. Otherwise the smart
        // default applies unless the user has already picked — guarded so a
        // late IPC doesn't clobber their pick. Decision logic is the pure
        // `resolveDiffModeOnOptions` (unit-tested).
        const decision = resolveDiffModeOnOptions(!!params.initialDiffMode, userPickedDiffMode.current)
        if (decision === 'initial') {
          setDiffMode(params.initialDiffMode!)
        } else if (decision === 'default') {
          // Default view: 'diff' (saved) → backend smart baseline; 'formatted'/'raw' → non-diff.
          // UNSET → formatted (non-diff), unless the caller asked for diff-on-open (RecentFiles
          // "Show changes"). So a plain open lands on the rendered view, not an auto-diff.
          const pref = getFileViewDefault()
          const wantDiff = pref === 'diff' || (pref === null && params.preferDiffOnOpen === true)
          setDiffMode(wantDiff ? opts.defaultMode : DIFF_MODE_OFF)
        }
      },
    },
  )

  // Clear options/baseline when the file isn't diffable (edit mode,
  // image render, unloaded content).
  useEffect(() => {
    if (!canShowDiff) {
      setDiffOptions([])
      setDiffMode(DIFF_MODE_OFF)
      setDiffBaseline(null)
    }
  }, [canShowDiff])

  // Baseline content for the active diff mode.
  const shouldFetchBaseline = canShowDiff && diffMode.kind !== 'off' && !editMode
  const baselineQuery = useIpcQuery<DiffBaseline>(
    () => shouldFetchBaseline
      ? ds.getFileDiffBaseline(filePath, diffMode, projectDir, effectiveSessionId ?? sessionId)
      : undefined,
    [filePath, diffMode, projectDir, sessionId, effectiveSessionId, shouldFetchBaseline, ds],
    {
      onResolve: setDiffBaseline,
    },
  )

  // Surface IPC failures as a synthetic baseline so the toolbar shows the
  // error state without leaving "Loading…" forever.
  useEffect(() => {
    if (baselineQuery.error) {
      setDiffBaseline({
        beforeText: '',
        afterText: content ?? '',
        label: '',
        addedLines: 0,
        removedLines: 0,
        isRegionOnly: false,
        error: baselineQuery.error.message,
      })
    }
  }, [baselineQuery.error, content])

  // Clear the baseline when the user switches off diff mode.
  useEffect(() => {
    if (diffMode.kind === 'off') setDiffBaseline(null)
  }, [diffMode])

  const diffLoading = baselineQuery.loading

  const enterEditMode = useCallback(() => {
    setEditContent(content ?? '')
    setEditMode(true)
    setSaveError(null)
    setTimeout(() => textareaRef.current?.focus(), 50)
  }, [content])

  const discardEdit = useCallback(() => {
    setEditMode(false)
    setEditContent('')
    setSaveError(null)
    setCloseConfirm(false)
  }, [])

  const saveEdit = useCallback(async () => {
    if (!window.electronAPI?.writeFile) return
    setSaving(true)
    setSaveError(null)
    try {
      const result = await window.electronAPI.writeFile(filePath, editContent)
      if (result.ok) {
        setContent(editContent)
        setEditMode(false)
        setEditContent('')
      } else {
        setSaveError(result.error ?? 'Save failed')
      }
    } catch (e) {
      setSaveError(String(e))
    } finally {
      setSaving(false)
    }
  }, [filePath, editContent])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!api.isActive) return
      if (editMode && e.ctrlKey && e.key === 's') {
        e.preventDefault()
        saveEdit()
      } else if (!editMode && !showAsImage && !isPdf && e.ctrlKey && e.key === 'f') {
        e.preventDefault()
        search.open()
      } else if (!editMode && !remote && e.ctrlKey && (e.key === 'e' || e.key === 'E')) {
        // Ctrl+E — same action as the header "Edit" button (shown for !editMode && !remote).
        e.preventDefault()
        enterEditMode()
      } else if (e.key === 'Escape') {
        if (closeConfirm) {
          setCloseConfirm(false)            // ESC on the prompt = Cancel, keep editing
        } else if (search.visible) {
          search.close()                    // ESC closes the find bar first
        } else if (editMode) {
          if (editContent !== content) {
            setCloseConfirm(true)           // unsaved changes → ask Save/Discard/Cancel
          } else {
            discardEdit()                   // no changes → just leave write mode
          }
        } else {
          api.close()                       // read mode → close the tab
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [api, editMode, editContent, content, closeConfirm, saveEdit, discardEdit, enterEditMode, remote, search.open, search.close, search.visible, showAsImage, isPdf])

  if (loading) return <div className="file-viewer"><div className="file-viewer-status">Loading...</div></div>
  if (remoteBinaryBlocked) return (
    <div className="file-viewer">
      <div className="file-viewer-toolbar">
        {renderPath()}
        <span className="file-viewer-diff-status">🛰 remote (read-only)</span>
      </div>
      <div className="file-viewer-status">Binary preview (image / PDF) isn’t available over a remote connection — open it on the peer.</div>
    </div>
  )
  if (content === null) return <div className="file-viewer"><div className="file-viewer-status">File not found: {filePath}</div></div>

  return (
    <div className="file-viewer">
      <div className="file-viewer-toolbar">
        {renderPath()}
        {!editMode && showAsImage && (
          <>
            <button className="notes-btn" onClick={() => navigator.clipboard.writeText(filePath)}>Copy path</button>
            {isSvg && (
              <span className="file-viewer-view-modes">
                <button className="notes-btn file-viewer-mode-btn file-viewer-mode-btn-active">Preview</button>
                <button
                  className="notes-btn file-viewer-mode-btn"
                  onClick={() => setSvgShowSource(true)}
                >Source</button>
              </span>
            )}
          </>
        )}
        {!editMode && isPdf && (
          <button className="notes-btn" onClick={() => navigator.clipboard.writeText(filePath)}>Copy path</button>
        )}
        {!editMode && !showAsImage && !isPdf && (
          <>
            {!remote && <button className="notes-btn" onClick={openFolder} title="Open this file's folder in a directory viewer">Open folder</button>}
            <button className="notes-btn" onClick={() => navigator.clipboard.writeText(content)}>Copy</button>
            <button className="notes-btn" onClick={() => navigator.clipboard.writeText(filePath)}>Copy path</button>
            {/* View-mode group: pair of buttons for file-type-specific rendering
                + diff selector. Clicking a view button clears diff so the
                view immediately reflects the click. The Diff selector shows
                active when a baseline is picked. */}
            <span className="file-viewer-view-modes">
              {isMarkdown && (
                <>
                  <button
                    className={`notes-btn file-viewer-mode-btn${!rawMode && !inDiffMode ? ' file-viewer-mode-btn-active' : ''}`}
                    onClick={() => { setRawMode(false); setDiffMode(DIFF_MODE_OFF) }}
                    onContextMenu={(e) => openDefaultMenu(e, 'formatted')}
                    title="Right-click → set as the default view for opened files"
                  >{defaultMode === 'formatted' ? '● ' : ''}Formatted</button>
                  <button
                    className={`notes-btn file-viewer-mode-btn${rawMode && !inDiffMode ? ' file-viewer-mode-btn-active' : ''}`}
                    onClick={() => { setRawMode(true); setDiffMode(DIFF_MODE_OFF) }}
                    onContextMenu={(e) => openDefaultMenu(e, 'raw')}
                    title="Right-click → set as the default view for opened files"
                  >{defaultMode === 'raw' ? '● ' : ''}Raw</button>
                </>
              )}
              {isSvg && (
                <>
                  <button
                    className={`notes-btn file-viewer-mode-btn${!svgShowSource && !inDiffMode ? ' file-viewer-mode-btn-active' : ''}`}
                    onClick={() => { setSvgShowSource(false); setDiffMode(DIFF_MODE_OFF) }}
                  >Preview</button>
                  <button
                    className={`notes-btn file-viewer-mode-btn${svgShowSource && !inDiffMode ? ' file-viewer-mode-btn-active' : ''}`}
                    onClick={() => { setSvgShowSource(true); setDiffMode(DIFF_MODE_OFF) }}
                  >Source</button>
                </>
              )}
              {isHtml && !remote && (
                <>
                  <button
                    className={`notes-btn file-viewer-mode-btn${!htmlShowSource && !inDiffMode ? ' file-viewer-mode-btn-active' : ''}`}
                    onClick={() => { setHtmlShowSource(false); setDiffMode(DIFF_MODE_OFF) }}
                    title="Render the HTML in an isolated webview"
                  >Preview</button>
                  <button
                    className={`notes-btn file-viewer-mode-btn${htmlShowSource && !inDiffMode ? ' file-viewer-mode-btn-active' : ''}`}
                    onClick={() => { setHtmlShowSource(true); setDiffMode(DIFF_MODE_OFF) }}
                  >Source</button>
                </>
              )}
              {isTable && (
                <>
                  <button
                    className={`notes-btn file-viewer-mode-btn${tableMode && !inDiffMode ? ' file-viewer-mode-btn-active' : ''}`}
                    onClick={() => { setTableMode(true); setDiffMode(DIFF_MODE_OFF) }}
                  >Table</button>
                  <button
                    className={`notes-btn file-viewer-mode-btn${!tableMode && !inDiffMode ? ' file-viewer-mode-btn-active' : ''}`}
                    onClick={() => { setTableMode(false); setDiffMode(DIFF_MODE_OFF) }}
                  >Raw</button>
                </>
              )}
              {!isCustomRender && diffOptions.length > 0 && (
                <>
                  {diffMode.kind !== 'off' && (
                    <button
                      className="notes-btn file-viewer-mode-btn"
                      onClick={() => { userPickedDiffMode.current = true; setDiffMode(DIFF_MODE_OFF) }}
                      title="Turn diff off — show file normally"
                    >No diff</button>
                  )}
                  <span
                    onContextMenu={(e) => openDefaultMenu(e, 'diff')}
                    title="Right-click → open files in diff by default"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
                  >
                    {defaultMode === 'diff' && <span style={{ opacity: 0.8 }}>●</span>}
                    <DiffAgainstSelector
                      value={diffMode}
                      options={diffOptions}
                      loading={diffLoading}
                      onChange={(m) => { userPickedDiffMode.current = true; setDiffMode(m) }}
                      active={diffActive}
                    />
                  </span>
                </>
              )}
            </span>
            {diffActive && diffBaseline && (
              <span className="file-viewer-diff-status" title={diffBaseline.regionOnlyReason ?? diffBaseline.label}>
                {diffBaseline.addedLines + diffBaseline.removedLines === 0
                  ? `no changes — ${diffBaseline.label.toLowerCase()}`
                  : `+${diffBaseline.addedLines} −${diffBaseline.removedLines} · ${diffBaseline.label}`}
                {diffBaseline.isRegionOnly ? ' · region only' : ''}
              </span>
            )}
            {!inDiffMode && diffBaseline?.error && (
              <span className="file-viewer-diff-status file-viewer-diff-error" title={diffBaseline.error}>
                diff error
              </span>
            )}
            {/* Edit / VS Code act on THIS machine's FS — hidden for a peer-backed (read-only) view. */}
            {!remote && (
              <>
                <button className="notes-btn" onClick={enterEditMode} title="Edit this file (Ctrl+E)">Edit</button>
                <button
                  className="notes-btn"
                  onClick={() => { void window.electronAPI?.openInVSCode?.(filePath) }}
                  title="Open in VS Code (code <path>)"
                >VS Code</button>
              </>
            )}
            {remote && <span className="file-viewer-diff-status" title="Read-only view of a remote peer's file">🛰 remote (read-only)</span>}
          </>
        )}
        {editMode && (
          <>
            {saveError && <span className="file-editor-error">{saveError}</span>}
            <button className="notes-btn notes-btn-primary" onClick={saveEdit} disabled={saving}>
              {saving ? 'Saving…' : 'Save (Ctrl+S)'}
            </button>
            <button className="notes-btn" onClick={discardEdit} disabled={saving}>Discard</button>
          </>
        )}
      </div>
      {defaultMenu && createPortal(
        <div ref={defaultMenuRef} className="tab-context-menu" style={{ left: defaultMenu.x, top: defaultMenu.y }}>
          {defaultMode === defaultMenu.mode ? (
            <div className="tab-context-item" onClick={() => applyDefault(null)}>
              ✓ Default — click to clear
            </div>
          ) : (
            <div className="tab-context-item" onClick={() => applyDefault(defaultMenu.mode)}>
              Set “{defaultMenu.mode === 'diff' ? 'Diff' : defaultMenu.mode === 'raw' ? 'Raw' : 'Formatted'}” as default view
            </div>
          )}
        </div>,
        document.body
      )}
      {!editMode && search.visible && (
        <div className="terminal-search-bar">
          <input
            ref={search.inputRef}
            className="terminal-search-input"
            type="text"
            placeholder="Find in file..."
            value={search.query}
            onChange={(e) => search.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.shiftKey) search.goTo(-1)
              else if (e.key === 'Enter') search.goTo(1)
              else if (e.key === 'Escape') search.close()
            }}
          />
          {search.matchCount > 0 && (
            <span className="terminal-search-count">{search.currentMatch}/{search.matchCount}</span>
          )}
          <button className="terminal-search-btn" onClick={() => search.goTo(-1)} title="Previous">&#x25B2;</button>
          <button className="terminal-search-btn" onClick={() => search.goTo(1)} title="Next">&#x25BC;</button>
          <button className="terminal-search-btn" onClick={search.close} title="Close">&#x2715;</button>
        </div>
      )}
      {editMode ? (
        <textarea
          ref={textareaRef}
          className="file-editor-textarea"
          value={editContent}
          onChange={e => setEditContent(e.target.value)}
          spellCheck={false}
        />
      ) : showAsImage ? (
        <div className="file-viewer-image-wrap">
          {imageDataUrl
            ? <img className="file-viewer-image" src={imageDataUrl} alt={fileName} />
            : <div className="file-viewer-status">Failed to load image</div>}
        </div>
      ) : isPdf ? (
        pdfBlobUrl
          ? <iframe className="file-viewer-pdf" src={pdfBlobUrl} title={fileName} />
          : <div className="file-viewer-status">Failed to load PDF</div>
      ) : (
        <div ref={contentRef} onClick={handleContentClick} style={{ flex: 1, overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {showAsTable ? (
            <CsvTable text={content} delim={isTsv ? '\t' : ','} />
          ) : inDiffMode && diffBaseline ? (
            diffBaseline.regionBefore !== undefined && diffBaseline.regionAfter !== undefined ? (
              <FileDiffPane
                filePath={filePath}
                regionBefore={diffBaseline.regionBefore}
                regionAfter={diffBaseline.regionAfter}
                disjoint={diffBaseline.disjoint}
                label={diffBaseline.label}
                defaultWholeFile
              />
            ) : (
              <DiffView
                beforeText={diffBaseline.beforeText}
                afterText={diffBaseline.afterText}
                highlightLang={lang ?? null}
                maxLines={500}
                startLine={diffBaseline.isRegionOnly ? null : 1}
                label={diffBaseline.isRegionOnly ? diffBaseline.regionOnlyReason ?? 'region only' : null}
                showMinimap
              />
            )
          ) : isMarkdown && !rawMode ? (
            <MdExtRenderer source={content ?? ''} theme="dark" remote={remote} resolveImageSrc={remote ? undefined : resolveImageSrc} className="file-viewer-markdown" />
          ) : showAsHtml ? (
            <HtmlPreview filePath={filePath} />
          ) : lang ? (
            <pre className="file-viewer-content"><code ref={codeRef} className={`shiki-code language-${lang}`}>{content}</code></pre>
          ) : (
            <pre className="file-viewer-content">{content}</pre>
          )}
        </div>
      )}
      {closeConfirm && (
        <div className="file-viewer-confirm-overlay">
          <div className="file-viewer-confirm">
            <div className="file-viewer-confirm-title">Save changes to {fileName}?</div>
            {saveError && <div className="file-editor-error">{saveError}</div>}
            <div className="file-viewer-confirm-actions">
              <button
                className="notes-btn notes-btn-primary"
                autoFocus
                disabled={saving}
                onClick={async () => { await saveEdit(); setCloseConfirm(false) }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button className="notes-btn" disabled={saving} onClick={discardEdit}>Discard</button>
              <button className="notes-btn" disabled={saving} onClick={() => setCloseConfirm(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
