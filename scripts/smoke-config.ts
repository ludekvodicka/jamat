// Smoke test: ensureConfig first-run bootstrap + loadConfig round-trip.
// Usage: node --import tsx scripts/smoke-config.ts
//
// Covers the path a fresh clone hits on first boot (previously untested): a starter config is
// seeded from the template, sanitized (_README + selfUpdate stripped, name/categories replaced),
// and loadConfig accepts it. Uses a temp dir for the config; ensureConfig always seeds a real
// ~/JamatProjects placeholder (so loadConfig's "accessible path" check passes) — that dir is left
// in place, exactly as a real first run would.

import { ensureConfig, loadConfig, firstRunConfigMessage, validateConfigPatch } from '../core/config.js'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let failed = 0
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ✓ ${name}`)
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const tmp = mkdtempSync(join(tmpdir(), 'jamat-smoke-config-'))
const example = join(tmp, 'config.example.json')
writeFileSync(example, JSON.stringify({
  _README: ['doc only — must be stripped'],
  name: 'Example',
  categories: [{ label: 'X', path: join(tmp, 'nope') }],
  defaultAgent: 'claude',
  selfUpdate: { provider: 'github' },
}, null, 2))

console.log('\n=== Smoke: config (ensureConfig + loadConfig)\n')

try {
  // [1] missing target → created with a sanitized starter
  const target = join(tmp, 'sub', 'config.json')
  const r1 = ensureConfig(target, example)
  check('[1] created on first run', r1.created === true && existsSync(r1.path))
  const created = JSON.parse(readFileSync(r1.path, 'utf-8'))
  check('[1] _README stripped', created._README === undefined)
  check('[1] selfUpdate stripped (channel left to runtime default)', created.selfUpdate === undefined)
  check('[1] name = My Jamat', created.name === 'My Jamat')
  check('[1] single category at JamatProjects',
    Array.isArray(created.categories) && created.categories.length === 1 &&
    String(created.categories[0].path).endsWith('JamatProjects'))
  check('[1] starterCategoryPath returned + created', !!r1.starterCategoryPath && existsSync(r1.starterCategoryPath as string))

  // [2] existing target → no-op, bytes untouched
  const before = readFileSync(r1.path, 'utf-8')
  const r2 = ensureConfig(target, example)
  check('[2] no-op when present', r2.created === false && readFileSync(r1.path, 'utf-8') === before)

  // [3] loadConfig accepts the generated starter (JamatProjects exists → accessible)
  const cfg = loadConfig(r1.path)
  check('[3] loadConfig parses starter', cfg.categories.length === 1)

  // [4] missing template → {}-based starter, still valid + loadable
  const target2 = join(tmp, 'sub2', 'config.json')
  const r4 = ensureConfig(target2, join(tmp, 'no-such-example.json'))
  check('[4] created from empty base', r4.created === true && existsSync(r4.path))
  check('[4] loadConfig parses empty-base starter', loadConfig(r4.path).categories.length === 1)

  // [5] malformed template → throws (caller is expected to handle)
  const bad = join(tmp, 'bad.json')
  writeFileSync(bad, '{ not valid json')
  let threw = false
  try { ensureConfig(join(tmp, 'sub3', 'config.json'), bad) } catch { threw = true }
  check('[5] malformed template throws', threw)

  // [6] firstRunConfigMessage names the config path + the projects dir
  const msg = firstRunConfigMessage(r1.path)
  check('[6] message names config + projects dir', msg.includes(r1.path) && msg.includes('JamatProjects'))

  // [7] agents (per-agent pre-launch hook) validation — load path + patch path
  const withAgents = (agents: unknown): string => {
    const p = join(tmp, `cfg-agents-${Math.abs(JSON.stringify(agents).length)}-${Date.now()}.json`)
    writeFileSync(p, JSON.stringify({ name: 'A', categories: [{ label: 'X', path: tmp }], agents }, null, 2))
    return p
  }
  const validAgents = { codex: { preLaunch: { command: 'node', args: ['~/x/packer.mjs', 'build', '--dir', '{dir}'], timeoutMs: 15000 } } }
  const loaded = loadConfig(withAgents(validAgents))
  check('[7] loadConfig keeps a valid agents block', loaded.agents?.codex?.preLaunch?.command === 'node')

  const throwsLoad = (agents: unknown): boolean => {
    try { loadConfig(withAgents(agents)); return false } catch { return true }
  }
  check('[7] unknown agent id rejected', throwsLoad({ gpt: { preLaunch: { command: 'x' } } }))
  check('[7] preLaunch without command rejected', throwsLoad({ codex: { preLaunch: { args: ['x'] } } }))
  check('[7] non-string args rejected', throwsLoad({ codex: { preLaunch: { command: 'node', args: [1, 2] } } }))
  check('[7] non-positive timeoutMs rejected', throwsLoad({ codex: { preLaunch: { command: 'node', timeoutMs: 0 } } }))

  const patchThrows = (agents: unknown): boolean => {
    try { validateConfigPatch({ agents } as any); return false } catch { return true }
  }
  let patchOk = true
  try { validateConfigPatch({ agents: validAgents } as any) } catch { patchOk = false }
  check('[7] validateConfigPatch accepts a valid agents patch', patchOk)
  check('[7] validateConfigPatch rejects a bad agents patch', patchThrows({ claude: { preLaunch: { command: '' } } }))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '✓ all passed' : `✗ ${failed} failed`}\n`)
process.exit(failed === 0 ? 0 : 1)
