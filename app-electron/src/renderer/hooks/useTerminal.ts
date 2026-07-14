import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { themes } from '../themes'
import { useLayoutStore } from '../store/layout-store'
import { loadSettings } from '../components/panels/SettingsPanel'
import { bracketedPaste, getPathAtPosition, stripQuoteGutter } from '../utils/terminal-helpers'
import { copyText, readClipboard } from '../utils/clipboard'
import { getRendererAgent } from '../../../../core/agents/renderer'
import { normalizeTty, stripAnsiLower } from '../../../../core/agents/claude/patterns'
import { DEFAULT_AGENT_ID } from '../../../../core/types/contracts'

import type { AgentId } from '../../../../core/types'
import type { ScreenOpenTabMeta } from '../../../../core/types/ipc-contracts'

type RestoreMeta = ScreenOpenTabMeta

// Virtual viewport for an eager tab that launches while still hidden (display:none → no real size):
// a remote/AI-opened tab the controller drives headlessly. Big & wide so the controlled Claude formats
// its TUI with minimal wrapping → the scrollback we read back stays clean. On reveal the ResizeObserver
// refits to the real container; a never-revealed (headless) tab keeps this size for life.
const HIDDEN_COLS = 200
const HIDDEN_ROWS = 50

// Status-line detection windows (rendered screen bottom rows). The SHALLOW window holds only the
// status-line region, so the ambiguous busy markers (spinner glyph ≈ markdown bullet; "esc to
// interrupt" / token counts can occur in displayed content) are matched there and can't false-fire
// on conversation text. The WIDE window is scanned ONLY for the high-specificity elapsed-timer
// markers (`busyWide`) — those can't appear in prose — so the "✻ …thinking… (1h25m·)" line is still
// caught when a tall input box + a rotating "Tip:" line push it above the shallow window (which had
// made the tab flicker idle↔running and blinked the context nudge).
const SCREEN_TAIL_ROWS = 8
const SCREEN_TAIL_WIDE_ROWS = 16

interface UseTerminalOptions {
  terminalId: string
  screenManaged?: boolean
  restoreMeta?: RestoreMeta
  cwd?: string
  command?: string
  args?: string[]
  /** Agent hosting this PTY. Drives the TUI pattern set (toolUse / blocked regexes). */
  agent?: AgentId
  /** Gate the xterm creation + agent spawn. When `false` nothing is created — lets a restored
   *  but not-yet-visible tab defer its `claude` launch until first shown, so reopening a window
   *  with many tabs doesn't start every session at once. Flips false→true once (then sticky). */
  enabled?: boolean
  /** True when `enabled` flipped because the USER activated the tab (vs it being visible at
   *  restore). Makes the restore spawn bypass the anti-stampede gate → launches immediately. */
  interactive?: boolean
}

export function useTerminal(containerRef: React.RefObject<HTMLDivElement | null>, options: UseTerminalOptions) {
  const termRef = useRef<Terminal | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  // Re-fit trigger exposed to the panel: a SETTLED (debounced) refit to call when the tab is revealed.
  // Restores correct sizing on restore/reveal WITHOUT the reflow corruption the old eager reveal-repaint
  // caused — that one re-fit at a transient size on every reveal; this fits at the settled size and
  // resizes only on a genuine change, so a same-size reveal is a no-op.
  const refitRef = useRef<(() => void) | null>(null)

  // Renderer agent metadata, kept in refs so the long-lived terminal callbacks
  // always read the CURRENT agent's behavior. The main effect runs once
  // (keyed on terminalId) and never re-binds; `screen:update-params` can
  // change `options.agent` mid-life (a screen-managed tab resolves its
  // agent only after the menu finishes), so capturing metadata in the
  // effect closure would leave it stale. The effect below re-points the
  // ref without a costly PTY re-mount.
  const rendererAgentRef = useRef(getRendererAgent(options.agent ?? DEFAULT_AGENT_ID))
  const patternsRef = useRef(rendererAgentRef.current.ttyPatterns)
  useEffect(() => {
    const agent = getRendererAgent(options.agent ?? DEFAULT_AGENT_ID)
    rendererAgentRef.current = agent
    patternsRef.current = agent.ttyPatterns
  }, [options.agent])

  // Terminal phase, authoritative from the main process ('menu' = the CLI menu TUI owns the PTY;
  // 'running' = a live agent session). Gates the F1/F2 app-shortcut steal in the key handler below:
  // the menu binds F1/F2 itself (Search / Manage), so we must NOT hijack them while it's up. A
  // screen-managed tab STARTS in the menu; direct-command / shell tabs never show it (default false).
  const isMenuRef = useRef(!!options.screenManaged)
  useEffect(() => {
    if (!window.electronAPI?.onScreenPhase) return
    return window.electronAPI.onScreenPhase((id, phase) => {
      if (id === options.terminalId) isMenuRef.current = phase === 'menu'
    })
  }, [options.terminalId])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !window.electronAPI) return
    // Lazy launch: create nothing (no xterm, no PTY/agent spawn) until enabled. Re-runs when
    // `enabled` flips true (see dep array), so a hidden restored tab spawns on first reveal.
    if (options.enabled === false) return

    const themeId = useLayoutStore.getState().currentTheme
    const t = themes[themeId]
    const settings = loadSettings()

    const term = new Terminal({
      scrollback: settings.scrollback,
      fontSize: t.fontSize,
      fontFamily: t.fontFamily,
      theme: t.theme,
      cursorBlink: settings.cursorBlink,
      allowProposedApi: true,
      vtExtensions: { win32InputMode: true }
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)


    // ── Renderer: DOM (default) or WebGL (opt-in) ──────────────────────────────────────────────
    // xterm 6 removed the canvas renderer. Two remain:
    //  • DOM — DEFAULT. No glyph atlas; xterm lays out real text nodes. Slower in theory, but immune to
    //    the intermittent cell mis-paint the accelerated path exhibits (a char dropped/doubled/shifted
    //    on a frame — the BUFFER is correct, only the paint isn't; a refresh/selection re-paints it
    //    differently). No accelerated addon loaded → that IS the DOM renderer.
    //  • WebGL (@xterm/addon-webgl) — opt-in. Atlas in a GPU texture. Faster, but the GPU atlas can
    //    desync (driver reset, hidden→shown, context loss) → stray/garbled glyphs; onContextLoss
    //    disposes it → built-in DOM fallback.
    // Chosen in Settings → Terminal → Renderer; applies to NEWLY-opened terminals.
    // `reportRenderer` publishes the ACTUAL renderer to the layout store → status-bar OGL/DOM badge.
    const reportRenderer = (r: 'webgl' | 'dom') =>
      useLayoutStore.getState().setTerminalRenderer(options.terminalId, r)

    if (settings.terminalRenderer === 'webgl') {
      try {
        const webgl = new WebglAddon()
        // GPU context lost (driver reset, backgrounded too long, …) → dispose so xterm falls back to
        // the built-in DOM renderer instead of leaving a frozen/garbled canvas on screen.
        webgl.onContextLoss(() => { try { webgl.dispose() } catch { /* already gone */ } reportRenderer('dom') })
        term.loadAddon(webgl)
        reportRenderer('webgl')
      } catch { reportRenderer('dom') }
    } else {
      // 'dom' (default, and the fallback for any legacy stored value) — no accelerated addon.
      reportRenderer('dom')
    }

    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)

    // Only fit when the container has real dimensions. An eager-launched control/AI tab can mount
    // while still INACTIVE (dockview keeps it at display:none → 0×0); fitting then shrinks the term
    // (and the PTY, via the size passed to createTerminal below) to the ~2×2 minimum — Claude would
    // format its TUI into that and the AI would read mangled scrollback. So when hidden we instead size
    // it to a big VIRTUAL viewport (HIDDEN_COLS×HIDDEN_ROWS): the remote/AI's Claude formats wide, so
    // the scrollback we read back is clean and minimally wrapped. The ResizeObserver fits it to the
    // real container once the tab is revealed (a headless AI tab may stay at the virtual size for life).
    if (container.offsetWidth > 0 && container.offsetHeight > 0) fitAddon.fit()
    else term.resize(HIDDEN_COLS, HIDDEN_ROWS)
    termRef.current = term
    searchRef.current = searchAddon

    // Publish live geometry for the status-bar diagnostic (cols×rows next to the renderer badge).
    const reportDims = () =>
      useLayoutStore.getState().setTerminalDims(options.terminalId, term.cols, term.rows)
    reportDims()

    // Forward the size to the PTY ONLY when it actually changed. A tab reveal (display:none→block)
    // otherwise re-sends the same size and triggers a needless xterm/ConPTY reflow — which corrupts
    // wide / box-drawing / combining-char content (plain ASCII survives a reflow; special chars hit
    // xterm's reflow bug). Initial size is sent via createTerminal/restoreTerminal below.
    let lastSentCols = term.cols
    let lastSentRows = term.rows
    const syncPtySize = () => {
      if (term.cols === lastSentCols && term.rows === lastSentRows) return
      lastSentCols = term.cols
      lastSentRows = term.rows
      window.electronAPI.resizeTerminal(options.terminalId, term.cols, term.rows)
      reportDims()
    }

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    let settleTimers: ReturnType<typeof setTimeout>[] = []
    const isRestore = !!options.restoreMeta
    let firstDataNudged = false
    let lastDebugPublish = 0
    const doRefit = () => {
      // Hidden (display:none → 0×0): don't fit, or we'd shrink the PTY to the ~2×2 minimum while an
      // eager AI tab runs hidden. The ResizeObserver fires again with real dims on reveal → refit then.
      // fit() resizes xterm only on a genuine size change, so a same-size reveal is a no-op (no reflow).
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return
      fitAddon.fit()
      syncPtySize()
    }
    const debouncedRefit = () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(doRefit, 50)
    }
    refitRef.current = debouncedRefit

    const resizeObserver = new ResizeObserver(debouncedRefit)
    resizeObserver.observe(container)
    window.addEventListener('resize', debouncedRefit)


    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true
      // App shortcuts — bubble to window/menu handler
      if (ev.key === 'F11') return false
      // F1 (help) / F2 (rename session) are handled by the window keydown listener
      // (useKeyboardShortcuts). Without this, xterm maps them to a PTY escape and cancels the event,
      // so the app shortcut never fires while the terminal is focused. EXCEPTION: while the CLI menu
      // owns this PTY it binds F1/F2 itself (Search / Manage) — pass them through (fall to `return
      // true`) so they reach the menu instead of being stolen for the app.
      if ((ev.key === 'F1' || ev.key === 'F2') && !isMenuRef.current) return false
      if (ev.key === 'Tab' && ev.ctrlKey) return false
      if (ev.altKey && (ev.key === 't' || ev.key === 'n' || ev.key === 'p' || ev.key === 'u' || ev.key === 'd')) return false
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'T' || ev.key === 'F' || ev.key === 'PageUp' || ev.key === 'PageDown')) return false
      if (ev.ctrlKey && ev.key === 'f') return false
      if (ev.ctrlKey && ev.key === 'k') return false
      if (ev.ctrlKey && (ev.key === 'b' || ev.key === 't' || ev.key === 'n' || ev.key === 'w' || ev.key === 'g' || ev.key === 'h' || ev.key === 'j' || ev.key === 'o' || ev.key === 'i' || ev.key === 'p')) {
        return false
      }
      // Paste: Ctrl+V or Ctrl+Shift+V (bracketed paste mode)
      if (ev.ctrlKey && (ev.key === 'v' || ev.key === 'V')) {
        ev.preventDefault()
        void readClipboard().then((text) => bracketedPaste(options.terminalId, text))
        return false
      }
      // Copy: Ctrl+Shift+C keeps the native copy (already works). Ctrl+C copies the selection when there
      // IS one — then clears it and is swallowed so no SIGINT; a bare Ctrl+C with no selection falls
      // through to xterm → \x03 (the interrupt stays intact). A keydown is a real user gesture and the
      // selection was finalized earlier (made with the mouse before the keypress), so there's no timing
      // issue. Goes through the main-process clipboard (copyText) — navigator.clipboard silently
      // rejects in the packaged file:// build, which left the selection cleared but the clipboard stale.
      if (ev.ctrlKey && ev.shiftKey && ev.key === 'C') {
        return false
      }
      if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && (ev.key === 'c' || ev.key === 'C')) {
        const sel = term.getSelection()
        if (sel) {
          ev.preventDefault()
          void copyText(stripQuoteGutter(sel))
          term.clearSelection()
          return false
        }
        return true
      }
      // Shift+Enter inserts a prompt newline using the active agent's PTY encoding.
      if (ev.shiftKey && ev.key === 'Enter') {
        ev.preventDefault()
        const sequences = rendererAgentRef.current.promptNewlineSequences
        window.electronAPI.writeTerminal(options.terminalId, term.modes.win32InputMode ? sequences.win32InputMode : sequences.standard)
        return false
      }
      return true
    })

    // Track selection in store (used by path detection + Ctrl+O) AND copy-on-select.
    //
    // This fires only when xterm makes a LOCAL text selection — i.e. plain shells, or a Shift-drag
    // that bypasses an app's mouse tracking. While Claude runs (mouse tracking on) a drag is forwarded
    // to the app and xterm makes NO selection, so this stays silent and the OSC 52 handler below is the
    // copy path instead. Copy through the main-process clipboard (copyText/IPC — navigator.clipboard is
    // focus-gated under file://). onSelectionChange fires AFTER xterm finalizes the selection, so
    // getSelection() is correct (no xterm-6 container-mouseup off-by-one). Copy immediately (no debounce)
    // so a quick select→Ctrl+V can't beat the write; dedup by text; never clobber with an empty selection.
    let lastCopiedSel = ''
    const selDisposable = term.onSelectionChange(() => {
      const sel = term.getSelection()
      useLayoutStore.getState().setTerminalSelection(sel?.trim() ?? '')
      if (sel && sel !== lastCopiedSel) {
        lastCopiedSel = sel
        void copyText(stripQuoteGutter(sel))
      }
    })

    // OSC 52 — the REAL copy path while Claude runs. With mouse tracking on (Claude's TUI), a drag is
    // forwarded to the app, so xterm makes NO local selection (term.getSelection() stays empty → the
    // onSelectionChange copy above never fires). Claude does its own selection and emits the copy as an
    // OSC 52 escape (`ESC ] 52 ; c ; <base64> BEL`). xterm core has NO OSC 52 handler and the clipboard
    // addon isn't loaded, so without this the copy is silently dropped — and any path that DID honor it
    // (navigator.clipboard) is focus-gated under file://. We handle it ourselves and write through the
    // main-process Electron clipboard (copyText/IPC): reliable, no focus gating, no xterm selection.
    const oscDisposable = term.parser.registerOscHandler(52, (data) => {
      const semi = data.indexOf(';')
      const b64 = (semi >= 0 ? data.slice(semi + 1) : data).trim()
      if (!b64 || b64 === '?') return true // a clipboard READ/query — ignore (don't leak the clipboard back)
      try {
        const bin = atob(b64)
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
        const text = new TextDecoder().decode(bytes)
        if (text) {
          const cleaned = stripQuoteGutter(text)
          void copyText(cleaned)
          // Surface to the optional status-bar clipboard-debug widget so it can show Claude's OSC 52
          // copies landing (no-op when the widget is hidden — nothing is listening).
          window.dispatchEvent(new CustomEvent('clipboard-osc52', { detail: { text: cleaned } }))
        }
      } catch { /* malformed base64 — ignore */ }
      return true // handled — stop any default processing
    })

    // Right-click = context menu, Shift+Right-click = paste. Path-at-cursor detection lives in
    // the shared terminal-helpers (reused by the remote viewer).
    const contextMenuHandler = (e: Event) => {
      e.preventDefault()
      const me = e as MouseEvent
      if (me.shiftKey) {
        void readClipboard().then((text) => bracketedPaste(options.terminalId, text))
      } else {
        const wordAtCursor = getPathAtPosition(term, container, me.clientX, me.clientY)
        window.dispatchEvent(new CustomEvent('terminal-context-menu', {
          detail: { x: me.clientX, y: me.clientY, terminalId: options.terminalId, wordAtCursor }
        }))
      }
    }
    container.addEventListener('contextmenu', contextMenuHandler)

    // Block right-button mouse events from xterm's mouse-reporting forwarder.
    // Without this, when a TUI enables mouse tracking (e.g. Claude Code via
    // \x1b[?1000h) the pty receives the right-click before our contextmenu
    // handler runs and the TUI treats it as a paste-from-clipboard, dumping
    // the clipboard into its input prompt. Capture-phase stopPropagation
    // prevents xterm's bubble-phase listener on .xterm-screen from ever
    // seeing the event. The `contextmenu` event is separate and still fires.
    const blockRightMouse = (e: MouseEvent) => { if (e.button === 2) e.stopPropagation() }
    container.addEventListener('mousedown', blockRightMouse, true)
    container.addEventListener('mouseup', blockRightMouse, true)

    term.onData((data) => window.electronAPI.writeTerminal(options.terminalId, data))

    // Pattern set is owned by the agent adapter, threaded via the
    // terminal options. Read lazily from `patternsRef` so a mid-life
    // agent change (via screen:update-params) is reflected without a
    // PTY re-mount — see the ref-sync effect above.
    let writeBuffer = ''
    let writeRaf = 0
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let toolUseExpiryTimer: ReturnType<typeof setTimeout> | null = null
    let promptIdleTimer: ReturnType<typeof setTimeout> | null = null
    let outputBuffer = ''
    type Status = 'idle' | 'running' | 'tool-use' | 'blocked' | 'waiting' | 'done'
    let currentStatus: Status = 'idle'
    let currentBgShell = false

    const setStatus = (status: Status) => {
      if (currentStatus === status) return
      currentStatus = status
      // Level-triggered source of truth: a tab header that mounts/remounts after this point reads the
      // CURRENT status from the store rather than missing the one-shot event below (which fires only on
      // change). This is what kept the dot grey on a working tab after a resize / during a long turn.
      useLayoutStore.getState().setTerminalStatus(options.terminalId, status)
      window.dispatchEvent(new CustomEvent('terminal-status', {
        detail: { id: options.terminalId, status }
      }))
      // backwards compat for useTaskNotifications: "active" means Claude is
      // doing something the user might want to be notified about completing.
      window.dispatchEvent(new CustomEvent('terminal-activity', {
        detail: {
          id: options.terminalId,
          active: status === 'running' || status === 'tool-use' || status === 'blocked' || status === 'waiting',
        }
      }))
    }

    // Busy = the turn is still working. An agent can expose TWO markers: `busy` (status-line text,
    // matched on the whitespace-COLLAPSED tail — esc-to-interrupt / token counter / elapsed timer,
    // which wrap across the width so collapsing reassembles them) and `busySpaced` (Claude's spinner
    // "<glyph> <one-word>…", matched on the SPACE-PRESERVED tail — collapsing would make it look like
    // prose). EITHER one present ⇒ working. `hasBusyMarker` = does this agent classify by busy at all
    // (Codex doesn't → keep the prior always-'running' behavior).
    const hasBusyMarker = () => !!(patternsRef.current.busy || patternsRef.current.busySpaced)

    // Read the RENDERED bottom rows of the xterm grid — where Claude's status line ("✶ Drizzling…
    // (28s · …)") always sits. This is the ROBUST detection source: the raw PTY byte stream only
    // carries the status line in full when Claude redraws it whole, but its TUI updates the spinner
    // DIFFERENTIALLY (cursor-addressed glyph/second swaps), so the raw tail often holds only fragments
    // and the markers fall off → false idle. xterm reconstructs the full current screen regardless, so
    // the bottom rows reliably contain the whole status line. (baseY-relative so it reads the live
    // bottom even if the user scrolled up.)
    const readScreenTail = (rows: number = SCREEN_TAIL_ROWS): string => {
      try {
        const buf = term.buffer.active
        const bottom = buf.baseY + term.rows
        const out: string[] = []
        for (let y = Math.max(0, bottom - rows); y < bottom; y++) {
          const line = buf.getLine(y)
          if (line) out.push(line.translateToString(true))
        }
        return out.join('\n')
      } catch { return '' }
    }

    // Working = a busy marker is present in EITHER the raw recent tail OR the rendered screen bottom
    // (OR can only catch MORE work; the idle prompt has no markers, so idle still resolves correctly).
    const isBusy = (recent: string) => {
      const p = patternsRef.current
      const screen = readScreenTail()
      if (p.busy && (p.busy.test(normalizeTty(recent)) || p.busy.test(normalizeTty(screen)))) return true
      if (p.busySpaced && (p.busySpaced.test(stripAnsiLower(recent)) || p.busySpaced.test(stripAnsiLower(screen)))) return true
      // Deep scan for the high-specificity elapsed-timer markers only (safe further up): catches the
      // spinner status line during long "thinking" turns when it's pushed above the shallow window.
      if (p.busyWide && p.busyWide.test(normalizeTty(readScreenTail(SCREEN_TAIL_WIDE_ROWS)))) return true
      return false
    }

    // Busy check for the IDLE direction — trust ONLY the rendered screen bottom, never the raw tail.
    // `outputBuffer` keeps a whole turn's history (cleared only on a confirmed idle), so a finished
    // turn's last "esc to interrupt" status line LINGERS in it. OR-ing that raw tail (`isBusy`) kept
    // the tab stuck on 'running' after the turn ended: the marker stayed inside the 2000-char window
    // (a short recap printed after it isn't enough to push it out) while the live screen already showed
    // the idle prompt. (The det widget reads a shorter raw window that had already dropped it → it
    // showed scr[—] raw[—] while the tab still said 'running' — that exact mismatch.) The idle checks
    // run ≥1.2s after the last byte, so the screen is fully settled here: current AND stale-free.
    // Running detection (`reclassifyFromOutput`) keeps `isBusy`'s raw OR for frame-immediate response.
    const isBusyScreen = () => {
      const p = patternsRef.current
      const screen = readScreenTail()
      if (screen) {
        if (p.busy && p.busy.test(normalizeTty(screen))) return true
        if (p.busySpaced && p.busySpaced.test(stripAnsiLower(screen))) return true
      }
      // Deep scan for the elapsed-timer markers only — keeps a long "thinking" turn from arming the
      // fast idle edge (and flipping the tab to idle) when the status line sits above the shallow window.
      if (p.busyWide) {
        const wide = readScreenTail(SCREEN_TAIL_WIDE_ROWS)
        if (wide && p.busyWide.test(normalizeTty(wide))) return true
      }
      return false
    }

    // Background-shell indicator — ORTHOGONAL to the turn status. Claude's footer shows a live
    // "N shell" count while a `Bash(run_in_background)` task is still executing; it disappears at 0.
    // The footer always sits in the rendered bottom rows, so scan the same screen tail (never the raw
    // buffer, which lingers a stale count after the shell exits). Published to the store only on
    // change (dedup) — CustomTab/TabListPanel show a muted pulsing dot when an IDLE tab has one, so a
    // finished turn that left a shell alive (or hung) is visible. Kept off the busy markers on purpose:
    // a running shell is not the agent working, so it must NOT flip the tab to 'running'.
    const publishBgShell = () => {
      const p = patternsRef.current
      const on = !!p.bgShell && p.bgShell.test(readScreenTail().toLowerCase())
      if (on === currentBgShell) return
      currentBgShell = on
      useLayoutStore.getState().setBgShell(options.terminalId, on)
    }

    // Re-classify based on recent output. Called on every data chunk so
    // blocked-prompts and tool-calls surface immediately rather than after
    // the 15s silence timer.
    const reclassifyFromOutput = () => {
      const recent = outputBuffer.slice(-2000)
      const norm = normalizeTty(recent)
      if (patternsRef.current.blocked.some(p => p.test(recent))) {
        setStatus('blocked')
        return
      }
      // Interactive question menu (AskUserQuestion / plan approval) → the turn paused for
      // the user to pick something. Checked after `blocked` so y/n permission menus stay red.
      const menu = patternsRef.current.questionMenu
      if (menu && menu.test(norm)) {
        setStatus('waiting')
        return
      }
      if (patternsRef.current.toolUse.test(recent)) {
        setStatus('tool-use')
        // Tool calls finish on their own; revert to 'running' if more text
        // streams in without another tool marker.
        if (toolUseExpiryTimer) clearTimeout(toolUseExpiryTimer)
        toolUseExpiryTimer = setTimeout(() => {
          if (currentStatus === 'tool-use') setStatus('running')
        }, 3000)
        return
      }
      // If the agent classifies by a busy marker and NONE is present, the turn finished (only the
      // redrawn idle prompt remains). Don't re-assert 'running' on those post-turn redraws —
      // otherwise the fast idle edge flickers idle→running. `isBusy` checks both the collapsed
      // status-line markers and the space-preserved spinner glyph. Agents with no busy marker keep
      // the prior always-'running' behavior.
      if (hasBusyMarker() && !isBusy(recent)) return
      setStatus('running')
    }

    const checkSilence = () => {
      const text = outputBuffer.slice(-2000)
      const norm = normalizeTty(text)
      if (patternsRef.current.blocked.some(p => p.test(text))) {
        setStatus('blocked')
        return
      }
      const menu = patternsRef.current.questionMenu
      if (menu && menu.test(norm)) {
        setStatus('waiting')
        return
      }
      // Re-check busy at FIRE time (not arm time) on the SETTLED SCREEN (not the stale raw buffer):
      // a big diff burst can momentarily push the markers out of the window and arm the 1.2s timer,
      // but by fire time the next status-line redraw has landed → still working, so don't flip to idle.
      // Using the screen (not raw) is what stops a finished turn's lingering "esc to interrupt" in
      // `outputBuffer` from re-asserting 'running' here and wedging the tab.
      if (isBusyScreen()) {
        setStatus('running')
        return
      }
      setStatus('idle')
      outputBuffer = ''
      // Settled-screen recheck: guarantees the bg-shell dot converges even if Claude goes fully
      // quiescent after the last shell exits (no idle repaint to re-trigger the data-path publish).
      publishBgShell()
    }

    const flushBuffer = () => {
      if (writeBuffer) {
        term.write(writeBuffer)
        writeBuffer = ''
      }
      writeRaf = 0
    }
    const removeDataListener = window.electronAPI.onTerminalData((id, data) => {
      if (id !== options.terminalId) return
      writeBuffer += data
      outputBuffer += data

      // First output from a RESTORED terminal → Claude is alive and has drawn its TUI. It likely missed
      // the early resize SIGWINCH while still starting up, and the grid never changes again, so node-pty
      // emits no further SIGWINCH and Claude stays anchored to its spawn size (input mid-screen, empty
      // rows below) until a MANUAL resize. Once it's emitting, nudge the pty by one row and back — a real
      // size change it now processes → it re-anchors to the full terminal height. xterm is untouched (no
      // flicker). Fires once.
      if (isRestore && !firstDataNudged && term.rows > 2 && container.offsetHeight > 0) {
        firstDataNudged = true
        settleTimers.push(
          setTimeout(() => {
            if (disposed || !termRef.current) return
            const c = term.cols
            const r = term.rows
            window.electronAPI.resizeTerminal(options.terminalId, c, r - 1)
            window.electronAPI.resizeTerminal(options.terminalId, c, r)
          }, 200),
        )
      }
      // Bound the classification buffer — all status tests slice the last 2000 chars, and
      // it's no longer cleared on every silence check (only on a confirmed idle), so cap it
      // to keep a long continuous turn from growing the string without limit.
      if (outputBuffer.length > 8000) outputBuffer = outputBuffer.slice(-8000)
      if (!writeRaf) writeRaf = requestAnimationFrame(flushBuffer)

      // Immediate reclassification: blocked-prompts and tool calls surface
      // on the same data chunk that brings them in. The 15s silence timer
      // is only the fallback that flips `running` → `idle` when Claude
      // stops streaming (extended thinking ≤ 15s is intentionally tolerated).
      reclassifyFromOutput()
      publishBgShell()
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(checkSilence, 15000)

      // Fast idle edge: once the agent's "busy" marker (e.g. "esc to interrupt") is gone — turn
      // finished, only the ready prompt remains — a short quiet means done, so flip to idle without
      // waiting out the 15s fallback. ARM ONCE and DON'T reset it on later chunks: Claude's idle
      // input box keeps re-emitting frames (cursor blink / redraw) under 1.2s apart, so a per-chunk
      // reset meant the timer never fired and the tab stuck on 'running'. Cancel only when the busy
      // marker reappears (work resumed). While busy is present, no timer is armed → full tolerance.
      const busyAbsent = hasBusyMarker() && !isBusyScreen()
      if (busyAbsent) {
        if (!promptIdleTimer && currentStatus !== 'idle') {
          promptIdleTimer = setTimeout(() => { promptIdleTimer = null; checkSilence() }, 1200)
        }
      } else if (promptIdleTimer) {
        clearTimeout(promptIdleTimer)
        promptIdleTimer = null
      }

      // Work-detection status-bar widget: when it's open, publish BOTH detection inputs (throttled
      // ~150ms, gated on the store flag → zero cost when off): the SPACE-PRESERVED raw tail
      // (stripAnsiLower — keeps the spinner's "<glyph> <word>…" structure; matchBusy derives the
      // collapsed form from it) AND the rendered screen bottom rows (the robust source). So the
      // widget shows exactly what each source contributes to the verdict.
      if (useLayoutStore.getState().detectionDebug) {
        const now = Date.now()
        if (now - lastDebugPublish >= 150) {
          lastDebugPublish = now
          useLayoutStore.getState().setTerminalDebug(options.terminalId, stripAnsiLower(outputBuffer.slice(-600)), readScreenTail(), now)
        }
      }
    })

    const removeExitListener = window.electronAPI.onTerminalExit((id, code) => {
      if (id === options.terminalId) {
        term.writeln(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m`)
        if (idleTimer) clearTimeout(idleTimer)
        if (toolUseExpiryTimer) clearTimeout(toolUseExpiryTimer)
        if (promptIdleTimer) clearTimeout(promptIdleTimer)
        // Process gone → no shells left; drop the bg-shell dot (the footer that carried the count
        // is gone too, so nothing would clear it otherwise).
        currentBgShell = false
        useLayoutStore.getState().setBgShell(options.terminalId, false)
        setStatus('done')
        setTimeout(() => setStatus('idle'), 3000)
      }
    })

    const removeRefitListener = window.electronAPI.onScreenRefit?.((id) => {
      if (id === options.terminalId) {
        term.clear()
        doRefit()
      }
    })

    if (options.restoreMeta) {
      window.electronAPI.restoreTerminal(options.terminalId, options.restoreMeta, options.interactive)
    } else if (options.screenManaged) {
      window.electronAPI.createScreenTerminal(options.terminalId, {
        cols: term.cols,
        rows: term.rows
      })
    } else {
      window.electronAPI.createTerminal(options.terminalId, {
        cols: term.cols,
        rows: term.rows,
        cwd: options.cwd,
        command: options.command,
        args: options.args
      })
    }

    term.focus()
    // Restore/initial mount can fit at a transient (collapsed) container size before dockview settles
    // the layout; schedule a settled refit so the grid grows to fill the panel (the ResizeObserver alone
    // proved unreliable for this on restore). Debounced + resize-only-on-change → no spurious reflow.
    debouncedRefit()

    return () => {
      disposed = true
      settleTimers.forEach(clearTimeout)
      if (writeRaf) cancelAnimationFrame(writeRaf)
      if (idleTimer) clearTimeout(idleTimer)
      if (toolUseExpiryTimer) clearTimeout(toolUseExpiryTimer)
      if (promptIdleTimer) clearTimeout(promptIdleTimer)
      if (resizeTimer) clearTimeout(resizeTimer)
      removeDataListener()
      removeExitListener()
      removeRefitListener?.()
      selDisposable.dispose()
      oscDisposable.dispose()
      resizeObserver.disconnect()
      window.removeEventListener('resize', debouncedRefit)
      container.removeEventListener('contextmenu', contextMenuHandler)
      container.removeEventListener('mousedown', blockRightMouse, true)
      container.removeEventListener('mouseup', blockRightMouse, true)
      window.electronAPI.destroyTerminal(options.terminalId)
      useLayoutStore.getState().clearTerminalRenderer(options.terminalId)
      term.dispose()
      termRef.current = null
      searchRef.current = null
      refitRef.current = null
    }
  }, [options.terminalId, options.enabled])

  return { searchRef, termRef, refitRef }
}
