/**
 * Built-in "Update & Restart" (menu action).
 *
 * Pulls the app's OWN repo from VCS (`svn update` / `git pull`), then fully
 * relaunches the process so every changed file — main, preload, renderer — loads.
 *
 * Why a launcher relaunch (not restartAllWindows / app.relaunch):
 *  - `restartAllWindows()` recreates windows IN-PROCESS → the main-process code
 *    stays the OLD code (it never re-executes), so a source pull wouldn't take.
 *  - `app.relaunch()` is unusable in dev: it re-spawns the electron binary
 *    directly, bypassing electron-vite's dev server, so `ELECTRON_RENDERER_URL`
 *    is unset and the renderer fails to load.
 *  - The launcher already does deps-install (root + app-electron) and, in prod,
 *    recompile-on-version-change. The pulled `package.json` carries a newer
 *    `version` (every change runs `npm run bump`), so `cs` auto-rebuilds. We
 *    INVOKE the launcher, never modify it — the same accepted pattern as
 *    `agent-server.ts` `/api/launch-app`.
 *
 * Safety: a full restart kills every PTY (running Claude sessions), so the action
 * is gated behind a confirm dialog that lists the live terminals (busy flagged),
 * and it skips the restart entirely when the VCS reports no changes.
 *
 * The static import edge is self-update → ipc-windows ONLY; ipc-windows reaches
 * back via a dynamic import in the menu click handler (no static cycle).
 */
import { app, dialog } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { existsSync, statSync, readFileSync } from 'node:fs'

import { getAppConfig, persistWindowState } from './ipc-windows'
import { getMonorepoRoot, getAppVersion } from './app-root'
import { getJamatPaths } from './jamat-paths'
import { getWindowsTabs } from './tab-tree-cache'
import { logError, logInfo } from './logger'
import type { SelfUpdateConfig } from '../../../core/types.js'

const UPDATE_TIMEOUT_MS = 120_000
const DIALOG_DETAIL_CAP = 4000

// Re-entrancy guard: independent triggers (menu "Update & Restart" / "Full Restart",
// the background update-checker, the remote debug:fullrestart op) can fire a restart
// concurrently. Two in flight = two helpers → two recompiles → two `taskkill
// "Jamat.exe"` racing each other's fresh instance, a storm of console spawns that
// can tip a child cmd.exe into 0xc0000142 (DLL init failed). Allow one restart at a time.
let relaunching = false

export function resolveRepoPath(cfg: SelfUpdateConfig): string {
  return cfg.repoPath && cfg.repoPath.trim() ? cfg.repoPath : getMonorepoRoot()
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

interface UpdateResult { ok: boolean; changed: boolean; output: string; error?: string }

function runVcsUpdate(vcs: 'svn' | 'git', repoPath: string): Promise<UpdateResult> {
  return new Promise((resolve) => {
    const args = vcs === 'svn' ? ['update'] : ['pull']
    const child = spawn(vcs, args, { cwd: repoPath, shell: true })
    let out = ''
    let err = ''
    let settled = false
    const finish = (r: UpdateResult) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r) }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, changed: false, output: out + err, error: `Timed out after ${UPDATE_TIMEOUT_MS / 1000}s` })
    }, UPDATE_TIMEOUT_MS)
    child.stdout?.on('data', (d) => { out += d.toString() })
    child.stderr?.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => finish({ ok: false, changed: false, output: out + err, error: e.message }))
    child.on('close', (code) => {
      const combined = out + err
      if (code !== 0) { finish({ ok: false, changed: false, output: combined, error: err.trim() || `exit ${code}` }); return }
      finish({ ok: true, changed: detectChanged(vcs, out), output: combined })
    })
  })
}

/** The version in the on-disk root `package.json` RIGHT NOW — i.e. the build a restart would load.
 *  Read FRESH, unlike `getAppVersion()` which is memoised to the RUNNING build. Null if unreadable. */
function readDiskVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(getMonorepoRoot(), 'package.json'), 'utf-8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch { return null }
}

/** >0-style "is a newer than b?" — numeric `YYYY.MM.DD.HH.mm` compare (mirrors update-checker). */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number(n) || 0)
  const pb = b.split('.').map((n) => Number(n) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

/** Did the update actually bring new code? Lets us skip a pointless (session-killing) restart. */
function detectChanged(vcs: 'svn' | 'git', output: string): boolean {
  if (vcs === 'git') return !/already up.to.date/i.test(output)
  // svn: a bare "At revision N." means nothing was pulled; "Updated to revision N."
  // or any per-file status line (A/U/D/G/C/R/M …) means real changes arrived.
  if (/updated to revision/i.test(output)) return true
  if (/^[ADUGCRME]{1,2}\s+\S/m.test(output)) return true
  return false
}

/** The live terminals a restart would kill, busy ones flagged — for the confirm dialog. */
function buildSessionList(): string {
  const lines: string[] = []
  for (const w of getWindowsTabs()) {
    for (const t of w.tabs) {
      if (!t.streamable) continue
      const tag = t.status === 'running' || t.status === 'tool-use'
        ? ' (busy)'
        : t.status === 'blocked' || t.status === 'waiting' ? ' (waiting for input)' : ''
      lines.push(`  • ${t.title}${tag}`)
    }
  }
  return lines.length ? lines.join('\n') : '  (no running terminals)'
}

async function info(message: string, detail?: string): Promise<void> {
  await dialog.showMessageBox({ type: 'info', title: 'Update & Restart', message, detail })
}
async function fail(message: string, detail?: string): Promise<void> {
  await dialog.showMessageBox({ type: 'error', title: 'Update & Restart', message, detail })
}

/**
 * Relaunch the WHOLE process via the per-user launcher (`cs` in prod — which
 * recompiles when the version changed — `csd` in dev), restoring every open
 * window. Shared by "Update & Restart" (after the VCS pull) and the menu
 * "Full Restart" / `/debug/fullrestart` (no pull). Returns false — WITHOUT
 * quitting — when the launcher can't be resolved, so the app is never left dead.
 */
export async function relaunchApp(): Promise<boolean> {
  if (relaunching) {
    logInfo('self-update', 'relaunch already in progress — ignoring duplicate trigger')
    return false
  }
  const dev = !app.isPackaged
  const bat = path.join(getMonorepoRoot(), 'bin', dev ? 'start-dev.bat' : 'start.bat')
  // No launcher script (an installed build has no bin/) OR a non-Windows host (the .bat + the
  // PowerShell restart helper are Windows-only) → relaunch the process directly. `bin/start.bat`
  // IS committed, so it exists in a POSIX checkout too — the win32 guard is what forces the direct
  // path there. app.relaunch() is unusable in DEV (it re-spawns the electron binary, bypassing
  // electron-vite's dev server → the renderer can't load), so a dev fallback still fails loudly.
  if (!existsSync(bat) || process.platform !== 'win32') {
    if (dev) {
      logError('self-update', `launcher not usable (bat=${bat}, platform=${process.platform}, dev) — cannot relaunch`)
      await fail('Restart failed — launcher not available.',
        'Restart the app manually.')
      return false
    }
    relaunching = true
    logInfo('self-update', `full-restart via app.relaunch (packaged, no launcher / non-win32)`)
    persistWindowState()
    app.relaunch()
    setTimeout(() => app.quit(), 200)
    return true
  }
  relaunching = true // committed: we spawn the helper and quit below; the process dies, no reset needed
  logInfo('self-update', `full-restart via helper → ${bat} (dev=${dev})`)
  persistWindowState()
  // A naive relaunch (just spawn the launcher) is defeated by Electron's single-instance lock:
  // the new instance sees THIS one still alive, becomes a "subsequent instance" (only opens a
  // window here) and exits — and in dev its electron-vite dev server is LEAKED (a fresh one on a
  // new port every restart, the "5 stray vite windows" bug). So delegate to a detached PowerShell
  // helper that first KILLS this app + (dev) every stray electron-vite, waits for the port to
  // free, then launches ONE fresh instance (which acquires the lock = primary). The helper is
  // detached + survives our exit; it also kills us, so this is a true full restart, not a re-open.
  const helper = path.join(getMonorepoRoot(), '.private', 'scripts', 'full-restart.ps1')
  const port = dev ? 47101 : 47100 // debug-api port; frees when this main process dies
  // Pass the real app-electron dir so the helper scopes its dev stray-kill to THIS app's
  // processes by path (rename-proof — no hard-coded repo name baked into the helper).
  const appElectronDir = path.join(getMonorepoRoot(), 'app-electron')
  const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helper, '-Bat', bat, '-Port', String(port), '-AppDir', appElectronDir, '-ConfigDir', getJamatPaths().configDir]
  if (!dev) psArgs.push('-Prod')
  // Launch the helper through cmd `start` so it BREAKS OUT of this app's process/job object. A
  // plain detached spawn dies together with this app when we quit — the helper never reaches the
  // relaunch step, leaving the app DOWN (observed: app killed, nothing came back). `start` makes
  // the helper a top-level process that survives our exit, so it can wait us out and relaunch.
  const child = spawn('cmd.exe', ['/c', 'start', '', 'powershell', ...psArgs], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  child.on('error', (e) => logError('self-update', `restart helper spawn failed: ${e.message}`))
  // The helper waits for our port to free, then relaunches; quit so window state flushes.
  setTimeout(() => app.quit(), 700)
  return true
}

export async function updateAndRestart(): Promise<void> {
  const cfg = getAppConfig()

  // GitHub Releases channel (packaged public builds) — route the manual action to electron-updater.
  // A packaged install with no explicit selfUpdate config defaults to 'github' (ensureConfig strips
  // the seeded block); a repo-in-place launch (JAMAT_ROOT) keeps the VCS self-pull channel.
  const provider = cfg?.selfUpdate?.provider ?? (app.isPackaged && !process.env['JAMAT_ROOT'] ? 'github' : undefined)
  if (provider === 'github') {
    await import('./auto-updater').then((m) => m.checkForUpdatesManual())
    return
  }

  if (!cfg?.selfUpdate) {
    await info('Self-update is not configured.',
      'Add this block to config-*.json:\n"selfUpdate": { "vcs": "svn" | "git", "repoPath"?: "..." }')
    return
  }

  const vcs = cfg.selfUpdate.vcs ?? 'git'
  const repoPath = resolveRepoPath(cfg.selfUpdate)
  if (!isDir(repoPath)) {
    await fail('Repository not found.', `selfUpdate.repoPath does not exist or is not a directory:\n${repoPath}`)
    return
  }

  const confirm = await dialog.showMessageBox({
    type: 'question',
    title: 'Update & Restart',
    message: `Pull the latest version (${vcs}) and restart the app?`,
    detail: `Repo: ${repoPath}\n\nRestart will close all running terminals/sessions:\n${buildSessionList()}`,
    buttons: ['Cancel', 'Update & Restart'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (confirm.response !== 1) return

  await pullAndRelaunch()
}

/**
 * Pull the configured VCS and, if anything changed, relaunch the whole process.
 * No confirm dialog — used by the menu action AFTER its own confirm, and by the
 * background update-checker AFTER it has prompted the user and verified every tab
 * is idle. Still shows failure / no-change info dialogs and short-circuits a
 * pointless (session-killing) restart when the pull brought nothing.
 */
export async function pullAndRelaunch(): Promise<void> {
  const cfg = getAppConfig()
  if (!cfg?.selfUpdate) return
  const vcs = cfg.selfUpdate.vcs ?? 'git'
  const repoPath = resolveRepoPath(cfg.selfUpdate)
  if (!isDir(repoPath)) {
    await fail('Repository not found.', `selfUpdate.repoPath does not exist or is not a directory:\n${repoPath}`)
    return
  }

  logInfo('self-update', `running ${vcs} update in ${repoPath}`)
  const res = await runVcsUpdate(vcs, repoPath)
  if (!res.ok) {
    logError('self-update', `${vcs} update failed: ${res.error ?? ''}`)
    await fail(`${vcs} update failed — the app stays running.`,
      (res.error ?? '').slice(0, DIALOG_DETAIL_CAP) || res.output.slice(-DIALOG_DETAIL_CAP))
    return
  }
  // The real "restart needed" signal is whether the ON-DISK build is newer than what's RUNNING —
  // NOT whether the pull brought files. On the machine where the bump+commit happened, the working
  // copy is ALREADY new (so `svn update` pulls nothing, res.changed=false) while this process is
  // still the OLD build — a restart IS needed to load it. Keying off res.changed alone skipped that
  // restart ("No changes — not restarted", yet the running version stays stale). So restart when
  // the pull brought changes OR the on-disk version outranks the running one.
  const disk = readDiskVersion()
  const running = getAppVersion()
  const diskNewer = !!disk && isNewer(disk, running)
  if (!res.changed && !diskNewer) {
    logInfo('self-update', `no changes and disk(${disk ?? '?'}) not newer than running(${running}); skipping restart`)
    await info('No changes — already up to date.', `Both running and on-disk versions are ${running}. The app was not restarted.`)
    return
  }

  // Pull brought changes OR the disk build is newer than what's running → full process relaunch
  // (recompiles in prod via `cs` when the version differs).
  logInfo('self-update', `relaunching: pulledChanges=${res.changed} disk=${disk ?? '?'} running=${running}`)
  await relaunchApp()
}
