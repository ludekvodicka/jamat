/**
 * Smoke for the customMenus editor's pure tree helpers (renderer/components/panels/menuTree) +
 * a round-trip through the server-side `parseCustomMenus` sanitizer.
 *
 * Run: `npx tsx scripts/smoke-menu-tree.ts`
 */
import { mutateNode, deleteNode, moveNode, newLeaf, newBranch, firstMenuError } from '../app-electron/src/renderer/components/panels/menuTree'
import { parseCustomMenus } from '../core/config'
import type { CustomMenuNode } from '../core/types'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}`) }
}

// A 2-level tree: group "Deploy" → command "Build"; plus a top-level command "Lint".
const tree: CustomMenuNode[] = [
  { label: 'Deploy', items: [{ label: 'Build', run: { command: 'npm', args: ['run', 'build'] } }] },
  { label: 'Lint', run: { command: 'eslint' } },
]

// ── mutateNode: edit a nested leaf's command ──
{
  const next = mutateNode(tree, [0, 0], n => ({ ...n, run: { ...n.run, command: 'pnpm' } }))
  ok('mutateNode edits the nested leaf', next[0].items![0].run!.command === 'pnpm')
  ok('mutateNode is immutable (original unchanged)', tree[0].items![0].run!.command === 'npm')
  ok('mutateNode leaves siblings intact', next[1].label === 'Lint')
}

// ── moveNode: reorder top-level + guard at edges ──
{
  const moved = moveNode(tree, [1], -1)
  ok('moveNode swaps top-level siblings', moved[0].label === 'Lint' && moved[1].label === 'Deploy')
  ok('moveNode past the top edge is a no-op', moveNode(tree, [0], -1)[0].label === 'Deploy')
}

// ── deleteNode: remove a nested child ──
{
  const pruned = deleteNode(tree, [0, 0])
  ok('deleteNode removes the nested child', (pruned[0].items ?? []).length === 0)
  ok('deleteNode keeps the parent group', pruned[0].label === 'Deploy')
}

// ── factories ──
{
  ok('newLeaf is an empty command', !!newLeaf().run && newLeaf().run!.command === '')
  ok('newBranch is an empty group', Array.isArray(newBranch().items) && newBranch().items!.length === 0)
}

// ── firstMenuError: catches the rows parseCustomMenus would silently drop ──
{
  ok('clean tree → no error', firstMenuError(tree) === null)
  ok('empty label flagged', !!firstMenuError([{ label: '', run: { command: 'x' } }]))
  ok('leaf with empty command flagged', !!firstMenuError([{ label: 'X', run: { command: '' } }]))
  ok('nested empty command flagged', !!firstMenuError([{ label: 'G', items: [{ label: 'C', run: { command: '' } }] }]))
}

// ── round-trip: a valid edited tree survives the server sanitizer unchanged in shape ──
{
  const edited = mutateNode(tree, [1], n => ({ ...n, label: 'Lint all' }))
  const sane = parseCustomMenus(edited)
  ok('valid edited tree passes firstMenuError', firstMenuError(edited) === null)
  ok('parseCustomMenus keeps both top-level nodes', sane.length === 2)
  ok('parseCustomMenus keeps the renamed command', sane[1].label === 'Lint all')
  ok('parseCustomMenus keeps the nested leaf', sane[0].items?.[0].run?.command === 'npm')
}

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed}) ===`)
process.exit(failed === 0 ? 0 : 1)
