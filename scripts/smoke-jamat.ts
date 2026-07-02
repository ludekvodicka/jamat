/**
 * Smoke for the Jamat pure logic (electron-free, fs-free): ring-delta math,
 * the marker convention + its echo-collision guard, and the scenario registry.
 *
 * Run: `npx tsx scripts/smoke-jamat.ts`
 */

import http from 'node:http'
import { computeRingDelta } from '../core/ring-delta'
import { JAMAT_SCENARIOS } from '../core/jamat/scenarios-meta'
import { makeCorrId, buildTerminalTask, buildTerminalTaskRef, parseTerminalAnswer } from '../core/jamat/markers'
import { getScenario, scenarioIds, awaitMarkedAnswer } from '../core/jamat/scenarios'
import { controlPost, putTask, getAnswer, type PeerRef } from '../core/jamat/http'
import { sessionMatchScore, findSessions } from '../core/jamat/orchestrator'
import type { ScenarioCtx } from '../core/jamat/types'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}`) }
}

// ── ring-delta: exact output since a cursor ──
{
  const ring = 'hello world' // 11 chars, all retained → seq === ring.length
  ok('delta since 0 = whole ring', computeRingDelta(ring, 11, 0).data === 'hello world')
  ok('delta since current seq = empty (no new output)', computeRingDelta(ring, 11, 11).data === '')
  ok('delta since mid cursor = the tail', computeRingDelta(ring, 11, 5).data === ' world')
  ok('delta within retained range is not truncated', computeRingDelta(ring, 11, 5).truncated === false)
  ok('cursor past seq clamps to empty (never negative slice)', computeRingDelta(ring, 11, 99).data === '')
}
{
  // ring holds only the last 5 of 11 total chars → oldest retained seq = 6
  const ring = 'world'
  ok('cursor older than the retained ring → whole ring + truncated', (() => {
    const r = computeRingDelta(ring, 11, 3)
    return r.data === 'world' && r.truncated === true
  })())
  ok('cursor exactly at oldest retained → clean tail, not truncated', (() => {
    const r = computeRingDelta(ring, 11, 6)
    return r.data === 'world' && r.truncated === false
  })())
}

// ── scenario catalog: the 5 MVP scenarios, unique ids ──
{
  const ids = JAMAT_SCENARIOS.map((s) => s.id).sort()
  ok('scenario catalog is exactly the 5 MVP scenarios',
    JSON.stringify(ids) === JSON.stringify(['consult', 'issue-handoff', 'notify', 'terminal-task', 'unblock']))
  ok('every scenario has a summary + 4 phases', JAMAT_SCENARIOS.every((s) =>
    !!s.summary && !!s.phases.deliver && !!s.phases.trigger && !!s.phases.await && !!s.phases.read))
}

// ── markers: the answer-bracketing convention + its false-positive guard ──
{
  const cid = 'abr-test01'
  const prompt = buildTerminalTask('do X', cid)
  ok('echoed prompt alone has NO end marker → parse returns null (no premature answer)',
    parseTerminalAnswer(prompt, cid) === null)
  const stream = prompt + '\n…claude works…\n[[[JAMAT-ANSWER:' + cid + ']]]\nThe answer is 42.\n[[[JAMAT-END:' + cid + ']]]\n'
  ok('parse extracts the answer between the real markers (last pair wins)',
    parseTerminalAnswer(stream, cid) === 'The answer is 42.')
  ok('parse is corrId-scoped (different id → null)', parseTerminalAnswer(stream, 'abr-other') === null)
  ok('makeCorrId yields distinct ids', makeCorrId() !== makeCorrId())
  // Regression (live-captured): Claude's TUI interleaves CSI escapes — colour, a cursor-forward
  // `\x1b[1C` where a space would be, absolute positioning `\x1b[19;3H`, line-clear `\x1b[K`.
  // The space-free colon marker + CSI-strip must still extract a CLEAN answer.
  const messy = '\x1b[m\x1b[1C[[[JAMAT-ANSWER:' + cid + ']]]\x1b[19;3HThe answer is 42.\r\n  [[[JAMAT-END:\x1b[1C' + cid + ']]]\x1b[K\r\n'
  ok('parse survives CSI escapes interleaved in/around the markers and cleans the answer',
    parseTerminalAnswer(messy, cid) === 'The answer is 42.')
  // Regression (live-captured): the remote mis-formatted the END marker as
  // `[[[JAMAT-ANSWER:id:END]]]` (appended :END) instead of `[[[JAMAT-END:id]]]`. The
  // tolerant close (END + id, either order) must still extract the answer (not time out).
  const altEnd = '[[[JAMAT-ANSWER:' + cid + ']]]\n42\n[[[JAMAT-ANSWER:' + cid + ':END]]]\n'
  ok('parse tolerates a mis-formatted [[[JAMAT-ANSWER:id:END]]] close', parseTerminalAnswer(altEnd, cid) === '42')
  // Regression (live-captured): the TUI renders inter-word spaces as cursor-forward (\x1b[1C),
  // so a multi-word answer must come back SPACED, not word-glued.
  const spaced = '[[[JAMAT-ANSWER:' + cid + ']]]\nThe\x1b[1Ccapital\x1b[1Cis\x1b[1CParis.\n[[[JAMAT-END:' + cid + ']]]\n'
  ok('parse restores cursor-forward spacing in a multi-word answer', parseTerminalAnswer(spaced, cid) === 'The capital is Paris.')
}

// ── scenario registry resolves all 5 strategies ──
{
  const ids = scenarioIds().sort()
  ok('registry has exactly the 5 scenarios',
    JSON.stringify(ids) === JSON.stringify(['consult', 'issue-handoff', 'notify', 'terminal-task', 'unblock']))
  ok('every catalog id resolves to a strategy', JAMAT_SCENARIOS.every((s) => !!getScenario(s.id)))
}

// ── find: session match scoring (exact > prefix > substring; empty = neutral) ──
{
  ok('sessionMatchScore: empty needle is neutral (0.5)', sessionMatchScore('HOST-A', '') === 0.5)
  ok('sessionMatchScore: exact = 1', sessionMatchScore('HOST-A', 'host-a') === 1)
  ok('sessionMatchScore: prefix = 0.8', sessionMatchScore('HOST-A', 'host') === 0.8)
  ok('sessionMatchScore: substring = 0.6', sessionMatchScore('Figma-mcp - Claude', 'mcp') === 0.6)
  ok('sessionMatchScore: no match = 0', sessionMatchScore('HOST-A', 'xyz') === 0)
}

// ── file-drop delivery: buildTerminalTaskRef points at the file but keeps markers ──
{
  const ref = buildTerminalTaskRef('/scratch/.jamat-tasks/abr-z.md', 'abr-z')
  ok('buildTerminalTaskRef references the task file, offers the answer file, AND keeps the markers',
    ref.includes('/scratch/.jamat-tasks/abr-z.md')
    && ref.includes('/scratch/.jamat-tasks/abr-z.answer.md')
    && ref.includes('[[[JAMAT-ANSWER:abr-z]]]'))
}

// ── controlPost ALWAYS marks X-Jamat (regression: AI reads that omitted an
//    explicit corrId were mis-tagged [human]) + putTask round-trips ──
await (async () => {
  const seen: Record<string, string | undefined> = {}
  let putBody: any = null
  const server = http.createServer((req, res) => {
    const op = (req.url ?? '').replace('/control/', '')
    seen[op] = req.headers['x-jamat'] as string | undefined
    let buf = ''
    req.on('data', (c) => { buf += c })
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Connection', 'close') // don't let the keep-alive agent hold the socket open past server.close()
      if (op === 'put-task') {
        try { putBody = JSON.parse(buf) } catch { /* leave null */ }
        res.end(JSON.stringify({ ok: true, path: `/scratch/.jamat-tasks/${putBody?.corrId ?? 'x'}.md` }))
        return
      }
      if (op === 'get-answer') { res.end(JSON.stringify({ ok: true, found: true, text: 'FILE ANSWER' })); return }
      res.end(JSON.stringify({ ok: true, seq: 0 }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const peer: PeerRef = { name: 'T', host: '127.0.0.1', controlPort: port, agentPort: port, token: 'x'.repeat(48) }
  await controlPost(peer, 'scrollback', { terminalId: 't' })          // no corrId → must STILL mark AI
  await controlPost(peer, 'windows', {}, { corrId: 'abr-xyz1' })       // explicit corrId → forwarded
  const droppedPath = await putTask(peer, 'abr-put1', 'BIG TASK TEXT') // file-drop helper
  const fileAnswer = await getAnswer(peer, 'abr-ga1')                  // file answer channel
  await new Promise<void>((r) => server.close(() => r()))
  ok('controlPost marks X-Jamat even without an explicit corrId (AI read never tagged [human])', seen['scrollback'] === 'gw')
  ok('controlPost forwards an explicit corrId as the X-Jamat marker', seen['windows'] === 'abr-xyz1')
  ok('putTask marks AI, sends the text, and returns the server path',
    seen['put-task'] === 'abr-put1' && putBody?.text === 'BIG TASK TEXT' && droppedPath === '/scratch/.jamat-tasks/abr-put1.md')
  ok('getAnswer reads the remote answer-file channel', fileAnswer === 'FILE ANSWER')
})()

// ── await derives status FROM the scrollback response (no `windows` call) + a failed
//    poll (transport blip / keep-alive reset) does NOT abort the await ──
await (async () => {
  let windowsHits = 0
  let scrollbackCalls = 0
  const server = http.createServer((req, res) => {
    const op = (req.url ?? '').replace('/control/', '')
    let buf = ''
    req.on('data', (c) => { buf += c })
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Connection', 'close')
      if (op === 'windows') { windowsHits++; res.end(JSON.stringify({ ok: true, windows: [] })); return }
      if (op === 'get-answer') { res.end(JSON.stringify({ ok: true, found: false })); return }
      if (op === 'scrollback') {
        scrollbackCalls++
        // First poll fails (simulated transient / reused-socket reset) → the await must
        // keep going; the second carries the blocked status.
        if (scrollbackCalls === 1) { res.statusCode = 500; res.end(JSON.stringify({ error: 'boom' })); return }
        res.end(JSON.stringify({ ok: true, data: '', seq: 0, status: 'blocked' }))
        return
      }
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const peer: PeerRef = { name: 'A', host: '127.0.0.1', controlPort: port, agentPort: port, token: 'x'.repeat(48) }
  const ctx: ScenarioCtx = { peer, terminalId: 't1', task: '', corrId: 'abr-await1', maxWaitMs: 3000, pollMs: 20, seqAtTrigger: 0, log: () => {} }
  const { outcome } = await awaitMarkedAnswer(ctx)
  await new Promise<void>((r) => server.close(() => r()))
  ok('await derives `blocked` from the scrollback status — never calls `windows`', outcome === 'blocked' && windowsHits === 0)
  ok('await survives a failed poll (500) and continues to the next one', scrollbackCalls >= 2)
})()

// ── findSessions probes peers in PARALLEL, with NO `/control/health` pre-probe, and
//    skips a down peer (regression for the dropped redundant probe) ──
await (async () => {
  let healthHits = 0
  const server = http.createServer((req, res) => {
    const url = req.url ?? ''
    if (req.method === 'GET' && url === '/control/health') { healthHits++; res.setHeader('Connection', 'close'); res.end(JSON.stringify({ ok: true, hostname: 'UP' })); return }
    let buf = ''
    req.on('data', (c) => { buf += c })
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Connection', 'close')
      if (url.endsWith('/control/windows')) {
        res.end(JSON.stringify({ ok: true, windows: [
          { windowId: 1, title: 'Win', tabs: [{ terminalId: 'term-1', title: 'myproject - hello', type: 'terminal', streamable: true, status: 'idle' }] },
        ] }))
        return
      }
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const upPort = (server.address() as { port: number }).port
  // A guaranteed-closed port for the DOWN peer: open one, grab its number, close it.
  const tmp = http.createServer()
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', () => r()))
  const downPort = (tmp.address() as { port: number }).port
  await new Promise<void>((r) => tmp.close(() => r()))
  const peers: PeerRef[] = [
    { name: 'UP', host: '127.0.0.1', controlPort: upPort, agentPort: upPort, token: 'x'.repeat(48) },
    { name: 'DOWN', host: '127.0.0.1', controlPort: downPort, agentPort: downPort, token: 'x'.repeat(48) },
  ]
  const { candidates, skipped } = await findSessions(peers, '', 'hello', {})
  await new Promise<void>((r) => server.close(() => r()))
  ok('findSessions returns the matching tab from the up peer', candidates.length === 1 && candidates[0]?.terminalId === 'term-1')
  ok('findSessions carries the tab status through as `state`', candidates[0]?.state === 'idle')
  ok('findSessions skips the down peer (no health pre-probe needed)', skipped.includes('DOWN'))
  ok('findSessions makes NO /control/health GET (dropped the redundant probe)', healthHits === 0)
})()

// ── await terminates on status idle/done once the turn has started (plan 005 / todo 019):
//    a finished turn whose markers got TUI-mangled returns idle+tail instead of timing out ──
async function runAwait(scrollbackFor: (n: number) => Record<string, unknown>, opts: { maxWaitMs?: number; pollMs?: number } = {}): Promise<{ outcome: string; answer: string; ms: number }> {
  let n = 0
  const server = http.createServer((req, res) => {
    const op = (req.url ?? '').replace('/control/', '')
    let buf = ''
    req.on('data', (c) => { buf += c })
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Connection', 'close')
      if (op === 'get-answer') { res.end(JSON.stringify({ ok: true, found: false })); return }
      if (op === 'scrollback') { n++; res.end(JSON.stringify({ ok: true, seq: 0, ...scrollbackFor(n) })); return }
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const peer: PeerRef = { name: 'AW', host: '127.0.0.1', controlPort: port, agentPort: port, token: 'x'.repeat(48) }
  const ctx: ScenarioCtx = { peer, terminalId: 't', task: '', corrId: 'abr-aw', maxWaitMs: opts.maxWaitMs ?? 3000, pollMs: opts.pollMs ?? 30, seqAtTrigger: 0, log: () => {} }
  const t0 = Date.now()
  const { outcome } = await awaitMarkedAnswer(ctx)
  const ms = Date.now() - t0
  await new Promise<void>((r) => server.close(() => r()))
  return { outcome, answer: ctx.answer ?? '', ms }
}
{
  // started (running) → idle, no parseable marker → returns idle with the tail, promptly
  const a = await runAwait((n) => n === 1 ? { status: 'running', data: 'working' } : { status: 'idle', data: 'working DONE-no-marker' })
  ok('await returns idle+tail when a started turn goes idle (mangled/absent marker)', a.outcome === 'idle' && a.answer.includes('DONE-no-marker'))
  ok('await returns promptly on idle (does not wait out maxWait)', a.ms < 1500)
  // idle from the FIRST poll (turn never started) → must NOT early-return → times out (gate)
  const b = await runAwait(() => ({ status: 'idle', data: 'prompt' }), { maxWaitMs: 300, pollMs: 50 })
  ok('await does NOT treat idle-from-start as done (turn-started gate)', b.outcome === 'timeout')
  // a clean marker on the idle poll wins over the idle-tail
  const tail = 'x\n[[[JAMAT-ANSWER:abr-aw]]]\nCLEAN\n[[[JAMAT-END:abr-aw]]]\n'
  const c = await runAwait((n) => n === 1 ? { status: 'running', data: 'working' } : { status: 'idle', data: tail })
  ok('await prefers a clean marker answer over the idle-tail', c.outcome === 'answered' && c.answer === 'CLEAN')
  // busy hint beats a stale/defaulted idle: a started turn still showing "esc to interrupt"
  // must NOT return idle even though status says idle (the peer defaults a live tab to idle
  // until the renderer emits `running`). Here status is idle from poll 1 but the busy hint is
  // always present → never returns idle → times out (no premature mid-turn return).
  const d = await runAwait(() => ({ status: 'idle', data: 'working… esc to interrupt' }), { maxWaitMs: 300, pollMs: 50 })
  ok('await does NOT return idle while the busy hint is present despite status:idle', d.outcome === 'timeout')
}

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed})`)
process.exit(failed === 0 ? 0 : 1)
