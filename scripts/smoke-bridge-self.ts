/**
 * Smoke: the Jamat SELF transport (plan 002 P4).
 *
 * `controlPost(selfPeer, …)` routes IN-PROC through `dispatch('control:<op>', …)` instead of
 * HTTP, under the self peer's ORIGINATING `via` — so self-control reuses the exact control ops
 * and never escalates. The real control ops need electron, so this registers in-memory fakes and
 * asserts the transport wiring: round-trip, via-threading, reach enforcement, and the app-up probe.
 *
 * Run: node --import tsx scripts/smoke-bridge-self.ts
 */

import { registerOp, _resetRegistryForTests } from '../core/op/registry.js'
import { controlPost, putTask, getAnswer, type PeerRef } from '../core/jamat/http.js'
import { probe } from '../core/jamat/reachability.js'

let passed = 0
let failed = 0
function ok(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}`) }
}

async function main(): Promise<void> {
  _resetRegistryForTests()

  // In-memory stand-ins for the real (electron-coupled) control ops.
  const store = new Map<string, string>()
  registerOp({
    name: 'control:put-task',
    meta: { reach: ['ui', 'ai', 'remote'], rw: 'rw' },
    handler: (args) => { const b = args[0] as any; store.set(b.corrId, b.text); return { ok: true, data: { ok: true, path: `mem://${b.corrId}` } } },
  })
  registerOp({
    name: 'control:get-answer',
    meta: { reach: ['ui', 'ai', 'remote'], rw: 'ro' },
    handler: (args) => { const b = args[0] as any; const t = store.get(b.corrId); return { ok: true, data: t !== undefined ? { ok: true, found: true, text: t } : { ok: true, found: false } } },
  })
  registerOp({
    name: 'control:echo-via',
    meta: { reach: ['ui', 'ai', 'remote'], rw: 'ro' },
    handler: (_args, ctx) => ({ ok: true, data: { ok: true, via: ctx.via } }),
  })
  registerOp({
    name: 'control:local-only',
    meta: { reach: ['ui', 'ai'], rw: 'ro' },
    handler: () => ({ ok: true, data: { ok: true } }),
  })

  const self: PeerRef = { name: 'self', host: 'self', controlPort: 0, agentPort: 0, token: '', self: true, selfVia: 'ai' }

  // 1. put-task / get-answer round-trip through the self transport (no HTTP).
  await putTask(self, 'c1', 'hello-self')
  ok('self put-task/get-answer round-trips', (await getAnswer(self, 'c1')) === 'hello-self')
  ok('self get-answer returns null when not written', (await getAnswer(self, 'nope')) === null)

  // 2. selfVia is threaded into the in-proc dispatch (no hardcoded escalation).
  ok('self honors selfVia=ai', (await controlPost(self, 'echo-via', {}))?.via === 'ai')
  ok('self honors selfVia=remote (stays remote, no escalation to ai)',
    (await controlPost({ ...self, selfVia: 'remote' }, 'echo-via', {}))?.via === 'remote')

  // 3. reach is enforced through the self transport: a remote-origin self call cannot reach a
  //    [ui,ai] op (the dispatch chokepoint denies it), while a via=ai self call can.
  let denied = false
  try { await controlPost({ ...self, selfVia: 'remote' }, 'local-only', {}) } catch { denied = true }
  ok('self via=remote is reach-denied on a [ui,ai] op', denied)
  ok('self via=ai reaches a [ui,ai] op', (await controlPost(self, 'local-only', {}))?.ok === true)

  // 4. the local instance is always app-up (no HTTP probe / no wake).
  ok('probe(self) is app-up', (await probe(self)) === 'app-up')

  console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed}) ===`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
