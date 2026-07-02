/**
 * Smoke for Direction #2 (remote data parity) — the security-critical path-scoping guard
 * (`scopeUnderRoots`) that keeps a remote `control:file-read` / `control:file-diff-*` /
 * `control:file-type` from reaching outside the configured project roots. Pure (node:path
 * only), so it runs headless.
 *
 * The op wiring (re-dispatch via:'ai', reach gate, audit) is electron-coupled and verified live;
 * here we lock down the boundary logic against traversal / sibling-prefix / type smuggling.
 *
 * Run: node --import tsx scripts/smoke-remote-parity.ts
 */

import path from 'node:path'
import { scopeUnderRoots } from '../core/menu-core/path-scope.js'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}`) }
}

// Two absolute roots derived from cwd so the host separator/drive is correct on any platform.
const rootA = path.resolve('proj-root-a')
const rootB = path.resolve('proj-root-b')
const roots = [rootA, rootB]

// ── inside a root → returns the resolved absolute path ──
{
  const inside = path.join(rootA, 'src', 'index.ts')
  ok('a file inside root A is allowed (returns resolved abs)', scopeUnderRoots(inside, roots) === path.resolve(inside))
  ok('a deep nested file inside root B is allowed', scopeUnderRoots(path.join(rootB, 'a', 'b', 'c', 'd.txt'), roots) === path.resolve(path.join(rootB, 'a', 'b', 'c', 'd.txt')))
  ok('the root itself is allowed', scopeUnderRoots(rootA, roots) === rootA)
  ok('matches the SECOND root too (not just the first)', scopeUnderRoots(path.join(rootB, 'x'), roots) === path.resolve(path.join(rootB, 'x')))
}

// ── outside every root → null ──
{
  ok('a file outside all roots is rejected', scopeUnderRoots(path.resolve('some-other-place', 'secret.env'), roots) === null)
  ok('an absolute system path is rejected', scopeUnderRoots(path.resolve(path.sep, 'etc', 'passwd'), roots) === null)
}

// ── control:file-type / control:list-recent share the SAME guard as control:file-read (the
//    open-file menu gate and the recent-files sidebar listing must not become path-probe oracles
//    for paths outside the roots) ──
{
  ok('file-type gate: a path inside a root is allowed', scopeUnderRoots(path.join(rootA, 'src', 'index.ts'), roots) === path.resolve(path.join(rootA, 'src', 'index.ts')))
  ok('file-type gate: a path outside all roots is rejected', scopeUnderRoots(path.resolve('elsewhere', 'app.config'), roots) === null)
  ok('list-recent: a project dir inside a root is allowed', scopeUnderRoots(path.join(rootB, 'src'), roots) === path.resolve(path.join(rootB, 'src')))
  ok('list-recent: a dir outside all roots is rejected', scopeUnderRoots(path.resolve('elsewhere'), roots) === null)
}

// ── sibling-prefix attack: /…/proj-root-aXXX must NOT match root /…/proj-root-a ──
{
  const sibling = path.resolve('proj-root-a-evil', 'x') // shares the "proj-root-a" prefix
  ok('a sibling dir sharing the root name PREFIX is rejected (root+sep boundary)', scopeUnderRoots(sibling, roots) === null)
}

// ── `..` traversal that escapes a root → null (resolves out before the check) ──
{
  const escape = path.join(rootA, '..', '..', 'outside', 'x.ts')
  ok('`..` traversal escaping the root is rejected', scopeUnderRoots(escape, roots) === null)
  // a `..` that stays inside the root is fine
  const stays = path.join(rootA, 'src', '..', 'lib', 'y.ts')
  ok('`..` that stays inside the root is allowed', scopeUnderRoots(stays, roots) === path.resolve(stays))
}

// ── type / emptiness smuggling → null ──
{
  ok('non-string path is rejected', scopeUnderRoots(42 as unknown, roots) === null)
  ok('null path is rejected', scopeUnderRoots(null as unknown, roots) === null)
  ok('empty-string path is rejected', scopeUnderRoots('', roots) === null)
  ok('empty roots list rejects everything', scopeUnderRoots(path.join(rootA, 'x'), []) === null)
  ok('a falsy root entry is skipped, not crashed', scopeUnderRoots(path.join(rootA, 'x'), ['', rootA]) === path.resolve(path.join(rootA, 'x')))
}

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed}) ===`)
process.exit(failed === 0 ? 0 : 1)
