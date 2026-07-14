/**
 * Smoke for the UI config-edit core: `writeConfigPatch` (atomic, key-preserving) +
 * `validateConfigPatch` (per-present-key, reusing the load-path validators). The IPC brick-guard
 * (categories must keep ≥1 existing dir) lives in the `config:update` handler, not here.
 *
 * Run: `npx tsx scripts/smoke-config-edit.ts`
 */
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, writeConfigPatch, validateConfigPatch } from '../core/config'
import type { ConfigPatch } from '../core/types'

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

const dir = mkdtempSync(join(tmpdir(), 'jamat-cfg-'))
const cfgPath = join(dir, 'config.json')

// Seed a config whose only category points at an existing dir (so loadConfig succeeds) plus an
// "advanced" key (screenOptions) the editor never touches.
writeFileSync(cfgPath, JSON.stringify({
  name: 'Orig',
  categories: [{ label: 'Tmp', path: dir, virtualFolders: [{ prefix: 'x-', title: 'X' }] }],
  screenOptions: { antiFlickerScrollSpeed: '7' },
  defaultAgent: 'claude',
}, null, 2) + '\n', 'utf-8')

// ── writeConfigPatch: round-trip + key preservation + atomicity ──
{
  writeConfigPatch(cfgPath, { name: 'Edited', defaultAgent: 'codex', dockerIsolation: false })
  const loaded = loadConfig(cfgPath)
  ok('name patched', loaded.name === 'Edited')
  ok('defaultAgent patched', loaded.defaultAgent === 'codex')
  ok('dockerIsolation patched', loaded.dockerIsolation === false)
  ok('untouched screenOptions preserved', loaded.screenOptions?.antiFlickerScrollSpeed === '7')
  ok('untouched category virtualFolders preserved', loaded.categories[0].virtualFolders.length === 1)
  ok('no .tmp file left behind', !existsSync(`${cfgPath}.tmp`))
}

// ── writeConfigPatch: customMenus stored in sanitized form (bad nodes dropped, no throw) ──
{
  writeConfigPatch(cfgPath, { customMenus: [
    { label: 'Group', items: [{ label: 'Run', run: { command: 'echo' } }] },
    { label: 'both', items: [], run: { command: 'x' } }, // both items+run → dropped by parseCustomMenus
    { label: 'neither' },                                 // neither → dropped
  ] as unknown as ConfigPatch['customMenus'] })
  const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'))
  ok('customMenus sanitized on write (1 of 3 kept)', Array.isArray(raw.customMenus) && raw.customMenus.length === 1 && raw.customMenus[0].label === 'Group')
}

// ── validateConfigPatch: rejects bad shapes, accepts good ones ──
{
  rejects('rejects empty name', () => validateConfigPatch({ name: '' }))
  rejects('rejects empty categories array', () => validateConfigPatch({ categories: [] }))
  rejects('rejects category missing path', () => validateConfigPatch({ categories: [{ label: 'L' } as never] }))
  rejects('rejects bad defaultAgent', () => validateConfigPatch({ defaultAgent: 'nope' as never }))
  // The channel now follows the runtime, so `vcs` (like `provider`/`repoPath`) is a DEAD key: a config
  // written by an older build — even a nonsense one — must still load instead of bricking the app.
  ok('accepts (and ignores) the deprecated selfUpdate.vcs', (() => {
    validateConfigPatch({ selfUpdate: { vcs: 'hg' } }); return true
  })())
  rejects('rejects selfUpdate.checkIntervalMinutes <= 0', () => validateConfigPatch({ selfUpdate: { checkIntervalMinutes: 0 } }))
  rejects('rejects NaN selfUpdate.checkIntervalMinutes (would JSON->null and brick)', () => validateConfigPatch({ selfUpdate: { checkIntervalMinutes: NaN } }))
  rejects('rejects non-boolean dockerIsolation', () => validateConfigPatch({ dockerIsolation: 'yes' as never }))
  ok('accepts a valid multi-key patch', (() => {
    validateConfigPatch({ name: 'X', defaultAgent: 'claude', categories: [{ label: 'L', path: dir }], dockerIsolation: true })
    return true
  })())
  ok('accepts an empty patch (no-op)', (() => { validateConfigPatch({}); return true })())
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed}) ===`)
process.exit(failed === 0 ? 0 : 1)
