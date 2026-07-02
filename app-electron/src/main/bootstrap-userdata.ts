// Runs as the very first import in main/index.ts (side-effect only).
// Must execute before any module that reads app.getPath('userData') at
// import time (groups-manager, notes-manager, ipc-layout, etc.) — those
// would otherwise capture the default path before we get a chance to
// override it.
//
// Why: app.isPackaged === false (dev mode launched via `npm run dev` /
// jamat-dev-*.bat) shares the same %APPDATA%\jamat\ directory with the
// packaged build. Running both at once made Chromium fail to lock
// GPUCache/ShaderCache/GrShaderCache, spamming "disk_cache.cc(216) Unable to
// create cache" on startup. A suffixed userData dir for the dev process
// isolates everything (cache + layouts + notes + groups + usage-cache +
// window-state).
import { app } from 'electron'
import { existsSync, mkdirSync, cpSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { resolveUserDataDir } from '../../../core/userdata-path.js'
import { resolveConfigDir, migrateIntoConfigDir } from '../../../core/config-dir.js'
import { buildJamatPaths } from '../../../core/jamat-paths.js'
import { setJamatPaths, getJamatPaths } from './jamat-paths.js'
import { loadAppState } from './app-state-store.js'

if (!app.isPackaged) {
  const base = app.getPath('userData')
  app.setPath('userData', `${base}-debug`)
}

// Resolve the PORTABLE config-dir (the relocatable home of config + app-state + caches + ideas) and
// publish the path map BEFORE loadAppState() reads it. Precedence: JAMAT_CONFIG_DIR env / --config-dir
// (set by the launcher) → ~/.jamat[-debug]. The per-machine userData dir (already -debug-split above)
// keeps ONLY Electron's own caches now — remote-control.json (the machine key) is moved INTO the
// config-dir by the cutover block below, so ALL config lives in one place.
const configDir = resolveConfigDir({ explicit: process.env['JAMAT_CONFIG_DIR'] ?? null, debug: !app.isPackaged })
setJamatPaths(buildJamatPaths(configDir, app.getPath('userData')))

// One-time migration from the pre-Jamat-rebrand userData dir (`claude-super-app`) to the new
// `jamat` dir (app-electron/package.json `name`). Carries this app's OWN state — most importantly
// the machine token in remote-control.json (so remote peers don't need re-pairing) plus the unified
// app-state.json (windows/layouts/notes/groups), ideas, usage cache, and the remote-activity log.
// Full recursive copy of the old dir EXCEPT Electron's volatile caches/lockfiles; idempotent (skips
// once bootstrap is marked done — see the sentinel below); never overwrites a newer file (force:false).
// prod: jamat → claude-super-app; dev: jamat-debug → claude-super-app-debug (leaf-only replace).
{
  const newDir = app.getPath('userData')
  // "already bootstrapped" = the sentinel written at the end of this file, OR (legacy machines) the
  // per-machine key still in userData before the cutover block below moves it into the config-dir.
  // Either suppresses this one-time claude-super-app → jamat copy, so relocating the key out of
  // userData can't re-trigger this migration on the next launch.
  const bootstrapSentinel = join(newDir, '.bootstrap-done')
  const alreadyBootstrapped = existsSync(bootstrapSentinel) || existsSync(join(newDir, 'remote-control.json'))
  if (!alreadyBootstrapped) {
    const oldDir = join(dirname(newDir), basename(newDir).replace('jamat', 'claude-super-app'))
    if (oldDir !== newDir && existsSync(oldDir)) {
      // Skip Electron's own caches / lockfiles — only the app's state is worth carrying.
      const SKIP = /(?:^|[\\/])(GPUCache|ShaderCache|Code Cache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|Crashpad|blob_storage|Singleton[^\\/]*|.*\.lock|LOCK)(?:[\\/]|$)/i
      try {
        mkdirSync(newDir, { recursive: true })
        cpSync(oldDir, newDir, { recursive: true, force: false, errorOnExist: false, filter: (src) => !SKIP.test(src) })
      } catch { /* best-effort; a fresh userData still works (peers just need re-pairing) */ }
    }
  }
}

// Migrate the per-user "CLI/core" data (Ideas — user content; usage stats + the stats-dashboard
// cache; the CLI menu prefs) OUT of the legacy `~/.claude-super-app` HOME dir INTO the shared
// userData dir (`%APPDATA%\jamat`). Everything now lives there, so the Electron app AND the
// standalone build-agnostic tools (app-cli/app-stats/app-agent, via resolveUserDataDir()) read ONE
// place — no separate home dir. Target is the PROD userData dir (resolveUserDataDir()), NOT
// app.getPath('userData') (the dev `-debug` split): the tools resolve PROD, so dev shares this
// machine-level data. Copy only our own files; never clobber one already migrated. Idempotent.
{
  const target = resolveUserDataDir()
  const DATA_RE = /^ideas-.*\.json$|^usage-stats\.json$|^menu-prefs\.json$|^stats$/
  const home = join(homedir(), '.claude-super-app')
  if (existsSync(home) && home !== target) {
    try {
      mkdirSync(target, { recursive: true })
      for (const entry of readdirSync(home)) {
        if (!DATA_RE.test(entry)) continue
        const src = join(home, entry)
        const dst = join(target, entry)
        if (existsSync(src) && !existsSync(dst)) cpSync(src, dst, { recursive: true })
      }
    } catch { /* best-effort; the apps recreate their files if absent */ }
  }
}

// One-time cutover INTO the portable config-dir: carry this machine's legacy %APPDATA%\jamat PORTABLE
// files (app-state + snapshots, usage-cache, stats, usage-stats, menu-prefs, ideas, remote-activity)
// into the config-dir, plus a legacy committed config (the OLD launcher's JAMAT_CONFIG file →
// config.json). Does NOT move remote-control.json — that has its own dedicated cutover block below
// (which runs for explicit dirs too). Idempotent, non-clobber, best-effort. MUST run before
// loadAppState() so <config-dir>/app-state.json is in place.
//
// ONLY when NO explicit --config-dir was given (i.e. the DEFAULT ~/.jamat): an explicit dir is used
// VERBATIM — it's either an SVN-synced dir (its own synced state is the source of truth, don't pour
// this machine's local state over it) or a clean test dir (must stay empty so the wizard fires, not
// be back-filled with a migrated app-state whose onboardingComplete=true would suppress it).
if (!process.env['JAMAT_CONFIG_DIR']) {
  const legacy = process.env['JAMAT_CONFIG']
  const legacyConfigFile = legacy && (legacy.includes('/') || legacy.includes('\\')) ? resolve(legacy) : null
  migrateIntoConfigDir(configDir, app.getPath('userData'), legacyConfigFile)
}

// One-time cutover: bring the per-machine remote-control.json (machine key + peers) INTO the
// config-dir so ALL config lives in one place. Runs for an explicit --config-dir too (unlike the
// portable-state migration above, which is default-dir only) — each machine uses its own config-dir,
// so the key stays per-machine, just relocated next to the config it belongs with. MOVE it (delete
// the userData original) so it isn't left scattered; non-clobber when the config-dir already carries
// one (e.g. an SVN-synced dir → that synced key wins, the local stale one is just left ignored).
// Best-effort: remote-control-store regenerates a key if this fails. Then drop the bootstrap sentinel
// so removing the key from userData can't re-trigger the claude-super-app migration above next launch.
{
  const legacyKey = join(app.getPath('userData'), 'remote-control.json')
  const dstKey = getJamatPaths().remoteControl // <configDir>/remote-control.json
  if (existsSync(legacyKey) && !existsSync(dstKey)) {
    try {
      mkdirSync(dirname(dstKey), { recursive: true })
      cpSync(legacyKey, dstKey)
      rmSync(legacyKey, { force: true })
    } catch { /* best-effort */ }
  }
  try { writeFileSync(join(app.getPath('userData'), '.bootstrap-done'), '') } catch { /* best-effort */ }
}

// Initialize the unified, versioned app-state store NOW — after the legacy-dir pulls above have
// populated the config-dir — so its one-time migration folds any legacy window-state.json +
// groups.json + layouts/ + notes/ into app-state.json (then removes them) and takes the first launch
// snapshot, all BEFORE any window/manager reads window or layout state.
loadAppState()
