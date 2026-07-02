/**
 * Smoke for core/abilities/manage.ts against a temp fake ~/.claude — no real config touched.
 * Run: `npx tsx scripts/smoke-abilities-manage.ts`
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { setPluginEnabled, setSkillEnabled, removePlugin, removeSkill, manageAbility } from '../core/abilities/manage.js'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

const home = mkdtempSync(join(tmpdir(), 'abilities-manage-'))
const claude = join(home, '.claude')
mkdirSync(claude, { recursive: true })

// settings.json with other keys that MUST survive a read-modify-write
const SETTINGS = { permissions: { allow: ['Read(/x/**)'] }, env: { FOO: 'bar' }, enabledPlugins: { 'keep@mp': true } }
writeFileSync(join(claude, 'settings.json'), JSON.stringify(SETTINGS, null, 2))
const readSettings = () => JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf-8'))

console.log('[plugin enable/disable]')
let r = setPluginEnabled(claude, 'new@mp', true)
let s = readSettings()
ok('enablePlugin adds the key', r.ok && s.enabledPlugins['new@mp'] === true)
ok('enablePlugin preserves other keys', s.permissions?.allow?.[0] === 'Read(/x/**)' && s.env?.FOO === 'bar' && s.enabledPlugins['keep@mp'] === true)
r = setPluginEnabled(claude, 'new@mp', false)
s = readSettings()
ok('disablePlugin removes the key', r.ok && !('new@mp' in s.enabledPlugins))
ok('disablePlugin keeps the rest', s.enabledPlugins['keep@mp'] === true && s.env?.FOO === 'bar')

console.log('[skill enable/disable]')
mkdirSync(join(claude, 'extensions/skills/myskill'), { recursive: true })
writeFileSync(join(claude, 'extensions/skills/myskill/SKILL.md'), '---\nname: myskill\n---')
mkdirSync(join(claude, 'skills'), { recursive: true })
const link = join(claude, 'skills/myskill')
const source = join(claude, 'extensions/skills/myskill/SKILL.md')
r = setSkillEnabled(claude, 'myskill', true)
if (!r.ok && /EPERM|privilege|operation not permitted/i.test(r.error || '')) {
  console.log('  ⊘ skill symlink tests skipped (no junction privilege on this host)')
} else {
  ok('enableSkill creates a symlink', r.ok && existsSync(link) && lstatSync(link).isSymbolicLink(), r.error)
  r = setSkillEnabled(claude, 'myskill', false)
  ok('disableSkill removes the symlink', r.ok && !existsSync(link), r.error)
  ok('disableSkill keeps the extensions source', existsSync(source))
}

console.log('[remove]')
// plugin with a real cache install dir → removePlugin delists + clears enable + deletes dir
const rmInst = join(claude, 'plugins/cache/mp/rmplug/1.0.0')
mkdirSync(rmInst, { recursive: true })
writeFileSync(join(rmInst, 'marker.txt'), 'x')
writeFileSync(join(claude, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'rmplug@mp': [{ scope: 'user', installPath: rmInst, version: '1.0.0' }] } }))
setPluginEnabled(claude, 'rmplug@mp', true)
r = removePlugin(claude, 'rmplug@mp')
const ip = JSON.parse(readFileSync(join(claude, 'plugins/installed_plugins.json'), 'utf-8'))
ok('removePlugin delists from installed_plugins.json', r.ok && !('rmplug@mp' in (ip.plugins || {})), r.error)
ok('removePlugin clears it from enabledPlugins', !('rmplug@mp' in (readSettings().enabledPlugins || {})))
ok('removePlugin deletes the cache install dir', !existsSync(rmInst))
// skill remove deletes BOTH the symlink and the extensions source (irreversible)
let r2 = setSkillEnabled(claude, 'myskill', true)
if (!r2.ok && /EPERM|privilege|operation not permitted/i.test(r2.error || '')) {
  console.log('  ⊘ removeSkill source test skipped (no junction privilege)')
} else {
  r2 = removeSkill(claude, 'myskill')
  ok('removeSkill removes symlink + extensions source', r2.ok && !existsSync(link) && !existsSync(join(claude, 'extensions/skills/myskill')), r2.error)
}
ok('removeSkill rejects path-traversal name', !removeSkill(claude, '../evil').ok)

console.log('[bare-name key resolve]')
// installed key is `name@marketplace`; managing by the BARE name must resolve to the full key
const ri2 = join(claude, 'plugins/cache/mp/bareplug/1.0.0')
mkdirSync(ri2, { recursive: true })
writeFileSync(join(claude, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'bareplug@mp': [{ scope: 'user', installPath: ri2, version: '1.0.0' }] } }))
ok('enablePlugin by bare name → full key in enabledPlugins', manageAbility(home, { action: 'enablePlugin', name: 'bareplug' }).ok && readSettings().enabledPlugins?.['bareplug@mp'] === true)
ok('removePlugin by bare name → delists full key', manageAbility(home, { action: 'removePlugin', name: 'bareplug' }).ok && !('bareplug@mp' in (JSON.parse(readFileSync(join(claude, 'plugins/installed_plugins.json'), 'utf-8')).plugins || {})))

console.log('[safety]')
// malformed settings.json must NOT be clobbered
writeFileSync(join(claude, 'settings.json'), '{ this is : not json ')
r = setPluginEnabled(claude, 'x@mp', true)
ok('malformed settings.json → ok:false', !r.ok)
ok('malformed settings.json not clobbered', readFileSync(join(claude, 'settings.json'), 'utf-8').includes('not json'))
// path-traversal / bad names rejected before any fs op
ok('path-traversal skill name rejected', (() => { const x = manageAbility(home, { action: 'disableSkill', name: '../evil' }); return !x.ok && /invalid skill name/.test(x.error || '') })())
ok('slashed skill name rejected', !manageAbility(home, { action: 'enableSkill', name: 'a/b' }).ok)
ok('unsupported action rejected', !manageAbility(home, { action: 'bogus' as any, name: 'x' }).ok)

rmSync(home, { recursive: true, force: true })
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
