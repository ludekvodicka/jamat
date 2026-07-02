/**
 * Smoke for the peer reachability + wake-escalation gate (core/jamat/reachability.ts).
 *
 * Closes the 017 coverage gap: the CLI parser + agent-gate are covered by
 * smoke-jamat-cli.ts + smoke-agent-gate.ts, but the wake escalation
 * — specifically "never wakes without allowWake" and the offline→wake ORDER —
 * had no automated guard. That gate is the one with real-world side effects
 * (it physically wakes/launches a machine), so a regression must be caught.
 *
 * No server is spun up: `self` short-circuits to app-up, and a peer pointed at a
 * closed localhost port resolves to `offline` via fast ECONNREFUSED (no 3s wait).
 *
 * Run: node --import tsx scripts/smoke-reachability.ts
 */

import { probe, wake, ensureAppUp } from '../core/jamat/reachability.js'
import type { PeerRef } from '../core/jamat/http.js'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}`) }
}

// A peer pointed at closed localhost ports → every probe HTTP attempt is refused
// immediately (ECONNREFUSED), so probe() resolves to 'offline' without waiting out
// the 3s per-attempt timeout. No mac/wolProxyUrl → wake() will throw if reached.
const deadPeer: PeerRef = { name: 'dead', host: '127.0.0.1', controlPort: 59998, agentPort: 59999, token: 'x' }
const selfPeer: PeerRef = { name: 'self', host: '', controlPort: 0, agentPort: 0, token: '', self: true }

async function main(): Promise<void> {
  console.log('\n[1] probe — self short-circuits, dead peer is offline')
  ok('probe(self) === app-up (local instance, no HTTP)', (await probe(selfPeer)) === 'app-up')
  ok('probe(deadPeer) === offline (nothing listening)', (await probe(deadPeer)) === 'offline')

  console.log('\n[2] ensureAppUp NEVER wakes/launches without allowWake')
  let threw = false
  try { await ensureAppUp(deadPeer, {}) } catch (e) { threw = true; ok('throws and the error names allowWake', /allowWake/.test(String(e))) }
  ok('ensureAppUp(offline, {}) rejects (no autonomous wake)', threw)

  console.log('\n[3] with allowWake, escalation STARTS at Wake-on-LAN (offline → wake), before any launch')
  const steps: string[] = []
  let wakeErr = ''
  try {
    await ensureAppUp(deadPeer, { allowWake: true, onStep: (s) => steps.push(s) })
  } catch (e) { wakeErr = String(e) }
  ok('first step is the Wake-on-LAN escalation', steps[0]?.includes('Wake-on-LAN') === true)
  ok('it never advanced to the launch-app step (wake came first and failed)',
    !steps.some((s) => s.includes('launching')))
  ok('the failure is the missing WoL coordinates (wake was actually attempted)',
    /mac|wolProxyUrl|WoL/i.test(wakeErr))

  console.log('\n[4] wake() requires WoL coordinates')
  let wakeThrew = false
  try { await wake(deadPeer) } catch { wakeThrew = true }
  ok('wake(peer without mac/wolProxyUrl) throws', wakeThrew)

  console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
