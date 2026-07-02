import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, unlinkSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { createPty, writeToPty, resizePty, destroyAll, gracefulDestroyAll } from './pty-manager'
import { startMenuInTerminal, restoreClaudeInTerminal, cleanupTerminal, updateTerminalSize, resumeClaudeInTerminal } from './screen-executor'
import { loadNotes, saveNotes } from './notes-manager'
import { loadIdeas, saveIdeas } from './ideas-manager'
import { getGroups, createGroup, deleteGroup, renameGroup, setGroupColor, getGroupForWindow } from './groups-manager'
import { createWindowIcon, clearIconCache } from './icon-generator'
import { setIsRestarting } from './app-state'
import { WINDOW_COLORS } from '../shared/window-colors'
import { logError } from './logger'
import { registerHandler, registerSend } from '../shared/typed-ipc'
import { publish, publishTo, publishToFocused } from './streams'
import { saveWindowState, loadWindowState, type WindowBounds, type WindowStateEntry } from './window-state-manager'
import { flushAppStateNow, getOnboardingComplete, isOnboardingDecided, setOnboardingComplete } from './app-state-store'
import { getJamatPaths } from './jamat-paths'
import { getMonorepoRoot, getAppVersion } from './app-root'
import { loadConfig as loadCoreConfig, ensureConfig, validateConfigPatch, writeConfigPatch } from '../../../core/config.js'
import type { AppConfig, ConfigPatch } from '../../../core/types.js'
import type { PtyConfig } from '../shared/types'
import type { ScreenOpenTabMeta, AppPathsInfo } from '../../../core/types/ipc-contracts.js'

const windows = new Map<string, BrowserWindow>()
let windowCounter = 1

let rebuildMenuTimer: ReturnType<typeof setTimeout> | null = null
function debouncedRebuildMenu(): void {
  if (rebuildMenuTimer) clearTimeout(rebuildMenuTimer)
  rebuildMenuTimer = setTimeout(() => { rebuildMenuTimer = null; rebuildMenu() }, 100)
}

let appConfig: AppConfig | null = null
let menuDir: string = ''
let menuConfigPath: string = ''
// Set by resolveConfigPath when a starter config is created on first run; consumed once by
// loadScreenConfig to show the welcome dialog after the config loads.
let firstRunConfigPath: string | null = null

function resolveConfigPath(): string | null {
  // The portable config-dir was resolved once in bootstrap-userdata (JAMAT_CONFIG_DIR / --config-dir
  // → ~/.jamat[-debug]) and published as the JamatPaths singleton. Config is always
  // `<configDir>/config.json`; if absent, seed a starter there → the onboarding wizard.
  const { configDir, configFile } = getJamatPaths()
  logError('config', `config-dir=${configDir} configFile=${configFile} packaged=${app.isPackaged}`)
  try {
    const { path: starterPath, created: wasCreated } = ensureConfig(configFile, join(getMonorepoRoot(), 'configs', 'config.example.json'))
    if (wasCreated) {
      logError('config', `First run: created starter config at ${starterPath}`)
      firstRunConfigPath = starterPath
    }
    return starterPath
  } catch (e: any) {
    logError('config', `Config resolve/seed failed (configFile=${configFile}): ${e.message}`)
    return null
  }
}

export async function loadScreenConfig(): Promise<void> {
  const configPath = resolveConfigPath()
  if (!configPath) return

  try {
    appConfig = loadCoreConfig(configPath)
    const root = getMonorepoRoot()
    menuDir = join(root, 'app-cli')
    menuConfigPath = configPath
    logError('config', `Loaded: ${appConfig.name} from ${configPath}`)
    if (appConfig.skippedCategories?.length) {
      const list = appConfig.skippedCategories.map((c) => `${c.label} (${c.path})`).join(', ')
      logError('config', `Skipped ${appConfig.skippedCategories.length} unavailable categor${appConfig.skippedCategories.length === 1 ? 'y' : 'ies'}: ${list}`)
    }
    // First-run decision — drives the renderer's in-app guided onboarding (auto-opens Settings)
    // instead of a static welcome dialog:
    //  - a starter config was just seeded → brand-new install → mark "needs onboarding" (false).
    //  - else a real config already existed and the flag was never set → a pre-existing user
    //    upgrading → mark complete so the guided flow doesn't nag someone already set up.
    if (firstRunConfigPath) {
      firstRunConfigPath = null
      setOnboardingComplete(false)
    } else if (!isOnboardingDecided()) {
      setOnboardingComplete(true)
    }
  } catch (e: any) {
    logError('config', `Failed to load ${configPath}: ${e.message}`)
    console.error('[config] Failed to load:', e.message)
  }
}

export function getAppConfig(): AppConfig | null { return appConfig }
export function getWindows(): Map<string, BrowserWindow> { return windows }
export function getMenuDir(): string { return menuDir }
export function getMenuConfigPath(): string { return menuConfigPath }
export function setWindowStateManager() {} // placeholder for window state manager hooks

// True between `before-quit` and shutdown — suppresses the per-window saves
// that `win.on('closed')` would otherwise do during the quit cascade (each
// would overwrite the snapshot taken in `before-quit` with a smaller set,
// ending in `{}`). The before-quit handler in registerWindowIpc captures the
// full set of still-open windows once; the 'close' handler captures the
// single-X-on-last-window case where before-quit fires too late.
let isQuitting = false
// Latch so the graceful PTY shutdown (held in before-quit) runs exactly once — the second
// before-quit pass (after gracefulDestroyAll re-calls app.quit) must fall through to a real quit.
let gracefulShutdownDone = false

/**
 * Accept a saved rectangle only if it still overlaps a connected display's work
 * area (by more than a titlebar sliver) — so a window last positioned on a now
 * disconnected monitor doesn't restore off-screen and unreachable. Returns the
 * bounds when usable, else undefined (→ caller falls back to the default size).
 */
function visibleBounds(b?: WindowBounds): WindowBounds | undefined {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !(b.width > 0) || !(b.height > 0)) return undefined
  const onScreen = screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    const overlapW = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x)
    const overlapH = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y)
    return overlapW > 80 && overlapH > 40
  })
  return onScreen ? b : undefined
}

export function persistWindowState(): void {
  const state: Record<string, WindowStateEntry> = {}
  for (const [id, win] of windows) {
    if (win.isDestroyed()) continue
    // getNormalBounds = the UN-maximized rect even while maximized, so un-maximizing
    // after restore lands in the right place; isMaximized restores the maximized state.
    const bounds = win.getNormalBounds()
    const isMaximized = win.isMaximized()
    // Named iff a group owns this window — born-named (id === group id) OR an unnamed window
    // that was named in place (group.windowId === id). getGroupForWindow covers both.
    const group = getGroupForWindow(id)
    if (group) {
      state[id] = { groupName: group.name, groupColor: group.color, isNew: false, bounds, isMaximized }
    } else {
      // Unnamed window — windowId is just a counter handle; preserve it so
      // restore doesn't accidentally collide with a still-open named id.
      state[id] = { isNew: false, bounds, isMaximized }
    }
  }
  saveWindowState(state)
}

/**
 * Tear down every window + pty and restart the app in-process, restoring ALL
 * windows that were open (named + unnamed). Snapshots the live window set
 * first so the restore covers more than just window 0. Shared by the
 * "Full Restart" menu item and the /debug/restart endpoint.
 */
export function restartAllWindows(): void {
  setIsRestarting(true)
  clearIconCache()
  // Snapshot the live windows before destroying them — the restore loop below
  // reads this back, so every open window comes back, not just window 0.
  persistWindowState()
  destroyAll()
  for (const win of BrowserWindow.getAllWindows()) {
    win.removeAllListeners('close')
    win.removeAllListeners('closed')
    win.destroy()
  }
  windows.clear()
  loadScreenConfig().then(() => {
    rebuildMenu()
    // Staggered restore (first window immediate, rest spaced) — see restoreSavedWindows.
    // The first window exists synchronously, so clearing isRestarting here can't let a
    // transient zero-window moment trip window-all-closed during the stagger.
    restoreSavedWindows(loadWindowState())
    setIsRestarting(false)
  })
}

export function createAppWindow(opts?: { windowId?: string; groupName?: string; groupColor?: string; isNew?: boolean; initialFile?: string; bounds?: WindowBounds; isMaximized?: boolean }): void {
  const id = opts?.windowId ?? String(windowCounter++)
  // Restored windows carry their original numeric id (for unnamed) or
  // `group-<ts>` (for named). Bump the counter past any numeric restored id
  // so a subsequent auto-generated unnamed id can't collide with one we just
  // recreated.
  const numericId = Number(id)
  if (Number.isInteger(numericId) && numericId >= windowCounter) {
    windowCounter = numericId + 1
  }

  // Restore the saved position+size for this exact windowId (named or unnamed) when it
  // still lands on a connected display; otherwise fall back to the default centered 1200×800.
  const savedBounds = visibleBounds(opts?.bounds)
  const win = new BrowserWindow({
    ...(savedBounds ?? { width: 1200, height: 800 }),
    backgroundColor: '#1e1e1e',
    show: false,
    title: opts?.groupName ? `Jamat — ${opts.groupName}` : 'Jamat',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  windows.set(id, win)

  win.setIcon(createWindowIcon(opts?.groupColor))

  win.on('ready-to-show', () => {
    // Restore the saved maximized state; else, with no saved bounds, keep the original
    // behavior of maximizing the very first window on a fresh launch. A window restored
    // to explicit saved bounds is left exactly as constructed.
    if (opts?.isMaximized) win.maximize()
    else if (!savedBounds && windows.size === 1) win.maximize()
    win.show()
  })

  win.on('focus', () => debouncedRebuildMenu())

  // Fires before destruction — `windows` still contains this window. If this
  // is the last one and we're NOT inside a `before-quit` cascade (i.e. the
  // user clicked X on the only window), snapshot the full set including this
  // window so it gets restored next launch. The `before-quit` handler would
  // fire too late here: by then `windows` is already empty.
  win.on('close', () => {
    if (windows.size === 1 && !isQuitting) persistWindowState()
  })

  win.on('closed', () => {
    windows.delete(id)
    rebuildMenu()
    // Skip the save when the app is quitting (before-quit already captured
    // the full snapshot) or when no windows remain (the 'close' handler
    // above already saved the last-window snapshot). Otherwise persist the
    // remaining windows so an explicit single-window close is permanent.
    if (!isQuitting && windows.size > 0) persistWindowState()
  })

  const isNew = opts?.isNew ?? (opts?.windowId === undefined && !opts?.groupName)
  const hashParts = [`windowId=${id}`]
  if (isNew) hashParts.push('new=1')
  if (opts?.groupName) hashParts.push(`groupName=${encodeURIComponent(opts.groupName)}`)
  if (opts?.groupColor) hashParts.push(`groupColor=${encodeURIComponent(opts.groupColor)}`)
  if (opts?.initialFile) hashParts.push(`file=${encodeURIComponent(opts.initialFile)}`)
  const hash = hashParts.join('&')

  const url = process.env['ELECTRON_RENDERER_URL']
  if (url && !app.isPackaged) {
    win.loadURL(`${url}#${hash}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
}

/** Stagger between windows when restoring many at once. Opening every saved window in the
 *  same tick floods the machine with simultaneous agent launches (each tab spawns a `claude`
 *  that writes ~/.claude.json). The real corruption guard is the spawn gate in screen-executor,
 *  which serializes the actual `claude` launches on the contended ~/.claude.json write — this
 *  stagger only spreads the WINDOWS visually, so it can be short (mirrors the graceful-exit cadence). */
const WINDOW_RESTORE_STAGGER_MS = 100

/**
 * Recreate the saved windows. The FIRST window opens immediately — so a full-restart (which
 * destroys the old windows first) never has a zero-window gap that would trip
 * `window-all-closed` and quit — and the rest open one per WINDOW_RESTORE_STAGGER_MS. An
 * empty/absent state restores a single default window 0.
 */
export function restoreSavedWindows(savedState: Record<string, WindowStateEntry> | null): void {
  const entries = savedState ? Object.entries(savedState) : []
  if (entries.length === 0) { createAppWindow({ windowId: '0' }); return }
  entries.forEach(([windowId, info], i) => {
    const make = () => createAppWindow({
      windowId,
      groupName: info.groupName,
      groupColor: info.groupColor,
      isNew: info.isNew,
      bounds: info.bounds,
      isMaximized: info.isMaximized,
    })
    if (i === 0) make()
    else setTimeout(make, i * WINDOW_RESTORE_STAGGER_MS)
  })
}

/** The windowId of the currently-focused app window (its key in the `windows` map), or null. */
function getFocusedWindowId(): string | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (!focused) return null
  for (const [id, win] of windows) if (win === focused) return id
  return null
}

/** Group id owning the focused window (born-named or named-in-place), else null. */
function getActiveGroupId(): string | null {
  const id = getFocusedWindowId()
  return id ? (getGroupForWindow(id)?.id ?? null) : null
}

let dialogCounter = 0

function showGroupSettingsDialog(groupId: string, currentName: string, currentColor: string, callback: (result: { name: string; color: string } | null) => void) {
  const dialogId = `group-settings-${++dialogCounter}`
  const parent = BrowserWindow.getFocusedWindow() ?? undefined
  const dialog = new BrowserWindow({
    width: 420,
    height: 400,
    resizable: false,
    minimizable: false,
    maximizable: false,
    modal: !!parent,
    parent,
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true
    }
  })
  dialog.setMenuBarVisibility(false)

  const escapedName = currentName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const colorsJson = JSON.stringify(WINDOW_COLORS)

  const html = `<!DOCTYPE html><html><head><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#1e1e1e; color:#ccc; font-family:'Segoe UI',sans-serif; padding:20px; }
    label { font-size:13px; display:block; margin-bottom:8px; }
    input { width:100%; padding:8px; background:#333; color:#fff; border:1px solid #555; border-radius:4px; font-size:14px; outline:none; }
    input:focus { border-color:#007acc; }
    .color-grid { display:flex; flex-wrap:wrap; gap:6px; margin:12px 0; }
    .color-swatch { width:32px; height:32px; border-radius:4px; cursor:pointer; border:2px solid transparent; transition: border-color 0.15s; }
    .color-swatch:hover { border-color:rgba(255,255,255,0.5); }
    .color-swatch.selected { border-color:#fff; }
    .color-swatch.none { background:repeating-linear-gradient(45deg,#333,#333 4px,#444 4px,#444 8px); }
    .btns { margin-top:16px; text-align:right; }
    button { padding:6px 16px; border:none; border-radius:4px; cursor:pointer; font-size:13px; margin-left:8px; }
    .ok { background:#0e639c; color:#fff; } .ok:hover { background:#1177bb; }
    .cancel { background:#333; color:#ccc; } .cancel:hover { background:#444; }
  </style></head><body>
    <label>Window name</label>
    <input id="name" value="${escapedName}" autofocus />
    <label style="margin-top:16px">Status bar color</label>
    <div class="color-grid" id="colors"></div>
    <div class="btns">
      <button class="cancel" id="btn-cancel">Cancel</button>
      <button class="ok" id="btn-ok">OK</button>
    </div>
    <script>
      const {ipcRenderer} = require('electron');
      const ch = '${dialogId}';
      const colors = ${colorsJson};
      let selectedColor = ${JSON.stringify(currentColor || '')};
      const grid = document.getElementById('colors');
      colors.forEach(c => {
        const el = document.createElement('div');
        el.className = 'color-swatch' + (c.value === selectedColor ? ' selected' : '') + (!c.value ? ' none' : '');
        if (c.value) el.style.background = c.value;
        el.title = c.name;
        el.onclick = () => {
          document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
          el.classList.add('selected');
          selectedColor = c.value;
        };
        grid.appendChild(el);
      });
      const submit = () => { ipcRenderer.send(ch, JSON.stringify({ name: document.getElementById('name').value.trim(), color: selectedColor })); window.close(); };
      const cancel = () => { ipcRenderer.send(ch, ''); window.close(); };
      document.getElementById('btn-ok').onclick = submit;
      document.getElementById('btn-cancel').onclick = cancel;
      document.getElementById('name').addEventListener('keydown', e => {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') cancel();
      });
    </script>
  </body></html>`

  dialog.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  dialog.setTitle('Window Group Settings')
  dialog.once('ready-to-show', () => dialog.show())

  ipcMain.once(dialogId, (_e, value: string) => {
    if (value) {
      try {
        const parsed = JSON.parse(value)
        callback(parsed.name ? parsed : null)
      } catch { callback(null) }
    } else {
      callback(null)
    }
    if (!dialog.isDestroyed()) dialog.close()
  })
  dialog.on('closed', () => {
    ipcMain.removeAllListeners(dialogId)
  })
}

export function rebuildMenu(): void {
  // Named windows are listed alphabetically by name (case-insensitive, locale-aware).
  const groups = getGroups().slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const groupItems: Electron.MenuItemConstructorOptions[] = groups.map(g => {
    // The window owning this group: its own id (born-named) or the named-in-place window's id.
    const winId = g.windowId ?? g.id
    return {
      label: g.name,
      click: () => {
        const existing = windows.get(winId)
        if (existing && !existing.isDestroyed()) {
          if (existing.isMinimized()) existing.restore()
          existing.focus()
        } else {
          createAppWindow({ windowId: winId, groupName: g.name, groupColor: g.color })
        }
      }
    }
  })

  const activeGroupId = getActiveGroupId()

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Settings', click: () => publishToFocused('menu:settings') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => publishToFocused('menu:toggle-sidebar') },
        { label: 'Toggle Panel Bar', accelerator: 'CmdOrCtrl+G', click: () => publishToFocused('menu:toggle-notes') },
        { label: 'Maximize Panel', accelerator: 'F11', click: () => publishToFocused('menu:toggle-maximize') },
        { type: 'separator' },
        { label: 'Session History', accelerator: 'CmdOrCtrl+H', click: () => publishToFocused('menu:open-session-history') },
        { label: 'File Changes', accelerator: 'CmdOrCtrl+J', click: () => publishToFocused('menu:open-file-changes') },
        { label: 'Search Sessions…', accelerator: 'CmdOrCtrl+Shift+F', click: () => publishToFocused('menu:open-sessions-search') },
        { label: 'Ideas', accelerator: 'CmdOrCtrl+I', click: () => publishToFocused('menu:open-ideas') },
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: [
            { label: 'Windows Terminal', type: 'radio', click: () => publish('menu:set-theme', 'windows-terminal') },
            { label: 'VS Code Dark', type: 'radio', click: () => publish('menu:set-theme', 'vscode-dark') },
            { label: 'PowerShell Blue', type: 'radio', click: () => publish('menu:set-theme', 'powershell') }
          ]
        },
        { type: 'separator' },
        { label: 'Help', accelerator: 'F1', click: () => publishToFocused('menu:help') }
      ]
    },
    {
      label: 'Tab',
      submenu: [
        { label: 'New Claude Tab', accelerator: 'CmdOrCtrl+T', click: () => publishToFocused('menu:new-tab') },
        { label: 'New Tab...', accelerator: 'CmdOrCtrl+Shift+T', click: () => publishToFocused('menu:new-tab-picker') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => publishToFocused('menu:close-tab') },
        { type: 'separator' },
        { label: 'Move Right', accelerator: 'Alt+T Alt+N', click: () => publishToFocused('menu:move-tab', 'right'), registerAccelerator: false },
        { label: 'Move Left', accelerator: 'Alt+T Alt+P', click: () => publishToFocused('menu:move-tab', 'left'), registerAccelerator: false },
        { label: 'Move Up', accelerator: 'Alt+T Alt+U', click: () => publishToFocused('menu:move-tab', 'above'), registerAccelerator: false },
        { label: 'Move Down', accelerator: 'Alt+T Alt+D', click: () => publishToFocused('menu:move-tab', 'below'), registerAccelerator: false },
        { type: 'separator' },
        { label: 'Reset Layout', click: () => publishToFocused('menu:reset-layout') }
      ]
    },
    {
      label: 'Window',
      submenu: [
        // Every window is born UNNAMED (numeric id, no group). A name is always applied in place
        // via "Window Group Settings…" below — the born-named window concept no longer exists.
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createAppWindow({ isNew: true }) },
        ...(groupItems.length > 0 ? [
          { type: 'separator' as const },
          ...groupItems,
        ] : []),
        { type: 'separator' as const },
        {
          // Name the focused window or edit its existing name/color. Unnamed → names in place
          // (keeps id, layout, live PTYs, starts showing in the list above); named → edits the group.
          label: 'Window Group Settings...',
          click: () => {
            const wid = getFocusedWindowId()
            if (!wid) return
            const existing = getGroupForWindow(wid)
            showGroupSettingsDialog(existing?.id ?? '', existing?.name ?? '', existing?.color ?? '', (result) => {
              if (!result || !result.name) return
              if (existing) {
                // Edit the existing group in place. Owning window = named-in-place numeric id or
                // (legacy) born-named group id.
                const win = windows.get(existing.windowId ?? existing.id)
                const live = win && !win.isDestroyed() ? win : null
                if (result.name !== existing.name) {
                  renameGroup(existing.id, result.name)
                  if (live) {
                    live.setTitle(`Jamat — ${result.name}`)
                    publishTo(live.webContents, 'group:name-changed', result.name)
                  }
                }
                if (result.color !== (existing.color ?? '')) {
                  setGroupColor(existing.id, result.color)
                  if (live) {
                    live.setIcon(createWindowIcon(result.color))
                    publishTo(live.webContents, 'group:color-changed', result.color)
                  }
                }
              } else {
                // Name this (unnamed) window in place — keeps id, layout and live PTYs.
                const group = createGroup(result.name, wid)
                if (result.color) setGroupColor(group.id, result.color)
                const win = windows.get(wid)
                if (win && !win.isDestroyed()) {
                  win.setTitle(`Jamat — ${result.name}`)
                  win.setIcon(createWindowIcon(result.color || undefined))
                  publishTo(win.webContents, 'group:name-changed', result.name)
                  publishTo(win.webContents, 'group:color-changed', result.color || '')
                }
              }
              rebuildMenu()
            })
          }
        },
        // Strip the name off the focused (named) window — it stays open and reverts to unnamed.
        ...(activeGroupId ? [{
          label: 'Clear Window Name',
          click: () => {
            const gid = getActiveGroupId()
            if (!gid) return
            const grp = getGroups().find(g => g.id === gid)
            deleteGroup(gid)
            // Keep the window in both cases — named-in-place (numeric windowId) and legacy
            // born-named (window id === group id). It simply becomes an unnamed window.
            const win = windows.get(grp?.windowId ?? gid)
            if (win && !win.isDestroyed()) {
              win.setTitle('Jamat')
              win.setIcon(createWindowIcon(undefined))
              publishTo(win.webContents, 'group:name-changed', '')
              publishTo(win.webContents, 'group:color-changed', '')
            }
            rebuildMenu()
          }
        }] : [])
      ]
    },
    {
      label: 'Debug',
      submenu: [
        { role: 'toggleDevTools' },
        // Explicit Reload (not role: 'reload') so it carries NO accelerator — frees Ctrl+R for the
        // terminals (reverse-search) instead of reloading the window.
        { label: 'Reload', click: () => { BrowserWindow.getFocusedWindow()?.webContents.reload() } },
        {
          label: 'Reload Windows',
          click: () => {
            destroyAll()
            loadScreenConfig().then(() => {
              for (const win of windows.values()) {
                if (!win.isDestroyed()) win.webContents.reloadIgnoringCache()
              }
            })
          }
        },
        {
          label: 'Update & Restart',
          click: () => { void import('./self-update').then((m) => m.updateAndRestart()) }
        },
        {
          // Full process relaunch (new process → main-process code reloads too),
          // NOT the in-process restartAllWindows. Dynamic import keeps ipc-windows →
          // self-update off the static graph (self-update statically imports back
          // from here for getMonorepoRoot / persistWindowState / getAppConfig).
          label: 'Full Restart',
          click: () => { void import('./self-update').then((m) => m.relaunchApp()) }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

export function registerWindowIpc(): void {
  // Capture all still-open windows once at quit start. Without this, the
  // per-window `closed` saves overwrite each other during the cascade and
  // the final state file ends up empty (or with just the last window),
  // losing every other open window. The `isQuitting` flag then suppresses
  // those per-window saves so they can't clobber this snapshot.
  //
  // We also HOLD the quit to shut the PTYs down gracefully, one at a time
  // (gracefulDestroyAll) — Claude Code flushes ~/.claude.json on the double Ctrl-C, so it isn't
  // TerminateProcess'd mid-write (the corruption source). Serial so two agents don't flush the
  // shared file at once. preventDefault the first pass; re-quit when the graceful pass is done.
  app.on('before-quit', (event) => {
    if (windows.size > 0) persistWindowState()
    flushAppStateNow() // force the debounced app-state.json write to land synchronously before exit
    isQuitting = true
    if (gracefulShutdownDone) return // second pass — let the quit proceed
    event.preventDefault()
    void gracefulDestroyAll().finally(() => { gracefulShutdownDone = true; app.quit() })
  })

  registerHandler('app:version', async (): Promise<string> => getAppVersion())

  // Resolved on-disk locations + provenance for the read-only Settings → Info tab. `explicit` is
  // whether the launcher pinned the config-dir (--config-dir / JAMAT_CONFIG_DIR) vs the default ~/.jamat.
  registerHandler('app:paths', async (): Promise<AppPathsInfo> => ({
    ...getJamatPaths(),
    explicit: !!process.env['JAMAT_CONFIG_DIR'],
    appVersion: getAppVersion(),
  }))

  // Clipboard via the native Electron module — the sandboxed renderer can't use navigator.clipboard
  // reliably in the packaged file:// build (it's focus/secure-origin gated), so all clipboard I/O
  // routes through here (see the ipc-contracts note).
  //
  // The Windows clipboard is one shared OS resource: if another process holds it open (a
  // clipboard-history / manager tool, rdpclip under Remote Desktop, …) clipboard.writeText() silently
  // no-ops and Chromium neither retries nor reports it. So write, read it back to confirm it landed,
  // and retry briefly until it sticks.
  registerHandler('clipboard:write-text', async (_event, text: string) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      clipboard.writeText(text)
      if (clipboard.readText() === text) return // landed
      await new Promise((r) => setTimeout(r, 25)) // OS clipboard was locked — back off and retry
    }
    logError('clipboard', 'writeText did not stick after retries (clipboard held by another process)')
  })
  registerHandler('clipboard:read-text', async (): Promise<string> => clipboard.readText())
  // Silent read for the optional status-bar clipboard-debug widget's poller (see ipc-contracts note).
  registerHandler('clipboard:debug-read', async (): Promise<string> => clipboard.readText())

  registerHandler('window:new', async (_event, filePath?: string) => {
    createAppWindow({ isNew: true, initialFile: typeof filePath === 'string' && filePath ? filePath : undefined })
  })

  // Notification click → bring the originating renderer's window to the foreground. Resolves the
  // window from the sender so it's correct in a multi-window session; the renderer then activates
  // the tab the notification came from (it has the dockview API).
  registerSend('window:focus', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  registerSend('window:detach-tab', (_event, data: { title: string; params: Record<string, unknown> }) => {
    const id = String(windowCounter++)
    createAppWindow({ windowId: id, isNew: true })
    const win = windows.get(id)
    if (win) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          const terminalId = `terminal-${Date.now()}`
          // `params` is the detached tab's own screen-open-tab meta (the renderer sends it on
          // detach); the IPC contract types it loosely as Record — assert the real shape for
          // the typed stream façade (V1 sent the same value through the untyped webContents.send).
          publishTo(win.webContents, 'screen:open-tab', terminalId, data.params as unknown as ScreenOpenTabMeta)
        }, 1000)
      })
    }
  })

  registerHandler('notes:load', async (_event, panelId) => {
    if (typeof panelId !== 'string') return ['']
    return loadNotes(panelId)
  })

  registerHandler('notes:save', async (_event, panelId: string, entries: string[]) => {
    if (typeof panelId !== 'string' || !Array.isArray(entries)) return
    await saveNotes(panelId, entries)
  })

  registerHandler('ideas:load', async (_event, windowId) => {
    if (typeof windowId !== 'string' || !windowId) return []
    return loadIdeas(windowId)
  })

  registerHandler('ideas:save', async (_event, windowId, ideas) => {
    if (typeof windowId !== 'string' || !windowId) return { ok: false, error: 'invalid windowId' }
    if (!Array.isArray(ideas)) return { ok: false, error: 'ideas must be an array' }
    return saveIdeas(windowId, ideas)
  })

  registerHandler('group:create', async (_event, name: string) => {
    if (typeof name !== 'string' || !name.trim()) return null
    const group = createGroup(name.trim())
    createAppWindow({ windowId: group.id, groupName: group.name, isNew: true })
    rebuildMenu()
    return group
  })

  registerHandler('group:rename', async (_event, id: string, newName: string) => {
    if (typeof id !== 'string' || typeof newName !== 'string' || !newName.trim()) return
    renameGroup(id, newName.trim())
    rebuildMenu()
  })

  registerHandler('config:get', async () => appConfig)

  // The raw on-disk config (faithful values for the Settings editors). Base file has no secrets.
  registerHandler('config:get-raw', async () => {
    if (!appConfig) return null
    try {
      return JSON.parse(readFileSync(appConfig.configPath, 'utf-8')) as Record<string, unknown>
    } catch {
      return null
    }
  })

  // Persist a partial config edit back into the committed base config (NOT the .local overlay —
  // secrets route through usage:set-credentials). Validates each present key with core/config.ts's
  // rules, brick-guards a categories edit (≥1 existing dir, so the reload + every future launch
  // can't fail the "no accessible path" check), writes atomically, then RELOADS the in-memory
  // config (one consistent refresh: Sets, overlay, skippedCategories) and broadcasts config:changed
  // so every window's store refreshes. Backs all the Settings config tabs.
  registerHandler('config:update', async (_event, patch: ConfigPatch) => {
    if (!appConfig) return { ok: false, error: 'Config not loaded' }
    try {
      validateConfigPatch(patch)
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
    if (patch.categories && !patch.categories.some((c) => {
      try { return statSync(c.path).isDirectory() } catch { return false }
    })) {
      return { ok: false, error: 'At least one project folder must point to an existing directory' }
    }
    const path = appConfig.configPath
    try {
      writeConfigPatch(path, patch)
      appConfig = loadCoreConfig(path)
    } catch (e: any) {
      return { ok: false, error: `Failed to save ${path}: ${e.message}` }
    }
    publish('config:changed', appConfig)
    return { ok: true }
  })

  // Native folder picker for the Projects/categories editor — window-modal when a window is focused.
  registerHandler('dialog:pick-directory', async (_event, opts) => {
    const win = BrowserWindow.getFocusedWindow()
    const res = win
      ? await dialog.showOpenDialog(win, { title: opts?.title, defaultPath: opts?.defaultPath, properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ title: opts?.title, defaultPath: opts?.defaultPath, properties: ['openDirectory', 'createDirectory'] })
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })

  // First-run onboarding signal + completion (persisted in app-state.json by loadScreenConfig +
  // setOnboardingComplete). firstRun drives the renderer's auto-open of Settings in guided mode.
  registerHandler('onboarding:get-state', async () => ({ firstRun: !getOnboardingComplete() }))
  registerHandler('onboarding:complete', async () => { setOnboardingComplete(true); return { ok: true } })

  registerHandler('stats:generate', async (_event, force?: boolean) => {
    const { spawn } = require('child_process') as typeof import('child_process')
    const { statSync: fstatSync } = require('fs') as typeof import('fs')
    const root = getMonorepoRoot()
    const statsScript = join(root, 'app-stats', 'generate-stats.ts')
    const htmlScript = join(root, 'app-stats', 'generate-html.ts')
    const configDir = getJamatPaths().configDir
    const htmlPath = join(getJamatPaths().statsDir, 'dashboard.html')
    const tsxBin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')

    // An installed build has no source tree (no node_modules/.bin/tsx, no app-stats/*) → the stats
    // generator can't run. Report it instead of failing with a raw spawn error. (Bundled stats = follow-up.)
    if (!existsSync(tsxBin)) return { ok: false, error: 'Usage stats needs a source checkout (not available in the installed build yet)' }

    // Serve cached HTML if fresh (< 5 minutes old) — unless the caller forces a rebuild (Reload button).
    if (!force) {
      try {
        const st = fstatSync(htmlPath)
        if (Date.now() - st.mtimeMs < 5 * 60 * 1000) {
          return { ok: true, htmlPath }
        }
      } catch {}
    }

    function runScript(script: string, timeout: number): Promise<{ ok: boolean; error?: string }> {
      return new Promise((resolve) => {
        const child = spawn(tsxBin, [script, '--config-dir', configDir], { cwd: root, stdio: 'pipe', shell: true })
        let stderr = ''
        const timer = setTimeout(() => { child.kill(); resolve({ ok: false, error: 'Timeout' }) }, timeout)
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.slice(0, 500) })
        })
        child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }) })
      })
    }

    try {
      const r1 = await runScript(statsScript, 120000)
      if (!r1.ok) return { ok: false, error: `Stats generation failed: ${r1.error}` }
      const r2 = await runScript(htmlScript, 30000)
      if (!r2.ok) return { ok: false, error: `HTML generation failed: ${r2.error}` }
      return { ok: true, htmlPath }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  // Native Usage Stats tab: runs the SAME generate-stats.ts as `stats:generate`, but skips the
  // HTML step and returns the parsed stats.json DATA. Serves a fresh (<5 min) cached stats.json
  // unless `force` (the ↻ button) bypasses the cache. The heavy ccusage FS scan runs in a
  // subprocess so the main thread stays responsive.
  registerHandler('stats:data', async (_event, force?: boolean) => {
    const { spawn } = require('child_process') as typeof import('child_process')
    const { statSync: fstatSync, readFileSync: fread } = require('fs') as typeof import('fs')
    const root = getMonorepoRoot()
    const statsScript = join(root, 'app-stats', 'generate-stats.ts')
    const configDir = getJamatPaths().configDir
    const jsonPath = join(getJamatPaths().statsDir, 'stats.json')
    const tsxBin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')

    // An installed build has no source tree → the stats generator can't run. Report it clearly.
    if (!existsSync(tsxBin)) return { ok: false, error: 'Usage stats needs a source checkout (not available in the installed build yet)' }

    const readJson = () => {
      try {
        return { ok: true as const, data: JSON.parse(fread(jsonPath, 'utf-8')) }
      } catch (e: any) {
        return { ok: false as const, error: `stats.json unreadable: ${e.message}` }
      }
    }

    // Serve fresh cache without spawning the generator.
    if (!force) {
      try {
        const st = fstatSync(jsonPath)
        if (Date.now() - st.mtimeMs < 5 * 60 * 1000) return readJson()
      } catch {}
    }

    function runScript(script: string, timeout: number): Promise<{ ok: boolean; error?: string }> {
      return new Promise((resolve) => {
        const child = spawn(tsxBin, [script, '--config-dir', configDir], { cwd: root, stdio: 'pipe', shell: true })
        let stderr = ''
        const timer = setTimeout(() => { child.kill(); resolve({ ok: false, error: 'Timeout' }) }, timeout)
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.slice(0, 500) })
        })
        child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }) })
      })
    }

    try {
      const r = await runScript(statsScript, 120000)
      if (!r.ok) return { ok: false, error: `Stats generation failed: ${r.error}` }
      return readJson()
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  registerSend('action:run', (_event, action: string, ...args: string[]) => {
    if (action === 'open-url') {
      const url = args[0]
      if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
        require('electron').shell.openExternal(url)
      }
      return
    }
    if (action === 'open-vscode') {
      let dir = args[0]
      if (!dir) return
      // Expand ~ — VS Code's CLI on Windows doesn't.
      if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) {
        const { homedir } = require('os') as typeof import('os')
        dir = homedir() + (dir === '~' ? '' : dir.slice(1))
      }
      const { spawn } = require('child_process') as typeof import('child_process')
      // Spawn the shim directly (win: `code.cmd`, else `code`) with the dir passed atomically as an
      // arg — no shell interpolation, so metacharacters in the path can't execute (see ipc-files.ts).
      const bin = process.platform === 'win32' ? 'code.cmd' : 'code'
      const child = spawn(bin, [dir], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      child.on('error', () => {})
    }
  })
}

export function registerPtyIpc(): void {
  registerSend('screen:create', (event, terminalId: string, config: { cols: number; rows: number }) => {
    if (!appConfig) return
    if (typeof terminalId !== 'string') return
    if (!config || typeof config.cols !== 'number' || typeof config.rows !== 'number') return
    startMenuInTerminal(terminalId, event.sender.id, {
      cols: config.cols,
      rows: config.rows,
      menuDir: menuDir,
      menuConfig: menuConfigPath
    })
  })

  registerSend('screen:restore', (event, terminalId: string, meta: ScreenOpenTabMeta, immediate?: boolean) => {
    if (!appConfig) return
    if (typeof terminalId !== 'string') return
    restoreClaudeInTerminal(terminalId, event.sender.id, {
      cols: 80,
      rows: 24,
      menuDir: menuDir,
      menuConfig: menuConfigPath
    }, meta, immediate === true)
  })

  registerHandler('pty:resume', async (_event, terminalId) => {
    if (typeof terminalId !== 'string' || !terminalId) {
      return { ok: false, error: 'invalid terminalId' }
    }
    return resumeClaudeInTerminal(terminalId)
  })

  registerSend('pty:create', (event, terminalId: string, config: PtyConfig) => {
    if (typeof terminalId !== 'string') return
    createPty(terminalId, event.sender.id, {
      cols: config.cols,
      rows: config.rows,
      cwd: config.cwd,
      command: config.command,
      args: config.args
    })
  })

  registerSend('pty:write', (_event, terminalId: string, data: string) => {
    if (typeof data !== 'string') return
    writeToPty(terminalId, data)
  })

  registerSend('pty:resize', (_event, terminalId: string, cols: number, rows: number) => {
    if (typeof cols !== 'number' || typeof rows !== 'number' || !isFinite(cols) || !isFinite(rows)) return
    resizePty(terminalId, cols, rows)
    updateTerminalSize(terminalId, cols, rows)
  })

  registerSend('pty:destroy', (_event, terminalId: string) => {
    cleanupTerminal(terminalId)
  })
}

const PENDING_TAB_FILE = join(tmpdir(), 'jamat-pending-tab.json')

export function processPendingTab(): void {
  if (!existsSync(PENDING_TAB_FILE)) return
  try {
    const raw = readFileSync(PENDING_TAB_FILE, 'utf-8')
    unlinkSync(PENDING_TAB_FILE)
    const meta = JSON.parse(raw)
    if (!meta.projectDir || !meta.cmd || !meta.folderName) return
    if (!appConfig) return

    const win = windows.get('0')
    if (!win || win.isDestroyed()) return

    const terminalId = `terminal-${Date.now()}`
    publishTo(win.webContents, 'screen:open-tab', terminalId, meta)
  } catch (e) { console.error('[screen] processPendingTab error:', e) }
}
