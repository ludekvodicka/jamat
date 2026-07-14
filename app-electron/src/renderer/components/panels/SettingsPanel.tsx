import { IDockviewPanelProps } from 'dockview'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useLayoutStore } from '../../store/layout-store'
import { themes, type ThemeId } from '../../themes'
import type { SessionDonePrompt } from '../../../shared/types'
import type { CategoryJson, SelfUpdateConfig, CustomMenuNode, CustomRun, ContextWarnLevel, AgentsConfig, AgentPreLaunch } from '../../../../../core/types/config'
import type { UpdateStatus } from '../../../../../core/update/update-status.types'
import type { AppPathsInfo } from '../../../../../core/types/ipc-contracts'
import { type MenuPath, mutateNode, deleteNode, moveNode, newLeaf, newBranch, firstMenuError } from './menuTree'
import { DEFAULT_CONTEXT_LEVELS } from '../../utils/context-level'
import { RemoteConnectionEditor } from './RemoteConnectionEditor'

interface Settings {
  scrollback: number
  cursorBlink: boolean
  /** xterm renderer for new terminals. Applies to NEWLY-opened terminals.
   *  'dom' (default) loads no accelerated addon — slower in theory, but immune to the intermittent
   *  cell mis-paint (a char dropped/doubled/shifted on a frame; a refresh/selection only partly heals
   *  because the buffer is fine and only the paint isn't) that WebGL can exhibit.
   *  'webgl' keeps a GPU glyph atlas — faster, but exhibits that corruption. (Canvas was removed in xterm 6.) */
  terminalRenderer: 'webgl' | 'dom'
  notifyAfterSeconds: number
  /** Desktop + toast notification when a turn finishes after ≥ notifyAfterSeconds of work. */
  notifyOnComplete: boolean
  /** Desktop + toast notification when Claude pauses for the user — a question (AskUserQuestion /
   *  plan approval) or a y/n permission prompt. Fires immediately, ignoring notifyAfterSeconds. */
  notifyOnQuestions: boolean
  toastDurationSeconds: number
  /** Show the bottom-right quick-prompt popup when a session finishes a non-trivial turn on the
   *  active tab (gated by the same notifyAfterSeconds work threshold). When on, the redundant
   *  "Finished after …" toast is suppressed for that active-tab finish. */
  sessionDonePopupEnabled: boolean
  recentFilesCount: number
  recentFilesIntervalSeconds: number
  /** Show the clipboard-debug widget in the status bar (live clipboard / OSC 52 / selection / focus +
   *  manual copy buttons). Off by default — a diagnostic surface kept for clipboard issues across
   *  terminal backends. Read live by App.tsx (re-applied on Save via the `app-settings-changed` event). */
  showClipboardDebug: boolean
  /** Show the work-detection widget in the status bar (live "is Claude working?" verdict + which
   *  busy markers fire, from the rendered screen vs the raw PTY tail; turns red on a detection-vs-tab
   *  mismatch). Off by default — a diagnostic surface kept for tuning the detection. Read live by
   *  App.tsx (re-applied on Save via the `app-settings-changed` event); mounting it also enables
   *  `detectionDebug` publishing. */
  showWorkDetectionDebug: boolean
  /** Show the renderer/geometry badge in the status bar (e.g. "DOM 135×68" — the active terminal's
   *  xterm renderer + cols×rows). On by default. Read live by App.tsx (same `app-settings-changed`). */
  showRendererBadge: boolean
}

export const STORAGE_KEY = 'jamat-settings'
const LEGACY_STORAGE_KEY = 'claude-super-app-settings' // pre-Jamat-rebrand; read once so existing settings survive

const DEFAULTS: Settings = {
  scrollback: 10000,
  cursorBlink: true,
  terminalRenderer: 'dom',
  notifyAfterSeconds: 60,
  notifyOnComplete: true,
  notifyOnQuestions: true,
  toastDurationSeconds: 5,
  sessionDonePopupEnabled: true,
  recentFilesCount: 15,
  recentFilesIntervalSeconds: 5,
  showClipboardDebug: false,
  showWorkDetectionDebug: false,
  showRendererBadge: true,
}

/** Dispatched after settings are saved so live-reactive consumers (e.g. App.tsx's clipboard-debug
 *  toggle) re-read loadSettings() without a reload. */
export const SETTINGS_CHANGED_EVENT = 'app-settings-changed'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
    if (raw) {
      const merged: Settings = { ...DEFAULTS, ...JSON.parse(raw) }
      // Canvas renderer was removed in xterm 6 → migrate any stored 'canvas' (or junk) to the default.
      if (merged.terminalRenderer !== 'webgl' && merged.terminalRenderer !== 'dom') {
        merged.terminalRenderer = DEFAULTS.terminalRenderer
      }
      return merged
    }
  } catch {}
  return { ...DEFAULTS }
}

function saveSettings(s: Settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}

type TabId = 'projects' | 'general' | 'agents' | 'menus' | 'appearance' | 'terminal' | 'notifications' | 'context' | 'recentFiles' | 'prompts' | 'usage' | 'updates' | 'remote' | 'debug' | 'info'

const TABS: { id: TabId; label: string }[] = [
  { id: 'projects', label: 'Projects' },
  { id: 'general', label: 'General' },
  { id: 'agents', label: 'Agents' },
  { id: 'menus', label: 'Project menus' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'context', label: 'Context warnings' },
  { id: 'recentFiles', label: 'Recent Files' },
  { id: 'prompts', label: 'Quick prompts' },
  { id: 'usage', label: 'Usage' },
  { id: 'updates', label: 'Updates' },
  { id: 'remote', label: 'Remote connection' },
  { id: 'debug', label: 'Debug' },
  { id: 'info', label: 'Info' },
]

// Tabs whose fields are persisted by the localStorage `Settings` object → they share the bottom Save
// bar. The prompts + usage tabs persist via their own IPC-backed buttons, so no shared bar there.
// 'debug' is NOT here: its toggles apply instantly via updateLive (no Save click), so no Save bar.
const LOCAL_SETTINGS_TABS: TabId[] = ['terminal', 'notifications', 'recentFiles']

export function SettingsPanel(props: IDockviewPanelProps) {
  const { currentTheme, setTheme } = useLayoutStore()
  const [tab, setTab] = useState<TabId>('projects')
  const [settings, setSettings] = useState(loadSettings)
  const [saved, setSaved] = useState(false)
  const guidedParam = (props.params as { guided?: boolean } | undefined)?.guided === true
  const [guided, setGuided] = useState(guidedParam)

  // The first-run auto-open pushes { guided:true } as params; if Settings is already open the panel
  // re-renders with the new params → flip into guided mode and jump to the first step.
  useEffect(() => {
    if (guidedParam) { setGuided(true); setTab('projects') }
  }, [guidedParam])

  const finishOnboarding = async () => {
    await window.electronAPI.completeOnboarding?.()
    setGuided(false)
  }

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  // Apply the moment you toggle it (no Save click) — used by the Debug tab so the status-bar widgets
  // appear/disappear instantly. Persists to localStorage and fires SETTINGS_CHANGED_EVENT right away
  // so App.tsx re-reads. (saveSettings before dispatch → the listener's loadSettings() sees the new value.)
  const updateLive = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const next = { ...settings, [key]: value }
    setSettings(next)
    saveSettings(next)
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT))
  }

  const handleSave = () => {
    saveSettings(settings)
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT))
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleThemeChange = (id: string) => {
    setTheme(id as ThemeId)
    window.location.reload()
  }

  return (
    <div className="settings-panel">
      <h1>Settings</h1>
      {guided && (
        <GuidedChecklist
          onJump={(t) => setTab(t)}
          onFinish={() => void finishOnboarding()}
          onDismiss={() => setGuided(false)}
        />
      )}
      <div className="settings-layout">
        <nav className="settings-nav">
          {TABS.map(t => (
            <button
              key={t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          <button className="settings-rerun" onClick={() => { setGuided(true); setTab('projects') }} title="Show the first-run setup guide again">
            ↻ Setup guide
          </button>
        </nav>

        <div className="settings-content">
          {tab === 'projects' && <CategoriesEditor />}

          {tab === 'general' && <GeneralEditor />}

          {tab === 'agents' && <AgentsEditor />}

          {tab === 'updates' && <UpdatesEditor />}

          {tab === 'remote' && <RemoteConnectionEditor />}

          {tab === 'menus' && <CustomMenusEditor />}

          {tab === 'appearance' && (
            <section className="settings-section">
              <h2>Appearance</h2>
              <div className="settings-row">
                <label>Theme</label>
                <select value={currentTheme} onChange={e => handleThemeChange(e.target.value)}>
                  {Object.entries(themes).map(([id, t]) => (
                    <option key={id} value={id}>{t.name}</option>
                  ))}
                </select>
              </div>
            </section>
          )}

          {tab === 'terminal' && (
            <section className="settings-section">
              <h2>Terminal</h2>
              <div className="settings-row">
                <label>Scrollback lines</label>
                <input
                  type="number"
                  min={1000}
                  max={100000}
                  step={1000}
                  value={settings.scrollback}
                  onChange={e => update('scrollback', parseInt(e.target.value) || DEFAULTS.scrollback)}
                />
              </div>
              <div className="settings-row">
                <label>Cursor blink</label>
                <input
                  type="checkbox"
                  checked={settings.cursorBlink}
                  onChange={e => update('cursorBlink', e.target.checked)}
                />
              </div>
              <div className="settings-row">
                <label title="WebGL is GPU-accelerated (fast) but can intermittently mis-paint cells. DOM uses no accelerated addon — slower, but immune to that paint corruption. Applies to new terminals.">Renderer</label>
                <select
                  value={settings.terminalRenderer}
                  onChange={e => update('terminalRenderer', e.target.value as Settings['terminalRenderer'])}
                >
                  <option value="dom">DOM (default — no GPU, no corruption)</option>
                  <option value="webgl">WebGL (GPU atlas, fast, can mis-paint)</option>
                </select>
              </div>
            </section>
          )}

          {tab === 'notifications' && (
            <section className="settings-section">
              <h2>Notifications</h2>
              <div className="settings-row">
                <label title="Show a desktop + toast notification when Claude finishes a turn that ran at least this long. Click the notification to focus the window and jump to that tab.">Notify on complete (after seconds)</label>
                <input
                  type="checkbox"
                  checked={settings.notifyOnComplete}
                  onChange={e => update('notifyOnComplete', e.target.checked)}
                />
                <input
                  type="number"
                  min={10}
                  max={600}
                  step={10}
                  value={settings.notifyAfterSeconds}
                  disabled={!settings.notifyOnComplete}
                  onChange={e => update('notifyAfterSeconds', parseInt(e.target.value) || DEFAULTS.notifyAfterSeconds)}
                />
              </div>
              <div className="settings-row">
                <label title="Notify the moment Claude pauses for you — a question (AskUserQuestion / plan approval) or a permission prompt. Fires immediately (no time threshold); skipped when that tab is already active and the window focused. Click to focus the window and jump to that tab.">Notify on questions / permission</label>
                <input
                  type="checkbox"
                  checked={settings.notifyOnQuestions}
                  onChange={e => update('notifyOnQuestions', e.target.checked)}
                />
              </div>
              <div className="settings-row">
                <label>Toast duration (seconds)</label>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={settings.toastDurationSeconds}
                  onChange={e => update('toastDurationSeconds', parseInt(e.target.value) || DEFAULTS.toastDurationSeconds)}
                />
              </div>
              <div className="settings-row">
                <label title="When a session finishes a non-trivial turn on the active tab, show a bottom-right popup with one-click follow-up prompts (edit them under Quick prompts). Uses the same work threshold as the notification above.">Session-done prompt popup</label>
                <input
                  type="checkbox"
                  checked={settings.sessionDonePopupEnabled}
                  onChange={e => update('sessionDonePopupEnabled', e.target.checked)}
                />
              </div>
            </section>
          )}

          {tab === 'recentFiles' && (
            <section className="settings-section">
              <h2>Recent Files</h2>
              <div className="settings-row">
                <label>Number of files</label>
                <input
                  type="number"
                  min={5}
                  max={50}
                  value={settings.recentFilesCount}
                  onChange={e => update('recentFilesCount', parseInt(e.target.value) || DEFAULTS.recentFilesCount)}
                />
              </div>
              <div className="settings-row">
                <label>Refresh interval (seconds)</label>
                <input
                  type="number"
                  min={5}
                  max={120}
                  step={5}
                  value={settings.recentFilesIntervalSeconds}
                  onChange={e => update('recentFilesIntervalSeconds', parseInt(e.target.value) || DEFAULTS.recentFilesIntervalSeconds)}
                />
              </div>
            </section>
          )}

          {tab === 'debug' && (
            <section className="settings-section">
              <h2>Debug</h2>
              <div className="settings-row">
                <label title="Show a clipboard diagnostic in the status bar: live OS clipboard, the last OSC 52 copy from the terminal app, xterm selection, window focus, and manual Copy buttons. Handy when a terminal backend has copy/paste quirks.">Show clipboard debug in status bar</label>
                <input
                  type="checkbox"
                  checked={settings.showClipboardDebug}
                  onChange={e => updateLive('showClipboardDebug', e.target.checked)}
                />
              </div>
              <p className="settings-note">
                Adds a 🐛 section to the status bar showing the live clipboard, the last OSC 52 copy
                (how Claude and similar TUIs copy), the xterm selection and focus state, plus manual
                Copy buttons. Off by default — a diagnostic surface for clipboard issues.
              </p>
              <div className="settings-row">
                <label title="Show a work-detection diagnostic in the status bar: the live 'is Claude working?' verdict, which busy markers fire (from the rendered screen vs the raw PTY tail), and the time since last output. Turns red when detection disagrees with the tab status. Hover it for the full breakdown + both source texts.">Show work-detection debug in status bar</label>
                <input
                  type="checkbox"
                  checked={settings.showWorkDetectionDebug}
                  onChange={e => updateLive('showWorkDetectionDebug', e.target.checked)}
                />
              </div>
              <p className="settings-note">
                Adds a “det:WORK/idle …” section showing the live work-detection verdict and why
                (which markers matched, screen vs raw source, output age). On by default while the
                detection is being tuned — turn off once the tab status dot is reliable.
              </p>
              <div className="settings-row">
                <label title="Show the renderer/geometry badge in the status bar — the active terminal's xterm renderer (DOM or OGL/WebGL) and its size in cols×rows, e.g. 'DOM 135×68'.">Show renderer/geometry badge in status bar</label>
                <input
                  type="checkbox"
                  checked={settings.showRendererBadge}
                  onChange={e => updateLive('showRendererBadge', e.target.checked)}
                />
              </div>
              <p className="settings-note">
                The “DOM 135×68” badge — active terminal's xterm renderer + cols×rows. On by default.
              </p>
            </section>
          )}

          {tab === 'context' && <ContextLevelsEditor />}

          {tab === 'prompts' && <QuickPromptsEditor />}

          {tab === 'usage' && <UsageCredentials />}

          {tab === 'info' && <AppInfo />}

          {LOCAL_SETTINGS_TABS.includes(tab) && (
            <div className="settings-actions">
              <button className="settings-save-btn" onClick={handleSave}>
                {saved ? '✓ Saved' : 'Save'}
              </button>
              <span className="settings-note">Changes to terminal settings apply to new terminals only</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * First-run "Get started" checklist shown on top of Settings in guided mode. Steps are DERIVED from
 * the live config (so they tick as the user saves each tab); whether onboarding is "done" is governed
 * by the persisted flag (set by Finish), not these ticks. The untouched starter category
 * (…/JamatProjects, created by ensureConfig) does NOT count as "a project added".
 */
function GuidedChecklist({ onJump, onFinish, onDismiss }: {
  onJump: (tab: TabId) => void
  onFinish: () => void
  onDismiss: () => void
}) {
  const appConfig = useLayoutStore(s => s.appConfig)
  const [usageHasKey, setUsageHasKey] = useState(false)
  useEffect(() => {
    window.electronAPI.getUsageCredentials?.().then(c => setUsageHasKey(c.hasSessionKey)).catch(() => {})
  }, [])

  const cats = appConfig?.categories ?? []
  const hasProject = cats.some(c => !/[\\/]JamatProjects$/.test(c.path))
  const steps: { id: string; label: string; done: boolean; tab: TabId; required: boolean }[] = [
    { id: 'projects', label: 'Add a project folder', done: hasProject, tab: 'projects', required: true },
    { id: 'agent', label: 'Choose your default agent', done: !!appConfig?.defaultAgent, tab: 'agents', required: true },
    { id: 'usage', label: 'Connect usage stats (optional)', done: usageHasKey, tab: 'usage', required: false },
  ]
  const doneCount = steps.filter(s => s.done).length
  const allRequired = steps.filter(s => s.required).every(s => s.done)

  return (
    <div className="settings-guide">
      <div className="settings-guide-head">
        <h2>Get started <span className="settings-guide-count">{doneCount}/{steps.length}</span></h2>
        <button className="settings-guide-dismiss" title="Hide for now (reopens next launch until finished)" onClick={onDismiss}>✕</button>
      </div>
      <ul className="settings-guide-steps">
        {steps.map(s => (
          <li key={s.id} className={s.done ? 'done' : ''}>
            <span className="settings-guide-check">{s.done ? '✓' : '○'}</span>
            <button className="settings-guide-jump" onClick={() => onJump(s.tab)}>{s.label}</button>
            {!s.required && <span className="settings-guide-opt">optional</span>}
          </li>
        ))}
      </ul>
      <div className="settings-guide-actions">
        <button className="settings-save-btn" disabled={!allRequired} onClick={onFinish}>Finish setup</button>
        {!allRequired && <span className="settings-note">Add a project folder and pick an agent to finish.</span>}
      </div>
    </div>
  )
}

/**
 * Editor for `categories` — the project folders Jamat scans for the start menu / sidebar. Each row
 * is one category (a name + a folder, pickable via the native dialog). Seeds from the RAW on-disk
 * config (`getRawConfig`) so inaccessible categories (detached drives) and advanced per-category
 * fields (hiddenFolders / virtualFolders / flattenFolders) survive a save instead of being silently
 * dropped by the runtime category filter. Persists via `config:update`; the main-side brick-guard
 * refuses a save where no folder exists, so the app can never be configured into a non-booting state.
 */
type CatRow = { label: string; path: string; advanced: Omit<CategoryJson, 'label' | 'path'> }

function CategoriesEditor() {
  const [rows, setRows] = useState<CatRow[]>([])
  const [missing, setMissing] = useState<Record<number, boolean>>({})
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const touched = useRef(false)
  const configFile = useLayoutStore(s => s.appConfig)?.configPath?.split(/[\\/]/).pop() ?? 'config-<user>.json'

  const seed = useCallback(() => {
    void window.electronAPI.getRawConfig().then((raw) => {
      if (touched.current) return
      const cats = Array.isArray(raw?.categories) ? (raw!.categories as CategoryJson[]) : []
      setRows(cats.map((c) => {
        const { label, path, ...advanced } = c
        return { label: label ?? '', path: path ?? '', advanced }
      }))
      setMissing({})
    }).catch(() => {})
  }, [])

  // Seed on mount; re-seed when another window's edit broadcasts config:changed (unless mid-edit).
  useEffect(() => {
    seed()
    return window.electronAPI.onConfigChanged?.(() => seed())
  }, [seed])

  const edit = (i: number, key: 'label' | 'path', value: string) => {
    touched.current = true; setStatus(null)
    setRows(prev => prev.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)))
    if (key === 'path') setMissing(m => { const n = { ...m }; delete n[i]; return n })
  }
  const add = () => { touched.current = true; setStatus(null); setRows(prev => [...prev, { label: '', path: '', advanced: {} }]) }
  const remove = (i: number) => {
    touched.current = true; setStatus(null)
    setRows(prev => prev.filter((_, idx) => idx !== i))
    setMissing({})
  }
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rows.length) return
    touched.current = true; setStatus(null)
    setRows(prev => {
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }
  const checkExists = async (i: number, path: string) => {
    const p = path.trim()
    if (!p) return
    const type = await window.electronAPI.fileType(p).catch(() => null)
    setMissing(m => ({ ...m, [i]: type !== 'dir' }))
  }
  const browse = async (i: number) => {
    const dir = await window.electronAPI.pickDirectory({ title: 'Pick a project folder', defaultPath: rows[i]?.path || undefined })
    if (dir) { edit(i, 'path', dir); setMissing(m => ({ ...m, [i]: false })) }
  }

  const save = async () => {
    const cleaned: CategoryJson[] = rows.map(r => ({ ...r.advanced, label: r.label.trim(), path: r.path.trim() }))
    const bad = cleaned.findIndex(c => !c.label || !c.path)
    if (bad !== -1) { setStatus(`✗ Row ${bad + 1}: both a name and a folder are required`); return }
    if (!cleaned.length) { setStatus('✗ Add at least one project folder'); return }
    setSaving(true); setStatus(null)
    try {
      const res = await window.electronAPI.updateConfig({ categories: cleaned })
      if (res.ok) { touched.current = false; setStatus('✓ Saved'); seed() }
      else setStatus(`✗ ${res.error ?? 'Failed to save'}`)
    } catch (e: any) {
      setStatus(`✗ ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-section">
      <h2>Projects</h2>
      <p className="settings-note">
        The folders Jamat scans for your projects — each becomes a category in the start menu and
        sidebar. Add one per place you keep projects. Saved to your committed <code>{configFile}</code>.
      </p>
      <div className="sdp-editor">
        <div className="cat-head">
          <span>Name</span>
          <span>Folder</span>
          <span />
          <span />
        </div>
        {rows.length === 0 && (
          <div className="settings-note sdp-empty">No project folders yet. Click “Add folder”.</div>
        )}
        {rows.map((r, i) => (
          <div className="cat-row" key={i}>
            <input type="text" value={r.label} placeholder="My Projects" onChange={e => edit(i, 'label', e.target.value)} />
            <div className="cat-path">
              <input
                type="text"
                value={r.path}
                placeholder="C:/Code/projects"
                onChange={e => edit(i, 'path', e.target.value)}
                onBlur={e => void checkExists(i, e.target.value)}
              />
              {missing[i] && <span className="cat-warn" title="This folder doesn't exist yet — it will be skipped until you create it.">⚠ not found</span>}
            </div>
            <button className="cat-browse" onClick={() => void browse(i)}>Browse…</button>
            <div className="sdp-row-actions">
              <button title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button title="Move down" onClick={() => move(i, 1)} disabled={i === rows.length - 1}>↓</button>
              <button title="Remove" className="sdp-remove" onClick={() => remove(i)}>✕</button>
            </div>
          </div>
        ))}
      </div>
      <div className="settings-actions">
        <button className="settings-add-btn" onClick={add}>+ Add folder</button>
        <button className="settings-save-btn" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save projects'}</button>
        {status && <span className="settings-note">{status}</span>}
      </div>
    </section>
  )
}

/**
 * Editor for the scalar config fields: app `name` and the `dockerIsolation` offer toggle.
 * (`defaultAgent` lives in the Agents tab, next to the per-agent blocks it orders.)
 * Seeds from the raw on-disk config; persists via `config:update`.
 */
function GeneralEditor() {
  const [name, setName] = useState('')
  const [docker, setDocker] = useState(true)
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const touched = useRef(false)

  const seed = useCallback(() => {
    void window.electronAPI.getRawConfig().then((raw) => {
      if (touched.current || !raw) return
      setName(typeof raw.name === 'string' ? raw.name : '')
      setDocker(raw.dockerIsolation !== false) // absent/true → offered
    }).catch(() => {})
  }, [])
  useEffect(() => { seed(); return window.electronAPI.onConfigChanged?.(() => seed()) }, [seed])

  const mark = () => { touched.current = true; setStatus(null) }
  const save = async () => {
    if (!name.trim()) { setStatus('✗ App name is required'); return }
    setSaving(true); setStatus(null)
    try {
      const res = await window.electronAPI.updateConfig({ name: name.trim(), dockerIsolation: docker })
      if (res.ok) { touched.current = false; setStatus('✓ Saved') }
      else setStatus(`✗ ${res.error ?? 'Failed to save'}`)
    } catch (e: any) {
      setStatus(`✗ ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-section">
      <h2>General</h2>
      <div className="settings-row">
        <label>App name</label>
        <input type="text" value={name} placeholder="My Jamat" onChange={e => { mark(); setName(e.target.value) }} />
      </div>
      <div className="settings-row">
        <label title="When on, the start menu offers per-project Docker isolation (the 🐳 marker + the 'Isolated?' prompt on create). Turn off on machines without Docker.">Offer Docker isolation</label>
        <input type="checkbox" checked={docker} onChange={e => { mark(); setDocker(e.target.checked) }} />
      </div>
      <div className="settings-actions">
        <button className="settings-save-btn" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        {status && <span className="settings-note">{status}</span>}
      </div>
    </section>
  )
}

/**
 * Editor for `defaultAgent` + `agents` — the menu's default agent, plus per-agent installed-status and
 * PRE-LAUNCH hooks (a command run in the project dir before the agent instance is created; the
 * motivating case is the Codex AGENTS.md packer). `defaultAgent` decides which agent the Jamat menu
 * lists FIRST and preselects on its `＋ New <Agent> session` rows; it also orders the blocks below.
 * Each agent shows whether its CLI is detected on PATH (read-only, `agents:list` IPC); a hook can only
 * be enabled/edited for a detected agent. Each hook is gated by an enable toggle so opening the tab and
 * saving never materializes a hook on an agent that had none. `{dir}`/`{name}` are substituted and a
 * leading `~` is expanded at launch (core/executor/pre-launch.ts). Seeds from the raw on-disk config;
 * persists via `config:update`. A failing hook never blocks a launch.
 */
type AgentFormId = 'claude' | 'codex'
interface AgentForm { enabled: boolean; command: string; args: string; cwd: string; timeout: string }
const EMPTY_AGENT_FORM: AgentForm = { enabled: false, command: '', args: '', cwd: '', timeout: '' }
const AGENT_FORM_LIST: { id: AgentFormId; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
]

function preLaunchToForm(pre: AgentPreLaunch | undefined): AgentForm {
  if (!pre) return { ...EMPTY_AGENT_FORM }
  return {
    enabled: true,
    command: pre.command ?? '',
    args: (pre.args ?? []).join('\n'),
    cwd: pre.cwd ?? '',
    timeout: pre.timeoutMs != null ? String(pre.timeoutMs) : '',
  }
}

function AgentsEditor() {
  const agentsMeta = useLayoutStore(s => s.agentsMeta)
  const [defaultAgent, setDefaultAgent] = useState<AgentFormId>('claude')
  const [forms, setForms] = useState<Record<AgentFormId, AgentForm>>({ claude: { ...EMPTY_AGENT_FORM }, codex: { ...EMPTY_AGENT_FORM } })
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const touched = useRef(false)

  const seed = useCallback(() => {
    void window.electronAPI.getRawConfig().then((raw) => {
      if (touched.current || !raw) return
      const agents = (raw.agents ?? {}) as AgentsConfig
      setDefaultAgent(raw.defaultAgent === 'codex' ? 'codex' : 'claude')
      setForms({
        claude: preLaunchToForm(agents.claude?.preLaunch),
        codex: preLaunchToForm(agents.codex?.preLaunch),
      })
    }).catch(() => {})
  }, [])
  useEffect(() => { seed(); return window.electronAPI.onConfigChanged?.(() => seed()) }, [seed])

  const setField = (id: AgentFormId, key: keyof AgentForm, value: string | boolean) => {
    touched.current = true; setStatus(null)
    setForms(prev => ({ ...prev, [id]: { ...prev[id], [key]: value } }))
  }

  const save = async () => {
    const agents: AgentsConfig = {}
    for (const { id, label } of AGENT_FORM_LIST) {
      const f = forms[id]
      if (!f.enabled) continue
      if (!f.command.trim()) { setStatus(`✗ ${label}: a command is required (or turn the hook off)`); return }
      const pre: AgentPreLaunch = { command: f.command.trim() }
      const args = f.args.split(/\r?\n/).map(a => a.trim()).filter(Boolean)
      if (args.length) pre.args = args
      if (f.cwd.trim()) pre.cwd = f.cwd.trim()
      if (f.timeout.trim()) {
        const n = parseInt(f.timeout, 10)
        if (!Number.isFinite(n) || n <= 0) { setStatus(`✗ ${label}: timeout must be a positive number of ms`); return }
        pre.timeoutMs = n
      }
      agents[id] = { preLaunch: pre }
    }
    setSaving(true); setStatus(null)
    try {
      const res = await window.electronAPI.updateConfig({ defaultAgent, agents })
      if (res.ok) { touched.current = false; setStatus('✓ Saved'); seed() }
      else setStatus(`✗ ${res.error ?? 'Failed to save'}`)
    } catch (e: any) {
      setStatus(`✗ ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  // Default first — the same order the menu uses for its `＋ New <Agent> session` rows.
  const orderedAgentForms = [...AGENT_FORM_LIST].sort((a, b) => Number(b.id === defaultAgent) - Number(a.id === defaultAgent))

  return (
    <section className="settings-section">
      <h2>Agents</h2>
      <p className="settings-note">
        Which agent CLIs are <strong>installed</strong> on this machine (detected on your PATH), which one
        is the <strong>default</strong>, and an optional per-agent <strong>pre-launch command</strong> run
        in the project folder right before that agent starts a session there. Placeholders <code>{'{dir}'}</code> (absolute
        project path) and <code>{'{name}'}</code> (folder name) are substituted, and a leading <code>~</code> expands
        to your home dir. A failing hook never blocks the launch — it's logged and the agent starts
        anyway. A hook can only be configured for a detected agent. Saved to your committed config.
      </p>
      <div className="settings-row">
        <label title="The agent the Jamat menu lists first and preselects on its 'New session' rows. The menu still offers the other installed agents — this only decides the default.">Default agent</label>
        <select value={defaultAgent} onChange={e => { touched.current = true; setStatus(null); setDefaultAgent(e.target.value as AgentFormId) }}>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </div>
      {orderedAgentForms.map(({ id, label }) => {
        const f = forms[id]
        const meta = agentsMeta?.find(m => m.id === id)
        const detecting = agentsMeta === null
        const available = meta?.available ?? false
        const name = meta?.displayName ?? label
        return (
          <div className="settings-agent-block" key={id}>
            <div className="settings-row">
              <label><strong>{name}</strong></label>
              {detecting
                ? <span className="agent-status detecting">Detecting…</span>
                : available
                  ? <span className="agent-status ok" title={`${meta?.binary ?? id} found on PATH`}>● Installed</span>
                  : <span className="agent-status off" title={`${meta?.binary ?? id} not found on PATH`}>○ Not installed</span>}
            </div>
            <div className="settings-row">
              <label title={available ? 'Run a command in the project folder before this agent starts a session there.' : `Install the ${name} CLI to configure a pre-launch hook.`}>Pre-launch hook</label>
              <input
                type="checkbox"
                checked={f.enabled}
                disabled={detecting || !available}
                onChange={e => setField(id, 'enabled', e.target.checked)}
              />
              {!detecting && !available && <span className="settings-note">install {name} to enable</span>}
            </div>
            {f.enabled && (
              <>
                <div className="settings-row">
                  <label>Command</label>
                  <input type="text" value={f.command} placeholder="node" disabled={!available} onChange={e => setField(id, 'command', e.target.value)} />
                </div>
                <div className="settings-row">
                  <label title="One argument per line. {dir}/{name} substituted; leading ~ expanded.">Arguments (one per line)</label>
                  <textarea
                    rows={4}
                    value={f.args}
                    disabled={!available}
                    placeholder={'~/.some-tool/prepare.mjs\n--dir\n{dir}'}
                    onChange={e => setField(id, 'args', e.target.value)}
                  />
                </div>
                <div className="settings-row">
                  <label title="Working dir for the command. Blank = the project dir being launched.">Working dir (optional)</label>
                  <input type="text" value={f.cwd} placeholder="{dir}" disabled={!available} onChange={e => setField(id, 'cwd', e.target.value)} />
                </div>
                <div className="settings-row">
                  <label title="Kill the hook after this many ms. Blank = 20000.">Timeout ms (optional)</label>
                  <input type="number" min={1} value={f.timeout} placeholder="20000" disabled={!available} onChange={e => setField(id, 'timeout', e.target.value)} />
                </div>
              </>
            )}
          </div>
        )
      })}
      <div className="settings-actions">
        <button className="settings-save-btn" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        {status && <span className="settings-note">{status}</span>}
      </div>
    </section>
  )
}

/**
 * Editor for `selfUpdate` — KNOBS ONLY, plus a live status block. The channel is NOT editable: it is
 * derived from the runtime (installed → GitHub Releases; source checkout → compare against the sources
 * on disk; unsigned macOS install → none). The old channel selector defaulted to "vcs" and, once
 * saved, silently disabled GitHub updates on an installed build — that footgun is gone by construction.
 * Gated by an "enable" toggle so opening the tab and saving never MATERIALIZES a selfUpdate block on a
 * config that had none.
 */
function UpdatesEditor() {
  const [st, setSt] = useState<UpdateStatus | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [autoCheck, setAutoCheck] = useState(true)
  const [interval, setIntervalMin] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const touched = useRef(false)

  const loadStatus = useCallback(() => {
    void window.electronAPI.getUpdateStatus?.().then(setSt).catch(() => {})
  }, [])

  const seed = useCallback(() => {
    void window.electronAPI.getRawConfig().then((raw) => {
      if (touched.current || !raw) return
      const su = (raw.selfUpdate ?? null) as SelfUpdateConfig | null
      setEnabled(su !== null)
      setAutoCheck(su?.autoCheck !== false)
      setIntervalMin(su?.checkIntervalMinutes != null ? String(su.checkIntervalMinutes) : '')
    }).catch(() => {})
  }, [])
  useEffect(() => { seed(); loadStatus(); return window.electronAPI.onConfigChanged?.(() => { seed(); loadStatus() }) }, [seed, loadStatus])

  const mark = () => { touched.current = true; setStatus(null) }
  const save = async () => {
    if (!enabled) { setStatus('Updates stay on their defaults. Enable to tune the knobs.'); return }
    const su: SelfUpdateConfig = { autoCheck }
    if (interval.trim()) {
      const n = parseInt(interval, 10)
      if (!Number.isFinite(n) || n <= 0) { setStatus('✗ Check interval must be a positive number of minutes'); return }
      su.checkIntervalMinutes = n
    }
    setSaving(true); setStatus(null)
    try {
      const res = await window.electronAPI.updateConfig({ selfUpdate: su })
      if (res.ok) { touched.current = false; setStatus('✓ Saved'); loadStatus() }
      else setStatus(`✗ ${res.error ?? 'Failed to save'}`)
    } catch (e: any) {
      setStatus(`✗ ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  const checkNow = async () => {
    setStatus(null)
    try { await window.electronAPI.checkForUpdates?.(); setTimeout(loadStatus, 1500) }
    catch (e: any) { setStatus(`✗ ${e.message}`) }
  }

  const channelLabel: Record<UpdateStatus['channel'], string> = {
    github: 'GitHub Releases (installed build)',
    source: 'Source checkout (compares against the sources on disk)',
    none: 'No update channel',
  }

  return (
    <section className="settings-section">
      <h2>Updates</h2>
      <p className="settings-note">
        The update channel follows how this build RUNS, not the config: an installed build updates from
        GitHub Releases; a build started from a source checkout never checks the network — it compares
        itself to the sources on disk and offers a restart (the launcher recompiles), so updating the
        sources stays your job. Every check, download, prompt — and every prompt that was SUPPRESSED,
        with the reason — is written to <code>update-log.jsonl</code> in your config folder.
      </p>

      {st && (
        <div className="settings-agent-block">
          <div className="settings-row">
            <label><strong>Channel</strong></label>
            <span className={`agent-status ${st.channel === 'none' ? 'off' : 'ok'}`}>{channelLabel[st.channel]}</span>
          </div>
          <div className="settings-row"><label>Why</label><span className="settings-note">{st.reason}</span></div>
          <div className="settings-row"><label>Running version</label><span className="settings-note">{st.running}</span></div>
          <div className="settings-row">
            <label>Last check</label>
            <span className="settings-note">
              {st.lastCheckAt ? `${new Date(st.lastCheckAt).toLocaleString()} — ${st.lastCheckOutcome ?? ''}` : 'not yet'}
            </span>
          </div>
          {st.pendingVersion && (
            <div className="settings-row">
              <label>Pending</label>
              <span className="settings-note">{st.pendingVersion} — waiting for a restart{st.snoozedUntil > Date.now() ? ` (snoozed until ${new Date(st.snoozedUntil).toLocaleTimeString()})` : ''}</span>
            </div>
          )}
          {st.warnings.map((w) => (
            <div className="settings-row" key={w}>
              <label>⚠ Config</label>
              <span className="settings-note">{w}</span>
            </div>
          ))}
          <div className="settings-actions">
            <button className="settings-add-btn" onClick={() => void checkNow()}>Check now</button>
          </div>
        </div>
      )}

      <div className="settings-row">
        <label title="Materializes a selfUpdate block in your config so the knobs below persist.">Tune update settings</label>
        <input type="checkbox" checked={enabled} onChange={e => { mark(); setEnabled(e.target.checked) }} />
      </div>
      {enabled && (
        <>
          <div className="settings-row">
            <label title="Check in the background and prompt when all tabs are idle. The manual check always works.">Background auto-check</label>
            <input type="checkbox" checked={autoCheck} onChange={e => { mark(); setAutoCheck(e.target.checked) }} />
          </div>
          <div className="settings-row">
            <label title="Blank = 120 min for an installed build, 15 min for a source checkout.">Check interval (minutes)</label>
            <input type="number" min={1} value={interval} placeholder="(default)" disabled={!autoCheck} onChange={e => { mark(); setIntervalMin(e.target.value) }} />
          </div>
          <p className="settings-note">Background settings apply after a restart; “Check now” always uses the current settings.</p>
        </>
      )}
      <div className="settings-actions">
        <button className="settings-save-btn" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        {status && <span className="settings-note">{status}</span>}
      </div>
    </section>
  )
}

/**
 * Recursive editor for `customMenus` — the F3 project-action menus (groups that nest + commands that
 * run against the selected project). Seeds from the raw on-disk config; the server re-sanitizes via
 * `parseCustomMenus`, so incomplete nodes are dropped, but we validate client-side first to warn
 * rather than silently lose a row. Persists via `config:update`.
 */
function CustomMenusEditor() {
  const [nodes, setNodes] = useState<CustomMenuNode[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const touched = useRef(false)

  const seed = useCallback(() => {
    void window.electronAPI.getRawConfig().then((raw) => {
      if (touched.current) return
      setNodes(Array.isArray(raw?.customMenus) ? (raw!.customMenus as CustomMenuNode[]) : [])
    }).catch(() => {})
  }, [])
  useEffect(() => { seed(); return window.electronAPI.onConfigChanged?.(() => seed()) }, [seed])

  const apply = useCallback((fn: (n: CustomMenuNode[]) => CustomMenuNode[]) => {
    touched.current = true; setStatus(null); setNodes(prev => fn(prev))
  }, [])

  const save = async () => {
    const err = firstMenuError(nodes)
    if (err) { setStatus(`✗ ${err}`); return }
    setSaving(true); setStatus(null)
    try {
      const res = await window.electronAPI.updateConfig({ customMenus: nodes })
      if (res.ok) { touched.current = false; setStatus('✓ Saved'); seed() }
      else setStatus(`✗ ${res.error ?? 'Failed to save'}`)
    } catch (e: any) {
      setStatus(`✗ ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-section">
      <h2>Project menus</h2>
      <p className="settings-note">
        Custom actions on <kbd>F3</kbd> for a (non-isolated) project — groups that nest and commands
        that run against the selected project (<code>{'{dir}'}</code> / <code>{'{name}'}</code> are
        substituted). Leave empty for none. Saved to your committed config.
      </p>
      <div className="cm-tree">
        {nodes.length === 0 && <div className="settings-note sdp-empty">No custom menus yet. Add a group or a command.</div>}
        {nodes.map((n, i) => (
          <MenuNodeRow key={i} node={n} path={[i]} siblings={nodes.length} apply={apply} />
        ))}
      </div>
      <div className="settings-actions">
        <button className="settings-add-btn" onClick={() => apply(ns => [...ns, newBranch()])}>+ Add group</button>
        <button className="settings-add-btn" onClick={() => apply(ns => [...ns, newLeaf()])}>+ Add command</button>
        <button className="settings-save-btn" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save menus'}</button>
        {status && <span className="settings-note">{status}</span>}
      </div>
    </section>
  )
}

function MenuNodeRow({ node, path, siblings, apply }: {
  node: CustomMenuNode
  path: MenuPath
  siblings: number
  apply: (fn: (n: CustomMenuNode[]) => CustomMenuNode[]) => void
}) {
  const i = path[path.length - 1]
  const isBranch = !!node.items
  const setField = (patch: Partial<CustomMenuNode>) => apply(ns => mutateNode(ns, path, n => ({ ...n, ...patch })))
  const setRun = (patch: Partial<CustomRun>) => apply(ns => mutateNode(ns, path, n => ({ ...n, run: { command: '', ...n.run, ...patch } })))
  const setKind = (kind: 'branch' | 'leaf') => apply(ns => mutateNode(ns, path, n =>
    kind === 'branch'
      ? { label: n.label, key: n.key, items: n.items ?? [] }
      : { label: n.label, key: n.key, run: n.run ?? { command: '' } }))

  return (
    <div className="cm-node">
      <div className="cm-row">
        <select className="cm-kind" value={isBranch ? 'branch' : 'leaf'} onChange={e => setKind(e.target.value as 'branch' | 'leaf')}>
          <option value="branch">Group</option>
          <option value="leaf">Command</option>
        </select>
        <input className="cm-label" type="text" value={node.label} placeholder={isBranch ? 'Group name' : 'Command name'} onChange={e => setField({ label: e.target.value })} />
        <input className="cm-key" type="text" value={node.key ?? ''} placeholder="key (f1)" onChange={e => setField({ key: e.target.value || undefined })} />
        <div className="sdp-row-actions">
          <button title="Move up" onClick={() => apply(ns => moveNode(ns, path, -1))} disabled={i === 0}>↑</button>
          <button title="Move down" onClick={() => apply(ns => moveNode(ns, path, 1))} disabled={i === siblings - 1}>↓</button>
          <button title="Remove" className="sdp-remove" onClick={() => apply(ns => deleteNode(ns, path))}>✕</button>
        </div>
      </div>
      {!isBranch && (
        <div className="cm-leaf">
          <div className="settings-row"><label>Command</label><input type="text" value={node.run?.command ?? ''} placeholder="npm" onChange={e => setRun({ command: e.target.value })} /></div>
          <div className="settings-row"><label>Args (space-separated)</label><input type="text" value={(node.run?.args ?? []).join(' ')} placeholder="run build {dir}" onChange={e => setRun({ args: e.target.value.split(/\s+/).filter(Boolean) })} /></div>
          <div className="settings-row"><label>Working dir (optional)</label><input type="text" value={node.run?.cwd ?? ''} placeholder="{dir}" onChange={e => setRun({ cwd: e.target.value || undefined })} /></div>
          <div className="settings-row"><label title="CLI host only: wait for a keypress after the command finishes.">Pause after run</label><input type="checkbox" checked={node.run?.pause !== false} onChange={e => setRun({ pause: e.target.checked })} /></div>
        </div>
      )}
      {isBranch && (
        <div className="cm-children">
          {(node.items ?? []).map((c, k) => (
            <MenuNodeRow key={k} node={c} path={[...path, k]} siblings={(node.items ?? []).length} apply={apply} />
          ))}
          <button className="settings-add-btn cm-add-child" onClick={() => apply(ns => mutateNode(ns, path, n => ({ ...n, items: [...(n.items ?? []), newLeaf()] })))}>+ command</button>
          <button className="settings-add-btn cm-add-child" onClick={() => apply(ns => mutateNode(ns, path, n => ({ ...n, items: [...(n.items ?? []), newBranch()] })))}>+ group</button>
        </div>
      )}
    </div>
  )
}

/**
 * Editor for `sessionDonePrompts` — the one-click buttons in the bottom-right session-done popup.
 * Reads the current list from the loaded app config, lets the user add / edit / reorder / delete
 * rows, and persists via `config:update` (writes the committed config-<user>.json).
 * On success the store's appConfig is updated so the popup picks up the change without a reload.
 * Leaving the list empty falls back to the built-in defaults.
 */
function QuickPromptsEditor() {
  const appConfig = useLayoutStore(s => s.appConfig)
  const setAppConfig = useLayoutStore(s => s.setAppConfig)
  const [rows, setRows] = useState<SessionDonePrompt[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Don't clobber in-progress edits when appConfig re-publishes; only seed from config until touched.
  const touched = useRef(false)
  const configFile = appConfig?.configPath?.split(/[\\/]/).pop() ?? 'config-<user>.json'

  useEffect(() => {
    if (touched.current) return
    setRows((appConfig?.sessionDonePrompts ?? []).map(p => ({ ...p })))
  }, [appConfig])

  const edit = (i: number, key: keyof SessionDonePrompt, value: string) => {
    touched.current = true
    setStatus(null)
    setRows(prev => prev.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)))
  }
  const add = () => {
    touched.current = true
    setStatus(null)
    setRows(prev => [...prev, { label: '', prompt: '' }])
  }
  const remove = (i: number) => {
    touched.current = true
    setStatus(null)
    setRows(prev => prev.filter((_, idx) => idx !== i))
  }
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rows.length) return
    touched.current = true
    setStatus(null)
    setRows(prev => {
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  const save = async () => {
    const cleaned = rows.map(r => ({ label: r.label.trim(), prompt: r.prompt.trim() }))
    const bad = cleaned.findIndex(r => !r.label || !r.prompt)
    if (bad !== -1) {
      setStatus(`✗ Row ${bad + 1}: both label and prompt are required`)
      return
    }
    setSaving(true)
    setStatus(null)
    try {
      const res = await window.electronAPI.updateConfig({ sessionDonePrompts: cleaned })
      if (res.ok) {
        setRows(cleaned)
        touched.current = false
        if (appConfig) setAppConfig({ ...appConfig, sessionDonePrompts: cleaned })
        setStatus('✓ Saved')
      } else {
        setStatus(`✗ ${res.error ?? 'Failed to save'}`)
      }
    } catch (e: any) {
      setStatus(`✗ ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-section">
      <h2>Quick prompts</h2>
      <p className="settings-note">
        Buttons shown in the bottom-right popup when Claude finishes a turn on the active tab. Each
        button types its prompt into that session and submits it (Enter). Leave the list empty to use
        the built-in defaults (<code>Continue</code>, <code>Summarize</code>). Saved to your
        committed <code>{configFile}</code>.
      </p>

      <div className="sdp-editor">
        <div className="sdp-head">
          <span>Label (button)</span>
          <span>Prompt (sent + Enter)</span>
          <span />
        </div>
        {rows.length === 0 && (
          <div className="settings-note sdp-empty">No prompts — defaults will be used. Click “Add prompt”.</div>
        )}
        {rows.map((r, i) => (
          <div className="sdp-row" key={i}>
            <input
              type="text"
              className="sdp-label"
              value={r.label}
              placeholder="Continue"
              onChange={e => edit(i, 'label', e.target.value)}
            />
            <input
              type="text"
              className="sdp-prompt"
              value={r.prompt}
              placeholder="What should we do next?"
              onChange={e => edit(i, 'prompt', e.target.value)}
            />
            <div className="sdp-row-actions">
              <button title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button title="Move down" onClick={() => move(i, 1)} disabled={i === rows.length - 1}>↓</button>
              <button title="Remove" className="sdp-remove" onClick={() => remove(i)}>✕</button>
            </div>
          </div>
        ))}
      </div>

      <div className="settings-actions">
        <button className="settings-add-btn" onClick={add}>+ Add prompt</button>
        <button className="settings-save-btn" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save prompts'}
        </button>
        {status && <span className="settings-note">{status}</span>}
      </div>
    </section>
  )
}

/**
 * Editor for `contextLevels` — the 4 FIXED context-fullness warning levels. The count is fixed at 4
 * (no add/remove/reorder); each row sets the % threshold and whether that level raises the centered
 * compact overlay (`popup`) and/or the passive status-bar + tab colour (`statusBar`). Seeds from the
 * loaded config or DEFAULT_CONTEXT_LEVELS, persists via `config:update`, and updates the store so the
 * status bar / overlay react live. The severity colour is derived by pct rank, not edited here.
 */
function ContextLevelsEditor() {
  const appConfig = useLayoutStore(s => s.appConfig)
  const setAppConfig = useLayoutStore(s => s.setAppConfig)
  const [rows, setRows] = useState<ContextWarnLevel[]>(DEFAULT_CONTEXT_LEVELS)
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Don't clobber in-progress edits when appConfig re-publishes; only seed from config until touched.
  const touched = useRef(false)
  const configFile = appConfig?.configPath?.split(/[\\/]/).pop() ?? 'config-<user>.json'

  useEffect(() => {
    if (touched.current) return
    const cl = appConfig?.contextLevels
    setRows((cl && cl.length === 4 ? cl : DEFAULT_CONTEXT_LEVELS).map(l => ({ ...l })))
  }, [appConfig])

  const editPct = (i: number, value: string) => {
    touched.current = true
    setStatus(null)
    const n = Math.round(Number(value))
    setRows(prev => prev.map((r, idx) => (idx === i ? { ...r, pct: Number.isFinite(n) ? n : 0 } : r)))
  }
  const toggle = (i: number, key: 'popup' | 'statusBar') => {
    touched.current = true
    setStatus(null)
    setRows(prev => prev.map((r, idx) => (idx === i ? { ...r, [key]: !r[key] } : r)))
  }
  const reset = () => {
    touched.current = true
    setStatus(null)
    setRows(DEFAULT_CONTEXT_LEVELS.map(l => ({ ...l })))
  }

  const save = async () => {
    const cleaned: ContextWarnLevel[] = rows.map(r => ({ pct: Math.round(r.pct), popup: !!r.popup, statusBar: !!r.statusBar }))
    const bad = cleaned.findIndex(r => !Number.isFinite(r.pct) || r.pct < 0 || r.pct > 100)
    if (bad !== -1) {
      setStatus(`✗ Level ${bad + 1}: % must be between 0 and 100`)
      return
    }
    setSaving(true)
    setStatus(null)
    try {
      const res = await window.electronAPI.updateConfig({ contextLevels: cleaned })
      if (res.ok) {
        setRows(cleaned)
        touched.current = false
        if (appConfig) setAppConfig({ ...appConfig, contextLevels: cleaned })
        setStatus('✓ Saved')
      } else {
        setStatus(`✗ ${res.error ?? 'Failed to save'}`)
      }
    } catch (e: any) {
      setStatus(`✗ ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-section">
      <h2>Context warnings</h2>
      <p className="settings-note">
        Four fixed levels that warn as a Claude session's context window fills up. For each level set
        the <strong>%</strong> threshold and whether it shows the centered <strong>popup</strong> (the
        “Compact now?” card — only while the session is idle) and/or a passive <strong>status bar</strong>
        colour on the token counter + tab. The Compact button in the status bar appears above the lowest
        threshold; the colour severity (info→amber→orange→red) follows the % order. Saved to your
        committed <code>{configFile}</code>.
      </p>

      <div className="ctxlvl-editor">
        <div className="ctxlvl-head">
          <span>Level</span>
          <span>Threshold %</span>
          <span>Popup</span>
          <span>Status bar</span>
        </div>
        {rows.map((r, i) => (
          <div className="ctxlvl-row" key={i}>
            <span className="ctxlvl-idx">{i + 1}</span>
            <input
              type="number"
              min={0}
              max={100}
              className="ctxlvl-pct"
              value={r.pct}
              onChange={e => editPct(i, e.target.value)}
            />
            <label className="ctxlvl-check">
              <input type="checkbox" checked={r.popup} onChange={() => toggle(i, 'popup')} />
            </label>
            <label className="ctxlvl-check">
              <input type="checkbox" checked={r.statusBar} onChange={() => toggle(i, 'statusBar')} />
            </label>
          </div>
        ))}
      </div>

      <div className="settings-actions">
        <button className="settings-add-btn" onClick={reset}>Reset to defaults</button>
        <button className="settings-save-btn" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save levels'}
        </button>
        {status && <span className="settings-note">{status}</span>}
      </div>
    </section>
  )
}

/**
 * Claude.ai usage credentials for the status-bar S / W % indicator. Persisted by main into the
 * gitignored config overlay (`config-<user>.local.json`), never localStorage; the session key is
 * never read back (only `hasSessionKey`), so the field starts blank and "leave blank to keep
 * current" preserves the stored one.
 */
function UsageCredentials() {
  const [usageOrgId, setUsageOrgId] = useState('')
  const [usageSessionKey, setUsageSessionKey] = useState('')
  const [usageHasKey, setUsageHasKey] = useState(false)
  const [usageStatus, setUsageStatus] = useState<string | null>(null)
  const [usageSaving, setUsageSaving] = useState(false)

  useEffect(() => {
    window.electronAPI.getUsageCredentials()
      .then(c => { setUsageOrgId(c.orgId); setUsageHasKey(c.hasSessionKey) })
      .catch(() => {})
  }, [])

  const handleSaveUsage = async () => {
    setUsageSaving(true)
    setUsageStatus(null)
    try {
      const res = await window.electronAPI.setUsageCredentials(usageOrgId, usageSessionKey)
      if (res.ok) {
        setUsageSessionKey('')
        setUsageHasKey(true)
        setUsageStatus(res.error ? `⚠ ${res.error}` : '✓ Saved')
      } else {
        setUsageStatus(`✗ ${res.error ?? 'Failed to save'}`)
      }
    } catch (e: any) {
      setUsageStatus(`✗ ${e.message}`)
    } finally {
      setUsageSaving(false)
    }
  }

  return (
    <section className="settings-section">
      <h2>Status detection (Claude.ai usage)</h2>
      <p className="settings-note">
        Credentials for the status-bar usage indicator (S / W %). Stored locally in your
        gitignored config overlay — never committed. From claude.ai while logged in: the
        Organization ID is in the usage API URL; the Session Key is the <code>sessionKey</code> cookie.
      </p>
      <div className="settings-row">
        <label>Organization ID</label>
        <input
          type="text"
          value={usageOrgId}
          onChange={e => setUsageOrgId(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
        />
      </div>
      <div className="settings-row">
        <label>Session Key</label>
        <input
          type="password"
          value={usageSessionKey}
          onChange={e => setUsageSessionKey(e.target.value)}
          placeholder={usageHasKey ? '•••••••• (leave blank to keep current)' : 'sessionKey cookie value'}
          autoComplete="off"
        />
      </div>
      <div className="settings-actions">
        <button className="settings-save-btn" onClick={handleSaveUsage} disabled={usageSaving}>
          {usageSaving ? 'Saving…' : 'Save credentials'}
        </button>
        {usageStatus && <span className="settings-note">{usageStatus}</span>}
      </div>
    </section>
  )
}

/**
 * Read-only "Info" tab: where Jamat resolves its config + state from. Surfaces the config-dir
 * provenance (explicit `--config-dir` / `JAMAT_CONFIG_DIR` vs the default `~/.jamat`) and every
 * resolved path — so a fresh-looking workspace (e.g. after switching to a synced config-dir whose
 * `app-state.json` doesn't hold the windows yet) is diagnosable at a glance instead of a mystery.
 */
function AppInfo() {
  const [paths, setPaths] = useState<AppPathsInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    window.electronAPI.getAppPaths?.()
      .then(setPaths)
      .catch((e: any) => setError(e?.message ?? 'Failed to load paths'))
  }, [])

  const copy = (value: string) => {
    void window.electronAPI.writeClipboard?.(value)
    setCopied(value)
    setTimeout(() => setCopied(c => (c === value ? null : c)), 1500)
  }

  if (error) return (
    <section className="settings-section"><h2>Info</h2><p className="settings-note">✗ {error}</p></section>
  )
  if (!paths) return (
    <section className="settings-section"><h2>Info</h2><p className="settings-note">Loading…</p></section>
  )

  const rows: { label: string; value: string; hint?: string }[] = [
    { label: 'Config file', value: paths.configFile, hint: 'The loaded config.json' },
    { label: 'Secret overlay', value: paths.configOverlay, hint: 'config.local.json — gitignored secrets (usage credentials)' },
    { label: 'App state', value: paths.appState, hint: 'Windows, saved windows (groups), tab layouts, notes' },
    { label: 'Snapshots', value: paths.snapshotsDir, hint: 'Per-launch app-state recovery points' },
    { label: 'Usage cache', value: paths.usageCache },
    { label: 'Stats', value: paths.statsDir },
    { label: 'User data (per-machine)', value: paths.userDataDir, hint: 'Electron caches only — never synced' },
    { label: 'Machine key', value: paths.remoteControl, hint: 'remote-control.json — machine key + peers, now in the config-dir' },
    { label: 'App version', value: paths.appVersion },
  ]

  return (
    <section className="settings-section">
      <h2>Info</h2>
      <p className="settings-note">
        Where Jamat reads its config and state from. The config-dir is resolved from{' '}
        <code>--config-dir</code> / <code>JAMAT_CONFIG_DIR</code>, or the default <code>~/.jamat</code>.
      </p>
      <div className="info-grid">
        <div className="info-row">
          <span className="info-label">Config source</span>
          <span className="info-source">
            {paths.explicit ? 'Explicit — --config-dir / JAMAT_CONFIG_DIR' : 'Default — ~/.jamat'}
          </span>
          <span />
        </div>
        <div className="info-row">
          <span className="info-label">Config dir</span>
          <code className="info-value" title="The portable dir holding config + app-state + caches">{paths.configDir}</code>
          <button className="info-copy" onClick={() => copy(paths.configDir)}>{copied === paths.configDir ? '✓' : '⧉'}</button>
        </div>
        {rows.map(r => (
          <div className="info-row" key={r.label}>
            <span className="info-label" title={r.hint}>{r.label}</span>
            <code className="info-value" title={r.hint}>{r.value}</code>
            <button className="info-copy" onClick={() => copy(r.value)}>{copied === r.value ? '✓' : '⧉'}</button>
          </div>
        ))}
      </div>
    </section>
  )
}
