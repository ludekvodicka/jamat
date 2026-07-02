/**
 * Smoke for the configurable context-warning levels: `validateContextLevels` (via the public
 * `validateConfigPatch`) + the renderer resolver in `context-level.ts` (severity-rank sort, statusBar
 * gating, defaults fallback, compact-suggest = lowest threshold). Pure logic only — no Electron.
 *
 * Run: `npx tsx scripts/smoke-context-levels.ts`
 */
import { validateConfigPatch } from '../core/config'
import type { ConfigPatch, ContextWarnLevel } from '../core/types'
import {
  resolveContextLevels,
  contextLevel,
  compactSuggestPct,
  DEFAULT_CONTEXT_LEVELS,
} from '../app-electron/src/renderer/utils/context-level'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}`) }
}
function rejects(label: string, fn: () => void): void {
  let threw = false
  try { fn() } catch { threw = true }
  ok(label, threw)
}

const valid: ContextWarnLevel[] = [
  { pct: 35, popup: true, statusBar: false },
  { pct: 45, popup: true, statusBar: true },
  { pct: 75, popup: true, statusBar: true },
  { pct: 85, popup: true, statusBar: true },
]

// ── validateConfigPatch (contextLevels per-field validator) ──
{
  ok('valid 4-level patch passes', (() => { try { validateConfigPatch({ contextLevels: valid }); return true } catch { return false } })())
  ok('absent contextLevels is a no-op', (() => { try { validateConfigPatch({} as ConfigPatch); return true } catch { return false } })())
  rejects('wrong count (3) rejected', () => validateConfigPatch({ contextLevels: valid.slice(0, 3) }))
  rejects('count 5 rejected', () => validateConfigPatch({ contextLevels: [...valid, { pct: 90, popup: true, statusBar: true }] }))
  rejects('pct > 100 rejected', () => validateConfigPatch({ contextLevels: [{ pct: 120, popup: true, statusBar: true }, ...valid.slice(1)] }))
  rejects('pct < 0 rejected', () => validateConfigPatch({ contextLevels: [{ pct: -1, popup: true, statusBar: true }, ...valid.slice(1)] }))
  rejects('non-numeric pct rejected', () => validateConfigPatch({ contextLevels: [{ pct: NaN, popup: true, statusBar: true }, ...valid.slice(1)] }))
  rejects('non-boolean popup rejected', () => validateConfigPatch({ contextLevels: [{ pct: 35, popup: 1 as unknown as boolean, statusBar: false }, ...valid.slice(1)] }))
}

// ── resolveContextLevels: defaults + severity-rank visuals ──
{
  const def = resolveContextLevels(undefined)
  ok('undefined → 4 default levels', def.length === 4)
  ok('defaults sorted ascending', def[0].pct === 35 && def[3].pct === 85)
  ok('lowest = info colour (#6a9fb5)', def[0].visual.color === '#6a9fb5')
  ok('highest = red (#e8554e)', def[3].visual.color === '#e8554e')

  // Unsorted input is sorted; visuals follow severity rank, not array order.
  const unsorted: ContextWarnLevel[] = [
    { pct: 85, popup: true, statusBar: true },
    { pct: 35, popup: true, statusBar: false },
    { pct: 75, popup: true, statusBar: true },
    { pct: 45, popup: true, statusBar: true },
  ]
  const r = resolveContextLevels(unsorted)
  ok('unsorted input → ascending', r.map(l => l.pct).join(',') === '35,45,75,85')
  ok('rank-1 (35) gets info colour despite being last in input', r[0].visual.color === '#6a9fb5')
  ok('malformed (count≠4) → defaults', resolveContextLevels([{ pct: 50, popup: true, statusBar: true }])[0].pct === 35)
}

// ── contextLevel: highest crossed statusBar level (or null) ──
{
  ok('40% → null (35 is silent, 45 not crossed)', contextLevel(40, DEFAULT_CONTEXT_LEVELS) === null)
  ok('50% → amber (45 crossed, statusBar on)', contextLevel(50, DEFAULT_CONTEXT_LEVELS)?.color === '#e0b000')
  ok('90% → red', contextLevel(90, DEFAULT_CONTEXT_LEVELS)?.color === '#e8554e')
  ok('null pct → null', contextLevel(null, DEFAULT_CONTEXT_LEVELS) === null)

  // A config that turns ON statusBar for the lowest level → it colours below the old floor.
  const lowOn: ContextWarnLevel[] = [
    { pct: 30, popup: true, statusBar: true },
    { pct: 45, popup: true, statusBar: true },
    { pct: 75, popup: true, statusBar: true },
    { pct: 85, popup: true, statusBar: true },
  ]
  ok('lowest statusBar ON → info colour at 35%', contextLevel(35, lowOn)?.color === '#6a9fb5')
}

// ── compactSuggestPct: the lowest threshold (button floor) ──
{
  ok('default compact floor = 35', compactSuggestPct(undefined) === 35)
  ok('custom lowest threshold respected', compactSuggestPct([
    { pct: 20, popup: true, statusBar: false },
    { pct: 45, popup: true, statusBar: true },
    { pct: 75, popup: true, statusBar: true },
    { pct: 85, popup: true, statusBar: true },
  ]) === 20)
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
