import { IDockviewPanelProps } from 'dockview'
import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useTerminal } from '../../hooks/useTerminal'
import { CrashBanner } from '../CrashBanner'
import { ContextWarningOverlay } from '../ContextWarningOverlay'
import { useLayoutStore } from '../../store/layout-store'
import { NotesPanel } from './NotesPanel'
import { RecentFilesPanel } from './RecentFilesPanel'
import { themes } from '../../themes'
import { bracketedPaste, openFileChangesPanel, openSessionHistoryPanel } from '../../utils/terminal-helpers'
import '@xterm/xterm/css/xterm.css'

import type { AgentId } from '../../../../../core/types'
import type { ScreenOpenTabMeta } from '../../../../../core/types/ipc-contracts'
import type { Terminal } from '@xterm/xterm'

/**
 * Scrape the text the user has typed (but not sent) in the Claude Code prompt — the rounded
 * input box (╭ │ > … │ ╰) drawn at the bottom of the terminal. We have no access to the TUI's
 * own input buffer, so we read it off the rendered screen (xterm viewport):
 *   - find the bottom (╰…╯) and top (╭…╮) borders of the lowest box,
 *   - strip the │ side borders and the leading "> " prompt marker,
 *   - join the content rows (a long line wrapped across rows rejoins with a newline — we can't
 *     tell soft-wrap from a real newline, acceptable for an import-to-notes helper).
 * Returns '' when the box is empty or shows only the dim placeholder (so we never import that).
 */
/** Read the visible viewport rows, bottom-anchored. */
function viewportRows(term: Terminal): string[] {
  const buf = term.buffer.active
  const rows: string[] = []
  for (let y = buf.baseY; y < buf.baseY + term.rows; y++) {
    rows.push(buf.getLine(y)?.translateToString(true) ?? '')
  }
  return rows
}

// Optional side bars (│ ┃) some box styles wrap each content row with.
const SIDE_L = /^\s*[│┃|]\s?/
const SIDE_R = /\s?[│┃|]\s*$/

/** A horizontal separator/border row: mostly box-drawing line/corner chars (Claude delimits the
 *  prompt with a full-width ──── rule — no corners — and below it sits the status line). */
function isSeparator(s: string): boolean {
  const t = s.trim()
  if (t.length < 10) return false
  const box = (t.match(/[─━╭╮╰╯┌┐└┘├┤┼┄┈╌╴╶]/g) || []).length
  return box >= t.length * 0.7
}

/**
 * Scrape the text typed (but not sent) in the Claude prompt off the rendered viewport. The prompt
 * sits ABOVE the lowest horizontal separator (the status line is BELOW it), so: find the lowest
 * separator, then the "> " prompt line just above it, and read only the rows BETWEEN them — never
 * the status row below. Strips side bars + the leading "> ". Returns '' when nothing usable found.
 */
function scrapeClaudePrompt(term: Terminal): string {
  const rows = viewportRows(term)
  let lowerSep = -1
  for (let i = rows.length - 1; i >= 0; i--) { if (isSeparator(rows[i])) { lowerSep = i; break } }
  if (lowerSep < 0) return ''

  let p = -1
  for (let i = lowerSep - 1; i >= 0; i--) {
    if (isSeparator(rows[i])) break // reached the top border without a prompt marker
    const stripped = rows[i].replace(SIDE_L, '').replace(SIDE_R, '')
    if (/^\s*>(\s|$)/.test(stripped)) { p = i; break }
  }
  if (p < 0) return ''

  let promptSeen = false
  const out = rows.slice(p, lowerSep).map((line) => {
    let s = line.replace(SIDE_L, '').replace(SIDE_R, '')
    if (!promptSeen) { const m = s.match(/^\s*>\s?/); if (m) { promptSeen = true; s = s.slice(m[0].length) } }
    return s
  })
  return out.join('\n').replace(/\s+$/g, '')
}

const RESTORE_CMDS = ['cc', 'ccc', 'resume', 'resume-fork'] as const
type RestoreCmd = typeof RESTORE_CMDS[number]
function isRestoreCmd(s: string | undefined): s is RestoreCmd {
  return typeof s === 'string' && (RESTORE_CMDS as readonly string[]).includes(s)
}

// Display labels for each commit target. One source of truth so the menu
// title, tooltips, and button text don't drift (the old per-site ternary
// collapsed Hg/All to "SVN").
const VCS_LABEL: Record<'git' | 'svn' | 'hg' | 'all', string> = {
  git: 'Git',
  svn: 'SVN',
  hg: 'Hg',
  all: 'all VCS',
}

interface TerminalPanelParams {
  cwd?: string
  command?: string
  args?: string[]
  projectDir?: string
  cmd?: string
  folderName?: string
  sessionId?: string
  forkParentId?: string
  antiFlicker?: boolean
  agent?: AgentId
  /** Force this tab's agent to launch IMMEDIATELY, even while the tab is inactive/hidden — set for
   *  control-opened tabs (remote/AI). Without it the lazy-launch gate defers the spawn until the tab
   *  is shown, so a SILENTLY-opened tab (activate:false) would never spawn its PTY and the AI/remote
   *  controller could never drive it (write-keys/scrollback → not_found). The anti-stampede deferral
   *  still applies to restored layout tabs (which never set this). */
  eager?: boolean
}


export function TerminalSidebarPanel({ api, params }: IDockviewPanelProps<TerminalPanelParams>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { appConfig, currentTheme, dockviewApi } = useLayoutStore()
  const [sidebarVisible, setSidebarVisible] = useState(false)

  const [searchVisible, setSearchVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Restore is only viable when the cmd from saved layout JSON matches
  // one of the four recognized launch verbs; bogus values fall through
  // to the screen-managed menu path.
  const restoreMeta: ScreenOpenTabMeta | undefined =
    params.projectDir && params.folderName && isRestoreCmd(params.cmd)
      ? {
          projectDir: params.projectDir,
          cmd: params.cmd,
          folderName: params.folderName,
          sessionId: params.sessionId,
          forkParentId: params.forkParentId,
          antiFlicker: params.antiFlicker,
          agent: params.agent,
        }
      : undefined
  const screenManaged = !!appConfig && params.command === undefined && !restoreMeta

  // Lazy launch: only spawn this tab's agent once the tab is (or becomes) visible. On an
  // app restore, every window's saved layout mounts ALL its panels at once; without this,
  // each would start its `claude` immediately and stampede ~/.claude.json. Sticky once shown
  // — switching away later does NOT kill the live session. A freshly-opened tab is active/
  // visible from the start, so it launches immediately (unaffected).
  // `interactive` = this tab was launched because the USER clicked it (not because it was the
  // visible tab at restore). Set BEFORE setLaunched so the launch effect reads it true — it makes
  // the spawn bypass the anti-stampede gate so a click launches immediately, no queue wait.
  // `params.eager` (control/AI-opened tab) launches NOW even while inactive/hidden — a silently-opened
  // remote tab must spawn its PTY immediately or the controller could never drive it. Eager ⇒ also
  // interactive (single deliberate open, bypass the gate). Restore tabs never set eager, so their
  // anti-stampede deferral is untouched.
  const interactiveRef = useRef(params.eager === true)
  const [launched, setLaunched] = useState(() => api.isVisible || params.eager === true)
  useEffect(() => {
    if (launched) return
    if (api.isVisible || api.isActive) { setLaunched(true); return }
    const activate = () => { interactiveRef.current = true; setLaunched(true) }
    const d1 = api.onDidVisibilityChange((e) => { if (e.isVisible) activate() })
    const d2 = api.onDidActiveChange((e) => { if (e.isActive) activate() })
    return () => { d1.dispose(); d2.dispose() }
  }, [api, launched])

  const { searchRef, termRef, refitRef } = useTerminal(containerRef, {
    terminalId: api.id,
    screenManaged,
    restoreMeta,
    cwd: params.cwd,
    command: params.command,
    args: params.args,
    agent: params.agent,
    enabled: launched,
    interactive: interactiveRef.current,
  })

  useEffect(() => {
    const disposable = api.onDidActiveChange(({ isActive }) => {
      if (isActive) setTimeout(() => termRef.current?.focus(), 0)
    })
    return () => disposable.dispose()
  }, [api])

  // Re-fit the terminal when the tab becomes visible/active. A restored or background tab can be sized
  // while its container is still collapsed → small grid that doesn't fill the panel. The (debounced,
  // resize-only-on-change) refit grows it to the real size. Safe vs the old reveal-repaint: it fits at
  // the SETTLED size and resizes only on a genuine change, so a same-size reveal is a no-op → no reflow.
  useEffect(() => {
    const refit = () => refitRef.current?.()
    const d1 = api.onDidVisibilityChange((e) => { if (e.isVisible) refit() })
    const d2 = api.onDidActiveChange((e) => { if (e.isActive) refit() })
    // On startup dockview settles restored panels over several frames: a tab can become active/visible
    // (→ refit) while still at a transient collapsed height, fitting to too few rows — then it never
    // grows (the ResizeObserver proved unreliable on restore). onDidDimensionsChange fires when the
    // panel reaches its final size → refit then. Debounced + resize-only-on-change, so a same-size
    // event is a no-op (no reflow). Mirrors RemoteViewerPanel.
    const d3 = api.onDidDimensionsChange(() => refit())
    return () => { d1.dispose(); d2.dispose(); d3.dispose() }
  }, [api, refitRef])

  useEffect(() => {
    if (!window.electronAPI?.onScreenTitle) return
    return window.electronAPI.onScreenTitle((id, title) => {
      if (id === api.id) {
        api.setTitle(title)
        window.dispatchEvent(new CustomEvent('screen-title-change', { detail: { id, title } }))
      }
    })
  }, [api.id])

  useEffect(() => {
    if (!window.electronAPI?.onScreenUpdateParams) return
    return window.electronAPI.onScreenUpdateParams((id, newParams) => {
      if (id === api.id) api.updateParameters(newParams)
    })
  }, [api.id])


  useEffect(() => {
    const handler = (e: CustomEvent) => {
      if (e.detail === api.id) setSidebarVisible(v => !v)
    }
    window.addEventListener('toggle-notes' as any, handler)
    return () => window.removeEventListener('toggle-notes' as any, handler)
  }, [api.id])

  const openSearch = useCallback(() => {
    setSearchVisible(true)
    setTimeout(() => searchInputRef.current?.focus(), 0)
  }, [])

  const closeSearch = useCallback(() => {
    setSearchVisible(false)
    setSearchQuery('')
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }, [])

  const findNext = useCallback(() => {
    if (searchQuery) searchRef.current?.findNext(searchQuery)
  }, [searchQuery])

  const findPrevious = useCallback(() => {
    if (searchQuery) searchRef.current?.findPrevious(searchQuery)
  }, [searchQuery])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 'f' || (e.shiftKey && e.key === 'F'))) {
        e.preventDefault()
        if (api.isActive) openSearch()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [api.id, openSearch])

  const handlePaste = (text: string) => {
    bracketedPaste(api.id, text)
    setTimeout(() => termRef.current?.focus(), 0)
  }

  // Pull the unsent text from the Claude prompt into Notes and clear the prompt. Long prompts
  // can be taller than the visible box, so we loop: scrape the visible chunk, prepend it (we
  // peel from the bottom), backspace it away to reveal the part above, and repeat until the box
  // is empty (or no longer changes — a safety stop). Backspace only: never interrupts/exits.
  const isClaudeTerminal = (params.agent ?? 'claude') === 'claude'
  const handleImportFromPrompt = useCallback(async (): Promise<string | null> => {
    const term = termRef.current
    if (!term) return null
    let result = ''
    let prev: string | null = null
    for (let i = 0; i < 40; i++) {
      const chunk = scrapeClaudePrompt(term)
      if (!chunk || chunk === prev) break
      result = result ? `${chunk}\n${result}` : chunk
      window.electronAPI?.writeTerminal?.(api.id, '\x7f'.repeat(chunk.length))
      prev = chunk
      await new Promise((r) => setTimeout(r, 160))
    }
    setTimeout(() => termRef.current?.focus(), 0)
    if (result) return result
    // Couldn't confidently find the prompt → return a labelled dump of the bottom viewport rows
    // (sends NO keystrokes) so the exact box rendering can be shared and the parser finalized.
    const dump = viewportRows(term).slice(-18).map((r, n) => `${String(n).padStart(2, '0')}┃${r}`).join('\n')
    return `⟦IMPORT-DEBUG — paste this back⟧\n${dump}\n⟦END⟧`
  }, [api.id, params.agent])

  const projectDir = params.projectDir ?? params.cwd ?? null

  const handleOpenSessionHistory = useCallback(() => {
    if (!dockviewApi || !projectDir) return
    openSessionHistoryPanel(dockviewApi, projectDir)
  }, [dockviewApi, projectDir])

  const handleOpenFileChanges = useCallback(() => {
    if (!dockviewApi || !projectDir) return
    openFileChangesPanel(dockviewApi, projectDir, { sessionId: params.sessionId })
  }, [dockviewApi, projectDir, params.sessionId])

  // Commit menu: left click on Commit Git/Svn = basic message (no AI delay);
  // right click = popup picking an AI model (Haiku/Sonnet/Opus) that runs
  // `claude -p` on the full diff and uses the summary as the dialog message.
  type CommitVcs = 'git' | 'svn' | 'hg' | 'all'
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number; vcs: CommitVcs } | null>(null)
  const [commitBusyKey, setCommitBusyKey] = useState<CommitVcs | null>(null)
  const [commitElapsed, setCommitElapsed] = useState(0)
  const commitTimerRef = useRef<number | null>(null)
  const [vcsAvailable, setVcsAvailable] = useState<{ git: boolean; svn: boolean; hg: boolean }>({
    git: false, svn: false, hg: false,
  })

  // Probe which VCS markers exist for this project so we can hide commit
  // buttons that have no working copy. Refreshes periodically + on window
  // focus so a freshly-`hg init`'d / `git init`'d repo shows up without
  // requiring a panel remount.
  //
  // Gated on `sidebarVisible`: the commit/log buttons only render when the
  // sidebar is open, so there's no reason to run the 5s fs-walking probe
  // for closed/background tabs (10 tabs × every 5s was real waste).
  useEffect(() => {
    if (!sidebarVisible || !projectDir || !window.electronAPI?.detectCommitVcs) return
    let cancelled = false
    const refresh = () => {
      window.electronAPI?.detectCommitVcs?.(projectDir).then((r) => {
        if (!cancelled) setVcsAvailable(r)
      }).catch(() => {})
    }
    refresh()
    const interval = window.setInterval(refresh, 5000)
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
  }, [projectDir, sidebarVisible])

  // Clean up the elapsed-seconds timer if the panel unmounts mid-commit.
  useEffect(() => {
    return () => {
      if (commitTimerRef.current !== null) window.clearInterval(commitTimerRef.current)
    }
  }, [])

  const runCommit = useCallback(async (vcs: CommitVcs, model: 'haiku' | 'sonnet' | 'opus' | 'off') => {
    if (!projectDir || !window.electronAPI?.openCommitDialog) return
    setCommitBusyKey(vcs)
    setCommitElapsed(0)
    const startedAt = Date.now()
    commitTimerRef.current = window.setInterval(() => {
      setCommitElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 200)
    try {
      const res = await window.electronAPI.openCommitDialog(vcs, projectDir, { model })
      if (!res.ok && res.error) console.warn(`[Commit ${vcs}]`, res.error, res.skipped)
      else for (const d of res.dialogs) console.log(`[Commit ${vcs}] ${d.repoRoot} usedAi=${d.usedAi} aiMs=${d.aiMs ?? 0}`)
    } finally {
      if (commitTimerRef.current !== null) {
        window.clearInterval(commitTimerRef.current)
        commitTimerRef.current = null
      }
      setCommitBusyKey(null)
    }
  }, [projectDir])

  const handleCommitClick = useCallback((vcs: CommitVcs) => () => runCommit(vcs, 'off'), [runCommit])

  const handleCommitContextMenu = useCallback((vcs: CommitVcs) => (e: React.MouseEvent) => {
    e.preventDefault()
    setCommitMenu({ x: e.clientX, y: e.clientY, vcs })
  }, [])

  const pickCommitModel = useCallback((model: 'haiku' | 'sonnet' | 'opus') => {
    const m = commitMenu
    setCommitMenu(null)
    if (m) runCommit(m.vcs, model)
  }, [commitMenu, runCommit])

  // Close commit menu on outside click / Escape / scroll.
  useEffect(() => {
    if (!commitMenu) return
    const close = () => setCommitMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [commitMenu])

  // Reposition the commit menu inside the viewport. Right-clicking near the
  // bottom (the Commit buttons live in the bottom sidebar row) would let it
  // drop off-screen. useLayoutEffect runs before paint so the user never
  // sees the off-screen position.
  const commitMenuRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!commitMenu || !commitMenuRef.current) return
    const menu = commitMenuRef.current
    const rect = menu.getBoundingClientRect()
    const margin = 8
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = commitMenu.x
    let top = commitMenu.y
    if (left + rect.width + margin > vw) left = Math.max(margin, vw - rect.width - margin)
    if (top + rect.height + margin > vh) {
      const above = commitMenu.y - rect.height
      top = above >= margin ? above : Math.max(margin, vh - rect.height - margin)
    }
    if (top < margin) top = margin
    if (left < margin) left = margin
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }, [commitMenu])

  return (
    <div className="terminal-with-notes">
      <div className="terminal-area-wrapper">
        {searchVisible && (
          <div className="terminal-search-bar">
            <input
              ref={searchInputRef}
              className="terminal-search-input"
              type="text"
              placeholder="Find..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                if (e.target.value) searchRef.current?.findNext(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.shiftKey) findPrevious()
                else if (e.key === 'Enter') findNext()
                else if (e.key === 'Escape') closeSearch()
              }}
            />
            <button className="terminal-search-btn" onClick={findPrevious} title="Previous (Shift+Enter)">&#x25B2;</button>
            <button className="terminal-search-btn" onClick={findNext} title="Next (Enter)">&#x25BC;</button>
            <button className="terminal-search-btn" onClick={closeSearch} title="Close (Escape)">&#x2715;</button>
          </div>
        )}
        <div
          ref={containerRef}
          className="terminal-area"
          data-terminal-id={api.id}
          style={{ background: themes[currentTheme].theme.background }}
        />
        <CrashBanner terminalId={api.id} />
        <ContextWarningOverlay terminalId={api.id} params={params as Record<string, unknown>} />
      </div>
      {sidebarVisible && (
        <div className="panel-sidebar-right">
          <div className="sidebar-section sidebar-section-grow">
            <div className="sidebar-section-header">Notes</div>
            <NotesPanel panelId={projectDir ?? api.id} visible={true} onPaste={handlePaste} onImportFromPrompt={isClaudeTerminal ? handleImportFromPrompt : undefined} />
          </div>
          {projectDir && (
            <div className="sidebar-section sidebar-section-files">
              <RecentFilesPanel projectDir={projectDir} />
            </div>
          )}
          {projectDir && (
            <>
              <div className="sidebar-action-row">
                <button className="sidebar-action-row-btn" onClick={handleOpenSessionHistory}>
                  🔍 History
                </button>
                <button className="sidebar-action-row-btn" onClick={handleOpenFileChanges}>
                  📝 Changes
                </button>
              </div>
              {(vcsAvailable.git || vcsAvailable.svn || vcsAvailable.hg) && (
                <div className="sidebar-action-row sidebar-commit-row">
                  <span className="sidebar-commit-label">Log:</span>
                  {(['git', 'svn', 'hg'] as const)
                    .filter((vcs) => vcsAvailable[vcs])
                    .map((vcs) => (
                      <button
                        key={`log-${vcs}`}
                        className="sidebar-action-row-btn"
                        onClick={() => { void window.electronAPI?.openCommitLog?.(vcs, projectDir) }}
                        title={`Open Tortoise${VCS_LABEL[vcs]} log viewer for this project`}
                      >
                        {VCS_LABEL[vcs]}
                      </button>
                    ))}
                </div>
              )}
              {(vcsAvailable.git || vcsAvailable.svn || vcsAvailable.hg) && (
                <div className="sidebar-action-row sidebar-commit-row">
                  <span className="sidebar-commit-label">Commit:</span>
                  {(['git', 'svn', 'hg', 'all'] as const)
                    .filter((vcs) => {
                      // Only show buttons for VCS that have a working copy.
                      // "All" only makes sense when at least 2 VCS are
                      // present — otherwise it'd duplicate the single VCS
                      // button.
                      if (vcs === 'all') {
                        const n = (vcsAvailable.git ? 1 : 0) + (vcsAvailable.svn ? 1 : 0) + (vcsAvailable.hg ? 1 : 0)
                        return n >= 2
                      }
                      return vcsAvailable[vcs]
                    })
                    .map((vcs) => {
                      const busy = commitBusyKey === vcs
                      const label = vcs === 'all' ? 'All' : VCS_LABEL[vcs]
                      return (
                        <button
                          key={vcs}
                          className="sidebar-action-row-btn sidebar-commit-btn"
                          onClick={handleCommitClick(vcs)}
                          onContextMenu={handleCommitContextMenu(vcs)}
                          disabled={commitBusyKey !== null}
                          title={vcs === 'all'
                            ? 'Left-click: open dialogs for all detected VCS with file-list messages. Right-click: pick an AI model.'
                            : `Left-click: open Tortoise${VCS_LABEL[vcs]} with a file-list message. Right-click: pick an AI model.`}
                        >
                          {busy ? `⏳ ${commitElapsed}s` : label}
                        </button>
                      )
                    })}
                </div>
              )}
            </>
          )}
          {commitMenu && createPortal(
            <div
              ref={commitMenuRef}
              className="commit-context-menu"
              style={{ left: commitMenu.x, top: commitMenu.y }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="commit-context-title">
                AI summary for {VCS_LABEL[commitMenu.vcs]} commit
              </div>
              <div className="commit-context-item" onClick={() => pickCommitModel('haiku')}>
                <span className="commit-context-label">Haiku</span>
                <span className="commit-context-hint">~15s · fast, basic</span>
              </div>
              <div className="commit-context-item" onClick={() => pickCommitModel('sonnet')}>
                <span className="commit-context-label">Sonnet</span>
                <span className="commit-context-hint">~22s · balanced</span>
              </div>
              <div className="commit-context-item" onClick={() => pickCommitModel('opus')}>
                <span className="commit-context-label">Opus</span>
                <span className="commit-context-hint">~20s · thorough</span>
              </div>
            </div>,
            document.body
          )}
        </div>
      )}
    </div>
  )
}
