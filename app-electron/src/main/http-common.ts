/**
 * Shared HTTP primitives for the Electron main process's unified op-server — its two
 * listeners (localhost dev/CLI surface + LAN control surface). MECHANICS ONLY: body
 * reading, JSON sending, bearer extraction, constant-time compare, and the Host/Origin
 * gate.
 *
 * The per-surface AUTH POLICY (who is trusted, with which credential) stays in each
 * server — this module is deliberately NOT a "god auth" function; each surface
 * COMPOSES these primitives into its own gate. That keeps the three trust models
 * independent while the duplicated plumbing lives in one tested place.
 *
 * Electron-free (node:http types + node:crypto only) so it unit-tests directly. Lives
 * in app-electron/src/main, NOT core/ — core/ carries no HTTP server code (zero-dep).
 */

import type { IncomingMessage, ServerResponse } from 'http'
import { timingSafeEqual, createHash } from 'crypto'

/** 1 MiB — far above any legitimate JSON-args / task payload; a same-host process
 *  can't OOM a surface with a multi-GB POST. */
export const DEFAULT_MAX_BODY = 1 << 20

/** Send a JSON response (pretty-printed — localhost/LAN diagnostic payloads). */
export function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data, null, 2))
}

/**
 * Read a BOUNDED JSON request body, then run `handler(parsedBody)`. Empty body → `{}`.
 * Overflow (> maxBytes) → 413, malformed JSON → 400, stream error → 400 — all sent by
 * this fn ({ ok: false, error }); the handler is NOT called in those cases. The handler
 * may be async; a rejection surfaces as 500 (so a throwing route can't hang the socket).
 * `body` is `any` — it's untyped wire JSON the surfaces already access loosely and
 * validate per-field at runtime (matches the inline readers it replaces — one of which
 * lacked the cap). One bounded reader for every surface.
 */
export function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (body: any) => void | Promise<void>,
  opts: { maxBytes?: number } = {},
): void {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BODY
  const chunks: Buffer[] = []
  let total = 0
  let aborted = false
  const fail = (msg: string, code: number): void => { aborted = true; sendJson(res, { ok: false, error: msg }, code) }
  req.on('error', () => { if (!aborted) fail('request stream error', 400) })
  req.on('data', (c: Buffer) => {
    if (aborted) return
    total += c.length
    if (total > maxBytes) { fail('request body too large', 413); req.destroy(); return }
    chunks.push(c)
  })
  req.on('end', () => {
    if (aborted) return
    let body: unknown
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {} }
    catch { fail('invalid JSON body', 400); return }
    void Promise.resolve(handler(body)).catch((e: any) => { if (!aborted) sendJson(res, { ok: false, error: String(e?.message ?? e) }, 500) })
  })
}

/** The Bearer token from the Authorization header, or undefined. */
export function bearerToken(req: IncomingMessage): string | undefined {
  const h = req.headers['authorization']
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : undefined
}

/** Constant-time string compare. Returns false (never throws) on a missing value or a
 *  length mismatch — the single tested home for the credential comparison. */
export function timingSafeMatch(provided: string | undefined, secret: string | undefined): boolean {
  if (!provided || !secret) return false
  // Hash both sides to a fixed width before the compare so the length check can't leak the secret
  // length via timing (the digests are always 32 bytes → no length branch).
  try {
    return timingSafeEqual(createHash('sha256').update(provided).digest(), createHash('sha256').update(secret).digest())
  } catch { return false }
}

/** True when the request carries an Origin header — any browser fetch/XHR/WS sets it;
 *  curl, scripts and same-process tools do not. Surfaces reject these so a webpage
 *  can't drive the API as a drive-by (and DNS-rebind can't smuggle one in). */
export function hasBrowserOrigin(req: IncomingMessage): boolean {
  return !!req.headers.origin
}

/** True when the request's Host header is in `allowed` (full `host:port` OR bare host).
 *  Defence-in-depth against DNS-rebind (a page that rebinds evil.com → 127.0.0.1 still
 *  sends `Host: evil.com`, which won't match) — the bearer token is the real gate.
 *  Handles bracketed IPv6 literals (`[::1]:port`): the stored allow-list entries are
 *  bare (`::1`), so the brackets are stripped and the port split off before comparing,
 *  otherwise a naive `split(':')[0]` would yield `[` and IPv6 hosts would never match. */
export function hostAllowed(req: IncomingMessage, allowed: Set<string>): boolean {
  const raw = String(req.headers.host ?? '').toLowerCase()
  if (!raw) return false
  if (allowed.has(raw)) return true
  let host: string
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']') // [::1]:port → ::1
    host = end > 0 ? raw.slice(1, end) : raw.slice(1)
  } else {
    host = raw.split(':')[0] // host:port / 127.0.0.1:port → host
  }
  return allowed.has(host)
}
