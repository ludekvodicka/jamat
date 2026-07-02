/**
 * Smoke for core/abilities/scan.ts against a temp fake ~/.claude — no real config touched.
 * Run: `npx tsx scripts/smoke-abilities-scan.ts`
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { scanAbilities } from '../core/abilities/scan.js'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

const home = mkdtempSync(join(tmpdir(), 'abilities-smoke-'))
const claude = join(home, '.claude')
const mk = (p: string) => mkdirSync(join(claude, p), { recursive: true })

// skills: one with frontmatter, one without (→ dirname)
mk('skills/with-fm'); writeFileSync(join(claude, 'skills/with-fm/SKILL.md'), '---\nname: cool-skill\ndescription: Does a cool thing.\n---\n# body')
mk('skills/no-fm'); writeFileSync(join(claude, 'skills/no-fm/SKILL.md'), '# just a heading\n\nFirst real sentence.')
// command: no frontmatter → filename + first prose line; + a non-md file (skipped)
mk('commands'); writeFileSync(join(claude, 'commands/deploy.md'), 'Deploy the app to prod.\n\nmore text')
writeFileSync(join(claude, 'commands/notes.txt'), 'ignored')
// agent: block-scalar description
mk('agents'); writeFileSync(join(claude, 'agents/rev.md'), '---\nname: reviewer\ndescription: |\n  Reviews code\n  across files.\n---\nbody')
// mcp via ~/.claude.json
writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { db: { command: 'node', args: ['server.js'] } } }))
// plugins: installed_plugins.json with one plugin + a nested skill
const inst = join(claude, 'plugins/cache/mp/myplug/1.0.0')
mkdirSync(join(inst, '.claude-plugin'), { recursive: true }); writeFileSync(join(inst, '.claude-plugin/plugin.json'), JSON.stringify({ description: 'My plugin.' }))
mkdirSync(join(inst, 'skills/nested'), { recursive: true }); writeFileSync(join(inst, 'skills/nested/SKILL.md'), '---\nname: nested-skill\ndescription: From a plugin.\n---')
mkdirSync(join(claude, 'plugins'), { recursive: true })
writeFileSync(join(claude, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
  'myplug@mp': [{ scope: 'local', projectPath: 'Q:\\Proj\\Demo', installPath: inst, version: '1.0.0' }],
  'globalplug@gm': [{ scope: 'user', installPath: join(claude, 'plugins/cache/gm/globalplug/2.0.0'), version: '2.0.0' }],
} }))
// settings.json enabledPlugins → globalplug enabled globally, myplug is not
writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'globalplug@gm': true } }))

// symlinked skill → should report link=symlink + linkTarget (best-effort; junctions need no privilege)
let symlinkMade = false
mkdirSync(join(claude, '_real/linked-skill'), { recursive: true })
writeFileSync(join(claude, '_real/linked-skill/SKILL.md'), '---\nname: linked-skill\ndescription: Via symlink.\n---')
try { symlinkSync(join(claude, '_real/linked-skill'), join(claude, 'skills/linked-skill'), 'junction'); symlinkMade = true } catch { /* no privilege */ }

// instructions: root CLAUDE.md @-imports one file (→ global); another is an orphan (→ manual)
writeFileSync(join(claude, 'CLAUDE.md'), '# My Rules\n\n@./extensions/instructions/imported.md\n')
mk('extensions/instructions')
writeFileSync(join(claude, 'extensions/instructions/imported.md'), '# Imported Rule\nbody')
writeFileSync(join(claude, 'extensions/instructions/orphan.md'), '# Orphan Rule\nbody')

const r = scanAbilities(home)

console.log('\n[skills]');
ok('skill frontmatter parsed + link=local', !!r.skills.find(s => s.name === 'cool-skill' && s.description === 'Does a cool thing.' && s.link === 'local'))
ok('skill no frontmatter → dirname + first prose line', !!r.skills.find(s => s.name === 'no-fm' && s.description === 'First real sentence.'))
if (symlinkMade) ok('symlinked skill → link=symlink + linkTarget', !!r.skills.find(s => s.name === 'linked-skill' && s.link === 'symlink' && /linked-skill/.test(s.linkTarget || '')))
else console.log('  ⊘ symlinked-skill test skipped (no junction privilege)')
console.log('[plugins/nesting]')
const myplug = r.plugins.find(p => p.name === 'myplug')
ok('plugin skill nested under plugin.children (not top-level)', !r.skills.find(s => s.name === 'nested-skill') && !!myplug?.children?.skills.find(s => s.name === 'nested-skill' && s.source === 'plugin:myplug'))
console.log('[commands]')
ok('command no-fm → filename + first line', !!r.commands.find(c => c.name === 'deploy' && c.description === 'Deploy the app to prod.'))
ok('.txt in commands skipped', !r.commands.find(c => c.name === 'notes'))
console.log('[agents]')
ok('agent block-scalar description joined', !!r.agents.find(a => a.name === 'reviewer' && /Reviews code/.test(a.description || '') && /across files/.test(a.description || '')))
console.log('[plugins]')
ok('plugin listed with manifest description', !!r.plugins.find(p => p.name === 'myplug' && p.description === 'My plugin.' && p.version === '1.0.0'))
console.log('[plugins/scope]')
const mp = r.plugins.find(p => p.name === 'myplug')
ok('local plugin scope: not global + project ref', !!mp?.scope && mp.scope.global === false && mp.scope.refs.length === 1 && mp.scope.refs[0].kind === 'local' && mp.scope.refs[0].project === 'Q:\\Proj\\Demo')
const gp = r.plugins.find(p => p.name === 'globalplug')
ok('global plugin scope: global true + no refs', !!gp?.scope && gp.scope.global === true && gp.scope.refs.length === 0)
console.log('[mcp]')
ok('mcp server from .claude.json', !!r.mcp.find(m => m.name === 'db' && /node server\.js/.test(m.description || '')))
console.log('[instructions]')
ok('root CLAUDE.md → instruction, global', !!r.instructions.find(x => x.name === 'CLAUDE.md' && x.scope?.global === true))
ok('@-imported instruction → global', !!r.instructions.find(x => x.name === 'imported.md' && x.scope?.global === true))
ok('non-imported instruction → manual (global false)', !!r.instructions.find(x => x.name === 'orphan.md' && x.scope?.global === false))
console.log('[robustness]')
ok('no throw on partial config', Array.isArray(r.skills) && Array.isArray(r.mcp))
ok('scanAbilities on empty home → all empty', (() => { const e = mkdtempSync(join(tmpdir(), 'ab-empty-')); const x = scanAbilities(e); rmSync(e, { recursive: true, force: true }); return x.skills.length === 0 && x.commands.length === 0 && x.mcp.length === 0 })())

rmSync(home, { recursive: true, force: true })
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
