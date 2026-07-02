/**
 * Zero-dep HTTP client for the Jamat (native `node:http` only). The existing
 * `app-electron/src/main/remote-client.ts httpJson` is electron-coupled, so the
 * CLI (and any future MCP adapter) needs its own client living in `core/`.
 *
 * Talks to a peer's control-server (token-gated REST) and its agent-server. The
 * bearer is the peer's normal `token` — the Jamat reaches peers with the same
 * credential a human would; AI-origin is flagged by the `X-Jamat` marker. This
 * runs inside the controller's local gateway (main), never in the AI's process.
 */

import http from 'node:http'
import { hostname } from 'node:os'
import { dispatch } from '../op/dispatch.js'
import type { Via } from '../op/types.js'

/** Shared keep-alive agent: the many sequential bridge requests — especially the
 * await poll loop hammering one peer — reuse TCP connections instead of paying a
 * fresh handshake each time. LAN + plain http, so one agent covers every
 * controlPost / controlGet / agent* call. A reused socket the peer closed can throw a
 * one-off ECONNRESET; the await loop tolerates a failed poll, and one-shot verbs
 * surface it to the caller for a retry. */
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 15_000 })

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The connection coordinates + token needed to reach one peer. */
export interface PeerRef {
  /** Display label (for logs/errors); not used on the wire. */
  name?: string
  host: string
  controlPort: number
  agentPort: number
  /** The peer's normal control token (same one human remote control uses). */
  token: string
  /** Optional Wake-on-LAN coordinates (see reachability.ts). */
  mac?: string
  wolProxyUrl?: string
  /** When set, this PeerRef is the LOCAL instance (self-control): `controlPost` dispatches the
   *  control op IN-PROC via `dispatch` (no HTTP, no token), under `selfVia`. The gateway builds
   *  a self peer for a `self` target, stamping the ORIGINATING via — so a `self` call never
   *  escalates (bridge ops are local-only `['ui','ai']`, so `selfVia` is never `'remote'`). */
  self?: boolean
  selfVia?: Via
}

export interface HttpResult {
  status: number
  body: any
}

/**
 * One JSON request. Resolves with `{status, body}` for any HTTP response
 * (including 4xx/5xx — the caller decides); rejects only on transport/timeout.
 */
export function httpJson(
  host: string,
  port: number,
  method: 'GET' | 'POST',
  path: string,
  opts: { token?: string; body?: unknown; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const { token, body, timeoutMs = 8000, headers: extra } = opts
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host, port, method, path,
        agent: keepAliveAgent,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(extra ?? {}),
        },
      },
      (res) => {
        // The request-phase timeout below does NOT cover the body — re-arm it on
        // the response so a peer that sends headers then stalls can't hang forever.
        res.setTimeout(timeoutMs, () => req.destroy(new Error(`response timeout after ${timeoutMs}ms`)))
        res.on('error', reject)
        res.on('aborted', () => reject(new Error('response aborted')))
        let buf = ''
        res.on('data', (c) => { buf += c })
        res.on('end', () => {
          let parsed: any = undefined
          try { parsed = buf ? JSON.parse(buf) : {} } catch { parsed = { raw: buf } }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`request timeout after ${timeoutMs}ms`)) })
    if (payload) req.write(payload)
    req.end()
  })
}

/** Self-control: dispatch the control op IN-PROC (no HTTP) under the originating `via`.
 * The op's `data` is the same body shape the HTTP path returns, so callers are unchanged.
 * Throws on a Result failure (mirroring controlPost's throw-on-non-2xx). */
let selfSeq = 0
async function selfControl(op: string, body: unknown, via: Via, corrId?: string): Promise<any> {
  const r = await dispatch(`control:${op}`, [body], { via, corrId: corrId ?? `self-${++selfSeq}`, marker: corrId })
  if (!r.ok) throw new Error(r.error ? `${op}: ${r.error}` : `${op}: failed`)
  return r.data
}

/** POST a control-server op (bearer = peer token). ALWAYS stamps `X-Jamat` —
 * every controlPost is Jamat-driven (the human UI path uses remote-client's own
 * client, never this), so the controlled side must attribute it to the AI, not a
 * human. Without this, a read that omits an explicit `corrId` (e.g. a scrollback
 * peek or seq probe) was mis-tagged `[human]`. Throws on non-2xx. A `self` peer routes
 * in-proc (above) instead. */
export async function controlPost(peer: PeerRef, op: string, body: unknown, opts: { timeoutMs?: number; corrId?: string } = {}): Promise<any> {
  if (peer.self) return selfControl(op, body, peer.selfVia ?? 'ai', opts.corrId)
  // X-Remote-Machine labels the controller in the peer's Remote Activity Log
  // (advisory display only, never used for auth). X-Jamat flags AI origin;
  // `corrId` joins the call to its exchange, `gw` is the fallback for standalone
  // calls (tabs / seq probe) that have no specific exchange id.
  const headers: Record<string, string> = {
    'X-Remote-Machine': hostname(),
    'X-Jamat': opts.corrId ?? 'gw',
  }
  const r = await httpJson(peer.host, peer.controlPort, 'POST', `/control/${op}`, { token: peer.token, body, timeoutMs: opts.timeoutMs, headers })
  if (r.status < 200 || r.status >= 300) throw new Error(r.body?.error ? `${op}: ${r.body.error} (${r.status})` : `${op}: HTTP ${r.status}`)
  return r.body
}

/** Drop a large task as a FILE on the peer (the bridge's >4 KB delivery path, avoiding
 * keystroke truncation + multi-line paste hazards). Returns the server-owned path the
 * peer wrote it to. Throws on non-2xx. */
export async function putTask(peer: PeerRef, corrId: string, text: string): Promise<string> {
  const r = await controlPost(peer, 'put-task', { corrId, text }, { corrId })
  return String(r?.path ?? '')
}

/** Read the remote's answer FILE (the file answer channel), or null if not written
 * yet. Polled during await alongside scrollback-marker scanning. Throws only on a
 * transport error (the caller polling should swallow that and keep waiting). */
export async function getAnswer(peer: PeerRef, corrId: string): Promise<string | null> {
  const r = await controlPost(peer, 'get-answer', { corrId })
  return r?.found ? String(r.text ?? '') : null
}

/** GET a control-server route (bearer = peer token). Returns the raw result; does NOT throw on non-2xx (unlike `controlPost`). */
export async function controlGet(peer: PeerRef, path: string, timeoutMs?: number): Promise<HttpResult> {
  return httpJson(peer.host, peer.controlPort, 'GET', path, { token: peer.token, timeoutMs })
}

/** GET an unauthenticated agent-server route (the health probe). Returns the raw result; does NOT throw. */
export async function agentGet(peer: PeerRef, path: string, timeoutMs?: number): Promise<HttpResult> {
  return httpJson(peer.host, peer.agentPort, 'GET', path, { timeoutMs })
}

/** POST an agent-server route (bearer = peer token). Returns the raw result; does NOT throw. */
export async function agentPost(peer: PeerRef, path: string, body: unknown, timeoutMs?: number): Promise<HttpResult> {
  return httpJson(peer.host, peer.agentPort, 'POST', path, { token: peer.token, body, timeoutMs })
}
