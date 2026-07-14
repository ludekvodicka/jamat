/**
 * Full-process relaunch — a GENERAL primitive, not part of the update module.
 *
 * Shared by the menu "Full Restart", the remote `POST /debug/fullrestart` op, and the update module's
 * source channel (where a restart through the launcher is what loads a newer on-disk build, because
 * the launcher recompiles when the version changed).
 *
 * Why the launcher and not something simpler (kept from the original self-update.ts):
 *  - `restartAllWindows()` recreates windows IN-PROCESS → the main-process code never re-executes, so
 *    new code wouldn't take.
 *  - `app.relaunch()` is unusable in dev: it re-spawns the electron binary directly, bypassing
 *    electron-vite's dev server, so `ELECTRON_RENDERER_URL` is unset and the renderer can't load.
 *  - A naive spawn of the launcher is defeated by Electron's single-instance lock, so a detached
 *    PowerShell helper kills this app (+ dev strays), waits for the port to free, then starts one
 *    fresh instance. We INVOKE the launcher, never modify it.
 *
 * Returns false — WITHOUT quitting — whenever it cannot relaunch, so the app is never left dead.
 */
import { app, dialog } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'

import { persistWindowState } from './ipc-windows'
import { getMonorepoRoot } from './app-root'
import { getJamatPaths } from './jamat-paths'
import { getWindowsTabs } from './tab-tree-cache'
import { logError, logInfo } from './logger'

// Re-entrancy guard: independent triggers (menu "Full Restart", the update module, the remote
// debug:fullrestart op) can fire a restart concurrently. Two in flight = two helpers → two
// recompiles → two `taskkill "Jamat.exe"` racing each other's fresh instance, a storm of console
// spawns that can tip a child cmd.exe into 0xc0000142 (DLL init failed). Allow one restart at a time.
let relaunching = false

/** The live terminals a restart would kill, busy ones flagged — for confirm/update dialogs. */
export function buildSessionList(): string {
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

async function fail(message: string, detail?: string): Promise<void> {
  await dialog.showMessageBox({ type: 'error', title: 'Restart', message, detail })
}

export async function relaunchApp(): Promise<boolean> {
  if (relaunching) {
    logInfo('relaunch', 'relaunch already in progress — ignoring duplicate trigger')
    return false
  }
  const dev = !app.isPackaged
  const bat = path.join(getMonorepoRoot(), 'bin', dev ? 'start-dev.bat' : 'start.bat')
  const helper = path.join(getMonorepoRoot(), '.private', 'scripts', 'full-restart.ps1')

  // No launcher script (an installed build has no bin/), a non-Windows host (the .bat + the PowerShell
  // helper are Windows-only), or a MISSING HELPER — `.private/` is git-ignored, so a public clone has
  // the committed bin/start.bat but NO full-restart.ps1: spawning `powershell -File <missing>` succeeds,
  // the helper dies instantly, and the app quits and never comes back. Take the direct path instead.
  if (!existsSync(bat) || !existsSync(helper) || process.platform !== 'win32') {
    if (dev) {
      // Platform first: bin/start.bat is COMMITTED (so it exists on macOS/Linux too) while the helper
      // is git-ignored — checking the files first would blame the wrong thing on a POSIX host.
      const why = process.platform !== 'win32' ? `unsupported platform (${process.platform})`
        : !existsSync(bat) ? `launcher missing (${bat})`
        : `restart helper missing (${helper})`
      logError('relaunch', `cannot relaunch — ${why}`)
      await fail('Restart failed.', `${why}\n\nRestart the app manually.`)
      return false
    }
    relaunching = true
    logInfo('relaunch', 'full-restart via app.relaunch (packaged; no launcher/helper or non-win32)')
    persistWindowState()
    app.relaunch()
    setTimeout(() => app.quit(), 200)
    return true
  }

  relaunching = true // committed: we spawn the helper and quit below; the process dies, no reset needed
  logInfo('relaunch', `full-restart via helper → ${bat} (dev=${dev})`)
  persistWindowState()
  const port = dev ? 47101 : 47100 // debug-api port; frees when this main process dies
  // Pass the real app-electron dir so the helper scopes its dev stray-kill to THIS app's processes by
  // path (rename-proof — no hard-coded repo name baked into the helper).
  const appElectronDir = path.join(getMonorepoRoot(), 'app-electron')
  const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helper, '-Bat', bat, '-Port', String(port), '-AppDir', appElectronDir, '-ConfigDir', getJamatPaths().configDir]
  if (!dev) psArgs.push('-Prod')
  // Launch the helper through cmd `start` so it BREAKS OUT of this app's process/job object. A plain
  // detached spawn dies together with this app when we quit — the helper never reaches the relaunch
  // step, leaving the app DOWN. `start` makes it a top-level process that survives our exit.
  const child = spawn('cmd.exe', ['/c', 'start', '', 'powershell', ...psArgs], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  child.on('error', (e) => logError('relaunch', `restart helper spawn failed: ${e.message}`))
  // The helper waits for our port to free, then relaunches; quit so window state flushes.
  setTimeout(() => app.quit(), 700)
  return true
}
