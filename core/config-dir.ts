/**
 * The ONE source of truth for the portable config-dir — the relocatable directory holding all
 * portable Jamat state (config, app-state, usage cache, stats, ideas, remote-activity). Pure, no
 * electron, so every process (Electron main, app-cli, app-agent, app-stats) resolves the IDENTICAL
 * path and the data never re-forks. `remote-control.json` (the machine key + peers) also lives in the
 * config-dir now — see `core/jamat-paths.ts`; it's relocated there by a dedicated cutover block in
 * `app-electron/src/main/bootstrap-userdata.ts` (NOT by `migrateIntoConfigDir` below).
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, readdirSync, cpSync } from 'node:fs'
import { CONFIG_DIR_NAME } from './paths.js'

export interface ConfigDirOpts {
  /** Explicit dir from `--config-dir` / `JAMAT_CONFIG_DIR`. Used VERBATIM (no `-debug` suffix). */
  explicit?: string | null
  /** Dev build → add the `-debug` leaf (Electron-owned state) so dev and prod don't bleed. Only
   *  applied to the DEFAULT `~/.jamat` — an explicit dir is always used as-is. */
  debug?: boolean
}

/** Resolve the portable config-dir. Precedence: explicit (`--config-dir`/env) → `~/.jamat[-debug]`. */
export function resolveConfigDir(opts: ConfigDirOpts = {}): string {
  const explicit = opts.explicit?.trim()
  if (explicit) return resolve(explicit)
  return join(homedir(), CONFIG_DIR_NAME + (opts.debug ? '-debug' : ''))
}

/** Portable files carried into the config-dir from a legacy `%APPDATA%\jamat`. Does NOT include
 *  `remote-control.json` — that has its own dedicated cutover in bootstrap-userdata (so it moves for
 *  explicit config-dirs too, not just the default) — nor Electron's own caches (GPUCache/…). */
const PORTABLE_RE = /^(app-state\.json|snapshots|usage-cache\.json|stats|usage-stats\.json|menu-prefs\.json|remote-activity|ideas-.*\.json)$/

/**
 * One-time, idempotent, non-clobber migration INTO the config-dir (mirrors the bootstrap-userdata
 * shape). No-op once `<configDir>/config.json` exists. Copies the portable runtime files out of the
 * legacy userData dir (skipping the machine key + caches) and, if given, the legacy committed config
 * (`.private/configs/config-<user>.json` → `config.json`, plus its `.local.json` overlay). Best-effort:
 * a failed copy degrades to the onboarding wizard, never throws.
 */
export function migrateIntoConfigDir(configDir: string, legacyUserDataDir: string, legacyConfigFile?: string | null): void {
  const configFile = join(configDir, 'config.json')
  if (existsSync(configFile)) return
  try { mkdirSync(configDir, { recursive: true }) } catch { return }

  if (legacyUserDataDir && existsSync(legacyUserDataDir)) {
    let entries: string[] = []
    try { entries = readdirSync(legacyUserDataDir) } catch { entries = [] }
    for (const entry of entries) {
      if (!PORTABLE_RE.test(entry)) continue
      const dst = join(configDir, entry)
      if (existsSync(dst)) continue // never clobber a newer/migrated file
      try { cpSync(join(legacyUserDataDir, entry), dst, { recursive: true }) } catch { /* best-effort */ }
    }
  }

  if (legacyConfigFile && existsSync(legacyConfigFile) && !existsSync(configFile)) {
    try {
      cpSync(legacyConfigFile, configFile)
      const overlay = legacyConfigFile.replace(/\.json$/i, '.local.json')
      if (existsSync(overlay) && !existsSync(join(configDir, 'config.local.json'))) {
        cpSync(overlay, join(configDir, 'config.local.json'))
      }
    } catch { /* best-effort */ }
  }
}
