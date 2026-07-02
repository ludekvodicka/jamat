/**
 * Runs one scenario end-to-end: reachability pre-flight → Deliver → Trigger →
 * Await → Read. Scenario-agnostic — it only knows the 4-phase shape, so a new
 * scenario needs no orchestrator change.
 */

import { ensureAppUp } from './reachability.js'
import { getScenario, awaitMarkedAnswer } from './scenarios.js'
import { makeCorrId } from './markers.js'
import { controlPost, sleep, type PeerRef } from './http.js'
import type { ScenarioId } from './scenarios-meta.js'
import type { ScenarioCtx, ScenarioOutcome, ScenarioResult, BridgeLogEntry } from './types.js'
import type { RemoteWindowInfo, TabStatus } from '../types/remote-control.js'
import { normalizeTty } from '../agents/claude/patterns.js'

export interface RunOpts {
  /** Explicit user gate for waking/launching an offline/closed peer. */
  allowWake?: boolean
  /** Await budget for terminal scenarios (default 120s). */
  maxWaitMs?: number
  /** Poll cadence while awaiting (default 1.2s). */
  pollMs?: number
  /** Progress callback (wake steps, etc.). */
  onStep?: (step: string) => void
  /** Structured log sink — the gateway forwards these to the Jamat Log tab. */
  onLog?: (entry: BridgeLogEntry) => void
  /** S1 only: the issue-tracker repo + issue the local AI already created. */
  repo?: string
  issue?: number
  /** Reuse a correlation id (e.g. a retried call); else generated. */
  corrId?: string
  /** Skip the reachability preflight — the caller already ensured the peer is app-up
   *  (e.g. `runDelegate`, which probes before opening the scratch tab). Avoids a
   *  duplicate `/control/health` round-trip. */
  assumeUp?: boolean
}

export async function runScenario(
  scenarioId: ScenarioId,
  peer: PeerRef,
  terminalId: string,
  task: string,
  opts: RunOpts = {},
): Promise<ScenarioResult> {
  const scenario = getScenario(scenarioId)
  const corrId = opts.corrId ?? makeCorrId()
  const peerLabel = peer.name ?? peer.host
  const log = (phase: BridgeLogEntry['phase'], message: string): void =>
    opts.onLog?.({ ts: Date.now(), corrId, scenario: scenarioId, peer: peerLabel, terminalId, phase, message })
  if (!scenario) {
    log('result', `unknown scenario: ${scenarioId}`)
    return { ok: false, scenario: scenarioId, outcome: 'error', corrId, error: `unknown scenario: ${scenarioId}` }
  }
  const ctx: ScenarioCtx = {
    peer, terminalId, task, corrId,
    repo: opts.repo, issue: opts.issue,
    maxWaitMs: opts.maxWaitMs ?? 120_000,
    pollMs: opts.pollMs ?? 1_200,
    log,
  }
  try {
    log('info', `${scenarioId} → ${peerLabel} (${terminalId})`)
    // Pre-flight: every scenario needs the peer app-up (PTYs live there). Wakes
    // ONLY when explicitly allowed; otherwise throws for an offline/closed peer.
    // Skipped when the caller already ensured it (`assumeUp`) — e.g. runDelegate,
    // which probes before opening the scratch tab (no duplicate health round-trip).
    if (!opts.assumeUp) {
      log('preflight', opts.allowWake ? 'ensuring peer is up (wake allowed)' : 'checking peer is app-up')
      await ensureAppUp(peer, { allowWake: opts.allowWake, onStep: (s) => { opts.onStep?.(s); log('preflight', s) } })
    }

    if (scenario.deliver) { log('deliver', 'delivering task'); await scenario.deliver(ctx) }
    if (scenario.trigger) { log('trigger', task ? `injecting: ${task.slice(0, 120)}` : 'injecting'); await scenario.trigger(ctx) }

    let outcome: ScenarioOutcome = scenario.trigger ? 'sent' : 'peeked'
    if (scenario.awaitTurn) { log('await', 'awaiting the remote turn'); outcome = (await scenario.awaitTurn(ctx)).outcome }

    let data: string | undefined
    if (scenario.read) { data = await scenario.read(ctx); log('read', `read ${data.length} chars`) }

    const ok = outcome !== 'error' && outcome !== 'timeout'
    log('result', `outcome=${outcome}${ctx.truncated ? ' (truncated)' : ''}`)
    return { ok, scenario: scenarioId, outcome, corrId, data, truncated: ctx.truncated }
  } catch (e: any) {
    log('result', `error: ${String(e?.message ?? e)}`)
    return { ok: false, scenario: scenarioId, outcome: 'error', corrId, error: String(e?.message ?? e) }
  }
}

export interface AwaitResult {
  ok: boolean
  outcome: ScenarioOutcome
  corrId: string
  /** UNTRUSTED remote output: the answer if found, else the current screen tail. */
  data?: string
  truncated?: boolean
  error?: string
}

/**
 * Re-await a remote turn WITHOUT injecting anything — for resuming an in-flight
 * delegation after the human acted on the peer (e.g. pasted a secret the remote
 * asked for). Reuses the ORIGINAL corrId so the answer marker still matches, and
 * scans the whole ring (`seqAtTrigger = 0`) so an answer already printed isn't missed.
 */
export async function awaitRemoteTurn(
  peer: PeerRef,
  terminalId: string,
  corrId: string,
  opts: { maxWaitMs?: number; pollMs?: number; onLog?: (e: BridgeLogEntry) => void } = {},
): Promise<AwaitResult> {
  const peerLabel = peer.name ?? peer.host
  const log = (phase: BridgeLogEntry['phase'], message: string): void =>
    opts.onLog?.({ ts: Date.now(), corrId, peer: peerLabel, terminalId, phase, message })
  const ctx: ScenarioCtx = {
    peer, terminalId, task: '', corrId,
    maxWaitMs: opts.maxWaitMs ?? 120_000, pollMs: opts.pollMs ?? 1_200,
    seqAtTrigger: 0, log,
  }
  try {
    log('info', `await → ${peerLabel} (${terminalId})`)
    await ensureAppUp(peer, { allowWake: false })
    log('await', 'awaiting the remote turn (resume, no re-inject)')
    const { outcome } = await awaitMarkedAnswer(ctx)
    const data = ctx.answer ?? ''
    log('read', `read ${data.length} chars`)
    log('result', `outcome=${outcome}${ctx.truncated ? ' (truncated)' : ''}`)
    return { ok: outcome !== 'timeout', outcome, corrId, data, truncated: ctx.truncated }
  } catch (e: any) {
    log('result', `error: ${String(e?.message ?? e)}`)
    return { ok: false, outcome: 'error', corrId, error: String(e?.message ?? e) }
  }
}

/** Get a freshly-opened scratch Claude to a usable prompt: auto-confirm Claude Code's
 * "Do you trust this folder?" gate (own machine + an explicitly-authorized delegation),
 * then wait until the REPL prompt is up. Polls the whole ring (`sinceSeq:0`, not logged).
 * Bounded — if neither the trust gate nor a prompt appears in budget, it returns anyway
 * and the caller's inject/await will surface whatever state the tab is in. */
async function readyScratchSession(peer: PeerRef, terminalId: string, log: (p: BridgeLogEntry['phase'], m: string) => void): Promise<void> {
  let trusted = false
  let lastLen = -1
  let stable = 0
  for (let i = 0; i < 70; i++) {
    let data = ''
    try { const r = await controlPost(peer, 'scrollback', { terminalId, sinceSeq: 0 }); data = String(r?.data ?? '') }
    catch { /* tab/PTY not ready yet */ }
    // Match against a NORMALIZED view: claude renders TUI text with cursor-positioning
    // escapes, so the raw scrollback has the spaces eaten ("Yes,Itrustthisfolder", not
    // "Yes, I trust this folder"). Strip ANSI + whitespace so the trust gate is detected
    // the instant it's in the buffer (was the cause of the slow auto-confirm).
    const norm = normalizeTty(data)
    if (!trusted && norm.includes('trustthisfolder')) {
      log('preflight', 'auto-confirming the trust-folder gate')
      await controlPost(peer, 'write-keys', { terminalId, data: '\r' }, { corrId: 'trust' })
      trusted = true; lastLen = -1; stable = 0
      await sleep(600) // let it advance past the gate
      continue
    }
    // Inject only once the REPL is truly IDLE at its prompt: the input bar is up, it's
    // not showing the busy hint, AND output has stopped growing for a couple polls.
    const ready = norm.includes('foragents')
    const busy = norm.includes('esctointerrupt')
    if (ready && !busy && data.length === lastLen) {
      if (++stable >= 4) {
        // The "for agents" bar + an empty input render BEFORE the fresh REPL reliably accepts
        // keystrokes — MCP servers / session init are still settling. Pasting the instant the
        // prompt looks idle swallows the HEAD of the task (seen live: the model received only
        // the marker-instruction tail, not the task, and replied "I don't see a question").
        // Settle generously (a loaded/slow peer needs more), then return so the full paste lands.
        // 4 stable polls (~1.6s) + this settle ≈ the margin a busy peer needs to be input-ready.
        log('preflight', 'scratch prompt idle — settling before delivery')
        await sleep(3500)
        return
      }
    }
    else stable = 0
    lastLen = data.length
    await sleep(400) // poll fast so the trust gate is confirmed promptly
  }
  log('preflight', 'scratch session not confirmed idle at a prompt (timed out) — proceeding')
}

export interface DelegateResult {
  ok: boolean
  outcome: ScenarioOutcome
  corrId: string
  /** The scratch tab opened for this delegation (so the caller can peek/await/close it). */
  terminalId: string
  data?: string
  truncated?: boolean
  error?: string
}

/**
 * One-shot delegation: open a scratch Claude on the peer, auto-confirm trust, wait for
 * its prompt, deliver the task (file-drop + single-line ref + separate-Enter submit via
 * the terminal-task scenario), and adaptive-await the answer (file channel or scrollback
 * markers). Returns the answer + the new terminalId. Collapses the former manual
 * open→trust→send→submit→await dance into a single gateway call.
 */
export async function runDelegate(
  peer: PeerRef,
  task: string,
  opts: { maxWaitMs?: number; pollMs?: number; onLog?: (e: BridgeLogEntry) => void } = {},
): Promise<DelegateResult> {
  const corrId = makeCorrId()
  const terminalId = `ai-claude-${Date.now()}`
  const peerLabel = peer.name ?? peer.host
  const log = (phase: BridgeLogEntry['phase'], message: string): void =>
    opts.onLog?.({ ts: Date.now(), corrId, peer: peerLabel, terminalId, phase, message })
  try {
    log('info', `delegate → ${peerLabel} (scratch ${terminalId})`)
    await ensureAppUp(peer, { allowWake: false })
    log('preflight', 'opening scratch Claude session')
    // Name the tab by the task (first line, truncated) so a human on the peer sees WHAT the
    // AI is doing in this auto-opened tab instead of the generic "scratch".
    const label = task.split('\n')[0].trim().slice(0, 50)
    // Activate the scratch tab on the peer (AI default now): the inactive/hidden path hit render edge
    // cases, so the delegate takes the reliable visible-launch path.
    await controlPost(peer, 'open-tab', { tabType: 'claude', scratch: true, terminalId, label, activate: true }, { corrId })
    await readyScratchSession(peer, terminalId, log)
    // Deliver + adaptive-await through the terminal-task scenario (reuses the fixed
    // file-drop, single-line inject, separate-Enter submit, and file/marker await).
    // assumeUp: we already ensured the peer is app-up above — skip the inner preflight.
    const r = await runScenario('terminal-task', peer, terminalId, task, { ...opts, corrId, assumeUp: true })
    return { ok: r.ok, outcome: r.outcome, corrId, terminalId, data: r.data, truncated: r.truncated, error: r.error }
  } catch (e: any) {
    log('result', `error: ${String(e?.message ?? e)}`)
    return { ok: false, outcome: 'error', corrId, terminalId, error: String(e?.message ?? e) }
  }
}

export interface SessionCandidate {
  peer: string
  host: string
  windowId: number
  windowTitle: string
  terminalId: string
  title: string
  type: string
  streamable: boolean
  /** Higher = better match (tab/window name weighted over PC match). */
  score: number
  /** Live Claude turn-status from the `windows` op for streamable terminals
   *  (idle/running/tool-use/blocked/done), `unknown` when the tab reports none;
   *  `panel` for non-terminals. */
  state: TabStatus | 'unknown' | 'panel'
  /** The session's launch cwd (terminal tabs only) — feed to `open --same-as
   *  <terminalId>` to start a new session in the same dir. */
  cwd?: string
  /** The peer's app version (from the `windows` response) — identical for every
   *  candidate on a peer; lets the caller confirm which build the peer is running. */
  version?: string
}

/** Case-insensitive match score: empty needle is neutral (0.5, doesn't filter);
 * exact=1, prefix=0.8, substring=0.6, no match=0 (excluded when a mask is given). */
export function sessionMatchScore(haystack: string, needle: string): number {
  if (!needle) return 0.5
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  if (h === n) return 1
  if (h.startsWith(n)) return 0.8
  if (h.includes(n)) return 0.6
  return 0
}

/**
 * Discover sessions across peers matching a PC-name mask + a name mask (tab title OR
 * window title), ranked by match score, each annotated with its live Claude turn-status.
 * Controller-side only — ONE `windows` op per peer carries the tabs AND their mirrored
 * status, so there are no extra round-trips and no scrollback-tail heuristic. Offline /
 * unreachable peers are skipped (returned in `skipped`), never blocking the result.
 */
export async function findSessions(
  peers: PeerRef[],
  pcMask: string,
  tabMask: string,
  opts: { onLog?: (e: BridgeLogEntry) => void } = {},
): Promise<{ candidates: SessionCandidate[]; skipped: string[] }> {
  const log = (phase: BridgeLogEntry['phase'], message: string): void =>
    opts.onLog?.({ ts: Date.now(), corrId: 'find', peer: '(local)', phase, message })
  log('info', `find pc~"${pcMask}" tab~"${tabMask}"`)
  const skipped: string[] = []
  // Probe all peers CONCURRENTLY (they're independent) → find latency ≈ the slowest
  // peer, not the sum. No `ensureAppUp` health pre-probe: if a peer isn't app-up the
  // `windows` call just fails (connection refused / 4 s timeout) → caught → skipped,
  // the same observable result with one fewer round-trip per peer.
  const perPeer = await Promise.all(peers.map(async (peer): Promise<SessionCandidate[]> => {
    const label = peer.name ?? peer.host
    const pcScore = sessionMatchScore(label, pcMask)
    if (pcScore === 0) return [] // PC mask given + no match → don't even hit the peer
    let windows: RemoteWindowInfo[]
    let version: string | undefined
    try {
      const r = await controlPost(peer, 'windows', {}, { timeoutMs: 4000 })
      windows = (r?.windows ?? []) as RemoteWindowInfo[]
      version = r?.version as string | undefined
    } catch { skipped.push(label); return [] }
    const out: SessionCandidate[] = []
    for (const w of windows) for (const t of w.tabs) {
      // The mask matches the tab title (now carries the session name, e.g.
      // "myproject - hello") OR the window title ("Backend — …"), best wins —
      // so a session is findable by what it's called or by which window holds it.
      const nameScore = Math.max(sessionMatchScore(t.title, tabMask), sessionMatchScore(w.title, tabMask))
      if (nameScore === 0) continue // mask given + matches neither tab nor window
      out.push({
        peer: label, host: peer.host, windowId: w.windowId, windowTitle: w.title,
        terminalId: t.terminalId, title: t.title, type: t.type, streamable: t.streamable,
        cwd: t.cwd, version,
        score: Number((nameScore + pcScore * 0.1).toFixed(3)),
        // State comes straight from the `windows` op's mirrored Claude turn-status —
        // reliable and free. `blocked`/`waiting` = needs input (don't send blind),
        // `running`/`tool-use` = busy, `idle`/`done` = ready. A tab that reported no
        // status (fresh, or a non-Claude cmd/powershell tab) → `unknown`.
        state: t.streamable ? (t.status ?? 'unknown') : 'panel',
      })
    }
    return out
  }))
  const candidates = perPeer.flat()
  candidates.sort((a, b) => b.score - a.score)
  log('result', `${candidates.length} candidate(s)${skipped.length ? `, skipped ${skipped.join(', ')}` : ''}`)
  return { candidates, skipped }
}
