/**
 * Remote App Control config store: `<configDir>/remote-control.json` (lives WITH the rest of the
 * config — see `core/jamat-paths.ts`. Moved out of `<userData>` so ALL config sits in one place;
 * the localhost jamat gateway is loopback-trusted and no longer needs the key, so only the LAN
 * listener + the agent still read it.)
 *
 * Holds this machine's single key (auto-generated, >= MIN_TOKEN_LEN hex — gates the LAN control
 * surface), the `enabled` opt-in (default false → closed by default), the control-server
 * `listenPort`, and the list of peers this machine can connect to.
 *
 * Must be read AFTER `bootstrap-userdata` (so the config-dir is resolved + the per-machine key is
 * migrated in) — all reads happen inside `app.whenReady`, never at import time. The agent reads the
 * SAME file from its own resolved config-dir (see `app-agent`), without importing electron.
 *
 * Atomic tmp+rename write (mirrors `ideas-manager.ts`). Process-wide cache so
 * the control-server and IPC handlers share one instance.
 */

import { app } from 'electron'
import { hostname } from 'os'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { randomBytes } from 'crypto'
import { logError } from './logger'
import { getJamatPaths } from './jamat-paths'
import type { RemoteControlData } from '../../../core/types/remote-control.js'
import { CONTROL_PORT_PACKAGED, CONTROL_PORT_DEV } from '../../../core/types/remote-control.js'
import { normalizeRemoteControlData, sanitizeForSave } from '../../../core/remote-control-config.js'

function filePath(): string {
  return getJamatPaths().remoteControl
}

function genToken(): string {
  // 24 bytes → 48 hex chars, comfortably above MIN_TOKEN_LEN.
  return randomBytes(24).toString('hex')
}

function defaultPort(): number {
  return app.isPackaged ? CONTROL_PORT_PACKAGED : CONTROL_PORT_DEV
}

/** This machine's default instance-id `<machine>` prefix: the short, lowercased hostname.
 *  Overridable in remote-control.json so it can be aligned with the name peers use for us. */
function defaultSelfName(): string {
  const h = hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')
  return h || 'local'
}

function defaults(): RemoteControlData {
  return { enabled: false, token: genToken(), listenPort: defaultPort(), selfName: defaultSelfName(), peers: [] }
}

let cache: RemoteControlData | null = null

export function loadRemoteControl(): RemoteControlData {
  if (cache) return cache
  const p = filePath()
  if (!existsSync(p)) {
    cache = defaults()
    saveRemoteControl(cache)
    return cache
  }
  try {
    const { data, mutated: tokenMutated } = normalizeRemoteControlData(
      JSON.parse(readFileSync(p, 'utf-8')),
      { defaultPort: defaultPort(), genToken },
    )
    // Seed this machine's selfName on first sight (the file predates the field) so the
    // instance-id `<machine>` prefix is always populated. (`mutated` is a fresh `let` — the
    // destructured `tokenMutated` is const and assigning to it would throw at runtime.)
    let mutated = tokenMutated
    if (!data.selfName) { data.selfName = defaultSelfName(); mutated = true }
    cache = data
    if (mutated) saveRemoteControl(data) // persist a regenerated token / seeded selfName
    return cache
  } catch (err) {
    try { logError('remote-control', `load failed, using defaults: ${err}`) } catch { /* logger needs electron */ }
    cache = defaults()
    return cache
  }
}

export function getRemoteControl(): RemoteControlData {
  return cache ?? loadRemoteControl()
}

/** This machine's instance-id `<machine>` prefix (selfName), always populated. */
export function getSelfName(): string {
  return getRemoteControl().selfName || defaultSelfName()
}

export function saveRemoteControl(data: RemoteControlData): { ok: boolean; error?: string } {
  try {
    // Defensive: never persist a weak token or junk peers.
    const safe = sanitizeForSave(data, genToken)
    const p = filePath()
    mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(safe, null, 2), 'utf-8')
    renameSync(tmp, p)
    cache = safe
    return { ok: true }
  } catch (err) {
    const msg = String(err)
    try { logError('remote-control', `save failed: ${msg}`) } catch { /* logger needs electron */ }
    return { ok: false, error: msg }
  }
}
