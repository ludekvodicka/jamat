/**
 * Smoke: the agent's `/api/*` gate predicate (which routes require the machine key). Guards the
 * 019-class "over/under-gate" risk — a deliberate change to which paths are open must update this.
 * Pure: imports only the side-effect-free `isGatedApiPath` (NOT the self-starting agent-server).
 *
 * Run: node --import tsx scripts/smoke-agent-gate.ts
 */

import { isGatedApiPath } from '../app-agent/api-gate.js'

let passed = 0
let failed = 0
function ok(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}`) }
}

// Open (keyless) — only the exact health probe.
ok('/api/health is NOT gated (keyless probe)', isGatedApiPath('/api/health') === false)

// Gated — every other /api/* (reads + mutations).
ok('/api/projects is gated', isGatedApiPath('/api/projects') === true)
ok('/api/sessions is gated', isGatedApiPath('/api/sessions') === true)
ok('/api/session-preview is gated', isGatedApiPath('/api/session-preview') === true)
ok('/api/launch is gated', isGatedApiPath('/api/launch') === true)
ok('/api/project/delete is gated', isGatedApiPath('/api/project/delete') === true)
ok('/api/launch-app is gated', isGatedApiPath('/api/launch-app') === true)

// Only the EXACT /api/health is open (no prefix/substring bypass).
ok('/api/healthz is gated (exact-match open route only)', isGatedApiPath('/api/healthz') === true)

// Non-/api paths are not an /api-gate concern (the caller handles /debug/* + static separately).
ok('/debug/health is not /api-gated', isGatedApiPath('/debug/health') === false)
ok('/ (root) is not /api-gated', isGatedApiPath('/') === false)

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed}) ===`)
process.exit(failed === 0 ? 0 : 1)
