/**
 * The single map of "which Jamat file lives where" — built once per process from the resolved
 * portable config-dir + the per-machine userData dir. Replaces the scattered `join(getPath(…), …)`
 * sites so there is exactly ONE place that decides portable (config-dir) vs per-machine (userData).
 * Pure, no electron.
 */
import { join } from 'node:path'
import { REMOTE_CONTROL_FILE } from './paths.js'

export interface JamatPaths {
  /** Portable, relocatable via --config-dir (default ~/.jamat[-debug]). */
  configDir: string
  /** Per-machine (%APPDATA%\jamat[-debug]) — only the machine key + Electron caches. */
  userDataDir: string
  configFile: string         // <configDir>/config.json
  configOverlay: string      // <configDir>/config.local.json (secret overlay)
  appState: string           // <configDir>/app-state.json
  snapshotsDir: string       // <configDir>/snapshots
  usageCache: string         // <configDir>/usage-cache.json
  statsDir: string           // <configDir>/stats
  usageStats: string         // <configDir>/usage-stats.json
  menuPrefs: string          // <configDir>/menu-prefs.json
  ideasDir: string           // <configDir>/ (ideas-<windowId>.json)
  remoteActivityDir: string  // <configDir>/remote-activity
  remoteControl: string      // <configDir>/remote-control.json (machine key + peers — lives WITH the config)
  /** <configDir>/update-log.jsonl — the ONLY log that survives the restart an update causes. */
  updateLog: string
}

export function buildJamatPaths(configDir: string, userDataDir: string): JamatPaths {
  return {
    configDir,
    userDataDir,
    configFile: join(configDir, 'config.json'),
    configOverlay: join(configDir, 'config.local.json'),
    appState: join(configDir, 'app-state.json'),
    snapshotsDir: join(configDir, 'snapshots'),
    usageCache: join(configDir, 'usage-cache.json'),
    statsDir: join(configDir, 'stats'),
    usageStats: join(configDir, 'usage-stats.json'),
    menuPrefs: join(configDir, 'menu-prefs.json'),
    ideasDir: configDir,
    remoteActivityDir: join(configDir, 'remote-activity'),
    remoteControl: join(configDir, REMOTE_CONTROL_FILE),
    updateLog: join(configDir, 'update-log.jsonl'),
  }
}
