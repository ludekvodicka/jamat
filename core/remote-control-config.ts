/**
 * Pure (electron-free, fs-free) normalization for the Remote App Control config.
 * Lives in `core/` so the security-critical invariant — a weak/missing token is
 * NEVER kept (it must be regenerated before it can gate a LAN-exposed RCE
 * surface) — is unit-testable via `scripts/smoke-remote-control.ts` without
 * booting electron. The electron-coupled `app-electron/src/main/remote-control-store.ts`
 * supplies the userData path + a crypto token generator and delegates here.
 */

import type { RemoteControlData, RemotePeer } from './types/remote-control.js'
import { MIN_TOKEN_LEN, isValidControlPort } from './types/remote-control.js'

export function isValidPeer(x: unknown): x is RemotePeer {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o.id === 'string'
    && typeof o.name === 'string'
    && typeof o.host === 'string'
    && typeof o.controlPort === 'number'
    && typeof o.agentPort === 'number'
    && typeof o.token === 'string'
}

export interface NormalizeOpts {
  /** Default listen port when the stored value is absent/invalid. */
  defaultPort: number
  /** Strong-token generator (caller supplies crypto). */
  genToken: () => string
}

/**
 * Coerce arbitrary parsed JSON into a valid `RemoteControlData`. `mutated` is
 * true when we had to change something that must be persisted back — currently
 * only a regenerated weak/missing token.
 */
export function normalizeRemoteControlData(raw: unknown, opts: NormalizeOpts): { data: RemoteControlData; mutated: boolean } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  let mutated = false

  // The single key (V2 unified token+aiToken). A weak/missing one is regenerated +
  // persisted (it gates a LAN-exposed RCE surface, so it must meet the min length).
  let token: string
  if (typeof o.token === 'string' && o.token.length >= MIN_TOKEN_LEN) {
    token = o.token
  } else {
    token = opts.genToken()
    mutated = true
  }

  const data: RemoteControlData = {
    enabled: o.enabled === true,
    token,
    listenPort: isValidControlPort(o.listenPort) ? o.listenPort : opts.defaultPort,
    peers: Array.isArray(o.peers) ? (o.peers as unknown[]).filter(isValidPeer) : [],
    // This machine's own short name (instance-id `<machine>` prefix). Kept verbatim if a non-empty
    // string; otherwise absent → the electron store seeds it from the hostname (core is host-agnostic).
    ...(typeof o.selfName === 'string' && o.selfName.trim() ? { selfName: o.selfName.trim() } : {}),
    // Optional Jamat scratch dir (for `open --scratch` + put-task drops); kept
    // verbatim if a string, else absent → callers fall back to the home dir.
    ...(typeof o.bridgeScratchDir === 'string' ? { bridgeScratchDir: o.bridgeScratchDir } : {}),
  }
  return { data, mutated }
}

/** Defensive sanitize on the save path — never write a weak token or junk peers. */
export function sanitizeForSave(data: RemoteControlData, genToken: () => string): RemoteControlData {
  return {
    enabled: data.enabled === true,
    token: typeof data.token === 'string' && data.token.length >= MIN_TOKEN_LEN ? data.token : genToken(),
    listenPort: isValidControlPort(data.listenPort) ? data.listenPort : 47200,
    peers: Array.isArray(data.peers) ? data.peers.filter(isValidPeer) : [],
    ...(typeof data.selfName === 'string' && data.selfName.trim() ? { selfName: data.selfName.trim() } : {}),
    ...(typeof data.bridgeScratchDir === 'string' ? { bridgeScratchDir: data.bridgeScratchDir } : {}),
  }
}
