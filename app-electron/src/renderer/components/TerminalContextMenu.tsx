import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLayoutStore } from '../store/layout-store'
import { bracketedPaste, pasteAsTextByLines, focusTerminal, openDirectoryViewer } from '../utils/terminal-helpers'
import { readClipboard } from '../utils/clipboard'
import { getTerminalFilePathExtractor } from '../../../../core/terminal/terminalFilePathExtractors'
import { DEFAULT_AGENT_ID, isAgentId, type AgentId } from '../../../../core/types/contracts'
import type { DirEntry } from '../../../../core/types/ipc-contracts'

/** How many files to show inline under a detected folder before collapsing into "+N more". */
const INLINE_FILE_CAP = 8

function baseName(path: string): string {
  return path.replace(/[/\\]+$/, '').replace(/^.*[/\\]/, '')
}

interface MenuState {
  x: number
  y: number
  terminalId: string
  projectDir: string | null
}

interface DetectedPath {
  path: string
  type: 'file' | 'dir'
  /** Resolved by searching the project for a truncated path, not by direct on-disk resolution. */
  viaSearch?: boolean
}

export function TerminalContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [detected, setDetected] = useState<DetectedPath[]>([])
  // Immediate contents of any detected folder, keyed by its path — drives the inline file list.
  const [dirContents, setDirContents] = useState<Record<string, DirEntry[]>>({})
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail
      const panels = useLayoutStore.getState().dockviewApi?.panels ?? []
      const panel = panels.find(p => p.id === detail.terminalId)
      const projectDir = (panel?.params as any)?.projectDir ?? (panel?.params as any)?.cwd ?? null
      const rawAgent = (panel?.params as { agent?: unknown } | undefined)?.agent
      const agent: AgentId = isAgentId(rawAgent) ? rawAgent : DEFAULT_AGENT_ID
      const extractor = getTerminalFilePathExtractor(agent)

      setMenu({ x: detail.x, y: detail.y, terminalId: detail.terminalId, projectDir })
      setDetected([])
      setDirContents({})

      const found: DetectedPath[] = []
      const seen = new Set<string>()

      const addDirect = async (path: string) => {
        if (seen.has(path)) return
        let ftype: 'file' | 'dir' | null = null
        try {
          ftype = await window.electronAPI?.fileType(path) ?? null
        } catch {
          try {
            if (await window.electronAPI?.fileExists(path)) ftype = 'file'
          } catch {}
        }
        if (!ftype) return
        seen.add(path)
        found.push({ path, type: ftype })
        setDetected([...found])
        // For a folder, pull its contents so the menu can list files inline (open one directly)
        // alongside the "open in directory viewer" item.
        if (ftype === 'dir') {
          try {
            const items = await window.electronAPI?.listDir(path) ?? []
            setDirContents(prev => ({ ...prev, [path]: items }))
          } catch {}
        }
      }

      const wordAtCursor = detail.wordAtCursor as string ?? ''
      const selText = useLayoutStore.getState().terminalSelection
      const tokens = [wordAtCursor, selText].filter((t): t is string => !!t)
      const uniqueTokens = tokens.filter((t, i) => tokens.indexOf(t) === i)

      // The per-agent extractor turns each token into on-disk candidates: a `direct` path to probe, or a
      // `search` spec (project-tree suffix search) for a truncated path — Claude's `…` names, or a
      // sub-agent path the host TUI clipped (`…\012-foo\bar.md`).
      const directPaths: string[] = []
      const searchSpecs: { baseDir: string; partial: string }[] = []
      for (const token of uniqueTokens) {
        for (const c of extractor.resolve(token, { projectDir })) {
          if (c.kind === 'direct') directPaths.push(c.path)
          else if (c.kind === 'search') searchSpecs.push({ baseDir: c.baseDir, partial: c.partial })
          else throw new Error(`Unknown path candidate: ${JSON.stringify(c)}`)
        }
      }

      // Direct first: a real on-disk hit wins.
      for (const path of [...new Set(directPaths)]) await addDirect(path)

      // Fallback only when nothing resolved directly: search the project and offer the matches. First
      // token that yields hits wins.
      if (found.length === 0 && window.electronAPI?.findFileBySuffix) {
        for (const spec of searchSpecs) {
          let hits: string[] = []
          try { hits = await window.electronAPI.findFileBySuffix(spec.baseDir, spec.partial) } catch { hits = [] }
          if (hits.length === 0) continue
          for (const h of hits) {
            if (seen.has(h)) continue
            seen.add(h)
            found.push({ path: h, type: 'file', viaSearch: true })
          }
          setDetected([...found])
          break
        }
      }
    }
    window.addEventListener('terminal-context-menu', handler)
    return () => window.removeEventListener('terminal-context-menu', handler)
  }, [])

  useEffect(() => {
    if (!menu) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(null)
    }
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('mousedown', handler)
    window.addEventListener('keydown', keyHandler)
    return () => { window.removeEventListener('mousedown', handler); window.removeEventListener('keydown', keyHandler) }
  }, [menu])

  if (!menu) return null

  const paste = () => {
    const tid = menu.terminalId
    void readClipboard().then((text) => {
      bracketedPaste(tid, text)
      setTimeout(() => focusTerminal(tid), 0)
    })
    setMenu(null)
  }

  // Paste as real, editable text: streams the clipboard in line by line so a large blob lands
  // as actual lines instead of Claude's collapsed "[Pasted text +N lines]" marker.
  const pasteAsText = () => {
    const tid = menu.terminalId
    void readClipboard().then((text) => {
      pasteAsTextByLines(tid, text)
      setTimeout(() => focusTerminal(tid), 0)
    })
    setMenu(null)
  }

  const openInVSCode = (path: string) => {
    window.electronAPI?.runAction('open-vscode', path)
    setMenu(null)
  }

  const openDirInViewer = (path: string) => {
    const api = useLayoutStore.getState().dockviewApi
    if (api) openDirectoryViewer(api, path, menu.projectDir ?? undefined)
    setMenu(null)
  }

  const openFileInTab = (path: string) => {
    const api = useLayoutStore.getState().dockviewApi
    if (api) {
      // Where the new file tab lands depends on the current screen split:
      //  - 1 region   → split it in half, put the file in a NEW group to the right
      //  - 2 regions  → drop the file into the OTHER group (not the one clicked in)
      //  - otherwise  → default placement, let the user move it
      const sourceGroup = (api.panels.find(p => p.id === menu.terminalId) as any)?.group
      const groups = api.groups
      let position: any
      if (groups.length === 1 && sourceGroup) {
        position = { referenceGroup: sourceGroup, direction: 'right' }
      } else if (groups.length === 2 && sourceGroup) {
        const otherGroup = groups.find(g => g.id !== sourceGroup.id)
        if (otherGroup) position = { referenceGroup: otherGroup }
      }
      api.addPanel({
        id: `file-${Date.now()}`,
        component: 'fileViewerPanel',
        title: baseName(path),
        params: { filePath: path },
        ...(position ? { position } : {})
      })
    }
    setMenu(null)
  }

  return createPortal(
    <div ref={ref} className="tab-context-menu" style={{ left: menu.x, top: menu.y }}>
      {detected.map((d) => (
        <div key={d.path}>
          {d.type === 'file' && (
            <div className="tab-context-item" onClick={() => openFileInTab(d.path)} title={d.viaSearch ? d.path : undefined}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}><path d="M3 1h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm6.5 0L13 4.5V13H3V1h6.5zM9 1v4h4"/></svg>
              Open {baseName(d.path)} in tab{d.viaSearch ? ' (found)' : ''}
            </div>
          )}
          {d.type === 'dir' && (() => {
            const files = (dirContents[d.path] ?? []).filter(it => it.type === 'file')
            return (
              <>
                <div className="tab-context-item" onClick={() => openDirInViewer(d.path)} title={d.path}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}><path d="M1.5 3a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .7.3l1 1H13.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3z"/></svg>
                  Open {baseName(d.path)} (directory viewer)
                </div>
                {files.slice(0, INLINE_FILE_CAP).map(it => (
                  <div key={it.path} className="tab-context-item tab-context-subitem" onClick={() => openFileInTab(it.path)} title={it.path}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}><path d="M3 1h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm6.5 0L13 4.5V13H3V1h6.5zM9 1v4h4"/></svg>
                    {it.name}
                  </div>
                ))}
                {files.length > INLINE_FILE_CAP && (
                  <div className="tab-context-item tab-context-more" onClick={() => openDirInViewer(d.path)}>
                    … +{files.length - INLINE_FILE_CAP} more
                  </div>
                )}
              </>
            )
          })()}
          <div className="tab-context-item" onClick={() => openInVSCode(d.path)}>
            <svg width="14" height="14" viewBox="0 0 100 100" fill="none" style={{ flexShrink: 0 }}><path d="M70.9 97.8l22.8-11a6.3 6.3 0 0 0 3.5-5.6V18.8a6.3 6.3 0 0 0-3.5-5.7L70.9 2.2a6.3 6.3 0 0 0-7.2 1.3L27 40.5 11.2 28.7a4.2 4.2 0 0 0-5.4.3L1.3 33.5a4.2 4.2 0 0 0 0 6.1L15 50 1.3 60.4a4.2 4.2 0 0 0 0 6.1l4.5 4.5a4.2 4.2 0 0 0 5.4.3L27 59.5l36.7 37a6.3 6.3 0 0 0 7.2 1.3zM71 75.5L45.3 50 71 24.5v51z" fill="#007ACC"/></svg>
            Open {baseName(d.path)} in VS Code
          </div>
        </div>
      ))}
      {menu.projectDir && (
        <>
          {detected.length > 0 && <div style={{ borderTop: '1px solid #3c3c3c', margin: '4px 0' }} />}
          <div className="tab-context-item" onClick={() => openInVSCode(menu.projectDir!)}>
            <svg width="14" height="14" viewBox="0 0 100 100" fill="none" style={{ flexShrink: 0 }}><path d="M70.9 97.8l22.8-11a6.3 6.3 0 0 0 3.5-5.6V18.8a6.3 6.3 0 0 0-3.5-5.7L70.9 2.2a6.3 6.3 0 0 0-7.2 1.3L27 40.5 11.2 28.7a4.2 4.2 0 0 0-5.4.3L1.3 33.5a4.2 4.2 0 0 0 0 6.1L15 50 1.3 60.4a4.2 4.2 0 0 0 0 6.1l4.5 4.5a4.2 4.2 0 0 0 5.4.3L27 59.5l36.7 37a6.3 6.3 0 0 0 7.2 1.3zM71 75.5L45.3 50 71 24.5v51z" fill="#007ACC"/></svg>
            Open project in VS Code
          </div>
        </>
      )}
      {(detected.length > 0 || menu.projectDir) && <div style={{ borderTop: '1px solid #3c3c3c', margin: '4px 0' }} />}
      <div className="tab-context-item" onClick={paste}>Paste</div>
      <div
        className="tab-context-item"
        onClick={pasteAsText}
        title="Insert the clipboard line by line as real, editable text — avoids Claude's collapsed “[Pasted text +N lines]” marker"
      >
        Paste as text
      </div>
    </div>,
    document.body
  )
}
