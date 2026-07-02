/**
 * Smoke for the portable config-dir core: `resolveConfigDir` precedence, the `buildJamatPaths` map
 * (portable vs per-machine), and `migrateIntoConfigDir` (idempotent, non-clobber, never the key).
 *
 * Run: `npx tsx scripts/smoke-config-dir.ts`
 */
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { resolveConfigDir, migrateIntoConfigDir } from '../core/config-dir'
import { buildJamatPaths } from '../core/jamat-paths'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}`) }
}

// ── resolveConfigDir precedence ──
{
  ok('explicit dir used verbatim (no -debug), debug=false', resolveConfigDir({ explicit: 'C:/tmp/x', debug: false }) === resolve('C:/tmp/x'))
  ok('explicit dir used verbatim even when debug=true', resolveConfigDir({ explicit: 'C:/tmp/x', debug: true }) === resolve('C:/tmp/x'))
  ok('default = ~/.jamat (debug=false)', resolveConfigDir({ debug: false }) === join(homedir(), '.jamat'))
  ok('default = ~/.jamat-debug (debug=true)', resolveConfigDir({ debug: true }) === join(homedir(), '.jamat-debug'))
  ok('empty explicit falls back to default', resolveConfigDir({ explicit: '  ' }) === join(homedir(), '.jamat'))
}

// ── buildJamatPaths: portable vs per-machine split ──
{
  const p = buildJamatPaths('C:/cfg', 'C:/appdata/jamat')
  ok('configFile under configDir', p.configFile === join('C:/cfg', 'config.json'))
  ok('appState under configDir', p.appState === join('C:/cfg', 'app-state.json'))
  ok('remoteActivityDir under configDir', p.remoteActivityDir === join('C:/cfg', 'remote-activity'))
  ok('remoteControl under configDir (with the rest of the config)', p.remoteControl === join('C:/cfg', 'remote-control.json'))
  ok('ideasDir is the configDir', p.ideasDir === 'C:/cfg')
}

// ── migrateIntoConfigDir ──
{
  const root = mkdtempSync(join(tmpdir(), 'jamat-mig-'))
  const legacyUserData = join(root, 'userData'); mkdirSync(legacyUserData, { recursive: true })
  const configDir = join(root, 'cfg')
  // legacy userData has portable files + the machine key (must NOT move) + a stray
  writeFileSync(join(legacyUserData, 'app-state.json'), '{"v":1}')
  writeFileSync(join(legacyUserData, 'ideas-w0.json'), '[]')
  writeFileSync(join(legacyUserData, 'usage-cache.json'), '{}')
  writeFileSync(join(legacyUserData, 'remote-control.json'), '{"key":"SECRET"}')
  writeFileSync(join(legacyUserData, 'random.log'), 'nope')
  // a legacy committed config to become config.json (+ overlay)
  const legacyCfg = join(root, 'config-user.json'); writeFileSync(legacyCfg, '{"name":"user"}')
  writeFileSync(join(root, 'config-user.local.json'), '{"claudeUsage":{}}')

  migrateIntoConfigDir(configDir, legacyUserData, legacyCfg)
  ok('portable app-state copied', existsSync(join(configDir, 'app-state.json')))
  ok('portable ideas copied', existsSync(join(configDir, 'ideas-w0.json')))
  ok('portable usage-cache copied', existsSync(join(configDir, 'usage-cache.json')))
  ok('machine key NOT copied by migrateIntoConfigDir (its own cutover in bootstrap handles it)', !existsSync(join(configDir, 'remote-control.json')))
  ok('non-portable stray NOT copied', !existsSync(join(configDir, 'random.log')))
  ok('legacy config → config.json', existsSync(join(configDir, 'config.json')) && JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8')).name === 'user')
  ok('legacy overlay → config.local.json', existsSync(join(configDir, 'config.local.json')))

  // idempotent: config.json now exists → 2nd run is a no-op (doesn't re-copy / re-clobber)
  writeFileSync(join(configDir, 'app-state.json'), '{"v":2}') // simulate newer state
  migrateIntoConfigDir(configDir, legacyUserData, legacyCfg)
  ok('idempotent: 2nd run does not clobber newer app-state', JSON.parse(readFileSync(join(configDir, 'app-state.json'), 'utf-8')).v === 2)

  // non-clobber on first run: a pre-existing target file is preserved
  const cfg2 = join(root, 'cfg2'); mkdirSync(cfg2, { recursive: true })
  writeFileSync(join(cfg2, 'app-state.json'), '{"keep":true}')
  migrateIntoConfigDir(cfg2, legacyUserData, null) // no legacyConfigFile → config.json stays absent
  ok('non-clobber: pre-existing app-state preserved', JSON.parse(readFileSync(join(cfg2, 'app-state.json'), 'utf-8')).keep === true)
  ok('migration without legacy config leaves config.json absent (→ wizard)', !existsSync(join(cfg2, 'config.json')))

  rmSync(root, { recursive: true, force: true })
}

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed}) ===`)
process.exit(failed === 0 ? 0 : 1)
