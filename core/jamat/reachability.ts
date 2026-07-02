/**
 * Peer reachability + the explicit-command-gated wake escalation (pure, node:http
 * only). Tiers mirror the human-side probe: `offline` (machine asleep/off) →
 * `agent-only` (machine up, Claude App closed) → `app-up` (control-server reachable).
 *
 * `ensureAppUp` escalates offline → Wake-on-LAN → launch-app → app-up, but ONLY
 * when `allowWake` is set — waking/launching a physical machine is a real-world
 * side effect, never done autonomously. The CLI exposes it solely via an explicit
 * `wake` verb / `--wake` flag, and the skill teaches that it needs a user command.
 */

import { agentGet, controlGet, agentPost, httpJson, sleep, type PeerRef } from './http.js'

export type Reachability = 'offline' | 'agent-only' | 'app-up'

export async function probe(peer: PeerRef): Promise<Reachability> {
  if (peer.self) return 'app-up' // the LOCAL instance is always up — no HTTP probe / no wake
  try { if ((await controlGet(peer, '/control/health', 3000)).status === 200) return 'app-up' } catch { /* fall through */ }
  try { if ((await agentGet(peer, '/api/health', 3000)).status === 200) return 'agent-only' } catch { /* fall through */ }
  return 'offline'
}

/** Send a Wake-on-LAN magic packet via the peer's `app-wol` proxy. */
export async function wake(peer: PeerRef): Promise<void> {
  if (!peer.wolProxyUrl || !peer.mac) {
    throw new Error('wake needs peer.mac + peer.wolProxyUrl (configure them on the peer)')
  }
  const u = new URL(peer.wolProxyUrl)
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80)
  const r = await httpJson(u.hostname, port, 'POST', '/wol', { body: { mac: peer.mac }, timeoutMs: 5000 })
  if (r.status < 200 || r.status >= 300) throw new Error(`WoL proxy: HTTP ${r.status}`)
}

/** Ask the always-on agent to launch the Electron app (machine up, app closed). */
export async function launchApp(peer: PeerRef): Promise<void> {
  const r = await agentPost(peer, '/api/launch-app', {}, 5000)
  if (r.status < 200 || r.status >= 300) throw new Error(`launch-app: HTTP ${r.status}`)
}

export interface EnsureOpts {
  /** Required to wake/launch. Without it, a non-app-up peer throws (never autonomous). */
  allowWake?: boolean
  onStep?: (step: string) => void
  /** Total budget for the whole escalation (boot + launch). */
  timeoutMs?: number
}

/** Bring `peer` to `app-up`, escalating across the tiers. Throws if it can't. */
export async function ensureAppUp(peer: PeerRef, opts: EnsureOpts = {}): Promise<Reachability> {
  let r = await probe(peer)
  if (r === 'app-up') return r
  if (!opts.allowWake) {
    throw new Error(`peer is ${r}; pass allowWake (an explicit user command) to wake/launch it`)
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000)

  if (r === 'offline') {
    opts.onStep?.('offline → sending Wake-on-LAN')
    await wake(peer)
    while (Date.now() < deadline && r === 'offline') {
      await sleep(3000)
      r = await probe(peer)
    }
    if (r === 'offline') throw new Error('peer did not come online after Wake-on-LAN (still offline)')
  }

  if (r === 'agent-only') {
    opts.onStep?.('agent-only → launching the app')
    await launchApp(peer)
    // Give the launch its OWN headroom — a slow boot above may have eaten most of
    // `deadline`, and a cold Electron start can recompile (tens of seconds).
    const launchDeadline = Math.max(deadline, Date.now() + 45_000)
    while (Date.now() < launchDeadline && r !== 'app-up') {
      await sleep(2000)
      r = await probe(peer)
    }
    if (r !== 'app-up') throw new Error('peer woke and a launch was requested, but the app never came up')
  }

  if (r !== 'app-up') throw new Error(`peer did not reach app-up (last state: ${r})`)
  return r
}
