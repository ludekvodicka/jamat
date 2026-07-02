/**
 * Smoke for the `jamat` CLI's PURE arg layer (electron-free, network-free): the
 * flag/positional parser, the `--self` peer-injection rules, and the verb→scenario map.
 * Importing the module must NOT fire the CLI (it is guarded to run only when invoked
 * directly), so these assertions exercise the parsing in isolation.
 *
 * Run: node --import tsx scripts/smoke-jamat-cli.ts
 */

import { parseArgs, applySelfPeer, VERB_SCENARIO } from '../app-cli/jamat.js'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}`) }
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ── parseArgs: positionals, valued flags, boolean flags, `--` end-of-flags ──
{
  const r = parseArgs(['send', 'pc1', 'term-1', 'do the thing'])
  ok('positional-only: all land in pos, flags empty', eq(r.pos, ['send', 'pc1', 'term-1', 'do the thing']) && eq(r.flags, {}))

  const f = parseArgs(['send', 'pc1', 'term-1', '--file', './task.md'])
  ok('valued flag captures the next token + drops it from pos', f.flags['file'] === './task.md' && eq(f.pos, ['send', 'pc1', 'term-1']))

  const b = parseArgs(['delegate', 'pc1', '--self', '--debug'])
  ok('trailing boolean flags become true', b.flags['self'] === true && b.flags['debug'] === true && eq(b.pos, ['delegate', 'pc1']))

  const c = parseArgs(['open', 'pc1', 'claude', '--scratch'])
  ok('a boolean flag at the end (no following value) is true', c.flags['scratch'] === true && eq(c.pos, ['open', 'pc1', 'claude']))

  const d = parseArgs(['issue', 'pc1', 'term', '--repo', '--issue', '5'])
  ok('a flag whose next token is also a flag is boolean-true (repo=true), the later flag keeps its value',
    d.flags['repo'] === true && d.flags['issue'] === '5')

  const e = parseArgs(['send', 'pc1', 'term', '--', '--task-starting-with-dashes'])
  ok('`--` ends flags: the rest is positional even if it looks like a flag',
    eq(e.pos, ['send', 'pc1', 'term', '--task-starting-with-dashes']) && eq(e.flags, {}))

  const g = parseArgs(['send', 'pc1', 'term', '--max-wait', '60000'])
  ok('numeric-looking flag values stay strings (caller coerces)', g.flags['max-wait'] === '60000')

  ok('empty argv → empty pos + flags', (() => { const z = parseArgs([]); return eq(z.pos, []) && eq(z.flags, {}) })())
}

// ── applySelfPeer: inject the reserved `self` peer at the peer slot under the right rules ──
{
  ok('--self on a peer verb injects `self` at the peer slot',
    eq(applySelfPeer(['tabs'], { self: true }, 'tabs'), ['tabs', 'self']))

  ok('--self with a real verb shifts the rest right (peer slot = self)',
    eq(applySelfPeer(['send', 'term-1', 'task'], { self: true }, 'send'), ['send', 'self', 'term-1', 'task']))

  ok('--self is a no-op for peerless verb `peers`', eq(applySelfPeer(['peers'], { self: true }, 'peers'), ['peers']))
  ok('--self is a no-op for peerless verb `find`', eq(applySelfPeer(['find', 'pc2'], { self: true }, 'find'), ['find', 'pc2']))
  ok('--self is a no-op for `help`', eq(applySelfPeer(['help'], { self: true }, 'help'), ['help']))

  ok('no double-insert when the peer is already `self`',
    eq(applySelfPeer(['tabs', 'self'], { self: true }, 'tabs'), ['tabs', 'self']))

  ok('without --self the args pass through unchanged',
    eq(applySelfPeer(['tabs', 'pc1'], {}, 'tabs'), ['tabs', 'pc1']))

  ok('undefined verb is a no-op (never throws)', eq(applySelfPeer([], { self: true }, undefined), []))

  // purity: the input array must not be mutated
  const input = ['tabs']
  applySelfPeer(input, { self: true }, 'tabs')
  ok('applySelfPeer does not mutate its input array', eq(input, ['tabs']))
}

// ── VERB_SCENARIO: the verb→scenario map matches the 5 server scenarios ──
{
  ok('verb→scenario map is exactly the 5 scenario-backed verbs',
    eq(VERB_SCENARIO, { peek: 'consult', send: 'terminal-task', issue: 'issue-handoff', notify: 'notify', unblock: 'unblock' }))
  ok('the direct-route verbs are NOT in the scenario map (handled before the lookup)',
    ['delegate', 'await', 'open', 'close', 'tabs', 'peers', 'find', 'wake'].every((v) => VERB_SCENARIO[v] === undefined))
  // every mapped scenario id is a real one (mirrors the catalog the gateway runs)
  const realScenarios = ['consult', 'issue-handoff', 'notify', 'terminal-task', 'unblock']
  ok('every mapped scenario id is a real scenario', Object.values(VERB_SCENARIO).every((s) => realScenarios.includes(s)))
}

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed}) ===`)
process.exit(failed === 0 ? 0 : 1)
