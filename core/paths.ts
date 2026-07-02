/**
 * Cross-process path constants. Pure consts, no fs/electron — safe to import
 * from `core/`, the Electron main process, AND the standalone agent
 * (`app-agent`, a plain Node process with no `electron` available).
 *
 * `USERDATA_DIR_NAME` is the Electron `app.getPath('userData')` leaf, which
 * derives from `app-electron/package.json` `name` (NOT `build.productName`)
 * because no `app.setName()` is called. The dev build suffixes `-debug`
 * (see `app-electron/src/main/bootstrap-userdata.ts`). It now holds ONLY
 * Electron's own caches (the machine key moved into the config-dir). If
 * `package.json` `name` ever changes, update this. Renamed from the legacy
 * `claude-super-app` (pre-Jamat rebrand); `bootstrap-userdata.ts` migrates
 * the old dir's full state on first launch.
 */
export const USERDATA_DIR_NAME = 'jamat'

/** Remote App Control config + key file. Lives in the CONFIG-DIR (see `core/jamat-paths.ts`) so all
 *  config sits together; each machine uses its own config-dir, so the key stays per-machine. */
export const REMOTE_CONTROL_FILE = 'remote-control.json'

/**
 * Default PORTABLE config-dir leaf under the home directory (`~/.jamat/`). This is the one
 * relocatable directory selected by `--config-dir` / `JAMAT_CONFIG_DIR` that holds ALL portable
 * per-machine-but-syncable state: `config.json` (+ `config.local.json` secret overlay),
 * `app-state.json` (+ `snapshots/`), `usage-cache.json`, `stats/`, `usage-stats.json`,
 * `menu-prefs.json`, `ideas-*`, `remote-activity/`. Resolved by `resolveConfigDir()` in
 * `core/config-dir.ts` (electron adds a `-debug` leaf in dev). Now ALSO holds `remote-control.json`
 * (the machine key + peers). Distinct from `USERDATA_DIR_NAME` (`%APPDATA%\jamat`), which keeps ONLY
 * Electron's own caches.
 */
export const CONFIG_DIR_NAME = '.jamat'
