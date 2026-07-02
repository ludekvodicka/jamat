/**
 * The 5 MVP scenario strategies on the 4-phase abstraction, plus the registry.
 * Each strategy implements only the phases it needs; the orchestrator runs them.
 * Adding a 6th scenario = add a strategy here + an entry in `scenarios-meta.ts`.
 */

import { controlPost, putTask, getAnswer, sleep, type PeerRef } from './http.js'
import { buildTerminalTask, buildTerminalTaskRef, buildIssueTask, buildNotify, parseTerminalAnswer } from './markers.js'
import type { Scenario, ScenarioCtx } from './types.js'
import type { ScenarioId } from './scenarios-meta.js'
import type { TabStatus } from '../types/remote-control.js'
// Shared TUI normalizer (collapse ANSI + whitespace, lowercase) — single source in the
// Claude patterns module, reused by the renderer's turn-indicator too.
import { normalizeTty as normTui } from '../agents/claude/patterns.js'

const enter = '\r'

// Shapes of the control-server responses we consume (controlPost returns `any`;
// these give the downstream access points real types).
interface ScrollbackResp { data?: string; cols?: number; rows?: number; alive?: boolean; seq?: number; truncated?: boolean; status?: TabStatus }

async function currentSeq(peer: PeerRef, terminalId: string): Promise<number> {
  const snap = await controlPost(peer, 'scrollback', { terminalId }) as ScrollbackResp
  return typeof snap.seq === 'number' ? snap.seq : 0
}

/**
 * Type `text` then submit with a SEPARATE Enter keystroke. Claude Code treats a
 * large keystroke burst as a PASTE and absorbs a trailing CR into the input buffer
 * instead of submitting — so the prompt just sits there. The Enter must therefore be
 * its own keystroke, sent after the paste has settled. (Verified live: a one-shot
 * `text + \r` left the prompt unsubmitted; a standalone `\r` afterwards submitted it.)
 */
async function injectSubmit(ctx: ScenarioCtx, text: string): Promise<void> {
  await controlPost(ctx.peer, 'write-keys', { terminalId: ctx.terminalId, data: text }, { corrId: ctx.corrId })
  await sleep(600) // let the REPL register the paste before the submit Enter
  await controlPost(ctx.peer, 'write-keys', { terminalId: ctx.terminalId, data: enter }, { corrId: ctx.corrId })
}

async function injectAndMarkSeq(ctx: ScenarioCtx, text: string): Promise<void> {
  ctx.seqAtTrigger = await currentSeq(ctx.peer, ctx.terminalId)
  await injectSubmit(ctx, text)
}

/**
 * Inject + submit, then VERIFY the prompt actually landed — a freshly-booted scratch
 * REPL can swallow keystrokes for a second or two even when it looks idle, dropping the
 * task (seen in the first delegate runs: trust confirmed, prompt empty, nothing ran).
 * After submitting we poll the scrollback for the corrId (the injected prompt echoes
 * `[JAMAT TASK <corrId>]`); if it never appears, re-inject. Bounded. The injected
 * text MUST contain `ctx.corrId` (true for the terminal-task/ref + issue-handoff prompts).
 */
async function readScreen(ctx: ScenarioCtx): Promise<string> {
  try { const r = await controlPost(ctx.peer, 'scrollback', { terminalId: ctx.terminalId, sinceSeq: 0 }) as ScrollbackResp; return r.data ?? '' }
  catch { return '' }
}

/** Output appended since `seqAtTrigger` (the cursor captured just before the first paste).
 *  Non-empty ⇒ the paste produced SOMETHING — even a collapsed "[Pasted text]" block that
 *  hides the corrId — so it landed and must NOT be pasted again (that doubles the prompt). */
async function deltaSince(ctx: ScenarioCtx): Promise<string> {
  try { const r = await controlPost(ctx.peer, 'scrollback', { terminalId: ctx.terminalId, sinceSeq: ctx.seqAtTrigger ?? 0 }) as ScrollbackResp; return r.data ?? '' }
  catch { return '' }
}

/** Clear the REPL input line (Ctrl+U) — wipes a stray partial before a re-delivery. */
async function clearInput(ctx: ScenarioCtx): Promise<void> {
  await controlPost(ctx.peer, 'write-keys', { terminalId: ctx.terminalId, data: '\x15' }, { corrId: ctx.corrId })
}

/**
 * Deliver `text` to the peer REPL in SMALL PACED CHUNKS rather than one burst. ROOT-CAUSE fix for
 * the head-swallow: `writeToPty` hands the whole burst to the peer's conpty input pipe in ONE
 * `process.write`, and a line-editor that isn't fully drained drops the LEADING bytes — seen live
 * on a slow peer, the first ~150 chars of the prompt vanished and only the marker-instruction TAIL
 * was submitted, so the remote answered "I don't see a question". Feeding the input paced keeps
 * conpty from overflowing so the whole prompt lands. `text` MUST be single-line (the terminal-task
 * prompts are) — a chunk boundary never carries a CR, so nothing submits early. */
async function pasteChunked(ctx: ScenarioCtx, text: string): Promise<void> {
  const CHUNK = 48
  for (let i = 0; i < text.length; i += CHUNK) {
    await controlPost(ctx.peer, 'write-keys', { terminalId: ctx.terminalId, data: text.slice(i, i + CHUNK) }, { corrId: ctx.corrId })
    await sleep(35) // let conpty drain each slice before the next
  }
}

/**
 * Deliver a prompt, CONFIRM the whole thing landed, then make it SUBMIT. Failure modes seen live:
 *  (1) a slow/loaded conpty REPL drops the LEADING bytes of a one-shot burst write — the model then
 *      receives only the marker-instruction tail and replies "I don't see a question" (TRANSPORT-
 *      AGNOSTIC: bites the in-proc `self` path AND a loaded remote peer); and
 *  (2) Claude Code treats a fast burst as a PASTE and absorbs a too-soon Enter into the buffer
 *      instead of submitting.
 * Defenses, in order: PRIME the line-editor (a throwaway char + clear absorbs the wake-up swallow),
 * deliver the text PACED in small chunks (so conpty never overflows and drops the head), VERIFY the
 * prompt HEAD is visible before submitting, and — crucially — if the head never confirms after
 * retries, DO NOT submit a partial: clear the line and THROW, so the caller retries the whole
 * delivery instead of the remote answering garbage. Phase 2 then presses Enter (its own keystroke)
 * until the turn truly starts.
 */
async function injectVerified(ctx: ScenarioCtx, text: string): Promise<void> {
  // Prime: the FIRST bytes a freshly-loaded REPL receives can be swallowed, so spend a throwaway
  // char on that risk, then clear — the real prompt's HEAD is never the sacrificial byte.
  await controlPost(ctx.peer, 'write-keys', { terminalId: ctx.terminalId, data: ' ' }, { corrId: ctx.corrId })
  await sleep(250)
  await clearInput(ctx)
  await sleep(150)

  ctx.seqAtTrigger = await currentSeq(ctx.peer, ctx.terminalId)
  // Phase 1 — DELIVER (paced) until the prompt HEAD is confirmed visible. The HEAD specifically:
  // a head-swallow leaves only the tail, whose normalized form ALSO contains the corrId (it sits
  // in the trailing `[[[JAMAT-ANSWER:<corrId>]]]` marker), so a plain corrId check would
  // pass on a partial. (Claude may instead collapse the whole input into a "[Pasted text]" block —
  // hides the head but proves the full text landed — accept that too.) On a partial / nothing,
  // clear the line and re-deliver; the REPL is now awake so the head lands. Bounded.
  const headNorm = normTui(text).slice(0, 24)
  let landed = false
  for (let attempt = 0; attempt < 4 && !landed; attempt++) {
    await pasteChunked(ctx, text)
    await sleep(500) // let the REPL settle the rendered input before reading it back
    const dn = normTui(await deltaSince(ctx))
    if (dn.includes('[pastedtext') || (headNorm.length > 0 && dn.includes(headNorm))) { landed = true; break }
    await clearInput(ctx)
    await sleep(300)
  }
  if (!landed) {
    // The head never confirmed — submitting now would ship a truncated, head-swallowed prompt
    // (→ "I don't see a question"). Clear any partial and FAIL CLEANLY so the caller retries.
    await clearInput(ctx)
    throw new Error('prompt head not confirmed on peer after 4 paced attempts (input swallowed) — refusing to submit a partial prompt')
  }
  // Phase 2 — SUBMIT. The text is in the input; press Enter as its OWN keystroke (Claude Code
  // absorbs a too-soon Enter into a paste buffer instead of submitting) until the turn truly
  // starts (its "esc to interrupt" busy hint, or an answer marker). Enter-ONLY — never re-deliver
  // here, so an absorbed Enter just costs another Enter, never a doubled prompt.
  for (let enterTry = 0; enterTry < 8; enterTry++) {
    await controlPost(ctx.peer, 'write-keys', { terminalId: ctx.terminalId, data: enter }, { corrId: ctx.corrId })
    await sleep(800)
    const data = await readScreen(ctx)
    if (normTui(data).includes('esctointerrupt') || parseTerminalAnswer(data, ctx.corrId) !== null) return // SUBMITTED
  }
}

/** ~10 s of no new output + no busy hint = the remote is idle at a prompt. */
const QUIET_POLLS = 8

/**
 * Poll the answer-delta for the END marker. Returns `answered` when the marker
 * appears, `blocked` when the tab reports a blocked turn, `idle` when the turn settles at
 * an idle prompt — either FINISHED (tab `status` idle/done once the turn has started) or
 * quiet awaiting the human (e.g. a secret) — else `timeout`. A finished turn whose answer
 * markers were mangled by the TUI thus returns `idle` + the tail instead of hanging. The latest
 * scrollback tail is left in `ctx.answer` for EVERY non-answered outcome, so the
 * controller can relay what's on the remote screen. Exported so the standalone
 * `await` verb (resume after the human acts) can reuse it without re-injecting.
 */
export async function awaitMarkedAnswer(ctx: ScenarioCtx): Promise<{ outcome: 'answered' | 'blocked' | 'idle' | 'timeout' }> {
  const start = Date.now()
  let lastLen = -1
  let quiet = 0
  let turnStarted = false
  while (Date.now() - start < ctx.maxWaitMs) {
    // One poll = two PARALLEL reads (was three serial round-trips):
    //  • the FILE answer channel — robust, wins over scrollback markers the terminal
    //    can mangle, and
    //  • the scrollback delta, which now ALSO carries the tab `status` (folded in by
    //    the control-server), so we no longer pull the whole `windows` tree just to
    //    read one tab's status.
    // A transport blip (incl. a reused keep-alive socket reset) fails the WHOLE poll
    // harmlessly — we sleep and try again, never aborting the await.
    let fileAns: string | null = null
    let d: ScrollbackResp = {}
    try {
      const [fa, sb] = await Promise.all([
        getAnswer(ctx.peer, ctx.corrId).catch(() => null),
        controlPost(ctx.peer, 'scrollback', { terminalId: ctx.terminalId, sinceSeq: ctx.seqAtTrigger ?? 0 }) as Promise<ScrollbackResp>,
      ])
      fileAns = fa; d = sb
    } catch { await sleep(ctx.pollMs); continue }
    // Channel 1 (file) wins.
    if (fileAns !== null) { ctx.answer = fileAns; ctx.truncated = false; return { outcome: 'answered' } }
    // Channel 2 (scrollback markers).
    const data = d.data ?? ''
    ctx.answer = data; ctx.truncated = !!d.truncated // keep the latest tail for any non-answered outcome
    const ans = parseTerminalAnswer(data, ctx.corrId)
    if (ans !== null) { ctx.answer = ans; return { outcome: 'answered' } }
    // Status (folded onto the scrollback response by plan 002) is the RELIABLE turn-done
    // signal: Claude's constant TUI redraw defeats the length-stable heuristic below AND
    // can overdraw the answer markers into garbage, so a finished turn would otherwise hang
    // to timeout. `blocked` short-circuits to its own outcome.
    // `waiting` (a question menu) is "needs the human to answer" too — same outcome as blocked.
    if (d.status === 'blocked' || d.status === 'waiting') return { outcome: 'blocked' }
    // Normalize first: claude's TUI renders with cursor escapes that eat the spaces
    // ("esctointerrupt"), so match the collapsed form.
    const busy = normTui(data).includes('esctointerrupt')
    // Mark the turn underway once it's working — so a freshly-injected REPL (still idle,
    // hasn't started) doesn't make us return immediately.
    if (busy || d.status === 'running' || d.status === 'tool-use') turnStarted = true
    // Turn started and now idle/done → FINISHED. Return the tail (a clean file/marker answer
    // would already have returned above this same poll); the caller reads the tail.
    // The `!busy` guard is load-bearing: the peer defaults a live tab's status to `idle`
    // when the renderer hasn't yet emitted `running` (it only emits on CHANGE), so a turn
    // that JUST started reports `idle` for a poll or two while "esc to interrupt" is already
    // on screen. Without `!busy`, that stale/defaulted idle beats the busy hint and the await
    // returns prematurely mid-turn. "esc to interrupt" present ⇒ still working, full stop.
    if (turnStarted && !busy && (d.status === 'idle' || d.status === 'done')) { ctx.answer = data; return { outcome: 'idle' } }
    // Fallback for tabs that don't report status (non-Claude / agents): quiet at a prompt
    // with no busy hint → idle. Defeated by Claude's redraw, hence the status path is primary.
    if (!busy && data.length === lastLen) { if (++quiet >= QUIET_POLLS) return { outcome: 'idle' } }
    else quiet = 0
    lastLen = data.length
    await sleep(ctx.pollMs)
  }
  return { outcome: 'timeout' }
}

// ── S2: terminal task ──
// A task that is large (> ~2 KB) OR multi-line is delivered as a FILE dropped on the
// peer (put-task) + a short single-line pointer inject — this dodges BOTH the 4 KB
// write-keys truncation AND the multi-line paste hazard (a multi-line keystroke inject
// lands in the REPL input buffer and the trailing Enter never submits it). Only a
// short, single-line task is injected inline (and even that prompt is single-line).
const TASK_INLINE_MAX = 2000
const terminalTask: Scenario = {
  id: 'terminal-task',
  async trigger(ctx) {
    if (ctx.task.length > TASK_INLINE_MAX || ctx.task.includes('\n')) {
      const filePath = await putTask(ctx.peer, ctx.corrId, ctx.task)
      await injectVerified(ctx, buildTerminalTaskRef(filePath, ctx.corrId))
    } else {
      await injectVerified(ctx, buildTerminalTask(ctx.task, ctx.corrId))
    }
  },
  async awaitTurn(ctx) { return awaitMarkedAnswer(ctx) },
  async read(ctx) { return ctx.answer ?? '' },
}

// ── S1: issue-handoff (bridge does only the trigger; the local AI's issue-tracker
// skill created the issue and will poll the answer comment). ──
const issueHandoff: Scenario = {
  id: 'issue-handoff',
  async trigger(ctx) {
    if (!ctx.repo || !ctx.issue) throw new Error('issue-handoff needs repo + issue (create the issue first via your issue-tracker skill)')
    await injectAndMarkSeq(ctx, buildIssueTask(ctx.repo, ctx.issue, ctx.corrId))
  },
}

// ── S3: consult / peek (read-only) ──
const consult: Scenario = {
  id: 'consult',
  async read(ctx) {
    const snap = await controlPost(ctx.peer, 'scrollback', { terminalId: ctx.terminalId }, { corrId: ctx.corrId }) as ScrollbackResp
    return snap.data ?? ''
  },
}

// ── S4: notify (fire-and-forget) ──
const notify: Scenario = {
  id: 'notify',
  async trigger(ctx) {
    await injectSubmit(ctx, buildNotify(ctx.task, ctx.corrId))
  },
}

// ── S5: unblock (answer a blocked prompt, then read what follows) ──
const unblock: Scenario = {
  id: 'unblock',
  async trigger(ctx) {
    // ctx.task is the answer to the blocked question (e.g. "yes", "1", "y", or "" = just Enter).
    ctx.seqAtTrigger = await currentSeq(ctx.peer, ctx.terminalId)
    await injectSubmit(ctx, ctx.task)
  },
  async awaitTurn(ctx) {
    const start = Date.now()
    // One scrollback read now yields BOTH the delta AND the tab `status` (folded in by
    // the control-server), so the unblock poll no longer needs a separate `windows` call.
    const poll = async (): Promise<ScrollbackResp> => {
      const d = await controlPost(ctx.peer, 'scrollback', { terminalId: ctx.terminalId, sinceSeq: ctx.seqAtTrigger ?? 0 }) as ScrollbackResp
      ctx.truncated = !!d.truncated
      return d
    }
    while (Date.now() - start < ctx.maxWaitMs) {
      const d = await poll()
      // The follow-up turn is done once the tab is idle/done. We do NOT require
      // having first observed `blocked` — a trivial unblock (e.g. "yes") can race
      // past it, which previously hung to timeout despite succeeding.
      if (d.status === 'idle' || d.status === 'done') {
        ctx.answer = d.data ?? ''
        return { outcome: 'answered' }
      }
      await sleep(ctx.pollMs)
    }
    ctx.answer = (await poll()).data ?? '' // timed out mid-turn — return whatever arrived
    return { outcome: 'timeout' }
  },
  async read(ctx) { return ctx.answer ?? '' },
}

const REGISTRY: Record<ScenarioId, Scenario> = {
  'issue-handoff': issueHandoff,
  'terminal-task': terminalTask,
  consult,
  notify,
  unblock,
}

export function getScenario(id: ScenarioId): Scenario | undefined {
  return REGISTRY[id]
}

export function scenarioIds(): ScenarioId[] {
  return Object.keys(REGISTRY) as ScenarioId[]
}
