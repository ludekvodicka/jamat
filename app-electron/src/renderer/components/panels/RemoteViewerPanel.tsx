import { IDockviewPanelProps } from 'dockview'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { RemotePeer, RemoteWindowInfo, WsServerMsg } from '../../../../../core/types/remote-control'
import { openPeerFile, openPeerChanges, getPathAtPosition, resolveTerminalPath } from '../../utils/terminal-helpers'
import { TerminalPromptSubmitter } from '../../utils/terminalPromptSubmitter'
import { useLayoutStore } from '../../store/layout-store'
import { NotesPanel } from './NotesPanel'
import { RecentFilesPanel } from './RecentFilesPanel'

/**
 * Full-window live viewer for ONE remote tab. Opened from RemoteConnectionsPanel
 * (one per peer+terminal), never from the tab picker — it needs a {peer,
 * terminalId} param the picker can't supply. Streams the remote tab over a WS and
 * forwards keystrokes back, so it's an interactive remote terminal — typed natively
 * into the focused xterm, exactly like a local tab (no separate control bar).
 */
interface RemoteViewerParams {
  peer: RemotePeer
  terminalId: string
}

export function RemoteViewerPanel({ params, api }: IDockviewPanelProps<RemoteViewerParams>) {
  const peer = params.peer
  const terminalId = params.terminalId
  const wrapRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const streamIdRef = useRef<string | null>(null)
  const [ended, setEnded] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // The remote tab's launch cwd (= projectDir) + Claude session id, resolved from the peer's
  // window tree — needed to open the peer's file viewer / session-changes / notes for this tab.
  // The ref mirrors the state so the (once-registered) xterm key handler reads live values.
  const [tabMeta, setTabMeta] = useState<{ cwd?: string; sessionId?: string }>({})
  const tabMetaRef = useRef<{ cwd?: string; sessionId?: string }>({})
  // The resolved absolute path under the cursor IF it is a real file on the peer (gated via
  // control:file-type) — drives whether the "Open file" menu item appears.
  const [openableFile, setOpenableFile] = useState<string | null>(null)
  // Right-side Notes sidebar INSIDE the viewer (Ctrl+G toggle) — mirrors the local terminal's
  // in-panel notes sidebar instead of opening a separate tab.
  const [sidebarVisible, setSidebarVisible] = useState(false)

  // Open the peer-backed File-Changes panel for THIS remote tab (Ctrl+J / menu). Reads cwd/sessionId
  // from the ref + the live global dock api, so it works both from the menu and from the xterm key
  // handler (registered once, would otherwise close over stale state). Mirrors the LOCAL Ctrl+J.
  const openPeerChangesHere = () => {
    const dock = useLayoutStore.getState().dockviewApi
    const meta = tabMetaRef.current
    if (dock && meta.cwd) openPeerChanges(dock, peer, meta.cwd, meta.sessionId, peer.name || 'session')
  }

  useEffect(() => {
    if (!peer || !terminalId || !viewerRef.current) return
    setEnded(false)
    const term = new Terminal({ scrollback: 8000, fontSize: 13, convertEol: false, cursorBlink: true, vtExtensions: { win32InputMode: true } })
    term.open(viewerRef.current)
    termRef.current = term


    // Reserved app shortcuts must drive the LOCAL app, not the remote PTY: return
    // false so the event bubbles to the global keyboard handler. Notably Ctrl+W
    // closes THIS viewer tab locally and leaves the remote tab running (close the
    // remote tab explicitly via the control bar). Everything else goes to the peer.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true
      if (ev.key === 'F11') return false
      if (ev.key === 'Tab' && ev.ctrlKey) return false
      if (ev.altKey && (ev.key === 't' || ev.key === 'n' || ev.key === 'p' || ev.key === 'u' || ev.key === 'd')) return false
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'T' || ev.key === 'PageUp' || ev.key === 'PageDown')) return false
      if (ev.ctrlKey && !ev.shiftKey && (ev.key === 'k' || ev.key === 'b' || ev.key === 't' || ev.key === 'n' || ev.key === 'w' || ev.key === 'h' || ev.key === 'o' || ev.key === 'i' || ev.key === 'p')) return false
      // Ctrl+J → peer File Changes (a dockview panel, as locally); Ctrl+G → toggle the in-viewer
      // Notes sidebar on the right (as the local terminal does, not a separate tab). Both peer-
      // backed. Handle here and STOP propagation so the global shortcut handler doesn't ALSO drive
      // this machine's local panels.
      if (ev.ctrlKey && !ev.shiftKey && ev.key === 'j') {
        ev.preventDefault(); ev.stopPropagation()
        openPeerChangesHere()
        return false
      }
      if (ev.ctrlKey && !ev.shiftKey && ev.key === 'g') {
        ev.preventDefault(); ev.stopPropagation()
        setSidebarVisible((v) => !v)
        return false
      }
      // Shift+Enter / Alt+Enter → insert a newline in the remote Claude Code prompt
      // (plain Enter still submits). xterm encodes both as a bare \r (= submit), so we
      // intercept and send the CSI-u sequence instead — same as the local terminal.
      if ((ev.shiftKey || ev.altKey) && ev.key === 'Enter') {
        ev.preventDefault()
        if (streamIdRef.current) window.electronAPI?.remoteStreamSendKeys?.(streamIdRef.current, '\x1b[13;2u')
        return false
      }
      // Ctrl+V / Ctrl+Shift+V → bracketed paste into the remote PTY (the clipboard lives on
      // THIS machine, so xterm's own paste can't reach it over the stream — we read it here).
      if (ev.ctrlKey && (ev.key === 'v' || ev.key === 'V')) {
        ev.preventDefault()
        navigator.clipboard.readText().then((text) => {
          if (text && streamIdRef.current) window.electronAPI?.remoteStreamSendKeys?.(streamIdRef.current, `\x1b[200~${text}\x1b[201~`)
        })
        return false
      }
      // Ctrl+C copies the local selection when there is one (Ctrl+Shift+C always copies);
      // a bare Ctrl+C with no selection falls through to xterm → \x03 (SIGINT to the remote).
      if (ev.ctrlKey && (ev.key === 'c' || ev.key === 'C')) {
        const sel = term.getSelection() ?? ''
        if (ev.shiftKey || sel) {
          ev.preventDefault()
          if (sel) { void navigator.clipboard.writeText(sel); term.clearSelection() }
          return false
        }
        return true
      }
      return true
    })

    // Right-click opens a menu (Open file / Session changes / Paste); Shift+Right-click pastes
    // immediately (power-user shortcut). The detected path lives on the REMOTE machine, so it is
    // opened via the peer file ops (read-only, path-scoped server-side) — never the local FS. The
    // clipboard is read on THIS machine and streamed as a bracketed paste so the remote TUI treats
    // it as pasted text, not typed Enter-submits.
    const mouseHost = viewerRef.current
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      if (e.shiftKey) {
        navigator.clipboard.readText().then((text) => {
          if (text && streamIdRef.current) window.electronAPI?.remoteStreamSendKeys?.(streamIdRef.current, `\x1b[200~${text}\x1b[201~`)
        })
      } else {
        const path = getPathAtPosition(term, mouseHost, e.clientX, e.clientY)
        setMenu({ x: e.clientX, y: e.clientY, path })
      }
    }
    // Block the right mouse button from xterm's mouse-reporting forwarder: when the remote TUI
    // enables mouse tracking, xterm would otherwise stream the right-click to the remote, which
    // pastes the REMOTE machine's clipboard. Capture-phase stopPropagation keeps it local; the
    // contextmenu event still fires. Same guard as the local terminal.
    const blockRightMouse = (e: MouseEvent) => { if (e.button === 2) e.stopPropagation() }
    mouseHost.addEventListener('contextmenu', onContextMenu)
    mouseHost.addEventListener('mousedown', blockRightMouse, true)
    mouseHost.addEventListener('mouseup', blockRightMouse, true)

    // "Fit to window": mirror the REMOTE's grid (never resize the remote — it's owned by the
    // controlled machine; imposing our size starts a size war and reflows its live TUI). We size
    // the local xterm to the remote's reported cols/rows and scale the FONT so that exact grid
    // fills the available pane, centered. So the viewer always shows the whole remote screen with
    // no black filler, just a larger/smaller font for a smaller/denser remote.
    let remoteCols = 0, remoteRows = 0
    const applySize = () => {
      const wrap = wrapRef.current
      if (!wrap) return
      const cw = wrap.clientWidth, ch = wrap.clientHeight
      // Current cell px at the current font (xterm's measured monospace cell). Font-invariant
      // ratios k = cell/font let us solve for the font that makes the remote grid fill the pane.
      const cell = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core?._renderService?.dimensions?.css?.cell
      const curFont = term.options.fontSize || 13
      if (remoteCols >= 1 && remoteRows >= 1 && cw > 0 && ch > 0 && cell && cell.width > 0 && cell.height > 0) {
        const kw = cell.width / curFont, kh = cell.height / curFont
        // Largest font that keeps both axes within the pane; floor to 0.5 so rounding can't overflow.
        let f = Math.min(cw / (remoteCols * kw), ch / (remoteRows * kh))
        f = Math.max(5, Math.min(40, Math.floor(f * 2) / 2))
        if (f !== curFont) term.options.fontSize = f
        if (term.cols !== remoteCols || term.rows !== remoteRows) term.resize(remoteCols, remoteRows)
      }
    }
    requestAnimationFrame(() => { applySize(); try { term.focus() } catch { /* ignore */ } })
    let resizeRaf = 0
    const ro = new ResizeObserver(() => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(applySize) })
    ro.observe(wrapRef.current!)
    const offActive = api.onDidActiveChange(({ isActive }) => { if (isActive) { applySize(); try { term.focus() } catch { /* ignore */ } } })
    const offDims = api.onDidDimensionsChange(() => applySize())

    // streamId generated here so the frame listener is attached BEFORE the stream
    // opens (the snapshot is sent on WS open and must not be missed) and stays
    // correlated for keystroke routing.
    const streamId = crypto.randomUUID()
    streamIdRef.current = streamId
    const unregisterPromptSubmitter = TerminalPromptSubmitter.register(api.id, {
      write: (data) => window.electronAPI?.remoteStreamSendKeys?.(streamId, data),
      isWin32InputMode: () => term.modes.win32InputMode,
    })
    let disposed = false

    // Keystrokes typed in the focused terminal → remote PTY (xterm encodes arrows
    // \x1b[A…, Enter \r, Ctrl-C \x03, etc.). Remote echoes back over the stream.
    // Forward keystrokes AND the wheel (so the remote TUI scrolls), but DROP mouse BUTTON/DRAG/
    // RELEASE reports — our pointer must not click or select on the controlled machine, or a plain
    // drag would drive the remote app and clobber the REMOTE user's clipboard while they work. xterm
    // emits wheel reports (SGR/legacy) in whatever encoding the remote requested, or cursor keys
    // under alternate-scroll — all of those carry the scroll and pass; only the wheel bit (0x40)
    // distinguishes a wheel report from a click/drag, so we forward iff that bit is set.
    const isNonWheelMouseReport = (d: string): boolean => {
      const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(d) // SGR (?1006): \x1b[<btn;x;y M|m
      if (sgr) return (Number(sgr[1]) & 64) === 0
      if (d.startsWith('\x1b[M') && d.length >= 6) return ((d.charCodeAt(3) - 32) & 64) === 0 // legacy
      return false
    }
    const onKeyDisp = term.onData((d) => {
      if (isNonWheelMouseReport(d)) return
      window.electronAPI?.remoteStreamSendKeys?.(streamId, d)
    })

    // Copy-on-select: mirror the xterm selection into THIS machine's clipboard as it changes, so
    // selecting text in the remote view is immediately available to paste locally (no extra Ctrl+C).
    const onSelDisp = term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (sel) void navigator.clipboard.writeText(sel)
    })

    // On end, also stop the terminal from emitting keystrokes (disableStdin) so
    // typing into a dead viewer can't fire onData (the buttons are already gated).
    const markEnded = () => { setEnded(true); try { term.options.disableStdin = true } catch { /* ignore */ } }

    // Re-enable input once the stream proves live again. The controlled side RE-SPAWNS the SAME
    // terminalId on a menu→Claude launch: the menu PTY exits (an 'exit' frame → markEnded) and
    // Claude spawns under the same id with the subscription intact, so data resumes. Without this,
    // that transient exit left the viewer permanently unable to type until you closed & reopened it.
    const reviveIfLive = () => {
      if (term.options.disableStdin) { try { term.options.disableStdin = false } catch { /* ignore */ } setEnded(false) }
    }

    const removeFrame = window.electronAPI!.onRemoteStreamFrame((sid: string, msg: WsServerMsg) => {
      if (sid !== streamId) return
      if (msg.type === 'snapshot') {
        // Adopt the remote's grid and refit the font so it fills the pane, then paint the snapshot.
        // The RAF retry covers the first snapshot arriving before xterm has measured its cell px.
        remoteCols = msg.cols; remoteRows = msg.rows
        applySize()
        requestAnimationFrame(applySize)
        term.reset()
        term.write(msg.data)
        if (msg.alive) reviveIfLive(); else markEnded()
      } else if (msg.type === 'data') {
        reviveIfLive() // a respawned PTY (menu→Claude) streams data under the same id — input is live again
        term.write(msg.delta)
      } else if (msg.type === 'resize') {
        // The controlled window changed its own terminal size — mirror the new grid and refit font.
        remoteCols = msg.cols; remoteRows = msg.rows
        applySize()
      } else if (msg.type === 'exit' || msg.type === 'error') {
        markEnded()
      }
    })

    void (async () => {
      const r = await window.electronAPI?.remoteStreamOpen?.(peer, terminalId, streamId)
      if (disposed) return
      if (!r?.ok) markEnded()
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(resizeRaf)
      ro.disconnect()
      offActive.dispose()
      offDims.dispose()
      onKeyDisp.dispose()
      onSelDisp.dispose()
      mouseHost.removeEventListener('contextmenu', onContextMenu)
      mouseHost.removeEventListener('mousedown', blockRightMouse, true)
      mouseHost.removeEventListener('mouseup', blockRightMouse, true)
      removeFrame()
      unregisterPromptSubmitter()
      window.electronAPI?.remoteStreamClose?.(streamId)
      streamIdRef.current = null
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peer?.id, terminalId])

  // Close the context menu on an outside click or Escape (only wired while it's open).
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [menu])

  // Resolve this viewer's tab to its launch cwd + Claude session id from the peer's window tree,
  // so the open-file / changes affordances know where to read. Stale-guarded against peer/tab swap.
  useEffect(() => {
    if (!peer || !terminalId) return
    let cancelled = false
    void (async () => {
      const r = await window.electronAPI?.remoteWindows?.(peer)
      if (cancelled || !r?.ok) return
      const tab = (r.windows ?? []).flatMap((w: RemoteWindowInfo) => w.tabs).find((t) => t.terminalId === terminalId)
      if (tab) { const meta = { cwd: tab.cwd, sessionId: tab.sessionId }; tabMetaRef.current = meta; setTabMeta(meta) }
    })()
    return () => { cancelled = true }
  }, [peer?.id, terminalId])

  // When the menu opens on a path, resolve it against the remote tab's cwd and gate it through
  // control:file-type (path-scoped server-side) — only a real *file* unlocks the "Open file" item.
  useEffect(() => {
    setOpenableFile(null)
    const raw = menu?.path
    if (!raw) return
    const resolved = resolveTerminalPath(raw, tabMeta.cwd ?? null)
    if (!resolved) return
    let cancelled = false
    void (async () => {
      const r = await window.electronAPI?.remoteOp?.(peer, 'control:file-type', [resolved])
      if (cancelled) return
      if (r?.ok && r.data === 'file') setOpenableFile(resolved)
    })()
    return () => { cancelled = true }
  }, [menu, tabMeta.cwd, peer])

  // Paste the clipboard into the remote PTY as one bracketed paste.
  const pasteToRemote = () => {
    setMenu(null)
    const sid = streamIdRef.current
    if (!sid) return
    navigator.clipboard.readText().then((text) => {
      if (text) window.electronAPI?.remoteStreamSendKeys?.(sid, `\x1b[200~${text}\x1b[201~`)
      try { termRef.current?.focus() } catch { /* ignore */ }
    })
  }

  // Paste as real, editable text: stream the clipboard line by line, each as its own tiny
  // bracketed paste carrying a literal in-paste \n, so a large blob lands as actual lines
  // instead of Claude's collapsed "[Pasted text +N lines]" marker. Mirrors pasteAsTextByLines,
  // but routed over the remote stream instead of the local writeTerminal.
  const pasteAsTextToRemote = () => {
    setMenu(null)
    const sid = streamIdRef.current
    if (!sid) return
    navigator.clipboard.readText().then((text) => {
      if (!text) return
      const lines = text.split(/\r?\n/)
      let i = 0
      const step = () => {
        if (i >= lines.length) return
        const isLast = i === lines.length - 1
        window.electronAPI?.remoteStreamSendKeys?.(sid, `\x1b[200~${isLast ? lines[i] : lines[i] + '\n'}\x1b[201~`)
        i++
        if (i < lines.length) setTimeout(step, 10)
      }
      step()
      try { termRef.current?.focus() } catch { /* ignore */ }
    })
  }

  // Open the file under the cursor (already gated to a real file) in a read-only peer FileViewer.
  // Uses the GLOBAL dockview api (the panel-scoped `api` prop can't add sibling panels).
  const openFileFromMenu = () => {
    setMenu(null)
    const dock = useLayoutStore.getState().dockviewApi
    if (dock && openableFile) openPeerFile(dock, peer, openableFile, tabMeta.cwd)
  }

  // Open the peer-backed "File Changes" side panel for this remote session (same panel a local
  // session has), pinned to the tab's cwd + session id. Same action as Ctrl+J.
  const openChangesFromMenu = () => {
    setMenu(null)
    openPeerChangesHere()
  }

  // The viewer is a pure terminal — type straight into it like a local tab. A small overlay
  // only appears when the remote stream ends (the terminal stops accepting input).
  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div
        ref={wrapRef}
        style={{ position: 'relative', flex: 1, minWidth: 0, height: '100%', background: '#000', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onClick={() => termRef.current?.focus()}
      >
        {/* The xterm host shrink-wraps to its grid and is centered, so the unavoidable
            aspect-ratio remainder letterboxes symmetrically. */}
        <div ref={viewerRef} />
        {ended && (
          <div style={{ position: 'absolute', top: 6, right: 8, fontSize: 11, color: '#d29922', background: '#161616cc', padding: '2px 6px', borderRadius: 4, pointerEvents: 'none' }}>
            stream ended
          </div>
        )}
      </div>
      {/* Right-side Notes sidebar (Ctrl+G) — peer-backed, keyed by the remote tab's cwd so it
          shares the same notes store as the peer's standalone Notes tab. Mirrors the local
          terminal's in-panel notes sidebar instead of opening a separate dockview tab. */}
      {sidebarVisible && (
        <div className="panel-sidebar-right">
          <div className="sidebar-section sidebar-section-grow">
            <div className="sidebar-section-header">
              🗒 Notes
              <span style={{ float: 'right', cursor: 'pointer', opacity: 0.7 }} title="Close (Ctrl+G)" onClick={() => setSidebarVisible(false)}>×</span>
            </div>
            <NotesPanel panelId={tabMeta.cwd ?? `viewer:${terminalId}`} peer={peer} visible />
          </div>
          {/* Recent Files for the remote tab's project (peer-backed) — matches the local sidebar's
              bottom section; clicking a file opens it read-only in the peer FileViewer. */}
          {tabMeta.cwd && (
            <div className="sidebar-section sidebar-section-files">
              <RecentFilesPanel projectDir={tabMeta.cwd} peer={peer} />
            </div>
          )}
        </div>
      )}
      {menu && createPortal(
        <div ref={menuRef} className="tab-context-menu" style={{ left: menu.x, top: menu.y }}>
          {openableFile && (
            <div className="tab-context-item" onClick={openFileFromMenu} title={openableFile}>
              Open {openableFile.replace(/^.*[/\\]/, '')}
            </div>
          )}
          {tabMeta.cwd && (
            <div className="tab-context-item" onClick={openChangesFromMenu} title="Open this remote session's modified files + diffs (read-only)">
              📝 Session changes
            </div>
          )}
          {(openableFile || tabMeta.cwd) && <div style={{ borderTop: '1px solid #3c3c3c', margin: '4px 0' }} />}
          <div className="tab-context-item" onClick={pasteToRemote}>Paste</div>
          <div
            className="tab-context-item"
            onClick={pasteAsTextToRemote}
            title="Insert the clipboard line by line as real, editable text — avoids Claude's collapsed “[Pasted text +N lines]” marker"
          >
            Paste as text
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
