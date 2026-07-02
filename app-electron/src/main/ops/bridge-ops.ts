/**
 * Bridge ops — the AI-to-Jamat (controller side), as registry ops (plan 002 P2).
 *
 * These were the named verbs in `ai-gateway.ts`'s `handleJamat`. They now live in
 * the op registry with `reach: ['ui','ai']` — the local AI (CLI, `via:'ai'`) and the
 * renderer reach them; a remote peer (`via:'remote'`) is reach-denied (the gateway was
 * always localhost-only). The op-server's `/jamat/*` adapter gates the request with
 * the machine key, passes the JSON body as the single arg, and sends `result.data`
 * verbatim (each op returns the EXACT body V1's gateway sent).
 *
 * The verbs map to the scoped control ops a human also has (read, write-keys,
 * open/close-tab, put/get-task) — driven through the orchestrator with an `onLog` sink
 * that streams to the Remote Activity Log. The AI never touches peer credentials: the
 * gateway holds the peer tokens and drives peers with their stored `token`.
 */

import { registerOp } from '../../../../core/op/registry.js'
import type { Result, Via } from '../../../../core/op/types.js'
import { getRemoteControl, getSelfName } from '../remote-control-store'
import { parseInstanceId } from '../../../../core/instance-id.js'
import { recordRemoteActivity } from '../remote-activity'
import { logInfo } from '../logger'
import { runScenario, awaitRemoteTurn, runDelegate, findSessions } from '../../../../core/jamat/orchestrator.js'
import { ensureAppUp } from '../../../../core/jamat/reachability.js'
import { controlPost, type PeerRef } from '../../../../core/jamat/http.js'
import { JAMAT_SCENARIOS, type ScenarioId } from '../../../../core/jamat/scenarios-meta.js'
import { AI_KEY_OPS } from '../../../../core/types/remote-control.js'
import type { BridgeLogEntry } from '../../../../core/jamat/types.js'

/** Hard ceiling for a scenario's await budget (10 min — a single delegate spans a real
 *  multi-minute remote task). The CLI sets its socket timeout from the budget (+buffer). */
const MAX_WAIT_CEILING_MS = 600_000
const RO = ['ui', 'ai'] as const

function peerRef(name: string): PeerRef | null {
  const p = getRemoteControl().peers.find((x) => x.name === name || x.host === name || x.id === name)
  if (!p) return null
  return { name: p.name, host: p.host, controlPort: p.controlPort, agentPort: p.agentPort, token: p.token, mac: p.mac, wolProxyUrl: p.wolProxyUrl }
}

function emitLog(entry: BridgeLogEntry): void {
  recordRemoteActivity({
    ts: entry.ts, side: 'controller', via: 'ai', machine: entry.peer,
    phase: entry.phase, target: entry.terminalId, scenario: entry.scenario,
    corrId: entry.corrId, message: entry.message,
  })
  logInfo('jamat', `[${entry.phase}] ${entry.peer} ${entry.message}`)
}

/** Resolve the peer from a body label, or return the V1 404 Result. The reserved label
 *  `self` targets THIS instance in-proc (self-control) — the self peer carries the
 *  ORIGINATING `via` so the in-proc control dispatch never escalates. */
function resolvePeer(label: string, via: Via): { peer: PeerRef; pname: string } | Result {
  if (label === 'self') {
    return { peer: { name: 'self', host: 'self', controlPort: 0, agentPort: 0, token: '', self: true, selfVia: via }, pname: 'self' }
  }
  const peer = peerRef(label)
  if (!peer) return { ok: false, error: `unknown peer "${label}". GET /jamat/peers (or use "self" for THIS machine)`, code: 'not_found' }
  return { peer, pname: peer.name ?? peer.host }
}

export function registerBridgeOps(): void {
  registerOp({
    name: 'bridge:help',
    meta: { summary: 'Gateway capabilities (scenarios + allowed ops)', reach: [...RO], rw: 'ro', audit: 'never' },
    handler: (): Result => {
      emitLog({ ts: Date.now(), corrId: 'gw', peer: '(local)', phase: 'info', message: 'AI is fetching gateway capabilities' })
      return { ok: true, data: { ok: true, service: 'jamat-gateway', scenarios: JAMAT_SCENARIOS, allowedOps: AI_KEY_OPS } }
    },
  })

  registerOp({
    name: 'bridge:peers',
    meta: { summary: 'List configured peers', reach: [...RO], rw: 'ro', audit: 'never' },
    handler: (): Result => {
      emitLog({ ts: Date.now(), corrId: 'gw', peer: '(local)', phase: 'info', message: 'AI is listing remote connections' })
      return {
        ok: true,
        data: {
          ok: true,
          peers: getRemoteControl().peers.map((p) => ({
            name: p.name, host: p.host, controlPort: p.controlPort, agentPort: p.agentPort,
            wakeable: !!(p.mac && p.wolProxyUrl),
          })),
        },
      }
    },
  })

  registerOp({
    name: 'bridge:find',
    meta: { summary: 'Discover sessions across all peers (pcMask, tabMask)', reach: [...RO], rw: 'ro', audit: 'never' },
    handler: async (args, ctx): Promise<Result> => {
      const body = (args[0] ?? {}) as any
      const peers = getRemoteControl().peers.map((p) => ({
        name: p.name, host: p.host, controlPort: p.controlPort, agentPort: p.agentPort, token: p.token, mac: p.mac, wolProxyUrl: p.wolProxyUrl,
      }))
      const result = await findSessions(peers, String(body.pcMask ?? ''), String(body.tabMask ?? ''), { onLog: emitLog })
      return { ok: true, data: { ok: true, ...result } }
    },
  })

  registerOp({
    name: 'bridge:wake',
    meta: { summary: 'Wake a peer (explicit)', reach: [...RO], rw: 'rw', audit: 'never' },
    handler: async (args, ctx): Promise<Result> => {
      const body = (args[0] ?? {}) as any
      const r = resolvePeer(String(body.peer ?? ''), ctx.via)
      if ('ok' in r) return r
      const { peer, pname } = r
      emitLog({ ts: Date.now(), corrId: 'wake', peer: pname, phase: 'info', message: 'wake requested (explicit)' })
      const tier = await ensureAppUp(peer, { allowWake: true, onStep: (s) => emitLog({ ts: Date.now(), corrId: 'wake', peer: pname, phase: 'preflight', message: s }) })
      emitLog({ ts: Date.now(), corrId: 'wake', peer: pname, phase: 'result', message: `reachability=${tier}` })
      return { ok: true, data: { ok: true, peer: peer.name, reachability: tier } }
    },
  })

  registerOp({
    name: 'bridge:tabs',
    meta: { summary: 'List a peer\'s windows/tabs', reach: [...RO], rw: 'ro', audit: 'never' },
    handler: async (args, ctx): Promise<Result> => {
      const body = (args[0] ?? {}) as any
      const r = resolvePeer(String(body.peer ?? ''), ctx.via)
      if ('ok' in r) return r
      const { peer, pname } = r
      emitLog({ ts: Date.now(), corrId: 'tabs', peer: pname, phase: 'info', message: 'listing windows/tabs' })
      await ensureAppUp(peer, { allowWake: false })
      const res = await controlPost(peer, 'windows', {})
      return { ok: true, data: { ok: true, peer: peer.name, windows: res.windows, version: res.version } }
    },
  })

  registerOp({
    name: 'bridge:open',
    meta: { summary: 'Open a tab on a peer', reach: [...RO], rw: 'rw', audit: 'never' },
    handler: async (args, ctx): Promise<Result> => {
      const body = (args[0] ?? {}) as any
      const r = resolvePeer(String(body.peer ?? ''), ctx.via)
      if ('ok' in r) return r
      const { peer, pname } = r
      const tabType = (body.tabType === 'cmd' || body.tabType === 'powershell') ? body.tabType : 'claude'
      const terminalId = (typeof body.terminalId === 'string' && /^[A-Za-z0-9_:-]{1,128}$/.test(body.terminalId))
        ? body.terminalId : `ai-${tabType}-${Date.now()}`
      const corrId = `open-${Date.now()}`
      emitLog({ ts: Date.now(), corrId, peer: pname, terminalId, phase: 'info', message: `opening ${tabType} tab` })
      await ensureAppUp(peer, { allowWake: false })
      await controlPost(peer, 'open-tab', {
        tabType, terminalId,
        scratch: body.scratch === true ? true : undefined,
        command: typeof body.command === 'string' ? body.command : undefined,
        category: typeof body.category === 'string' ? body.category : undefined,
        project: typeof body.project === 'string' ? body.project : undefined,
        sameAs: typeof body.sameAs === 'string' ? body.sameAs : undefined,
        windowId: Number.isInteger(body.windowId) ? body.windowId : undefined,
        // AI ACTIVATES the opened tab by default. The silent/inactive path (activate:false) drives the
        // eager-hidden-launch + hidden-render edge cases, which proved flaky — activating routes through
        // the well-tested visible-launch path. A caller can still opt into silent with activate:false.
        activate: body.activate === false ? false : true,
      }, { corrId })
      emitLog({ ts: Date.now(), corrId, peer: pname, terminalId, phase: 'result', message: `opened ${tabType} tab as ${terminalId}` })
      return { ok: true, data: { ok: true, peer: peer.name, terminalId, tabType } }
    },
  })

  registerOp({
    name: 'bridge:close',
    meta: { summary: 'Close a tab on a peer', reach: [...RO], rw: 'rw', audit: 'never' },
    handler: async (args, ctx): Promise<Result> => {
      const body = (args[0] ?? {}) as any
      const r = resolvePeer(String(body.peer ?? ''), ctx.via)
      if ('ok' in r) return r // peer resolution first (V1 order: unknown-peer 404 before arg-400)
      if (typeof body.terminalId !== 'string' || !body.terminalId) return { ok: false, error: 'terminalId required', code: 'bad_args' }
      const { peer, pname } = r
      const terminalId = String(body.terminalId)
      const corrId = `close-${Date.now()}`
      emitLog({ ts: Date.now(), corrId, peer: pname, terminalId, phase: 'info', message: `closing tab ${terminalId}` })
      await ensureAppUp(peer, { allowWake: false })
      await controlPost(peer, 'close-tab', { terminalId }, { corrId })
      emitLog({ ts: Date.now(), corrId, peer: pname, terminalId, phase: 'result', message: `closed tab ${terminalId}` })
      return { ok: true, data: { ok: true, peer: peer.name, terminalId } }
    },
  })

  registerOp({
    name: 'bridge:run',
    meta: { summary: 'Run a bridge scenario against a peer', reach: [...RO], rw: 'rw', audit: 'never' },
    handler: async (args, ctx): Promise<Result> => {
      const body = (args[0] ?? {}) as any
      const r = resolvePeer(String(body.peer ?? ''), ctx.via)
      if ('ok' in r) return r // peer resolution first (V1 order: unknown-peer 404 before arg-400)
      if (typeof body.scenario !== 'string') return { ok: false, error: 'scenario required', code: 'bad_args' }
      const scenario = body.scenario as ScenarioId
      if (!JAMAT_SCENARIOS.some((s) => s.id === scenario)) return { ok: false, error: `unknown scenario "${scenario}"`, code: 'bad_args' }
      if (!body.terminalId) return { ok: false, error: 'terminalId required', code: 'bad_args' }
      const { peer } = r
      const result = await runScenario(scenario, peer, String(body.terminalId), String(body.task ?? ''), {
        allowWake: false,
        repo: typeof body.repo === 'string' ? body.repo : undefined,
        issue: Number.isInteger(body.issue) ? body.issue : undefined,
        maxWaitMs: Number.isInteger(body.maxWaitMs) ? Math.min(body.maxWaitMs, MAX_WAIT_CEILING_MS) : undefined,
        onLog: emitLog,
      })
      return { ok: true, data: result } // result carries `ok`; HTTP stays 200 for a clean JSON error body
    },
  })

  registerOp({
    name: 'bridge:ask',
    meta: { summary: 'Ask a tab by its instance id (resolve → inject → await the marked answer)', reach: [...RO], rw: 'rw', audit: 'never' },
    handler: async (args, ctx): Promise<Result> => {
      const body = (args[0] ?? {}) as any
      const instanceId = String(body.instanceId ?? '')
      const parsed = parseInstanceId(instanceId)
      if (!parsed) return { ok: false, error: 'instanceId required, shaped `<machine>:<folder>-<rand>`', code: 'bad_args' }
      const task = String(body.task ?? '')
      const peekOnly = body.peekOnly === true
      if (!task.trim() && !peekOnly) return { ok: false, error: 'task required (the question to ask), or set peekOnly to just read its screen', code: 'bad_args' }
      // Route to the machine named in the id: our own selfName → in-proc self; else a configured peer.
      const self = getSelfName().toLowerCase()
      const label = (parsed.machine === self || parsed.machine === 'self' || parsed.machine === 'local') ? 'self' : parsed.machine
      const r = resolvePeer(label, ctx.via)
      if ('ok' in r) return r
      const { peer, pname } = r
      const corrId = `ask-${Date.now()}`
      emitLog({ ts: Date.now(), corrId, peer: pname, phase: 'info', message: `resolving instance ${instanceId}` })
      await ensureAppUp(peer, { allowWake: false })
      const res = await controlPost(peer, 'resolve-instance', { instanceId })
      if (!res?.found || !res.terminalId) {
        return { ok: true, data: { ok: false, found: false, instanceId,
          error: res?.wrongMachine
            ? `instance "${instanceId}" targets machine "${parsed.machine}" — no peer by that name here (check the <machine> prefix matches a configured peer)`
            : `instance "${instanceId}" not found on ${peer.name} — the tab is closed, or its id was never copied (mint it via right-click → Copy instance id)` } }
      }
      const terminalId = String(res.terminalId)
      const result = await runScenario(peekOnly ? 'consult' : 'terminal-task', peer, terminalId, task, {
        allowWake: false,
        maxWaitMs: Number.isInteger(body.maxWaitMs) ? Math.min(body.maxWaitMs, MAX_WAIT_CEILING_MS) : undefined,
        onLog: emitLog,
      })
      return { ok: true, data: { ...result, instanceId, terminalId, machine: parsed.machine } }
    },
  })

  registerOp({
    name: 'bridge:delegate',
    meta: { summary: 'One-shot delegate: open scratch Claude → deliver → await', reach: [...RO], rw: 'rw', audit: 'never' },
    handler: async (args, ctx): Promise<Result> => {
      const body = (args[0] ?? {}) as any
      if (typeof body.task !== 'string' || !body.task.trim()) return { ok: false, error: 'task required (pass a task or --file)', code: 'bad_args' }
      const r = resolvePeer(String(body.peer ?? ''), ctx.via)
      if ('ok' in r) return r
      const { peer } = r
      const result = await runDelegate(peer, body.task, {
        maxWaitMs: Number.isInteger(body.maxWaitMs) ? Math.min(body.maxWaitMs, MAX_WAIT_CEILING_MS) : MAX_WAIT_CEILING_MS,
        onLog: emitLog,
      })
      return { ok: true, data: result }
    },
  })

  registerOp({
    name: 'bridge:await',
    meta: { summary: 'Resume awaiting an in-flight delegation (corrId)', reach: [...RO], rw: 'rw', audit: 'never' },
    handler: async (args, ctx): Promise<Result> => {
      const body = (args[0] ?? {}) as any
      if (!body.terminalId) return { ok: false, error: 'terminalId required', code: 'bad_args' }
      if (typeof body.corrId !== 'string' || !/^[\w-]{1,128}$/.test(body.corrId)) {
        return { ok: false, error: 'corrId required (use the corrId from the original send result)', code: 'bad_args' }
      }
      const r = resolvePeer(String(body.peer ?? ''), ctx.via)
      if ('ok' in r) return r
      const { peer } = r
      const result = await awaitRemoteTurn(peer, String(body.terminalId), String(body.corrId), {
        maxWaitMs: Number.isInteger(body.maxWaitMs) ? Math.min(body.maxWaitMs, MAX_WAIT_CEILING_MS) : undefined,
        onLog: emitLog,
      })
      return { ok: true, data: result }
    },
  })
}
