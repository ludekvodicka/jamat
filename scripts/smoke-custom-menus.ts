/**
 * Smoke for custom menus: config parse (`parseCustomMenus`) + the TUI submenu-stack
 * handler (navigate branches, pop, leaf-dispatch with {dir}/{name} substitution).
 *
 * Run: `npx tsx scripts/smoke-custom-menus.ts`
 */
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseCustomMenus } from '../core/config'
import { handleCustomMenu, currentCustomItems } from '../app-cli/handlers'
import type { ActionConfig } from '../app-cli/actions'
import type { MenuState, CustomMenuNode } from '../core/types'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}`) }
}

// A fake MenuState carrying only the fields handleCustomMenu/currentCustomItems read.
function fakeState(menus: CustomMenuNode[]): MenuState {
  return { customMenus: menus, customPath: [], customTargetDir: 'Q:\\proj\\myapp', submenu: 'custom' } as unknown as MenuState
}
const KEY = (name: string) => ({ name }) as any

// ── parseCustomMenus: branch/leaf validation ──
{
  const tree = parseCustomMenus([
    { label: 'Deploy', items: [{ label: 'Build', run: { command: 'npm', args: ['run', 'build', '{dir}'] } }] },
    { label: 'both', items: [], run: { command: 'x' } }, // both items+run → dropped
    { label: 'neither' },                                 // neither → dropped
    { run: { command: 'noLabel' } },                      // no label → dropped
    { label: 'emptyCmd', run: { command: '' } },          // empty command → not a leaf → dropped
  ])
  ok('valid branch kept; malformed nodes dropped', tree.length === 1 && tree[0].label === 'Deploy')
  ok('branch carries its single leaf child', tree[0].items?.length === 1 && tree[0].items![0].run?.command === 'npm')
  ok('leaf args default + pause default applied', tree[0].items![0].run!.pause === true)
  ok('non-array input → []', parseCustomMenus(undefined).length === 0 && parseCustomMenus('nope' as unknown).length === 0)
  ok('depth cap stops runaway nesting (no throw)', (() => {
    let n: any = { label: 'L', run: { command: 'x' } }
    for (let i = 0; i < 12; i++) n = { label: 'g', items: [n] }
    return parseCustomMenus([n]).length === 1
  })())
}

// ── handler navigation: push branch, pop, exit ──
{
  const menus = parseCustomMenus([{ label: 'Deploy', items: [{ label: 'Build', run: { command: 'npm', args: ['build'] } }] }])
  const cfg: ActionConfig = { statsFile: '', selectionFile: join(tmpdir(), 'smoke-cm-nav.json') }
  const s = fakeState(menus)

  ok('root items = customMenus', currentCustomItems(s).length === 1 && currentCustomItems(s)[0].label === 'Deploy')
  handleCustomMenu(s, KEY('f1'), '', {} as any, cfg)
  ok('F1 pushes into the branch (now showing Build)', s.customPath.length === 1 && currentCustomItems(s)[0].label === 'Build')
  handleCustomMenu(s, KEY('escape'), '', {} as any, cfg)
  ok('Esc pops back to root', s.customPath.length === 0 && s.submenu === 'custom')
  handleCustomMenu(s, KEY('escape'), '', {} as any, cfg)
  ok('Esc at root exits the submenu', s.submenu === null)
}

// ── handler leaf-dispatch: writes custom-run with {dir}/{name} substituted ──
{
  const menus = parseCustomMenus([{ label: 'Deploy', items: [
    { label: 'Build', run: { command: 'npm', args: ['run', 'build', '{dir}', '{name}'], cwd: '{dir}' } },
  ] }])
  const cfg: ActionConfig = { statsFile: '', selectionFile: join(tmpdir(), 'smoke-cm-leaf.json') }
  if (existsSync(cfg.selectionFile)) unlinkSync(cfg.selectionFile)

  const s = fakeState(menus)
  s.customPath = [menus[0]] // already inside the Deploy branch → F1 = the Build leaf

  const origExit = process.exit
  ;(process as any).exit = () => {} // dispatchAction calls process.exit; neutralize for the test
  try {
    handleCustomMenu(s, KEY('f1'), '', {} as any, cfg)
  } finally {
    ;(process as any).exit = origExit
  }
  const sel = JSON.parse(readFileSync(cfg.selectionFile, 'utf-8'))
  unlinkSync(cfg.selectionFile)

  ok('leaf writes a custom-run selection', sel.action === 'custom-run')
  ok('{dir} substituted in args', sel.run.args.includes('Q:\\proj\\myapp'))
  ok('{name} substituted in args (basename)', sel.run.args.includes('myapp'))
  ok('{dir} substituted in cwd', sel.run.cwd === 'Q:\\proj\\myapp')
  ok('selected dir carried on the selection', sel.dir === 'Q:\\proj\\myapp')
}

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed}) ===`)
process.exit(failed === 0 ? 0 : 1)
