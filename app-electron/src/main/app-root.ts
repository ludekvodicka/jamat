/**
 * Resolve the monorepo root + the app version — a leaf module (electron + node builtins only) so
 * both ipc-windows and screen-executor can import it without an ipc-windows ↔ screen-executor cycle.
 */
import { app } from 'electron'
import { join, resolve } from 'path'
import { readFileSync } from 'fs'

export function getMonorepoRoot(): string {
  if (app.isPackaged) {
    // Repo-in-place launch (bin/start.bat|.sh) sets JAMAT_ROOT → the working copy. An INSTALLED
    // build has none → resources/ mirrors the monorepo layout via extraResources.
    return process.env['JAMAT_ROOT'] ?? process.resourcesPath
  }
  // __dirname in dev = app-electron/out/main → 3 levels up = monorepo root
  return resolve(__dirname, '..', '..', '..')
}

/** The app version = root `package.json` `version` (the `YYYY.MM.DD.HH.mm` bump shown
 *  in the status bar). Falls back to 'dev' if unreadable. */
let cachedAppVersion: string | null = null
export function getAppVersion(): string {
  // Memoize at first read (≈ process start) so this reports the RUNNING build's version, not
  // whatever is on disk NOW. After an `svn update` without a restart the on-disk package.json
  // is newer than the code actually executing — and the whole point of surfacing the version
  // (status bar / Remote Connections tab / `find`) is to confirm which build a peer is RUNNING.
  // A real restart re-loads this module, so the cache re-initialises to the new version.
  if (cachedAppVersion !== null) return cachedAppVersion
  let v = 'dev'
  try {
    const pkg = JSON.parse(readFileSync(join(getMonorepoRoot(), 'package.json'), 'utf-8'))
    if (typeof pkg.version === 'string') v = pkg.version
  } catch { /* keep 'dev' */ }
  cachedAppVersion = v
  return v
}
