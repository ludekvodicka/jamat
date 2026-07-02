/**
 * Smoke for the cross-turn diff composition core (`composeSteps`,
 * `applyStepsToState`). These drive the per-file before/after the
 * SessionChanges panel and FileViewer session-* diff modes render, and
 * have subtle `priorState` semantics that `smoke-session-changes-edge.ts`
 * (which only checks `extractSessionTurns`) never exercised.
 *
 * Run: `npx tsx scripts/smoke-diff-compose.ts`
 */

import { composeSteps, applyStepsToState } from '../core/menu-core/diff-compose'
import type { EditStep } from '../core/types/session'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

function edit(oldString: string, newString: string, replaceAll = false): EditStep {
  return { tool: 'Edit', oldString, newString, content: null, replaceAll }
}
function write(content: string): EditStep {
  return { tool: 'Write', oldString: null, newString: null, content, replaceAll: false }
}

console.log('\n[1] composeSteps — priorState !== "" + first-step Write → real whole-file diff')
{
  const r = composeSteps([write('new content\n')], true, 'old content\n')
  ok('before = priorState', r.beforeText === 'old content\n', JSON.stringify(r.beforeText))
  ok('after = written content', r.afterText === 'new content\n')
  ok('not overwritten (prior known)', r.isOverwritten === false)
  ok('not flagged new file', r.isNewFile === false)
}

console.log('\n[2] composeSteps — priorState === "" + seenEarlier + Write → overwritten/unrecoverable')
{
  const r = composeSteps([write('replacement\n')], true, '')
  ok('before empty (prior unrecoverable)', r.beforeText === '')
  ok('after = written content', r.afterText === 'replacement\n')
  ok('isOverwritten = true', r.isOverwritten === true)
  ok('not new file', r.isNewFile === false)
}

console.log('\n[3] composeSteps — priorState !== "" + leading Edit → region anchor (ignores priorState)')
{
  const r = composeSteps([edit('foo', 'bar')], true, 'WHOLE FILE\nfoo\nMORE\n')
  ok('before = old_string region', r.beforeText === 'foo', JSON.stringify(r.beforeText))
  ok('after = new_string region', r.afterText === 'bar')
  ok('not new file (edit)', r.isNewFile === false)
}

console.log('\n[4] composeSteps — first-ever Write (not seen earlier) → new file')
{
  const r = composeSteps([write('brand new\n')], false, '')
  ok('before empty', r.beforeText === '')
  ok('after = content', r.afterText === 'brand new\n')
  ok('isNewFile = true', r.isNewFile === true)
}

console.log('\n[5] composeSteps — disjoint edit (old_string not in running after) → appended + flagged')
{
  const r = composeSteps([edit('a', 'A'), edit('zzz-not-present', 'Q')], true)
  ok('disjoint flagged', r.disjoint === true)
  ok('before concatenates both regions', r.beforeText === 'a\nzzz-not-present', JSON.stringify(r.beforeText))
  ok('after concatenates both regions', r.afterText === 'A\nQ', JSON.stringify(r.afterText))
}

console.log('\n[6] applyStepsToState — Write sets known state; later Edit applies')
{
  const a = applyStepsToState('', [write('line1\nline2\n')])
  ok('state after write', a.state === 'line1\nline2\n')
  ok('known = true after write', a.known === true)
  const b = applyStepsToState(a.state, [edit('line1', 'LINE1')])
  ok('edit applied to known state', b.state === 'LINE1\nline2\n', JSON.stringify(b.state))
}

console.log('\n[7] applyStepsToState — Edit on unknown ("") state is skipped (can\'t anchor)')
{
  const r = applyStepsToState('', [edit('x', 'Y')])
  ok('unknown state unchanged', r.state === '')
  ok('known stays false', r.known === false)
}

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
