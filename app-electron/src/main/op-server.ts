/**
 * Unified op-server — the HTTP+WS transport for the op layer (plan 002 P2).
 *
 * Replaces the three separate servers (debug-api + ai-gateway + control-server) with
 * ONE module managing TWO listeners — the two trust zones V1 had, now both routed
 * through the single `dispatch()` chokepoint:
 *
 *   • LOCAL listener  — 127.0.0.1, ALWAYS on (dev tooling + local AI/CLI).
 *       /debug/*     → debug ops   (no key; localhost-trusted, V1 debug-api parity)
 *       /jamat/* → bridge ops  (machine-key gated; V1 ai-gateway parity)
 *       /op          → generic dispatch (key gated)
 *     Source is always loopback here → `via:'ai'` (full local power).
 *
 *   • LAN listener    — 0.0.0.0, on only when `enabled && key >= MIN_TOKEN_LEN`.
 *       /control/*   → control ops (the 7 remote-reachable ops)
 *       /op          → generic dispatch
 *       WS           → live tab stream + keystroke injection
 *     Full V1 control gate: enabled → no-Origin → Host-allowlist → bearer key,
 *     plus per-IP rate limit + OPTIONS-403. `via` by source: loopback→`'ai'`,
 *     LAN→`'remote'` (so a remote peer reaches ONLY the `reach:['…','remote']` ops).
 *
 * ONE key: the machine `token` gates `/jamat`, `/op`, and the whole LAN surface
 * (V2 removed the old separate `aiToken`). Peers still speak the exact `/control/*` + WS
 * wire protocol on the same control port, so V1 interop is unchanged.
 *
 * Response shaping preserves each V1 family's body: `/control` + `/debug` send the op's
 * `data` verbatim (errors as `{error}` + status); `/jamat` the same (errors as
 * `{ok:false,error}`); `/op` the structured `{ok,data}` / `{ok:false,error,code}`.
 */

import http from 'node:http'
import { networkInterfaces, hostname, homedir } from 'node:os'
import { WebSocketServer, type WebSocket } from 'ws'
import { BrowserWindow } from 'electron'

import { sendJson, readJsonBody, bearerToken, timingSafeMatch, hasBrowserOrigin, hostAllowed } from './http-common.js'
import { dispatch } from '../../../core/op/dispatch.js'
import type { OpCtx, Via } from '../../../core/op/types.js'
import { getRemoteControl } from './remote-control-store'
import { getAppVersion } from './app-root'
import {
  writeToPty, getTerminalSnapshot, subscribeTerminal, hasBufferedTerminal,
} from './pty-manager'
import { publish } from './streams'
import { getIsRestarting } from './app-state'
import { recordRemoteActivity } from './remote-activity'
import { logError, logInfo } from './logger'
import { CONTROL_OPS, MIN_TOKEN_LEN, REMOTE_PROTOCOL, APP_ID } from '../../../core/types/remote-control.js'
import type { WsServerMsg, WsClientMsg } from '../../../core/types/remote-control.js'
import { app } from 'electron'

const MAX_KEYS_BYTES = 4096
const RATE_WINDOW_MS = 10_000
const RATE_MAX = 300
const WS_MSG_PER_SEC = 200
const WS_HEARTBEAT_MS = 30_000
const WS_MAX_PAYLOAD = 64 * 1024

// ── corrId + via ─────────────────────────────────────────────────────────────
let corrSeq = 0
function nextCorr(): string { return `op-${++corrSeq}` }

function isLoopback(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.')
}

/** The single machine key (V2 unified token+aiToken into one). Gates every keyed surface. */
function machineKey(): string { return getRemoteControl().token }

function keyOk(req: http.IncomingMessage): boolean {
  const key = machineKey()
  if (!key || key.length < MIN_TOKEN_LEN) return false
  return timingSafeMatch(bearerToken(req), key)
}

/** The `X-Jamat` marker (corrId) when the request is Jamat-driven, else undefined. */
function jamatMarker(req: http.IncomingMessage): string | undefined {
  const h = req.headers['x-jamat']
  return typeof h === 'string' && /^[\w:-]{1,128}$/.test(h) ? h : undefined
}

/** The controller's self-reported machine name (`X-Remote-Machine`) — audit label only. */
function remoteMachine(req: http.IncomingMessage): string | undefined {
  const h = req.headers['x-remote-machine']
  return typeof h === 'string' && /^[\w.\- :]{1,64}$/.test(h) ? h : undefined
}

function ctxFor(req: http.IncomingMessage, via: Via): OpCtx {
  const ip = req.socket.remoteAddress ?? 'unknown'
  return { via, corrId: nextCorr(), machine: remoteMachine(req) ?? ip, marker: jamatMarker(req) }
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?')
  if (idx < 0) return {}
  const params: Record<string, string> = {}
  for (const part of url.slice(idx + 1).split('&')) {
    const [k, v] = part.split('=')
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? '')
  }
  return params
}

/** Map an op-Result failure `code` to the V1 HTTP status. */
function statusFromCode(code?: string): number {
  switch (code) {
    case 'bad_args': return 400
    case 'not_found': case 'no_op': return 404
    case 'too_large': return 413
    case 'reach_denied': case 'dev_only': return 403
    case 'no_window': case 'write_failed': case 'threw': return 500
    default: return 400
  }
}

// ── /op generic endpoint (both listeners) ────────────────────────────────────
function handleOp(req: http.IncomingMessage, res: http.ServerResponse, via: Via, onActivity?: () => void): void {
  if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'method not allowed' }, 405); return }
  readJsonBody(req, res, async (body) => {
    onActivity?.()
    const name = String(body?.name ?? '')
    const args = Array.isArray(body?.args) ? body.args : []
    const result = await dispatch(name, args, ctxFor(req, via))
    if (result.ok) sendJson(res, { ok: true, data: result.data })
    else sendJson(res, { ok: false, error: result.error, code: result.code }, statusFromCode(result.code))
  })
}

// ── LOCAL listener (127.0.0.1, always on) ────────────────────────────────────
let localServer: http.Server | null = null
let localAllowedHostSet = new Set<string>()

function localPort(): number {
  const env = process.env.DEBUG_API_PORT
  if (env && /^\d+$/.test(env)) return parseInt(env, 10)
  return app.isPackaged ? 47100 : 47101
}

// `${method} ${path}` → debug op name. Every debug op takes the parsed query as its
// single arg. The two curl aliases (file-diff-options, sessions/rename) + /debug/ipc
// are handled specially / removed below.
const DEBUG_ROUTES: Record<string, string> = {
  'GET /debug/health': 'debug:health',
  'GET /debug/info': 'debug:info',
  'GET /debug/logs': 'debug:logs',
  'GET /debug/remote-activity-log': 'debug:remote-activity-log',
  'GET /debug/config': 'debug:config',
  'GET /debug/windows': 'debug:windows',
  'GET /debug/terminals': 'debug:terminals',
  'GET /debug/screen-state': 'debug:screen-state',
  'GET /debug/usage': 'debug:usage',
  'POST /debug/usage/refresh': 'debug:usage-refresh',
  'POST /debug/reload': 'debug:reload',
  'POST /debug/restart': 'debug:restart',
  'POST /debug/fullrestart': 'debug:fullrestart',
  'POST /debug/build-reload': 'debug:build-reload',
  'POST /debug/build-restart': 'debug:build-restart',
  'POST /debug/update': 'debug:update',
  'POST /debug/open-tab': 'debug:open-tab',
  'GET /debug/sessions': 'debug:sessions',
  'POST /debug/sessions/open': 'debug:sessions-open',
  'GET /debug/sessions/open': 'debug:sessions-open-check',
  'GET /debug/file-changes': 'debug:file-changes',
  'POST /debug/generate-stats': 'debug:generate-stats',
}

async function dispatchDebug(req: http.IncomingMessage, res: http.ServerResponse, opName: string, query: Record<string, string>): Promise<void> {
  const result = await dispatch(opName, [query], ctxFor(req, 'ai'))
  if (result.ok) sendJson(res, result.data)
  else sendJson(res, { error: result.error }, statusFromCode(result.code))
}

function handleLocal(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method === 'OPTIONS') { res.statusCode = 403; res.end(); return }
  // Host check (anti-DNS-rebind) + no-Origin (anti browser drive-by) — V1 debug-api gate.
  if (hasBrowserOrigin(req) || !hostAllowed(req, localAllowedHostSet)) {
    res.statusCode = 403; res.setHeader('Content-Type', 'text/plain'); res.end('forbidden'); return
  }
  const method = req.method ?? 'GET'
  const pathname = (req.url ?? '/').split('?')[0]
  const query = parseQuery(req.url ?? '/')

  // /jamat/* — loopback-trusted (same stance as /debug/* below): this server binds 127.0.0.1 only
  // and is Host/Origin-guarded above, so a local caller (the `jamat` CLI) needs NO machine key. The
  // key now lives in the config-dir and is required ONLY on the LAN listener (handleLan). Dropping it
  // here lets the CLI work without locating the active config-dir or setting JAMAT_CONFIG_DIR — the
  // running app already holds the key per its own config and does the privileged work (peer drive).
  if (pathname.startsWith('/jamat/')) {
    const sub = pathname.slice('/jamat/'.length)
    if (method === 'GET' && (sub === 'help' || sub === 'peers')) {
      void dispatch(`bridge:${sub}`, [], ctxFor(req, 'ai')).then((result) => {
        if (result.ok) sendJson(res, result.data)
        else sendJson(res, { ok: false, error: result.error }, statusFromCode(result.code))
      })
      return
    }
    if (method !== 'POST') { sendJson(res, { ok: false, error: 'method not allowed' }, 405); return }
    readJsonBody(req, res, async (body) => {
      const result = await dispatch(`bridge:${sub}`, [body], ctxFor(req, 'ai'))
      if (result.ok) sendJson(res, result.data)
      else sendJson(res, { ok: false, error: result.error }, statusFromCode(result.code))
    })
    return
  }

  // /op — generic dispatch (key gated).
  if (pathname === '/op') {
    if (!keyOk(req)) { sendJson(res, { ok: false, error: 'unauthorized' }, 401); return }
    handleOp(req, res, 'ai')
    return
  }

  // /debug/* — no key (localhost-trusted, V1 parity).
  // Two curl aliases route straight to their P1 IPC ops:
  if (method === 'GET' && pathname === '/debug/file-diff-options') {
    const filePath = query.file ?? ''
    if (!filePath) { sendJson(res, { error: 'Pass ?file=<absPath>[&project=<dir>][&session=<id>]' }, 400); return }
    void dispatch('file-diff:list-options', [filePath, query.project || null, query.session || null], ctxFor(req, 'ai'))
      .then((result) => { if (result.ok) sendJson(res, result.data); else sendJson(res, { error: result.error }, statusFromCode(result.code)) })
    return
  }
  if (method === 'POST' && pathname === '/debug/sessions/rename') {
    if (app.isPackaged) { sendJson(res, { error: 'rename is dev-only (rw)' }, 403); return }
    const projectDir = query.project ?? ''
    const sessionId = query.session ?? ''
    if (!projectDir || !sessionId) { sendJson(res, { error: 'Pass ?project=<projectDir>&session=<sessionId> with body { name: "..." }' }, 400); return }
    readJsonBody(req, res, async (body) => {
      let name = query.name ?? ''
      if (!name && typeof body?.name === 'string') name = body.name
      if (!name) { sendJson(res, { error: 'Missing `name` (in body JSON or ?name= query)' }, 400); return }
      const result = await dispatch('sessions:rename', [projectDir, sessionId, name], ctxFor(req, 'ai'))
      if (result.ok) sendJson(res, result.data); else sendJson(res, { error: result.error }, statusFromCode(result.code))
    })
    return
  }
  const opName = DEBUG_ROUTES[`${method} ${pathname}`]
  if (opName) { void dispatchDebug(req, res, opName, query); return }

  sendJson(res, {
    error: 'not found',
    endpoints: Object.keys(DEBUG_ROUTES).concat(['GET /debug/file-diff-options', 'POST /debug/sessions/rename', 'POST /op', 'POST /jamat/<verb>']),
  }, 404)
}

// ── LAN listener (0.0.0.0, conditional) ──────────────────────────────────────
let lanServer: http.Server | null = null
let wss: WebSocketServer | null = null
let boundPort = 0
let lanAllowedHostSet = new Set<string>()

function computeAllowedHosts(port: number): void {
  const names = new Set<string>(['127.0.0.1', 'localhost', hostname().toLowerCase()])
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' || i.family === 'IPv6') names.add(i.address.toLowerCase())
    }
  }
  const set = new Set<string>()
  for (const n of names) { set.add(n); set.add(`${n}:${port}`) }
  lanAllowedHostSet = set
}

/** Full LAN gate: opt-in + no-Origin + Host-allowlist + valid key (V1 control-server authorized()). */
function lanAuthorized(req: http.IncomingMessage): boolean {
  if (!getRemoteControl().enabled) return false
  if (hasBrowserOrigin(req)) return false
  if (!hostAllowed(req, lanAllowedHostSet)) return false
  return timingSafeMatch(bearerToken(req), machineKey())
}

// per-IP rate limit (fixed window)
const hits = new Map<string, { n: number; start: number }>()
function rateOk(ip: string): boolean {
  const now = Date.now()
  const e = hits.get(ip)
  if (!e || now - e.start > RATE_WINDOW_MS) {
    hits.set(ip, { n: 1, start: now })
    // Opportunistic eviction: once the map grows past a small bound, drop entries
    // whose window has already elapsed so it can't accumulate stale source IPs over
    // long uptime. Bounded by LAN host count in practice; this is the backstop.
    if (hits.size > 64) {
      for (const [k, v] of hits) if (now - v.start > RATE_WINDOW_MS) hits.delete(k)
    }
    return true
  }
  e.n++
  return e.n <= RATE_MAX
}

// activity → passive indicator (throttled broadcast)
let lastActiveEmit = 0
let lastPeerLabel = ''
function signalActivity(peer: string): void {
  lastPeerLabel = peer
  if (sessionEndDebounce) { clearTimeout(sessionEndDebounce); sessionEndDebounce = null }
  const now = Date.now()
  if (now - lastActiveEmit < 1500) return
  lastActiveEmit = now
  publish('remote:session-active', { active: true, peerLabel: peer, lastActionTs: now })
}

// live WS connections drive the indicator (on-edge re-asserted, off-edge debounced)
const liveWsConnections = new Set<WebSocket>()
let sessionEndDebounce: ReturnType<typeof setTimeout> | null = null
let sessionKeepalive: ReturnType<typeof setInterval> | null = null
const SESSION_END_GRACE_MS = 1500
const SESSION_KEEPALIVE_MS = 10_000

function emitSessionActive(): void {
  publish('remote:session-active', { active: true, peerLabel: lastPeerLabel, lastActionTs: Date.now() })
}
function trackWsOpen(ws: WebSocket, peer: string): void {
  liveWsConnections.add(ws)
  lastPeerLabel = peer
  if (sessionEndDebounce) { clearTimeout(sessionEndDebounce); sessionEndDebounce = null }
  emitSessionActive()
  if (!sessionKeepalive) sessionKeepalive = setInterval(() => { if (liveWsConnections.size > 0) emitSessionActive() }, SESSION_KEEPALIVE_MS)
}
function trackWsClose(ws: WebSocket): void {
  liveWsConnections.delete(ws)
  if (liveWsConnections.size > 0) return
  if (sessionKeepalive) { clearInterval(sessionKeepalive); sessionKeepalive = null }
  // During an in-process restart (prepareForRestart closed these sockets) the restart resets the
  // indicator itself — don't schedule a stray "session ended" publish into the rebuilt windows.
  if (getIsRestarting()) return
  if (sessionEndDebounce) clearTimeout(sessionEndDebounce)
  sessionEndDebounce = setTimeout(() => {
    sessionEndDebounce = null
    if (liveWsConnections.size > 0) return
    publish('remote:session-active', { active: false, peerLabel: '', lastActionTs: Date.now() })
  }, SESSION_END_GRACE_MS)
}

function handleLan(req: http.IncomingMessage, res: http.ServerResponse): void {
  const ip = req.socket.remoteAddress ?? 'unknown'
  if (req.method === 'OPTIONS') { res.statusCode = 403; res.end(); return }
  if (!rateOk(ip)) { sendJson(res, { error: 'rate limited' }, 429); return }
  if (!lanAuthorized(req)) { sendJson(res, { error: 'unauthorized' }, 401); return }

  const pathname = (req.url ?? '/').split('?')[0]
  const via: Via = isLoopback(ip) ? 'ai' : 'remote'

  // Token-gated minimal health (peer probe): identity + version, so a controller can detect an
  // incompatible peer (a legacy v1 app has no app/protocol). Deliberately NOT signalActivity.
  if (req.method === 'GET' && pathname === '/control/health') {
    sendJson(res, { ok: true, hostname: hostname(), version: getAppVersion(), app: APP_ID, protocol: REMOTE_PROTOCOL })
    return
  }

  // /op — generic dispatch, reach-gated. On the LAN listener a remote peer (via:'remote')
  // reaches ONLY ops tagged reach:'remote' — the 7 control ops AND the debug ops — so the
  // UI's Remote connections list can debug/control a peer (logs/terminals/restart/…) over
  // the same gated channel. Bridge ops stay reach:['ui','ai'] → a peer can't transitively
  // drive a THIRD peer through us. Named /control/* routes stay too (V1 wire compatibility).
  if (pathname === '/op') { handleOp(req, res, via, () => signalActivity(ip)); return }

  const op = pathname.startsWith('/control/') ? pathname.slice('/control/'.length) : ''
  if (!Object.prototype.hasOwnProperty.call(CONTROL_OPS, op)) { sendJson(res, { error: 'unknown op' }, 404); return }
  if (req.method !== 'POST') { sendJson(res, { error: 'method not allowed' }, 405); return }
  readJsonBody(req, res, async (body) => {
    signalActivity(ip)
    const result = await dispatch(`control:${op}`, [body], ctxFor(req, via))
    if (result.ok) sendJson(res, result.data)
    else sendJson(res, { error: result.error }, statusFromCode(result.code))
  })
}

// ── WebSocket: live tab stream + keystroke injection (LAN only) ───────────────
const aliveSockets = new WeakSet<WebSocket>()
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

function wsSend(ws: WebSocket, msg: WsServerMsg): void {
  try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)) } catch { /* socket gone */ }
}

function onUpgrade(req: http.IncomingMessage, socket: import('node:net').Socket, head: Buffer): void {
  if (!lanAuthorized(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return }
  wss?.handleUpgrade(req, socket, head, (ws) => { wss?.emit('connection', ws, req) })
}

function onWsConnection(ws: WebSocket, req: http.IncomingMessage): void {
  const ip = req.socket.remoteAddress ?? 'unknown'
  const machine = remoteMachine(req) ?? ip
  let unsub: (() => void) | null = null
  let currentId: string | null = null
  let msgTimes: number[] = []
  let subscribeTimer: ReturnType<typeof setTimeout> | null = null // the subscribe-retry backoff timer
  aliveSockets.add(ws)
  trackWsOpen(ws, ip)
  ws.on('pong', () => aliveSockets.add(ws))

  ws.on('message', (raw) => {
    const now = Date.now()
    msgTimes = msgTimes.filter((t) => now - t < 1000)
    msgTimes.push(now)
    if (msgTimes.length > WS_MSG_PER_SEC) return // drop floods

    let msg: WsClientMsg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.type === 'subscribe') {
      const tid = msg.terminalId
      if (typeof tid !== 'string') { wsSend(ws, { type: 'error', message: 'bad terminal id' }); return }
      if (subscribeTimer) { clearTimeout(subscribeTimer); subscribeTimer = null } // cancel a prior subscribe's pending retry
      let attempts = 0
      const doSubscribe = (): void => {
        if (ws.readyState !== ws.OPEN) return
        if (!hasBufferedTerminal(tid)) {
          if (attempts++ >= 12) { wsSend(ws, { type: 'error', message: 'unknown terminal' }); return }
          subscribeTimer = setTimeout(doSubscribe, 400)
          return
        }
        if (unsub) unsub()
        currentId = tid
        const snap = getTerminalSnapshot(tid)
        if (snap) wsSend(ws, { type: 'snapshot', data: snap.data, cols: snap.cols, rows: snap.rows, alive: snap.alive, seq: snap.seq })
        unsub = subscribeTerminal(tid, (ev) => wsSend(ws, ev))
        signalActivity(ip)
        recordRemoteActivity({ ts: Date.now(), side: 'controlled', via: 'human', machine, action: 'view-start', target: tid, message: `started viewing ${tid}` })
      }
      doSubscribe()
    } else if (msg.type === 'keys') {
      if (!currentId || typeof msg.data !== 'string') return
      if (!hasBufferedTerminal(currentId)) { wsSend(ws, { type: 'exit' }); return }
      writeToPty(currentId, msg.data.slice(0, MAX_KEYS_BYTES))
      signalActivity(ip)
    }
  })

  const teardown = (): void => {
    if (subscribeTimer) { clearTimeout(subscribeTimer); subscribeTimer = null }
    if (unsub) { unsub(); unsub = null }
    if (currentId) {
      recordRemoteActivity({ ts: Date.now(), side: 'controlled', via: 'human', machine, action: 'view-stop', target: currentId, message: `stopped viewing ${currentId}` })
      currentId = null
    }
    trackWsClose(ws)
  }
  ws.on('close', teardown)
  ws.on('error', teardown)
}

// ── lifecycle ────────────────────────────────────────────────────────────────

function startLocalServer(): void {
  if (localServer) return
  const port = localPort()
  localAllowedHostSet = new Set([`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1', 'localhost'])
  localServer = http.createServer(handleLocal)
  localServer.on('error', (err: NodeJS.ErrnoException) => { logError('op-server', `local ${err.code}: ${err.message}`) })
  localServer.listen(port, '127.0.0.1', () => { logInfo('op-server', `local http://127.0.0.1:${port}`) })
}

/** (Re)start or stop the LAN listener to match config (called at startup + after save-config). */
// Reconciles are serialized through this chain so a rapid enable→disable→enable (or a
// port change) can't run two reconciles concurrently and double-bind. Each waits for the
// previous to finish; reconcileOpServer stays sync (fire-and-forget) for its callers.
let reconcileChain: Promise<void> = Promise.resolve()
export function reconcileOpServer(): void {
  reconcileChain = reconcileChain
    .then(() => doReconcile())
    .catch((e) => { logError('op-server', `reconcile failed: ${e instanceof Error ? e.message : String(e)}`) })
}

async function doReconcile(): Promise<void> {
  const cfg = getRemoteControl()
  const shouldRun = cfg.enabled && cfg.token.length >= MIN_TOKEN_LEN
  if (!shouldRun) { await stopLanServer(); return }
  if (lanServer && boundPort === cfg.listenPort) return // already running on the right port

  // Wait for the previous listener to fully release the port — `server.close()` is async,
  // so re-`listen()`ing synchronously after it can transiently EADDRINUSE on a fast toggle.
  await stopLanServer()
  computeAllowedHosts(cfg.listenPort)
  lanServer = http.createServer(handleLan)
  wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD })
  wss.on('connection', onWsConnection)
  lanServer.on('upgrade', onUpgrade)
  heartbeatTimer = setInterval(() => {
    if (!wss) return
    for (const client of wss.clients) {
      if (!aliveSockets.has(client)) { try { client.terminate() } catch { /* ignore */ } continue }
      aliveSockets.delete(client)
      try { client.ping() } catch { /* ignore */ }
    }
  }, WS_HEARTBEAT_MS)
  lanServer.on('error', (err: NodeJS.ErrnoException) => { logError('op-server', `lan ${err.code}: ${err.message}`); boundPort = 0 })
  // Bind 0.0.0.0 (LAN). Defense = key + Host-allowlist + LAN-scoped firewall rule.
  lanServer.listen(cfg.listenPort, '0.0.0.0', () => {
    boundPort = cfg.listenPort
    logInfo('op-server', `lan listening on 0.0.0.0:${cfg.listenPort}`)
  })
}

function stopLanServer(): Promise<void> {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  if (sessionKeepalive) { clearInterval(sessionKeepalive); sessionKeepalive = null }
  if (sessionEndDebounce) { clearTimeout(sessionEndDebounce); sessionEndDebounce = null }
  liveWsConnections.clear()
  if (wss) {
    for (const c of wss.clients) { try { c.terminate() } catch { /* ignore */ } }
    try { wss.close() } catch { /* ignore */ }
    wss = null
  }
  const srv = lanServer
  lanServer = null
  boundPort = 0
  return new Promise<void>((resolve) => {
    if (!srv) { resolve(); return }
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    try { srv.close(finish) } catch { finish() }
    // Don't hang a reconcile if a keep-alive socket lingers past close().
    setTimeout(finish, 1500)
  })
}

/** Start the always-on local listener (dev tooling + local AI/CLI). The conditional LAN
 *  listener is started separately via `reconcileOpServer()` AFTER windows exist, so the
 *  tab-tree cache + PTY ring buffer are populated before a peer can connect — matching
 *  V1's "control-server last" ordering. */
/** Runtime bind state of the LAN listener (vs the persisted config). `bound` is true only when
 *  the listener is actually live on the configured port — false while disabled OR after an
 *  EADDRINUSE error reset `boundPort` to 0, so the UI can stop claiming "listening". */
export function getBindState(): { enabled: boolean; bound: boolean; port: number } {
  const cfg = getRemoteControl()
  return { enabled: cfg.enabled, bound: boundPort !== 0 && boundPort === cfg.listenPort, port: cfg.listenPort }
}

export function startOpServer(): void {
  startLocalServer()
}

export function stopOpServer(): void {
  void stopLanServer()
  if (localServer) { try { localServer.close() } catch { /* ignore */ } localServer = null }
}

/** Called before an in-process window/PTY restart (debug:restart/reload, possibly remote-triggered):
 *  the windows + PTYs the LAN WS viewers are streaming are about to be destroyed. Cleanly close the
 *  sockets (each viewer gets a close → "stream ended", then can reconnect to the rebuilt tabs) and
 *  reset the session indicator so it doesn't stick on or fire into destroyed/unmounted windows. The
 *  LAN listener itself stays bound (peers reconnect). */
export function prepareForRestart(): void {
  if (wss) for (const c of wss.clients) { try { c.close() } catch { /* ignore */ } }
  liveWsConnections.clear()
  if (sessionKeepalive) { clearInterval(sessionKeepalive); sessionKeepalive = null }
  if (sessionEndDebounce) { clearTimeout(sessionEndDebounce); sessionEndDebounce = null }
}
