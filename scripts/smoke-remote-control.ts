/**
 * Smoke for Remote App Control's pure invariants (electron-free, fs-free).
 * Guards the security-relevant pieces: the closed-by-default op allowlist, the
 * port separation from the debug API, and the token-strength normalization
 * (a weak/missing token must be regenerated, a strong one preserved).
 *
 * Run: `npx tsx scripts/smoke-remote-control.ts`
 */

import {
  CONTROL_OPS,
  AI_KEY_OPS,
  CONTROL_PORT_PACKAGED,
  CONTROL_PORT_DEV,
  MIN_TOKEN_LEN,
} from '../core/types/remote-control'
import { normalizeRemoteControlData, sanitizeForSave, isValidPeer } from '../core/remote-control-config'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}`) }
}

const STRONG = 'a'.repeat(MIN_TOKEN_LEN)          // exactly the minimum length
const WEAK = 'short'
const gen = () => 'g'.repeat(48)                  // deterministic strong token for tests

// ── op allowlist: closed-by-default, correct ro/rw classification ──
const keys = Object.keys(CONTROL_OPS).sort()
ok('CONTROL_OPS is exactly {windows, scrollback, resolve-instance, write-keys, open-tab, close-tab, put-task, get-answer}',
  JSON.stringify(keys) === JSON.stringify(['close-tab', 'get-answer', 'open-tab', 'put-task', 'resolve-instance', 'scrollback', 'windows', 'write-keys']))
ok("'resolve-instance' is ro", CONTROL_OPS['resolve-instance'] === 'ro')
ok('AI_KEY_OPS includes open/close-tab + put-task + get-answer (UI parity + file delegate + file answer)',
  ['open-tab', 'close-tab', 'put-task', 'get-answer'].every((o) => AI_KEY_OPS.includes(o as any)))
ok("'put-task' is rw", CONTROL_OPS['put-task'] === 'rw')
ok("'get-answer' is ro", CONTROL_OPS['get-answer'] === 'ro')
ok('AI_KEY_OPS is a subset of CONTROL_OPS and includes write-keys',
  AI_KEY_OPS.includes('write-keys') && AI_KEY_OPS.every((o) => o in CONTROL_OPS))
ok("'windows' is ro", CONTROL_OPS.windows === 'ro')
ok("'scrollback' is ro", CONTROL_OPS.scrollback === 'ro')
ok("'write-keys' is rw (mutates a PTY)", CONTROL_OPS['write-keys'] === 'rw')
ok("'open-tab' is rw", CONTROL_OPS['open-tab'] === 'rw')
ok('no op classified outside ro/rw', Object.values(CONTROL_OPS).every((v) => v === 'ro' || v === 'rw'))

// ── ports: distinct from the debug API (47100/47101) ──
ok('control ports do not collide with debug ports',
  ![47100, 47101].includes(CONTROL_PORT_PACKAGED) && ![47100, 47101].includes(CONTROL_PORT_DEV))
ok('MIN_TOKEN_LEN is at least 32', MIN_TOKEN_LEN >= 32)

// ── token normalization (the load path) ──
{
  const { data, mutated } = normalizeRemoteControlData({ token: WEAK, enabled: true }, { defaultPort: 47200, genToken: gen })
  ok('weak token is regenerated', data.token === gen() && data.token.length >= MIN_TOKEN_LEN)
  ok('weak token regeneration sets mutated=true (forces persist)', mutated === true)
}
{
  const { data, mutated } = normalizeRemoteControlData({ token: STRONG, enabled: true, listenPort: 47200, peers: [] }, { defaultPort: 47200, genToken: gen })
  ok('strong token is preserved', data.token === STRONG)
  ok('strong token leaves mutated=false', mutated === false)
}
{
  const { data } = normalizeRemoteControlData({}, { defaultPort: 47201, genToken: gen })
  ok('missing config → disabled by default', data.enabled === false)
  ok('missing config → token generated', typeof data.token === 'string' && data.token.length >= MIN_TOKEN_LEN)
  ok('missing listenPort → default', data.listenPort === 47201)
  ok('missing peers → empty array', Array.isArray(data.peers) && data.peers.length === 0)
}

// ── peer validation + save sanitization ──
const goodPeer = { id: 'x', name: 'n', host: 'h', controlPort: 47200, agentPort: 3501, token: 't' }
ok('isValidPeer accepts a well-formed peer', isValidPeer(goodPeer))
ok('isValidPeer rejects a peer missing fields', !isValidPeer({ id: 'x', name: 'n' }))
{
  const saved = sanitizeForSave({ enabled: true, token: WEAK, listenPort: 47200, peers: [goodPeer, { junk: 1 } as any] }, gen)
  ok('save sanitization regenerates a weak token', saved.token === gen())
  ok('save sanitization drops invalid peers', saved.peers.length === 1 && saved.peers[0].id === 'x')
}

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed})`)
process.exit(failed === 0 ? 0 : 1)
