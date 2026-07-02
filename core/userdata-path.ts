/**
 * Resolve the app's userData dir for NON-Electron processes (the standalone agent, the CLI menu,
 * and the stats generator) — WITHOUT importing electron. Mirrors what Electron's
 * `app.getPath('userData')` yields on Windows: `%APPDATA%\<USERDATA_DIR_NAME>`.
 *
 * Used to consolidate the per-user "CLI/core" data (usage stats, the stats-dashboard cache, the CLI
 * menu prefs, and ideas) into the SAME `%APPDATA%\jamat` dir the Electron app uses, instead
 * of a separate `~/.jamat` home dir. The `app-cli`/`app-stats`/`app-agent` tools are
 * build-agnostic (they have no notion of the dev `-debug` split), so they resolve the PROD dir by
 * default — Electron and these tools then agree on one location for the shared data. The dev `-debug`
 * split still applies to Electron's OWN state (layouts/remote-control/caches via `app.getPath`), which
 * the CLI reaches with `debug:true` only where it explicitly mirrors a dev instance (e.g. its key).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { USERDATA_DIR_NAME } from './paths.js'

/** The Electron userData dir as seen from a plain Node process. `debug` selects the dev `-debug` split. */
export function resolveUserDataDir(debug = false): string {
  const roaming = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming')
  return join(roaming, USERDATA_DIR_NAME + (debug ? '-debug' : ''))
}
